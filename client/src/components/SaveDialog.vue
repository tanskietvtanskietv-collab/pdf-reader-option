<script setup>
import { computed, ref, watch } from 'vue';
import { listFolders, canPickSaveLocation } from '../api.js';

const props = defineProps({
  open: { type: Boolean, default: false },
  suggestedName: { type: String, default: 'document-marked.pdf' },
  markCount: { type: Number, default: 0 },
  busy: { type: Boolean, default: false },
  error: { type: String, default: '' },
});

const emit = defineEmits(['close', 'save']);

const LAST_FOLDER_KEY = 'pdf-term-reader:last-folder';

const loading = ref(false);
const listError = ref('');
const current = ref(null); // absolute path, null at the "This PC" level
const parent = ref(null);
const label = ref('');
const folders = ref([]);
const places = ref([]);
const confined = ref(false);
const fileName = ref('');
const pathInput = ref('');

const atTop = computed(() => current.value === null);
const canGoUp = computed(() => parent.value !== null);
const canSave = computed(
  () => !atTop.value && !loading.value && !listError.value && Boolean(fileName.value.trim()),
);

watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    fileName.value = props.suggestedName;
    listError.value = '';

    let start = '';
    try {
      start = localStorage.getItem(LAST_FOLDER_KEY) || '';
    } catch {
      /* storage unavailable */
    }
    // Fall back to the top level if the remembered folder has gone away.
    if (!(await load(start))) await load('');
  },
);

async function load(target) {
  loading.value = true;
  listError.value = '';
  try {
    const payload = await listFolders(target ?? '');
    current.value = payload.path;
    parent.value = payload.parent;
    label.value = payload.label;
    folders.value = payload.folders;
    places.value = payload.places;
    confined.value = payload.confined;
    pathInput.value = payload.path ?? '';
    return true;
  } catch (error) {
    listError.value = error.message;
    return false;
  } finally {
    loading.value = false;
  }
}

/** Typing a path and pressing Enter jumps straight there, like the address bar. */
function gotoTypedPath() {
  if (pathInput.value.trim()) load(pathInput.value.trim());
}

function save() {
  if (!canSave.value || props.busy) return;
  try {
    localStorage.setItem(LAST_FOLDER_KEY, current.value);
  } catch {
    /* storage unavailable */
  }
  emit('save', { destination: current.value, fileName: fileName.value.trim() });
}
</script>

<template>
  <div v-if="open" class="backdrop" @click.self="emit('close')">
    <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="save-title">
      <header class="bar">
        <h2 id="save-title">Save As</h2>
        <button type="button" class="ghost close" @click="emit('close')" :disabled="busy">✕</button>
      </header>

      <div class="location">
        <label for="save-path">Save in</label>
        <input
          id="save-path"
          v-model="pathInput"
          type="text"
          spellcheck="false"
          :placeholder="atTop ? 'This PC' : ''"
          @keyup.enter="gotoTypedPath"
        />
        <button type="button" class="ghost" :disabled="!canGoUp || loading" title="Up one level" @click="load(parent)">
          ↑
        </button>
      </div>

      <div class="body">
        <nav class="places">
          <button
            v-if="!confined"
            type="button"
            class="place"
            :class="{ active: atTop }"
            @click="load('')"
          >
            <span class="icon">🖥️</span>This PC
          </button>
          <button
            v-for="place in places"
            :key="place.path"
            type="button"
            class="place"
            :class="{ active: current === place.path }"
            @click="load(place.path)"
          >
            <span class="icon">📁</span>{{ place.name }}
          </button>
        </nav>

        <ul class="folders">
          <li v-if="loading" class="hint">Loading…</li>
          <li v-else-if="listError" class="hint error">{{ listError }}</li>
          <li v-else-if="!folders.length" class="hint">
            No sub-folders here{{ atTop ? '' : ' — save into this folder' }}.
          </li>
          <li v-for="folder in folders" :key="folder.path">
            <button type="button" class="folder" @click="load(folder.path)" :title="folder.path">
              <span class="icon">{{ atTop ? '💽' : '📁' }}</span>{{ folder.name }}
            </button>
          </li>
        </ul>
      </div>

      <div class="fields">
        <label for="save-name">File name</label>
        <input id="save-name" v-model="fileName" type="text" @keyup.enter="save" />

        <label for="save-type">Save as type</label>
        <select id="save-type" disabled>
          <option>PDF Documents (*.pdf)</option>
        </select>
      </div>

      <p v-if="error" class="save-error">{{ error }}</p>
      <p v-else-if="atTop" class="note">Pick a drive or a shortcut, then choose a folder.</p>
      <p v-else class="note">
        {{ markCount }} mark{{ markCount === 1 ? '' : 's' }} will be saved into
        <strong>{{ label }}</strong> on the machine running the server.
      </p>

      <p v-if="!canPickSaveLocation()" class="hint-native">
        Tip: open this app at <code>http://localhost:5173</code> (or over https) and this button
        uses the real Windows Save As dialog instead.
      </p>

      <footer>
        <button type="button" class="primary" @click="save" :disabled="!canSave || busy">
          {{ busy ? 'Saving…' : 'Save' }}
        </button>
        <button type="button" class="ghost" @click="emit('close')" :disabled="busy">Cancel</button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: grid;
  place-items: center;
  background: var(--overlay);
  padding: 24px;
}

.dialog {
  width: min(680px, 100%);
  height: min(560px, 92vh);
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--surface-1);
  box-shadow: var(--dialog-shadow);
}

.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

h2 {
  margin: 0;
  font-size: 15px;
}

.close {
  padding: 2px 8px;
}

.location {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-muted);
}

.location input {
  width: 100%;
  font-size: 12px;
}

.body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 150px 1fr;
  gap: 10px;
}

.places {
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-2);
}

.place,
.folder {
  width: 100%;
  text-align: left;
  background: transparent;
  border: none;
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.place:hover,
.folder:hover {
  background: var(--surface-3);
}

.place.active {
  background: var(--accent-soft);
  color: var(--text);
}

.icon {
  margin-right: 8px;
}

.folders {
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  margin: 0;
  padding: 4px;
  list-style: none;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-2);
}

.hint {
  padding: 14px;
  text-align: center;
  font-size: 12px;
  color: var(--text-muted);
}

.hint.error {
  color: var(--danger);
}

.fields {
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: center;
  gap: 8px 10px;
  font-size: 12px;
  color: var(--text-muted);
}

.fields input,
.fields select {
  width: 100%;
  font: inherit;
  font-size: 13px;
  color: var(--text);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 5px 8px;
}

.note,
.save-error,
.hint-native {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-muted);
}

.save-error {
  color: var(--danger);
}

.hint-native code {
  background: var(--surface-2);
  padding: 1px 5px;
  border-radius: 4px;
}

footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
