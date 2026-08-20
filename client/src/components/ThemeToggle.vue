<script setup>
import { onMounted, ref } from 'vue';

/**
 * Dark / light switch.
 *
 * **Light is the default.** The OS preference is deliberately ignored: a machine
 * set to dark still opens this app light, and dark is used only when the user
 * asked for it here. That choice is remembered, and the inline script in
 * index.html reads the same key so the first paint is already correct.
 */

const STORAGE_KEY = 'pdf-term-reader:theme';
const DEFAULT_THEME = 'light';

const theme = ref(DEFAULT_THEME);

function apply(next) {
  theme.value = next;
  document.documentElement.dataset.theme = next;
}

onMounted(() => {
  let stored = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    /* storage unavailable */
  }
  apply(stored === 'dark' ? 'dark' : DEFAULT_THEME);
});

function toggle() {
  const next = theme.value === 'dark' ? 'light' : 'dark';
  apply(next);
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* storage unavailable */
  }
}
</script>

<template>
  <button
    type="button"
    class="switch"
    role="switch"
    :aria-checked="theme === 'dark'"
    :title="theme === 'dark' ? 'Dark theme — switch to light' : 'Light theme — switch to dark'"
    aria-label="Dark theme"
    @click="toggle"
  >
    <span class="track" :class="{ on: theme === 'dark' }">
      <span class="glyph sun">☀</span>
      <span class="glyph moon">☾</span>
      <span class="knob"></span>
    </span>
  </button>
</template>

<style scoped>
.switch {
  padding: 2px;
  background: transparent;
  border: none;
  line-height: 0;
  border-radius: 999px;
}

.switch:hover:not(:disabled) {
  background: transparent;
}

.switch:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.track {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  width: 52px;
  height: 26px;
  padding: 0 6px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--surface-2);
  transition: background 160ms ease, border-color 160ms ease;
}

.track.on {
  background: var(--accent-soft);
  border-color: var(--accent);
}

.glyph {
  font-size: 12px;
  line-height: 1;
  color: var(--text-muted);
  z-index: 1;
  transition: color 160ms ease;
}

.track:not(.on) .sun,
.track.on .moon {
  color: var(--text);
}

.knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--surface-1);
  border: 1px solid var(--border);
  box-shadow: 0 1px 3px rgb(0 0 0 / 25%);
  transition: transform 180ms cubic-bezier(0.2, 0.8, 0.3, 1);
}

.track.on .knob {
  transform: translateX(26px);
}

@media (prefers-reduced-motion: reduce) {
  .knob,
  .track,
  .glyph {
    transition: none;
  }
}
</style>
