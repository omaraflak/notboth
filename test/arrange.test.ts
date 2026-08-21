/**
 * What a good arrangement means, stated as numbers.
 *
 * Two wires that follow the same path look like one wire, and a wire drawn
 * across the middle of a part looks like it is connected to it. Both are
 * misreadings the picture invites, so both are counted here rather than left
 * to whoever is looking at it.
 */
import { describe, expect, it } from 'vitest';
import { Builder } from './helpers';
import { arrangeDef } from '../src/core/autolayout';
import { approxMeasure, layoutBox, planRoutes, type Obstacle, type WireGeom } from '../src/core/layout';
import { defSignature, signatureOf } from '../src/core/project';
import { isPrim, primKind } from '../src/core/primitives';
import type { ComponentDef, Point, Project } from '../src/core/types';

interface Seg { x0: number; y0: number; x1: number; y1: number; net: string; wire: string }

function labelOf(project: Project, inst: { def: string; props: { name?: string } }): string {
  if (isPrim(inst.def)) {
    const k = primKind(inst.def);
    return k === 'IN' || k === 'OUT' || k === 'TOGGLE' || k === 'PROBE'
      ? (inst.props.name || k.toLowerCase()) : k;
  }
  return project.defs.find((d) => d.id === inst.def)?.name ?? '?';
}

function boxes(project: Project, def: ComponentDef): Obstacle[] {
  return def.instances.map((i) => {
    const box = layoutBox(defSignature(project, i.def, i.props), labelOf(project, i), approxMeasure);
    return { id: i.id, x0: i.x, y0: i.y, x1: i.x + box.w, y1: i.y + box.h };
  });
}

/** Every drawn segment of every wire, the way the canvas would draw them. */
function segments(project: Project, def: ComponentDef): Seg[] {
  const placed = new Map(def.instances.map((i) => [i.id,
    { inst: i, box: layoutBox(defSignature(project, i.def, i.props), labelOf(project, i), approxMeasure) }]));
  const point = (e: { inst: string; pin: string }): Point | null => {
    const p = placed.get(e.inst);
    const pin = p?.box.pins.find((x) => x.pin.id === e.pin);
    return p && pin ? { x: p.inst.x + pin.x, y: p.inst.y + pin.y } : null;
  };
  const geoms: WireGeom[] = [];
  for (const w of def.wires) {
    const from = point(w.from);
    const to = point(w.to);
    if (!from || !to) continue;
    geoms.push({
      id: w.id,
      net: `${w.from.inst}:${w.from.pin}:${w.from.lo}-${w.from.hi}`,
      from, to, via: w.via, fromInst: w.from.inst, toInst: w.to.inst,
    });
  }
  const plan = planRoutes(geoms, boxes(project, def));
  const segs: Seg[] = [];
  for (const g of geoms) {
    const pts = plan.paths.get(g.id) ?? [];
    for (let i = 0; i < pts.length - 1; i++) {
      segs.push({ x0: pts[i].x, y0: pts[i].y, x1: pts[i + 1].x, y1: pts[i + 1].y, net: g.net, wire: g.id });
    }
  }
  return segs;
}

/** Segments of *different* signals lying along the same line. */
function overlaps(segs: Seg[]): number {
  let n = 0;
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const a = segs[i];
      const b = segs[j];
      if (a.net === b.net) continue;
      const span = (p: number, q: number, r: number, s: number) =>
        Math.min(Math.max(p, q), Math.max(r, s)) - Math.max(Math.min(p, q), Math.min(r, s));
      if (a.y0 === a.y1 && b.y0 === b.y1 && a.y0 === b.y0 && span(a.x0, a.x1, b.x0, b.x1) > 0) n++;
      else if (a.x0 === a.x1 && b.x0 === b.x1 && a.x0 === b.x0 && span(a.y0, a.y1, b.y0, b.y1) > 0) n++;
    }
  }
  return n;
}

/** Segments crossing the body of a part they are not attached to. */
function throughParts(segs: Seg[], rects: Obstacle[], def: ComponentDef): number {
  const ends = new Map(def.wires.map((w) => [w.id, [w.from.inst, w.to.inst]]));
  let n = 0;
  for (const s of segs) {
    for (const r of rects) {
      if (ends.get(s.wire)?.includes(r.id)) continue;
      if (Math.max(s.x0, s.x1) > r.x0 && Math.min(s.x0, s.x1) < r.x1
        && Math.max(s.y0, s.y1) > r.y0 && Math.min(s.y0, s.y1) < r.y1) n++;
    }
  }
  return n;
}

function check(b: Builder) {
  arrangeDef(b.project, b.def);
  const segs = segments(b.project, b.def);
  return { overlaps: overlaps(segs), through: throughParts(segs, boxes(b.project, b.def), b.def) };
}

