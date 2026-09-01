import { newId } from './ids';
import {
  asIdentifier, clampWidth, defaultProps, isPrim, primDefId, primKind, primSignature,
} from './primitives';
import type {
  ComponentDef, Folder, Id, Instance, Pin, PrimitiveKind, Project, Signature, Wire,
} from './types';

export function createProject(name = 'Untitled'): Project {
  const now = Date.now();
  // One ordinary component to open into. Somewhere to try things out is just a
  // component you choose not to place anywhere, so there is nothing to set up.
  const first = emptyDef('Main', null);
  return {
    id: newId('p_'),
    name,
    folders: [],
    defs: [first],
    openDefId: first.id,
    createdAt: now,
    updatedAt: now,
  };
}

export function emptyDef(name: string, folder: Id | null): ComponentDef {
  return { id: newId('c_'), name, folder, instances: [], wires: [], updatedAt: Date.now() };
}

export function getDef(p: Project, id: Id): ComponentDef | undefined {
  return p.defs.find((d) => d.id === id);
}

export function requireDef(p: Project, id: Id): ComponentDef {
  const d = getDef(p, id);
  if (!d) throw new Error(`no such component: ${id}`);
  return d;
}

/* ------------------------------------------------------------------ *
 * Signatures
 * ------------------------------------------------------------------ */

/**
 * A user component's pins are the IN/OUT markers it contains, in the order
 * they are stored. Deliberately *not* their order on the canvas: where a box
 * sits is a matter of layout, and rearranging a schematic to make it readable
 * should never quietly change the component's interface. Reorder pins from
 * the text editor, or with the arrows in the inspector.
 */
export function defSignature(p: Project, defId: Id, props = {}): Signature {
  if (isPrim(defId)) return primSignature(primKind(defId), props);
  const def = getDef(p, defId);
  if (!def) return { inputs: [], outputs: [] };
  return signatureOf(def);
}

export function signatureOf(def: ComponentDef): Signature {
  const inputs: Pin[] = [];
  const outputs: Pin[] = [];
  for (const inst of def.instances) {
    if (!isPrim(inst.def)) continue;
    const kind = primKind(inst.def);
    // The pin's name is what the text form writes after `in`/`out` and after a
    // dot, so it has to be something that form can read back.
    if (kind === 'IN') {
      inputs.push({
        id: inst.id,
        name: asIdentifier(inst.props.name || 'in', 'in'),
        width: clampWidth(inst.props.width),
      });
    } else if (kind === 'OUT') {
      outputs.push({
        id: inst.id,
        name: asIdentifier(inst.props.name || 'out', 'out'),
        width: clampWidth(inst.props.width),
      });
    }
  }
  return { inputs, outputs };
}

export function pinOf(sig: Signature, pinId: Id): Pin | undefined {
  return sig.inputs.find((x) => x.id === pinId) ?? sig.outputs.find((x) => x.id === pinId);
}

/* ------------------------------------------------------------------ *
 * Instances and wires
 * ------------------------------------------------------------------ */

export function makeInstance(defId: Id, x: number, y: number, props = {}): Instance {
  const base = isPrim(defId) ? defaultProps(primKind(defId)) : {};
  return { id: newId('i_'), def: defId, x, y, props: { ...base, ...props } };
}

/**
 * Kinds whose `name` prop the rest of the app reads back: the port markers,
 * which become the component's pins, and the two readouts.
 */
const NAMED_KINDS = new Set<PrimitiveKind>(['IN', 'OUT', 'PROBE']);

function nameOf(inst: Instance): string | null {
  if (!isPrim(inst.def) || !NAMED_KINDS.has(primKind(inst.def))) return null;
  return inst.props.name || null;
}

