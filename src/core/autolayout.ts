/**
 * Arranging a schematic.
 *
 * Position is presentation: it has no effect on what a circuit does, on its
 * pin order, or on how it reads in the text editor. That makes rearranging
 * completely safe, and means it can be done on demand.
 *
 * The shape is the one every schematic has: signals flow left to right, so a
 * part sits in the column after the deepest thing feeding it. Columns alone
 * are not much of an arrangement though -- they say nothing about the order
 * within a column, and a bad order is what makes a picture look like a bowl of
 * spaghetti. Two things fix that here.
 *
 *  - **Order follows the wires.** Each column is sorted by where the parts
 *    feeding it ended up, swept forwards and backwards a few times until it
 *    settles. This is the barycentre heuristic, and it is what turns a random
 *    stack into rows that line up with what drives them.
 *  - **Long wires get a lane.** A wire that skips a column would otherwise be
 *    drawn straight through whatever is standing there. Reserving a slot for
 *    it in each column it crosses keeps that space empty, so the wire has
 *    somewhere to go and the parts move apart to make room.
 */
import { approxMeasure, layoutBox, type Measure } from './layout';
import { customLabel, isPrim, primKind } from './primitives';
import { defSignature } from './project';
import type { ComponentDef, Id, Instance, Project, Wire } from './types';

const COLUMN_GAP = 4;
const ROW_GAP = 1;
const MARGIN = 2;
/** Vertical room kept clear in a column for one wire passing through it. */
const LANE_HEIGHT = 1;
/** Forward-and-back ordering sweeps. Beyond about this it stops improving. */
const SWEEPS = 4;

export interface ArrangeOptions {
  /** Restrict the move to these parts; everything else stays put. */
  only?: Set<Id>;
  measure?: Measure;
}

interface Node {
  key: string;
  layer: number;
  /** Absent on a lane, which is reserved space rather than a part. */
  inst?: Instance;
  height: number;
  /** Where this sat before, used to seed the order and to break ties. */
  hint: number;
  index: number;
  /**
   * Position in the component's pin list, on a port marker only. Ports are
   * held in that order however the rest of the column is shuffled: reading the
   * left-hand column downwards is how you see a component's interface, and it
   * has to agree with the inspector and with the text.
   */
  port?: number;
}

/** Lay parts out in columns. Returns how many actually moved. */
export function arrange(
  project: Project,
  instances: Instance[],
  wires: Wire[],
  options: ArrangeOptions = {},
): number {
  if (!instances.length) return 0;
  const measure = options.measure ?? approxMeasure;
  const byId = new Map(instances.map((i) => [i.id, i]));

  const layerOf = assignLayers(instances, wires, byId);
  const { layers, predecessors, successors } = buildGraph(instances, wires, layerOf, measure, project);

  order(layers, predecessors, successors);
  return place(layers, project, measure, options);
}

/* ------------------------------------------------------------------ *
 * Columns
 * ------------------------------------------------------------------ */

function assignLayers(instances: Instance[], wires: Wire[], byId: Map<Id, Instance>): Map<Id, number> {
  const feeders = new Map<Id, Id[]>();
  for (const w of wires) {
    const list = feeders.get(w.to.inst);
    if (list) list.push(w.from.inst); else feeders.set(w.to.inst, [w.from.inst]);
  }

  const kindOf = (inst: Instance) => (isPrim(inst.def) ? primKind(inst.def) : null);
  const depth = new Map<Id, number>();
  const visiting = new Set<Id>();

  const depthOf = (id: Id): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    // A feedback loop has no "first" gate; break the tie rather than recurse
    // forever. Latches are supposed to look like this.
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const inst = byId.get(id);
    const isSource = inst && (kindOf(inst) === 'IN' || kindOf(inst) === 'TOGGLE'
      || kindOf(inst) === 'CONST' || kindOf(inst) === 'CLOCK');
    let d = isSource ? 0 : 1;
    for (const from of feeders.get(id) ?? []) d = Math.max(d, depthOf(from) + 1);
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };

  let deepest = 0;
  for (const inst of instances) deepest = Math.max(deepest, depthOf(inst.id));
  // Outputs belong at the right edge whatever feeds them -- and in a column of
  // their own past it. Sharing the last column with the gates that drive them
  // would leave those wires with no room to run forwards, so every one of them
  // would have to double back around its own neighbours.
  const hasOthers = instances.some((i) => kindOf(i) !== 'OUT');
  for (const inst of instances) {
    if (kindOf(inst) === 'OUT') depth.set(inst.id, hasOthers ? deepest + 1 : 0);
  }
  return depth;
}

/* ------------------------------------------------------------------ *
 * The ordering graph
 * ------------------------------------------------------------------ */