/** A full adder from NANDs: deep enough that wires must skip columns. */
function fullAdder(b: Builder) {
  const a = b.prim('IN', { name: 'a' });
  const bb = b.prim('IN', { name: 'b' });
  const ci = b.prim('IN', { name: 'cin' });
  const g = Array.from({ length: 6 }, () => b.prim('NAND'));
  const sum = b.prim('OUT', { name: 'sum' });
  const co = b.prim('OUT', { name: 'cout' });
  b.wire([a, 'out'], [g[0], 'a']); b.wire([bb, 'out'], [g[0], 'b']);
  b.wire([a, 'out'], [g[1], 'a']); b.wire([g[0], 'y'], [g[1], 'b']);
  b.wire([g[0], 'y'], [g[2], 'a']); b.wire([bb, 'out'], [g[2], 'b']);
  b.wire([g[1], 'y'], [g[3], 'a']); b.wire([g[2], 'y'], [g[3], 'b']);
  b.wire([g[3], 'y'], [g[4], 'a']); b.wire([ci, 'out'], [g[4], 'b']);
  b.wire([g[4], 'y'], [g[5], 'a']); b.wire([g[4], 'y'], [g[5], 'b']);
  b.wire([g[5], 'y'], [sum, 'in']); b.wire([g[3], 'y'], [co, 'in']);
  return b;
}

describe('an arranged schematic', () => {
  it('draws a full adder without a wire on a wire or across a gate', () => {
    const r = check(fullAdder(new Builder()));
    expect(r).toEqual({ overlaps: 0, through: 0 });
  });

  it('draws a latch cleanly, feedback and all', () => {
    const b = new Builder();
    const s = b.prim('IN', { name: 's' });
    const r = b.prim('IN', { name: 'r' });
    const n1 = b.prim('NAND');
    const n2 = b.prim('NAND');
    const q = b.prim('OUT', { name: 'q' });
    const nq = b.prim('OUT', { name: 'nq' });
    b.wire([s, 'out'], [n1, 'a']); b.wire([n2, 'y'], [n1, 'b']);
    b.wire([n1, 'y'], [n2, 'a']); b.wire([r, 'out'], [n2, 'b']);
    b.wire([n1, 'y'], [q, 'in']); b.wire([n2, 'y'], [nq, 'in']);
    expect(check(b)).toEqual({ overlaps: 0, through: 0 });
  });

  it('draws one signal fanning out to many gates cleanly', () => {
    const b = new Builder();
    const src = b.prim('IN', { name: 'clk' });
    for (let i = 0; i < 8; i++) {
      const g = b.prim('NAND');
      const o = b.prim('OUT', { name: `o${i}` });
      b.wire([src, 'out'], [g, 'a']);
      b.wire([src, 'out'], [g, 'b']);
      b.wire([g, 'y'], [o, 'in']);
    }
    expect(check(b)).toEqual({ overlaps: 0, through: 0 });
  });

  it('lets wires of one signal share a path, which is the point of a trunk', () => {
    const b = new Builder();
    const src = b.prim('IN', { name: 'a' });
    const g1 = b.prim('NAND');
    const g2 = b.prim('NAND');
    b.wire([src, 'out'], [g1, 'a']);
    b.wire([src, 'out'], [g2, 'a']);
    arrangeDef(b.project, b.def);
    const segs = segments(b.project, b.def);
    const nets = new Set(segs.map((s) => s.net));
    expect(nets.size).toBe(1);
    // Both wires leave the source along the same run rather than each taking
    // their own; that is one signal drawn once.
    const shared = segs.filter((s) => s.y0 === s.y1 && s.y0 === segs[0].y0);
    expect(shared.length).toBeGreaterThan(1);
  });

  it('puts outputs in a column of their own, past everything that feeds them', () => {
    const b = fullAdder(new Builder());
    arrangeDef(b.project, b.def);
    const outs = b.def.instances.filter((i) => isPrim(i.def) && primKind(i.def) === 'OUT');
    const others = b.def.instances.filter((i) => !(isPrim(i.def) && primKind(i.def) === 'OUT'));
    const leftmostOut = Math.min(...outs.map((i) => i.x));
    expect(leftmostOut).toBeGreaterThan(Math.max(...others.map((i) => i.x)));
  });

  it('orders a column by what feeds it, not by where things happened to be', () => {
    // Two independent pairs, deliberately interleaved to start with.
    const b = new Builder();
    const a1 = b.prim('IN', { name: 'a1' }, 0);
    const a2 = b.prim('IN', { name: 'a2' }, 10);
    const g1 = b.prim('NAND', {}, 10);
    const g2 = b.prim('NAND', {}, 0);
    b.wire([a1, 'out'], [g1, 'a']); b.wire([a1, 'out'], [g1, 'b']);
    b.wire([a2, 'out'], [g2, 'a']); b.wire([a2, 'out'], [g2, 'b']);
    arrangeDef(b.project, b.def);
    const y = (id: string) => b.def.instances.find((i) => i.id === id)!.y;
    // Whichever input ends up on top, its gate follows it.
    expect(y(a1) < y(a2)).toBe(y(g1) < y(g2));
  });

  it('leaves a component with no wires alone rather than failing', () => {
    const b = new Builder();
    b.prim('NAND');
    b.prim('NAND');
    expect(() => arrangeDef(b.project, b.def)).not.toThrow();
    expect(signatureOf(b.def).inputs).toEqual([]);
  });
});
