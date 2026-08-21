<script setup>
import { ref, shallowRef, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
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
const emit = defineEmits(['error', 'loaded', 'marks']);

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

const panning = ref(false);

/* ------------------------------------------------------------ annotations --
 * Every mark is stored in PDF points at scale 1 — the same contract the server
 * uses for search hits — and drawn into an SVG whose viewBox is the page box.
 * That is what keeps annotations welded to the drawing through zoom and pan
 * instead of drifting, and it means stroke widths scale with the document.
 */

const ANNOTATION_COLOR = '#e8262b';
const STAMP_SIZE = 22; // PDF points, the check mark's bounding box

// 'pan' | 'select' | 'pencil' | 'check' | 'rect' | 'circle'
const tool = ref('pan');
const strokeWidth = ref(2); // PDF points
const annotations = ref([]); // committed marks
const stroke = ref(null); // the in-progress pencil stroke or shape
const selectedId = ref(null);

/**
 * Undo history as whole-array snapshots rather than an add/remove log, because
 * moving and resizing a shape mutates a mark in place — an add/remove stack
 * cannot express that, so those edits would silently not be undoable.
 */
const past = ref([]);
const future = ref([]);

const HANDLE_PX = 9; // selection handles keep this pixel size at any zoom
const MIN_SHAPE = 3; // PDF points; smaller than this is a stray click, not a shape

/** Each handle gets the double-headed arrow that points along its own axis. */
const HANDLE_CURSOR = {
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
};

// What the pointer is over (or, mid-drag, what it grabbed).
const hoverCursor = ref('');

let strokeOrigin = null;
let annotationId = 0;

const annotating = computed(() => tool.value !== 'pan' && tool.value !== 'select');
const drawingShape = computed(() => tool.value === 'rect' || tool.value === 'circle');

const selectedMark = computed(
  () => annotations.value.find((mark) => mark.id === selectedId.value) ?? null,
);

/**
 * Only the select tool drives the cursor from JS; every other tool keeps the
 * cursor its CSS class sets (grab, crosshair …), so returning undefined here
 * leaves those alone rather than overriding them with `default`.
 */
const cursorStyle = computed(() =>
  tool.value === 'select' ? hoverCursor.value || 'default' : undefined,
);

/** Handles and the selection outline must not grow with the zoom. */
const handleSize = computed(() => HANDLE_PX / scale.value);
const hairline = computed(() => 1 / scale.value);

/** The 8 resize handles of a shape, in PDF points. */
function handlesFor(mark) {
  const { x, y, w, h } = normalizedBox(mark);
  const mx = x + w / 2;
  const my = y + h / 2;
  return [
    { id: 'nw', x, y },
    { id: 'n', x: mx, y },
    { id: 'ne', x: x + w, y },
    { id: 'e', x: x + w, y: my },
    { id: 'se', x: x + w, y: y + h },
    { id: 's', x: mx, y: y + h },
    { id: 'sw', x, y: y + h },
    { id: 'w', x, y: my },
  ];
}

/** Shapes are stored as drawn, so width/height can be negative mid-drag. */
function normalizedBox({ x, y, w, h }) {
  return {
    x: w < 0 ? x + w : x,
    y: h < 0 ? y + h : y,
    w: Math.abs(w),
    h: Math.abs(h),
  };
}

/** Box-shaped marks: everything the select tool can move, resize and delete. */
function isShape(mark) {
  return mark?.type === 'rect' || mark?.type === 'circle' || mark?.type === 'image';
}

/* ---------------------------------------------------------- pasted images --
 * Ctrl+V of a Snipping Tool capture. The clipboard gives a PNG; it is re-encoded
 * to JPEG here because that is what the PDF export embeds directly (DCTDecode),
 * and because a full-screen PNG is several times larger on the wire.
 */

const PASTE_MAX_PIXELS = 1600; // longest edge; keeps the payload sane
const PASTE_JPEG_QUALITY = 0.92;
const PASTE_PAGE_FRACTION = 0.45; // how much of the page width a paste covers

async function encodePaste(blob) {
  const bitmap = await createImageBitmap(blob);
  const ratio = Math.min(1, PASTE_MAX_PIXELS / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * ratio));
  const height = Math.max(1, Math.round(bitmap.height * ratio));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  // JPEG has no alpha; paint white first so transparent captures do not go black.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  const dataUrl = canvas.toDataURL('image/jpeg', PASTE_JPEG_QUALITY);
  return { dataUrl, data: dataUrl.slice(dataUrl.indexOf(',') + 1), width, height };
}

