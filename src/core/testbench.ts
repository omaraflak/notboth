import { compile, type CompileError } from './compile';
import { Simulator } from './sim';
import type { Id, Pin, Project, Signature, TestBench, TestVector } from './types';

export interface VectorResult {
  index: number;
  pass: boolean;
  inputs: Record<string, number>;
  expected: Record<string, number>;
  actual: Record<string, number>;
}

export interface TestRun {
  ran: boolean;
  results: VectorResult[];
  passed: number;
  total: number;
  errors: CompileError[];
  unstable: boolean;
  /** Vector columns that match no pin on the component any more. */
  unknownPins: string[];
}

/**
 * Find the pin a vector column refers to. Ids are the real key; names are
 * accepted so that vectors written before ids were used keep working, and so
 * that a hand-edited exported project stays readable.
 */
export function resolveVectorPin(sig: Signature, side: 'in' | 'out', key: string): Pin | undefined {
  const pins = side === 'in' ? sig.inputs : sig.outputs;
  return pins.find((p) => p.id === key) ?? pins.find((p) => p.name === key);
}

/**
 * Rewrite name-keyed columns to id-keyed ones, and set aside any column whose
 * pin is not there any more instead of throwing it away.
 *
 * Both directions matter. A column whose pin has gone is parked, so that
 * saving the table afterwards cannot quietly delete work; a parked column
 * whose pin has come back is picked up again, so an undo or a redrawn marker
 * restores it. What the caller gets is only the columns that resolve, which
 * is what both the runner and the table want to see.
 */
export function normalizeVectors(
  sig: Signature, vectors: TestVector[],
): { vectors: TestVector[]; unknown: string[] } {
  const unknown = new Set<string>();
  const side = (which: 'in' | 'out', row: Record<string, number>, parked: Record<string, number>) => {
    const live: Record<string, number> = {};
    const held: Record<string, number> = {};
    // Parked first, so a column that has come back is overwritten by the
    // current one rather than the other way round.
    for (const [key, value] of Object.entries({ ...parked, ...row })) {
      const pin = resolveVectorPin(sig, which, key);
      if (pin) live[pin.id] = value;
      else { held[key] = value; unknown.add(key); }
    }
    return { live, held };
  };

  const out = vectors.map((v) => {
    const ins = side('in', v.in, v.orphans?.in ?? {});
    const outs = side('out', v.out, v.orphans?.out ?? {});
    const vector: TestVector = { in: ins.live, out: outs.live };
    if (Object.keys(ins.held).length || Object.keys(outs.held).length) {
      vector.orphans = { in: ins.held, out: outs.held };
    }
    return vector;
  });
  return { vectors: out, unknown: [...unknown] };
}

/**
 * Run a component's test vectors against a freshly compiled netlist.
 *
 * By the time a project has thirty components, a one-gate mistake buried
 * inside an ALU is effectively unfindable by eye. These vectors are how you
 * find it.
 */
export function runTests(project: Project, defId: Id, bench?: TestBench): TestRun {
  const def = project.defs.find((d) => d.id === defId);
  const tests = bench ?? def?.tests;
  const nl = compile(project, defId);
  if (nl.errors.length) {
    return { ran: false, results: [], passed: 0, total: 0, errors: nl.errors, unstable: false, unknownPins: [] };
  }
  if (!tests || !tests.vectors.length) {
    return { ran: false, results: [], passed: 0, total: 0, errors: [], unstable: false, unknownPins: [] };
  }

  const sig = nl.rootSignature;
  const { vectors, unknown } = normalizeVectors(sig, tests.vectors);

  const sim = new Simulator(nl);
  const label = new Map<Id, string>();
  for (const pin of [...sig.inputs, ...sig.outputs]) label.set(pin.id, pin.name);

  const results: VectorResult[] = [];
  let passed = 0;
  let unstable = false;

  for (let i = 0; i < vectors.length; i++) {
    const v = vectors[i];
    if (tests.resetEachVector) sim.reset();

    for (const [pinId, value] of Object.entries(v.in)) {
      const nets = nl.rootInputs.get(pinId);
      if (nets) sim.writeNets(nets, value >>> 0);
    }

    if (tests.settleTicks && tests.settleTicks > 0) {
      sim.run(tests.settleTicks, false);
    } else if (!sim.settle(20000, true)) {
      unstable = true;
    }

    // Reported back under the pin's current name, which is what you read.
    const inputs: Record<string, number> = {};
    for (const [pinId, value] of Object.entries(v.in)) inputs[label.get(pinId) ?? pinId] = value;

    const expected: Record<string, number> = {};
    const actual: Record<string, number> = {};
    let pass = true;
    for (const [pinId, want] of Object.entries(v.out)) {
      const name = label.get(pinId) ?? pinId;
      const nets = nl.rootOutputs.get(pinId);
      const got = nets ? sim.readNets(nets) : 0;
      expected[name] = want;
      actual[name] = got;
      if (got !== (want >>> 0)) pass = false;
    }
    if (pass) passed++;
    results.push({ index: i, pass, inputs, expected, actual });
  }

  return {
    ran: true, results, passed, total: vectors.length,
    errors: [], unstable, unknownPins: unknown,
  };
}
