import { isPrim, clampWidth, primKind, primSignature, screenAddrWidth } from './primitives';
import { defSignature, pinOf, signatureOf } from './project';
import type {
  ComponentDef, Id, Instance, NumberFormat, Project, Signature,
} from './types';

/* ------------------------------------------------------------------ *
 * Netlist shape
 * ------------------------------------------------------------------ */

export interface CompileError {
  message: string;
  defId?: Id;
  instId?: Id;
  wireId?: Id;
}

export interface ClockNode { net: number; period: number; path: string; instId: Id; top: boolean }

/**
 * A port on the component being edited. It has no driver inside the circuit,
 * so its value is whatever the editor or a test bench puts there -- which is
 * why an input port is the thing you click to switch a signal on.
 */
export interface InputNode {
  nets: number[]; width: number; value: number;
  path: string; instId: Id; top: boolean;
}

export interface ProbeNode {
  nets: number[]; width: number; format: NumberFormat;
  path: string; instId: Id; top: boolean;
}

export interface MemNode {
  /** ROM is read-only; RAM and SCREEN latch on the rising clock edge. */
  kind: 'ROM' | 'RAM' | 'SCREEN';
  addr: number[];
  data: number[];          // output bits
  din: number[];           // RAM only
  load: number;            // RAM only, -1 for ROM
  clk: number;             // RAM only, -1 for ROM
  addrWidth: number;
  dataWidth: number;
  contents: number[];
  path: string; instId: Id; top: boolean;
}

export interface Netlist {
  netCount: number;
  gateCount: number;
  gA: Int32Array;
  gB: Int32Array;
  gY: Int32Array;
  /** Nets held permanently at a fixed value by a CONST. */
  constNets: Int32Array;
  constVals: Uint8Array;
  clocks: ClockNode[];
  inputs: InputNode[];
  probes: ProbeNode[];
  mems: MemNode[];
  /** Root component's port pins, for test benches and external stimulus. */
  rootInputs: Map<Id, number[]>;
  rootOutputs: Map<Id, number[]>;
  /** `${instanceId}:${pinId}` -> nets, for root-level instances only. Used by
   *  the canvas to colour live wires and pins. */
  rootPinNets: Map<string, number[]>;
  /** net -> gates that read it. CSR-style adjacency. */
  fanoutStart: Int32Array;
  fanout: Int32Array;
  errors: CompileError[];
  rootSignature: Signature;
}

const MAX_GATES = 4_000_000;
const MAX_MEM_WORDS = 1 << 20;

/* ------------------------------------------------------------------ *
 * Union-find over raw nets
 * ------------------------------------------------------------------ */

class UnionFind {
  private parent: number[] = [];

  make(): number {
    this.parent.push(this.parent.length);
    return this.parent.length - 1;
  }

  find(x: number): number {
    let root = x;
    while (this.parent[root] !== root) root = this.parent[root];
    while (this.parent[x] !== root) {
      const next = this.parent[x];
      this.parent[x] = root;
      x = next;
    }
    return root;
  }

  union(a: number, b: number) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }

  get size() { return this.parent.length; }
}

/* ------------------------------------------------------------------ *
 * Compile
 * ------------------------------------------------------------------ */

interface RawGate { a: number; b: number; y: number }
interface RawDriver { net: number; what: string; instId: Id; defId: Id }

interface Ctx {
  uf: UnionFind;
  gates: RawGate[];
  drivers: RawDriver[];
  consts: { net: number; value: number }[];
  clocks: ClockNode[];
  inputs: InputNode[];
  probes: ProbeNode[];
  mems: MemNode[];
  errors: CompileError[];
  rootInputs: Map<Id, number[]>;
  rootOutputs: Map<Id, number[]>;
  rootPinNets: Map<string, number[]>;
  aborted: boolean;
  /** Built once per compile: definition lookup and memoised signatures. */
  defIndex: Map<Id, ComponentDef>;
  sigCache: Map<Id, Signature>;
}