/** Which page to drop a paste on, and where: the middle of what you can see. */
function pasteTarget(image) {
  const view = viewportEl.value;
  const pageNumber = currentPage.value;
  const page = props.pages[pageNumber - 1];
  if (!view || !page) return null;

  const rect = view.getBoundingClientRect();
  const centre = pdfPointAt(rect.left + rect.width / 2, rect.top + rect.height / 2, pageNumber - 1);
  if (!centre) return null;

  const w = Math.min(page.width * PASTE_PAGE_FRACTION, image.width);
  const h = round2((w * image.height) / image.width);
  return {
    page: pageNumber,
    // Clamped so a paste never lands mostly off the page.
    x: round2(Math.min(Math.max(centre.x - w / 2, 0), Math.max(page.width - w, 0))),
    y: round2(Math.min(Math.max(centre.y - h / 2, 0), Math.max(page.height - h, 0))),
    w: round2(w),
    h,
  };
}

async function onPaste(event) {
  if (!props.docId || isTypingTarget(event.target)) return;

  const item = [...(event.clipboardData?.items ?? [])].find((entry) =>
    entry.type?.startsWith('image/'),
  );
  if (!item) return;
  event.preventDefault();

  const blob = item.getAsFile();
  if (!blob) return;

  try {
    const image = await encodePaste(blob);
    const box = pasteTarget(image);
    if (!box) return;

    const mark = {
      id: ++annotationId,
      type: 'image',
      ...box,
      width: 0,
      src: image.dataUrl,
      data: image.data,
      pixelWidth: image.width,
      pixelHeight: image.height,
    };
    addAnnotation(mark);
    // Pasting is a placement, so hand over to select: it almost always needs
    // moving or resizing straight afterwards.
    tool.value = 'select';
    selectedId.value = mark.id;
  } catch (error) {
    emit('error', `Could not paste that image: ${error.message}`);
  }
}

const annotationsByPage = computed(() => {
  const grouped = new Map();
  const all = stroke.value ? [...annotations.value, stroke.value] : annotations.value;
  for (const mark of all) {
    if (!grouped.has(mark.page)) grouped.set(mark.page, []);
    grouped.get(mark.page).push(mark);
  }
  return grouped;
});

/** `M x y L x y …` for an ink stroke; a single point becomes a visible dot. */
function inkPath(points) {
  if (points.length === 1) {
    const [p] = points;
    return `M ${p.x} ${p.y} L ${p.x + 0.01} ${p.y}`;
  }
  return points.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' ');
}

/**
 * The three vertices of a check mark centred on (x, y), in PDF points.
 * Rendering and export both read the shape from here, so the SVG on screen and
 * the ink annotation in the saved file can never disagree.
 */
function stampPoints({ x, y }, size = STAMP_SIZE) {
  const s = size / 2;
  return [
    { x: x - s * 0.8, y: y + s * 0.05 },
    { x: x - s * 0.25, y: y + s * 0.65 },
    { x: x + s * 0.85, y: y - s * 0.7 },
  ];
}

function stampPath(mark, size = STAMP_SIZE) {
  return inkPath(stampPoints(mark, size));
}

/** A rectangle as a closed polyline. */
function rectPoints(mark) {
  const { x, y, w, h } = normalizedBox(mark);
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
    { x, y },
  ];
}

/** An ellipse sampled into a closed polyline — smooth enough at print sizes. */
function ellipsePoints(mark, segments = 64) {
  const { x, y, w, h } = normalizedBox(mark);
  const cx = x + w / 2;
  const cy = y + h / 2;
  const rx = w / 2;
  const ry = h / 2;
  const points = [];
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    points.push({
      x: round2(cx + rx * Math.cos(angle)),
      y: round2(cy + ry * Math.sin(angle)),
    });
  }
  return points;
}

/**
 * Every mark flattened to a polyline the export endpoint understands, so the
 * server stays shape-agnostic: a rectangle is a closed 5-point line and an
 * ellipse is a sampled polygon.
 */
function markPoints(mark) {
  if (mark.type === 'check') return stampPoints(mark, mark.size);
  if (mark.type === 'rect') return rectPoints(mark);
  if (mark.type === 'circle') return ellipsePoints(mark);
  return mark.points;
}

