<script setup>
import { computed, reactive, ref, watch } from 'vue';

const props = defineProps({
  categories: { type: Array, default: () => [] },
  category: { type: String, default: '' },
  // Keyed by row id: { status, totalMatches, pages, activeMatch, error }
  results: { type: Object, default: () => ({}) },
  activeRowId: { type: String, default: null },
  disabled: { type: Boolean, default: false },
  busy: { type: Boolean, default: false },
});

const emit = defineEmits(['update:category', 'search', 'search-all', 'clear', 'step-match']);

// Edited term values survive category switches, keyed by row id.
const edits = reactive({});
const onlyHits = ref(false);
const filterText = ref('');

const items = computed(() => {
  const found = props.categories.find((c) => c.name === props.category);
  return found ? found.items : [];
});

const rows = computed(() =>
  items.value.map((label, index) => {
    const id = `${props.category}#${index}`;
    return { id, index, label, value: edits[id] ?? label };
  }),
);

const visibleRows = computed(() => {
  const needle = filterText.value.trim().toLowerCase();
  return rows.value.filter((row) => {
    if (onlyHits.value && !(props.results[row.id]?.totalMatches > 0)) return false;
    if (needle && !row.label.toLowerCase().includes(needle)) return false;
    return true;
  });
});

const summary = computed(() => {
  const searched = rows.value.filter((row) => props.results[row.id]?.status === 'done');
  const withHits = searched.filter((row) => props.results[row.id].totalMatches > 0);
  const total = searched.reduce((sum, row) => sum + props.results[row.id].totalMatches, 0);
  return { searched: searched.length, withHits: withHits.length, total };
});

watch(
  () => props.category,
  () => {
    filterText.value = '';
  },
);

function submit(row) {
  if (props.disabled) return;
  emit('search', { id: row.id, label: row.label, query: row.value });
}

function onInput(row, event) {
  edits[row.id] = event.target.value;
}

function resetRow(row) {
  delete edits[row.id];
}

/** A row is ticked once its search has come back, hit or miss. */
function isSearched(row) {
  return props.results[row.id]?.status === 'done';
}

function badgeClass(state) {
  if (!state || state.status === 'idle') return 'badge idle';
  if (state.status === 'loading') return 'badge loading';
  if (state.status === 'error') return 'badge error';
  return state.totalMatches > 0 ? 'badge hit' : 'badge miss';
}

function badgeText(state) {
  if (!state || state.status === 'idle') return '—';
  if (state.status === 'loading') return '…';
  if (state.status === 'error') return '!';
  return `Found: ${state.totalMatches}`;
}
</script>

<template>
  <aside class="panel">
    <div class="panel-head">
      <fieldset class="categories">
        <legend>Category</legend>
        <label v-for="c in categories" :key="c.name" class="radio">
          <input
            type="radio"
            name="category"
            :value="c.name"
            :checked="category === c.name"
            @change="emit('update:category', c.name)"
          />
          <span>{{ c.name }}</span>
          <em>{{ c.items.length }}</em>
        </label>
      </fieldset>

      <div class="actions">
        <button type="button" @click="emit('search-all')" :disabled="disabled || busy">
          {{ busy ? 'Searching…' : 'Search all terms' }}
        </button>
        <button type="button" class="ghost" @click="emit('clear')">
          Clear
        </button>
      </div>

      <div class="filters">
        <input
          v-model="filterText"
          type="search"
          class="filter"
          placeholder="Filter this list…"
        />
        <label class="checkbox">
          <input type="checkbox" v-model="onlyHits" />
          <span>Hits only</span>
        </label>
      </div>

      <p class="summary">
        {{ summary.searched }} searched · {{ summary.withHits }} with hits ·
        {{ summary.total }} matches
      </p>
    </div>

    <ol class="rows">
      <li
        v-for="row in visibleRows"
        :key="row.id"
        class="row"
        :class="{ active: row.id === activeRowId }"
      >
        <span class="row-index">
          <span class="num">{{ row.index + 1 }}</span>
          <span
            v-if="isSearched(row)"
            class="check"
            :class="{ empty: results[row.id].totalMatches === 0 }"
            :title="`Already searched — ${results[row.id].totalMatches} match(es)`"
            >✓</span
          >
        </span>

        <div class="row-main">
          <input
            class="term"
            type="text"
            :value="row.value"
            :placeholder="row.label"
            :title="`Original term: ${row.label}`"
            @input="onInput(row, $event)"
            @keyup.enter="submit(row)"
          />
          <div class="row-meta">
            <span :class="badgeClass(results[row.id])">{{ badgeText(results[row.id]) }}</span>
            <span v-if="results[row.id]?.pages?.length" class="pages">
              p. {{ results[row.id].pages.slice(0, 6).join(', ')
              }}{{ results[row.id].pages.length > 6 ? '…' : '' }}
            </span>
            <span v-if="results[row.id]?.error" class="error-text">
              {{ results[row.id].error }}
            </span>
          </div>
        </div>

        <div class="row-actions">
          <template v-if="results[row.id]?.totalMatches > 0">
            <button type="button" class="mini" title="Previous match" @click="emit('step-match', { id: row.id, delta: -1, query: row.value })">‹</button>
            <span class="counter">
              {{ (results[row.id].activeMatch ?? 0) + 1 }}/{{ results[row.id].totalMatches }}
            </span>
            <button type="button" class="mini" title="Next match" @click="emit('step-match', { id: row.id, delta: 1, query: row.value })">›</button>
          </template>
          <button
            v-if="row.value !== row.label"
            type="button"
            class="mini"
            title="Restore original term"
            @click="resetRow(row)"
          >
            ↺
          </button>
        </div>
      </li>
      <li v-if="!visibleRows.length" class="empty">No terms match this filter.</li>
    </ol>
  </aside>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  overflow: hidden;
  background: var(--surface-1);
  border-left: 1px solid var(--border);
}

