<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue';

/**
 * Dark / light switch.
 *
 * With no stored choice the app follows the operating system, and keeps
 * following it if the user changes it while the app is open. Flipping the switch
 * pins a theme and stops the app tracking the system. The same key is read by
 * the inline script in index.html so the first paint is already correct.
 */

const STORAGE_KEY = 'pdf-term-reader:theme';

const theme = ref('light');
let media = null;

function systemTheme() {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function apply(next) {
  theme.value = next;
  document.documentElement.dataset.theme = next;
}

function onSystemChange(event) {
  // Only while the user has not pinned a theme of their own.
  let stored = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    /* storage unavailable */
  }
  if (!stored) apply(event.matches ? 'dark' : 'light');
}

onMounted(() => {
  let stored = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    /* storage unavailable */
  }
  apply(stored === 'dark' || stored === 'light' ? stored : systemTheme());

  media = window.matchMedia?.('(prefers-color-scheme: dark)');
  media?.addEventListener('change', onSystemChange);
});

onBeforeUnmount(() => media?.removeEventListener('change', onSystemChange));

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