function exportMarks() {
  return annotations.value.map((mark) => {
    if (mark.type === 'image') {
      const { x, y, w, h } = normalizedBox(mark);
      return {
        page: mark.page,
        x,
        y,
        w,
        h,
        image: { data: mark.data, pixelWidth: mark.pixelWidth, pixelHeight: mark.pixelHeight },
      };
    }
    return {
      page: mark.page,
      width: mark.width,
      points: markPoints(mark).map((p) => ({ x: p.x, y: p.y })),
    };
  });
}

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
    resetAnnotations(); // marks belong to the document that was open
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
let resizeTimer = null;
let wheelEl = null;
watch(viewportEl, (el) => {
  resizeObserver?.disconnect();
  clearTimeout(resizeTimer);
  wheelEl?.removeEventListener('wheel', onWheel);
  wheelEl = null;
  if (!el) return;

  // Registered by hand rather than with @wheel: preventDefault only suppresses
  // the browser's own page zoom on a non-passive listener.
  el.addEventListener('wheel', onWheel, { passive: false });
  wheelEl = el;
  resizeObserver = new ResizeObserver(([entry]) => {
    // Debounced: while a fit mode is active, dragging the split divider would
    // otherwise invalidate and re-render every canvas on every pointermove.
    const width = entry.contentRect.width;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      containerWidth.value = width;
    }, 120);
  });
  resizeObserver.observe(el);
  containerWidth.value = el.clientWidth;
});

/**
 * A zoom change invalidates every rendered canvas, but re-rendering on each
 * wheel tick would thrash. Instead the existing bitmaps are stretched to the new
 * size for instant (if briefly soft) feedback, and the sharp re-render is
 * debounced until the wheel settles.
 */
let rerenderTimer = null;
watch(scale, () => {
  for (const pageNumber of renderedPages.value) {
    const canvas = canvasEls.value[pageNumber - 1];
    const page = props.pages[pageNumber - 1];
    if (!canvas || !page || !canvas.width) continue;
    canvas.style.width = `${Math.floor(page.width * scale.value)}px`;
    canvas.style.height = `${Math.floor(page.height * scale.value)}px`;
  }

  clearTimeout(rerenderTimer);
  rerenderTimer = setTimeout(async () => {
    // Re-render in place; no clearPage first, so pages never flash to the
    // placeholder while zooming.
    for (const pageNumber of [...renderedPages.value]) await renderPage(pageNumber);
    await renderVisible();
  }, 110);
});

watch(
  () => annotations.value.length,
  (count) => emit('marks', count),
);

watch(
  () => props.pages.length,
  async () => {
    await nextTick();
    observePages();
  },
);

onMounted(() => {
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('paste', onPaste);
});

watch(tool, clearHoverCursor);

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('paste', onPaste);
  cancelAnimationFrame(hoverFrame);
  observer?.disconnect();
  resizeObserver?.disconnect();
  wheelEl?.removeEventListener('wheel', onWheel);
  clearTimeout(resizeTimer);
  clearTimeout(rerenderTimer);
  destroyDocument();
});

/* ----------------------------------------------------------------- actions */

const ZOOM_MIN = 0.1;
const ZOOM_MAX = 8;

function setZoom(value) {
  fitMode.value = 'custom';
  zoom.value = Math.min(Math.max(value, ZOOM_MIN), ZOOM_MAX);
}
function zoomIn() {
  zoomAtCenter(scale.value * 1.25);
}
function zoomOut() {
  zoomAtCenter(scale.value / 1.25);
}
function round(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Ctrl (or Cmd) + wheel zooms the viewer instead of the whole browser page, but
 * only while the pointer is over the scroll area — the listener lives on that
 * element, so the rest of the app keeps the browser's native zoom.
 * A plain wheel is left completely alone so normal scrolling still works.
 */
function onWheel(event) {
  if (!event.ctrlKey && !event.metaKey) return;
  if (!props.docId) return;
  event.preventDefault();

  // deltaMode 1 = lines (Firefox), 2 = pages; normalise to pixels.
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1;
  const factor = Math.exp((-event.deltaY * unit) / 500);
  zoomAt(scale.value * factor, event.clientX, event.clientY);
}

/** Point under the cursor in PDF points, so it can be pinned across a zoom. */
function pointOn(el, page, clientX, clientY) {
  const rect = el.getBoundingClientRect();
  // Derived from the element, not from scale.value: during a fast wheel burst
  // scale.value already holds a newer value whose layout has not flushed yet.
  const domScale = rect.width / page.width;
  if (!domScale) return null;
  return { el, x: (clientX - rect.left) / domScale, y: (clientY - rect.top) / domScale };
}

function anchorAt(clientX, clientY) {
  const els = pageEls.value;
  let fallback = null;

  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    const page = props.pages[i];
    if (!el || !page) continue;
    const rect = el.getBoundingClientRect();
    if (clientY < rect.top || clientY > rect.bottom) continue;

    const point = pointOn(el, page, clientX, clientY);
    fallback ??= point;
    // Cursor over the side gutter still anchors on this row of the page stack.
    if (clientX >= rect.left && clientX <= rect.right) return point;
  }
  if (fallback) return fallback;

  const index = currentPage.value - 1;
  const el = els[index];
  const page = props.pages[index];
  return el && page ? pointOn(el, page, clientX, clientY) : null;
}

