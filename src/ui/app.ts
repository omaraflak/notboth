import { compile, type Netlist } from '../core/compile';
import { Simulator } from '../core/sim';
import { newId } from '../core/ids';
import {
  createProject, getDef, nameNewInstances, requireDef,
} from '../core/project';
import { getLastOpen, listProjects, loadProject, saveProject, setLastOpen } from '../core/storage';
import type { ComponentDef, Id, Instance, Project, Wire } from '../core/types';

export type Channel = 'project' | 'selection' | 'view' | 'sim' | 'tick' | 'toast';

export interface Selection {
  instances: Set<Id>;
  wires: Set<Id>;
}

export interface View { tx: number; ty: number; zoom: number }

/** Which editor is showing. Both edit the same component. */
export type EditorMode = 'schematic' | 'code' | 'tests';

/** Ticks per second. The last entry runs as fast as one frame allows. */
export const SPEEDS = [1, 2, 5, 10, 25, 60, 150, 400, 1_000, 4_000, 20_000, Infinity];
const FRAME_BUDGET_MS = 6;

export class App {
  project: Project;
  selection: Selection = { instances: new Set(), wires: new Set() };
  view: View = { tx: 0, ty: 0, zoom: 1 };
  /** Component armed in the library, waiting to be placed on the canvas. */
  armed: Id | null = null;
  /** Schematic or text -- two editors for the same component. */
  mode: EditorMode = 'schematic';
  clipboard: { instances: Instance[]; wires: Wire[] } | null = null;

  netlist: Netlist | null = null;
  compileMs = 0;
  sim: Simulator | null = null;
  powered = false;
  running = false;
  speedIndex = 5;

  private undoStack: Project[] = [];
  private redoStack: Project[] = [];
  private listeners = new Map<Channel, Set<() => void>>();
  private compileTimer: number | null = null;
  private saveTimer: number | null = null;
  private rafId: number | null = null;
  private lastFrame = 0;
  private tickCarry = 0;

  toastText: string | null = null;
  toastKind: 'info' | 'err' = 'info';
  private toastTimer: number | null = null;

  constructor(project: Project) {
    this.project = project;
    this.scheduleCompile(0);
  }

  static async boot(): Promise<App> {
    let project: Project | undefined;
    try {
      const last = await getLastOpen();
      if (last) project = await loadProject(last);
      if (!project) project = (await listProjects())[0];
    } catch { /* first run, or storage unavailable */ }
    if (!project) {
      project = createProject('My Computer');
      await saveProject(project).catch(() => {});
    }
    await setLastOpen(project.id).catch(() => {});
    return new App(project);
  }

  /* ---------------- events ---------------- */

  /** Returns the way to stop listening, for anything that does not outlive the app. */
  on(channel: Channel, fn: () => void): () => void {
    let set = this.listeners.get(channel);
    if (!set) { set = new Set(); this.listeners.set(channel, set); }
    set.add(fn);
    return () => { set!.delete(fn); };
  }

  emit(...channels: Channel[]) {
    for (const c of channels) for (const fn of this.listeners.get(c) ?? []) fn();
  }

