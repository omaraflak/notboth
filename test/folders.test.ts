import { describe, expect, it } from 'vitest';
import {
  createFolder, deleteFolder, emptyDef, folderContains, folderPath,
} from '../src/core/project';
import { createProject } from '../src/core/project';
import type { Project } from '../src/core/types';

/** Two branches, so a move can be tried both along one and across them. */
function tree(): Project & { ids: Record<string, string> } {
  const p = createProject('t');
  p.defs = [];
  p.folders = [];
  const gates = createFolder(p, 'Gates');
  const logic = createFolder(p, 'Logic', gates.id);
  const deep = createFolder(p, 'Deep', logic.id);
  const maths = createFolder(p, 'Maths');
  return Object.assign(p, {
    ids: { gates: gates.id, logic: logic.id, deep: deep.id, maths: maths.id },
  });
}

describe('folderContains', () => {
  it('finds a folder inside itself', () => {
    const p = tree();
    expect(folderContains(p, p.ids.gates, p.ids.gates)).toBe(true);
  });

  it('finds a folder nested any distance down', () => {
    const p = tree();
    expect(folderContains(p, p.ids.gates, p.ids.logic)).toBe(true);
    expect(folderContains(p, p.ids.gates, p.ids.deep)).toBe(true);
  });

  it('does not look upwards, or across', () => {
    const p = tree();
    expect(folderContains(p, p.ids.deep, p.ids.gates)).toBe(false);
    expect(folderContains(p, p.ids.gates, p.ids.maths)).toBe(false);
  });

  it('treats the top level as inside nothing', () => {
    const p = tree();
    expect(folderContains(p, p.ids.gates, null)).toBe(false);
  });

  // This is what the check is for: dragging Gates into its own descendant
  // would leave a ring of folders with no way back to the top.
  it('refuses the move that would make a cycle', () => {
    const p = tree();
    const wouldCycle = folderContains(p, p.ids.gates, p.ids.deep);
    expect(wouldCycle).toBe(true);
  });

  it('gives an answer rather than spinning on a tree that is already a ring', () => {
    const p = tree();
    p.folders.find((f) => f.id === p.ids.gates)!.parent = p.ids.deep;
    expect(folderContains(p, p.ids.maths, p.ids.deep)).toBe(false);
  });
});

describe('moving things between folders', () => {
  it('re-parents a folder without disturbing what is inside it', () => {
    const p = tree();
    const logic = p.folders.find((f) => f.id === p.ids.logic)!;
    logic.parent = p.ids.maths;
    expect(folderPath(p, p.ids.deep)).toBe('Maths/Logic/Deep');
  });

  it('lifts everything up a level when a folder is deleted', () => {
    const p = tree();
    const def = emptyDef('Xor', p.ids.logic);
    p.defs.push(def);

    deleteFolder(p, p.ids.logic);

    expect(p.folders.some((f) => f.id === p.ids.logic)).toBe(false);
    // The component and the sub-folder both land in Logic's own parent.
    expect(def.folder).toBe(p.ids.gates);
    expect(p.folders.find((f) => f.id === p.ids.deep)!.parent).toBe(p.ids.gates);
  });

  it('sends the contents of a top-level folder to the top level', () => {
    const p = tree();
    const def = emptyDef('Xor', p.ids.maths);
    p.defs.push(def);
    deleteFolder(p, p.ids.maths);
    expect(def.folder).toBe(null);
  });
});
