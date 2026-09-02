import { describe, expect, it } from 'vitest';
import { addPrimitive, createProject, emptyDef, isUntouched } from '../src/core/project';

describe('isUntouched', () => {
  it('is true for a project straight out of the box', () => {
    // Not an empty project: a new one already holds one component to open into.
    const p = createProject('t');
    expect(p.defs).toHaveLength(1);
    expect(isUntouched(p)).toBe(true);
  });

  it('is false once a single gate has been placed', () => {
    const p = createProject('t');
    addPrimitive(p.defs[0], 'NAND', 0, 0);
    expect(isUntouched(p)).toBe(false);
  });

  it('is false once a second component exists, even an empty one', () => {
    const p = createProject('t');
    p.defs.push(emptyDef('Not', null));
    expect(isUntouched(p)).toBe(false);
  });

  it('is true again when everything built has been taken back out', () => {
    const p = createProject('t');
    addPrimitive(p.defs[0], 'NAND', 0, 0);
    p.defs[0].instances = [];
    expect(isUntouched(p)).toBe(true);
  });
});
