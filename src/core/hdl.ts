/**
 * A textual form for a component, and the way back.
 *
 * The schematic is canonical: this is a second editor for the same data, not a
 * second source of truth. Two properties make that workable.
 *
 *  - **Labels are identity.** Every part carries a label, and a part whose
 *    label is unchanged keeps its id, its position on the canvas and any
 *    properties the text does not mention. So editing one line of text does
 *    not rearrange a schematic you spent an hour laying out.
 *  - **Nets are implicit.** The text names the *source* of a signal and the
 *    parser lowers that to the wire list the graph actually stores. Going the
 *    other way, wires sharing a driver collapse back into one name.
 *
 * The one thing text does not carry is memory contents -- a ROM's program is
 * data, not structure, and it survives a round trip by identity.
 */
import { arrange } from './autolayout';
import { newId } from './ids';
import { clampWidth, isPrim, primDefId, primKind, primName } from './primitives';
import { asIdentifier, defSignature, signatureOf } from './project';
import type {
  ComponentDef, Id, Instance, Notes, Pin, PrimitiveKind, Project, Signature, Wire,
} from './types';
import { PRIMITIVE_KINDS } from './types';

/* ------------------------------------------------------------------ *
 * Property names, so they can be told apart from pin names
 * ------------------------------------------------------------------ */

/** Editable in text. `contents` is deliberately absent: see the file comment. */
const PROP_KEYS: Record<PrimitiveKind, string[]> = {
  NAND: [],
  CLOCK: ['period'],
  TOGGLE: ['width', 'value'],
  CONST: ['width', 'value'],
  IN: ['width'],
  OUT: ['width'],
  PROBE: ['width', 'format'],
  ROM: ['addrWidth', 'dataWidth'],
  RAM: ['addrWidth', 'dataWidth'],
};

const PORT_KINDS = new Set(['IN', 'OUT']);

function isPortInstance(inst: Instance): boolean {
  return isPrim(inst.def) && PORT_KINDS.has(primKind(inst.def));
}

/* ------------------------------------------------------------------ *
 * Labels
 * ------------------------------------------------------------------ */

function baseLabel(project: Project, inst: Instance): string {
  if (isPrim(inst.def)) return primKind(inst.def).toLowerCase();
  const name = project.defs.find((d) => d.id === inst.def)?.name ?? 'part';
  const cleaned = name.replace(/[^A-Za-z0-9_]/g, '') || 'part';
  // A name written in caps is an acronym or a gate name, not camel case:
  // NOT becomes not, ALU becomes alu. Only a name that already mixes cases
  // gets its first letter dropped, turning FullAdder into fullAdder.
  const head = /[a-z]/.test(cleaned)
    ? cleaned.charAt(0).toLowerCase() + cleaned.slice(1)
    : cleaned.toLowerCase();
  return /^[A-Za-z_]/.test(head) ? head : `part${head}`;
}

/**
 * A label for every part. A stored name wins, so labels the author typed
 * survive; anything unnamed gets a generated one, which is then written back
 * on the next apply so it is stable from then on.
 */
export function labelsFor(project: Project, def: ComponentDef): Map<Id, string> {
  const labels = new Map<Id, string>();
  const taken = new Set<string>();

  for (const inst of def.instances) {
    if (isPortInstance(inst)) {
      // Sanitised on the way out too: a name from before this was enforced
      // would otherwise leave the component unreadable, and so unsaveable.
      const name = asIdentifier(inst.props.name || 'port', 'port');
      labels.set(inst.id, name);
      taken.add(name);
    }
  }
  for (const inst of def.instances) {
    if (isPortInstance(inst)) continue;
    const wanted = inst.props.name;
    if (wanted && !taken.has(wanted)) {
      labels.set(inst.id, wanted);
      taken.add(wanted);
    }
  }
  for (const inst of def.instances) {
    if (isPortInstance(inst) || labels.has(inst.id)) continue;
    const base = baseLabel(project, inst);
    // Mux16 must not become mux161; separate the counter when the name
    // already ends in a digit.
    const join = /\d$/.test(base) ? '_' : '';
    let n = 1;
    while (taken.has(`${base}${join}${n}`)) n++;
    const label = `${base}${join}${n}`;
    labels.set(inst.id, label);
    taken.add(label);
  }
  return labels;
}

