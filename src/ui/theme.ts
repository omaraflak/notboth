/**
 * The canvas cannot use CSS variables directly, so it reads them once per
 * theme change. Adding a palette means editing style.css, not this file.
 */
export type ThemeName = 'light' | 'dark';

const TOKENS = [
  'canvas-bg', 'grid-dot', 'grid-dot-major',
  'box-fill', 'box-stroke', 'box-text', 'box-pin-text', 'box-shadow',
  'pin', 'pin-hot', 'wire', 'wire-hot', 'wire-selected',
  'accent', 'accent-soft', 'accent-line', 'danger', 'ok', 'warn', 'text', 'text-dim', 'text-faint',
  'bg-elev', 'line', 'line-strong',
] as const;

export type Palette = Record<(typeof TOKENS)[number], string>;

let cached: Palette | null = null;
const listeners = new Set<() => void>();

export function palette(): Palette {
  if (cached) return cached;
  const cs = getComputedStyle(document.documentElement);
  const out = {} as Palette;
  for (const t of TOKENS) out[t] = cs.getPropertyValue(`--${t}`).trim();
  cached = out;
  return out;
}

export function currentTheme(): ThemeName {
  return (document.documentElement.dataset.theme as ThemeName) || 'light';
}

export function setTheme(name: ThemeName) {
  document.documentElement.dataset.theme = name;
  localStorage.setItem('nand.theme', name);
  cached = null;
  for (const fn of listeners) fn();
}

export function toggleTheme() {
  setTheme(currentTheme() === 'light' ? 'dark' : 'light');
}

export function onThemeChange(fn: () => void) {
  listeners.add(fn);
}

export function initTheme() {
  const saved = localStorage.getItem('nand.theme') as ThemeName | null;
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  setTheme(saved ?? (prefersDark ? 'dark' : 'light'));
}

/** Blend a wire's user-chosen hue toward the "energised" look. */
export function mix(a: string, b: string, t: number): string {
  const ca = parseColor(a), cb = parseColor(b);
  if (!ca || !cb) return b;
  const c = ca.map((v, i) => Math.round(v + (cb[i] - v) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function parseColor(s: string): [number, number, number] | null {
  s = s.trim();
  if (s.startsWith('#')) {
    const hex = s.length === 4
      ? s.slice(1).split('').map((c) => c + c).join('')
      : s.slice(1, 7);
    const n = parseInt(hex, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const parts = m[1].split(/[,\s/]+/).map(Number);
    return [parts[0], parts[1], parts[2]];
  }
  return null;
}
