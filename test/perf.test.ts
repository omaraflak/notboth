import { describe, expect, it } from 'vitest';
import { compile, type Netlist } from '../src/core/compile';
import { Simulator } from '../src/core/sim';
import { newId } from '../src/core/ids';
import { addPrimitive, connect, createProject, defSignature, emptyDef } from '../src/core/project';
import { arrangeDef } from '../src/core/autolayout';
import { approxMeasure, layoutBox, planRoutes, type Obstacle, type WireGeom } from '../src/core/layout';
import { primLabel } from '../src/core/primitives';
import type { ComponentDef, Id, Project, Wire } from '../src/core/types';

/**
 * Performance and stress tests.
 *
 * These exist to catch *algorithmic* regressions, not to benchmark a machine.
 * Absolute milliseconds vary wildly between laptops and CI, so wherever
 * possible the assertion is about how a cost scales with size: an accidental
 * O(n^2) shows up as throughput collapsing between two sizes, while ordinary
 * machine-speed differences move both numbers together and change nothing.
 *
 * (The compiler really did go quadratic once, when the wire pass looked each
 * endpoint up with a linear scan. It took seven seconds to compile 20,000
 * gates. That is the class of bug this file is here to catch.)
 */

const report: string[] = [];

function note(line: string) {
  report.push(line);
}

function time<T>(fn: () => T): { value: T; ms: number } {
  const t0 = performance.now();
  const value = fn();
  return { value, ms: performance.now() - t0 };
}

/* ------------------------------------------------------------------ *
 * Circuit generators
 *
 * These build wires directly rather than through connect(), which resolves
 * pin widths with a scan. That is fine interactively -- a person draws one
 * wire at a time -- but it would make generating a 100,000-gate fixture
 * quadratic, and the fixture is not what we are measuring.
 * ------------------------------------------------------------------ */

interface Endpoint { inst: Id; pin: string }

function link(def: ComponentDef, from: Endpoint, to: Endpoint, bits = 1) {
  const w: Wire = {
    id: newId('w_'),
    from: { inst: from.inst, pin: from.pin, lo: 0, hi: bits - 1 },
    to: { inst: to.inst, pin: to.pin, lo: 0, hi: bits - 1 },
  };
  def.wires.push(w);
}

/** A toggle feeding a chain of `n` NAND inverters. Deep, narrow, always busy. */
function inverterChain(n: number) {
  const project = createProject();
  const def = emptyDef('Chain', null);
  project.defs.push(def);
  const src = addPrimitive(def, 'TOGGLE', 0, 0, { name: 'in', width: 1, value: 0 });
  let prev: Endpoint = { inst: src.id, pin: 'out' };
  for (let i = 0; i < n; i++) {
    const g = addPrimitive(def, 'NAND', i + 1, 0);
    link(def, prev, { inst: g.id, pin: 'a' });
    link(def, prev, { inst: g.id, pin: 'b' });
    prev = { inst: g.id, pin: 'y' };
  }
  const out = addPrimitive(def, 'OUT', n + 1, 0, { name: 'out', width: 1 });
  link(def, prev, { inst: out.id, pin: 'in' });
  return { project, def, srcId: src.id, outId: out.id };
}

/**
 * A chain driven by a clock that flips every single tick. In steady state the
 * chain holds alternating values and every gate changes on every tick, which
 * is the heaviest sustained load the engine can be given.
 */
function clockedChain(n: number) {
  const project = createProject();
  const def = emptyDef('Clocked', null);
  project.defs.push(def);
  const clk = addPrimitive(def, 'CLOCK', 0, 0, { period: 2 });
  let prev: Endpoint = { inst: clk.id, pin: 'clk' };
  for (let i = 0; i < n; i++) {
    const g = addPrimitive(def, 'NAND', i + 1, 0);
    link(def, prev, { inst: g.id, pin: 'a' });
    link(def, prev, { inst: g.id, pin: 'b' });
    prev = { inst: g.id, pin: 'y' };
  }
  return { project, def };
}

