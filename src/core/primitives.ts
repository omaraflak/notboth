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
      return { inputs: [], outputs: [pin('out', props.name || 'sw', w)] };
    case 'CONST':
      return { inputs: [], outputs: [pin('out', String(props.value ?? 0), w)] };
    case 'IN':
      return { inputs: [], outputs: [pin('out', props.name || 'in', w)] };
    case 'OUT':
      return { inputs: [pin('in', props.name || 'out', w)], outputs: [] };
    case 'PROBE':
      return { inputs: [pin('in', props.name || 'probe', w)], outputs: [] };
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

/** Display label for a placed instance. */
export function primLabel(inst: Instance): string {
  const kind = primKind(inst.def);
  switch (kind) {
    case 'NAND':   return 'NAND';
    case 'CLOCK':  return `CLK/${inst.props.period ?? 16}`;
    case 'TOGGLE': return inst.props.name || 'sw';
    case 'CONST':  return `${inst.props.value ?? 0}`;
    case 'IN':     return inst.props.name || 'in';
    case 'OUT':    return inst.props.name || 'out';
    case 'PROBE':  return inst.props.name || 'probe';
    case 'ROM':    return 'ROM';
    case 'RAM':    return 'RAM';
  }
}

/** Which primitives make sense to offer in the palette, in display order. */
export const PALETTE_PRIMITIVES: PrimitiveKind[] =
  ['NAND', 'IN', 'OUT', 'TOGGLE', 'CONST', 'CLOCK', 'PROBE', 'ROM', 'RAM'];
