import {
  PRIM_PREFIX, MAX_WIDTH,
  type Id, type Instance, type InstanceProps, type PrimitiveKind, type Signature,
} from './types';

export function primDefId(kind: PrimitiveKind): Id {
  return PRIM_PREFIX + kind;
}

export function isPrim(defId: Id): boolean {
  return defId.startsWith(PRIM_PREFIX);
}

export function primKind(defId: Id): PrimitiveKind {
  return defId.slice(PRIM_PREFIX.length) as PrimitiveKind;
}

export function clampWidth(w: number | undefined, fallback = 1): number {
  const n = Math.floor(Number(w ?? fallback));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_WIDTH, Math.max(1, n));
}

/** Mask for the low `width` bits, as an unsigned 32-bit number. */
export function maskOf(width: number): number {
  return width >= 32 ? 0xffffffff : ((1 << width) - 1) >>> 0;
}

/**
 * A name the text form can write down and read back.
 *
 * A port marker's name *is* the pin's name, and the text form writes it after
 * a dot or after `in`/`out`. A space or a leading digit in there produces a
 * line the parser cannot read, which leaves the component impossible to save
 * from the code view -- so names are held to what an identifier can be at the
 * point they are typed, rather than being allowed to trap the file later.
 */
export function asIdentifier(name: string, fallback = 'x'): string {
  const cleaned = name.replace(/[^A-Za-z0-9_]/g, '');
  if (!cleaned) return fallback;
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `${fallback}${cleaned}`;
}

export function defaultProps(kind: PrimitiveKind): InstanceProps {
  switch (kind) {
    case 'NAND':   return {};
    case 'CLOCK':  return { period: 16 };
    case 'TOGGLE': return { name: 'sw', width: 1, value: 0 };
    case 'CONST':  return { width: 1, value: 0 };
    case 'IN':     return { name: 'in', width: 1 };
    case 'OUT':    return { name: 'out', width: 1 };
    case 'PROBE':  return { name: 'probe', width: 1, format: 'hex' };
    case 'ROM':    return { addrWidth: 8, dataWidth: 16, contents: [] };
    case 'RAM':    return { addrWidth: 8, dataWidth: 16, contents: [] };
  }
}

/**
 * The pin layout of a primitive. Unlike user components, primitive pin ids are
 * fixed strings, so wires survive a change of width.
 */
export function primSignature(kind: PrimitiveKind, props: InstanceProps): Signature {
  const w = clampWidth(props.width);
  switch (kind) {
    case 'NAND':
      return {
        inputs: [pin('a', 'a', 1), pin('b', 'b', 1)],
        outputs: [pin('y', 'y', 1)],
      };
    case 'CLOCK':
      return { inputs: [], outputs: [pin('clk', 'clk', 1)] };
    case 'TOGGLE':
      return { inputs: [], outputs: [pin('out', asIdentifier(props.name || 'sw', 'sw'), w)] };
    // Named `out`, not named after its value: a pin's name is what the text
    // form writes after the dot, and `const1.0` is not something the parser can
    // read back. The value is on the box already.
    case 'CONST':
      return { inputs: [], outputs: [pin('out', 'out', w)] };
    case 'IN':
      return { inputs: [], outputs: [pin('out', asIdentifier(props.name || 'in', 'in'), w)] };
    case 'OUT':
      return { inputs: [pin('in', asIdentifier(props.name || 'out', 'out'), w)], outputs: [] };
    case 'PROBE':
      return { inputs: [pin('in', asIdentifier(props.name || 'probe', 'probe'), w)], outputs: [] };
    // Pin names stay plain -- the width belongs to the pin, not to its name,
    // and a name like `addr[8]` cannot be written in the text editor because
    // brackets already mean a bit range there. The box shows the size anyway.
    case 'ROM': {
      const aw = clampWidth(props.addrWidth, 8);
      const dw = clampWidth(props.dataWidth, 16);
      return {
        inputs: [pin('addr', 'addr', aw)],
        outputs: [pin('data', 'data', dw)],
      };
    }
    case 'RAM': {
      const aw = clampWidth(props.addrWidth, 8);
      const dw = clampWidth(props.dataWidth, 16);
      return {
        inputs: [
          pin('addr', 'addr', aw),
          pin('in', 'in', dw),
          pin('load', 'load', 1),
          pin('clk', 'clk', 1),
        ],
        outputs: [pin('out', 'out', dw)],
      };
    }
  }
}

function pin(id: string, name: string, width: number) {
  return { id, name, width };
}

/**
 * What a primitive is called on screen and in the text form.
 *
 * The internal kind stays upper case because it is baked into stored ids and
 * into every saved project, so this table is the one place the two spellings
 * meet. ROM and RAM keep their capitals: they are initialisms, not words.
 */
const NAMES: Record<PrimitiveKind, string> = {
  NAND: 'Nand',
  CLOCK: 'Clock',
  TOGGLE: 'Toggle',
  CONST: 'Const',
  IN: 'In',
  OUT: 'Out',
  PROBE: 'Probe',
  ROM: 'ROM',
  RAM: 'RAM',
};

export function primName(kind: PrimitiveKind): string {
  return NAMES[kind];
}

/** Display label for a placed instance. */
export function primLabel(inst: Instance): string {
  const kind = primKind(inst.def);
  switch (kind) {
    case 'NAND':   return 'Nand';
    case 'CLOCK':  return `Clk/${inst.props.period ?? 16}`;
    case 'TOGGLE': return inst.props.name || 'sw';
    case 'CONST':  return `${inst.props.value ?? 0}`;
    case 'IN':     return inst.props.name || 'in';
    case 'OUT':    return inst.props.name || 'out';
    case 'PROBE':  return inst.props.name || 'probe';
    case 'ROM':    return 'ROM';
    case 'RAM':    return 'RAM';
  }
}

/**
 * The label a part carries because the author typed it, rather than because
 * one was generated. Ports, toggles and probes already show their name as the
 * box label, so for those there is nothing extra to display.
 */
export function customLabel(inst: Instance): string | null {
  if (isPrim(inst.def)) {
    const kind = primKind(inst.def);
    if (kind === 'IN' || kind === 'OUT' || kind === 'TOGGLE' || kind === 'PROBE') return null;
  }
  const name = inst.props.name;
  return typeof name === 'string' && name ? name : null;
}

/** Which primitives make sense to offer in the palette, in display order. */
export const PALETTE_PRIMITIVES: PrimitiveKind[] =
  ['NAND', 'IN', 'OUT', 'TOGGLE', 'CONST', 'CLOCK', 'PROBE', 'ROM', 'RAM'];