/** One toggle driving `n` independent gates: a pathological fan-out net. */
function fanOut(n: number) {
  const project = createProject();
  const def = emptyDef('FanOut', null);
  project.defs.push(def);
  const src = addPrimitive(def, 'TOGGLE', 0, 0, { name: 'in', width: 1, value: 0 });
  const sinks: Id[] = [];
  for (let i = 0; i < n; i++) {
    const g = addPrimitive(def, 'NAND', 2, i);
    link(def, { inst: src.id, pin: 'out' }, { inst: g.id, pin: 'a' });
    link(def, { inst: src.id, pin: 'out' }, { inst: g.id, pin: 'b' });
    sinks.push(g.id);
  }
  return { project, def, srcId: src.id, sinks };
}

/** `depth` components nested one inside the next, each holding an inverter. */
function nested(depth: number) {
  const project = createProject();
  const leaf = emptyDef('L0', null);
  project.defs.push(leaf);
  const li = addPrimitive(leaf, 'IN', 0, 0, { name: 'in', width: 1 });
  const lg = addPrimitive(leaf, 'NAND', 1, 0);
  const lo = addPrimitive(leaf, 'OUT', 2, 1, { name: 'out', width: 1 });
  link(leaf, { inst: li.id, pin: 'out' }, { inst: lg.id, pin: 'a' });
  link(leaf, { inst: li.id, pin: 'out' }, { inst: lg.id, pin: 'b' });
  link(leaf, { inst: lg.id, pin: 'y' }, { inst: lo.id, pin: 'in' });

  let inner = leaf;
  let innerIn = li.id;
  let innerOut = lo.id;
  for (let d = 1; d <= depth; d++) {
    const wrap = emptyDef(`L${d}`, null);
    project.defs.push(wrap);
    const wi = addPrimitive(wrap, 'IN', 0, 0, { name: 'in', width: 1 });
    const wg = addPrimitive(wrap, 'NAND', 1, 0);
    const child = { id: newId('i_'), def: inner.id, x: 2, y: 0, props: {} };
    wrap.instances.push(child);
    const wo = addPrimitive(wrap, 'OUT', 3, 1, { name: 'out', width: 1 });
    link(wrap, { inst: wi.id, pin: 'out' }, { inst: wg.id, pin: 'a' });
    link(wrap, { inst: wi.id, pin: 'out' }, { inst: wg.id, pin: 'b' });
    link(wrap, { inst: wg.id, pin: 'y' }, { inst: child.id, pin: innerIn });
    link(wrap, { inst: child.id, pin: innerOut }, { inst: wo.id, pin: 'in' });
    inner = wrap;
    innerIn = wi.id;
    innerOut = wo.id;
  }
  return { project, top: inner, inId: innerIn, outId: innerOut };
}

/** `count` instances of one small component, side by side. */
function manyInstances(count: number) {
  const project = createProject();
  const leaf = emptyDef('Inv', null);
  project.defs.push(leaf);
  const li = addPrimitive(leaf, 'IN', 0, 0, { name: 'in', width: 1 });
  const lg = addPrimitive(leaf, 'NAND', 1, 0);
  const lo = addPrimitive(leaf, 'OUT', 2, 1, { name: 'out', width: 1 });
  link(leaf, { inst: li.id, pin: 'out' }, { inst: lg.id, pin: 'a' });
  link(leaf, { inst: li.id, pin: 'out' }, { inst: lg.id, pin: 'b' });
  link(leaf, { inst: lg.id, pin: 'y' }, { inst: lo.id, pin: 'in' });

  const top = emptyDef('Top', null);
  project.defs.push(top);
  const src = addPrimitive(top, 'TOGGLE', 0, 0, { name: 'in', width: 1, value: 0 });
  for (let i = 0; i < count; i++) {
    const inst = { id: newId('i_'), def: leaf.id, x: 2, y: i, props: {} };
    top.instances.push(inst);
    link(top, { inst: src.id, pin: 'out' }, { inst: inst.id, pin: li.id });
  }
  return { project, top, srcId: src.id };
}

/**
 * A shift register `bits` wide, built from real NAND feedback loops -- no DFF
 * primitive. Nine gates per bit, and every clock edge moves the whole thing.
 */