export function compile(project: Project, rootDefId: Id): Netlist {
  const ctx: Ctx = {
    uf: new UnionFind(),
    gates: [], drivers: [], consts: [],
    clocks: [], inputs: [], probes: [], mems: [],
    errors: [],
    rootInputs: new Map(), rootOutputs: new Map(), rootPinNets: new Map(),
    aborted: false,
    defIndex: new Map(project.defs.map((d) => [d.id, d])),
    sigCache: new Map(),
  };

  const root = ctx.defIndex.get(rootDefId);
  if (!root) {
    return emptyNetlist([{ message: `component not found` }]);
  }

  flattenDef(root, null, '', ctx, new Set(), true);
  return finalize(ctx, signatureSafe(project, rootDefId));
}

/** Signature of a user component, computed once per compile. */
function userSig(ctx: Ctx, defId: Id): Signature {
  let sig = ctx.sigCache.get(defId);
  if (!sig) {
    const def = ctx.defIndex.get(defId);
    sig = def ? signatureOf(def) : { inputs: [], outputs: [] };
    ctx.sigCache.set(defId, sig);
  }
  return sig;
}

function signatureSafe(p: Project, id: Id): Signature {
  try { return defSignature(p, id); } catch { return { inputs: [], outputs: [] }; }
}

function flattenDef(
  def: ComponentDef,
  boundary: Map<Id, number[]> | null,
  path: string,
  ctx: Ctx,
  stack: Set<Id>,
  isRoot: boolean,
) {
  if (ctx.aborted) return;
  if (stack.has(def.id)) {
    ctx.errors.push({ message: `"${def.name}" contains itself (recursive definition)`, defId: def.id });
    return;
  }
  stack.add(def.id);

  // `${instanceId}:${pinId}` -> raw net per bit, for every instance at this level.
  const local = new Map<string, number[]>();
  // Direction of every pin at this level, so the wire loop is O(1) per wire
  // instead of re-deriving signatures.
  const pinDir = new Map<string, 'in' | 'out'>();
  const alloc = (key: string, width: number): number[] => {
    const nets: number[] = new Array(width);
    for (let i = 0; i < width; i++) nets[i] = ctx.uf.make();
    local.set(key, nets);
    return nets;
  };

  const children: { inst: Instance; def: ComponentDef; boundary: Map<Id, number[]>; path: string }[] = [];
  const labelCounts = new Map<string, number>();

  for (const inst of def.instances) {
    if (ctx.aborted) break;

    if (isPrim(inst.def)) {
      const kind = primKind(inst.def);

      // Fast path: NAND is by far the most common instance and its pins never
      // vary, so skip building a Signature object for it.
      if (kind === 'NAND') {
        for (const pinId of ['a', 'b'] as const) {
          alloc(`${inst.id}:${pinId}`, 1);
          pinDir.set(`${inst.id}:${pinId}`, 'in');
          if (isRoot) ctx.rootPinNets.set(`${inst.id}:${pinId}`, local.get(`${inst.id}:${pinId}`)!);
        }
        const y = alloc(`${inst.id}:y`, 1);
        pinDir.set(`${inst.id}:y`, 'out');
        if (isRoot) ctx.rootPinNets.set(`${inst.id}:y`, y);
        ctx.drivers.push({ net: y[0], what: 'NAND', instId: inst.id, defId: def.id });
        if (ctx.gates.length >= MAX_GATES) {
          ctx.aborted = true;
          ctx.errors.push({ message: `circuit exceeds ${MAX_GATES.toLocaleString()} gates`, defId: def.id });
          break;
        }
        ctx.gates.push({ a: local.get(`${inst.id}:a`)![0], b: local.get(`${inst.id}:b`)![0], y: y[0] });
        continue;
      }

      const sig = primSignature(kind, inst.props);

      if (kind === 'IN' || kind === 'OUT') {
        const pinId = kind === 'IN' ? 'out' : 'in';
        const width = clampWidth(inst.props.width);
        const bound = boundary?.get(inst.id);
        if (bound) {
          local.set(`${inst.id}:${pinId}`, bound);
        } else {
          const nets = alloc(`${inst.id}:${pinId}`, width);
          if (kind === 'IN') {
            ctx.rootInputs.set(inst.id, nets);
            ctx.inputs.push({
              nets, width, value: (inst.props.value ?? 0) >>> 0,
              path: inst.props.name ?? 'in', instId: inst.id, top: isRoot,
            });
            // A root input is driven externally (test bench or nothing).
            for (const n of nets) ctx.drivers.push({ net: n, what: 'input port', instId: inst.id, defId: def.id });
          } else {
            ctx.rootOutputs.set(inst.id, nets);
          }
        }
        pinDir.set(`${inst.id}:${pinId}`, kind === 'IN' ? 'out' : 'in');
        if (isRoot) ctx.rootPinNets.set(`${inst.id}:${pinId}`, local.get(`${inst.id}:${pinId}`)!);
        continue;
      }

      for (const pin of sig.inputs) pinDir.set(`${inst.id}:${pin.id}`, 'in');
      for (const pin of sig.outputs) pinDir.set(`${inst.id}:${pin.id}`, 'out');
      for (const pin of [...sig.inputs, ...sig.outputs]) {
        const nets = alloc(`${inst.id}:${pin.id}`, pin.width);
        if (isRoot) ctx.rootPinNets.set(`${inst.id}:${pin.id}`, nets);
      }
      for (const pin of sig.outputs) {
        for (const n of local.get(`${inst.id}:${pin.id}`)!) {
          ctx.drivers.push({ net: n, what: kind, instId: inst.id, defId: def.id });
        }
      }

      const nodePath = joinPath(path, labelFor(inst, kind, labelCounts));
      registerPrimitive(ctx, inst, kind, local, nodePath, isRoot, def.id);
      continue;
    }

    const childDef = ctx.defIndex.get(inst.def);
    if (!childDef) {
      ctx.errors.push({ message: `missing component used in "${def.name}"`, defId: def.id, instId: inst.id });
      continue;
    }
    const sig = userSig(ctx, inst.def);
    for (const pin of sig.inputs) pinDir.set(`${inst.id}:${pin.id}`, 'in');
    for (const pin of sig.outputs) pinDir.set(`${inst.id}:${pin.id}`, 'out');
    const childBoundary = new Map<Id, number[]>();
    for (const pin of [...sig.inputs, ...sig.outputs]) {
      const nets = alloc(`${inst.id}:${pin.id}`, pin.width);
      childBoundary.set(pin.id, nets);
      if (isRoot) ctx.rootPinNets.set(`${inst.id}:${pin.id}`, nets);
    }
    children.push({
      inst, def: childDef, boundary: childBoundary,
      path: joinPath(path, labelFor(inst, childDef.name, labelCounts)),
    });
  }

  // Wires: union the bits on each side. Everything downstream reads the
  // union-find root, so wire order does not matter.
  for (const w of def.wires) {
    const fromKey = `${w.from.inst}:${w.from.pin}`;
    const toKey = `${w.to.inst}:${w.to.pin}`;
    const fromNets = local.get(fromKey);
    const toNets = local.get(toKey);
    if (!fromNets || !toNets) {
      ctx.errors.push({ message: `dangling wire in "${def.name}"`, defId: def.id, wireId: w.id });
      continue;
    }
    if (pinDir.get(fromKey) !== 'out') {
      ctx.errors.push({ message: `wire in "${def.name}" starts at an input`, defId: def.id, wireId: w.id });
      continue;
    }
    if (pinDir.get(toKey) !== 'in') {
      ctx.errors.push({ message: `wire in "${def.name}" ends at an output`, defId: def.id, wireId: w.id });
      continue;
    }

    const n = w.from.hi - w.from.lo + 1;
    const m = w.to.hi - w.to.lo + 1;
    if (n !== m) {
      ctx.errors.push({
        message: `wire in "${def.name}" connects ${n} bit${n === 1 ? '' : 's'} to ${m}`,
        defId: def.id, wireId: w.id,
      });
      continue;
    }
    if (w.from.lo < 0 || w.from.hi >= fromNets.length || w.to.lo < 0 || w.to.hi >= toNets.length) {
      ctx.errors.push({ message: `wire in "${def.name}" addresses bits outside the pin`, defId: def.id, wireId: w.id });
      continue;
    }
    for (let i = 0; i < n; i++) ctx.uf.union(fromNets[w.from.lo + i], toNets[w.to.lo + i]);
  }

  for (const child of children) {
    flattenDef(child.def, child.boundary, child.path, ctx, stack, false);
  }

  stack.delete(def.id);
}