// Only the newest zoom of a burst applies its scroll correction; stacking the
// corrections of superseded ones would overshoot.
let zoomToken = 0;

/** Zoom while keeping the point under (clientX, clientY) visually still. */
async function zoomAt(target, clientX, clientY) {
  const view = viewportEl.value;
  // 3 decimals, not 2: a fine trackpad pinch moves the scale by well under 1 %,
  // and rounding those steps away makes the gesture feel stuck.
  const next = Math.min(Math.max(Math.round(target * 1000) / 1000, ZOOM_MIN), ZOOM_MAX);
  if (!view || next === scale.value) return;

  const anchor = anchorAt(clientX, clientY);
  const token = ++zoomToken;
  setZoom(next);
  if (!anchor) return;

  await nextTick(); // page boxes have resized; read their new geometry
  if (token !== zoomToken) return;

  const rect = anchor.el.getBoundingClientRect();
  view.scrollTo({
    left: view.scrollLeft + (rect.left + anchor.x * next - clientX),
    top: view.scrollTop + (rect.top + anchor.y * next - clientY),
    // 'instant' beats the CSS scroll-behavior: smooth, which would lag the zoom.
    behavior: 'instant',
  });

  // Zooming mid-drag (ctrl + wheel while holding the button) would leave the pan
  // origin pointing at the pre-zoom scroll offset, and the next pointermove
  // would snap the page back. Re-base it on where things are now.
  if (panning.value && panOrigin) {
    panOrigin.x = clientX;
    panOrigin.y = clientY;
    panOrigin.left = view.scrollLeft;
    panOrigin.top = view.scrollTop;
  }
}

/* --------------------------------------------------------------- panning --
 * Hovering the page area gives a grab cursor; holding the left button drags the
 * document around. Touch is deliberately excluded — those devices already pan
 * natively, and handling both would move the page twice per gesture.
 */

let panOrigin = null;

/** One entry point for the scroll area; the active tool decides what happens. */
function onPointerDown(event) {
  if (tool.value === 'pan') {
    startPan(event);
    return;
  }
  if (!props.docId || event.button !== 0) return;

  if (tool.value === 'select') beginSelection(event);
  else if (tool.value === 'check') placeStamp(event);
  else if (tool.value === 'pencil') startStroke(event);
  else if (drawingShape.value) startShape(event);
}

function onPointerMove(event) {
  if (drag) {
    dragMove(event);
    return;
  }
  // Hover feedback for the select tool: move over a shape, a double-headed
  // arrow over each handle. Only runs when idle, so a drag keeps its cursor.
  if (tool.value === 'select' && !stroke.value) scheduleHoverCursor(event);
  if (stroke.value) {
    if (isShape(stroke.value)) resizeNewShape(event);
    else extendStroke(event);
    return;
  }
  onPan(event);
}

function onPointerUp(event) {
  if (drag) {
    dragEnd(event);
    return;
  }
  if (stroke.value) {
    if (isShape(stroke.value)) endShape(event);
    else endStroke(event);
    return;
  }
  endPan(event);
}

/**
 * Client coordinates -> { pageIndex, x, y } in PDF points. `lockedIndex` keeps a
 * stroke on the page it started on even if the pointer wanders off it.
 */
function pdfPointAt(clientX, clientY, lockedIndex = null) {
  const els = pageEls.value;

  const project = (index) => {
    const el = els[index];
    const page = props.pages[index];
    if (!el || !page) return null;
    const rect = el.getBoundingClientRect();
    const domScale = rect.width / page.width;
    if (!domScale) return null;
    return {
      index,
      page: page.page,
      x: round2((clientX - rect.left) / domScale),
      y: round2((clientY - rect.top) / domScale),
    };
  };

  if (lockedIndex !== null) return project(lockedIndex);

  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    if (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    ) {
      return project(i);
    }
  }
  return null; // the pointer is in the gutter, not on a page
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/* ------------------------------------------------------------ shape tools -- */

function startShape(event) {
  const point = pdfPointAt(event.clientX, event.clientY);
  if (!point) return;
  event.preventDefault();
  viewportEl.value?.setPointerCapture?.(event.pointerId);

  strokeOrigin = { pointerId: event.pointerId, index: point.index };
  selectedId.value = null;
  stroke.value = {
    id: ++annotationId,
    type: tool.value === 'rect' ? 'rect' : 'circle',
    page: point.page,
    x: point.x,
    y: point.y,
    w: 0,
    h: 0,
    width: strokeWidth.value,
  };
}

function resizeNewShape(event) {
  if (!strokeOrigin) return;
  const point = pdfPointAt(event.clientX, event.clientY, strokeOrigin.index);
  if (!point) return;
  stroke.value.w = round2(point.x - stroke.value.x);
  stroke.value.h = round2(point.y - stroke.value.y);
}

