/**
 * Pure geometry. Every component is the same shape -- a named box with named
 * pins -- so one function lays all of them out, and everything lands exactly
 * on grid intersections.
 *
 * All coordinates here are in *grid cells*, not pixels. The renderer scales.
 */
import type { Pin, Point, Signature } from './types';

export const GRID = 16;

export const NAME_FONT = '600 11px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
export const PIN_FONT = '9px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

export type Measure = (text: string, font: string) => number;

/** Deterministic fallback so layout is testable without a canvas. */
export const approxMeasure: Measure = (text, font) =>
  text.length * (font.includes('11px') ? 6.4 : 5.2);

export interface PinLayout {
  pin: Pin;
  side: 'in' | 'out';
  index: number;
  /** Position relative to the box origin, in grid cells. */
  x: number;
  y: number;
}

export interface BoxLayout {
  /** Size in grid cells. */
  w: number;
  h: number;
  pins: PinLayout[];
}

const PAD_PX = 9;
const MIN_W = 3;

/**
 * Box size follows from the pin count, so a component's shape tells you its
 * signature at a glance and neighbouring boxes always align.
 */
export function layoutBox(sig: Signature, name: string, measure: Measure = approxMeasure): BoxLayout {
  const rows = Math.max(sig.inputs.length, sig.outputs.length, 1);
  const h = rows + 1;

  // A single-purpose primitive names its box and its only pin the same thing;
  // drawing it twice is noise, so it is neither measured nor painted.
  let maxIn = 0;
  for (const p of sig.inputs) {
    if (showPinLabel(p, name)) maxIn = Math.max(maxIn, measure(p.name, PIN_FONT));
  }
  let maxOut = 0;
  for (const p of sig.outputs) {
    if (showPinLabel(p, name)) maxOut = Math.max(maxOut, measure(p.name, PIN_FONT));
  }
  const nameW = measure(name, NAME_FONT);

  const needed = maxIn + maxOut + nameW + PAD_PX * 4;
  const w = Math.max(MIN_W, Math.ceil(needed / GRID));

  const pins: PinLayout[] = [];
  sig.inputs.forEach((pin, i) => pins.push({ pin, side: 'in', index: i, x: 0, y: i + 1 }));
  sig.outputs.forEach((pin, i) => pins.push({ pin, side: 'out', index: i, x: w, y: i + 1 }));
  return { w, h, pins };
}

/** False when the pin label would merely repeat the box name. */
export function showPinLabel(pin: Pin, boxName: string): boolean {
  return pin.name !== boxName;
}

export function findPin(box: BoxLayout, pinId: string): PinLayout | undefined {
  return box.pins.find((p) => p.pin.id === pinId);
}

/* ------------------------------------------------------------------ *
 * Wire routing
 * ------------------------------------------------------------------ */

/**
 * Orthogonal route from an output pin to an input pin, in grid cells.
 * Wires leave to the right and arrive from the left; when the target is behind
 * the source the route steps out and around rather than crossing the boxes.
 */
export function routeWire(start: Point, end: Point, via: Point[] = [], channel?: number): Point[] {
  if (via.length) {
    const pts: Point[] = [start];
    let cur = start;
    for (const v of [...via, end]) {
      if (v.x !== cur.x && v.y !== cur.y) pts.push({ x: v.x, y: cur.y });
      pts.push(v);
      cur = v;
    }
    return dedupe(pts);
  }

  if (end.x - start.x >= 2) {
    const midX = channel ?? Math.round((start.x + end.x) / 2);
    return dedupe([start, { x: midX, y: start.y }, { x: midX, y: end.y }, end]);
  }

  const outX = start.x + 1;
  const inX = end.x - 1;
  const midY = start.y === end.y ? start.y + 2 : Math.round((start.y + end.y) / 2);
  return dedupe([
    start,
    { x: outX, y: start.y }, { x: outX, y: midY },
    { x: inX, y: midY }, { x: inX, y: end.y },
    end,
  ]);
}