function shiftRegister(bits: number) {
  const project = createProject();

  // One master-slave D flip-flop, falling-edge triggered.
  const dff = emptyDef('DFF', null);
  project.defs.push(dff);
  const d = addPrimitive(dff, 'IN', 0, 0, { name: 'd', width: 1 });
  const clk = addPrimitive(dff, 'IN', 0, 1, { name: 'clk', width: 1 });
  const nclk = addPrimitive(dff, 'NAND', 1, 0);
  const m1 = addPrimitive(dff, 'NAND', 2, 0);
  const m2 = addPrimitive(dff, 'NAND', 3, 0);
  const mq = addPrimitive(dff, 'NAND', 4, 0);
  const mqb = addPrimitive(dff, 'NAND', 5, 0);
  const s1 = addPrimitive(dff, 'NAND', 6, 0);
  const s2 = addPrimitive(dff, 'NAND', 7, 0);
  const sq = addPrimitive(dff, 'NAND', 8, 0);
  const sqb = addPrimitive(dff, 'NAND', 9, 0);
  const q = addPrimitive(dff, 'OUT', 10, 9, { name: 'q', width: 1 });
  const e = (inst: { id: Id }, pin: string): Endpoint => ({ inst: inst.id, pin });
  link(dff, e(clk, 'out'), e(nclk, 'a'));
  link(dff, e(clk, 'out'), e(nclk, 'b'));
  link(dff, e(d, 'out'), e(m1, 'a'));
  link(dff, e(clk, 'out'), e(m1, 'b'));
  link(dff, e(m1, 'y'), e(m2, 'a'));
  link(dff, e(clk, 'out'), e(m2, 'b'));
  link(dff, e(m1, 'y'), e(mq, 'a'));
  link(dff, e(mqb, 'y'), e(mq, 'b'));
  link(dff, e(m2, 'y'), e(mqb, 'a'));
  link(dff, e(mq, 'y'), e(mqb, 'b'));
  link(dff, e(mq, 'y'), e(s1, 'a'));
  link(dff, e(nclk, 'y'), e(s1, 'b'));
  link(dff, e(s1, 'y'), e(s2, 'a'));
  link(dff, e(nclk, 'y'), e(s2, 'b'));
  link(dff, e(s1, 'y'), e(sq, 'a'));
  link(dff, e(sqb, 'y'), e(sq, 'b'));
  link(dff, e(s2, 'y'), e(sqb, 'a'));
  link(dff, e(sq, 'y'), e(sqb, 'b'));
  link(dff, e(sq, 'y'), e(q, 'in'));

  const top = emptyDef('Shift', null);
  project.defs.push(top);
  const din = addPrimitive(top, 'TOGGLE', 0, 0, { name: 'din', width: 1, value: 1 });
  const clock = addPrimitive(top, 'TOGGLE', 0, 1, { name: 'clk', width: 1, value: 0 });
  const out = addPrimitive(top, 'OUT', 99, 99, { name: 'out', width: 1 });
  let prev: Endpoint = { inst: din.id, pin: 'out' };
  for (let i = 0; i < bits; i++) {
    const cell = { id: newId('i_'), def: dff.id, x: 2 + i, y: 0, props: {} };
    top.instances.push(cell);
    link(top, prev, { inst: cell.id, pin: d.id });
    link(top, { inst: clock.id, pin: 'out' }, { inst: cell.id, pin: clk.id });
    prev = { inst: cell.id, pin: q.id };
  }
  link(top, prev, { inst: out.id, pin: 'in' });
  return { project, top, outId: out.id };
}

function netlistBytes(nl: Netlist): number {
  return nl.gA.byteLength + nl.gB.byteLength + nl.gY.byteLength
    + nl.fanout.byteLength + nl.fanoutStart.byteLength
    + nl.constNets.byteLength + nl.constVals.byteLength;
}

function compileTop(project: Project, def: ComponentDef) {
  const nl = compile(project, def.id);
  expect(nl.errors).toEqual([]);
  return nl;
}

/* ================================================================== *
 * Compiler
 * ================================================================== */

