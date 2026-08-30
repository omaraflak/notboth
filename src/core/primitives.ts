import { GRID } from './layout';
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
    case 'NAND': return {};
    case 'CLOCK': return { period: 16 };
    case 'CONST': return { width: 1, value: 0 };
    case 'IN': return { name: 'in', width: 1, value: 0, format: 'hex' };
    case 'OUT': return { name: 'out', width: 1, format: 'hex' };
    case 'PROBE': return { name: 'probe', width: 1, format: 'hex' };
    case 'ROM': return { addrWidth: 8, dataWidth: 16, contents: [] };
    case 'RAM': return { addrWidth: 8, dataWidth: 16, contents: [] };
    case 'SCREEN': return { pxWidth: 128, pxHeight: 96 };
  }
}

/* ------------------------------------------------------------------ *
 * Screen geometry
 *
 * One 16-bit word per pixel, so the address a program writes to *is* the
 * pixel: `addr = y * pxWidth + x`. Nothing packs, nothing is masked, and the
 * whole colour fits in the 15 bits.
 * ------------------------------------------------------------------ */

export function screenSize(props: InstanceProps): { w: number; h: number } {
  const w = Math.min(1024, Math.max(1, Math.floor(Number(props.pxWidth ?? 128)) || 128));
  const h = Math.min(1024, Math.max(1, Math.floor(Number(props.pxHeight ?? 96)) || 96));
  return { w, h };
}

export function screenWords(props: InstanceProps): number {
  const { w, h } = screenSize(props);
  return w * h;
}

/** The narrowest address that can reach every pixel. */
export function fittedAddrWidth(props: InstanceProps): number {
  const words = screenWords(props);
  let bits = 1;
  while ((1 << bits) < words && bits < 20) bits++;
  return bits;
}

/**
 * How wide the screen's address pin is. It defaults to whatever the pixels
 * need, so a screen you drop on the grid is the right size without being told.
 * Set it and the screen takes that many bits instead, which is how you wire a
 * whole address bus straight into it and let something upstream decide which
 * addresses land here.
 */
export function screenAddrWidth(props: InstanceProps): number {
  if (props.addrWidth === undefined) return fittedAddrWidth(props);
  return clampWidth(props.addrWidth, fittedAddrWidth(props));
}

/**
 * The area a part reserves inside its box for something painted, in grid
 * cells. Only a screen has one; everything else is text and pins.
 */
export function viewportCells(inst: Instance): { w: number; h: number } | null {
  if (!isPrim(inst.def) || primKind(inst.def) !== 'SCREEN') return null;
  const { w, h } = screenSize(inst.props);
  return { w: Math.ceil(w / GRID), h: Math.ceil(h / GRID) };
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
    // Deliberately the same pins as RAM, in the same order. A screen is a RAM
    // you can see, so anything you know about wiring one wires the other.
    case 'SCREEN':
      return {
        inputs: [
          pin('addr', 'addr', screenAddrWidth(props)),
          pin('in', 'in', 16),
          pin('load', 'load', 1),
          pin('clk', 'clk', 1),
        ],
        outputs: [pin('out', 'out', 16)],
      };
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
  CONST: 'Const',
  IN: 'In',
  OUT: 'Out',
  PROBE: 'Probe',
  ROM: 'ROM',
  RAM: 'RAM',
  SCREEN: 'Screen',
};

export function primName(kind: PrimitiveKind): string {
  return NAMES[kind];
}

/** Display label for a placed instance. */
export function primLabel(inst: Instance): string {
  const kind = primKind(inst.def);
  switch (kind) {
    case 'NAND': return 'Nand';
    case 'CLOCK': return `Clk/${inst.props.period ?? 16}`;
    case 'CONST': return `${inst.props.value ?? 0}`;
    case 'IN': return inst.props.name || 'in';
    case 'OUT': return inst.props.name || 'out';
    case 'PROBE': return inst.props.name || 'probe';
    case 'ROM': return 'ROM';
    case 'RAM': return 'RAM';
    case 'SCREEN': return 'Screen';
  }
}

/**
 * The label to draw on a part's box, or null for the usual case of none. Every
 * part has a label -- it is what the text form calls it -- but showing it is
 * opt-in per part, so a schematic only carries the names worth carrying.
 *
 * Ports, toggles and probes are excluded because their name is already their
 * box label; there is nothing extra to show.
 */
export function customLabel(inst: Instance): string | null {
  if (!inst.props.showName) return null;
  if (isPrim(inst.def)) {
    const kind = primKind(inst.def);
    if (kind === 'IN' || kind === 'OUT' || kind === 'PROBE') return null;
  }
  const name = inst.props.name;
  return typeof name === 'string' && name ? name : null;
}

/** Which primitives make sense to offer in the palette, in display order. */
export const PALETTE_PRIMITIVES: PrimitiveKind[] =
  ['NAND', 'IN', 'OUT', 'CONST', 'CLOCK', 'PROBE', 'ROM', 'RAM', 'SCREEN'];