/* Category + actions stay pinned; only the term list scrolls. */
.panel-head {
  flex: none;
  padding: 12px;
  border-bottom: 1px solid var(--border);
  display: grid;
  gap: 10px;
}

.categories {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 10px 10px;
  display: flex;
  gap: 8px;
}

.categories legend {
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-muted);
  padding: 0 4px;
}

.radio {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  background: var(--surface-2);
}

.radio:has(input:checked) {
  background: var(--accent-soft);
  outline: 1px solid var(--accent);
}

.radio em {
  margin-left: auto;
  font-style: normal;
  font-size: 11px;
  color: var(--text-muted);
}

.actions {
  display: flex;
  gap: 8px;
}

.actions button {
  flex: 1;
}

.filters {
  display: flex;
  align-items: center;
  gap: 10px;
}

.filter {
  flex: 1;
}

.checkbox {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-muted);
  white-space: nowrap;
}

.summary {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

.rows {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  margin: 0;
  padding: 6px;
  list-style: none;
  display: grid;
  gap: 4px;
  align-content: start;
}

.row {
  display: grid;
  grid-template-columns: 38px 1fr auto;
  align-items: center;
  gap: 8px;
  padding: 6px;
  border-radius: 8px;
  border: 1px solid transparent;
}

.row:hover {
  background: var(--surface-2);
}

.row.active {
  background: var(--accent-soft);
  border-color: var(--accent);
}

.row-index {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 3px;
  font-size: 11px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}

.row-index .num {
  min-width: 16px;
  text-align: right;
}

/* Tick = this term has already been searched against the current document. */
.row-index .check {
  font-size: 12px;
  line-height: 1;
  color: #46d18a;
}

.row-index .check.empty {
  color: var(--text-faint);
}

.row-main {
  min-width: 0;
  display: grid;
  gap: 3px;
}

.term {
  width: 100%;
  font-family: 'Noto Sans JP', 'Meiryo', system-ui, sans-serif;
}

.row-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 16px;
}

.badge {
  font-size: 11px;
  font-weight: 600;
  padding: 1px 7px;
  border-radius: 999px;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.badge.idle {
  color: var(--text-faint);
  background: var(--surface-2);
}
.badge.loading {
  color: var(--text-muted);
  background: var(--surface-2);
}
.badge.hit {
  color: #0b2e13;
  background: #6ee7a0;
}
.badge.miss {
  color: var(--text-muted);
  background: var(--surface-3);
}
.badge.error {
  color: #fff;
  background: #d24141;
}

.pages,
.error-text {
  font-size: 11px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.error-text {
  color: #f08a8a;
}

.row-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

.counter {
  font-size: 11px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  min-width: 34px;
  text-align: center;
}

.mini {
  padding: 2px 7px;
  font-size: 12px;
  line-height: 1.2;
}

.empty {
  padding: 20px;
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
}
</style>