describe('compiler performance', () => {
  it('compiles in time proportional to circuit size, not its square', () => {
    // Two sizes an order of magnitude apart. Linear work keeps throughput
    // roughly flat; quadratic work makes the larger one collapse.
    const small = inverterChain(3_000);
    const large = inverterChain(60_000);

    compile(small.project, small.def.id); // warm the JIT
    const a = time(() => compileTop(small.project, small.def));
    const b = time(() => compileTop(large.project, large.def));

    const smallRate = a.value.gateCount / Math.max(a.ms, 0.01);
    const largeRate = b.value.gateCount / Math.max(b.ms, 0.01);
    note(`compile     ${a.value.gateCount.toLocaleString()} gates in ${a.ms.toFixed(0)}ms `
      + `(${smallRate.toFixed(0)}/ms) -> ${b.value.gateCount.toLocaleString()} gates in `
      + `${b.ms.toFixed(0)}ms (${largeRate.toFixed(0)}/ms)`);

    expect(b.value.gateCount).toBe(60_000);
    // A 20x jump in size must not cost more than ~4x the per-gate time.
    expect(largeRate).toBeGreaterThan(smallRate / 4);
    expect(b.ms).toBeLessThan(4_000);
  }, 60_000);

  it('handles a net with tens of thousands of readers', () => {
    const { project, def } = fanOut(40_000);
    const { value: nl, ms } = time(() => compileTop(project, def));
    note(`fan-out     one net read by ${(nl.fanout.length).toLocaleString()} gate inputs, compiled in ${ms.toFixed(0)}ms`);
    expect(nl.gateCount).toBe(40_000);
    // Every gate reads the same net from both inputs; the CSR index dedupes
    // the self-pair only, so the adjacency list is one entry per gate input.
    expect(ms).toBeLessThan(3_000);
  }, 60_000);

  it('flattens deep hierarchies without recursing off a cliff', () => {
    const depth = 400;
    const inversions = depth + 1;
    const { project, top, inId, outId } = nested(depth);
    const { value: nl, ms } = time(() => compileTop(project, top));
    note(`hierarchy   ${depth} levels deep flattened to ${nl.gateCount} gates in ${ms.toFixed(0)}ms`);
    expect(nl.gateCount).toBe(inversions);

    // Flattening 400 levels is only worth anything if the result still
    // computes: an odd number of inversions must invert.
    const sim = new Simulator(nl);
    sim.writeNets(nl.rootInputs.get(inId)!, 1);
    expect(sim.settle(50_000)).toBe(true);
    expect(sim.readNets(nl.rootOutputs.get(outId)!)).toBe(inversions % 2 === 0 ? 1 : 0);
  }, 60_000);

  it('scales with many instances of one definition', () => {
    const count = 20_000;
    const { project, top } = manyInstances(count);
    const { value: nl, ms } = time(() => compileTop(project, top));
    note(`instances   ${count.toLocaleString()} copies of one component in ${ms.toFixed(0)}ms`);
    expect(nl.gateCount).toBe(count);
    expect(ms).toBeLessThan(4_000);
  }, 60_000);

  it('keeps the netlist compact in memory', () => {
    const { project, def } = inverterChain(50_000);
    const nl = compileTop(project, def);
    const bytesPerGate = netlistBytes(nl) / nl.gateCount;
    note(`footprint   ${bytesPerGate.toFixed(1)} bytes per gate `
      + `(${(netlistBytes(nl) / 1024 / 1024).toFixed(1)} MB for ${nl.gateCount.toLocaleString()} gates)`);
    // Typed arrays only: three int32 indices per gate plus the fan-out index.
    expect(bytesPerGate).toBeLessThan(48);
  }, 60_000);
});

/* ================================================================== *
 * Simulator
 * ================================================================== */

