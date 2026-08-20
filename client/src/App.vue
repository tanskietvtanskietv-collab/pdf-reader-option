<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import PdfViewer from './components/PdfViewer.vue';
import SearchPanel from './components/SearchPanel.vue';
import SaveDialog from './components/SaveDialog.vue';
import ThemeToggle from './components/ThemeToggle.vue';
import {
  fetchCategories,
  uploadPdf,
  searchTerm,
  searchBatch,
  releaseDocument,
  exportAnnotatedPdf,
  pickSaveLocation,
  writePdf,
  canPickSaveLocation,
  saveAnnotatedPdfTo,
} from './api.js';

const categories = ref([]);
const category = ref('Wakugumi');

const doc = ref(null); // { docId, fileName, totalPages, pages, parseMs, byteSize }
const status = reactive({ state: 'idle', message: '', progress: 0 });

/** Per row search state, keyed by `${category}#${index}`. */
const results = reactive({});
const activeRowId = ref(null);
const batchBusy = ref(false);
const dragging = ref(false);

const viewer = ref(null);
const fileInput = ref(null);

const ready = computed(() => Boolean(doc.value));
const activeState = computed(() => (activeRowId.value ? results[activeRowId.value] : null));
const highlights = computed(() => activeState.value?.results ?? []);
const activeIndex = computed(() => activeState.value?.activeMatch ?? -1);

onMounted(async () => {
  try {
    const payload = await fetchCategories();
    categories.value = payload.categories;
    if (!payload.categories.some((c) => c.name === category.value)) {
      category.value = payload.categories[0]?.name ?? '';
    }
  } catch (error) {
    setStatus('error', `Could not load the term dictionaries: ${error.message}`);
  }
});

function setStatus(state, message = '', progress = 0) {
  status.state = state;
  status.message = message;
  status.progress = progress;
}

/* ------------------------------------------------------------------ upload */

function pickFile() {
  fileInput.value?.click();
}

async function onFileChosen(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (file) await upload(file);
}

function onDragLeave(event) {
  // Ignore the dragleave events fired while crossing child elements.
  if (!event.relatedTarget) dragging.value = false;
}

async function onDrop(event) {
  dragging.value = false;
  const file = event.dataTransfer?.files?.[0];
  if (file) await upload(file);
}

async function upload(file) {
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
    setStatus('error', 'Only PDF files can be uploaded.');
    return;
  }

  const previousDocId = doc.value?.docId ?? null;
  clearResults();
  doc.value = null;
  setStatus('uploading', `Uploading ${file.name}…`, 0);

  try {
    const payload = await uploadPdf(file, previousDocId, (percent) => {
      if (percent < 100) setStatus('uploading', `Uploading ${file.name}…`, percent);
      else setStatus('parsing', 'Server is extracting the text layer…', 100);
    });
    doc.value = payload;
    setStatus(
      'ready',
      `${payload.totalPages} page${payload.totalPages === 1 ? '' : 's'} indexed in ${payload.parseMs} ms`,
    );
  } catch (error) {
    setStatus('error', error.message);
  }
}

async function closeDocument() {
  const docId = doc.value?.docId;
  doc.value = null;
  clearResults();
  setStatus('idle');
  if (docId) await releaseDocument(docId).catch(() => {});
}

/* ------------------------------------------------------------------ search */

function clearResults() {
  for (const key of Object.keys(results)) delete results[key];
  activeRowId.value = null;
}

function rowState(id) {
  if (!results[id]) {
    results[id] = { status: 'idle', totalMatches: 0, pages: [], results: null, activeMatch: 0 };
  }
  return results[id];
}

/** Triggered by Enter on a term input. */
async function runSearch({ id, query }) {
  if (!doc.value) return;
  const state = rowState(id);
  state.status = 'loading';
  state.error = '';
  activeRowId.value = id;

  try {
    const payload = await searchTerm(doc.value.docId, query, category.value);
    state.status = 'done';
    state.totalMatches = payload.totalMatches;
    state.pages = payload.pages;
    state.results = payload.results;
    state.activeMatch = payload.results.length ? 0 : -1;
    state.truncated = payload.truncated;

    if (payload.results.length) await viewer.value?.scrollToHighlight(payload.results[0]);
  } catch (error) {
    state.status = 'error';
    state.error = error.message;
    state.totalMatches = 0;
    state.results = null;
  }
}

