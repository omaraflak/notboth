type Props = Record<string, unknown>;
type Child = Node | string | number | null | undefined | false;

/** Minimal element builder. No framework on the hot path. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, props?: Props | null, ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') el.className = String(value);
      else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
      else if (key === 'dataset' && typeof value === 'object') Object.assign(el.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      } else if (key in el && key !== 'list') {
        (el as unknown as Record<string, unknown>)[key] = value;
      } else {
        el.setAttribute(key, String(value));
      }
    }
  }
  append(el, children);
  return el;
}

export function append(el: HTMLElement, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
}

export function clear(el: HTMLElement) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

const NS = 'http://www.w3.org/2000/svg';

/* The three filled cells of the truth map, then the hollow one: a rounded
   square with a rounded square punched out, so the hole is as soft as the
   corner. A stroked rect cannot do that -- its hole is only as round as
   `rx - strokeWidth/2`, which collapses to a point at these sizes. */
const MARK_CELLS = 'M6.1,2.5H11.4A3.6,3.6 0 0 1 15,6.1V11.4A3.6,3.6 0 0 1 11.4,15H6.1A3.6,3.6 0 0 1 2.5,11.4V6.1A3.6,3.6 0 0 1 6.1,2.5ZM20.6,2.5H25.9A3.6,3.6 0 0 1 29.5,6.1V11.4A3.6,3.6 0 0 1 25.9,15H20.6A3.6,3.6 0 0 1 17,11.4V6.1A3.6,3.6 0 0 1 20.6,2.5ZM6.1,17H11.4A3.6,3.6 0 0 1 15,20.6V25.9A3.6,3.6 0 0 1 11.4,29.5H6.1A3.6,3.6 0 0 1 2.5,25.9V20.6A3.6,3.6 0 0 1 6.1,17Z';
const MARK_HOLLOW = 'M20.6,17H25.9A3.6,3.6 0 0 1 29.5,20.6V25.9A3.6,3.6 0 0 1 25.9,29.5H20.6A3.6,3.6 0 0 1 17,25.9V20.6A3.6,3.6 0 0 1 20.6,17ZM21.77,19.6H24.73A2.17,2.17 0 0 1 26.9,21.77V24.73A2.17,2.17 0 0 1 24.73,26.9H21.77A2.17,2.17 0 0 1 19.6,24.73V21.77A2.17,2.17 0 0 1 21.77,19.6Z';

const PATHS: Record<string, string> = {
  power: 'M12 3v9M6.2 6.2a8 8 0 1 0 11.6 0',
  play: 'M6 4l12 8-12 8z',
  pause: 'M8 5v14M16 5v14',
  step: 'M6 4l9 8-9 8zM18 4v16',
  reset: 'M3 12a9 9 0 1 0 3-6.7M3 4v5h5',
  undo: 'M9 14L4 9l5-5M4 9h9a7 7 0 0 1 0 14H8',
  redo: 'M15 14l5-5-5-5M20 9h-9a7 7 0 0 0 0 14h5',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  chip: 'M7 7h10v10H7zM9 3v4M15 3v4M9 17v4M15 17v4M3 9h4M3 15h4M17 9h4M17 15h4',
  trash: 'M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13',
  more: 'M12 6h.01M12 12h.01M12 18h.01',
  download: 'M12 3v12M7 11l5 5 5-5M4 20h16',
  upload: 'M12 21V9M7 13l5-5 5 5M4 4h16',
  sun: 'M12 4V2M12 22v-2M4 12H2M22 12h-2M6 6L4.5 4.5M19.5 19.5L18 18M18 6l1.5-1.5M4.5 19.5L6 18M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  moon: 'M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  check: 'M4 12l5 5L20 6',
  x: 'M6 6l12 12M18 6L6 18',
  zap: 'M13 2L4 14h7l-1 8 9-12h-7z',
  chevron: 'M9 6l6 6-6 6',
  chevronDown: 'M6 9l6 6 6-6',
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',
  beaker: 'M9 3v6L4 19a2 2 0 0 0 2 3h12a2 2 0 0 0 2-3l-5-10V3M8 3h8M7 14h10',
  memory: 'M6 6h12v12H6zM9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4M10 10h4v4h-4z',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  swap: 'M4 8h13l-3-3M20 16H7l3 3',
  gauge: 'M12 14l4-4M20 16a9 9 0 1 0-16 0',
  book: 'M4 5a2 2 0 0 1 2-2h13v18H6a2 2 0 0 1-2-2zM19 3v18M8 8h7M8 12h5',
  help: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M9.3 9.2a2.8 2.8 0 1 1 3.5 3.4c-.5.2-.8.6-.8 1.1v.6M12 17.3h.01',
  external: 'M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
};

export function icon(name: keyof typeof PATHS | string, size = 13): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', PATHS[name] ?? PATHS.chip);
  svg.appendChild(path);
  return svg;
}

/**
 * The notboth mark: the NAND truth table laid out as a 2x2 map -- 1, 1, 1, 0.
 * Three cells filled, and the one case where both inputs are high left hollow.
 *
 * Not part of the icon set: those are single stroked paths, and this is two
 * filled ones, the second punching its own hole with the even-odd rule.
 */
export function brandMark(size = 17): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  const add = (d: string, cls?: string) => {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    if (cls) { path.setAttribute('class', cls); path.setAttribute('fill-rule', 'evenodd'); }
    svg.appendChild(path);
  };
  add(MARK_CELLS);
  // The odd one out is coloured from the stylesheet, so the palette stays in
  // one file rather than being half in the markup.
  add(MARK_HOLLOW, 'mark-zero');
  return svg;
}

export function button(
  label: string | null,
  opts: { icon?: string; title?: string; className?: string; onClick?: () => void; disabled?: boolean } = {},
): HTMLButtonElement {
  const el = h('button', {
    class: `btn ${opts.className ?? ''} ${label ? '' : 'icon'}`.trim(),
    title: opts.title ?? label ?? '',
    disabled: opts.disabled ?? false,
    onclick: opts.onClick,
  });
  if (opts.icon) el.appendChild(icon(opts.icon));
  if (label) el.appendChild(document.createTextNode(label));
  return el;
}
