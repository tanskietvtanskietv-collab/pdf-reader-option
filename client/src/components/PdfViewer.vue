<script setup>
import { ref, shallowRef, computed, watch, onBeforeUnmount, nextTick } from 'vue';
import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { documentFileUrl } from '../api.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const props = defineProps({
  docId: { type: String, default: null },
  // Page geometry from the server: [{ page, width, height }] at scale 1.
  pages: { type: Array, default: () => [] },
  // Search hits from the server: [{ page, index, bounds, rects }] at scale 1.
  highlights: { type: Array, default: () => [] },
  activeIndex: { type: Number, default: -1 },
});
const emit = defineEmits(['error', 'loaded']);

const viewportEl = ref(null);
const pageEls = ref([]);
const canvasEls = ref([]);

const pdfDoc = shallowRef(null);
const loading = ref(false);
const currentPage = ref(1);
// The viewer opens at a fixed 100 % and scrolls; fit width / fit page stay
// available from the toolbar but are never the initial state.
const zoom = ref(1);
const fitMode = ref('custom');
const containerWidth = ref(0);

const renderTasks = new Map();
const renderedPages = ref(new Set());
const visiblePages = ref(new Set());

const RENDER_WINDOW = 3; // pages kept rendered on each side of the viewport

const baseWidth = computed(() =>
  props.pages.length ? Math.max(...props.pages.map((p) => p.width)) : 612,
);

/** Effective scale: explicit zoom, or derived from the fit mode. */
const scale = computed(() => {
  if (fitMode.value === 'custom' || !containerWidth.value) return zoom.value;
  if (fitMode.value === 'width') {
    return Math.max((containerWidth.value - 48) / baseWidth.value, 0.05);
  }
  const first = props.pages[0];
  if (fitMode.value === 'page' && first && viewportEl.value) {
    return Math.max(
      Math.min(
        (containerWidth.value - 48) / first.width,
        (viewportEl.value.clientHeight - 48) / first.height,
      ),
      0.05,
    );
  }
  return zoom.value;
});

const zoomPercent = computed(() => Math.round(scale.value * 100));

const highlightsByPage = computed(() => {
  const grouped = new Map();
  props.highlights.forEach((hit) => {
    if (!grouped.has(hit.page)) grouped.set(hit.page, []);
    grouped.get(hit.page).push(hit);
  });
  return grouped;
});

/* ------------------------------------------------------------- document io */

watch(
  () => props.docId,
  async (docId) => {
    await destroyDocument();
    if (!docId) return;

    loading.value = true;
    try {
      pdfDoc.value = await pdfjsLib.getDocument({
        url: documentFileUrl(docId),
        cMapUrl: '/pdfjs/cmaps/',
        cMapPacked: true,
        standardFontDataUrl: '/pdfjs/standard_fonts/',
      }).promise;
      currentPage.value = 1;
      await nextTick();
      observePages();
      await renderVisible();
      emit('loaded', { totalPages: pdfDoc.value.numPages });
    } catch (error) {
      emit('error', error.message || 'Could not open the PDF');
    } finally {
      loading.value = false;
    }
  },
  { immediate: true },
);

async function destroyDocument() {
  for (const task of renderTasks.values()) task.cancel();
  renderTasks.clear();
  renderedPages.value = new Set();
  visiblePages.value = new Set();
  if (pdfDoc.value) {
    await pdfDoc.value.destroy().catch(() => {});
    pdfDoc.value = null;
  }
}

/* --------------------------------------------------------------- rendering */

async function renderPage(pageNumber) {
  const doc = pdfDoc.value;
  const canvas = canvasEls.value[pageNumber - 1];
  if (!doc || !canvas) return;

  renderTasks.get(pageNumber)?.cancel();

  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: scale.value });
  const outputScale = Math.min(window.devicePixelRatio || 1, 2);

  canvas.width = Math.floor(viewport.width * outputScale);
  canvas.height = Math.floor(viewport.height * outputScale);
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;

  const task = page.render({
    canvasContext: canvas.getContext('2d', { alpha: false }),
    viewport,
    transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0],
  });
  renderTasks.set(pageNumber, task);

  try {
    await task.promise;
    renderedPages.value = new Set(renderedPages.value).add(pageNumber);
  } catch (error) {
    if (error?.name !== 'RenderingCancelledException') {
      emit('error', `Page ${pageNumber}: ${error.message}`);
    }
  } finally {
    if (renderTasks.get(pageNumber) === task) renderTasks.delete(pageNumber);
    page.cleanup();
  }
}