  toast(text: string, kind: 'info' | 'err' = 'info') {
    this.toastText = text;
    this.toastKind = kind;
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toastText = null;
      this.emit('toast');
    }, kind === 'err' ? 4200 : 2200);
    this.emit('toast');
  }

  /* ---------------- open component ---------------- */

  get openDef(): ComponentDef {
    const d = this.project.openDefId ? getDef(this.project, this.project.openDefId) : undefined;
    if (d) return d;
    const first = this.project.defs[0] ?? requireDef(this.project, '');
    this.project.openDefId = first.id;
    return first;
  }

  setMode(mode: EditorMode) {
    if (this.mode === mode) return;
    this.mode = mode;
    this.emit('view');
  }

  openComponent(id: Id) {
    if (this.project.openDefId === id) return;
    this.project.openDefId = id;
    this.clearSelection();
    this.armed = null;
    this.scheduleCompile();
    this.persist();
    this.emit('project', 'selection');
  }

  /* ---------------- mutation and history ---------------- */

  /**
   * Every edit goes through here. Snapshotting the whole project keeps undo
   * trivially correct across library operations as well as canvas edits.
   */
  mutate(fn: () => void) {
    const before = structuredClone(this.project);
    fn();
    this.project.updatedAt = Date.now();
    this.undoStack.push(before);
    if (this.undoStack.length > 80) this.undoStack.shift();
    this.redoStack.length = 0;
    this.afterChange();
  }

  undo() {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(structuredClone(this.project));
    this.project = prev;
    this.pruneSelection();
    this.afterChange();
  }

  redo() {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(structuredClone(this.project));
    this.project = next;
    this.pruneSelection();
    this.afterChange();
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  private afterChange() {
    this.scheduleCompile();
    this.persist();
    this.emit('project', 'selection');
  }

  private pruneSelection() {
    const def = this.openDef;
    const ids = new Set(def.instances.map((i) => i.id));
    for (const id of [...this.selection.instances]) if (!ids.has(id)) this.selection.instances.delete(id);
    const wireIds = new Set(def.wires.map((w) => w.id));
    for (const id of [...this.selection.wires]) if (!wireIds.has(id)) this.selection.wires.delete(id);
  }

  /* ---------------- selection ---------------- */

  clearSelection() {
    if (!this.selection.instances.size && !this.selection.wires.size) return;
    this.selection.instances.clear();
    this.selection.wires.clear();
    this.emit('selection');
  }

  selectInstance(id: Id, additive = false) {
    if (!additive) { this.selection.instances.clear(); this.selection.wires.clear(); }
    if (additive && this.selection.instances.has(id)) this.selection.instances.delete(id);
    else this.selection.instances.add(id);
    this.wiresFollowParts();
    this.emit('selection');
  }

  /**
   * Whatever is wired to a selected part is selected with it.
   *
   * Picking a gate is really picking a gate *and how it is connected* -- that
   * is what you are looking at when you click one -- so the wires light up
   * with it rather than staying grey. While parts are selected the wire set is
   * entirely theirs; a wire clicked on its own is only kept when nothing else
   * is selected, which is the only time it was picked deliberately.
   */
  wiresFollowParts() {
    const parts = this.selection.instances;
    if (!parts.size) { this.selection.wires.clear(); return; }
    this.selection.wires.clear();
    for (const w of this.openDef.wires) {
      if (parts.has(w.from.inst) || parts.has(w.to.inst)) this.selection.wires.add(w.id);
    }
  }

  selectWire(id: Id, additive = false) {
    if (!additive) { this.selection.instances.clear(); this.selection.wires.clear(); }
    if (additive && this.selection.wires.has(id)) this.selection.wires.delete(id);
    else this.selection.wires.add(id);
    this.emit('selection');
  }

  get selectedInstances(): Instance[] {
    const def = this.openDef;
    return def.instances.filter((i) => this.selection.instances.has(i.id));
  }

  get selectedWires(): Wire[] {
    const def = this.openDef;
    return def.wires.filter((w) => this.selection.wires.has(w.id));
  }

  /* ---------------- clipboard ---------------- */

  copySelection() {
    const def = this.openDef;
    const ids = this.selection.instances;
    if (!ids.size) return;
    this.clipboard = {
      instances: def.instances.filter((i) => ids.has(i.id)).map((i) => structuredClone(i)),
      wires: def.wires
        .filter((w) => ids.has(w.from.inst) && ids.has(w.to.inst))
        .map((w) => structuredClone(w)),
    };
    this.toast(`Copied ${this.clipboard.instances.length} component${this.clipboard.instances.length === 1 ? '' : 's'}`);
  }

  paste(atX: number, atY: number) {
    const clip = this.clipboard;
    if (!clip?.instances.length) return;
    const minX = Math.min(...clip.instances.map((i) => i.x));
    const minY = Math.min(...clip.instances.map((i) => i.y));
    const remap = new Map<Id, Id>();
    const fresh: Instance[] = clip.instances.map((i) => {
      const id = newId('i_');
      remap.set(i.id, id);
      return { ...structuredClone(i), id, x: i.x - minX + atX, y: i.y - minY + atY };
    });
    const wires: Wire[] = clip.wires.map((w) => ({
      ...structuredClone(w),
      id: newId('w_'),
      from: { ...w.from, inst: remap.get(w.from.inst)! },
      to: { ...w.to, inst: remap.get(w.to.inst)! },
    }));
    nameNewInstances(this.openDef, fresh);
    this.mutate(() => {
      const def = this.openDef;
      def.instances.push(...fresh);
      def.wires.push(...wires);
    });
    this.selection.instances = new Set(fresh.map((i) => i.id));
    this.wiresFollowParts();
    this.emit('selection');
  }

  /** Copy the selection in place. Unlike copy+paste this leaves the clipboard
   *  alone, so duplicating does not clobber something you meant to keep. */
  duplicateSelection(dx = 2, dy = 2) {
    const def = this.openDef;
    const ids = this.selection.instances;
    if (!ids.size) return;
    const remap = new Map<Id, Id>();
    const fresh: Instance[] = def.instances
      .filter((i) => ids.has(i.id))
      .map((i) => {
        const id = newId('i_');
        remap.set(i.id, id);
        return { ...structuredClone(i), id, x: i.x + dx, y: i.y + dy };
      });
    const wires: Wire[] = def.wires
      .filter((w) => ids.has(w.from.inst) && ids.has(w.to.inst))
      .map((w) => ({
        ...structuredClone(w),
        id: newId('w_'),
        from: { ...w.from, inst: remap.get(w.from.inst)! },
        to: { ...w.to, inst: remap.get(w.to.inst)! },
      }));
    nameNewInstances(def, fresh);
    this.mutate(() => { def.instances.push(...fresh); def.wires.push(...wires); });
    this.selection.instances = new Set(fresh.map((i) => i.id));
    this.wiresFollowParts();
    this.emit('selection');
  }

  selectAll() {
    const def = this.openDef;
    this.selection.instances = new Set(def.instances.map((i) => i.id));
    this.wiresFollowParts();
    this.emit('selection');
  }

  /* ---------------- compile ---------------- */

  scheduleCompile(delay = 120) {
    if (this.compileTimer) clearTimeout(this.compileTimer);
    this.compileTimer = window.setTimeout(() => {
      this.compileTimer = null;
      this.compileNow();
    }, delay);
  }

  compileNow() {
    const t0 = performance.now();
    this.netlist = compile(this.project, this.openDef.id);
    this.compileMs = performance.now() - t0;
    if (this.powered) this.rebuildSim();
    this.emit('sim');
  }

  private rebuildSim() {
    if (!this.netlist || this.netlist.errors.length) { this.sim = null; return; }
    this.sim = new Simulator(this.netlist);
    this.sim.settle(2000, true);
  }

  /* ---------------- simulation ---------------- */

  get errors() { return this.netlist?.errors ?? []; }

  powerOn() {
    if (this.compileTimer) { clearTimeout(this.compileTimer); this.compileTimer = null; this.compileNow(); }
    if (!this.netlist) this.compileNow();
    if (this.netlist!.errors.length) {
      this.toast('Fix the circuit errors before switching on', 'err');
      return;
    }
    this.powered = true;
    this.rebuildSim();
    this.running = true;
    this.startLoop();
    this.emit('sim');
  }

  powerOff() {
    this.powered = false;
    this.running = false;
    this.sim = null;
    this.stopLoop();
    this.emit('sim', 'tick');
  }

  togglePower() {
    if (this.powered) this.powerOff(); else this.powerOn();
  }

  pause() {
    this.running = false;
    this.stopLoop();
    this.emit('sim');
  }

  resume() {
    if (!this.powered) return this.powerOn();
    this.running = true;
    this.startLoop();
    this.emit('sim');
  }

  stepOnce(ticks = 1) {
    if (!this.powered) this.powerOn();
    this.running = false;
    this.stopLoop();
    this.sim?.run(ticks);
    this.emit('sim', 'tick');
  }

  resetSim() {
    this.sim?.reset();
    this.sim?.settle(2000, true);
    this.emit('sim', 'tick');
  }

  setSpeed(index: number) {
    this.speedIndex = Math.max(0, Math.min(SPEEDS.length - 1, index));
    this.emit('sim');
  }

  get speed(): number { return SPEEDS[this.speedIndex]; }

  private startLoop() {
    if (this.rafId !== null) return;
    this.lastFrame = performance.now();
    this.tickCarry = 0;
    const frame = (now: number) => {
      this.rafId = null;
      if (!this.running || !this.sim) return;
      const dt = Math.min(0.25, (now - this.lastFrame) / 1000);
      this.lastFrame = now;

      const speed = this.speed;
      if (speed === Infinity) {
        const deadline = performance.now() + FRAME_BUDGET_MS;
        do { this.sim.run(64); } while (performance.now() < deadline);
      } else {
        this.tickCarry += dt * speed;
        let budget = Math.floor(this.tickCarry);
        this.tickCarry -= budget;
        const deadline = performance.now() + FRAME_BUDGET_MS;
        while (budget > 0 && performance.now() < deadline) {
          const chunk = Math.min(budget, 256);
          this.sim.run(chunk);
          budget -= chunk;
        }
      }
      this.emit('tick');
      this.rafId = requestAnimationFrame(frame);
    };
    this.rafId = requestAnimationFrame(frame);
  }

  private stopLoop() {
    if (this.rafId !== null) { cancelAnimationFrame(this.rafId); this.rafId = null; }
  }

  /* ---------------- persistence ---------------- */

  persist(immediate = false) {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    const run = () => {
      this.saveTimer = null;
      saveProject(this.project).catch(() => this.toast('Could not save to browser storage', 'err'));
    };
    if (immediate) run();
    else this.saveTimer = window.setTimeout(run, 400);
  }

  async switchProject(project: Project) {
    await saveProject(this.project).catch(() => {});
    this.project = project;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.clearSelection();
    this.powerOff();
    this.view = { tx: 0, ty: 0, zoom: 1 };
    await setLastOpen(project.id).catch(() => {});
    await saveProject(project).catch(() => {});
    this.scheduleCompile(0);
    this.emit('project', 'selection', 'sim');
  }
}