/* ------------------------------------------------------------------ *
 * Graph -> text
 * ------------------------------------------------------------------ */

function widthSuffix(width: number): string {
  return width > 1 ? `[${width}]` : '';
}

function sliceSuffix(lo: number, hi: number, width: number): string {
  if (lo === 0 && hi === width - 1) return '';
  return lo === hi ? `[${lo}]` : `[${hi}..${lo}]`;
}

/* ------------------------------------------------------------------ *
 * Comments
 * ------------------------------------------------------------------ */

/** Where a run of comment lines with nothing after it is kept. */
const END = '$';
/** Where the block at the very top is kept. */
const TOP = '^';

const MEMORY_NOTE = '# Memory contents are not shown here; edit them from the schematic.';

/** The comment the generator writes when the author has not written their own. */
function headerLines(name: string, instances: Instance[]): string[] {
  const lines = [`# ${name}`];
  const hasMemory = instances.some((i) => isPrim(i.def)
    && (primKind(i.def) === 'ROM' || primKind(i.def) === 'RAM'));
  if (hasMemory) lines.push(MEMORY_NOTE);
  return lines;
}

/**
 * What a statement declares, which is what a comment above it is about.
 * Declarations, parts and assignments live in separate namespaces because a
 * port and the line that drives it share a name.
 */
function anchorOf(text: string): string | null {
  const port = RE_PORT.exec(text);
  if (port && !/^\s*(in|out)\s*=/.test(text)) return `d:${port[2]}`;
  const inst = RE_INST.exec(text);
  if (inst) return `p:${inst[1]}`;
  const eq = text.indexOf('=');
  if (eq > 0) return `a:${text.slice(0, eq).replace(/\s+/g, '')}`;
  return null;
}

function isEmpty(notes: Notes): boolean {
  return !Object.keys(notes.above ?? {}).length && !Object.keys(notes.inline ?? {}).length;
}

/**
 * Pull the comments out of a source text and file them by what they were
 * written about. A generated header is left behind rather than captured, so
 * that it goes on tracking the component's name.
 */
export function collectNotes(source: string, def: ComponentDef, instances: Instance[]): Notes | undefined {
  const above: Record<string, string[]> = {};
  const inline: Record<string, string> = {};
  let pending: string[] = [];
  let buffer = '';
  let depth = 0;
  let started = false;

  const flushTo = (key: string) => {
    while (pending.length && pending[pending.length - 1] === '') pending.pop();
    if (pending.length) above[key] = pending;
    pending = [];
  };

  for (const raw of source.split('\n')) {
    const trimmed = raw.trim();
    if (depth === 0) {
      if (!trimmed) { if (pending.length) pending.push(''); continue; }
      if (trimmed.startsWith('#')) { pending.push(trimmed); continue; }
    }

    const hash = raw.indexOf('#');
    const code = (hash >= 0 ? raw.slice(0, hash) : raw).trim();
    const comment = hash >= 0 ? raw.slice(hash).trim() : '';

    buffer = depth === 0 ? code : `${buffer} ${code}`;
    for (const ch of code) {
      if (ch === '(') depth++;
      else if (ch === ')') depth = Math.max(0, depth - 1);
    }
    if (depth !== 0) continue;

    const key = buffer ? anchorOf(buffer) : null;
    if (key) {
      // A block at the top with a blank line under it is about the component,
      // not about the first thing declared in it.
      if (!started && pending[pending.length - 1] === '') flushTo(TOP);
      started = true;
      flushTo(key);
      if (comment) inline[key] = comment;
    } else {
      pending = [];
    }
    buffer = '';
  }
  flushTo(END);

  // A block at the top that is only what the generator would have written
  // anyway is not the author's, and keeping it would freeze a stale name.
  const top = above[TOP];
  if (top) {
    const generated = headerLines(def.name, instances).join('\n');
    if (top.join('\n') === generated) delete above[TOP];
  }

  const notes: Notes = {};
  if (Object.keys(above).length) notes.above = above;
  if (Object.keys(inline).length) notes.inline = inline;
  return isEmpty(notes) ? undefined : notes;
}