function registerPrimitive(
  ctx: Ctx, inst: Instance, kind: ReturnType<typeof primKind>,
  local: Map<string, number[]>, path: string, top: boolean, defId: Id,
) {
  const nets = (pin: string) => local.get(`${inst.id}:${pin}`) ?? [];
  switch (kind) {
    case 'CLOCK': {
      const period = Math.max(2, Math.floor(inst.props.period ?? 16));
      ctx.clocks.push({ net: nets('clk')[0], period, path, instId: inst.id, top });
      break;
    }
    case 'CONST': {
      const width = clampWidth(inst.props.width);
      // `>>> 0` reinterprets a negative as its 32-bit two's complement, and
      // taking the low `width` bits of that is exactly the two's complement in
      // `width` bits. So -1 drives every wire high whatever the width is.
      const value = (inst.props.value ?? 0) >>> 0;
      const out = nets('out');
      for (let i = 0; i < width; i++) ctx.consts.push({ net: out[i], value: (value >>> i) & 1 });
      break;
    }
    case 'PROBE': {
      ctx.probes.push({
        nets: nets('in'), width: clampWidth(inst.props.width),
        format: inst.props.format ?? 'hex', path, instId: inst.id, top,
      });
      break;
    }
    case 'ROM':
    case 'RAM':
    case 'SCREEN': {
      // A screen sizes its own memory from its pixels, so there is no address
      // width to get wrong -- and no initial contents: it boots black.
      const isScreen = kind === 'SCREEN';
      const addrWidth = isScreen ? screenAddrWidth(inst.props) : clampWidth(inst.props.addrWidth, 8);
      const dataWidth = isScreen ? 16 : clampWidth(inst.props.dataWidth, 16);
      if (addrWidth > 20) {
        ctx.errors.push({
          message: `${kind} address width ${addrWidth} exceeds the ${MAX_MEM_WORDS.toLocaleString()}-word limit`,
          defId, instId: inst.id,
        });
        return;
      }
      const writable = kind !== 'ROM';
      ctx.mems.push({
        kind,
        addr: nets('addr'),
        data: nets(kind === 'ROM' ? 'data' : 'out'),
        din: writable ? nets('in') : [],
        load: writable ? nets('load')[0] : -1,
        clk: writable ? nets('clk')[0] : -1,
        addrWidth, dataWidth,
        contents: isScreen ? [] : (inst.props.contents ?? []),
        path, instId: inst.id, top,
      });
      break;
    }
    default:
      break;
  }
}

