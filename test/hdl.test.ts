import { describe, expect, it } from 'vitest';
import { applyText, fromText, labelsFor, renameInstance, toText } from '../src/core/hdl';
import { compile } from '../src/core/compile';
import { Simulator } from '../src/core/sim';
import { addPrimitive, connect, createProject, emptyDef, signatureOf } from '../src/core/project';
import { customLabel } from '../src/core/primitives';
import type { ComponentDef, Project } from '../src/core/types';

function project(): Project {
  const p = createProject('t');
  p.defs = [];
  return p;
}

function def(p: Project, name: string): ComponentDef {
  const d = emptyDef(name, null);
  p.defs.push(d);
  return d;
}

/** Drive every input combination and record the outputs. */
function truthTable(p: Project, d: ComponentDef): string[] {
  const nl = compile(p, d.id);
  expect(nl.errors).toEqual([]);
  const sim = new Simulator(nl);
  const sig = signatureOf(d);
  const bits = sig.inputs.reduce((n, pin) => n + pin.width, 0);
  const rows: string[] = [];
  for (let v = 0; v < (1 << bits); v++) {
    let shift = 0;
    for (const pin of sig.inputs) {
      sim.writeNets(nl.rootInputs.get(pin.id)!, (v >> shift) & ((1 << pin.width) - 1));
      shift += pin.width;
    }
    sim.settle(5000);
    rows.push(sig.outputs.map((o) => sim.readNets(nl.rootOutputs.get(o.id)!)).join(','));
  }
  return rows;
}

/** A NOT built by hand on the canvas. */
function handBuiltNot(p: Project) {
  const d = def(p, 'Not');
  const i = addPrimitive(d, 'IN', 1, 3, { name: 'in', width: 1 });
  const g = addPrimitive(d, 'NAND', 7, 3);
  const o = addPrimitive(d, 'OUT', 14, 3, { name: 'out', width: 1 });
  connect(p, d, { inst: i.id, pin: 'out' }, { inst: g.id, pin: 'a' });
  connect(p, d, { inst: i.id, pin: 'out' }, { inst: g.id, pin: 'b' });
  connect(p, d, { inst: g.id, pin: 'y' }, { inst: o.id, pin: 'in' });
  return { d, i, g, o };
}