export function toText(project: Project, def: ComponentDef): string {
  const labels = labelsFor(project, def);
  const byId = new Map(def.instances.map((i) => [i.id, i]));
  const sig = signatureOf(def);
  const out: string[] = [];

  const sigOf = (inst: Instance): Signature => defSignature(project, inst.def, inst.props);
  const pinOf = (inst: Instance, pinId: Id): Pin | undefined => {
    const s = sigOf(inst);
    return s.inputs.find((p) => p.id === pinId) ?? s.outputs.find((p) => p.id === pinId);
  };

  /** How a wire's driver reads in text. */
  const sourceText = (w: Wire): string => {
    const inst = byId.get(w.from.inst);
    if (!inst) return '?';
    const pin = pinOf(inst, w.from.pin);
    const width = pin?.width ?? 1;
    const slice = sliceSuffix(w.from.lo, w.from.hi, width);
    if (isPortInstance(inst)) return `${labels.get(inst.id)}${slice}`;
    return `${labels.get(inst.id)}.${pin?.name ?? '?'}${slice}`;
  };

  // Wires grouped by the pin they feed.
  const feeding = new Map<string, Wire[]>();
  for (const w of def.wires) {
    const key = `${w.to.inst}:${w.to.pin}`;
    const list = feeding.get(key);
    if (list) list.push(w); else feeding.set(key, [w]);
  }

  const notes = def.notes ?? {};
  const above = (key: string) => { const lines = notes.above?.[key]; if (lines) out.push(...lines); };
  const withNote = (key: string, line: string) => {
    const note = notes.inline?.[key];
    return note ? `${line}  ${note}` : line;
  };

  out.push(...(notes.above?.[TOP] ?? headerLines(def.name, def.instances)));
  out.push('');

  for (const p of sig.inputs) {
    above(`d:${p.name}`);
    out.push(withNote(`d:${p.name}`, `in  ${p.name}${widthSuffix(p.width)}`));
  }
  for (const p of sig.outputs) {
    above(`d:${p.name}`);
    out.push(withNote(`d:${p.name}`, `out ${p.name}${widthSuffix(p.width)}`));
  }
  if (sig.inputs.length || sig.outputs.length) out.push('');

  // Parts in stored order, never in canvas order: the text has to be
  // independent of the layout, so that rearranging a schematic cannot rewrite
  // it and so that reordering these lines is a change that sticks.
  const parts = def.instances.filter((i) => !isPortInstance(i));

  const trailing: Array<{ key: string; text: string }> = [];
  for (const inst of parts) {
    const label = labels.get(inst.id)!;
    const type = isPrim(inst.def)
      ? primName(primKind(inst.def))
      : project.defs.find((d) => d.id === inst.def)?.name ?? '?';
    const s = sigOf(inst);
    const args: string[] = [];

    if (isPrim(inst.def)) {
      for (const key of PROP_KEYS[primKind(inst.def)]) {
        const value = (inst.props as Record<string, unknown>)[key];
        if (value === undefined) continue;
        args.push(`${key} = ${typeof value === 'string' ? value : String(value)}`);
      }
    }

    for (const pin of s.inputs) {
      const wires = feeding.get(`${inst.id}:${pin.id}`) ?? [];
      const whole = wires.length === 1 && wires[0].to.lo === 0 && wires[0].to.hi === pin.width - 1;
      if (whole) {
        args.push(`${pin.name} = ${sourceText(wires[0])}`);
      } else {
        // Partial or multiply-driven: each piece gets its own line below.
        for (const w of wires) {
          const target = `${label}.${pin.name}${sliceSuffix(w.to.lo, w.to.hi, pin.width)}`;
          trailing.push({ key: `a:${target.replace(/\s+/g, '')}`, text: `${target} = ${sourceText(w)}` });
        }
      }
    }
    above(`p:${label}`);
    out.push(withNote(`p:${label}`,
      args.length ? `${label} : ${type}(${args.join(', ')})` : `${label} : ${type}`));
  }

  const emit = (lines: Array<{ key: string; text: string }>) => {
    if (!lines.length) return;
    out.push('');
    for (const line of lines) {
      above(line.key);
      out.push(withNote(line.key, line.text));
    }
  };
  emit(trailing);

  const outLines: Array<{ key: string; text: string }> = [];
  for (const p of sig.outputs) {
    const wires = feeding.get(`${p.id}:in`) ?? [];
    for (const w of wires) {
      const target = `${p.name}${sliceSuffix(w.to.lo, w.to.hi, p.width)}`;
      outLines.push({ key: `a:${target.replace(/\s+/g, '')}`, text: `${target} = ${sourceText(w)}` });
    }
  }
  emit(outLines);

  const tail = notes.above?.[END];
  if (tail) { out.push(''); out.push(...tail); }

  return out.join('\n') + '\n';
}