function dedupe(pts: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue;
    out.push(p);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Routing a whole schematic
 * ------------------------------------------------------------------ */

export interface WireGeom {
  id: string;
  /** Identifies the signal: driver pin plus the bits taken from it. */
  net: string;
  from: Point;
  to: Point;
  via?: Point[];
}

export interface Junction { x: number; y: number; net: string }

export interface RoutePlan {
  paths: Map<string, Point[]>;
  /** Where a branch leaves a trunk mid-run, and the two really are joined. */
  junctions: Junction[];
}

const MAX_CHANNEL_SHIFT = 8;

/**
 * Route every wire at once.
 *
 * Choosing each wire's vertical channel independently lets unrelated signals
 * land on the same column and merge into what looks like a single wire. So the
 * channel is chosen per *net* instead: wires driven by the same pin share one
 * trunk -- they carry the same signal, so overlapping is honest -- and any
 * other net that wants the same column is pushed aside until it finds a free
 * one. Whatever crossings remain are genuine crossings, and only a junction
 * dot means "joined".
 */
export function planRoutes(wires: WireGeom[]): RoutePlan {
  const paths = new Map<string, Point[]>();
  const junctions: Junction[] = [];

  const nets = new Map<string, WireGeom[]>();
  for (const w of wires) {
    const list = nets.get(w.net);
    if (list) list.push(w); else nets.set(w.net, [w]);
  }

  // A stable order, so the picture does not reshuffle between redraws.
  const ordered = [...nets.entries()].sort((a, b) => {
    const fa = a[1][0].from;
    const fb = b[1][0].from;
    return fa.x - fb.x || fa.y - fb.y || (a[0] < b[0] ? -1 : 1);
  });

  const taken = new Map<number, [number, number][]>();
  const collides = (x: number, y0: number, y1: number) =>
    (taken.get(x) ?? []).some(([a, b]) => Math.min(y1, b) - Math.max(y0, a) > 0);
  const reserve = (x: number, y0: number, y1: number) => {
    const spans = taken.get(x);
    if (spans) spans.push([y0, y1]); else taken.set(x, [[y0, y1]]);
  };

  for (const [net, group] of ordered) {
    const from = group[0].from;
    const straight = group.filter((w) => !w.via?.length && w.to.x - from.x >= 2);
    for (const w of group) {
      if (straight.includes(w)) continue;
      paths.set(w.id, routeWire(w.from, w.to, w.via ?? []));
    }
    if (!straight.length) continue;

    const nearest = Math.min(...straight.map((w) => w.to.x));
    const lo = from.x + 1;
    const hi = nearest - 1;
    const ys = [from.y, ...straight.map((w) => w.to.y)];
    const top = Math.min(...ys);
    const bottom = Math.max(...ys);

    let channel = Math.min(hi, Math.max(lo, Math.round((from.x + nearest) / 2)));
    // A net that never runs vertically cannot be confused with anything.
    if (bottom > top) {
      for (let shift = 0; shift <= MAX_CHANNEL_SHIFT; shift++) {
        const tries = shift === 0 ? [channel] : [channel + shift, channel - shift];
        const free = tries.find((c) => c >= lo && c <= hi && !collides(c, top, bottom));
        if (free !== undefined) { channel = free; break; }
      }
      reserve(channel, top, bottom);
    }

    for (const w of straight) paths.set(w.id, routeWire(w.from, w.to, [], channel));

    if (straight.length > 1) {
      for (const y of new Set(ys)) {
        if (y > top && y < bottom) junctions.push({ x: channel, y, net });
      }
    }
  }

  return { paths, junctions };
}

/** Shortest distance from a point to a polyline, in the same units. */
export function distanceToPolyline(pts: Point[], p: Point): number {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    best = Math.min(best, distanceToSegment(pts[i], pts[i + 1], p));
  }
  return best;
}

function distanceToSegment(a: Point, b: Point, p: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Human-readable bit range, shown on a wire only when it is a partial slice. */
export function sliceLabel(lo: number, hi: number, width: number): string | null {
  if (lo === 0 && hi === width - 1) return null;
  return lo === hi ? `[${lo}]` : `[${hi}..${lo}]`;
}

export function formatValue(value: number, width: number, format: string): string {
  const masked = width >= 32 ? value >>> 0 : (value & ((1 << width) - 1)) >>> 0;
  switch (format) {
    case 'bin': return masked.toString(2).padStart(width, '0');
    case 'dec': return String(masked);
    case 'sdec': {
      const signBit = 1 << (width - 1);
      return String(width < 32 && masked & signBit ? masked - (1 << width) : masked | 0);
    }
    default: return '0x' + masked.toString(16).toUpperCase().padStart(Math.ceil(width / 4), '0');
  }
}
