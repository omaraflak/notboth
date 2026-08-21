import { describe, expect, it } from 'vitest';
import { Builder, defineAnd, defineNot, pinId } from './helpers';
import { Simulator } from '../src/core/sim';
import { compile } from '../src/core/compile';
import { runTests } from '../src/core/testbench';
import {
  createProject, previewReplace, replaceAllUses, usageCount, wouldRecurse,
  emptyDef, addPrimitive, connect, signatureOf, deleteDef, uniqueName, movePort,
} from '../src/core/project';

/* ------------------------------------------------------------------ *
 * The one true gate
 * ------------------------------------------------------------------ */

describe('NAND', () => {
  it('implements the truth table', () => {
    const b = new Builder();
    const a = b.prim('IN', { name: 'a' }, 0);
    const bb = b.prim('IN', { name: 'b' }, 1);
    const g = b.prim('NAND', {}, 2);
    const out = b.prim('OUT', { name: 'y' }, 3);
    b.wire([a, 'out'], [g, 'a']);
    b.wire([bb, 'out'], [g, 'b']);
    b.wire([g, 'y'], [out, 'in']);

    const { sim, nl } = b.sim();
    const A = nl.rootInputs.get(a)!;
    const B = nl.rootInputs.get(bb)!;
    const Y = nl.rootOutputs.get(out)!;

    for (const [x, y, want] of [[0, 0, 1], [0, 1, 1], [1, 0, 1], [1, 1, 0]]) {
      sim.writeNets(A, x);
      sim.writeNets(B, y);
      expect(sim.settle()).toBe(true);
      expect(sim.readNets(Y)).toBe(want);
    }
  });

  it('lists a shared input net once in the fan-out index', () => {
    // An inverter feeds one net to both NAND inputs. Reserving two slots and
    // filling one leaves a zero behind, which reads as gate 0 and wakes it.
    const b = new Builder();
    const a = b.prim('IN', { name: 'a' }, 0);
    const g = b.prim('NAND', {}, 1);
    const out = b.prim('OUT', { name: 'y' }, 2);
    b.wire([a, 'out'], [g, 'a']);
    b.wire([a, 'out'], [g, 'b']);
    b.wire([g, 'y'], [out, 'in']);

    const nl = b.compile();
    expect(nl.gateCount).toBe(1);
    expect(nl.fanout.length).toBe(1);
    expect(nl.fanout[0]).toBe(0);
  });

  it('costs exactly one gate and one tick of delay', () => {
    const b = new Builder();
    const a = b.prim('IN', { name: 'a' }, 0);
    const g = b.prim('NAND', {}, 1);
    const out = b.prim('OUT', { name: 'y' }, 2);
    b.wire([a, 'out'], [g, 'a']);
    b.wire([a, 'out'], [g, 'b']);
    b.wire([g, 'y'], [out, 'in']);

    const nl = b.compile();
    expect(nl.gateCount).toBe(1);

    const sim = new Simulator(nl);
    sim.settle();
    const Y = nl.rootOutputs.get(out)!;
    expect(sim.readNets(Y)).toBe(1); // NOT 0

    sim.writeNets(nl.rootInputs.get(a)!, 1);
    expect(sim.readNets(Y)).toBe(1); // not yet: one tick of delay
    sim.step(true);
    expect(sim.readNets(Y)).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Hierarchy
 * ------------------------------------------------------------------ */

describe('hierarchical components', () => {
  it('flattens nested definitions down to NAND gates', () => {
    const b = new Builder();
    defineNot(b);
    defineAnd(b);

    const nl = b.compile('And');
    expect(nl.gateCount).toBe(2); // one NAND + the NOT's single NAND

    const sim = new Simulator(nl);
    const A = nl.rootInputs.get(pinId(b.project, 'And', 'a'))!;
    const B = nl.rootInputs.get(pinId(b.project, 'And', 'b'))!;
    const Y = nl.rootOutputs.get(pinId(b.project, 'And', 'out'))!;

    for (const [x, y, want] of [[0, 0, 0], [0, 1, 0], [1, 0, 0], [1, 1, 1]]) {
      sim.writeNets(A, x);
      sim.writeNets(B, y);
      expect(sim.settle()).toBe(true);
      expect(sim.readNets(Y)).toBe(want);
    }
  });

  it('takes pin order from the port markers, not from where they sit', () => {
    // Layout is layout. Dragging a marker across the canvas must not silently
    // rewrite the component's interface.
    const b = new Builder();
    b.prim('IN', { name: 'first' }, 9);
    b.prim('IN', { name: 'second' }, 1);
    b.prim('OUT', { name: 'result' }, 5);
    const sig = signatureOf(b.def);
    expect(sig.inputs.map((p) => p.name)).toEqual(['first', 'second']);
    expect(sig.outputs.map((p) => p.name)).toEqual(['result']);
  });

  it('reorders pins on request, without touching the canvas', () => {
    const b = new Builder();
    const first = b.prim('IN', { name: 'first' }, 0);
    b.prim('IN', { name: 'second' }, 4);
    b.prim('OUT', { name: 'result' }, 8);
    const before = new Map(b.def.instances.map((i) => [i.id, `${i.x},${i.y}`]));

    expect(movePort(b.def, first, 1)).toBe(true);
    expect(signatureOf(b.def).inputs.map((p) => p.name)).toEqual(['second', 'first']);
    // Every marker is still exactly where it was; only the list order changed.
    for (const inst of b.def.instances) expect(`${inst.x},${inst.y}`).toBe(before.get(inst.id));

    // Outputs are ordered independently, and the ends clamp.
    expect(movePort(b.def, first, 1)).toBe(false);
    expect(signatureOf(b.def).outputs.map((p) => p.name)).toEqual(['result']);
  });

  it('reuses one definition across many instances', () => {
    const b = new Builder();
    defineNot(b);
    b.newDef('Triple');
    const inp = b.prim('IN', { name: 'in' }, 0);
    const out = b.prim('OUT', { name: 'out' }, 9);
    const notIn = pinId(b.project, 'Not', 'in');
    const notOut = pinId(b.project, 'Not', 'out');
    let prev: [string, string] = [inp, 'out'];
    for (let i = 0; i < 3; i++) {
      const n = b.use('Not');
      b.wire(prev, [n, notIn]);
      prev = [n, notOut];
    }
    b.wire(prev, [out, 'in']);

    const nl = b.compile('Triple');
    expect(nl.gateCount).toBe(3);
    const sim = new Simulator(nl);
    sim.writeNets(nl.rootInputs.get(inp)!, 1);
    sim.settle();
    expect(sim.readNets(nl.rootOutputs.get(out)!)).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Buses and bit slicing
 * ------------------------------------------------------------------ */

describe('buses', () => {
  it('slices and recombines bits at wire endpoints', () => {
    const b = new Builder();
    const a = b.prim('IN', { name: 'a', width: 4 }, 0);
    const bb = b.prim('IN', { name: 'b', width: 4 }, 1);
    const out = b.prim('OUT', { name: 'out', width: 4 }, 2);
    b.wire([a, 'out', 0, 1], [out, 'in', 0, 1]);
    b.wire([bb, 'out', 2, 3], [out, 'in', 2, 3]);

    const { sim, nl } = b.sim();
    expect(nl.errors).toEqual([]);
    sim.writeNets(nl.rootInputs.get(a)!, 0b1010);
    sim.writeNets(nl.rootInputs.get(bb)!, 0b0110);
    sim.settle();
    expect(sim.readNets(nl.rootOutputs.get(out)!)).toBe(0b0110);
  });

  it('rejects a wire whose two ends are different widths', () => {
    const b = new Builder();
    const a = b.prim('IN', { name: 'a', width: 4 }, 0);
    const out = b.prim('OUT', { name: 'out', width: 2 }, 1);
    b.wire([a, 'out', 0, 3], [out, 'in', 0, 1]);
    const nl = b.compile();
    expect(nl.errors.length).toBe(1);
    expect(nl.errors[0].message).toMatch(/4 bits to 2/);
  });

  it('exists only in the editor: buses vanish into single-bit nets', () => {
    const b = new Builder();
    const a = b.prim('IN', { name: 'a', width: 8 }, 0);
    const out = b.prim('OUT', { name: 'out', width: 8 }, 1);
    b.wire([a, 'out'], [out, 'in']);
    const nl = b.compile();
    expect(nl.rootInputs.get(a)!.length).toBe(8);
  });
});

/* ------------------------------------------------------------------ *
 * Error detection
 * ------------------------------------------------------------------ */

describe('compile errors', () => {
  it('flags a net driven by two sources', () => {
    const b = new Builder();
    const g1 = b.prim('NAND', {}, 0);
    const g2 = b.prim('NAND', {}, 1);
    const out = b.prim('OUT', { name: 'out' }, 2);
    b.wire([g1, 'y'], [out, 'in']);
    b.wire([g2, 'y'], [out, 'in']);
    const nl = b.compile();
    expect(nl.errors.some((e) => /driven by 2 sources/.test(e.message))).toBe(true);
  });

  it('allows one output to fan out to many inputs', () => {
    const b = new Builder();
    const a = b.prim('IN', { name: 'a' }, 0);
    const g1 = b.prim('NAND', {}, 1);
    const g2 = b.prim('NAND', {}, 2);
    b.wire([a, 'out'], [g1, 'a']);
    b.wire([a, 'out'], [g1, 'b']);
    b.wire([a, 'out'], [g2, 'a']);
    b.wire([a, 'out'], [g2, 'b']);
    expect(b.compile().errors).toEqual([]);
  });

  it('refuses to connect two inputs together', () => {
    const b = new Builder();
    const g1 = b.prim('NAND', {}, 0);
    const g2 = b.prim('NAND', {}, 1);
    b.wire([g1, 'a'], [g2, 'b']);
    const nl = b.compile();
    expect(nl.errors.length).toBeGreaterThan(0);
  });

  it('detects a recursive definition', () => {
    const p = createProject();
    const outer = p.defs[0];
    const inner = emptyDef('Inner', null);
    p.defs.push(inner);
    inner.instances.push({ id: 'x1', def: outer.id, x: 0, y: 0, props: {} });
    outer.instances.push({ id: 'x2', def: inner.id, x: 0, y: 0, props: {} });
    const nl = compile(p, outer.id);
    expect(nl.errors.some((e) => /contains itself/.test(e.message))).toBe(true);
  });

  it('predicts recursion before a component is placed', () => {
    const b = new Builder();
    defineNot(b);
    b.newDef('Wrapper');
    b.use('Not');
    const notDef = b.project.defs.find((d) => d.name === 'Not')!;
    const wrapper = b.project.defs.find((d) => d.name === 'Wrapper')!;
    expect(wouldRecurse(b.project, notDef.id, wrapper.id)).toBe(true);
    expect(wouldRecurse(b.project, wrapper.id, notDef.id)).toBe(false);
    expect(wouldRecurse(b.project, notDef.id, notDef.id)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Sequential logic built from NAND feedback loops
 * ------------------------------------------------------------------ */

describe('memory emerges from NAND feedback', () => {
  /** Classic active-low SR latch: two cross-coupled NANDs. */
  function srLatch() {
    const b = new Builder();
    // Start with set asserted so the latch has a defined initial state.
    const sbar = b.prim('TOGGLE', { name: 'sbar', width: 1, value: 0 }, 0);
    const rbar = b.prim('TOGGLE', { name: 'rbar', width: 1, value: 1 }, 1);
    const q = b.prim('NAND', {}, 2);
    const qbar = b.prim('NAND', {}, 3);
    const out = b.prim('OUT', { name: 'q' }, 4);
    b.wire([sbar, 'out'], [q, 'a']);
    b.wire([qbar, 'y'], [q, 'b']);
    b.wire([rbar, 'out'], [qbar, 'a']);
    b.wire([q, 'y'], [qbar, 'b']);
    b.wire([q, 'y'], [out, 'in']);
    const { sim, nl } = b.sim();
    return { sim, nl, out, S: 0, R: 1 };
  }

  it('holds its value after the set input is released', () => {
    const { sim, nl, out, S, R } = srLatch();
    const Q = nl.rootOutputs.get(out)!;

    expect(sim.settle()).toBe(true);
    expect(sim.readNets(Q)).toBe(1);

    sim.setToggle(S, 1); // release set -- the latch must remember
    expect(sim.settle()).toBe(true);
    expect(sim.readNets(Q)).toBe(1);

    sim.setToggle(R, 0); // reset
    expect(sim.settle()).toBe(true);
    expect(sim.readNets(Q)).toBe(0);

    sim.setToggle(R, 1); // release reset -- still remembers
    expect(sim.settle()).toBe(true);
    expect(sim.readNets(Q)).toBe(0);
  });

  it('reports a perfectly symmetric latch as unstable rather than hanging', () => {
    // Both inputs released from an all-zero start: the real circuit resolves
    // this by manufacturing asymmetry, which a perfect simulator lacks.
    const b = new Builder();
    const sbar = b.prim('TOGGLE', { name: 'sbar', width: 1, value: 1 }, 0);
    const rbar = b.prim('TOGGLE', { name: 'rbar', width: 1, value: 1 }, 1);
    const q = b.prim('NAND', {}, 2);
    const qbar = b.prim('NAND', {}, 3);
    b.wire([sbar, 'out'], [q, 'a']);
    b.wire([qbar, 'y'], [q, 'b']);
    b.wire([rbar, 'out'], [qbar, 'a']);
    b.wire([q, 'y'], [qbar, 'b']);
    const { sim } = b.sim();
    expect(sim.settle(500)).toBe(false);
    expect(sim.unstable).toBe(true);
  });

  /**
   * Master-slave D flip-flop: nine NAND gates, no built-in DFF primitive.
   * Updates Q on the falling edge of clk.
   */
  function dff() {
    const b = new Builder();
    const d = b.prim('TOGGLE', { name: 'd', width: 1, value: 0 }, 0);
    const clk = b.prim('TOGGLE', { name: 'clk', width: 1, value: 0 }, 1);
    const nclk = b.prim('NAND', {}, 2);
    const m1 = b.prim('NAND', {}, 3);
    const m2 = b.prim('NAND', {}, 4);
    const mq = b.prim('NAND', {}, 5);
    const mqb = b.prim('NAND', {}, 6);
    const s1 = b.prim('NAND', {}, 7);
    const s2 = b.prim('NAND', {}, 8);
    const sq = b.prim('NAND', {}, 9);
    const sqb = b.prim('NAND', {}, 10);
    const out = b.prim('OUT', { name: 'q' }, 11);

    b.wire([clk, 'out'], [nclk, 'a']);
    b.wire([clk, 'out'], [nclk, 'b']);
    // master gated latch, enabled while clk is high
    b.wire([d, 'out'], [m1, 'a']);
    b.wire([clk, 'out'], [m1, 'b']);
    b.wire([m1, 'y'], [m2, 'a']);
    b.wire([clk, 'out'], [m2, 'b']);
    b.wire([m1, 'y'], [mq, 'a']);
    b.wire([mqb, 'y'], [mq, 'b']);
    b.wire([m2, 'y'], [mqb, 'a']);
    b.wire([mq, 'y'], [mqb, 'b']);
    // slave gated latch, enabled while clk is low
    b.wire([mq, 'y'], [s1, 'a']);
    b.wire([nclk, 'y'], [s1, 'b']);
    b.wire([s1, 'y'], [s2, 'a']);
    b.wire([nclk, 'y'], [s2, 'b']);
    b.wire([s1, 'y'], [sq, 'a']);
    b.wire([sqb, 'y'], [sq, 'b']);
    b.wire([s2, 'y'], [sqb, 'a']);
    b.wire([sq, 'y'], [sqb, 'b']);
    b.wire([sq, 'y'], [out, 'in']);

    const { sim, nl } = b.sim();
    return { sim, nl, out, D: 0, CLK: 1 };
  }

  it('latches D on the clock edge and holds it', () => {
    const { sim, nl, out, D, CLK } = dff();
    const Q = nl.rootOutputs.get(out)!;
    expect(nl.gateCount).toBe(9);

    const pulse = () => {
      sim.setToggle(CLK, 1); sim.settle();
      sim.setToggle(CLK, 0); sim.settle();
    };

    sim.settle();
    sim.setToggle(D, 1);
    sim.settle();
    expect(sim.readNets(Q)).toBe(0); // nothing happens without a clock edge

    pulse();
    expect(sim.readNets(Q)).toBe(1);

    sim.setToggle(D, 0);
    sim.settle();
    expect(sim.readNets(Q)).toBe(1); // holds until the next edge

    pulse();
    expect(sim.readNets(Q)).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Clock
 * ------------------------------------------------------------------ */

describe('CLOCK', () => {
  it('oscillates with the configured period', () => {
    const b = new Builder();
    const clk = b.prim('CLOCK', { period: 8 }, 0);
    const out = b.prim('OUT', { name: 'clk' }, 1);
    b.wire([clk, 'clk'], [out, 'in']);
    const { sim, nl } = b.sim();
    const Q = nl.rootOutputs.get(out)!;

    const seen: number[] = [];
    for (let t = 0; t < 16; t++) { sim.step(); seen.push(sim.readNets(Q)); }
    // Half period of 4 ticks: low, low, low, high, high, high, high, low...
    expect(seen.slice(0, 8)).toEqual([0, 0, 0, 1, 1, 1, 1, 0]);
  });

  it('is frozen while settling, so combinational logic can resolve', () => {
    const b = new Builder();
    const clk = b.prim('CLOCK', { period: 4 }, 0);
    const out = b.prim('OUT', { name: 'clk' }, 1);
    b.wire([clk, 'clk'], [out, 'in']);
    const { sim } = b.sim();
    expect(sim.settle(1000, true)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Memory primitives
 * ------------------------------------------------------------------ */

describe('ROM', () => {
  it('reads combinationally', () => {
    const b = new Builder();
    const addr = b.prim('IN', { name: 'addr', width: 4 }, 0);
    const rom = b.prim('ROM', { addrWidth: 4, dataWidth: 8, contents: [5, 7, 9, 11] }, 1);
    const out = b.prim('OUT', { name: 'data', width: 8 }, 2);
    b.wire([addr, 'out'], [rom, 'addr']);
    b.wire([rom, 'data'], [out, 'in']);

    const { sim, nl } = b.sim();
    const A = nl.rootInputs.get(addr)!;
    const D = nl.rootOutputs.get(out)!;
    for (const [a, want] of [[0, 5], [1, 7], [2, 9], [3, 11], [4, 0]]) {
      sim.writeNets(A, a);
      sim.settle();
      expect(sim.readNets(D)).toBe(want);
    }
  });
});

describe('RAM', () => {
  it('writes on the rising clock edge and reads asynchronously', () => {
    const b = new Builder();
    const addr = b.prim('TOGGLE', { name: 'addr', width: 4, value: 0 }, 0);
    const din = b.prim('TOGGLE', { name: 'din', width: 8, value: 0 }, 1);
    const load = b.prim('TOGGLE', { name: 'load', width: 1, value: 0 }, 2);
    const clk = b.prim('TOGGLE', { name: 'clk', width: 1, value: 0 }, 3);
    const ram = b.prim('RAM', { addrWidth: 4, dataWidth: 8 }, 4);
    const out = b.prim('OUT', { name: 'out', width: 8 }, 5);
    b.wire([addr, 'out'], [ram, 'addr']);
    b.wire([din, 'out'], [ram, 'in']);
    b.wire([load, 'out'], [ram, 'load']);
    b.wire([clk, 'out'], [ram, 'clk']);
    b.wire([ram, 'out'], [out, 'in']);

    const { sim, nl } = b.sim();
    const [ADDR, DIN, LOAD, CLK] = [0, 1, 2, 3];
    const O = nl.rootOutputs.get(out)!;

    const write = (a: number, v: number) => {
      sim.setToggle(ADDR, a); sim.setToggle(DIN, v); sim.setToggle(LOAD, 1);
      sim.setToggle(CLK, 0); sim.settle();
      sim.setToggle(CLK, 1); sim.settle();
      sim.setToggle(LOAD, 0); sim.settle();
    };

    write(3, 42);
    write(7, 200);

    sim.setToggle(DIN, 0);
    sim.setToggle(ADDR, 3); sim.settle();
    expect(sim.readNets(O)).toBe(42);
    sim.setToggle(ADDR, 7); sim.settle();
    expect(sim.readNets(O)).toBe(200);
    sim.setToggle(ADDR, 1); sim.settle();
    expect(sim.readNets(O)).toBe(0);
  });

  it('ignores the clock edge when load is low', () => {
    const b = new Builder();
    const addr = b.prim('TOGGLE', { name: 'addr', width: 4, value: 2 }, 0);
    const din = b.prim('TOGGLE', { name: 'din', width: 8, value: 99 }, 1);
    const load = b.prim('TOGGLE', { name: 'load', width: 1, value: 0 }, 2);
    const clk = b.prim('TOGGLE', { name: 'clk', width: 1, value: 0 }, 3);
    const ram = b.prim('RAM', { addrWidth: 4, dataWidth: 8 }, 4);
    const out = b.prim('OUT', { name: 'out', width: 8 }, 5);
    b.wire([addr, 'out'], [ram, 'addr']);
    b.wire([din, 'out'], [ram, 'in']);
    b.wire([load, 'out'], [ram, 'load']);
    b.wire([clk, 'out'], [ram, 'clk']);
    b.wire([ram, 'out'], [out, 'in']);

    const { sim, nl } = b.sim();
    sim.settle();
    sim.setToggle(3, 1); sim.settle();
    expect(sim.readNets(nl.rootOutputs.get(out)!)).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Toggles reachable through the hierarchy
 * ------------------------------------------------------------------ */

describe('nested signals', () => {
  it('surfaces toggles and probes buried inside components, by path', () => {
    const b = new Builder();
    b.newDef('Inner');
    const innerOut = b.prim('OUT', { name: 'out' }, 2);
    const sw = b.prim('TOGGLE', { name: 'hidden', width: 1, value: 1 }, 0);
    b.wire([sw, 'out'], [innerOut, 'in']);

    b.newDef('Outer');
    const inner = b.use('Inner');
    const out = b.prim('OUT', { name: 'out' }, 5);
    b.wire([inner, innerOut], [out, 'in']);

    const nl = b.compile('Outer');
    expect(nl.toggles.length).toBe(1);
    expect(nl.toggles[0].path).toBe('Inner/hidden');
    expect(nl.toggles[0].top).toBe(false);

    const sim = new Simulator(nl);
    sim.settle();
    expect(sim.readNets(nl.rootOutputs.get(out)!)).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * Library operations
 * ------------------------------------------------------------------ */

describe('replaceAllUses', () => {
  function twoAdders() {
    const b = new Builder();
    const mk = (name: string) => {
      b.newDef(name);
      const a = b.prim('IN', { name: 'a' }, 0);
      const g = b.prim('NAND', {}, 1);
      const o = b.prim('OUT', { name: 'out' }, 2);
      b.wire([a, 'out'], [g, 'a']);
      b.wire([a, 'out'], [g, 'b']);
      b.wire([g, 'y'], [o, 'in']);
      return b.project.defs.find((d) => d.name === name)!;
    };
    const v1 = mk('V1');
    const v2 = mk('V2');
    b.newDef('Top');
    const top = b.project.defs.find((d) => d.name === 'Top')!;
    const inp = b.prim('IN', { name: 'in' }, 0);
    const u1 = b.use('V1');
    const u2 = b.use('V1');
    const out = b.prim('OUT', { name: 'out' }, 9);
    b.wire([inp, 'out'], [u1, pinId(b.project, 'V1', 'a')]);
    b.wire([u1, pinId(b.project, 'V1', 'out')], [u2, pinId(b.project, 'V1', 'a')]);
    b.wire([u2, pinId(b.project, 'V1', 'out')], [out, 'in']);
    return { b, v1, v2, top };
  }

  it('swaps every instance and remaps pins by name', () => {
    const { b, v1, v2 } = twoAdders();
    expect(usageCount(b.project, v1.id)).toBe(2);

    const preview = previewReplace(b.project, v1.id, v2.id);
    expect(preview.instances).toBe(2);
    expect(preview.droppedPins).toEqual([]);
    expect(preview.wiresDropped).toBe(0);

    replaceAllUses(b.project, v1.id, v2.id);
    expect(usageCount(b.project, v1.id)).toBe(0);
    expect(usageCount(b.project, v2.id)).toBe(2);
    expect(b.compile('Top').errors).toEqual([]);
  });

  it('reports pins that will be dropped instead of failing silently', () => {
    const { b, v1 } = twoAdders();
    b.newDef('Mismatch');
    b.prim('IN', { name: 'zzz' }, 0);
    b.prim('OUT', { name: 'out' }, 1);
    const mismatch = b.project.defs.find((d) => d.name === 'Mismatch')!;

    const preview = previewReplace(b.project, v1.id, mismatch.id);
    expect(preview.droppedPins).toContain('a');
    expect(preview.wiresDropped).toBeGreaterThan(0);

    replaceAllUses(b.project, v1.id, mismatch.id);
    // The wires that could not be remapped are gone, not left dangling.
    expect(b.compile('Top').errors.filter((e) => /dangling/.test(e.message))).toEqual([]);
  });
});

describe('deleteDef', () => {
  it('removes the component and every instance of it', () => {
    const { b, v1, top } = twoAdders2();
    deleteDef(b.project, v1.id);
    expect(b.project.defs.find((d) => d.id === v1.id)).toBeUndefined();
    expect(top.instances.filter((i) => i.def === v1.id).length).toBe(0);
    expect(b.compile('Top').errors).toEqual([]);
  });

  function twoAdders2() {
    const b = new Builder();
    b.newDef('V1');
    const a = b.prim('IN', { name: 'a' }, 0);
    const g = b.prim('NAND', {}, 1);
    const o = b.prim('OUT', { name: 'out' }, 2);
    b.wire([a, 'out'], [g, 'a']);
    b.wire([a, 'out'], [g, 'b']);
    b.wire([g, 'y'], [o, 'in']);
    const v1 = b.project.defs.find((d) => d.name === 'V1')!;
    b.newDef('Top');
    const top = b.project.defs.find((d) => d.name === 'Top')!;
    b.use('V1');
    return { b, v1, top };
  }
});

describe('uniqueName', () => {
  it('avoids collisions in the library', () => {
    const p = createProject();
    p.defs[0].name = 'Adder';
    expect(uniqueName(p, 'Adder')).toBe('Adder2');
    expect(uniqueName(p, 'Adder', p.defs[0].id)).toBe('Adder');
    expect(uniqueName(p, 'Mux')).toBe('Mux');
  });
});

/* ------------------------------------------------------------------ *
 * Test benches
 * ------------------------------------------------------------------ */

describe('test benches', () => {
  it('verifies a component against its truth table', () => {
    const b = new Builder();
    defineNot(b);
    const notDef = b.project.defs.find((d) => d.name === 'Not')!;
    notDef.tests = { vectors: [{ in: { in: 0 }, out: { out: 1 } }, { in: { in: 1 }, out: { out: 0 } }] };

    const run = runTests(b.project, notDef.id);
    expect(run.ran).toBe(true);
    expect(run.passed).toBe(2);
    expect(run.total).toBe(2);
  });

  it('reports which vector failed and what it produced', () => {
    const b = new Builder();
    defineNot(b);
    const notDef = b.project.defs.find((d) => d.name === 'Not')!;
    notDef.tests = { vectors: [{ in: { in: 1 }, out: { out: 1 } }] }; // wrong on purpose

    const run = runTests(b.project, notDef.id);
    expect(run.passed).toBe(0);
    expect(run.results[0].actual).toEqual({ out: 0 });
  });

  it('survives a port being renamed after the tests were written', () => {
    // Wires bind to pins by id, so a rename never breaks a circuit. Vectors
    // used to bind by name, which meant renaming a port silently stopped
    // driving the input and every vector failed with no explanation.
    const b = new Builder();
    defineNot(b);
    const notDef = b.project.defs.find((d) => d.name === 'Not')!;
    const inPin = notDef.instances.find((i) => i.props.name === 'in')!;
    const outPin = notDef.instances.find((i) => i.props.name === 'out')!;
    notDef.tests = {
      vectors: [
        { in: { [inPin.id]: 0 }, out: { [outPin.id]: 1 } },
        { in: { [inPin.id]: 1 }, out: { [outPin.id]: 0 } },
      ],
    };
    expect(runTests(b.project, notDef.id).passed).toBe(2);

    inPin.props.name = 'a';
    outPin.props.name = 'y';
    const after = runTests(b.project, notDef.id);
    expect(after.passed).toBe(2);
    expect(after.unknownPins).toEqual([]);
    // And the results read back under the new names.
    expect(Object.keys(after.results[0].actual)).toEqual(['y']);
  });

  it('says which columns it could not match instead of failing mutely', () => {
    const b = new Builder();
    defineNot(b);
    const notDef = b.project.defs.find((d) => d.name === 'Not')!;
    notDef.tests = { vectors: [{ in: { nosuchpin: 1 }, out: { alsomissing: 0 } }] };

    const run = runTests(b.project, notDef.id);
    expect(run.ran).toBe(true);
    expect(run.unknownPins.sort()).toEqual(['alsomissing', 'nosuchpin']);
  });

  it('still accepts vectors written by name, so old tests keep working', () => {
    const b = new Builder();
    defineNot(b);
    const notDef = b.project.defs.find((d) => d.name === 'Not')!;
    notDef.tests = { vectors: [{ in: { in: 1 }, out: { out: 0 } }] };
    const run = runTests(b.project, notDef.id);
    expect(run.passed).toBe(1);
    expect(run.unknownPins).toEqual([]);
  });

  it('refuses to run against a circuit that does not compile', () => {
    const b = new Builder();
    const g1 = b.prim('NAND', {}, 0);
    const g2 = b.prim('NAND', {}, 1);
    const out = b.prim('OUT', { name: 'out' }, 2);
    b.wire([g1, 'y'], [out, 'in']);
    b.wire([g2, 'y'], [out, 'in']);
    b.def.tests = { vectors: [{ in: {}, out: { out: 0 } }] };
    const run = runTests(b.project, b.def.id);
    expect(run.ran).toBe(false);
    expect(run.errors.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ *
 * Something that looks like real hardware
 * ------------------------------------------------------------------ */

describe('a 4-bit ripple-carry adder built only from NAND', () => {
  it('adds', () => {
    const p = createProject();
    const project = p;

    // NAND-only XOR: 4 gates.
    const xor = emptyDef('Xor', null);
    project.defs.push(xor);
    {
      const a = addPrimitive(xor, 'IN', 0, 0, { name: 'a' });
      const bb = addPrimitive(xor, 'IN', 0, 1, { name: 'b' });
      const n1 = addPrimitive(xor, 'NAND', 2, 0);
      const n2 = addPrimitive(xor, 'NAND', 4, 0);
      const n3 = addPrimitive(xor, 'NAND', 4, 2);
      const n4 = addPrimitive(xor, 'NAND', 6, 1);
      const o = addPrimitive(xor, 'OUT', 8, 9, { name: 'out' });
      connect(project, xor, { inst: a.id, pin: 'out' }, { inst: n1.id, pin: 'a' });
      connect(project, xor, { inst: bb.id, pin: 'out' }, { inst: n1.id, pin: 'b' });
      connect(project, xor, { inst: a.id, pin: 'out' }, { inst: n2.id, pin: 'a' });
      connect(project, xor, { inst: n1.id, pin: 'y' }, { inst: n2.id, pin: 'b' });
      connect(project, xor, { inst: n1.id, pin: 'y' }, { inst: n3.id, pin: 'a' });
      connect(project, xor, { inst: bb.id, pin: 'out' }, { inst: n3.id, pin: 'b' });
      connect(project, xor, { inst: n2.id, pin: 'y' }, { inst: n4.id, pin: 'a' });
      connect(project, xor, { inst: n3.id, pin: 'y' }, { inst: n4.id, pin: 'b' });
      connect(project, xor, { inst: n4.id, pin: 'y' }, { inst: o.id, pin: 'in' });
    }
    const xorPin = (n: string) => xor.instances.find((i) => i.props.name === n)!.id;

    // AND from NAND + NAND-as-inverter.
    const and = emptyDef('And2', null);
    project.defs.push(and);
    {
      const a = addPrimitive(and, 'IN', 0, 0, { name: 'a' });
      const bb = addPrimitive(and, 'IN', 0, 1, { name: 'b' });
      const n1 = addPrimitive(and, 'NAND', 2, 0);
      const n2 = addPrimitive(and, 'NAND', 4, 0);
      const o = addPrimitive(and, 'OUT', 6, 9, { name: 'out' });
      connect(project, and, { inst: a.id, pin: 'out' }, { inst: n1.id, pin: 'a' });
      connect(project, and, { inst: bb.id, pin: 'out' }, { inst: n1.id, pin: 'b' });
      connect(project, and, { inst: n1.id, pin: 'y' }, { inst: n2.id, pin: 'a' });
      connect(project, and, { inst: n1.id, pin: 'y' }, { inst: n2.id, pin: 'b' });
      connect(project, and, { inst: n2.id, pin: 'y' }, { inst: o.id, pin: 'in' });
    }
    const andPin = (n: string) => and.instances.find((i) => i.props.name === n)!.id;

    // OR = NAND(NOT a, NOT b)
    const or = emptyDef('Or2', null);
    project.defs.push(or);
    {
      const a = addPrimitive(or, 'IN', 0, 0, { name: 'a' });
      const bb = addPrimitive(or, 'IN', 0, 1, { name: 'b' });
      const na = addPrimitive(or, 'NAND', 2, 0);
      const nb = addPrimitive(or, 'NAND', 2, 2);
      const n = addPrimitive(or, 'NAND', 4, 1);
      const o = addPrimitive(or, 'OUT', 6, 9, { name: 'out' });
      connect(project, or, { inst: a.id, pin: 'out' }, { inst: na.id, pin: 'a' });
      connect(project, or, { inst: a.id, pin: 'out' }, { inst: na.id, pin: 'b' });
      connect(project, or, { inst: bb.id, pin: 'out' }, { inst: nb.id, pin: 'a' });
      connect(project, or, { inst: bb.id, pin: 'out' }, { inst: nb.id, pin: 'b' });
      connect(project, or, { inst: na.id, pin: 'y' }, { inst: n.id, pin: 'a' });
      connect(project, or, { inst: nb.id, pin: 'y' }, { inst: n.id, pin: 'b' });
      connect(project, or, { inst: n.id, pin: 'y' }, { inst: o.id, pin: 'in' });
    }
    const orPin = (n: string) => or.instances.find((i) => i.props.name === n)!.id;

    // Full adder: sum = a^b^cin, cout = (a&b) | (cin & (a^b))
    const fa = emptyDef('FullAdder', null);
    project.defs.push(fa);
    {
      const a = addPrimitive(fa, 'IN', 0, 0, { name: 'a' });
      const bb = addPrimitive(fa, 'IN', 0, 1, { name: 'b' });
      const cin = addPrimitive(fa, 'IN', 0, 2, { name: 'cin' });
      const x1 = { id: 'fa_x1', def: xor.id, x: 2, y: 0, props: {} };
      const x2 = { id: 'fa_x2', def: xor.id, x: 4, y: 0, props: {} };
      const a1 = { id: 'fa_a1', def: and.id, x: 2, y: 4, props: {} };
      const a2 = { id: 'fa_a2', def: and.id, x: 4, y: 4, props: {} };
      const o1 = { id: 'fa_o1', def: or.id, x: 6, y: 4, props: {} };
      fa.instances.push(x1, x2, a1, a2, o1);
      const sum = addPrimitive(fa, 'OUT', 8, 20, { name: 'sum' });
      const cout = addPrimitive(fa, 'OUT', 8, 21, { name: 'cout' });

      connect(project, fa, { inst: a.id, pin: 'out' }, { inst: x1.id, pin: xorPin('a') });
      connect(project, fa, { inst: bb.id, pin: 'out' }, { inst: x1.id, pin: xorPin('b') });
      connect(project, fa, { inst: x1.id, pin: xorPin('out') }, { inst: x2.id, pin: xorPin('a') });
      connect(project, fa, { inst: cin.id, pin: 'out' }, { inst: x2.id, pin: xorPin('b') });
      connect(project, fa, { inst: x2.id, pin: xorPin('out') }, { inst: sum.id, pin: 'in' });

      connect(project, fa, { inst: a.id, pin: 'out' }, { inst: a1.id, pin: andPin('a') });
      connect(project, fa, { inst: bb.id, pin: 'out' }, { inst: a1.id, pin: andPin('b') });
      connect(project, fa, { inst: x1.id, pin: xorPin('out') }, { inst: a2.id, pin: andPin('a') });
      connect(project, fa, { inst: cin.id, pin: 'out' }, { inst: a2.id, pin: andPin('b') });
      connect(project, fa, { inst: a1.id, pin: andPin('out') }, { inst: o1.id, pin: orPin('a') });
      connect(project, fa, { inst: a2.id, pin: andPin('out') }, { inst: o1.id, pin: orPin('b') });
      connect(project, fa, { inst: o1.id, pin: orPin('out') }, { inst: cout.id, pin: 'in' });
    }
    const faPin = (n: string) => fa.instances.find((i) => i.props.name === n)!.id;

    // 4-bit ripple carry, wired bit by bit off two 4-bit buses.
    const add4 = emptyDef('Add4', null);
    project.defs.push(add4);
    const A = addPrimitive(add4, 'IN', 0, 0, { name: 'a', width: 4 });
    const B = addPrimitive(add4, 'IN', 0, 1, { name: 'b', width: 4 });
    const SUM = addPrimitive(add4, 'OUT', 20, 30, { name: 'sum', width: 4 });
    const COUT = addPrimitive(add4, 'OUT', 20, 31, { name: 'cout', width: 1 });
    const zero = addPrimitive(add4, 'CONST', 0, 3, { width: 1, value: 0 });
    let carry: { inst: string; pin: string } = { inst: zero.id, pin: 'out' };
    for (let i = 0; i < 4; i++) {
      const cell = { id: `add_${i}`, def: fa.id, x: 4 + i * 4, y: 0, props: {} };
      add4.instances.push(cell);
      connect(project, add4, { inst: A.id, pin: 'out', lo: i, hi: i }, { inst: cell.id, pin: faPin('a') });
      connect(project, add4, { inst: B.id, pin: 'out', lo: i, hi: i }, { inst: cell.id, pin: faPin('b') });
      connect(project, add4, carry, { inst: cell.id, pin: faPin('cin') });
      connect(project, add4, { inst: cell.id, pin: faPin('sum') }, { inst: SUM.id, pin: 'in', lo: i, hi: i });
      carry = { inst: cell.id, pin: faPin('cout') };
    }
    connect(project, add4, carry, { inst: COUT.id, pin: 'in' });

    const nl = compile(project, add4.id);
    expect(nl.errors).toEqual([]);

    const sim = new Simulator(nl);
    const Ain = nl.rootInputs.get(A.id)!;
    const Bin = nl.rootInputs.get(B.id)!;
    const Sout = nl.rootOutputs.get(SUM.id)!;
    const Cout = nl.rootOutputs.get(COUT.id)!;

    for (let a = 0; a < 16; a++) {
      for (let bv = 0; bv < 16; bv++) {
        sim.writeNets(Ain, a);
        sim.writeNets(Bin, bv);
        expect(sim.settle()).toBe(true);
        const total = a + bv;
        expect(sim.readNets(Sout)).toBe(total & 15);
        expect(sim.readNets(Cout)).toBe(total >> 4);
      }
    }
  });
});