describe('writing a component out as text', () => {
  it('reads like a description of the circuit', () => {
    const p = project();
    const { d } = handBuiltNot(p);
    const text = toText(p, d);
    expect(text).toContain('in  in');
    expect(text).toContain('out out');
    expect(text).toMatch(/nand1 : Nand\(a = in, b = in\)/);
    expect(text).toContain('out = nand1.y');
  });

  it('spells ROM and RAM in capitals, and everything else as a word', () => {
    const p = project();
    const d = def(p, 'Store');
    addPrimitive(d, 'ROM', 0, 0, { addrWidth: 4, dataWidth: 8, contents: [] });
    addPrimitive(d, 'RAM', 0, 4, { addrWidth: 4, dataWidth: 8, contents: [] });
    addPrimitive(d, 'CLOCK', 0, 8, { period: 12 });
    const text = toText(p, d);
    expect(text).toMatch(/rom1 : ROM\(/);
    expect(text).toMatch(/ram1 : RAM\(/);
    expect(text).toMatch(/clock1 : Clock\(period = 12\)/);
  });

  it('still reads a type name written the old way, in capitals', () => {
    const p = project();
    const d = def(p, 'Not');
    // Anything saved or written before the built-ins were renamed says NAND.
    const parsed = fromText(p, 'in a\nout y\n\ng : NAND(a = a, b = a)\n\ny = g.y', d);
    expect(parsed.issues).toEqual([]);
    expect(parsed.instances).toHaveLength(3);
  });

  it('shows a bit range only where one is actually taken', () => {
    const p = project();
    const d = def(p, 'Slice');
    const bus = addPrimitive(d, 'IN', 0, 0, { name: 'bus', width: 8 });
    const g = addPrimitive(d, 'NAND', 4, 0);
    const o = addPrimitive(d, 'OUT', 8, 0, { name: 'y', width: 1 });
    connect(p, d, { inst: bus.id, pin: 'out', lo: 3, hi: 3 }, { inst: g.id, pin: 'a' });
    connect(p, d, { inst: bus.id, pin: 'out', lo: 0, hi: 0 }, { inst: g.id, pin: 'b' });
    connect(p, d, { inst: g.id, pin: 'y' }, { inst: o.id, pin: 'in' });

    const text = toText(p, d);
    expect(text).toContain('in  bus[8]');
    expect(text).toContain('a = bus[3]');
    expect(text).toContain('b = bus[0]');
  });
});

describe('reading a component in from text', () => {
  it('builds a circuit that behaves the same', () => {
    const p = project();
    const built = handBuiltNot(p);
    const before = truthTable(p, built.d);

    const typed = def(p, 'Not2');
    expect(applyText(p, typed, `
      in  in
      out out
      g : NAND(a = in, b = in)
      out = g.y
    `)).toEqual([]);

    expect(truthTable(p, typed)).toEqual(before);
  });

  it('accepts a component built out of other components', () => {
    const p = project();
    handBuiltNot(p);
    const and = def(p, 'And');
    expect(applyText(p, and, `
      in a
      in b
      out out
      n : NAND(a = a, b = b)
      inv : Not(in = n.y)
      out = inv.out
    `)).toEqual([]);
    expect(truthTable(p, and)).toEqual(['0', '0', '0', '1']);
  });

  it('merges two sources into one bus by driving separate ranges', () => {
    const p = project();
    const d = def(p, 'Merge');
    expect(applyText(p, d, `
      in lo[2]
      in hi[2]
      out both[4]
      both[1..0] = lo
      both[3..2] = hi
    `)).toEqual([]);

    const nl = compile(p, d.id);
    expect(nl.errors).toEqual([]);
    const sig = signatureOf(d);
    const sim = new Simulator(nl);
    sim.writeNets(nl.rootInputs.get(sig.inputs[0].id)!, 0b01);
    sim.writeNets(nl.rootInputs.get(sig.inputs[1].id)!, 0b11);
    sim.settle();
    expect(sim.readNets(nl.rootOutputs.get(sig.outputs[0].id)!)).toBe(0b1101);
  });

  it('carries primitive settings', () => {
    const p = project();
    const d = def(p, 'Timed');
    expect(applyText(p, d, `
      out tick
      c : CLOCK(period = 24)
      tick = c.clk
    `)).toEqual([]);
    const clock = d.instances.find((i) => i.def === 'prim:CLOCK')!;
    expect(clock.props.period).toBe(24);
    expect(toText(p, d)).toContain('period = 24');
  });
});

describe('generated labels', () => {
  const labelFor = (componentName: string) => {
    const p = project();
    const inner = def(p, componentName);
    addPrimitive(inner, 'IN', 0, 0, { name: 'a', width: 1 });
    addPrimitive(inner, 'OUT', 4, 0, { name: 'y', width: 1 });
    const outer = def(p, 'Outer');
    outer.instances.push({ id: 'u1', def: inner.id, x: 2, y: 2, props: {} });
    const line = toText(p, outer).split('\n').find((l) => l.includes(' : ')) ?? '';
    return line.split(':')[0].trim();
  };

  it('reads a name in caps as one word, not as camel case', () => {
    // NOT must not come out as nOT.
    expect(labelFor('NOT')).toBe('not1');
    expect(labelFor('AND')).toBe('and1');
    expect(labelFor('OR')).toBe('or1');
    expect(labelFor('ALU')).toBe('alu1');
  });

  it('still drops just the first letter of a camel-case name', () => {
    expect(labelFor('FullAdder')).toBe('fullAdder1');
    expect(labelFor('Mux16')).toBe('mux16_1');
  });

  it('produces a usable identifier from an awkward name', () => {
    expect(labelFor('16Bit')).toMatch(/^[A-Za-z_]/);
    expect(labelFor('Half Adder!')).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
  });
});

describe('renaming a label', () => {
  it('keeps the part where it was rather than re-placing it', () => {
    const p = project();
    const { d, g } = handBuiltNot(p);
    expect(applyText(p, d, toText(p, d))).toEqual([]);

    // Rename the gate; it is the same gate, just called something else.
    expect(applyText(p, d, `
      in  in
      out out
      inverter : NAND(a = in, b = in)
      out = inverter.y
    `)).toEqual([]);

    const renamed = d.instances.find((x) => x.props.name === 'inverter')!;
    expect(renamed.id).toBe(g.id);
    expect([renamed.x, renamed.y]).toEqual([7, 3]);
    expect(truthTable(p, d)).toEqual(['1', '0']);
  });

  it("keeps a memory's contents through a rename", () => {
    const p = project();
    const d = def(p, 'Mem');
    expect(applyText(p, d, `
      in  addr[4]
      out data[8]
      rom1 : ROM(addrWidth = 4, dataWidth = 8, addr = addr)
      data = rom1.data
    `)).toEqual([]);

    const rom = d.instances.find((i) => i.def === 'prim:ROM')!;
    rom.props.contents = [11, 22, 33];

    expect(applyText(p, d, `
      in  addr[4]
      out data[8]
      program : ROM(addrWidth = 4, dataWidth = 8, addr = addr)
      data = program.data
    `)).toEqual([]);

    const after = d.instances.find((i) => i.def === 'prim:ROM')!;
    expect(after.id).toBe(rom.id);
    expect(after.props.contents).toEqual([11, 22, 33]);
  });

  it("keeps a renamed port's identity, so its tests survive", () => {
    const p = project();
    const d = def(p, 'Buf');
    expect(applyText(p, d, 'in old\nout y\ng : NAND(a = old, b = old)\ny = g.y')).toEqual([]);
    const port = d.instances.find((i) => i.props.name === 'old')!;

    expect(applyText(p, d, 'in fresh\nout y\ng : NAND(a = fresh, b = fresh)\ny = g.y')).toEqual([]);
    const after = d.instances.find((i) => i.props.name === 'fresh')!;
    expect(after.id).toBe(port.id);
  });
});

describe('port order', () => {
  it('follows the order the ports are declared in', () => {
    const p = project();
    const d = def(p, 'Three');
    expect(applyText(p, d, 'in a\nin b\nin s\nout y\ng : NAND(a = a, b = b)\ny = g.y')).toEqual([]);
    expect(signatureOf(d).inputs.map((x) => x.name)).toEqual(['a', 'b', 's']);

    // Reordering the text must stick, not snap back to the canvas order.
    expect(applyText(p, d, 'in s\nin a\nin b\nout y\ng : NAND(a = a, b = b)\ny = g.y')).toEqual([]);
    expect(signatureOf(d).inputs.map((x) => x.name)).toEqual(['s', 'a', 'b']);
    expect(toText(p, d).indexOf('in  s')).toBeLessThan(toText(p, d).indexOf('in  a'));
  });

  it('does not move anything on the canvas', () => {
    // Where a box sits is layout; pin order is interface. Changing one must
    // not disturb the other.
    const p = project();
    const d = def(p, 'Three');
    expect(applyText(p, d, 'in a\nin b\nin s\nout y\ng : NAND(a = a, b = b)\ny = g.y')).toEqual([]);
    const spots = new Map(d.instances.map((i) => [i.id, `${i.x},${i.y}`]));

    expect(applyText(p, d, 'in s\nin a\nin b\nout y\ng : NAND(a = a, b = b)\ny = g.y')).toEqual([]);
    for (const inst of d.instances) expect(`${inst.x},${inst.y}`).toBe(spots.get(inst.id));
    expect(signatureOf(d).inputs.map((x) => x.name)).toEqual(['s', 'a', 'b']);
  });

  it('orders inputs and outputs independently', () => {
    const p = project();
    const d = def(p, 'Two');
    expect(applyText(p, d, 'in a\nin b\nout p\nout q\ng : NAND(a = a, b = b)\np = g.y\nq = g.y')).toEqual([]);
    expect(applyText(p, d, 'in b\nin a\nout q\nout p\ng : NAND(a = a, b = b)\np = g.y\nq = g.y')).toEqual([]);
    const sig = signatureOf(d);
    expect(sig.inputs.map((x) => x.name)).toEqual(['b', 'a']);
    expect(sig.outputs.map((x) => x.name)).toEqual(['q', 'p']);
  });
});

describe('the round trip', () => {
  it('leaves an untouched component exactly as it was', () => {
    const p = project();
    const { d, i, g, o } = handBuiltNot(p);
    const positions = new Map(d.instances.map((x) => [x.id, `${x.x},${x.y}`]));

    expect(applyText(p, d, toText(p, d))).toEqual([]);

    // Same parts, same ids, same places on the canvas.
    expect(d.instances.map((x) => x.id).sort()).toEqual([i.id, g.id, o.id].sort());
    for (const inst of d.instances) expect(`${inst.x},${inst.y}`).toBe(positions.get(inst.id));
    expect(truthTable(p, d)).toEqual(['1', '0']);
  });

  it('settles immediately: the second trip changes nothing at all', () => {
    const p = project();
    const { d } = handBuiltNot(p);
    expect(applyText(p, d, toText(p, d))).toEqual([]);
    const settled = structuredClone({ instances: d.instances, wires: d.wires });
    const text = toText(p, d);

    expect(applyText(p, d, text)).toEqual([]);
    expect(toText(p, d)).toBe(text);
    expect({ instances: d.instances, wires: d.wires }).toEqual(settled);
  });

  it('keeps the layout of the parts you did not touch', () => {
    const p = project();
    const { d, g } = handBuiltNot(p);
    const text = toText(p, d);
    // Add a second gate; the first must not move.
    expect(applyText(p, d, text.replace('out = nand1.y', 'extra : NAND(a = nand1.y, b = nand1.y)\nout = extra.y'))).toEqual([]);

    const kept = d.instances.find((x) => x.id === g.id)!;
    expect([kept.x, kept.y]).toEqual([7, 3]);
    expect(d.instances.length).toBe(4);
    expect(truthTable(p, d)).toEqual(['0', '1']); // now a buffer
  });

  it('gives newly typed parts room rather than stacking them at the origin', () => {
    const p = project();
    const d = def(p, 'Chain');
    expect(applyText(p, d, `
      in a
      out y
      g1 : NAND(a = a, b = a)
      g2 : NAND(a = g1.y, b = g1.y)
      g3 : NAND(a = g2.y, b = g2.y)
      y = g3.y
    `)).toEqual([]);

    const spots = new Set(d.instances.map((x) => `${x.x},${x.y}`));
    expect(spots.size).toBe(d.instances.length);
    const xs = d.instances.map((x) => x.x);
    expect(Math.max(...xs)).toBeGreaterThan(Math.min(...xs));
  });

  it('keeps wire colours across a rewrite', () => {
    const p = project();
    const { d } = handBuiltNot(p);
    d.wires[0].color = '#e0483a';
    expect(applyText(p, d, toText(p, d))).toEqual([]);
    expect(d.wires.some((w) => w.color === '#e0483a')).toBe(true);
  });
});

describe('when the text is wrong', () => {
  const parse = (source: string) => {
    const p = project();
    handBuiltNot(p);
    const d = def(p, 'Broken');
    return fromText(p, source, d);
  };

  it('names the line and the problem', () => {
    const r = parse('in a\nout y\ng : NOTATHING(a = a)\ny = g.out');
    expect(r.issues[0].line).toBe(3);
    expect(r.issues[0].message).toMatch(/no component called "NOTATHING"/);
  });

  it('lists the pins a component actually has', () => {
    const r = parse('in a\nout y\ng : NAND(z = a)\ny = g.y');
    expect(r.issues[0].message).toMatch(/no input called "z" \(it has: a, b\)/);
  });

  it('catches a width mismatch', () => {
    const r = parse('in a[4]\nout y\ng : NAND(a = a, b = a)\ny = g.y');
    expect(r.issues.some((i) => /4 bits on the right, 1 on the left/.test(i.message))).toBe(true);
  });

  it('catches a bit that does not exist', () => {
    const r = parse('in a[2]\nout y\ng : NAND(a = a[5], b = a[0])\ny = g.y');
    expect(r.issues.some((i) => /bit 5 does not exist/.test(i.message))).toBe(true);
  });

  it('catches the same input being driven twice', () => {
    const r = parse('in a\nin b\nout y\ng : NAND(a = a, b = b)\ng.a = b\ny = g.y');
    expect(r.issues.some((i) => /already driven on line/.test(i.message))).toBe(true);
  });

  it('refuses a component that would contain itself', () => {
    const p = project();
    const outer = def(p, 'Outer');
    const inner = def(p, 'Inner');
    inner.instances.push({ id: 'x', def: outer.id, x: 0, y: 0, props: {} });
    const r = fromText(p, 'in a\nout y\nu : Inner\n', outer);
    expect(r.issues.some((i) => /cannot be used here/.test(i.message))).toBe(true);
  });

  it('changes nothing at all when there is an error', () => {
    const p = project();
    const { d } = handBuiltNot(p);
    const before = structuredClone({ instances: d.instances, wires: d.wires });
    const issues = applyText(p, d, 'in a\nout y\nbroken nonsense here');
    expect(issues.length).toBeGreaterThan(0);
    expect({ instances: d.instances, wires: d.wires }).toEqual(before);
  });
});

describe('arranging the schematic', () => {
  it('tidies parts into columns without changing the text', async () => {
    const { arrangeDef } = await import('../src/core/autolayout');
    const p = project();
    const d = def(p, 'Chain');
    expect(applyText(p, d, `
      in a
      out y
      g1 : NAND(a = a, b = a)
      g2 : NAND(a = g1.y, b = g1.y)
      y = g2.y
    `)).toEqual([]);

    const textBefore = toText(p, d);
    const behaviourBefore = truthTable(p, d);

    // Scatter everything, then tidy it.
    for (const inst of d.instances) { inst.x = 40; inst.y = 40; }
    const moved = arrangeDef(p, d);
    expect(moved).toBeGreaterThan(0);

    // Left to right, no two parts on the same spot.
    const spots = new Set(d.instances.map((i) => `${i.x},${i.y}`));
    expect(spots.size).toBe(d.instances.length);
    const input = d.instances.find((i) => i.props.name === 'a')!;
    const output = d.instances.find((i) => i.props.name === 'y')!;
    expect(input.x).toBeLessThan(output.x);

    // And the two things that must not move.
    expect(toText(p, d)).toBe(textBefore);
    expect(truthTable(p, d)).toEqual(behaviourBefore);
  });

  it('leaves pin order alone', async () => {
    const { arrangeDef } = await import('../src/core/autolayout');
    const p = project();
    const d = def(p, 'Ports');
    expect(applyText(p, d, 'in s\nin a\nin b\nout y\ng : NAND(a = a, b = b)\ny = g.y')).toEqual([]);
    const before = signatureOf(d).inputs.map((x) => x.name);
    arrangeDef(p, d);
    expect(signatureOf(d).inputs.map((x) => x.name)).toEqual(before);
    expect(before).toEqual(['s', 'a', 'b']);
  });

  it('survives a feedback loop instead of recursing forever', async () => {
    const { arrangeDef } = await import('../src/core/autolayout');
    const p = project();
    const d = def(p, 'Latch');
    // Two cross-coupled NANDs: neither one comes "first".
    expect(applyText(p, d, `
      in sbar
      in rbar
      out q
      q1 : NAND(a = sbar, b = q2.y)
      q2 : NAND(a = rbar, b = q1.y)
      q = q1.y
    `)).toEqual([]);
    expect(() => arrangeDef(p, d)).not.toThrow();
    expect(new Set(d.instances.map((i) => `${i.x},${i.y}`)).size).toBe(d.instances.length);
  });
});

describe('comments', () => {
  /** A NOT gate, written with notes all over it. */
  const commented = [
    '# What this component is for.',
    '# Second line of that.',
    '',
    'in  a    # the operand',
    'out y',
    '',
    '# Tying both inputs together makes a NAND invert.',
    'g : Nand(a = a, b = a)',
    '',
    'y = g.y',
    '',
    '# a parting thought',
  ].join('\n');

  const load = () => {
    const p = project();
    const d = def(p, 'Not');
    expect(applyText(p, d, commented)).toEqual([]);
    return { p, d };
  };

  it('survives the text being regenerated from the schematic', () => {
    const { p, d } = load();
    const text = toText(p, d);
    expect(text).toContain('# What this component is for.');
    expect(text).toContain('# Second line of that.');
    expect(text).toContain('# the operand');
    expect(text).toContain('# Tying both inputs together makes a NAND invert.');
    expect(text).toContain('# a parting thought');
  });

  it('keeps each comment with what it was written about', () => {
    const { p, d } = load();
    const lines = toText(p, d).split('\n');
    const at = (needle: string) => lines.findIndex((l) => l.includes(needle));
    expect(at('# Tying both')).toBe(at('g : Nand') - 1);
    expect(lines[at('in  a')]).toContain('# the operand');
  });

  it('follows a part when the schematic changes around it', () => {
    const { p, d } = load();
    // As if a gate had been added on the canvas.
    const extra = addPrimitive(d, 'NAND', 0, 9);
    connect(p, d, { inst: extra.id, pin: 'y' }, { inst: extra.id, pin: 'a' });
    const lines = toText(p, d).split('\n');
    const note = lines.findIndex((l) => l.includes('# Tying both'));
    expect(lines[note + 1]).toContain('g : Nand');
  });

  it('round-trips: reading its own output back gives the same notes', () => {
    const { p, d } = load();
    const once = toText(p, d);
    expect(applyText(p, d, once)).toEqual([]);
    expect(toText(p, d)).toBe(once);
  });

  it('does not capture the generated header, which tracks the name', () => {
    const p = project();
    const d = def(p, 'Thing');
    addPrimitive(d, 'NAND', 0, 0);
    expect(applyText(p, d, toText(p, d))).toEqual([]);
    expect(d.notes?.above?.['^']).toBeUndefined();
    d.name = 'Renamed';
    expect(toText(p, d)).toContain('# Renamed');
    expect(toText(p, d)).not.toContain('# Thing');
  });

  it('drops a note whose subject is gone rather than stranding it', () => {
    const { p, d } = load();
    expect(applyText(p, d, 'in  a\nout y\n\ny = a')).toEqual([]);
    expect(toText(p, d)).not.toContain('# Tying both');
  });

  it('leaves a component with no comments carrying nothing', () => {
    const p = project();
    const d = def(p, 'Bare');
    addPrimitive(d, 'NAND', 0, 0);
    applyText(p, d, toText(p, d));
    expect(d.notes).toBeUndefined();
  });
});

describe('names the text form has to be able to write', () => {
  const zero = () => {
    const p = project();
    const d = def(p, 'Zero');
    const k = addPrimitive(d, 'CONST', 0, 0, { width: 1, value: 0 });
    const g = addPrimitive(d, 'NAND', 4, 0);
    const o = addPrimitive(d, 'OUT', 8, 0, { name: 'y', width: 1 });
    connect(p, d, { inst: k.id, pin: 'out' }, { inst: g.id, pin: 'a' });
    connect(p, d, { inst: k.id, pin: 'out' }, { inst: g.id, pin: 'b' });
    connect(p, d, { inst: g.id, pin: 'y' }, { inst: o.id, pin: 'in' });
    return { p, d, k };
  };

  it('writes a const output as a name, not as its value', () => {
    const { p, d } = zero();
    const text = toText(p, d);
    expect(text).toContain('const1.out');
    expect(text).not.toContain('const1.0');
  });

  it('reads back a circuit driven by a constant', () => {
    const { p, d } = zero();
    expect(applyText(p, d, toText(p, d))).toEqual([]);
  });

  it('reads back whatever the value is, including one', () => {
    const { p, d, k } = zero();
    k.props.value = 1;
    const text = toText(p, d);
    expect(text).toContain('value = 1');
    expect(applyText(p, d, text)).toEqual([]);
  });

  it('will not let a port name make a component unwritable', () => {
    const { p, d } = zero();
    const out = d.instances.find((i) => i.props.name === 'y')!;
    out.props.name = 'my out!';
    expect(signatureOf(d).outputs[0].name).toBe('myout');
    expect(applyText(p, d, toText(p, d))).toEqual([]);
  });

  it('keeps a name that starts with a digit reachable', () => {
    const { p, d } = zero();
    const out = d.instances.find((i) => i.props.name === 'y')!;
    out.props.name = '2nd';
    expect(applyText(p, d, toText(p, d))).toEqual([]);
  });
});

describe('renaming a part', () => {
  it('gives the part the name and writes it into the text form', () => {
    const p = project();
    const d = def(p, 'C');
    const a = addPrimitive(d, 'IN', 0, 0, { name: 'a', width: 1 });
    const g = addPrimitive(d, 'NAND', 5, 0);
    const o = addPrimitive(d, 'OUT', 10, 0, { name: 'y', width: 1 });
    connect(p, d, { inst: a.id, pin: 'out' }, { inst: g.id, pin: 'a' });
    connect(p, d, { inst: a.id, pin: 'out' }, { inst: g.id, pin: 'b' });
    connect(p, d, { inst: g.id, pin: 'y' }, { inst: o.id, pin: 'in' });

    expect(labelsFor(p, d).get(g.id)).toBe('nand1');
    expect(renameInstance(p, d, g.id, 'carry')).toBe('carry');
    expect(labelsFor(p, d).get(g.id)).toBe('carry');
    expect(toText(p, d)).toContain('carry : Nand');
    expect(applyText(p, d, toText(p, d))).toEqual([]);
  });

  it('refuses to hand out a label another part already has', () => {
    const p = project();
    const d = def(p, 'C');
    const g1 = addPrimitive(d, 'NAND', 0, 0);
    const g2 = addPrimitive(d, 'NAND', 5, 0);
    expect(renameInstance(p, d, g1.id, 'carry')).toBe('carry');
    // Silently keeping the old label is what labelsFor would do; a suffix is
    // visible, so the author can see what happened.
    expect(renameInstance(p, d, g2.id, 'carry')).toBe('carry2');
    const labels = labelsFor(p, d);
    expect(labels.get(g1.id)).toBe('carry');
    expect(labels.get(g2.id)).toBe('carry2');
  });

  it('lets a part keep the name it already has', () => {
    const p = project();
    const d = def(p, 'C');
    const g = addPrimitive(d, 'NAND', 0, 0);
    expect(renameInstance(p, d, g.id, 'carry')).toBe('carry');
    expect(renameInstance(p, d, g.id, 'carry')).toBe('carry');
  });

  it('sanitises a name that could not be written back', () => {
    const p = project();
    const d = def(p, 'C');
    const g = addPrimitive(d, 'NAND', 0, 0);
    expect(renameInstance(p, d, g.id, 'my gate!')).toBe('mygate');
    expect(applyText(p, d, toText(p, d))).toEqual([]);
  });

  it('is only reported for parts whose name is not already their box label', () => {
    const p = project();
    const d = def(p, 'C');
    const g = addPrimitive(d, 'NAND', 0, 0);
    const port = addPrimitive(d, 'IN', 5, 0, { name: 'a', width: 1 });
    expect(customLabel(g)).toBe(null);
    renameInstance(p, d, g.id, 'carry');
    expect(customLabel(g)).toBe('carry');
    // A port already shows its name on the box, so there is nothing to add.
    expect(customLabel(port)).toBe(null);
  });
});
