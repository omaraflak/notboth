import { newId } from './ids';
import { isPrim, primDefId, primKind } from './primitives';
import { defSignature, emptyDef, pinOf, uniqueName } from './project';
import type { ComponentDef, Id, Instance, Project, Wire } from './types';

export interface ExtractResult {
  def: ComponentDef;
  instance: Instance;
  inputs: number;
  outputs: number;
}

/**
 * Turn a selected sub-circuit into a named component and drop an instance of
 * it back in its place.
 *
 * Wires that cross the selection boundary become port markers: one IN for each
 * inside input pin that something outside drives, one OUT for each inside
 * output pin that something outside reads. Slices are preserved on both sides,
 * so extracting a group of gates never changes what the circuit does.
 */
export function extractSelection(
  project: Project,
  parent: ComponentDef,
  selected: Set<Id>,
  name: string,
): ExtractResult | null {
  const inside = parent.instances.filter(
    (i) => selected.has(i.id) && !isPortMarker(i),
  );
  if (!inside.length) return null;
  const insideIds = new Set(inside.map((i) => i.id));

  const internal: Wire[] = [];
  const inbound: Wire[] = [];
  const outbound: Wire[] = [];
  const untouched: Wire[] = [];
  for (const w of parent.wires) {
    const f = insideIds.has(w.from.inst);
    const t = insideIds.has(w.to.inst);
    if (f && t) internal.push(w);
    else if (t) inbound.push(w);
    else if (f) outbound.push(w);
    else untouched.push(w);
  }

  const def = emptyDef(uniqueName(project, name), parent.folder);

  // Keep the relative arrangement, shifted to leave room for port markers.
  const minX = Math.min(...inside.map((i) => i.x));
  const minY = Math.min(...inside.map((i) => i.y));
  const maxX = Math.max(...inside.map((i) => i.x));
  const INSET = 8;      // room on the left for the IN markers
  const OUT_GAP = 12;   // clear space between the logic and the OUT markers
  for (const i of inside) {
    def.instances.push({ ...structuredClone(i), x: i.x - minX + INSET, y: i.y - minY });
  }
  for (const w of internal) def.wires.push(structuredClone(w));

  // One port per crossed pin, not per crossed wire.
  const inPorts = new Map<string, Instance>();
  const outPorts = new Map<string, Instance>();
  const usedNames = new Set<string>();
  let inRow = 0;
  let outRow = 0;

  for (const w of inbound) {
    const key = `${w.to.inst}:${w.to.pin}`;
    if (inPorts.has(key)) continue;
    const width = widthOf(project, parent, w.to.inst, w.to.pin);
    const port: Instance = {
      id: newId('i_'),
      def: primDefId('IN'),
      x: 0, y: inRow++,
      props: { name: portName(project, parent, w.to.inst, w.to.pin, usedNames), width },
    };
    inPorts.set(key, port);
    def.instances.push(port);
  }
  for (const w of outbound) {
    const key = `${w.from.inst}:${w.from.pin}`;
    if (outPorts.has(key)) continue;
    const width = widthOf(project, parent, w.from.inst, w.from.pin);
    const port: Instance = {
      id: newId('i_'),
      def: primDefId('OUT'),
      x: maxX - minX + INSET + OUT_GAP, y: outRow++,
      props: { name: portName(project, parent, w.from.inst, w.from.pin, usedNames), width },
    };
    outPorts.set(key, port);
    def.instances.push(port);
  }

  // Inside: connect each port marker straight through to the pin it stands for.
  for (const [key, port] of inPorts) {
    const [inst, pin] = splitKey(key);
    const width = widthOf(project, parent, inst, pin);
    def.wires.push(wire({ inst: port.id, pin: 'out', lo: 0, hi: width - 1 }, { inst, pin, lo: 0, hi: width - 1 }));
  }
  for (const [key, port] of outPorts) {
    const [inst, pin] = splitKey(key);
    const width = widthOf(project, parent, inst, pin);
    def.wires.push(wire({ inst, pin, lo: 0, hi: width - 1 }, { inst: port.id, pin: 'in', lo: 0, hi: width - 1 }));
  }

  project.defs.push(def);

  // Parent: swap the selection for a single box, reattaching the crossings.
  const box: Instance = {
    id: newId('i_'),
    def: def.id,
    x: minX,
    y: minY,
    props: {},
  };
  parent.instances = parent.instances.filter((i) => !insideIds.has(i.id));
  parent.instances.push(box);
  parent.wires = untouched;
  for (const w of inbound) {
    const port = inPorts.get(`${w.to.inst}:${w.to.pin}`)!;
    parent.wires.push(wire(w.from, { inst: box.id, pin: port.id, lo: w.to.lo, hi: w.to.hi }, w.color));
  }
  for (const w of outbound) {
    const port = outPorts.get(`${w.from.inst}:${w.from.pin}`)!;
    parent.wires.push(wire({ inst: box.id, pin: port.id, lo: w.from.lo, hi: w.from.hi }, w.to, w.color));
  }
  parent.updatedAt = Date.now();

  return { def, instance: box, inputs: inPorts.size, outputs: outPorts.size };
}

function isPortMarker(i: Instance): boolean {
  if (!isPrim(i.def)) return false;
  const k = primKind(i.def);
  return k === 'IN' || k === 'OUT';
}

function splitKey(key: string): [Id, Id] {
  const at = key.indexOf(':');
  return [key.slice(0, at), key.slice(at + 1)];
}

function widthOf(p: Project, def: ComponentDef, instId: Id, pinId: Id): number {
  const inst = def.instances.find((i) => i.id === instId);
  if (!inst) return 1;
  return pinOf(defSignature(p, inst.def, inst.props), pinId)?.width ?? 1;
}

function portName(p: Project, def: ComponentDef, instId: Id, pinId: Id, used: Set<string>): string {
  const inst = def.instances.find((i) => i.id === instId);
  const sig = inst ? defSignature(p, inst.def, inst.props) : { inputs: [], outputs: [] };
  const base = pinOf(sig, pinId)?.name || 'port';
  let name = base;
  for (let n = 2; used.has(name); n++) name = `${base}${n}`;
  used.add(name);
  return name;
}

function wire(from: Wire['from'], to: Wire['to'], color?: string): Wire {
  const w: Wire = { id: newId('w_'), from: { ...from }, to: { ...to } };
  if (color) w.color = color;
  return w;
}
