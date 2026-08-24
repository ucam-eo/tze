import { writable } from 'svelte/store';

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'tze-theme';

function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // localStorage unavailable (private mode) — fall through to default.
  }
  return 'dark';
}

/** UI colour theme. The dark terminal look is the default; light mode exists
 *  for projectors and bright rooms (issue #1). index.html applies the saved
 *  value before first paint, so this store only needs to track changes. */
export const theme = writable<Theme>(initialTheme());

theme.subscribe((t) => {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem(STORAGE_KEY, t);
  } catch {
    // Persistence is best-effort.
  }
});

export function toggleTheme() {
  theme.update((t) => (t === 'dark' ? 'light' : 'dark'));
}
