import { describe, expect, it } from 'vitest';
import { Builder } from './helpers';
import { extractSelection } from '../src/core/extract';
import { compile } from '../src/core/compile';
import { Simulator } from '../src/core/sim';
import { createProject, makeInstance, nameNewInstances, nextFreeBits, signatureOf } from '../src/core/project';
import { primDefId } from '../src/core/primitives';
import type { ComponentDef } from '../src/core/types';

/** AND built inline: two NANDs, the second acting as an inverter. */
function inlineAnd() {
  const b = new Builder();
  const a = b.prim('IN', { name: 'a' }, 0);
  const bb = b.prim('IN', { name: 'b' }, 1);
  const n1 = b.prim('NAND', {}, 2);
  const n2 = b.prim('NAND', {}, 3);
  const out = b.prim('OUT', { name: 'out' }, 4);
  b.wire([a, 'out'], [n1, 'a']);
  b.wire([bb, 'out'], [n1, 'b']);
  b.wire([n1, 'y'], [n2, 'a']);
  b.wire([n1, 'y'], [n2, 'b']);
  b.wire([n2, 'y'], [out, 'in']);
  return { b, a, bb, n1, n2, out };
}

function truthTable(b: Builder, defName: string | undefined, aId: string, bId: string, outId: string) {
  const nl = compile(b.project, defName ? b.project.defs.find((d) => d.name === defName)!.id : b.def.id);
  expect(nl.errors).toEqual([]);
  const sim = new Simulator(nl);
  const A = nl.rootInputs.get(aId)!;
  const B = nl.rootInputs.get(bId)!;
  const Y = nl.rootOutputs.get(outId)!;
  const rows: number[] = [];
  for (const [x, y] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
    sim.writeNets(A, x);
    sim.writeNets(B, y);
    sim.settle();
    rows.push(sim.readNets(Y));
  }
  return rows;
}

describe('extractSelection', () => {
  it('replaces the selection with one box and preserves behaviour', () => {
    const { b, a, bb, n1, n2, out } = inlineAnd();
    const before = truthTable(b, undefined, a, bb, out);
    expect(before).toEqual([0, 0, 0, 1]);

    const result = extractSelection(b.project, b.def, new Set([n1, n2]), 'And');
    expect(result).not.toBeNull();
    expect(result!.inputs).toBe(2);
    expect(result!.outputs).toBe(1);

    // The parent now holds a single instance of the new component.
    expect(b.def.instances.filter((i) => i.def === result!.def.id).length).toBe(1);
    expect(b.def.instances.some((i) => i.id === n1)).toBe(false);

    expect(truthTable(b, undefined, a, bb, out)).toEqual(before);
  });

  it('gives the new component a usable signature', () => {
    const { b, n1, n2 } = inlineAnd();
    const result = extractSelection(b.project, b.def, new Set([n1, n2]), 'And')!;
    const sig = signatureOf(result.def);
    expect(sig.inputs.length).toBe(2);
    expect(sig.outputs.length).toBe(1);
    expect(sig.inputs.every((p) => p.width === 1)).toBe(true);
  });

  it('creates one port per crossed pin, not per crossed wire', () => {
    const b = new Builder();
    const src = b.prim('IN', { name: 'src' }, 0);
    const g = b.prim('NAND', {}, 1);
    const o1 = b.prim('OUT', { name: 'o1' }, 2);
    const o2 = b.prim('OUT', { name: 'o2' }, 3);
    b.wire([src, 'out'], [g, 'a']);
    b.wire([src, 'out'], [g, 'b']);
    b.wire([g, 'y'], [o1, 'in']);
    b.wire([g, 'y'], [o2, 'in']); // one source pin feeding two outside sinks

    const result = extractSelection(b.project, b.def, new Set([g]), 'Inv')!;
    expect(result.inputs).toBe(2);  // pins a and b are distinct
    expect(result.outputs).toBe(1); // pin y is one port, shared
    expect(compile(b.project, b.def.id).errors).toEqual([]);
  });

  it('preserves bit slices across the new boundary', () => {
    const b = new Builder();
    const bus = b.prim('IN', { name: 'bus', width: 4 }, 0);
    const g = b.prim('NAND', {}, 1);
    const out = b.prim('OUT', { name: 'out' }, 2);
    b.wire([bus, 'out', 2, 2], [g, 'a']);
    b.wire([bus, 'out', 3, 3], [g, 'b']);
    b.wire([g, 'y'], [out, 'in']);

    const nl0 = compile(b.project, b.def.id);
    const s0 = new Simulator(nl0);
    s0.writeNets(nl0.rootInputs.get(bus)!, 0b1100);
    s0.settle();
    expect(s0.readNets(nl0.rootOutputs.get(out)!)).toBe(0);

    extractSelection(b.project, b.def, new Set([g]), 'Slice');
    const nl1 = compile(b.project, b.def.id);
    expect(nl1.errors).toEqual([]);
    const s1 = new Simulator(nl1);
    s1.writeNets(nl1.rootInputs.get(bus)!, 0b1100);
    s1.settle();
    expect(s1.readNets(nl1.rootOutputs.get(out)!)).toBe(0);
    s1.writeNets(nl1.rootInputs.get(bus)!, 0b0100);
    s1.settle();
    expect(s1.readNets(nl1.rootOutputs.get(out)!)).toBe(1);
  });

  it('leaves port markers in the parent alone', () => {
    const { b, a, n1, n2 } = inlineAnd();
    extractSelection(b.project, b.def, new Set([a, n1, n2]), 'And');
    // The IN marker stays in the parent; only real logic moves.
    expect(b.def.instances.some((i) => i.id === a)).toBe(true);
  });

  it('returns null when nothing extractable is selected', () => {
    const { b, a } = inlineAnd();
    expect(extractSelection(b.project, b.def, new Set([a]), 'Nope')).toBeNull();
  });
});