describe('simulator throughput', () => {
  it('sustains millions of gate updates per second under full activity', () => {
    const N = 5_000;
    const { project, def } = clockedChain(N);
    const nl = compileTop(project, def);
    const sim = new Simulator(nl);

    // Run past the initial settling wave so the chain is in steady state,
    // where every gate genuinely flips on every tick.
    sim.run(N + 100);

    const TICKS = 20_000;
    const { ms } = time(() => sim.run(TICKS));
    const updatesPerSec = (TICKS * N) / (ms / 1000);
    note(`throughput  ${(updatesPerSec / 1e6).toFixed(1)}M gate-updates/sec `
      + `(${N.toLocaleString()} gates all flipping, ${TICKS.toLocaleString()} ticks in ${ms.toFixed(0)}ms)`);
    expect(updatesPerSec).toBeGreaterThan(3e6);
  }, 60_000);

  /**
   * The central architectural claim: work is proportional to activity, not to
   * circuit size. A large but quiescent machine must cost nothing per tick.
   */
  it('charges nothing for gates whose inputs did not move', () => {
    // Wide and shallow on purpose. A deep chain would spend its whole settle
    // in a propagating wavefront, which measures the wrong thing; here 50,000
    // gates go quiet in two ticks and stay quiet.
    const { project, def } = fanOut(50_000);
    const nl = compileTop(project, def);
    const sim = new Simulator(nl);
    expect(sim.settle(1_000)).toBe(true);
    expect(sim.busy).toBe(false);

    const TICKS = 500_000;
    const { ms } = time(() => sim.run(TICKS));
    const perTick = (ms * 1e6) / TICKS;
    note(`idle cost   ${perTick.toFixed(0)} ns/tick with ${nl.gateCount.toLocaleString()} settled gates`);
    expect(ms).toBeLessThan(500);
  }, 60_000);

  it('propagates a change across a huge fan-out in a single tick', () => {
    const { project, def, sinks } = fanOut(40_000);
    const nl = compileTop(project, def);
    const sim = new Simulator(nl);
    sim.settle(100);

    const { ms } = time(() => {
      sim.setToggle(0, 1);
      sim.step(true);
    });
    note(`fan-out sim one net waking ${sinks.length.toLocaleString()} gates in ${ms.toFixed(1)}ms`);

    // Uniform delay means all 40,000 gates flip together, on the same tick --
    // not spread over 40,000 of them.
    let flipped = 0;
    for (let g = 0; g < nl.gateCount; g++) if (sim.net[nl.gY[g]] === 0) flipped++;
    expect(flipped).toBe(nl.gateCount);
    expect(ms).toBeLessThan(200);
  }, 60_000);

  it('clocks hundreds of NAND-built flip-flops', () => {
    const BITS = 200;
    const { project, top, outId } = shiftRegister(BITS);
    const nl = compileTop(project, top);
    expect(nl.gateCount).toBe(BITS * 9);

    const sim = new Simulator(nl);
    const [DIN, CLK] = [0, 1];
    const OUT = nl.rootOutputs.get(outId)!;

    // A fixed number of ticks per phase rather than settle(): at power-on a
    // NAND-built latch is genuinely metastable -- both cross-coupled gates see
    // the same inputs -- and only a clock edge breaks the symmetry, one stage
    // per cycle. Waiting for quiescence would mean waiting for a circuit that
    // is correctly refusing to settle.
    const pulse = () => {
      sim.setToggle(CLK, 1);
      sim.run(60, true);
      sim.setToggle(CLK, 0);
      sim.run(60, true);
    };

    // Flush zeros through: this also resolves every latch, front to back.
    sim.setToggle(DIN, 0);
    for (let i = 0; i < BITS + 4; i++) pulse();
    expect(sim.readNets(OUT)).toBe(0);

    // Now push a single 1 the whole length of the register.
    sim.setToggle(DIN, 1);
    const { ms } = time(() => {
      for (let i = 0; i < BITS - 1; i++) pulse();
    });
    note(`sequential  ${BITS} NAND-built flip-flops (${nl.gateCount.toLocaleString()} gates), `
      + `${BITS - 1} clock cycles in ${ms.toFixed(0)}ms`);

    // Not there yet after BITS-1 cycles...
    expect(sim.readNets(OUT)).toBe(0);
    pulse();
    // ...and exactly one cycle later it arrives.
    expect(sim.readNets(OUT)).toBe(1);
    expect(ms).toBeLessThan(15_000);
  }, 120_000);
});

/* ================================================================== *
 * Memory primitives
 * ================================================================== */

