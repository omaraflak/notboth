import { describe, expect, it } from 'vitest';
import {
  distanceToPolyline, formatValue, layoutBox, planRoutes, routeWire, showPinLabel, sliceLabel,
} from '../src/core/layout';
import type { Signature } from '../src/core/types';

const sig = (ins: number, outs: number): Signature => ({
  inputs: Array.from({ length: ins }, (_, i) => ({ id: `i${i}`, name: `in${i}`, width: 1 })),
  outputs: Array.from({ length: outs }, (_, i) => ({ id: `o${i}`, name: `out${i}`, width: 1 })),
});

describe('box layout', () => {
  it('sizes height from the pin count so pins land on grid points', () => {
    expect(layoutBox(sig(2, 1), 'NAND').h).toBe(3);
    expect(layoutBox(sig(1, 1), 'Not').h).toBe(2);
    expect(layoutBox(sig(6, 2), 'ALU').h).toBe(7);
  });

  it('places pins at integer grid offsets down the left and right edges', () => {
    const box = layoutBox(sig(2, 1), 'NAND');
    const ins = box.pins.filter((p) => p.side === 'in');
    expect(ins.map((p) => [p.x, p.y])).toEqual([[0, 1], [0, 2]]);
    const outs = box.pins.filter((p) => p.side === 'out');
    expect(outs[0].x).toBe(box.w);
    expect(outs[0].y).toBe(1);
  });

  it('widens to fit long names without overlapping pin labels', () => {
    const narrow = layoutBox(sig(1, 1), 'X').w;
    const wide = layoutBox(sig(1, 1), 'ProgramCounterWithReset').w;
    expect(wide).toBeGreaterThan(narrow);
  });
});

describe('pin labels', () => {
  it('drops a pin label that only repeats the box name', () => {
    // The repeated name is the widest pin, so hiding it is what narrows the box.
    const same: Signature = {
      inputs: [{ id: 'a', name: 'thelongname', width: 1 }, { id: 'b', name: 'b', width: 1 }],
      outputs: [],
    };
    const different: Signature = {
      inputs: [{ id: 'a', name: 'anothername', width: 1 }, { id: 'b', name: 'b', width: 1 }],
      outputs: [],
    };
    expect(layoutBox(same, 'thelongname').w)
      .toBeLessThan(layoutBox(different, 'thelongname').w);
  });

  it('drops the label on a box that has only one pin, whatever it is called', () => {
    // The box name is the whole story on a const, a clock or a port marker.
    const lone: Signature = { inputs: [], outputs: [{ id: 'out', name: 'out', width: 1 }] };
    const bare: Signature = { inputs: [], outputs: [{ id: 'out', name: '', width: 1 }] };
    expect(showPinLabel(lone.outputs[0], '0', 1)).toBe(false);
    expect(layoutBox(lone, '0').w).toBe(layoutBox(bare, '0').w);
  });
});

describe('wire routing', () => {
  it('routes forward with a single vertical jog', () => {
    const pts = routeWire({ x: 0, y: 0 }, { x: 10, y: 4 });
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[pts.length - 1]).toEqual({ x: 10, y: 4 });
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      expect(a.x === b.x || a.y === b.y).toBe(true); // strictly orthogonal
    }
  });

  it('steps around when the target sits behind the source', () => {
    const pts = routeWire({ x: 10, y: 2 }, { x: 2, y: 2 });
    expect(pts.length).toBeGreaterThan(4);
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      expect(a.x === b.x || a.y === b.y).toBe(true);
    }
  });

  it('honours user waypoints', () => {
    const pts = routeWire({ x: 0, y: 0 }, { x: 8, y: 0 }, [{ x: 4, y: 6 }]);
    expect(pts.some((p) => p.x === 4 && p.y === 6)).toBe(true);
  });

  it('measures distance for hit testing', () => {
    const pts = routeWire({ x: 0, y: 0 }, { x: 10, y: 0 });
    expect(distanceToPolyline(pts, { x: 5, y: 0 })).toBeCloseTo(0);
    expect(distanceToPolyline(pts, { x: 5, y: 3 })).toBeCloseTo(3);
  });
});

describe('labels', () => {
  it('shows a bit range only for partial slices', () => {
    expect(sliceLabel(0, 15, 16)).toBeNull();
    expect(sliceLabel(3, 3, 16)).toBe('[3]');
    expect(sliceLabel(0, 7, 16)).toBe('[7..0]');
  });

  it('formats values in each base', () => {
    expect(formatValue(10, 4, 'bin')).toBe('1010');
    expect(formatValue(255, 8, 'hex')).toBe('0xFF');
    expect(formatValue(255, 8, 'sdec')).toBe('-1');
    expect(formatValue(255, 8, 'dec')).toBe('255');
  });
});

