/**
 * Arranging a schematic.
 *
 * Position is presentation: it has no effect on what a circuit does, on its
 * pin order, or on how it reads in the text editor. That makes rearranging
 * completely safe, and means it can be done on demand.
 *
 * The arrangement is by depth -- sources on the left, sinks on the right,
 * everything else in the column after the deepest thing feeding it -- which is
 * how a schematic is read anyway.
 */
import { approxMeasure, layoutBox, type Measure } from './layout';
import { isPrim, primKind } from './primitives';
import { defSignature } from './project';
import type { ComponentDef, Id, Instance, Project, Wire } from './types';

const COLUMN_GAP = 4;
const ROW_GAP = 1;
const MARGIN = 2;

export interface ArrangeOptions {
  /** Restrict the move to these parts; everything else stays put. */
  only?: Set<Id>;
  measure?: Measure;
}

/** Lay parts out in columns. Returns how many actually moved. */
export function arrange(
  project: Project,
  instances: Instance[],
  wires: Wire[],
  options: ArrangeOptions = {},
): number {
  if (!instances.length) return 0;
  const measure = options.measure ?? approxMeasure;
  const byId = new Map(instances.map((i) => [i.id, i]));

  const feeders = new Map<Id, Id[]>();
  for (const w of wires) {
    const list = feeders.get(w.to.inst);
    if (list) list.push(w.from.inst); else feeders.set(w.to.inst, [w.from.inst]);
  }

  const kindOf = (inst: Instance) => (isPrim(inst.def) ? primKind(inst.def) : null);

  const depth = new Map<Id, number>();
  const visiting = new Set<Id>();
  const depthOf = (id: Id): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    // A feedback loop has no "first" gate; break the tie rather than recurse
    // forever. Latches are supposed to look like this.
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const inst = byId.get(id);
    const isSource = inst && (kindOf(inst) === 'IN' || kindOf(inst) === 'TOGGLE'
      || kindOf(inst) === 'CONST' || kindOf(inst) === 'CLOCK');
    let d = isSource ? 0 : 1;
    for (const from of feeders.get(id) ?? []) d = Math.max(d, depthOf(from) + 1);
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };

  let deepest = 0;
  for (const inst of instances) deepest = Math.max(deepest, depthOf(inst.id));
  // Outputs belong at the right edge whatever feeds them.
  for (const inst of instances) if (kindOf(inst) === 'OUT') depth.set(inst.id, deepest);

  const columns = new Map<number, Instance[]>();
  for (const inst of instances) {
    const d = depth.get(inst.id) ?? 0;
    const list = columns.get(d);
    if (list) list.push(inst); else columns.set(d, [inst]);
  }

  let moved = 0;
  let x = MARGIN;
  for (const d of [...columns.keys()].sort((a, b) => a - b)) {
    const column = columns.get(d)!;
    // Keep the vertical order the author already had, so an arrange feels
    // like tidying rather than shuffling.
    column.sort((a, b) => a.y - b.y || a.x - b.x);

    let widest = 4;
    let y = MARGIN;
    for (const inst of column) {
      const box = layoutBox(defSignature(project, inst.def, inst.props), labelOf(project, inst), measure);
      widest = Math.max(widest, box.w);
      if (!options.only || options.only.has(inst.id)) {
        if (inst.x !== x || inst.y !== y) moved++;
        inst.x = x;
        inst.y = y;
      }
      y += box.h + ROW_GAP;
    }
    x += widest + COLUMN_GAP;
  }
  return moved;
}

/** Arrange a whole component in place. */
export function arrangeDef(project: Project, def: ComponentDef): number {
  return arrange(project, def.instances, def.wires);
}

function labelOf(project: Project, inst: Instance): string {
  if (isPrim(inst.def)) {
    const kind = primKind(inst.def);
    if (kind === 'IN' || kind === 'OUT' || kind === 'TOGGLE' || kind === 'PROBE') {
      return inst.props.name || kind.toLowerCase();
    }
    return kind;
  }
  return project.defs.find((d) => d.id === inst.def)?.name ?? '?';
}