/**
 * Give newly arrived markers names nothing else in the component is using.
 *
 * Two pins called `in` is not a cosmetic clash: a port marker's name *is* the
 * pin's name, so a duplicate leaves the component with an ambiguous interface
 * and text that will not parse. Every path that brings an instance into a
 * component -- placing, pasting, duplicating -- goes through here, before the
 * instances are added.
 *
 * A trailing number is treated as a counter rather than part of the name, so
 * duplicating `a1` gives `a2` instead of `a11`.
 */
export { asIdentifier };

export function nameNewInstances(def: ComponentDef, fresh: Instance[]): void {
  const arriving = new Set(fresh.map((i) => i.id));
  const taken = new Set<string>();
  for (const inst of def.instances) {
    if (arriving.has(inst.id)) continue;
    const name = nameOf(inst);
    if (name) taken.add(name);
  }
  for (const inst of fresh) {
    const name = nameOf(inst);
    if (!name) continue;
    const chosen = freeName(name, taken);
    inst.props.name = chosen;
    taken.add(chosen);
  }
}

function freeName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  const base = name.replace(/\d+$/, '') || name;
  for (let n = 2; ; n++) {
    const candidate = `${base}${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function addPrimitive(
  def: ComponentDef, kind: PrimitiveKind, x: number, y: number, props = {},
): Instance {
  const inst = makeInstance(primDefId(kind), x, y, props);
  def.instances.push(inst);
  return inst;
}

/**
 * Which bits of `pin` a new connection should take.
 *
 * Wiring a sixteen-bit bus to sixteen one-bit gates is the commonest thing
 * there is to do here, and taking bit zero every time would mean editing the
 * range by hand fifteen times. So a fresh connection claims the lowest stretch
 * of the pin that nothing has taken yet, which walks a bus outwards one drag
 * at a time. When the pin is full it starts over at the bottom rather than
 * refusing, because a second wire from the same bits is sometimes exactly what
 * is wanted -- fan-out from a one-bit pin is nothing else.
 */
export function nextFreeBits(
  def: ComponentDef, instId: Id, pinId: Id, width: number, pinWidth: number,
): { lo: number; hi: number } {
  const taken: Array<[number, number]> = [];
  for (const w of def.wires) {
    if (w.from.inst === instId && w.from.pin === pinId) taken.push([w.from.lo, w.from.hi]);
    if (w.to.inst === instId && w.to.pin === pinId) taken.push([w.to.lo, w.to.hi]);
  }
  for (let lo = 0; lo + width <= pinWidth; lo++) {
    const hi = lo + width - 1;
    if (!taken.some(([a, b]) => Math.max(lo, a) <= Math.min(hi, b))) return { lo, hi };
  }
  return { lo: 0, hi: width - 1 };
}

/** Connect two endpoints, defaulting to the full width of both pins. */
export function connect(
  p: Project, def: ComponentDef,
  from: { inst: Id; pin: Id; lo?: number; hi?: number },
  to: { inst: Id; pin: Id; lo?: number; hi?: number },
  color?: string,
): Wire {
  const fw = pinWidth(p, def, from.inst, from.pin);
  const tw = pinWidth(p, def, to.inst, to.pin);
  const wire: Wire = {
    id: newId('w_'),
    from: { inst: from.inst, pin: from.pin, lo: from.lo ?? 0, hi: from.hi ?? fw - 1 },
    to: { inst: to.inst, pin: to.pin, lo: to.lo ?? 0, hi: to.hi ?? tw - 1 },
  };
  if (color) wire.color = color;
  def.wires.push(wire);
  return wire;
}

export function pinWidth(p: Project, def: ComponentDef, instId: Id, pinId: Id): number {
  const inst = def.instances.find((i) => i.id === instId);
  if (!inst) return 1;
  const sig = defSignature(p, inst.def, inst.props);
  return pinOf(sig, pinId)?.width ?? 1;
}

/** Move a port marker earlier or later in the pin list. */
export function movePort(def: ComponentDef, instId: Id, delta: number): boolean {
  const kindOf = (i: Instance) => (isPrim(i.def) ? primKind(i.def) : null);
  const target = def.instances.find((i) => i.id === instId);
  if (!target) return false;
  const kind = kindOf(target);
  if (kind !== 'IN' && kind !== 'OUT') return false;

  // Only the markers of the same kind matter: inputs and outputs are ordered
  // independently of each other.
  const slots: number[] = [];
  def.instances.forEach((inst, index) => { if (kindOf(inst) === kind) slots.push(index); });
  const at = slots.indexOf(def.instances.indexOf(target));
  const to = at + delta;
  if (at < 0 || to < 0 || to >= slots.length) return false;

  const a = slots[at];
  const b = slots[to];
  [def.instances[a], def.instances[b]] = [def.instances[b], def.instances[a]];
  return true;
}

export function removeInstances(def: ComponentDef, ids: Set<Id>) {
  def.instances = def.instances.filter((i) => !ids.has(i.id));
  def.wires = def.wires.filter((w) => !ids.has(w.from.inst) && !ids.has(w.to.inst));
}

export function removeWires(def: ComponentDef, ids: Set<Id>) {
  def.wires = def.wires.filter((w) => !ids.has(w.id));
}

/* ------------------------------------------------------------------ *
 * Library operations
 * ------------------------------------------------------------------ */

/** Every definition that directly instantiates `defId`. */
export function usersOf(p: Project, defId: Id): ComponentDef[] {
  return p.defs.filter((d) => d.id !== defId && d.instances.some((i) => i.def === defId));
}

export function usageCount(p: Project, defId: Id): number {
  let n = 0;
  for (const d of p.defs) for (const i of d.instances) if (i.def === defId) n++;
  return n;
}

export interface ReplacePreview {
  instances: number;
  defs: number;
  /** Pins of `fromId` that have no same-named counterpart in `toId`. */
  droppedPins: string[];
  /** Pins whose width changes; their wires are dropped too. */
  resizedPins: string[];
  wiresDropped: number;
}

/**
 * Swap every instance of one component for another, matching pins by name.
 * This is the direct operation that "rewritable component ids" would only
 * approximate, and unlike an id rewrite it can report what will break first.
 */
export function previewReplace(p: Project, fromId: Id, toId: Id): ReplacePreview {
  const a = defSignature(p, fromId);
  const b = defSignature(p, toId);
  const droppedPins: string[] = [];
  const resizedPins: string[] = [];
  const map = pinMapping(a, b, droppedPins, resizedPins);

  let instances = 0;
  let wiresDropped = 0;
  const defs = new Set<Id>();
  for (const d of p.defs) {
    const affected = d.instances.filter((i) => i.def === fromId);
    if (!affected.length) continue;
    defs.add(d.id);
    instances += affected.length;
    const ids = new Set(affected.map((i) => i.id));
    for (const w of d.wires) {
      if (ids.has(w.from.inst) && !map.has(w.from.pin)) wiresDropped++;
      else if (ids.has(w.to.inst) && !map.has(w.to.pin)) wiresDropped++;
    }
  }
  return { instances, defs: defs.size, droppedPins, resizedPins, wiresDropped };
}

export function replaceAllUses(p: Project, fromId: Id, toId: Id): ReplacePreview {
  const preview = previewReplace(p, fromId, toId);
  const a = defSignature(p, fromId);
  const b = defSignature(p, toId);
  const map = pinMapping(a, b, [], []);

  for (const d of p.defs) {
    const ids = new Set(d.instances.filter((i) => i.def === fromId).map((i) => i.id));
    if (!ids.size) continue;
    for (const i of d.instances) if (i.def === fromId) i.def = toId;
    d.wires = d.wires.filter((w) => {
      if (ids.has(w.from.inst)) {
        const next = map.get(w.from.pin);
        if (next === undefined) return false;
        w.from.pin = next;
      }
      if (ids.has(w.to.inst)) {
        const next = map.get(w.to.pin);
        if (next === undefined) return false;
        w.to.pin = next;
      }
      return true;
    });
    d.updatedAt = Date.now();
  }
  return preview;
}

function pinMapping(a: Signature, b: Signature, dropped: string[], resized: string[]): Map<Id, Id> {
  const map = new Map<Id, Id>();
  const pair = (from: Pin[], to: Pin[]) => {
    for (const pin of from) {
      const match = to.find((x) => x.name === pin.name);
      if (!match) { dropped.push(pin.name); continue; }
      if (match.width !== pin.width) { resized.push(pin.name); continue; }
      map.set(pin.id, match.id);
    }
  };
  pair(a.inputs, b.inputs);
  pair(a.outputs, b.outputs);
  return map;
}

export function deleteDef(p: Project, defId: Id) {
  p.defs = p.defs.filter((d) => d.id !== defId);
  for (const d of p.defs) {
    const ids = new Set(d.instances.filter((i) => i.def === defId).map((i) => i.id));
    if (!ids.size) continue;
    d.instances = d.instances.filter((i) => !ids.has(i.id));
    d.wires = d.wires.filter((w) => !ids.has(w.from.inst) && !ids.has(w.to.inst));
  }
  if (p.openDefId === defId) p.openDefId = p.defs[0]?.id ?? null;
}

/**
 * True if placing `childId` inside `parentId` would create a cycle. Checked at
 * placement time so a recursive definition can never be saved.
 */
export function wouldRecurse(p: Project, parentId: Id, childId: Id): boolean {
  if (parentId === childId) return true;
  const seen = new Set<Id>();
  const visit = (id: Id): boolean => {
    if (id === parentId) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    const def = getDef(p, id);
    if (!def) return false;
    return def.instances.some((i) => !isPrim(i.def) && visit(i.def));
  };
  return visit(childId);
}

/* ------------------------------------------------------------------ *
 * Folders
 * ------------------------------------------------------------------ */

export function createFolder(p: Project, name: string, parent: Id | null = null): Folder {
  const f: Folder = { id: newId('f_'), name, parent };
  p.folders.push(f);
  return f;
}

export function deleteFolder(p: Project, folderId: Id) {
  const kids = p.folders.filter((f) => f.parent === folderId);
  const target = p.folders.find((f) => f.id === folderId)?.parent ?? null;
  for (const k of kids) k.parent = target;
  for (const d of p.defs) if (d.folder === folderId) d.folder = target;
  p.folders = p.folders.filter((f) => f.id !== folderId);
}

/**
 * Does `folderId` sit at or inside `ancestor`?
 *
 * The question worth asking before moving a folder: putting one inside its own
 * descendant would cut that branch off the tree, taking everything on it with
 * it and leaving a ring of folders that is its own parent.
 */
export function folderContains(p: Project, ancestor: Id, folderId: Id | null): boolean {
  const seen = new Set<Id>();
  let cur = folderId;
  while (cur) {
    if (cur === ancestor) return true;
    if (seen.has(cur)) return false;      // already broken; do not spin on it
    seen.add(cur);
    cur = p.folders.find((f) => f.id === cur)?.parent ?? null;
  }
  return false;
}

export function folderPath(p: Project, folderId: Id | null): string {
  const parts: string[] = [];
  let cur = folderId;
  const guard = new Set<Id>();
  while (cur) {
    if (guard.has(cur)) break;
    guard.add(cur);
    const f = p.folders.find((x) => x.id === cur);
    if (!f) break;
    parts.unshift(f.name);
    cur = f.parent;
  }
  return parts.join('/');
}

/** Ensure a name is unique within the project; components are addressed by id
 *  but duplicate names make the library unreadable. */
export function uniqueName(p: Project, base: string, exceptId?: Id): string {
  const taken = new Set(p.defs.filter((d) => d.id !== exceptId).map((d) => d.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}