function endShape(event) {
  const view = viewportEl.value;
  if (view?.hasPointerCapture?.(event.pointerId)) view.releasePointerCapture(event.pointerId);

  const shape = stroke.value;
  stroke.value = null;
  strokeOrigin = null;
  if (!shape) return;

  // A click without a drag is not a shape.
  if (Math.abs(shape.w) < MIN_SHAPE || Math.abs(shape.h) < MIN_SHAPE) return;

  addAnnotation({ ...shape, ...normalizedBox(shape) });
  // The tool stays active on purpose: picking the circle once should let you
  // draw as many circles as you like. Switch to Select to adjust one.
}

/* -------------------------------------------------- select / move / resize -- */

let drag = null;

/** Topmost shape whose box contains the point, or null. */
function shapeAt(point) {
  const slack = handleSize.value / 2;
  for (let i = annotations.value.length - 1; i >= 0; i--) {
    const mark = annotations.value[i];
    if (!isShape(mark) || mark.page !== point.page) continue;
    const { x, y, w, h } = normalizedBox(mark);
    if (
      point.x >= x - slack &&
      point.x <= x + w + slack &&
      point.y >= y - slack &&
      point.y <= y + h + slack
    ) {
      return mark;
    }
  }
  return null;
}

function handleAt(mark, point) {
  const reach = handleSize.value;
  return (
    handlesFor(mark).find(
      (handle) => Math.abs(point.x - handle.x) <= reach && Math.abs(point.y - handle.y) <= reach,
    ) ?? null
  );
}

/**
 * Hit-testing walks page rects, so it is throttled to one frame. Nothing writes
 * to the DOM in between, which keeps these reads out of a forced-reflow loop.
 */
let hoverFrame = 0;
function scheduleHoverCursor(event) {
  if (hoverFrame) return;
  const { clientX, clientY } = event;
  hoverFrame = requestAnimationFrame(() => {
    hoverFrame = 0;
    hoverCursor.value = cursorFor(clientX, clientY);
  });
}

function cursorFor(clientX, clientY) {
  const point = pdfPointAt(clientX, clientY);
  if (!point) return 'default';

  const current = selectedMark.value;
  if (current && current.page === point.page) {
    const handle = handleAt(current, point);
    if (handle) return HANDLE_CURSOR[handle.id];
  }
  return shapeAt(point) ? 'move' : 'default';
}

function clearHoverCursor() {
  cancelAnimationFrame(hoverFrame);
  hoverFrame = 0;
  hoverCursor.value = '';
}

function beginSelection(event) {
  const point = pdfPointAt(event.clientX, event.clientY);
  if (!point) {
    selectedId.value = null;
    return;
  }

  // A handle of the current selection wins over anything underneath it.
  const current = selectedMark.value;
  const handle = current && current.page === point.page ? handleAt(current, point) : null;
  if (handle) {
    event.preventDefault();
    viewportEl.value?.setPointerCapture?.(event.pointerId);
    hoverCursor.value = HANDLE_CURSOR[handle.id];
    drag = {
      mode: 'resize',
      handle: handle.id,
      pointerId: event.pointerId,
      index: point.index,
      origin: point,
      start: normalizedBox(current),
      snapshot: annotations.value,
    };
    return;
  }

  const hit = shapeAt(point);
  selectedId.value = hit?.id ?? null;
  if (!hit) return;

  event.preventDefault();
  viewportEl.value?.setPointerCapture?.(event.pointerId);
  hoverCursor.value = 'move';
  drag = {
    mode: 'move',
    pointerId: event.pointerId,
    index: point.index,
    origin: point,
    start: normalizedBox(hit),
    snapshot: annotations.value,
  };
}

/** Replace one mark immutably so snapshot history stays valid. */
function updateMark(id, patch) {
  annotations.value = annotations.value.map((mark) =>
    mark.id === id ? { ...mark, ...patch } : mark,
  );
}

function dragMove(event) {
  const point = pdfPointAt(event.clientX, event.clientY, drag.index);
  if (!point) return;
  const dx = point.x - drag.origin.x;
  const dy = point.y - drag.origin.y;
  const { x, y, w, h } = drag.start;

  if (drag.mode === 'move') {
    updateMark(selectedId.value, { x: round2(x + dx), y: round2(y + dy) });
    return;
  }

  // Resize: each handle moves the edges it touches. Left/top handles move the
  // origin as well as the size, which is why x/y are recomputed here.
  const handle = drag.handle;
  let nx = x;
  let ny = y;
  let nw = w;
  let nh = h;

  if (handle.includes('w')) {
    nx = x + dx;
    nw = w - dx;
  }
  if (handle.includes('e')) nw = w + dx;
  if (handle.includes('n')) {
    ny = y + dy;
    nh = h - dy;
  }
  if (handle.includes('s')) nh = h + dy;

  updateMark(selectedId.value, {
    x: round2(nx),
    y: round2(ny),
    w: round2(nw),
    h: round2(nh),
  });
}