describe('memory under load', () => {
  it('handles a 64K-word RAM without choking', () => {
    const project = createProject();
    const def = emptyDef('BigRam', null);
    project.defs.push(def);
    const addr = addPrimitive(def, 'TOGGLE', 0, 0, { name: 'addr', width: 16, value: 0 });
    const din = addPrimitive(def, 'TOGGLE', 0, 1, { name: 'din', width: 16, value: 0 });
    const load = addPrimitive(def, 'TOGGLE', 0, 2, { name: 'load', width: 1, value: 0 });
    const clk = addPrimitive(def, 'TOGGLE', 0, 3, { name: 'clk', width: 1, value: 0 });
    const ram = addPrimitive(def, 'RAM', 2, 0, { addrWidth: 16, dataWidth: 16 });
    const out = addPrimitive(def, 'OUT', 4, 9, { name: 'out', width: 16 });
    link(def, { inst: addr.id, pin: 'out' }, { inst: ram.id, pin: 'addr' }, 16);
    link(def, { inst: din.id, pin: 'out' }, { inst: ram.id, pin: 'in' }, 16);
    link(def, { inst: load.id, pin: 'out' }, { inst: ram.id, pin: 'load' });
    link(def, { inst: clk.id, pin: 'out' }, { inst: ram.id, pin: 'clk' });
    link(def, { inst: ram.id, pin: 'out' }, { inst: out.id, pin: 'in' }, 16);

    const nl = compileTop(project, def);
    const sim = new Simulator(nl);
    const [ADDR, DIN, LOAD, CLK] = [0, 1, 2, 3];
    const O = nl.rootOutputs.get(out.id)!;

    const WRITES = 2_000;
    const { ms } = time(() => {
      sim.setToggle(LOAD, 1);
      for (let i = 0; i < WRITES; i++) {
        sim.setToggle(ADDR, i * 31 & 0xffff);
        sim.setToggle(DIN, (i * 2654435761) & 0xffff);
        sim.setToggle(CLK, 0);
        sim.settle(64);
        sim.setToggle(CLK, 1);
        sim.settle(64);
      }
      sim.setToggle(LOAD, 0);
    });
    note(`memory      ${WRITES.toLocaleString()} clocked writes into a 65,536-word RAM in ${ms.toFixed(0)}ms`);

    // Spot-check that everything actually landed where it should have.
    for (const i of [0, 1, 7, 500, 1_999]) {
      sim.setToggle(ADDR, i * 31 & 0xffff);
      sim.settle(64);
      expect(sim.readNets(O)).toBe((i * 2654435761) & 0xffff);
    }
    expect(ms).toBeLessThan(5_000);
  }, 60_000);

  it('refuses a memory too large to allocate instead of trying', () => {
    const project = createProject();
    const def = emptyDef('Absurd', null);
    project.defs.push(def);
    addPrimitive(def, 'ROM', 0, 0, { addrWidth: 30, dataWidth: 16 });
    const nl = compile(project, def.id);
    expect(nl.errors.some((e) => /exceeds/.test(e.message))).toBe(true);
  });
});

/* ================================================================== *
 * Pathological circuits
 * ================================================================== */

describe('degenerate circuits', () => {
  it('bounds an oscillating circuit instead of hanging', () => {
    // A ring of an odd number of inverters never settles; it is a ring
    // oscillator. settle() must give up rather than spin forever.
    const project = createProject();
    const def = emptyDef('Ring', null);
    project.defs.push(def);
    const gates = Array.from({ length: 1_001 }, (_, i) => addPrimitive(def, 'NAND', i, 0));
    for (let i = 0; i < gates.length; i++) {
      const prev = gates[(i + gates.length - 1) % gates.length];
      link(def, { inst: prev.id, pin: 'y' }, { inst: gates[i].id, pin: 'a' });
      link(def, { inst: prev.id, pin: 'y' }, { inst: gates[i].id, pin: 'b' });
    }
    const nl = compileTop(project, def);
    const sim = new Simulator(nl);
    const { value: stable, ms } = time(() => sim.settle(20_000));
    note(`oscillator  ${nl.gateCount.toLocaleString()}-gate ring gave up after 20,000 ticks in ${ms.toFixed(0)}ms`);
    expect(stable).toBe(false);
    expect(sim.unstable).toBe(true);
    expect(ms).toBeLessThan(3_000);
  }, 60_000);

  it('survives a circuit that is entirely unconnected', () => {
    const project = createProject();
    const def = emptyDef('Loose', null);
    project.defs.push(def);
    for (let i = 0; i < 20_000; i++) addPrimitive(def, 'NAND', i, 0);
    const { value: nl, ms } = time(() => compileTop(project, def));
    const sim = new Simulator(nl);
    sim.settle(100);
    note(`unwired     ${nl.gateCount.toLocaleString()} unconnected gates compiled in ${ms.toFixed(0)}ms`);
    expect(nl.netCount).toBe(20_000 * 3);
    expect(sim.busy).toBe(false);
  }, 60_000);

  it('recompiles quickly enough to keep the editor responsive', () => {
    // The editor recompiles after every edit. At the scale of a real CPU
    // (well under 20,000 gates) that has to be imperceptible.
    const { project, def } = inverterChain(10_000);
    compile(project, def.id);
    let worst = 0;
    for (let i = 0; i < 5; i++) {
      const { ms } = time(() => compile(project, def.id));
      worst = Math.max(worst, ms);
    }
    note(`edit loop   worst of 5 recompiles of a 10,000-gate circuit: ${worst.toFixed(0)}ms`);
    expect(worst).toBeLessThan(400);
  }, 60_000);
});