function labelFor(inst: Instance, fallback: string, counts: Map<string, number>): string {
  const base = inst.props.name || fallback;
  const n = (counts.get(base) ?? 0) + 1;
  counts.set(base, n);
  return n === 1 ? base : `${base}#${n}`;
}

function joinPath(path: string, label: string): string {
  return path ? `${path}/${label}` : label;
}

/* ------------------------------------------------------------------ *
 * Finalise: resolve union-find roots to dense net indices
 * ------------------------------------------------------------------ */

function finalize(ctx: Ctx, rootSignature: Signature): Netlist {
  const dense = new Int32Array(ctx.uf.size).fill(-1);
  let netCount = 0;
  const resolve = (raw: number): number => {
    const root = ctx.uf.find(raw);
    if (dense[root] === -1) dense[root] = netCount++;
    return dense[root];
  };
  const resolveAll = (raws: number[]): number[] => raws.map(resolve);

  const gateCount = ctx.gates.length;
  const gA = new Int32Array(gateCount);
  const gB = new Int32Array(gateCount);
  const gY = new Int32Array(gateCount);
  for (let i = 0; i < gateCount; i++) {
    gA[i] = resolve(ctx.gates[i].a);
    gB[i] = resolve(ctx.gates[i].b);
    gY[i] = resolve(ctx.gates[i].y);
  }

  // Multiple drivers on one net is a hard error: it is almost always a
  // mis-drawn wire, and the simulator has no notion of contention.
  const byNet = new Map<number, RawDriver[]>();
  for (const d of ctx.drivers) {
    const net = resolve(d.net);
    const list = byNet.get(net);
    if (list) list.push(d); else byNet.set(net, [d]);
  }
  const reported = new Set<string>();
  for (const [, list] of byNet) {
    if (list.length < 2) continue;
    const key = list.map((d) => d.instId).sort().join('|');
    if (reported.has(key)) continue;
    reported.add(key);
    ctx.errors.push({
      message: `net driven by ${list.length} sources (${list.map((d) => d.what).join(', ')})`,
      defId: list[0].defId, instId: list[0].instId,
    });
  }

  const constNets = new Int32Array(ctx.consts.length);
  const constVals = new Uint8Array(ctx.consts.length);
  ctx.consts.forEach((c, i) => { constNets[i] = resolve(c.net); constVals[i] = c.value; });

  for (const c of ctx.clocks) c.net = resolve(c.net);
  for (const t of ctx.inputs) t.nets = resolveAll(t.nets);
  for (const p of ctx.probes) p.nets = resolveAll(p.nets);
  for (const m of ctx.mems) {
    m.addr = resolveAll(m.addr);
    m.data = resolveAll(m.data);
    m.din = resolveAll(m.din);
    if (m.load >= 0) m.load = resolve(m.load);
    if (m.clk >= 0) m.clk = resolve(m.clk);
  }
  const rootInputs = new Map<Id, number[]>();
  for (const [k, v] of ctx.rootInputs) rootInputs.set(k, resolveAll(v));
  const rootOutputs = new Map<Id, number[]>();
  for (const [k, v] of ctx.rootOutputs) rootOutputs.set(k, resolveAll(v));
  const rootPinNets = new Map<string, number[]>();
  for (const [k, v] of ctx.rootPinNets) rootPinNets.set(k, resolveAll(v));

  // CSR fan-out index: net -> gates that read it. A gate with both inputs on
  // one net -- every inverter built from a NAND -- is listed once, so the
  // count has to skip the duplicate exactly as the fill below does. Counting
  // it twice would leave an unwritten slot, and an unwritten slot reads as
  // gate 0 and wakes it for no reason.
  const counts = new Int32Array(netCount + 1);
  for (let i = 0; i < gateCount; i++) {
    counts[gA[i]]++;
    if (gB[i] !== gA[i]) counts[gB[i]]++;
  }
  const fanoutStart = new Int32Array(netCount + 1);
  let acc = 0;
  for (let n = 0; n < netCount; n++) { fanoutStart[n] = acc; acc += counts[n]; }
  fanoutStart[netCount] = acc;
  const cursor = fanoutStart.slice(0, netCount);
  const fanout = new Int32Array(acc);
  for (let i = 0; i < gateCount; i++) {
    fanout[cursor[gA[i]]++] = i;
    if (gB[i] !== gA[i]) fanout[cursor[gB[i]]++] = i;
  }

  return {
    netCount, gateCount, gA, gB, gY,
    constNets, constVals,
    clocks: ctx.clocks, inputs: ctx.inputs, probes: ctx.probes, mems: ctx.mems,
    rootInputs, rootOutputs, rootPinNets,
    fanoutStart, fanout,
    errors: ctx.errors,
    rootSignature,
  };
}

function emptyNetlist(errors: CompileError[]): Netlist {
  return {
    netCount: 0, gateCount: 0,
    gA: new Int32Array(0), gB: new Int32Array(0), gY: new Int32Array(0),
    constNets: new Int32Array(0), constVals: new Uint8Array(0),
    clocks: [], inputs: [], probes: [], mems: [],
    rootInputs: new Map(), rootOutputs: new Map(), rootPinNets: new Map(),
    fanoutStart: new Int32Array(1), fanout: new Int32Array(0),
    errors, rootSignature: { inputs: [], outputs: [] },
  };
}

/** Convenience for tests and the UI: does this pin exist on this instance? */
export function hasPin(P: Project, def: ComponentDef, instId: Id, pinId: Id): boolean {
  const inst = def.instances.find((i) => i.id === instId);
  if (!inst) return false;
  return !!pinOf(defSignature(P, inst.def, inst.props), pinId);
}
