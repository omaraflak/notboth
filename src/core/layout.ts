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
export function layoutBox(
  sig: Signature,
  name: string,
  measure: Measure = approxMeasure,
  label?: string | null,
  /** Area the box must reserve for something painted inside it, in cells. */
  viewport?: { w: number; h: number } | null,
): BoxLayout {
  const rows = Math.max(sig.inputs.length, sig.outputs.length, 1);
  const h = Math.max(rows + 1, viewport ? viewport.h + 2 : 0);

  // A single-purpose primitive is named by its box; labelling its one pin as
  // well is noise, so it is neither measured nor painted.
  const pinCount = sig.inputs.length + sig.outputs.length;
  let maxIn = 0;
  for (const p of sig.inputs) {
    if (showPinLabel(p, name, pinCount)) maxIn = Math.max(maxIn, measure(p.name, PIN_FONT));
  }
  let maxOut = 0;
  for (const p of sig.outputs) {
    if (showPinLabel(p, name, pinCount)) maxOut = Math.max(maxOut, measure(p.name, PIN_FONT));
  }
  // A renamed part shows its label above its type, so the box has to be wide
  // enough for whichever of the two is longer.
  const nameW = Math.max(measure(name, NAME_FONT), label ? measure(label, PIN_FONT) : 0);

  const needed = maxIn + maxOut + nameW + PAD_PX * 4;
  // The viewport sits between the pin labels, so it adds to their width
  // rather than competing with it.
  const withView = viewport ? maxIn + maxOut + viewport.w * GRID + PAD_PX * 4 : 0;
  const w = Math.max(MIN_W, Math.ceil(Math.max(needed, withView) / GRID));

  const pins: PinLayout[] = [];
  sig.inputs.forEach((pin, i) => pins.push({ pin, side: 'in', index: i, x: 0, y: i + 1 }));
  sig.outputs.forEach((pin, i) => pins.push({ pin, side: 'out', index: i, x: w, y: i + 1 }));
  return { w, h, pins };
}

/**
 * False when the pin label would tell you nothing the box does not already.
 * That covers a pin named after its box, and any box with only one pin -- a
 * const, a clock, a port marker -- where the box label is the whole story.
 */
export function showPinLabel(pin: Pin, boxName: string, pinCount = 2): boolean {
  if (pinCount <= 1) return false;
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
  /** The parts at each end, which this wire is allowed to touch. */
  fromInst?: string;
  toInst?: string;
}

export interface Junction { x: number; y: number; net: string }

export interface RoutePlan {
  paths: Map<string, Point[]>;
  /** Where a branch leaves a trunk mid-run, and the two really are joined. */
  junctions: Junction[];
}

const MAX_CHANNEL_SHIFT = 8;
/** How far off a pin's own row a run may be detoured to find clear space. */
const MAX_DETOUR = 6;
/**
 * Above this many wires the schematic is past the point of being read, and the
 * search for clear space stops earning its keep -- so it is skipped and every
 * wire takes the direct route. Routing runs on every edit, and a circuit this
 * size is one you navigate by zooming in, not by following lines across it.
 */
const AVOIDANCE_LIMIT = 1500;
/** Grid cells per bucket in the occupancy index. */
const CELL = 8;

/**
 * What the schematic has already committed to, so that a later wire can be
 * asked to go somewhere else.
 *
 * Every reserved run remembers which signal put it there. Two wires driven by
 * the same pin *should* lie on top of each other -- that is one signal, drawn
 * once, branching -- so occupancy only counts against a different net. That
 * single rule is the whole difference between a schematic you can read and one
 * where two unrelated wires look like one.
 */
class Occupancy {
  private vertical = new Map<number, Map<number, Span[]>>();
  private horizontal = new Map<number, Map<number, Span[]>>();