/** Route a whole component the way the canvas does, boxes and all. */
function routeAll(project: Project, def: ComponentDef) {
  const placed = new Map(def.instances.map((i) => [i.id,
    { inst: i, box: layoutBox(defSignature(project, i.def, i.props), primLabel(i), approxMeasure) }]));
  const obstacles: Obstacle[] = [...placed.values()].map((p) => ({
    id: p.inst.id,
    x0: p.inst.x, y0: p.inst.y,
    x1: p.inst.x + p.box.w, y1: p.inst.y + p.box.h,
  }));
  const geoms: WireGeom[] = [];
  for (const w of def.wires) {
    const a = placed.get(w.from.inst);
    const b = placed.get(w.to.inst);
    const pa = a?.box.pins.find((x) => x.pin.id === w.from.pin);
    const pb = b?.box.pins.find((x) => x.pin.id === w.to.pin);
    if (!a || !b || !pa || !pb) continue;
    geoms.push({
      id: w.id,
      net: `${w.from.inst}:${w.from.pin}:${w.from.lo}-${w.from.hi}`,
      from: { x: a.inst.x + pa.x, y: a.inst.y + pa.y },
      to: { x: b.inst.x + pb.x, y: b.inst.y + pb.y },
      fromInst: w.from.inst,
      toInst: w.to.inst,
    });
  }
  return planRoutes(geoms, obstacles);
}

describe('schematic layout', () => {
  it('arranges and routes a large schematic without going quadratic', () => {
    // Many small circuits stacked in the same few columns: the shape that
    // makes every wire compete for the same space between two columns.
    const build = (n: number) => {
      const project = createProject('perf');
      const def = project.defs[0];
      for (let i = 0; i < n; i++) {
        const a = addPrimitive(def, 'IN', 0, i * 5, { name: `a${i}`, width: 1 });
        const g = addPrimitive(def, 'NAND', 0, i * 5);
        const h = addPrimitive(def, 'NAND', 0, i * 5);
        const o = addPrimitive(def, 'OUT', 0, i * 5, { name: `o${i}`, width: 1 });
        connect(project, def, { inst: a.id, pin: 'out' }, { inst: g.id, pin: 'a' });
        connect(project, def, { inst: a.id, pin: 'out' }, { inst: g.id, pin: 'b' });
        connect(project, def, { inst: g.id, pin: 'y' }, { inst: h.id, pin: 'a' });
        connect(project, def, { inst: g.id, pin: 'y' }, { inst: h.id, pin: 'b' });
        connect(project, def, { inst: h.id, pin: 'y' }, { inst: o.id, pin: 'in' });
      }
      return { project, def };
    };

    const run = (n: number) => {
      const { project, def } = build(n);
      const a = time(() => arrangeDef(project, def));
      const r = time(() => routeAll(project, def));
      return { parts: def.instances.length, ms: a.ms + r.ms, arrange: a.ms, route: r.ms };
    };

    const small = run(50);
    const large = run(200);
    note(`layout      ${large.parts} parts: arrange ${large.arrange.toFixed(0)}ms,`
      + ` route ${large.route.toFixed(0)}ms`);

    // Four times the parts must not cost anything like sixteen times the work.
    expect((large.ms + 1) / (small.ms + 1)).toBeLessThan(10);
    expect(large.ms).toBeLessThan(1500);
  });
});

describe('summary', () => {
  it('prints the measurements', () => {
    console.log('\n' + report.map((r) => '  ' + r).join('\n') + '\n');
    expect(report.length).toBeGreaterThan(0);
  });
});