function clearPage(pageNumber) {
  renderTasks.get(pageNumber)?.cancel();
  renderTasks.delete(pageNumber);
  const canvas = canvasEls.value[pageNumber - 1];
  if (canvas) {
    canvas.width = 0;
    canvas.height = 0;
  }
  const next = new Set(renderedPages.value);
  next.delete(pageNumber);
  renderedPages.value = next;
}

/** Render everything near the viewport, drop canvases that drifted far away. */
async function renderVisible() {
  if (!pdfDoc.value) return;
  const wanted = new Set();
  for (const pageNumber of visiblePages.value) {
    for (let n = pageNumber - RENDER_WINDOW; n <= pageNumber + RENDER_WINDOW; n++) {
      if (n >= 1 && n <= pdfDoc.value.numPages) wanted.add(n);
    }
  }
  if (wanted.size === 0) wanted.add(currentPage.value);

  for (const pageNumber of renderedPages.value) {
    if (!wanted.has(pageNumber)) clearPage(pageNumber);
  }
  for (const pageNumber of [...wanted].sort((a, b) => a - b)) {
    if (!renderedPages.value.has(pageNumber) && !renderTasks.has(pageNumber)) {
      await renderPage(pageNumber);
    }
  }
}

/* -------------------------------------------------- scroll / intersection */

let observer = null;
function observePages() {
  observer?.disconnect();
  observer = new IntersectionObserver(
    (entries) => {
      const next = new Set(visiblePages.value);
      for (const entry of entries) {
        const pageNumber = Number(entry.target.dataset.page);
        if (entry.isIntersecting) next.add(pageNumber);
        else next.delete(pageNumber);
      }
      visiblePages.value = next;
      if (next.size) currentPage.value = Math.min(...next);
      renderVisible();
    },
    { root: viewportEl.value, rootMargin: '300px 0px', threshold: 0.01 },
  );
  pageEls.value.filter(Boolean).forEach((el) => observer.observe(el));
}

let resizeObserver = null;
watch(viewportEl, (el) => {
  resizeObserver?.disconnect();
  if (!el) return;
  resizeObserver = new ResizeObserver(([entry]) => {
    containerWidth.value = entry.contentRect.width;
  });
  resizeObserver.observe(el);
  containerWidth.value = el.clientWidth;
});

// A zoom change invalidates every rendered canvas.
watch(scale, async () => {
  for (const pageNumber of [...renderedPages.value]) clearPage(pageNumber);
  await nextTick();
  await renderVisible();
});

watch(
  () => props.pages.length,
  async () => {
    await nextTick();
    observePages();
  },
);

onBeforeUnmount(() => {
  observer?.disconnect();
  resizeObserver?.disconnect();
  destroyDocument();
});

/* ----------------------------------------------------------------- actions */

function setZoom(value) {
  fitMode.value = 'custom';
  zoom.value = Math.min(Math.max(value, 0.1), 8);
}
function zoomIn() {
  setZoom(round(scale.value * 1.25));
}
function zoomOut() {
  setZoom(round(scale.value / 1.25));
}
function round(n) {
  return Math.round(n * 100) / 100;
}
function fitWidth() {
  fitMode.value = 'width';
}
function fitPage() {
  fitMode.value = 'page';
}
function resetZoom() {
  setZoom(1);
}

function goToPage(pageNumber) {
  const el = pageEls.value[pageNumber - 1];
  if (!el || !viewportEl.value) return;
  viewportEl.value.scrollTo({ top: el.offsetTop - 12, behavior: 'smooth' });
  currentPage.value = pageNumber;
}

/** Centre a server-returned hit in the viewport (used after every search). */
async function scrollToHighlight(hit) {
  if (!hit || !viewportEl.value) return;
  const el = pageEls.value[hit.page - 1];
  if (!el) return;
  await renderVisible();

  const view = viewportEl.value;
  const top = el.offsetTop + hit.bounds.y * scale.value - view.clientHeight / 2;
  const left =
    el.offsetLeft + hit.bounds.x * scale.value - view.clientWidth / 2 + hit.bounds.width / 2;

  view.scrollTo({
    top: Math.max(top, 0),
    left: Math.max(left, 0),
    behavior: 'smooth',
  });
  currentPage.value = hit.page;
}

defineExpose({ goToPage, scrollToHighlight, zoomIn, zoomOut, fitWidth });
</script>