function dragEnd(event) {
  const view = viewportEl.value;
  if (view?.hasPointerCapture?.(event.pointerId)) view.releasePointerCapture(event.pointerId);

  const mark = selectedMark.value;
  if (mark) {
    // A resize dragged past the opposite edge leaves negative width/height.
    const box = normalizedBox(mark);
    if (box.w < MIN_SHAPE || box.h < MIN_SHAPE) {
      // Collapsed to nothing: put it back as it was rather than keeping a sliver.
      annotations.value = drag.snapshot;
    } else {
      updateMark(mark.id, box);
      pushHistory(drag.snapshot);
    }
  }
  drag = null;
  hoverCursor.value = cursorFor(event.clientX, event.clientY);
}

function deleteSelected() {
  if (!selectedId.value) return;
  pushHistory(annotations.value);
  annotations.value = annotations.value.filter((mark) => mark.id !== selectedId.value);
  selectedId.value = null;
}

function placeStamp(event) {
  const point = pdfPointAt(event.clientX, event.clientY);
  if (!point) return;
  event.preventDefault();
  addAnnotation(
    {
      id: ++annotationId,
      type: 'check',
      page: point.page,
      x: point.x,
      y: point.y,
      size: STAMP_SIZE,
      width: Math.max(strokeWidth.value * 1.4, 2),
    },
  );
}

function startStroke(event) {
  const point = pdfPointAt(event.clientX, event.clientY);
  if (!point) return;
  event.preventDefault();
  viewportEl.value?.setPointerCapture?.(event.pointerId);
  strokeOrigin = { pointerId: event.pointerId, index: point.index };
  stroke.value = {
    id: ++annotationId,
    type: 'ink',
    page: point.page,
    points: [{ x: point.x, y: point.y }],
    width: strokeWidth.value,
  };
}

function extendStroke(event) {
  if (!strokeOrigin) return;
  const point = pdfPointAt(event.clientX, event.clientY, strokeOrigin.index);
  if (!point) return;

  const points = stroke.value.points;
  const last = points[points.length - 1];
  // Skip sub-pixel jitter; it bloats the path for no visible gain.
  if (Math.hypot(point.x - last.x, point.y - last.y) < 0.4) return;
  // Pushed, not copied: ref() is deeply reactive, and rebuilding the array on
  // every pointermove would make a long stroke quadratic.
  points.push({ x: point.x, y: point.y });
}

function endStroke(event) {
  const view = viewportEl.value;
  if (view?.hasPointerCapture?.(event.pointerId)) view.releasePointerCapture(event.pointerId);
  if (stroke.value) addAnnotation(stroke.value);
  stroke.value = null;
  strokeOrigin = null;
}

/** Remember the pre-change array and drop the redo branch, as editors do. */
function pushHistory(snapshot) {
  past.value = [...past.value, snapshot];
  future.value = [];
}

function addAnnotation(mark) {
  pushHistory(annotations.value);
  annotations.value = [...annotations.value, mark];
}

function undoAnnotation() {
  if (!past.value.length) return;
  future.value = [...future.value, annotations.value];
  annotations.value = past.value[past.value.length - 1];
  past.value = past.value.slice(0, -1);
  keepSelectionValid();
}

function redoAnnotation() {
  if (!future.value.length) return;
  past.value = [...past.value, annotations.value];
  annotations.value = future.value[future.value.length - 1];
  future.value = future.value.slice(0, -1);
  keepSelectionValid();
}

/** A mark that undo removed must not stay selected, or handles float alone. */
function keepSelectionValid() {
  if (selectedId.value && !annotations.value.some((mark) => mark.id === selectedId.value)) {
    selectedId.value = null;
  }
}

function clearAnnotations() {
  if (!annotations.value.length) return;
  pushHistory(annotations.value);
  annotations.value = [];
  stroke.value = null;
  selectedId.value = null;
}

/** Wipe the marks and the history — used when a different document is opened. */
function resetAnnotations() {
  annotations.value = [];
  past.value = [];
  future.value = [];
  stroke.value = null;
  strokeOrigin = null;
  selectedId.value = null;
  drag = null;
}

function cancelStroke() {
  stroke.value = null;
  strokeOrigin = null;
}

/* ------------------------------------------------------------- shortcuts -- */

