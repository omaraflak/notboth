import { describe, expect, it } from 'vitest';
import { Builder } from './helpers';
import { extractSelection } from '../src/core/extract';
import { compile } from '../src/core/compile';
import { Simulator } from '../src/core/sim';
import { signatureOf } from '../src/core/project';

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