/* ------------------------------------------------------------------ *
 * Text -> graph
 * ------------------------------------------------------------------ */

export interface HdlIssue {
  line: number;
  message: string;
}

export interface ParsedComponent {
  issues: HdlIssue[];
  instances: Instance[];
  wires: Wire[];
  /** What was written in the margins, so it survives the next redraw. */
  notes?: Notes;
}

const IDENT = '[A-Za-z_][A-Za-z0-9_]*';
const RE_PORT = new RegExp(`^(in|out)\\s+(${IDENT})\\s*(?:\\[\\s*(\\d+)\\s*\\])?$`);
const RE_INST = new RegExp(`^(${IDENT})\\s*:\\s*(${IDENT})\\s*(?:\\(([\\s\\S]*)\\))?$`);
const RE_REF = new RegExp(`^(${IDENT})(?:\\.(${IDENT}))?\\s*(?:\\[\\s*(\\d+)\\s*(?:\\.\\.\\s*(\\d+)\\s*)?\\])?$`);

interface Ref { label: string; pin?: string; lo?: number; hi?: number }

function parseRef(text: string): Ref | null {
  const m = RE_REF.exec(text.trim());
  if (!m) return null;
  const ref: Ref = { label: m[1] };
  if (m[2]) ref.pin = m[2];
  if (m[3] !== undefined) {
    const a = Number(m[3]);
    const b = m[4] !== undefined ? Number(m[4]) : a;
    ref.lo = Math.min(a, b);
    ref.hi = Math.max(a, b);
  }
  return ref;
}

function parseNumber(text: string): number | null {
  const t = text.trim().toLowerCase();
  let n: number;
  if (t.startsWith('0x')) n = parseInt(t.slice(2), 16);
  else if (t.startsWith('0b')) n = parseInt(t.slice(2), 2);
  else if (/^\d+$/.test(t)) n = parseInt(t, 10);
  else return null;
  return Number.isFinite(n) ? n : null;
}

/** Split on commas, which is safe because no value can contain one. */
function splitArgs(text: string): string[] {
  return text.split(',').map((s) => s.trim()).filter(Boolean);
}

interface Statement { line: number; text: string }

/** Strip comments and join lines while parentheses are still open. */
function statements(source: string): Statement[] {
  const out: Statement[] = [];
  const lines = source.split('\n');
  let buffer = '';
  let start = 0;
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].replace(/#.*$/, '').trim();
    if (!stripped && depth === 0) continue;
    if (depth === 0) { buffer = stripped; start = i + 1; } else { buffer += ' ' + stripped; }
    for (const ch of stripped) {
      if (ch === '(') depth++;
      else if (ch === ')') depth = Math.max(0, depth - 1);
    }
    if (depth === 0 && buffer) { out.push({ line: start, text: buffer }); buffer = ''; }
  }
  if (buffer) out.push({ line: start, text: buffer });
  return out;
}