function isTypingTarget(target) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/**
 * Escape returns to the hand tool; Ctrl/Cmd+Z undoes and Ctrl/Cmd+Y redoes.
 * Skipped entirely while a form field has focus, so Ctrl+Z still undoes typing
 * in the search panel's term inputs rather than removing a drawn mark.
 */
function onKeyDown(event) {
  if (isTypingTarget(event.target)) return;

  // Delete removes the selected shape. Guarded by isTypingTarget above, so
  // Backspace still deletes text in the search panel's term fields.
  if ((event.key === 'Delete' || event.key === 'Backspace') && selectedId.value) {
    event.preventDefault();
    deleteSelected();
    return;
  }

  if (event.key === 'Escape') {
    if (stroke.value) cancelStroke();
    if (selectedId.value) {
      selectedId.value = null;
      event.preventDefault();
      return;
    }
    if (tool.value !== 'pan') {
      tool.value = 'pan';
      event.preventDefault();
    }
    return;
  }

  if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
  const key = event.key.toLowerCase();

  if (key === 'z' && !event.shiftKey) {
    event.preventDefault();
    undoAnnotation();
  } else if (key === 'y' || (key === 'z' && event.shiftKey)) {
    // Ctrl+Shift+Z as well: Cmd+Y is not redo on macOS.
    event.preventDefault();
    redoAnnotation();
  }
}

function startPan(event) {
  if (!props.docId || event.button !== 0 || event.pointerType === 'touch') return;
  const view = viewportEl.value;
  if (!view) return;

  panOrigin = {
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    left: view.scrollLeft,
    top: view.scrollTop,
  };
  panning.value = true;
  view.setPointerCapture?.(event.pointerId);
  event.preventDefault(); // otherwise the canvas starts a native image drag
}

function onPan(event) {
  if (!panning.value || !panOrigin) return;
  const view = viewportEl.value;
  if (!view) return;

  view.scrollTo({
    left: panOrigin.left - (event.clientX - panOrigin.x),
    top: panOrigin.top - (event.clientY - panOrigin.y),
    // Must be instant: the container sets scroll-behavior: smooth, which would
    // animate every pan step and make the drag lag behind the cursor.
    behavior: 'instant',
  });
}

function endPan(event) {
  if (!panning.value) return;
  panning.value = false;
  panOrigin = null;
  const view = viewportEl.value;
  if (view?.hasPointerCapture?.(event.pointerId)) view.releasePointerCapture(event.pointerId);
}