describe('routing a whole schematic', () => {
  const geom = (id: string, net: string, from: [number, number], to: [number, number]) =>
    ({ id, net, from: { x: from[0], y: from[1] }, to: { x: to[0], y: to[1] } });

  /** The x of the vertical run, or null if the wire never turns. */
  const channelOf = (points: { x: number; y: number }[]) => {
    for (let i = 0; i < points.length - 1; i++) {
      if (points[i].x === points[i + 1].x && points[i].y !== points[i + 1].y) return points[i].x;
    }
    return null;
  };

  it('keeps two different signals off the same vertical line', () => {
    // Both would pick the same midpoint column if routed independently.
    const plan = planRoutes([
      geom('w1', 'srcA', [0, 0], [10, 8]),
      geom('w2', 'srcB', [0, 4], [10, 12]),
    ]);
    const a = channelOf(plan.paths.get('w1')!);
    const b = channelOf(plan.paths.get('w2')!);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
  });

  it('lets wires carrying the same signal share one trunk', () => {
    const plan = planRoutes([
      geom('w1', 'src', [0, 0], [10, 2]),
      geom('w2', 'src', [0, 0], [10, 9]),
    ]);
    expect(channelOf(plan.paths.get('w1')!)).toBe(channelOf(plan.paths.get('w2')!));
  });

  it('marks the point where a branch leaves a trunk', () => {
    // Driver between its two sinks: the trunk passes straight through the
    // driver's own row, so that point is a real join and needs a dot.
    const plan = planRoutes([
      geom('w1', 'src', [0, 5], [10, 0]),
      geom('w2', 'src', [0, 5], [10, 10]),
    ]);
    expect(plan.junctions.map((j) => j.y)).toEqual([5]);
    expect(plan.junctions[0].net).toBe('src');
  });

  it('marks a branch the trunk carries on past, wherever it sits', () => {
    // Driver at the top, sinks below it: the trunk runs through the nearer
    // sink on its way to the further one, so that is still a join.
    const plan = planRoutes([
      geom('w1', 'src', [0, 0], [10, 4]),
      geom('w2', 'src', [0, 0], [10, 9]),
    ]);
    expect(plan.junctions.map((j) => j.y)).toEqual([4]);
  });

  it('puts no dot on a net that never branches', () => {
    const plan = planRoutes([geom('w1', 'src', [0, 0], [10, 6])]);
    expect(plan.junctions).toEqual([]);
  });

  it('puts no dot where two ends simply turn corners', () => {
    // Driver level with neither sink, both sinks at the extremes: every
    // meeting point is the end of a run, so nothing is ambiguous.
    const plan = planRoutes([
      geom('w1', 'src', [0, 3], [10, 3]),
      geom('w2', 'src', [0, 3], [10, 9]),
    ]);
    expect(plan.junctions).toEqual([]);
  });

  it('never claims a channel outside the gap it has to fit in', () => {
    const plan = planRoutes(
      Array.from({ length: 6 }, (_, i) => geom(`w${i}`, `net${i}`, [0, i * 3], [6, i * 3 + 12])),
    );
    for (const [, points] of plan.paths) {
      const x = channelOf(points);
      if (x === null) continue;
      expect(x).toBeGreaterThan(0);
      expect(x).toBeLessThan(6);
    }
  });

  it('still steps around when the target is behind the source', () => {
    const plan = planRoutes([geom('w1', 'src', [10, 2], [2, 2])]);
    const points = plan.paths.get('w1')!;
    expect(points.length).toBeGreaterThan(4);
    for (let i = 0; i < points.length - 1; i++) {
      expect(points[i].x === points[i + 1].x || points[i].y === points[i + 1].y).toBe(true);
    }
  });

  it('produces a route for every wire it is given', () => {
    const wires = [
      geom('a', 'n1', [0, 0], [8, 3]),
      geom('b', 'n1', [0, 0], [8, 6]),
      geom('c', 'n2', [1, 9], [9, 1]),
      geom('d', 'n3', [12, 0], [4, 4]),
    ];
    const plan = planRoutes(wires);
    expect([...plan.paths.keys()].sort()).toEqual(['a', 'b', 'c', 'd']);
  });
});
