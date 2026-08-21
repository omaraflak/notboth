/**
 * Core data model.
 *
 * Two representations exist in this app and they are deliberately different:
 *
 *  - The *editor* world (this file) is hierarchical. A component definition
 *    contains instances of other definitions, pins have widths, and one wire
 *    can carry many bits.
 *  - The *simulator* world (see compile.ts / sim.ts) is flat. Everything is
 *    inlined down to single-bit nets and NAND gates. Buses exist purely as an
 *    authoring convenience and cease to exist at compile time.
 */

export type Id = string;

/** The only built-in building blocks. Everything with logic in it is NAND. */
export type PrimitiveKind =
  | 'NAND'   // the one true gate: 1-bit, no settings, 1 tick of delay
  | 'CLOCK'  // periodic square wave, period measured in simulation ticks
  | 'TOGGLE' // manual power supply / input switch
  | 'CONST'  // fixed 0 or 1, for tying inputs high or low inside a subcircuit
  | 'IN'     // port marker: declares an input pin of the enclosing component
  | 'OUT'    // port marker: declares an output pin of the enclosing component
  | 'PROBE'  // readout
  | 'ROM'    // combinational lookup, holds the program
  | 'RAM';   // async read, synchronous write on the rising edge of clk

export const PRIM_PREFIX = 'prim:';

export const PRIMITIVE_KINDS: PrimitiveKind[] = [
  'NAND', 'CLOCK', 'TOGGLE', 'CONST', 'IN', 'OUT', 'PROBE', 'ROM', 'RAM',
];

export const MAX_WIDTH = 32;

export interface Pin {
  /** For user components this is the id of the IN/OUT marker instance, so the
   *  pin identity survives renames. For primitives it is a fixed string. */
  id: Id;
  name: string;
  width: number;
}

export interface Signature {
  inputs: Pin[];
  outputs: Pin[];
}

/**
 * Per-instance configuration. Only ever populated for parameterised
 * primitives -- NAND, CONST and every user-built component have no settings.
 */
export interface InstanceProps {
  name?: string;
  width?: number;
  /** Current value of a TOGGLE, or the fixed value of a CONST. */
  value?: number;
  /** CLOCK: full period in ticks (toggles every period/2). */
  period?: number;
  addrWidth?: number;
  dataWidth?: number;
  /** ROM/RAM initial contents, indexed by address. */
  contents?: number[];
  format?: NumberFormat;
}

export type NumberFormat = 'bin' | 'hex' | 'dec' | 'sdec';

export interface Instance {
  id: Id;
  /** Either `prim:KIND` or the id of a user ComponentDef. */
  def: Id;
  /** Position in grid cells, not pixels. */
  x: number;
  y: number;
  props: InstanceProps;
}

/** One end of a wire, optionally addressing a sub-range of a bus pin. */
export interface Endpoint {
  inst: Id;
  pin: Id;
  /** Least significant bit of the slice, inclusive. */
  lo: number;
  /** Most significant bit of the slice, inclusive. */
  hi: number;
}

export interface Wire {
  id: Id;
  /** Driver side: must be an output pin of `from.inst`. */
  from: Endpoint;
  /** Sink side: must be an input pin of `to.inst`. */
  to: Endpoint;
  /** User-chosen hue. The simulator controls brightness, not colour. */
  color?: string;
  via?: Point[];
}

export interface Point { x: number; y: number }

export interface TestVector {
  /**
   * Keyed by input pin id -- the IN marker's instance id -- so that renaming a
   * port cannot silently break the tests. Vectors written before this was true
   * are keyed by name, and are matched by name as a fallback.
   */
  in: Record<string, number>;
  /** Keyed by output pin id, same reasoning. */
  out: Record<string, number>;
}

export interface TestBench {
  vectors: TestVector[];
  /**
   * Ticks to run after applying each vector. Omit for combinational logic,
   * where the runner settles until quiescent instead.
   */
  settleTicks?: number;
  /** Reset the simulator between vectors. Off by default so sequential
   *  circuits can be driven as a sequence of steps. */
  resetEachVector?: boolean;
}

export interface ComponentDef {
  id: Id;
  name: string;
  folder: Id | null;
  instances: Instance[];
  wires: Wire[];
  tests?: TestBench;
  /** Wall-clock of last edit, for sorting recents. */
  updatedAt?: number;
}

export interface Folder {
  id: Id;
  name: string;
  parent: Id | null;
}

export interface Project {
  id: Id;
  name: string;
  folders: Folder[];
  defs: ComponentDef[];
  openDefId: Id | null;
  createdAt: number;
  updatedAt: number;
}

export const SCHEMA_VERSION = 1;

export interface ProjectFile {
  schema: number;
  project: Project;
}