/** Fill every badge of the current category in a single request. */
async function runSearchAll() {
  if (!doc.value) return;
  batchBusy.value = true;
  const items = categories.value.find((c) => c.name === category.value)?.items ?? [];
  items.forEach((_, index) => {
    rowState(`${category.value}#${index}`).status = 'loading';
  });

  try {
    const payload = await searchBatch(doc.value.docId, category.value, items);
    payload.results.forEach((result, index) => {
      const state = rowState(`${category.value}#${index}`);
      state.status = 'done';
      state.totalMatches = result.totalMatches;
      state.pages = result.pages;
      // Coordinates are fetched on demand when the row becomes active.
      state.results = null;
      state.activeMatch = 0;
    });
    setStatus('ready', `${payload.termsWithMatches} of ${payload.totalTerms} terms found`);
  } catch (error) {
    setStatus('error', error.message);
    items.forEach((_, index) => {
      const state = rowState(`${category.value}#${index}`);
      if (state.status === 'loading') state.status = 'idle';
    });
  } finally {
    batchBusy.value = false;
  }
}

async function stepMatch({ id, delta, query }) {
  const state = rowState(id);
  activeRowId.value = id;

  // Batch results carry counts only; pull the coordinates on first navigation.
  if (!state.results) {
    const items = categories.value.find((c) => c.name === category.value)?.items ?? [];
    const index = Number(id.split('#')[1]);
    await runSearch({ id, query: query ?? items[index] });
    return;
  }
  if (!state.results.length) return;

  state.activeMatch = (state.activeMatch + delta + state.results.length) % state.results.length;
  await viewer.value?.scrollToHighlight(state.results[state.activeMatch]);
}

watch(category, () => {
  activeRowId.value = null;
});

/* -------------------------------------------------------------- save as pdf */

const markCount = ref(0);
const saving = ref(false);

const suggestedFileName = computed(() => {
  const base = (doc.value?.fileName ?? 'document').replace(/\.pdf$/i, '');
  return `${base}-marked.pdf`;
});

const saveDialogOpen = ref(false);
const saveError = ref('');

/**
 * Always choose the destination before anything is written.
 *
 * Where the browser has `showSaveFilePicker` (a secure context) that native
 * dialog is the folder chooser, and it must be opened straight off the click —
 * it needs that click's user activation, which building the file would consume.
 * Otherwise the in-app dialog browses folders on the server machine instead.
 */
async function savePdf() {
  if (!doc.value || !markCount.value || saving.value) return;
  saveError.value = '';

  if (canPickSaveLocation()) {
    let handle = null;
    try {
      handle = await pickSaveLocation(suggestedFileName.value);
    } catch (error) {
      if (error?.name === 'AbortError') return; // the user closed the dialog
    }
    if (handle) {
      await writeThroughBrowser(handle);
      return;
    }
  }

  saveDialogOpen.value = true;
}

async function writeThroughBrowser(handle) {
  saving.value = true;
  setStatus('saving', 'Writing the marks into a copy of the PDF…');
  try {
    const blob = await exportAnnotatedPdf(doc.value.docId, viewer.value?.exportMarks() ?? []);
    const name = await writePdf(blob, handle, suggestedFileName.value);
    setStatus('ready', `Saved ${name}`);
  } catch (error) {
    setStatus('error', `Could not save: ${error.message}`);
  } finally {
    saving.value = false;
  }
}

/** Destination chosen in the in-app dialog: the server writes the file. */
async function saveToFolder({ destination, fileName, overwrite = false }) {
  saving.value = true;
  saveError.value = '';
  setStatus('saving', 'Writing the marks into a copy of the PDF…');
  try {
    const marks = viewer.value?.exportMarks() ?? [];
    const saved = await saveAnnotatedPdfTo(doc.value.docId, marks, {
      destination,
      fileName,
      overwrite,
    });
    saveDialogOpen.value = false;
    setStatus('ready', `Saved to ${saved.path}`);
  } catch (error) {
    if (error.code === 'EEXIST_PDF') {
      // Never overwrite silently; ask, then retry with the flag.
      if (window.confirm(`${error.message}. Replace it?`)) {
        await saveToFolder({ destination, fileName, overwrite: true });
        return;
      }
      saveError.value = 'Pick another name or folder.';
    } else {
      saveError.value = error.message;
    }
    setStatus('ready', '');
  } finally {
    saving.value = false;
  }
}

/* ---------------------------------------------------------- split resizing */