  /**
   * Runs are filed by the cell they fall in, not just by the row, so a query
   * reads the few spans near where it is looking instead of every span on the
   * row. Without this the router is quadratic in the size of the schematic --
   * every part contributes a span to every row it covers, and every candidate
   * route reads them all.
   */
  private static file(map: Map<number, Map<number, Span[]>>, line: number, a: number, b: number, net: string) {
    const span: Span = { lo: Math.min(a, b), hi: Math.max(a, b), net };
    let cells = map.get(line);
    if (!cells) { cells = new Map(); map.set(line, cells); }
    for (let k = Math.floor(span.lo / CELL); k <= Math.floor(span.hi / CELL); k++) {
      const list = cells.get(k);
      if (list) list.push(span); else cells.set(k, [span]);
    }
  }

  /** Length of the longest run of `a..b` already held by something else. */
  private static clash(
    map: Map<number, Map<number, Span[]>>, line: number, a: number, b: number, exempt: Set<string>,
  ): number {
    const cells = map.get(line);
    if (!cells) return 0;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    let worst = 0;
    // A span filed in several cells is seen more than once, which is harmless:
    // the answer is the longest overlap, not their total.
    for (let k = Math.floor(lo / CELL); k <= Math.floor(hi / CELL); k++) {
      const list = cells.get(k);
      if (!list) continue;
      for (const s of list) {
        if (exempt.has(s.net)) continue;
        const over = Math.min(hi, s.hi) - Math.max(lo, s.lo);
        if (over > worst) worst = over;
      }
    }
    return worst;
  }

  /**
   * Total length of this path that would be drawn over something it should not
   * be: another signal, or the body of a part. `exempt` holds the names this
   * particular wire is allowed to overlap -- its own signal, and the two parts
   * it is attached to, which it obviously has to touch.
   */
  cost(pts: Point[], exempt: Set<string>): number {
    let total = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i];
      const q = pts[i + 1];
      if (p.x === q.x) total += Occupancy.clash(this.vertical, p.x, p.y, q.y, exempt);
      else if (p.y === q.y) total += Occupancy.clash(this.horizontal, p.y, p.x, q.x, exempt);
    }
    return total;
  }

  claim(pts: Point[], net: string) {
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i];
      const q = pts[i + 1];
      if (p.x === q.x) Occupancy.file(this.vertical, p.x, p.y, q.y, net);
      else if (p.y === q.y) Occupancy.file(this.horizontal, p.y, p.x, q.x, net);
    }
  }

  /**
   * Reserve the body of a part. A box is simply space a wire may not occupy,
   * so it costs nothing extra to express it the same way as a wire: routing
   * around parts and routing around other signals become one search.
   */
  block(r: Obstacle) {
    const name = boxNet(r.id);
    for (let y = r.y0; y <= r.y1; y++) Occupancy.file(this.horizontal, y, r.x0, r.x1, name);
    for (let x = r.x0; x <= r.x1; x++) Occupancy.file(this.vertical, x, r.y0, r.y1, name);
  }
}

interface Span { lo: number; hi: number; net: string }

/** The body of a part, in grid units, that wires should route around. */
export interface Obstacle { id: string; x0: number; y0: number; x1: number; y1: number }

const boxNet = (id: string) => `\u0000box:${id}`;

/**
 * A path that leaves the source on its own row, crosses on `track`, and comes
 * back to the sink's row at the end. Used when the direct route would be drawn
 * on top of another signal: two extra bends is a smaller price than two wires
 * that look like one.
 */
function aroundWire(start: Point, end: Point, track: number): Point[] {
  const outX = start.x + 1;
  const inX = end.x - 1;
  return dedupe([
    start,
    { x: outX, y: start.y }, { x: outX, y: track },
    { x: inX, y: track }, { x: inX, y: end.y },
    end,
  ]);
}

function detourWire(start: Point, end: Point, track: number): Point[] {
  const outX = start.x + 1;
  const inX = Math.max(outX + 1, end.x - 1);
  return dedupe([
    start,
    { x: outX, y: start.y }, { x: outX, y: track },
    { x: inX, y: track }, { x: inX, y: end.y },
    end,
  ]);
}