<template>
  <section class="viewer">
    <header class="viewer-toolbar">
      <div class="group">
        <button type="button" @click="zoomOut" :disabled="!docId" title="Zoom out">&minus;</button>
        <span class="zoom-value">{{ zoomPercent }}%</span>
        <button type="button" @click="zoomIn" :disabled="!docId" title="Zoom in">+</button>
        <button
          type="button"
          class="ghost"
          :class="{ active: fitMode === 'custom' && zoom === 1 }"
          @click="resetZoom"
          :disabled="!docId"
        >
          100%
        </button>
        <button
          type="button"
          class="ghost"
          :class="{ active: fitMode === 'width' }"
          @click="fitWidth"
          :disabled="!docId"
        >
          Fit width
        </button>
        <button
          type="button"
          class="ghost"
          :class="{ active: fitMode === 'page' }"
          @click="fitPage"
          :disabled="!docId"
        >
          Fit page
        </button>
      </div>

      <div class="group">
        <button
          type="button"
          class="ghost"
          @click="goToPage(Math.max(currentPage - 1, 1))"
          :disabled="!docId || currentPage <= 1"
        >
          ‹
        </button>
        <span class="page-counter">
          Page <strong>{{ currentPage }}</strong> / {{ pages.length || 0 }}
        </span>
        <button
          type="button"
          class="ghost"
          @click="goToPage(Math.min(currentPage + 1, pages.length))"
          :disabled="!docId || currentPage >= pages.length"
        >
          ›
        </button>
      </div>
    </header>

    <div class="viewer-scroll" ref="viewportEl">
      <p v-if="!docId" class="placeholder">
        Upload a PDF drawing to start. The server extracts the text layer and returns bounding
        boxes for every hit.
      </p>
      <p v-else-if="loading" class="placeholder">Opening document…</p>

      <div
        v-for="page in pages"
        :key="page.page"
        class="page"
        :data-page="page.page"
        :ref="(el) => (pageEls[page.page - 1] = el)"
        :style="{
          width: `${Math.floor(page.width * scale)}px`,
          height: `${Math.floor(page.height * scale)}px`,
        }"
      >
        <canvas :ref="(el) => (canvasEls[page.page - 1] = el)"></canvas>

        <div v-if="!renderedPages.has(page.page)" class="page-loading">Page {{ page.page }}</div>

        <div class="overlay">
          <div
            v-for="hit in highlightsByPage.get(page.page) || []"
            :key="`${hit.index}-${hit.bounds.x}-${hit.bounds.y}`"
            class="highlight"
            :class="{ active: hit.index === activeIndex }"
            :style="{
              left: `${hit.bounds.x * scale}px`,
              top: `${hit.bounds.y * scale}px`,
              width: `${Math.max(hit.bounds.width * scale, 3)}px`,
              height: `${Math.max(hit.bounds.height * scale, 3)}px`,
            }"
            :title="hit.text"
          ></div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.viewer {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  overflow: hidden;
  background: var(--surface-2);
}

.viewer-toolbar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  background: var(--surface-1);
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
}

.group {
  display: flex;
  align-items: center;
  gap: 6px;
}

.zoom-value,
.page-counter {
  font-variant-numeric: tabular-nums;
  font-size: 13px;
  color: var(--text-muted);
  min-width: 52px;
  text-align: center;
}

/* Block layout rather than flex centring: a page wider than the viewport must
   overflow to the right and stay reachable, which `align-items: center` breaks. */
.viewer-scroll {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  padding: 16px;
  scroll-behavior: smooth;
}

.placeholder {
  margin: 15vh auto 0;
  max-width: 380px;
  text-align: center;
  color: var(--text-muted);
  line-height: 1.6;
}

.page {
  position: relative;
  margin: 0 auto 16px;
  background: #fff;
  box-shadow: 0 2px 12px rgb(0 0 0 / 35%);
}

.page:last-child {
  margin-bottom: 0;
}

.page canvas {
  display: block;
}

.page-loading {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: #9aa3af;
  font-size: 13px;
  background: repeating-linear-gradient(45deg, #f6f7f9, #f6f7f9 12px, #eef0f4 12px, #eef0f4 24px);
}

.overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.highlight {
  position: absolute;
  background: rgb(255 213 0 / 38%);
  outline: 1px solid rgb(214 158 0 / 80%);
  border-radius: 1px;
  transition: background 120ms ease;
}

.highlight.active {
  background: rgb(255 92 0 / 45%);
  outline: 2px solid rgb(255 92 0 / 95%);
  box-shadow: 0 0 0 3px rgb(255 92 0 / 20%);
}
</style>