const PANEL_DEFAULT = 15; // viewer 85 % / search panel 15 %
const PANEL_MIN = 10;
const PANEL_MAX = 60;
const PANEL_MIN_PX = 180; // below this the term rows stop being usable. Chosen so
                          // the 15 % default survives on any window >= 1200px.
const PANEL_STORAGE_KEY = 'pdf-term-reader:panel-width';

const layoutEl = ref(null);
const resizing = ref(false);
const panelWidth = ref(readStoredPanelWidth());

const layoutColumns = computed(() => `1fr 6px ${panelWidth.value}%`);

function readStoredPanelWidth() {
  try {
    const stored = Number(localStorage.getItem(PANEL_STORAGE_KEY));
    if (Number.isFinite(stored) && stored >= PANEL_MIN && stored <= PANEL_MAX) return stored;
  } catch {
    /* storage can be unavailable (private mode); the default is fine */
  }
  return PANEL_DEFAULT;
}

function storePanelWidth() {
  try {
    localStorage.setItem(PANEL_STORAGE_KEY, String(Math.round(panelWidth.value * 10) / 10));
  } catch {
    /* ignore */
  }
}

/** Percentage clamp that also enforces a pixel floor for the term list. */
function clampPanel(percent) {
  const width = layoutEl.value?.clientWidth ?? 0;
  const min = width ? Math.max(PANEL_MIN, (PANEL_MIN_PX / width) * 100) : PANEL_MIN;
  return Math.min(Math.max(percent, min), PANEL_MAX);
}

function startResize(event) {
  resizing.value = true;
  event.currentTarget.setPointerCapture?.(event.pointerId);
}

function onResize(event) {
  if (!resizing.value || !layoutEl.value) return;
  const rect = layoutEl.value.getBoundingClientRect();
  // Dragging the divider left grows the panel, right shrinks it.
  panelWidth.value = clampPanel(((rect.right - event.clientX) / rect.width) * 100);
}

function endResize(event) {
  if (!resizing.value) return;
  resizing.value = false;
  event.currentTarget.releasePointerCapture?.(event.pointerId);
  storePanelWidth();
}

function nudgePanel(delta) {
  panelWidth.value = clampPanel(panelWidth.value + delta);
  storePanelWidth();
}

function resetPanelWidth() {
  panelWidth.value = PANEL_DEFAULT;
  storePanelWidth();
}

// A narrower window can push the stored percentage below the pixel floor.
function reclampPanel() {
  panelWidth.value = clampPanel(panelWidth.value);
}
onMounted(() => window.addEventListener('resize', reclampPanel));
onBeforeUnmount(() => window.removeEventListener('resize', reclampPanel));

const statusLabel = computed(() => {
  switch (status.state) {
    case 'uploading':
      return `Uploading ${status.progress}%`;
    case 'parsing':
      return 'Parsing on server';
    case 'saving':
      return 'Saving';
    case 'ready':
      return 'Ready';
    case 'error':
      return 'Error';
    default:
      return 'Idle';
  }
});
</script>

