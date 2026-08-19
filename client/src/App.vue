<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue';
import PdfViewer from './components/PdfViewer.vue';
import SearchPanel from './components/SearchPanel.vue';
import { fetchCategories, uploadPdf, searchTerm, searchBatch, releaseDocument } from './api.js';

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

const statusLabel = computed(() => {
  switch (status.state) {
    case 'uploading':
      return `Uploading ${status.progress}%`;
    case 'parsing':
      return 'Parsing on server';
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
    :class="{ dragging }"
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
        <button v-if="doc" type="button" class="ghost" @click="closeDocument">Close</button>
      </div>

      <div class="status" :data-state="status.state">
        <span class="dot"></span>
        <span class="status-label">{{ statusLabel }}</span>
        <span class="status-message">{{ status.message }}</span>
      </div>
    </header>

    <main class="layout">
      <PdfViewer
        ref="viewer"
        :doc-id="doc?.docId ?? null"
        :pages="doc?.pages ?? []"
        :highlights="highlights"
        :active-index="activeIndex"
        @error="setStatus('error', $event)"
      />
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
  background: #46d18a;
}
.status[data-state='error'] .dot {
  background: #e05555;
}
.status[data-state='uploading'] .dot,
.status[data-state='parsing'] .dot {
  background: #f0b429;
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

/* 65 / 35 split required by the layout spec. Both columns scroll internally. */
.layout {
  display: grid;
  grid-template-columns: 65fr 35fr;
  min-height: 0;
  overflow: hidden;
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
  background: rgb(10 12 16 / 72%);
  font-size: 18px;
  pointer-events: none;
  border: 2px dashed var(--accent);
}
</style>