describe('naming newly placed markers', () => {
  const place = (def: ComponentDef, kind: 'IN' | 'OUT' | 'IN') => {
    const inst = makeInstance(primDefId(kind), 0, 0);
    nameNewInstances(def, [inst]);
    def.instances.push(inst);
    return inst;
  };

  it('does not let two ports share a name', () => {
    const p = createProject();
    const def = p.defs[0];
    expect(place(def, 'IN').props.name).toBe('in');
    expect(place(def, 'IN').props.name).toBe('in2');
    expect(place(def, 'IN').props.name).toBe('in3');
  });

  it('counts each kind separately, since the names differ anyway', () => {
    const p = createProject();
    const def = p.defs[0];
    expect(place(def, 'IN').props.name).toBe('in');
    expect(place(def, 'OUT').props.name).toBe('out');
    expect(place(def, 'IN').props.name).toBe('in2');
    expect(place(def, 'OUT').props.name).toBe('out2');
  });

  it('fills a gap left by a renamed port rather than counting past it', () => {
    const p = createProject();
    const def = p.defs[0];
    place(def, 'IN');
    const second = place(def, 'IN');
    expect(second.props.name).toBe('in2');
    second.props.name = 'carry';
    expect(place(def, 'IN').props.name).toBe('in2');
  });

  it('treats a trailing number as a counter when several arrive at once', () => {
    const p = createProject();
    const def = p.defs[0];
    const a = makeInstance(primDefId('IN'), 0, 0, { name: 'a1', width: 1 });
    const b = makeInstance(primDefId('IN'), 0, 2, { name: 'a1', width: 1 });
    nameNewInstances(def, [a, b]);
    expect([a.props.name, b.props.name]).toEqual(['a1', 'a2']);
  });

  it('leaves kinds that have no name alone', () => {
    const p = createProject();
    const def = p.defs[0];
    const nand = makeInstance(primDefId('NAND'), 0, 0);
    const konst = makeInstance(primDefId('CONST'), 0, 2);
    nameNewInstances(def, [nand, konst]);
    expect(nand.props.name).toBeUndefined();
    expect(konst.props.name).toBeUndefined();
  });
});

describe('choosing bits for a new wire', () => {
  /** A 16-bit source and a supply of one-bit gates to wire it into. */
  const bus = () => {
    const b = new Builder();
    const src = b.prim('IN', { name: 'a', width: 16 });
    return { b, src };
  };

  it('walks up a bus as gates are wired to it', () => {
    const { b, src } = bus();
    const picked: number[] = [];
    for (let i = 0; i < 4; i++) {
      const g = b.prim('NAND');
      const r = nextFreeBits(b.def, src, 'out', 1, 16);
      b.wire([src, 'out', r.lo, r.hi], [g, 'a']);
      picked.push(r.lo);
    }
    expect(picked).toEqual([0, 1, 2, 3]);
  });

  it('fills a wide input from several narrow sources', () => {
    const b = new Builder();
    const out = b.prim('OUT', { name: 'y', width: 8 });
    const picked: number[] = [];
    for (let i = 0; i < 3; i++) {
      const g = b.prim('NAND');
      const r = nextFreeBits(b.def, out, 'in', 1, 8);
      b.wire([g, 'y'], [out, 'in', r.lo, r.hi]);
      picked.push(r.lo);
    }
    expect(picked).toEqual([0, 1, 2]);
  });

  it('takes whole stretches when the far end is itself a bus', () => {
    const { b, src } = bus();
    const first = nextFreeBits(b.def, src, 'out', 4, 16);
    b.wire([src, 'out', first.lo, first.hi], [b.prim('OUT', { name: 'lo', width: 4 }), 'in']);
    const second = nextFreeBits(b.def, src, 'out', 4, 16);
    expect([first, second]).toEqual([{ lo: 0, hi: 3 }, { lo: 4, hi: 7 }]);
  });

  it('starts over at the bottom once the pin is full', () => {
    const b = new Builder();
    const src = b.prim('IN', { name: 'a', width: 2 });
    for (const lo of [0, 1]) {
      b.wire([src, 'out', lo, lo], [b.prim('NAND'), 'a']);
    }
    expect(nextFreeBits(b.def, src, 'out', 1, 2)).toEqual({ lo: 0, hi: 0 });
  });

  it('leaves one-bit fan-out alone, which shares by design', () => {
    const b = new Builder();
    const src = b.prim('IN', { name: 'clk', width: 1 });
    b.wire([src, 'out'], [b.prim('NAND'), 'a']);
    expect(nextFreeBits(b.def, src, 'out', 1, 1)).toEqual({ lo: 0, hi: 0 });
  });

  it('fills a gap left by a deleted wire before moving on', () => {
    const { b, src } = bus();
    const gates = [0, 1, 2].map(() => b.prim('NAND'));
    gates.forEach((g, i) => b.wire([src, 'out', i, i], [g, 'a']));
    b.def.wires = b.def.wires.filter((w) => w.from.lo !== 1);
    expect(nextFreeBits(b.def, src, 'out', 1, 16)).toEqual({ lo: 1, hi: 1 });
  });
});