<template>
  <div
    class="app"
    :class="{ dragging, resizing }"
    @dragover.prevent="dragging = true"
    @dragleave.prevent="onDragLeave"
    @drop.prevent="onDrop"
  >
    <header class="app-header">
      <div class="brand">
        <strong>PDF Term Reader</strong>
        <span>Wakugumi / Jikugumi</span>
      </div>

      <div class="file">
        <button type="button" class="primary" @click="pickFile">Upload PDF</button>
        <input ref="fileInput" type="file" accept="application/pdf,.pdf" hidden @change="onFileChosen" />
        <span v-if="doc" class="file-name" :title="doc.fileName">{{ doc.fileName }}</span>
        <span v-else class="file-name muted">No file loaded</span>
        <button
          v-if="doc"
          type="button"
          class="primary"
          @click="savePdf"
          :disabled="!markCount || saving"
          :title="
            markCount
              ? 'Save a copy with your marks burned in'
              : 'Draw or stamp something first'
          "
        >
          {{ saving ? 'Saving…' : 'Save as PDF…' }}
          <span v-if="markCount" class="mark-count">{{ markCount }}</span>
        </button>
        <button v-if="doc" type="button" class="ghost" @click="closeDocument">Close</button>
      </div>

      <div class="status" :data-state="status.state">
        <span class="dot"></span>
        <span class="status-label">{{ statusLabel }}</span>
        <span class="status-message">{{ status.message }}</span>
      </div>

      <ThemeToggle />
    </header>

    <main class="layout" ref="layoutEl" :style="{ gridTemplateColumns: layoutColumns }">
      <PdfViewer
        ref="viewer"
        :doc-id="doc?.docId ?? null"
        :pages="doc?.pages ?? []"
        :highlights="highlights"
        :active-index="activeIndex"
        @error="setStatus('error', $event)"
        @marks="markCount = $event"
      />

      <div
        class="resizer"
        :class="{ active: resizing }"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the search panel"
        :aria-valuenow="Math.round(panelWidth)"
        :aria-valuemin="PANEL_MIN"
        :aria-valuemax="PANEL_MAX"
        tabindex="0"
        title="Drag to resize — double-click to reset"
        @pointerdown="startResize"
        @pointermove="onResize"
        @pointerup="endResize"
        @pointercancel="endResize"
        @dblclick="resetPanelWidth"
        @keydown.left.prevent="nudgePanel(1)"
        @keydown.right.prevent="nudgePanel(-1)"
      >
        <span class="grip"></span>
      </div>

      <SearchPanel
        :categories="categories"
        :category="category"
        :results="results"
        :active-row-id="activeRowId"
        :disabled="!ready"
        :busy="batchBusy"
        @update:category="category = $event"
        @search="runSearch"
        @search-all="runSearchAll"
        @clear="clearResults"
        @step-match="stepMatch"
      />
    </main>

    <SaveDialog
      :open="saveDialogOpen"
      :suggested-name="suggestedFileName"
      :mark-count="markCount"
      :busy="saving"
      :error="saveError"
      @close="saveDialogOpen = false"
      @save="saveToFolder"
    />

    <div v-if="dragging" class="drop-hint">Drop the PDF to upload</div>
  </div>
</template>

<style scoped>
.app {
  display: grid;
  grid-template-rows: auto 1fr;
  height: 100vh;
  position: relative;
}

.app-header {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 10px 16px;
  background: var(--surface-1);
  border-bottom: 1px solid var(--border);
}

.brand {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
}

.brand span {
  font-size: 11px;
  color: var(--text-muted);
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.file {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.file-name {
  max-width: 340px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}

.file-name.muted {
  color: var(--text-faint);
}

/* Number of marks that would be burned into the saved copy. */
.mark-count {
  display: inline-block;
  margin-left: 6px;
  padding: 0 6px;
  border-radius: 999px;
  background: rgb(255 255 255 / 25%);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.status {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-muted);
  min-width: 0;
}

.status .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-faint);
  flex: none;
}

.status[data-state='ready'] .dot {
  background: var(--success);
}
.status[data-state='error'] .dot {
  background: var(--danger-strong);
}
.status[data-state='uploading'] .dot,
.status[data-state='saving'] .dot,
.status[data-state='parsing'] .dot {
  background: var(--warning);
  animation: pulse 1s ease-in-out infinite;
}

.status-label {
  color: var(--text);
  font-weight: 600;
}

.status-message {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 380px;
}

@keyframes pulse {
  50% {
    opacity: 0.35;
  }
}

/* Viewer / divider / search panel. Columns come from `layoutColumns`, which
   defaults to 85 % / 15 % and is dragged by the .resizer. Both panes scroll
   internally — the window never does. */
.layout {
  display: grid;
  min-height: 0;
  overflow: hidden;
}

.resizer {
  position: relative;
  cursor: col-resize;
  background: var(--border);
  touch-action: none;
  display: flex;
  align-items: center;
  justify-content: center;
}

.resizer::before {
  /* Widens the pointer target well past the 6px visual line. */
  content: '';
  position: absolute;
  inset: 0 -5px;
}

.resizer:hover,
.resizer:focus-visible,
.resizer.active {
  background: var(--accent);
  outline: none;
}

.grip {
  width: 2px;
  height: 26px;
  border-radius: 2px;
  background: var(--text-faint);
  pointer-events: none;
}

.resizer:hover .grip,
.resizer:focus-visible .grip,
.resizer.active .grip {
  background: #fff;
}

/* While dragging, keep the cursor and stop the pointer selecting text. */
.app.resizing {
  cursor: col-resize;
  user-select: none;
}

.layout > * {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.drop-hint {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: var(--overlay);
  font-size: 18px;
  pointer-events: none;
  border: 2px dashed var(--accent);
}
</style>
