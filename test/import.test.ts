import { describe, expect, it } from 'vitest';
import { App } from '../src/ui/app';
import { createProject } from '../src/core/project';
import { compile } from '../src/core/compile';
import { Simulator } from '../src/core/sim';

const NOT = `
in  in
out out

nand1 : Nand(a = in, b = in)

out = nand1.y
`;

/** An App without touching IndexedDB or the DOM. */
function bare(): App {
  const app = Object.create(App.prototype) as App;
  Object.assign(app, {
    project: (() => { const p = createProject('t'); p.defs = []; return p; })(),
    selection: { instances: new Set(), wires: new Set() },
    listeners: new Map(),
    undoStack: [], redoStack: [],
  });
  // the parts of App an import touches, stubbed to record rather than render
  const toasts: string[] = [];
  (app as unknown as Record<string, unknown>).toast = (t: string) => { toasts.push(t); };
  (app as unknown as Record<string, unknown>).mutate = (fn: () => void) => { fn(); };
  (app as unknown as Record<string, unknown>).openComponent = () => { };
  (app as unknown as Record<string, unknown>).toasts = toasts;
  return app;
}

describe('importing a circuit from the manual', () => {
  it('adds the component and keeps its name', () => {
    const app = bare();
    const result = app.importComponent('Not', NOT);
    expect(result).toEqual({ name: 'Not' });
    expect(app.project.defs.map((d) => d.name)).toEqual(['Not']);
  });

  it('proposes a free name rather than overwriting one', () => {
    const app = bare();
    app.importComponent('Not', NOT);
    const again = app.importComponent('Not', NOT);
    expect(again).toEqual({ name: 'Not2' });
    const third = app.importComponent('Not', NOT);
    expect(third).toEqual({ name: 'Not3' });
    expect(app.project.defs.map((d) => d.name)).toEqual(['Not', 'Not2', 'Not3']);
    // the first one is untouched
    expect(app.project.defs[0].instances.length).toBe(3);
  });

  it('the imported component actually works', () => {
    const app = bare();
    const { name } = app.importComponent('Not', NOT) as { name: string };
    const def = app.project.defs.find((d) => d.name === name)!;
    const nl = compile(app.project, def.id);
    expect(nl.errors).toEqual([]);
    const sim = new Simulator(nl);
    const inPort = def.instances.find((i) => i.props.name === 'in')!;
    const outPort = def.instances.find((i) => i.props.name === 'out')!;
    const idx = nl.inputs.findIndex((t) => t.instId === inPort.id);
    const outs = nl.rootOutputs.get(outPort.id)!;
    const truth: number[] = [];
    for (const v of [0, 1]) {
      sim.setInput(idx, v);
      sim.settle(200, true);
      truth.push(sim.readNets(outs));
    }
    expect(truth).toEqual([1, 0]);
  });

  it('refuses a circuit that does not parse, leaving nothing behind', () => {
    const app = bare();
    const bad = app.importComponent('Broken', 'in a\nout out\n\nx : Nope(a = a)\n\nout = x.y\n');
    expect('error' in bad).toBe(true);
    expect(app.project.defs).toEqual([]);
  });

  it('needs the parts it is built from', () => {
    const app = bare();
    const and = 'in a\nin b\nout out\n\nn1 : Nand(a = a, b = b)\nn2 : Not(in = n1.y)\n\nout = n2.out\n';
    expect('error' in app.importComponent('And', and)).toBe(true);
    // with Not present first, the same import lands
    app.importComponent('Not', NOT);
    expect(app.importComponent('And', and)).toEqual({ name: 'And' });
  });
});
