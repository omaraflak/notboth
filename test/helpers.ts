import { compile } from '../src/core/compile';
import { Simulator } from '../src/core/sim';
import {
  addPrimitive, connect, createProject, emptyDef, requireDef,
} from '../src/core/project';
import type { ComponentDef, Id, PrimitiveKind, Project } from '../src/core/types';

/** Small fluent builder so tests read like schematics. */
export class Builder {
  readonly project: Project;
  def: ComponentDef;
  private row = 0;

  constructor(name = 'Main') {
    this.project = createProject('test');
    this.def = requireDef(this.project, this.project.defs[0].id);
    this.def.name = name;
  }

  newDef(name: string): Builder {
    const def = emptyDef(name, null);
    this.project.defs.push(def);
    this.def = def;
    this.row = 0;
    return this;
  }

  open(name: string): Builder {
    const def = this.project.defs.find((d) => d.name === name);
    if (!def) throw new Error(`no def ${name}`);
    this.def = def;
    this.row = 0;
    return this;
  }

  prim(kind: PrimitiveKind, props: Record<string, unknown> = {}, y?: number): Id {
    const inst = addPrimitive(this.def, kind, 0, y ?? this.row++, props);
    return inst.id;
  }

  /** Place an instance of a user-defined component. */
  use(name: string): Id {
    const target = this.project.defs.find((d) => d.name === name);
    if (!target) throw new Error(`no def ${name}`);
    const inst = { id: `i_${Math.random().toString(36).slice(2, 10)}`, def: target.id, x: 0, y: this.row++, props: {} };
    this.def.instances.push(inst);
    return inst.id;
  }

  wire(
    from: [Id, string] | [Id, string, number, number],
    to: [Id, string] | [Id, string, number, number],
  ) {
    const f = { inst: from[0], pin: from[1], lo: from[2], hi: from[3] };
    const t = { inst: to[0], pin: to[1], lo: to[2], hi: to[3] };
    return connect(this.project, this.def, f, t);
  }

  compile(defName?: string) {
    const def = defName ? this.project.defs.find((d) => d.name === defName)! : this.def;
    return compile(this.project, def.id);
  }

  sim(defName?: string): { sim: Simulator; nl: ReturnType<typeof compile> } {
    const nl = this.compile(defName);
    return { sim: new Simulator(nl), nl };
  }
}

/** Build a NAND-only NOT gate as a reusable component named `Not`. */
export function defineNot(b: Builder) {
  b.newDef('Not');
  const inp = b.prim('IN', { name: 'in', width: 1 }, 0);
  const nand = b.prim('NAND', {}, 1);
  const out = b.prim('OUT', { name: 'out', width: 1 }, 2);
  b.wire([inp, 'out'], [nand, 'a']);
  b.wire([inp, 'out'], [nand, 'b']);
  b.wire([nand, 'y'], [out, 'in']);
  return b;
}

/** AND = NOT(NAND). */
export function defineAnd(b: Builder) {
  b.newDef('And');
  const a = b.prim('IN', { name: 'a', width: 1 }, 0);
  const bb = b.prim('IN', { name: 'b', width: 1 }, 1);
  const nand = b.prim('NAND', {}, 2);
  const not = b.use('Not');
  const out = b.prim('OUT', { name: 'out', width: 1 }, 4);
  b.wire([a, 'out'], [nand, 'a']);
  b.wire([bb, 'out'], [nand, 'b']);
  const notDef = b.project.defs.find((d) => d.name === 'Not')!;
  const notIn = notDef.instances.find((i) => i.props.name === 'in')!.id;
  const notOut = notDef.instances.find((i) => i.props.name === 'out')!.id;
  b.wire([nand, 'y'], [not, notIn]);
  b.wire([not, notOut], [out, 'in']);
  return b;
}

export function pinId(project: Project, defName: string, pinName: string): Id {
  const def = project.defs.find((d) => d.name === defName)!;
  return def.instances.find((i) => i.props.name === pinName)!.id;
}
