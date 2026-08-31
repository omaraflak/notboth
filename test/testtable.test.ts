import { describe, expect, it } from 'vitest';
import { vectorsFromTable } from '../src/core/testbench';
import type { Signature, TestVector } from '../src/core/types';

const sig: Signature = {
  inputs: [{ id: 'ia', name: 'a', width: 1 }, { id: 'ib', name: 'b', width: 1 }],
  outputs: [{ id: 'oo', name: 'out', width: 1 }],
};
const read = (c: string) => (/^\d+$/.test(c.trim()) ? Number(c.trim()) : null);

const AND: TestVector[] = [
  { in: { ia: 0, ib: 0 }, out: { oo: 0 } },
  { in: { ia: 0, ib: 1 }, out: { oo: 0 } },
  { in: { ia: 1, ib: 0 }, out: { oo: 0 } },
  { in: { ia: 1, ib: 1 }, out: { oo: 1 } },
];

describe('a truth table as text', () => {
  it('reads a table as the manual writes one', () => {
    const text = [
      'a | b | >out',
      '0 | 0 | 0',
      '0 | 1 | 0',
      '1 | 0 | 0',
      '1 | 1 | 1',
    ].join('\n');
    expect(vectorsFromTable(sig, text, read).vectors).toEqual(AND);
  });

  it('reads one whose columns are not padded', () => {
    expect(vectorsFromTable(sig, 'a|b|>out\n1|1|1', read).vectors)
      .toEqual([{ in: { ia: 1, ib: 1 }, out: { oo: 1 } }]);
  });

  it('reads a table copied out of the manual, prose column and all', () => {
    const fromManual = [
      'a | b | >out | .what it means',
      '0 | 0 | 0    | neither',
      '1 | 1 | 1    | both',
    ].join('\n');
    const { vectors, ignored } = vectorsFromTable(sig, fromManual, read);
    expect(ignored).toEqual(['.what it means']);
    expect(vectors).toEqual([
      { in: { ia: 0, ib: 0 }, out: { oo: 0 } },
      { in: { ia: 1, ib: 1 }, out: { oo: 1 } },
    ]);
  });

  it('matches columns by name, in any order', () => {
    const { vectors } = vectorsFromTable(sig, '>out | b | a\n1 | 1 | 0', read);
    expect(vectors).toEqual([{ in: { ia: 0, ib: 1 }, out: { oo: 1 } }]);
  });

  it('fills in a column the table leaves out', () => {
    const { vectors } = vectorsFromTable(sig, 'a | >out\n1 | 1', read);
    expect(vectors).toEqual([{ in: { ia: 1, ib: 0 }, out: { oo: 1 } }]);
  });

  it('says which line is wrong rather than half-reading', () => {
    expect(() => vectorsFromTable(sig, 'a | b | >out\n0 | 0 | 0\n1 | 1', read))
      .toThrow(/line 3 has 2 cells, expected 3/);
    expect(() => vectorsFromTable(sig, 'a | b | >out\n0 | 0 | zzz', read))
      .toThrow(/line 2: cannot read "zzz" for out/);
    expect(() => vectorsFromTable(sig, 'x | y\n0 | 0', read))
      .toThrow(/no column matches a pin/);
    expect(() => vectorsFromTable(sig, '   ', read)).toThrow(/nothing to read/);
  });

  it('reads a pin whose name contains a pipe', () => {
    const piped: Signature = {
      inputs: [{ id: 'i1', name: 'D|A', width: 1 }],
      outputs: [{ id: 'o1', name: 'out', width: 1 }],
    };
    expect(vectorsFromTable(piped, 'D\\|A | >out\n1 | 0', read).vectors)
      .toEqual([{ in: { i1: 1 }, out: { o1: 0 } }]);
  });
});
