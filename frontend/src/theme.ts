// Appearance preference: follow the OS, or force dark/light. Stored per browser.
export type ThemeChoice = 'system' | 'dark' | 'light';
const KEY = 'fpgaweb.theme';
const listeners: (() => void)[] = [];

export function getTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'dark' || v === 'light') return v;
  } catch {
    /* storage unavailable */
  }
  return 'system';
}

/** The theme actually in effect (resolving 'system' via the OS preference). */
export function effectiveTheme(): 'dark' | 'light' {
  const c = getTheme();
  if (c !== 'system') return c;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function applyTheme(): void {
  const c = getTheme();
  if (c === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = c;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', effectiveTheme() === 'light' ? '#F0F2F5' : '#070E1D');
  for (const fn of listeners) fn();
}

export function setTheme(c: ThemeChoice): void {
  try {
    if (c === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, c);
  } catch {
    /* ignore */
  }
  applyTheme();
}

export function onThemeChange(fn: () => void): void {
  listeners.push(fn);
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', fn);
}