function zoomAtCenter(target) {
  const view = viewportEl.value;
  if (!view) {
    setZoom(round(target));
    return;
  }
  const rect = view.getBoundingClientRect();
  zoomAt(target, rect.left + rect.width / 2, rect.top + rect.height / 2);
}
function fitWidth() {
  fitMode.value = 'width';
}
function fitPage() {
  fitMode.value = 'page';
}
function resetZoom() {
  zoomAtCenter(1);
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

defineExpose({ goToPage, scrollToHighlight, zoomIn, zoomOut, fitWidth, exportMarks });
</script>

<template>
  <section class="viewer">
    <header class="viewer-toolbar">
      <div class="group">
        <button type="button" @click="zoomOut" :disabled="!docId" title="Zoom out">&minus;</button>
        <span class="zoom-value" title="Ctrl + scroll over the page to zoom">{{ zoomPercent }}%</span>
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

      <div class="group tools">
        <button
          type="button"
          class="ghost"
          :class="{ active: tool === 'pan' }"
          @click="tool = 'pan'"
          :disabled="!docId"
          title="Hand — drag to move the drawing"
        >
          ✋
        </button>
        <button
          type="button"
          class="ghost"
          :class="{ active: tool === 'select' }"
          @click="tool = 'select'"
          :disabled="!docId"
          title="Select — click a shape to move, resize or delete it"
        >
          ⬉
        </button>
        <button
          type="button"
          class="ghost"
          :class="{ active: tool === 'pencil' }"
          @click="tool = 'pencil'"
          :disabled="!docId"
          title="Pencil — draw in red (Esc returns to the hand)"
        >
          ✏️
        </button>
        <button
          type="button"
          class="ghost"
          :class="{ active: tool === 'rect' }"
          @click="tool = 'rect'"
          :disabled="!docId"
          title="Rectangle — drag to draw a red box"
        >
          ▭
        </button>
        <button
          type="button"
          class="ghost"
          :class="{ active: tool === 'circle' }"
          @click="tool = 'circle'"
          :disabled="!docId"
          title="Circle — drag to draw a red ellipse"
        >
          ◯
        </button>
        <button
          type="button"
          class="ghost"
          :class="{ active: tool === 'check' }"
          @click="tool = 'check'"
          :disabled="!docId"
          title="Check stamp — click to place a red tick (Esc returns to the hand)"
        >
          ✔
        </button>

        <select
          v-model.number="strokeWidth"
          class="thickness"
          :disabled="!docId"
          title="Line thickness"
        >
          <option :value="1">Thin</option>
          <option :value="2">Medium</option>
          <option :value="4">Thick</option>
          <option :value="7">Extra</option>
        </select>

        <button
          type="button"
          class="ghost"
          @click="undoAnnotation"
          :disabled="!past.length"
          title="Undo (Ctrl+Z)"
        >
          ↶
        </button>
        <button
          type="button"
          class="ghost"
          @click="redoAnnotation"
          :disabled="!future.length"
          title="Redo (Ctrl+Y)"
        >
          ↷
        </button>
        <button
          type="button"
          class="ghost"
          @click="clearAnnotations"
          :disabled="!annotations.length"
          title="Remove every mark — Ctrl+Y brings them back one by one"
        >
          Clear
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

    <div
      class="viewer-scroll"
      ref="viewportEl"
      :class="{ grabbable: Boolean(docId) && tool === 'pan', panning, annotating, selecting: tool === 'select' }"
      :style="{ cursor: cursorStyle }"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @pointerleave="clearHoverCursor"
    >
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

        <!-- Annotations. The viewBox is the page in PDF points, so every mark is
             stored at scale 1 and the browser scales it with the zoom. -->
        <svg
          v-if="annotationsByPage.has(page.page)"
          class="ink"
          :viewBox="`0 0 ${page.width} ${page.height}`"
          preserveAspectRatio="none"
        >
          <template v-for="mark in annotationsByPage.get(page.page)" :key="mark.id">
            <rect
              v-if="mark.type === 'rect'"
              :x="normalizedBox(mark).x"
              :y="normalizedBox(mark).y"
              :width="normalizedBox(mark).w"
              :height="normalizedBox(mark).h"
              fill="none"
              :stroke="ANNOTATION_COLOR"
              :stroke-width="mark.width"
            />
            <image
              v-else-if="mark.type === 'image'"
              :href="mark.src"
              :x="normalizedBox(mark).x"
              :y="normalizedBox(mark).y"
              :width="normalizedBox(mark).w"
              :height="normalizedBox(mark).h"
              preserveAspectRatio="none"
            />
            <ellipse
              v-else-if="mark.type === 'circle'"
              :cx="normalizedBox(mark).x + normalizedBox(mark).w / 2"
              :cy="normalizedBox(mark).y + normalizedBox(mark).h / 2"
              :rx="normalizedBox(mark).w / 2"
              :ry="normalizedBox(mark).h / 2"
              fill="none"
              :stroke="ANNOTATION_COLOR"
              :stroke-width="mark.width"
            />
            <path
              v-else
              :d="mark.type === 'check' ? stampPath(mark, mark.size) : inkPath(mark.points)"
              fill="none"
              :stroke="ANNOTATION_COLOR"
              :stroke-width="mark.width"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </template>

          <!-- Selection outline + resize handles, sized in points so they keep a
               constant pixel size however far the viewer is zoomed. -->
          <g v-if="selectedMark && selectedMark.page === page.page" class="selection">
            <rect
              :x="normalizedBox(selectedMark).x"
              :y="normalizedBox(selectedMark).y"
              :width="normalizedBox(selectedMark).w"
              :height="normalizedBox(selectedMark).h"
              fill="none"
              stroke="#2563eb"
              :stroke-width="hairline"
              :stroke-dasharray="`${hairline * 4} ${hairline * 3}`"
            />
            <rect
              v-for="handle in handlesFor(selectedMark)"
              :key="handle.id"
              :x="handle.x - handleSize / 2"
              :y="handle.y - handleSize / 2"
              :width="handleSize"
              :height="handleSize"
              fill="#ffffff"
              stroke="#2563eb"
              :stroke-width="hairline"
            />
          </g>
        </svg>

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
  background: var(--viewer-bg);
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

/* Hand cursor over the document; closed hand while dragging it around. */
.viewer-scroll.grabbable {
  cursor: grab;
}

.viewer-scroll.panning {
  cursor: grabbing;
  user-select: none;
}

.viewer-scroll.annotating {
  cursor: crosshair;
  user-select: none;
}

.viewer-scroll.selecting {
  cursor: default;
  user-select: none;
}

/* Annotation layer: above the canvas, never intercepting the pointer — the
   scroll container owns all pointer handling. */
.ink {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.tools .thickness {
  font: inherit;
  color: var(--text);
  background: var(--surface-3);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 5px 6px;
}

.tools .ghost.active {
  background: var(--accent-soft);
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
  box-shadow: var(--page-shadow);
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