/**
 * Parse `source` into the parts and wires of `target`, reusing the identity of
 * anything whose label has not changed.
 */
export function fromText(project: Project, source: string, target: ComponentDef): ParsedComponent {
  const issues: HdlIssue[] = [];
  const fail = (line: number, message: string) => { issues.push({ line, message }); };

  // What a type name may refer to.
  const primByName = new Map<string, PrimitiveKind>();
  for (const k of PRIMITIVE_KINDS) primByName.set(k.toLowerCase(), k);
  const defByName = new Map<string, ComponentDef>();
  for (const d of project.defs) if (d.id !== target.id) defByName.set(d.name.toLowerCase(), d);

  // Existing parts, so labels can carry identity across an edit.
  const existingByLabel = new Map<string, Instance>();
  for (const [id, label] of labelsFor(project, target)) {
    const inst = target.instances.find((i) => i.id === id);
    if (inst) existingByLabel.set(label, inst);
  }

  const instances: Instance[] = [];
  const byLabel = new Map<string, Instance>();
  const declaredLine = new Map<string, number>();
  const isFresh = new Set<Id>();

  const claim = (label: string, defId: Id, props: Record<string, unknown>, line: number): Instance => {
    const previous = existingByLabel.get(label);
    if (previous && previous.def === defId) {
      const inst: Instance = {
        ...structuredClone(previous),
        props: { ...previous.props, ...props, name: label },
      };
      byLabel.set(label, inst);
      instances.push(inst);
      declaredLine.set(label, line);
      return inst;
    }
    const inst: Instance = {
      id: newId('i_'),
      def: defId,
      x: 0,
      y: 0,
      props: { ...props, name: label },
    };
    isFresh.add(inst.id);
    byLabel.set(label, inst);
    instances.push(inst);
    declaredLine.set(label, line);
    return inst;
  };

  interface PendingBinding { line: number; target: Ref; source: Ref }
  const bindings: PendingBinding[] = [];

  /* ---- pass one: declarations ---- */

  for (const st of statements(source)) {
    const port = RE_PORT.exec(st.text);
    if (port && !/^\s*(in|out)\s*=/.test(st.text)) {
      const kind = port[1] === 'in' ? 'IN' : 'OUT';
      const name = port[2];
      const width = port[3] ? clampWidth(Number(port[3])) : 1;
      if (byLabel.has(name)) { fail(st.line, `"${name}" is declared twice`); continue; }
      claim(name, primDefId(kind), { width }, st.line);
      continue;
    }

    const inst = RE_INST.exec(st.text);
    if (inst) {
      const label = inst[1];
      const typeName = inst[2];
      if (byLabel.has(label)) { fail(st.line, `"${label}" is declared twice`); continue; }

      const prim = primByName.get(typeName.toLowerCase());
      const userDef = defByName.get(typeName.toLowerCase());
      if (!prim && !userDef) { fail(st.line, `there is no component called "${typeName}"`); continue; }
      if (prim && PORT_KINDS.has(prim)) {
        fail(st.line, `use "in ${label}" or "out ${label}" to declare a port`);
        continue;
      }
      if (userDef && wouldContain(project, userDef.id, target.id)) {
        fail(st.line, `"${typeName}" already contains this component, so it cannot be used here`);
        continue;
      }

      const props: Record<string, unknown> = {};
      const allowed = prim ? PROP_KEYS[prim] : [];
      const created = claim(label, prim ? primDefId(prim) : userDef!.id, {}, st.line);
      const signature = defSignature(project, created.def, created.props);
      const inputNames = new Set(signature.inputs.map((p) => p.name));

      for (const arg of splitArgs(inst[3] ?? '')) {
        const eq = arg.indexOf('=');
        if (eq < 0) { fail(st.line, `"${arg}" should be written as name = value`); continue; }
        const key = arg.slice(0, eq).trim();
        const value = arg.slice(eq + 1).trim();

        if (allowed.includes(key)) {
          if (key === 'format') { props[key] = value; continue; }
          const n = parseNumber(value);
          if (n === null) { fail(st.line, `${key} needs a number, not "${value}"`); continue; }
          props[key] = key === 'value' ? n >>> 0 : clampWidth(n, n);
          continue;
        }
        if (!inputNames.has(key)) {
          const hint = [...inputNames].join(', ') || 'none';
          fail(st.line, `"${typeName}" has no input called "${key}" (it has: ${hint})`);
          continue;
        }
        const src = parseRef(value);
        if (!src) { fail(st.line, `could not read "${value}"`); continue; }
        bindings.push({ line: st.line, target: { label, pin: key }, source: src });
      }
      Object.assign(created.props, props);
      continue;
    }

    const eq = st.text.indexOf('=');
    if (eq > 0) {
      const lhs = parseRef(st.text.slice(0, eq));
      const rhs = parseRef(st.text.slice(eq + 1));
      if (!lhs) { fail(st.line, `could not read "${st.text.slice(0, eq).trim()}"`); continue; }
      if (!rhs) { fail(st.line, `could not read "${st.text.slice(eq + 1).trim()}"`); continue; }
      bindings.push({ line: st.line, target: lhs, source: rhs });
      continue;
    }

    fail(st.line, `could not understand "${st.text}"`);
  }

  /* ---- renames: pair up whatever is left over ---- */

  // In the text, changing a label is indistinguishable from deleting one part
  // and adding another. Match the leftovers by type, in the order they are
  // declared, so renaming something keeps its place on the canvas -- and a
  // renamed ROM keeps the program loaded into it.
  const reused = new Set(instances.filter((i) => !isFresh.has(i.id)).map((i) => i.id));
  const spare = new Map<Id, Instance[]>();
  for (const inst of target.instances) {
    if (reused.has(inst.id)) continue;
    const list = spare.get(inst.def);
    if (list) list.push(inst); else spare.set(inst.def, [inst]);
  }
  for (const inst of instances) {
    if (!isFresh.has(inst.id)) continue;
    const previous = spare.get(inst.def)?.shift();
    if (!previous) continue;
    isFresh.delete(inst.id);
    inst.id = previous.id;
    inst.x = previous.x;
    inst.y = previous.y;
    // Anything the text does not mention -- a ROM's contents, say -- carries
    // over; anything it does mention wins.
    inst.props = { ...previous.props, ...inst.props };
  }

  /* ---- pass two: wires ---- */

  const wires: Wire[] = [];
  const sigCache = new Map<Id, Signature>();
  const sigFor = (inst: Instance): Signature => {
    let s = sigCache.get(inst.id);
    if (!s) { s = defSignature(project, inst.def, inst.props); sigCache.set(inst.id, s); }
    return s;
  };

  /** Resolve a reference to a concrete pin, on the side we need it. */
  const resolve = (ref: Ref, side: 'source' | 'target', line: number) => {
    const inst = byLabel.get(ref.label);
    if (!inst) { fail(line, `nothing here is called "${ref.label}"`); return null; }
    const s = sigFor(inst);
    const port = isPortInstance(inst);

    // A port marker is mirrored: an input port is a source inside its own
    // component, so its usable pin is on the opposite side to its name.
    let pin: Pin | undefined;
    if (port) {
      pin = (side === 'source' ? s.outputs : s.inputs)[0];
      if (ref.pin) { fail(line, `"${ref.label}" is a port, so write it without a pin name`); return null; }
    } else {
      const pool = side === 'source' ? s.outputs : s.inputs;
      if (!ref.pin) {
        if (pool.length === 1) pin = pool[0];
        else {
          const names = pool.map((p) => p.name).join(', ') || 'none';
          fail(line, `say which pin of "${ref.label}" you mean (it has: ${names})`);
          return null;
        }
      } else {
        pin = pool.find((p) => p.name === ref.pin);
        if (!pin) {
          const names = pool.map((p) => p.name).join(', ') || 'none';
          const which = side === 'source' ? 'output' : 'input';
          fail(line, `"${ref.label}" has no ${which} called "${ref.pin}" (it has: ${names})`);
          return null;
        }
      }
    }
    if (!pin) { fail(line, `"${ref.label}" has nothing to connect on that side`); return null; }

    const lo = ref.lo ?? 0;
    const hi = ref.hi ?? pin.width - 1;
    if (hi >= pin.width) {
      fail(line, `${ref.label}${ref.pin ? '.' + ref.pin : ''} is ${pin.width} bit${pin.width === 1 ? '' : 's'} wide, so bit ${hi} does not exist`);
      return null;
    }
    return { inst, pin, lo, hi };
  };

  const driven = new Map<string, number>();

  for (const b of bindings) {
    const to = resolve(b.target, 'target', b.line);
    const from = resolve(b.source, 'source', b.line);
    if (!to || !from) continue;

    const want = to.hi - to.lo + 1;
    const give = from.hi - from.lo + 1;
    if (want !== give) {
      fail(b.line, `${give} bit${give === 1 ? '' : 's'} on the right, ${want} on the left`);
      continue;
    }
    for (let i = 0; i < want; i++) {
      const key = `${to.inst.id}:${to.pin.id}:${to.lo + i}`;
      const seen = driven.get(key);
      if (seen !== undefined) {
        fail(b.line, `bit ${to.lo + i} of ${b.target.label} is already driven on line ${seen}`);
        break;
      }
      driven.set(key, b.line);
    }

    wires.push({
      id: newId('w_'),
      from: { inst: from.inst.id, pin: from.pin.id, lo: from.lo, hi: from.hi },
      to: { inst: to.inst.id, pin: to.pin.id, lo: to.lo, hi: to.hi },
    });
  }

  // Keep the colour and routing of wires that already existed.
  const previous = new Map<string, Wire>();
  for (const w of target.wires) previous.set(wireKey(w), w);
  for (const w of wires) {
    const old = previous.get(wireKey(w));
    if (!old) continue;
    w.id = old.id;
    if (old.color) w.color = old.color;
    if (old.via) w.via = structuredClone(old.via);
  }

  // `instances` is left in the order the text declares things. Stored order is
  // what both pin order and statement order are read from, so the text is the
  // single authority on order -- and canvas position has no say in either.
  // Only the parts the text just invented need placing; everything else keeps
  // the position it already had.
  if (!issues.length && isFresh.size) arrange(project, instances, wires, { only: isFresh });
  return { issues, instances, wires, notes: collectNotes(source, target, instances) };
}

/**
 * Parse and commit, or report why not. Nothing is changed unless the whole
 * text is good, so a typo can never leave a component half-rewritten.
 */
export function applyText(project: Project, def: ComponentDef, source: string): HdlIssue[] {
  const parsed = fromText(project, source, def);
  if (parsed.issues.length) return parsed.issues;
  def.instances = parsed.instances;
  def.wires = parsed.wires;
  def.notes = parsed.notes;
  def.updatedAt = Date.now();
  return [];
}

function wireKey(w: Wire): string {
  return `${w.from.inst}:${w.from.pin}:${w.from.lo}-${w.from.hi}>${w.to.inst}:${w.to.pin}:${w.to.lo}-${w.to.hi}`;
}

/** True if `outer` already uses `inner`, directly or at any depth. */
function wouldContain(project: Project, outer: Id, inner: Id): boolean {
  const seen = new Set<Id>();
  const visit = (id: Id): boolean => {
    if (id === inner) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    const def = project.defs.find((d) => d.id === id);
    return !!def && def.instances.some((i) => !isPrim(i.def) && visit(i.def));
  };
  return visit(outer);
}