export function planRoutes(wires: WireGeom[], obstacles: Obstacle[] = []): RoutePlan {
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

  const held = new Occupancy();
  const avoiding = wires.length <= AVOIDANCE_LIMIT;
  if (avoiding) for (const r of obstacles) held.block(r);

  for (const [net, group] of ordered) {
    const from = group[0].from;
    // Wires that can use the net's trunk: forwards, and not hand-routed.
    const trunk = group.filter((w) => !w.via?.length && w.to.x - from.x >= 2);
    const direct = group.filter((w) => !trunk.includes(w));

    const exemptOf = (w: WireGeom) =>
      new Set([net, boxNet(w.fromInst ?? ''), boxNet(w.toInst ?? '')]);

    // Wires that run backwards -- the feedback in every latch -- have to come
    // round the outside of their own gates. Which row they come round on is
    // free, so it is worth choosing one that is not already taken.
    for (const w of direct) {
      let path = routeWire(w.from, w.to, w.via ?? []);
      if (avoiding && !w.via?.length) {
        const exempt = exemptOf(w);
        let bestCost = held.cost(path, exempt);
        const home = w.from.y === w.to.y
          ? w.from.y + 2
          : Math.round((w.from.y + w.to.y) / 2);
        for (let d = 1; d <= MAX_DETOUR && bestCost > 0; d++) {
          for (const track of [home + d, home - d]) {
            const candidate = aroundWire(w.from, w.to, track);
            const cost = held.cost(candidate, exempt);
            if (cost < bestCost) { bestCost = cost; path = candidate; }
            if (cost === 0) break;
          }
        }
      }
      paths.set(w.id, path);
      held.claim(path, net);
    }
    if (!trunk.length) continue;

    const nearest = Math.min(...trunk.map((w) => w.to.x));
    const lo = from.x + 1;
    const hi = nearest - 1;
    const mid = Math.min(hi, Math.max(lo, Math.round((from.x + nearest) / 2)));

    // Pick the column for this net's trunk. Every segment it implies counts,
    // not just the vertical one: moving the trunk right lengthens the run out
    // of the source and shortens the runs into the sinks, so the best column
    // is genuinely a trade-off and worth searching for.
    let channel = mid;
    let bestCost = avoiding ? Infinity : 0;
    for (let shift = 0; shift <= MAX_CHANNEL_SHIFT && bestCost > 0; shift++) {
      for (const c of shift === 0 ? [mid] : [mid + shift, mid - shift]) {
        if (c < lo || c > hi) continue;
        let cost = 0;
        for (const w of trunk) cost += held.cost(routeWire(w.from, w.to, [], c), exemptOf(w));
        if (cost < bestCost) { bestCost = cost; channel = c; }
        if (cost === 0) break;
      }
    }

    for (const w of trunk) {
      const exempt = exemptOf(w);
      let path = routeWire(w.from, w.to, [], channel);
      if (avoiding && held.cost(path, exempt) > 0) {
        // Still sitting on someone else's signal -- most often a run straight
        // along a row that another wire is already using. Step off the row.
        const home = w.from.y === w.to.y ? w.from.y : Math.round((w.from.y + w.to.y) / 2);
        let best: Point[] | null = null;
        let bestDetour = held.cost(path, exempt);
        for (let d = 1; d <= MAX_DETOUR && bestDetour > 0; d++) {
          for (const track of [home - d, home + d]) {
            const candidate = detourWire(w.from, w.to, track);
            const cost = held.cost(candidate, exempt);
            if (cost < bestDetour) { bestDetour = cost; best = candidate; }
            if (cost === 0) break;
          }
        }
        if (best) path = best;
      }
      paths.set(w.id, path);
      held.claim(path, net);
    }

    // A dot wherever the trunk carries on past a branch, so a T is told apart
    // from a crossing.
    const onTrunk = trunk.filter((w) => (paths.get(w.id)?.length ?? 0) > 0
      && paths.get(w.id)!.some((p) => p.x === channel));
    if (onTrunk.length > 1) {
      const ys = [from.y, ...onTrunk.map((w) => w.to.y)];
      const top = Math.min(...ys);
      const bottom = Math.max(...ys);
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
