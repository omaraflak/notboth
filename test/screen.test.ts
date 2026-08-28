import { describe, it, expect } from 'vitest';
import { Builder } from './helpers';
import { screenAddrWidth, screenSize, screenWords } from '../src/core/primitives';

describe('screen geometry', () => {
  it('derives its memory from its pixels', () => {
    expect(screenWords({ pxWidth: 128, pxHeight: 96 })).toBe(12288);
    expect(screenAddrWidth({ pxWidth: 128, pxHeight: 96 })).toBe(14);
    expect(screenAddrWidth({ pxWidth: 16, pxHeight: 16 })).toBe(8);   // 256 words exactly
    expect(screenAddrWidth({ pxWidth: 4, pxHeight: 4 })).toBe(4);
    expect(screenSize({}).w).toBe(128);
  });
});

describe('screen as memory', () => {
  it('latches on the rising edge and reads back asynchronously', () => {
    const b = new Builder('Main');
    const addr = b.prim('IN', { name: 'a', width: 8 });
    const din = b.prim('IN', { name: 'd', width: 16 });
    const load = b.prim('IN', { name: 'l', width: 1 });
    const clk = b.prim('IN', { name: 'c', width: 1 });
    const scr = b.prim('SCREEN', { pxWidth: 16, pxHeight: 16 });
    const out = b.prim('OUT', { name: 'o', width: 16 });
    b.wire([addr, 'out'], [scr, 'addr']);
    b.wire([din, 'out'], [scr, 'in']);
    b.wire([load, 'out'], [scr, 'load']);
    b.wire([clk, 'out'], [scr, 'clk']);
    b.wire([scr, 'out'], [out, 'in']);

    const { sim, nl } = b.sim();
    expect(nl.errors).toEqual([]);
    expect(nl.mems[0].kind).toBe('SCREEN');
    expect(nl.mems[0].addrWidth).toBe(8);

    const idx = (n: string) => nl.inputs.findIndex((t) => t.path === n);
    const o = nl.rootOutputs.get(b.def.instances.find((i) => i.props.name === 'o')!.id)!;
    const set = (n: string, v: number) => sim.setInput(idx(n), v);

    set('a', 5); set('d', 0x7c00); set('l', 1); set('c', 0);
    sim.settle(500, true);
    expect(sim.readNets(o)).toBe(0);            // nothing latched yet

    set('c', 1); sim.settle(500, true);          // rising edge
    expect(sim.readNets(o)).toBe(0x7c00);
    expect(sim.memWord(0, 5)).toBe(0x7c00);
    const rev = sim.memRevision(0);

    set('c', 0); set('l', 0); set('d', 0x001f);  // load low: writes are ignored
    set('c', 1); sim.settle(500, true);
    expect(sim.memWord(0, 5)).toBe(0x7c00);
    expect(sim.memRevision(0)).toBe(rev);        // and nothing repaints

    set('a', 6); sim.settle(500, true);          // reads follow the address
    expect(sim.readNets(o)).toBe(0);
  });

  it('boots black and does not carry contents', () => {
    const b = new Builder('Main');
    const scr = b.prim('SCREEN', { pxWidth: 4, pxHeight: 4, contents: [1, 2, 3] });
    const out = b.prim('OUT', { name: 'o', width: 16 });
    b.wire([scr, 'out'], [out, 'in']);
    const { sim, nl } = b.sim();
    expect(nl.mems[0].contents).toEqual([]);
    expect(sim.memWord(0, 0)).toBe(0);
  });
});