function buildGraph(
  instances: Instance[],
  wires: Wire[],
  layerOf: Map<Id, number>,
  measure: Measure,
  project: Project,
) {
  const layers: Node[][] = [];
  const nodeOf = new Map<string, Node>();
  const predecessors = new Map<string, string[]>();
  const successors = new Map<string, string[]>();

  const put = (node: Node) => {
    (layers[node.layer] ??= []).push(node);
    nodeOf.set(node.key, node);
    return node;
  };
  const link = (from: string, to: string) => {
    (successors.get(from) ?? successors.set(from, []).get(from)!).push(to);
    (predecessors.get(to) ?? predecessors.set(to, []).get(to)!).push(from);
  };

  instances.forEach((inst, rank) => {
    const box = layoutBox(defSignature(project, inst.def, inst.props), labelOf(project, inst), measure, customLabel(inst));
    const kind = isPrim(inst.def) ? primKind(inst.def) : null;
    put({
      key: inst.id,
      layer: layerOf.get(inst.id) ?? 0,
      inst,
      height: box.h,
      hint: inst.y,
      index: 0,
      // Their order in the instance list is the pin order, which is the one
      // thing about a schematic that is not free to be rearranged.
      port: kind === 'IN' || kind === 'OUT' ? rank : undefined,
    });
  });

  // A wire that skips columns gets a reserved slot in each one it crosses, so
  // nothing is standing in its way when the router comes to draw it. The cap
  // keeps a pathological circuit -- one signal crossing a hundred columns --
  // from generating more filler than the schematic has parts.
  let budget = instances.length * 4;

  for (const w of wires) {
    const a = layerOf.get(w.from.inst);
    const b = layerOf.get(w.to.inst);
    if (a === undefined || b === undefined) continue;
    // Feedback runs right to left; for ordering purposes it pulls its two ends
    // together just the same, so read it in the direction the columns go.
    const [lo, hi, from, to] = a <= b
      ? [a, b, w.from.inst, w.to.inst]
      : [b, a, w.to.inst, w.from.inst];
    if (lo === hi) continue;

    const spanned = hi - lo - 1;
    if (spanned <= 0 || budget < spanned) {
      link(from, to);
      continue;
    }
    budget -= spanned;
    const midpoint = ((nodeOf.get(from)?.hint ?? 0) + (nodeOf.get(to)?.hint ?? 0)) / 2;
    let previous = from;
    for (let l = lo + 1; l < hi; l++) {
      const lane = put({ key: `lane:${w.id}:${l}`, layer: l, height: LANE_HEIGHT, hint: midpoint, index: 0 });
      link(previous, lane.key);
      previous = lane.key;
    }
    link(previous, to);
  }

  for (const column of layers) {
    if (!column) continue;
    column.sort((p, q) => p.hint - q.hint || (p.inst?.x ?? 0) - (q.inst?.x ?? 0));
    holdPortOrder(column);
    column.forEach((n, i) => { n.index = i; });
  }
  return { layers, predecessors, successors };
}

/* ------------------------------------------------------------------ *
 * Ordering
 * ------------------------------------------------------------------ */

/**
 * Sort each column by the average position of what it is attached to in the
 * column before it, then do the same backwards, a few times over. A node with
 * nothing to go on keeps where it is, so an arrangement never churns for no
 * reason.
 */
function order(
  layers: Node[][],
  predecessors: Map<string, string[]>,
  successors: Map<string, string[]>,
) {
  const positionOf = new Map<string, number>();
  const reindex = (column: Node[]) => column.forEach((n, i) => {
    n.index = i;
    positionOf.set(n.key, i);
  });
  for (const column of layers) if (column) reindex(column);

  const sweep = (column: Node[], neighbours: Map<string, string[]>) => {
    const scored = column.map((n) => {
      const near = neighbours.get(n.key) ?? [];
      let sum = 0;
      let count = 0;
      for (const k of near) {
        const at = positionOf.get(k);
        if (at !== undefined) { sum += at; count++; }
      }
      return { node: n, score: count ? sum / count : n.index };
    });
    scored.sort((p, q) => p.score - q.score || p.node.index - q.node.index);
    const next = scored.map((s) => s.node);
    column.length = 0;
    column.push(...next);
    holdPortOrder(column);
    reindex(column);
  };

  for (let pass = 0; pass < SWEEPS; pass++) {
    for (let l = 1; l < layers.length; l++) if (layers[l]) sweep(layers[l], predecessors);
    for (let l = layers.length - 2; l >= 0; l--) if (layers[l]) sweep(layers[l], successors);
  }
}

/**
 * Put the port markers back into pin order, keeping whichever slots the
 * heuristic chose for them. So the arrangement still decides *where* the ports
 * sit relative to everything else, and the component decides which port is
 * which -- rearranging a schematic must never look like the interface changed.
 */
function holdPortOrder(column: Node[]) {
  const ports = column.filter((n) => n.port !== undefined);
  if (ports.length < 2) return;
  ports.sort((p, q) => p.port! - q.port!);
  let next = 0;
  for (let i = 0; i < column.length; i++) {
    if (column[i].port !== undefined) column[i] = ports[next++];
  }
}

/* ------------------------------------------------------------------ *
 * Coordinates
 * ------------------------------------------------------------------ */

function place(
  layers: Node[][],
  project: Project,
  measure: Measure,
  options: ArrangeOptions,
): number {
  let moved = 0;
  let x = MARGIN;

  for (const column of layers) {
    if (!column?.length) continue;
    let widest = 4;
    let y = MARGIN;
    for (const node of column) {
      if (node.inst) {
        const box = layoutBox(
          defSignature(project, node.inst.def, node.inst.props),
          labelOf(project, node.inst),
          measure,
          customLabel(node.inst),
        );
        widest = Math.max(widest, box.w);
        if (!options.only || options.only.has(node.inst.id)) {
          if (node.inst.x !== x || node.inst.y !== y) moved++;
          node.inst.x = x;
          node.inst.y = y;
        }
      }
      y += node.height + ROW_GAP;
    }
    x += widest + COLUMN_GAP;
  }
  return moved;
}

/** Arrange a whole component in place. */
export function arrangeDef(project: Project, def: ComponentDef): number {
  return arrange(project, def.instances, def.wires);
}

function labelOf(project: Project, inst: Instance): string {
  if (isPrim(inst.def)) {
    const kind = primKind(inst.def);
    if (kind === 'IN' || kind === 'OUT' || kind === 'TOGGLE' || kind === 'PROBE') {
      return inst.props.name || kind.toLowerCase();
    }
    return kind;
  }
  return project.defs.find((d) => d.id === inst.def)?.name ?? '?';
}
