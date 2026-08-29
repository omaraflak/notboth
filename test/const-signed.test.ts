import { describe, expect, it } from 'vitest';
import { Builder } from './helpers';
import { applyText, toText } from '../src/core/hdl';
import { compile } from '../src/core/compile';
import { Simulator } from '../src/core/sim';
import { createProject, emptyDef } from '../src/core/project';

/** The bits a CONST of `value` actually drives, read off its output. */
function bitsOf(value: number, width: number): number {
  const b = new Builder('Main');
  const k = b.prim('CONST', { width, value });
  const out = b.prim('OUT', { name: 'out', width });
  b.wire([k, 'out'], [out, 'in']);
  const { sim, nl } = b.sim();
  sim.settle(200, true);
  return sim.readNets(nl.rootOutputs.get(out)!);
}

describe('a negative CONST', () => {
  it('drives its two\'s complement', () => {
    expect(bitsOf(-1, 16)).toBe(0xffff);
    expect(bitsOf(-1, 1)).toBe(0b1);
    expect(bitsOf(-1, 8)).toBe(0xff);
    expect(bitsOf(-5, 8)).toBe(0xfb);
    expect(bitsOf(-128, 8)).toBe(0x80);
    expect(bitsOf(-32768, 16)).toBe(0x8000);
    expect(bitsOf(-2, 16)).toBe(0xfffe);
  });

  it('agrees with the unsigned spelling of the same bits', () => {
    for (const [signed, unsigned, width] of [[-1, 0xffff, 16], [-5, 0xfb, 8], [-128, 0x80, 8]] as const) {
      expect(bitsOf(signed, width)).toBe(bitsOf(unsigned, width));
    }
  });

  it('survives a round trip through the text form', () => {
    const project = createProject('t');
    project.defs = [];
    const def = emptyDef('K', null);
    project.defs.push(def);
    expect(applyText(project, def, `
      out o[16]
      k : Const(width = 16, value = -1)
      o = k.out
    `)).toEqual([]);

    const inst = def.instances.find((i) => i.props.name === 'k')!;
    expect(inst.props.value).toBe(-1);          // not 4294967295
    expect(toText(project, def)).toContain('value = -1');

    const nl = compile(project, def.id);
    const sim = new Simulator(nl);
    sim.settle(200, true);
    const out = def.instances.find((i) => i.props.name === 'o')!;
    expect(sim.readNets(nl.rootOutputs.get(out.id)!)).toBe(0xffff);
  });
});
