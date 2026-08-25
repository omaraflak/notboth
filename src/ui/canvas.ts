import {
  GRID, NAME_FONT, PIN_FONT, distanceToPolyline, formatValue, layoutBox, planRoutes, routeWire,
  showPinLabel, sliceLabel,
  type BoxLayout, type Measure, type PinLayout, type RoutePlan, type WireGeom,
} from '../core/layout';
import { arrangeDef } from '../core/autolayout';
import { clampWidth, customLabel, isPrim, primKind, primLabel } from '../core/primitives';
import {
  connect, defSignature, makeInstance, nameNewInstances, nextFreeBits, removeInstances, removeWires,
  wouldRecurse,
} from '../core/project';
import type { Id, Instance, Point, Signature, Wire } from '../core/types';
import type { App } from './app';
import { contextMenu, memoryEditor, type MenuItem } from './dialogs';
import { mix, onThemeChange, palette } from './theme';

interface Placed {
  inst: Instance;
  sig: Signature;
  box: BoxLayout;
}

interface PinHit { inst: Instance; pin: PinLayout }

interface Simulatorish { net: Uint8Array }

type Drag =
  | { kind: 'none' }
  | { kind: 'pan'; sx: number; sy: number; tx: number; ty: number }
  | { kind: 'move'; sx: number; sy: number; origin: Map<Id, Point>; moved: boolean }
  | { kind: 'band'; x0: number; y0: number; x1: number; y1: number; additive: boolean }
  | { kind: 'wire'; from: PinHit; cursor: Point };

const MONO = 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace';

export class CanvasView {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private grid: HTMLCanvasElement;
  private gridCtx: CanvasRenderingContext2D;
  private gridStale = true;
  private measure: Measure;
  private measureCache = new Map<string, number>();
  private dirty = true;
  private raf: number | null = null;

  private placed: Placed[] = [];
  private byId = new Map<Id, Placed>();
  private routes: RoutePlan = { paths: new Map(), junctions: [] };
  private placedStale = true;
  private drag: Drag = { kind: 'none' };
  private hoverPin: PinHit | null = null;
  private spaceHeld = false;
  private cursor: Point = { x: 0, y: 0 };
  private shownDefId: Id | null = null;

  constructor(
    private app: App,
    private host: HTMLElement,
    private actions: { extract: () => void },
  ) {
    this.canvas = document.createElement('canvas');
    this.host.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d', { alpha: false })!;
    this.grid = document.createElement('canvas');
    this.gridCtx = this.grid.getContext('2d', { alpha: false })!;

    const probe = document.createElement('canvas').getContext('2d')!;
    this.measure = (text, font) => {
      const key = `${font} ${text}`;
      let w = this.measureCache.get(key);
      if (w === undefined) {
        probe.font = font;
        w = probe.measureText(text).width;
        this.measureCache.set(key, w);
      }
      return w;
    };

    new ResizeObserver(() => this.resize()).observe(this.host);
    this.resize();
    this.bind();

    app.on('project', () => {
      this.placedStale = true;
      // Opening a different component should show you that component, not
      // whatever corner of the canvas you happened to be looking at.
      if (this.shownDefId !== app.openDef.id) {
        this.shownDefId = app.openDef.id;
        this.fit();
      }
      this.invalidate();
    });
    app.on('selection', () => this.invalidate());
    app.on('sim', () => this.invalidate());
    app.on('tick', () => this.invalidate());
    onThemeChange(() => { this.gridStale = true; this.invalidate(); });
  }

  invalidate() {
    this.dirty = true;
    if (this.raf === null) {
      this.raf = requestAnimationFrame(() => { this.raf = null; this.render(); });
    }
  }

  /* ---------------- coordinates ---------------- */

  private get view() { return this.app.view; }

  /** Screen pixels to grid cells (fractional). */
  private toGrid(sx: number, sy: number): Point {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: ((sx - r.left) - this.view.tx) / this.view.zoom / GRID,
      y: ((sy - r.top) - this.view.ty) / this.view.zoom / GRID,
    };
  }

  fit() {
    this.placedStale = true;
    this.shownDefId = this.app.openDef.id;
    // Measure the host, not the canvas: the canvas carries an explicit width
    // from the last resize, which may predate a layout change (a panel
    // appearing, say). Reading the host forces a fresh layout.
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    // At boot the stylesheet may not have laid the shell out yet; fitting to a
    // zero-sized canvas would park the circuit off-screen.
    if (width < 40 || height < 40) {
      requestAnimationFrame(() => this.fit());
      return;
    }
    this.buildPlaced();
    if (!this.placed.length) {
      this.app.view = { tx: 80, ty: 80, zoom: 1 };
      this.gridStale = true;
      this.invalidate();
      return;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of this.placed) {
      minX = Math.min(minX, p.inst.x); minY = Math.min(minY, p.inst.y);
      maxX = Math.max(maxX, p.inst.x + p.box.w); maxY = Math.max(maxY, p.inst.y + p.box.h);
    }
    const zoom = Math.min(2, Math.max(0.2, Math.min(
      Math.max(1, width - 120) / Math.max(1, (maxX - minX) * GRID),
      Math.max(1, height - 120) / Math.max(1, (maxY - minY) * GRID),
    )));
    this.view.zoom = zoom;
    this.view.tx = width / 2 - ((minX + maxX) / 2) * GRID * zoom;
    this.view.ty = height / 2 - ((minY + maxY) / 2) * GRID * zoom;
    this.gridStale = true;
    this.invalidate();
  }

  zoomBy(factor: number) {
    const w = this.canvas.clientWidth / 2, h = this.canvas.clientHeight / 2;
    const before = { x: (w - this.view.tx) / this.view.zoom, y: (h - this.view.ty) / this.view.zoom };
    this.view.zoom = Math.max(0.15, Math.min(4, this.view.zoom * factor));
    this.view.tx = w - before.x * this.view.zoom;
    this.view.ty = h - before.y * this.view.zoom;
    this.gridStale = true;
    this.invalidate();
  }

  /* ---------------- layout ---------------- */

  /** Rebuild the layout cache if an edit has invalidated it. Hit testing runs
   *  from user input, which can arrive before the next paint. */
  private ensurePlaced() {
    if (this.placedStale) this.buildPlaced();
  }

  private buildPlaced() {
    this.placedStale = false;
    const app = this.app;
    const def = app.openDef;
    this.placed = def.instances.map((inst) => {
      const sig = defSignature(app.project, inst.def, inst.props);
      const name = isPrim(inst.def) ? primLabel(inst) : (nameOfDef(app, inst.def) ?? '?');
      return { inst, sig, box: layoutBox(sig, name, this.measure, customLabel(inst)) };
    });
    this.byId = new Map(this.placed.map((p) => [p.inst.id, p]));
    this.planRouting();
  }

  /** Route every wire together, so distinct signals never share a channel. */
  private planRouting() {
    const geoms: WireGeom[] = [];
    for (const w of this.app.openDef.wires) {
      const from = this.endpointPoint(w.from);
      const to = this.endpointPoint(w.to);
      if (!from || !to) continue;
      geoms.push({
        id: w.id,
        net: `${w.from.inst}:${w.from.pin}:${w.from.lo}-${w.from.hi}`,
        from,
        to,
        via: w.via,
        fromInst: w.from.inst,
        toInst: w.to.inst,
      });
    }
    // Parts are handed to the router as space to keep out of, so a wire is
    // never drawn straight through a box that has nothing to do with it.
    const obstacles = this.placed.map((p) => ({
      id: p.inst.id,
      x0: p.inst.x, y0: p.inst.y,
      x1: p.inst.x + p.box.w, y1: p.inst.y + p.box.h,
    }));
    this.routes = planRoutes(geoms, obstacles);
  }

  private pinPoint(p: Placed, pin: PinLayout): Point {
    return { x: p.inst.x + pin.x, y: p.inst.y + pin.y };
  }

  private endpointPoint(e: { inst: Id; pin: Id }): Point | null {
    const p = this.byId.get(e.inst);
    if (!p) return null;
    const pin = p.box.pins.find((x) => x.pin.id === e.pin);
    return pin ? this.pinPoint(p, pin) : null;
  }

  private wirePath(w: Wire): Point[] | null {
    const planned = this.routes.paths.get(w.id);
    if (planned) return planned;
    const a = this.endpointPoint(w.from);
    const b = this.endpointPoint(w.to);
    if (!a || !b) return null;
    return routeWire(a, b, w.via ?? []);
  }

  /* ---------------- hit testing ---------------- */

  private hitPin(g: Point): PinHit | null {
    this.ensurePlaced();
    const r = 0.45;
    for (let i = this.placed.length - 1; i >= 0; i--) {
      const p = this.placed[i];
      for (const pin of p.box.pins) {
        const pt = this.pinPoint(p, pin);
        if (Math.abs(pt.x - g.x) <= r && Math.abs(pt.y - g.y) <= r) return { inst: p.inst, pin };
      }
    }
    return null;
  }

  private hitInstance(g: Point): Placed | null {
    this.ensurePlaced();
    for (let i = this.placed.length - 1; i >= 0; i--) {
      const p = this.placed[i];
      if (g.x >= p.inst.x && g.x <= p.inst.x + p.box.w && g.y >= p.inst.y && g.y <= p.inst.y + p.box.h) return p;
    }
    return null;
  }

  private hitWire(g: Point): Wire | null {
    this.ensurePlaced();
    const tol = Math.max(0.22, 6 / (GRID * this.view.zoom));
    const def = this.app.openDef;
    for (let i = def.wires.length - 1; i >= 0; i--) {
      const path = this.wirePath(def.wires[i]);
      if (path && distanceToPolyline(path, g) <= tol) return def.wires[i];
    }
    return null;
  }

  /* ---------------- input ---------------- */

  private bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this.onDown(e));
    c.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', (e) => this.onUp(e));
    c.addEventListener('dblclick', (e) => this.onDoubleClick(e));
    c.addEventListener('contextmenu', (e) => { e.preventDefault(); this.onContextMenu(e); });
    c.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !isTyping(e.target)) { this.spaceHeld = true; e.preventDefault(); }
    });
    window.addEventListener('keyup', (e) => { if (e.code === 'Space') this.spaceHeld = false; });
  }

  private onDown(e: PointerEvent) {
    const g = this.toGrid(e.clientX, e.clientY);
    this.cursor = g;
    this.canvas.setPointerCapture(e.pointerId);

    if (e.button === 1 || this.spaceHeld || (e.button === 0 && e.altKey)) {
      this.drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, tx: this.view.tx, ty: this.view.ty };
      return;
    }
    if (e.button !== 0) return;

    if (this.app.armed) {
      this.place(this.app.armed, Math.round(g.x), Math.round(g.y));
      if (!e.shiftKey) { this.app.armed = null; this.app.emit('project'); }
      return;
    }

    const pin = this.hitPin(g);
    if (pin) {
      if (pin.pin.side === 'out') {
        this.drag = { kind: 'wire', from: pin, cursor: g };
      } else {
        // Dragging off an input detaches whatever feeds it, so a mis-drawn
        // connection is one gesture away from being redrawn.
        const def = this.app.openDef;
        const existing = def.wires.find((w) => w.to.inst === pin.inst.id && w.to.pin === pin.pin.pin.id);
        if (existing) this.app.mutate(() => removeWires(def, new Set([existing.id])));
      }
      this.invalidate();
      return;
    }

    const hit = this.hitInstance(g);
    if (hit) {
      if (this.app.powered && this.tryToggle(hit)) return;
      if (!this.app.selection.instances.has(hit.inst.id)) this.app.selectInstance(hit.inst.id, e.shiftKey);
      else if (e.shiftKey) this.app.selectInstance(hit.inst.id, true);

      const origin = new Map<Id, Point>();
      for (const id of this.app.selection.instances) {
        const p = this.byId.get(id);
        if (p) origin.set(id, { x: p.inst.x, y: p.inst.y });
      }
      this.drag = { kind: 'move', sx: g.x, sy: g.y, origin, moved: false };
      return;
    }

    const wire = this.hitWire(g);
    if (wire) { this.app.selectWire(wire.id, e.shiftKey); return; }

    if (!e.shiftKey) this.app.clearSelection();
    this.drag = { kind: 'band', x0: g.x, y0: g.y, x1: g.x, y1: g.y, additive: e.shiftKey };
  }

  private onMove(e: PointerEvent) {
    const g = this.toGrid(e.clientX, e.clientY);
    this.cursor = g;

    switch (this.drag.kind) {
      case 'pan':
        this.view.tx = this.drag.tx + (e.clientX - this.drag.sx);
        this.view.ty = this.drag.ty + (e.clientY - this.drag.sy);
        this.gridStale = true;
        this.invalidate();
        return;

      case 'move': {
        const dx = Math.round(g.x - this.drag.sx);
        const dy = Math.round(g.y - this.drag.sy);
        const def = this.app.openDef;
        for (const [id, o] of this.drag.origin) {
          const inst = def.instances.find((i) => i.id === id);
          if (inst && (inst.x !== o.x + dx || inst.y !== o.y + dy)) {
            inst.x = o.x + dx;
            inst.y = o.y + dy;
            this.drag.moved = true;
          }
        }
        this.invalidate();
        return;
      }

      case 'band':
        this.drag.x1 = g.x;
        this.drag.y1 = g.y;
        this.invalidate();
        return;

      case 'wire':
        this.drag.cursor = g;
        this.hoverPin = this.hitPin(g);
        this.invalidate();
        return;

      default: {
        const pin = this.hitPin(g);
        const changed = pin?.pin.pin.id !== this.hoverPin?.pin.pin.id || pin?.inst.id !== this.hoverPin?.inst.id;
        this.hoverPin = pin;
        this.canvas.style.cursor = this.spaceHeld ? 'grab'
          : this.app.armed ? 'copy'
          : pin ? 'crosshair'
          : this.hitInstance(g) ? 'move' : 'default';
        if (changed) this.invalidate();
      }
    }
  }

  private onUp(e: PointerEvent) {
    const g = this.toGrid(e.clientX, e.clientY);
    const drag = this.drag;
    this.drag = { kind: 'none' };

    if (drag.kind === 'move' && drag.moved) {
      // Rewind the live drag and replay it through mutate(), so the whole
      // gesture collapses into a single undo entry.
      const def = this.app.openDef;
      const after = new Map<Id, Point>();
      for (const id of drag.origin.keys()) {
        const inst = def.instances.find((i) => i.id === id);
        if (inst) after.set(id, { x: inst.x, y: inst.y });
      }
      for (const [id, o] of drag.origin) {
        const inst = def.instances.find((i) => i.id === id);
        if (inst) { inst.x = o.x; inst.y = o.y; }
      }
      this.app.mutate(() => {
        for (const [id, pos] of after) {
          const inst = def.instances.find((i) => i.id === id);
          if (inst) { inst.x = pos.x; inst.y = pos.y; }
        }
      });
    } else if (drag.kind === 'band') {
      this.selectInBand(drag);
    } else if (drag.kind === 'wire') {
      const target = this.hitPin(g);
      if (target && target.pin.side === 'in') this.finishWire(drag.from, target);
      this.hoverPin = null;
    }
    this.invalidate();
  }

  /**
   * Right-click acts on what is under the cursor, selecting it first if it is
   * not already selected -- the same thing every other editor does.
   */
  private onContextMenu(e: MouseEvent) {
    const app = this.app;
    const g = this.toGrid(e.clientX, e.clientY);
    const at = { x: Math.round(g.x), y: Math.round(g.y) };

    const hit = this.hitInstance(g);
    if (hit && !app.selection.instances.has(hit.inst.id)) app.selectInstance(hit.inst.id, false);
    const wire = hit ? null : this.hitWire(g);
    if (wire && !app.selection.wires.has(wire.id)) app.selectWire(wire.id, false);

    const items: MenuItem[] = [];
    const selected = app.selectedInstances;

    if (selected.length) {
      const one = selected.length === 1 ? selected[0] : null;
      const kind = one && isPrim(one.def) ? primKind(one.def) : null;
      const name = one
        ? (kind ? primLabel(one) : nameOfDef(app, one.def) ?? 'Component')
        : `${selected.length} selected`;
      items.push({ header: name });

      items.push({
        label: selected.length === 1 ? 'Make component...' : `Make component from ${selected.length} parts...`,
        icon: 'chip',
        onClick: () => this.actions.extract(),
      });
      items.push({ label: 'Duplicate', icon: 'copy', onClick: () => app.duplicateSelection() });

      if (one && !kind) {
        items.push('divider');
        items.push({
          label: 'Edit this component', icon: 'chip',
          onClick: () => app.openComponent(one.def),
        });
      }
      if (one && (kind === 'ROM' || kind === 'RAM')) {
        items.push('divider');
        items.push({
          label: kind === 'ROM' ? 'Edit program...' : 'Set initial contents...',
          icon: 'memory',
          onClick: () => memoryEditor(app, one, kind),
        });
      }

      items.push('divider');
      items.push({
        label: selected.length === 1 ? 'Delete' : `Delete ${selected.length} parts`,
        icon: 'trash', danger: true,
        onClick: () => this.deleteSelection(),
      });
    } else if (wire) {
      items.push({ header: 'Wire' });
      items.push({ label: 'Delete wire', icon: 'trash', danger: true, onClick: () => this.deleteSelection() });
    } else {
      if (app.clipboard?.instances.length) {
        items.push({ label: 'Paste here', icon: 'copy', onClick: () => app.paste(at.x, at.y) });
      }
      items.push({ label: 'Arrange automatically', icon: 'layers', onClick: () => this.arrange() });
      items.push({ label: 'Select all', onClick: () => app.selectAll() });
      items.push({ label: 'Fit to circuit', icon: 'fit', onClick: () => this.fit() });
    }

    contextMenu(e.clientX, e.clientY, items);
  }

  private onDoubleClick(e: MouseEvent) {
    const g = this.toGrid(e.clientX, e.clientY);
    const hit = this.hitInstance(g);
    if (hit && !isPrim(hit.inst.def)) this.app.openComponent(hit.inst.def);
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const r = this.canvas.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const before = { x: (mx - this.view.tx) / this.view.zoom, y: (my - this.view.ty) / this.view.zoom };
      this.view.zoom = Math.max(0.15, Math.min(4, this.view.zoom * Math.exp(-e.deltaY * 0.0025)));
      this.view.tx = mx - before.x * this.view.zoom;
      this.view.ty = my - before.y * this.view.zoom;
    } else {
      this.view.tx -= e.deltaX;
      this.view.ty -= e.deltaY;
    }
    this.gridStale = true;
    this.invalidate();
  }

  private selectInBand(band: { x0: number; y0: number; x1: number; y1: number; additive: boolean }) {
    const x0 = Math.min(band.x0, band.x1), x1 = Math.max(band.x0, band.x1);
    const y0 = Math.min(band.y0, band.y1), y1 = Math.max(band.y0, band.y1);
    if (x1 - x0 < 0.2 && y1 - y0 < 0.2) return;
    if (!band.additive) { this.app.selection.instances.clear(); this.app.selection.wires.clear(); }
    for (const p of this.placed) {
      if (p.inst.x + p.box.w >= x0 && p.inst.x <= x1 && p.inst.y + p.box.h >= y0 && p.inst.y <= y1) {
        this.app.selection.instances.add(p.inst.id);
      }
    }
    this.app.wiresFollowParts();
    this.app.emit('selection');
  }

  /**
   * Clicking an input port while the circuit runs drives it. Only a port of
   * the component being edited can be driven: one level down it is a pin, and
   * whatever contains it is the thing driving it.
   *
   * A single bit flips. Anything wider is a number, so it asks for one.
   */
  private tryToggle(hit: Placed): boolean {
    const inst = hit.inst;
    if (!isPrim(inst.def) || primKind(inst.def) !== 'IN') return false;
    const index = this.app.netlist?.inputs.findIndex((t) => t.instId === inst.id) ?? -1;
    if (index < 0) return false;

    // One bit flips under the pointer. Anything wider is a number, and a
    // number wants the panel: bits to click and a field to type into, both of
    // which stay on screen while the circuit runs.
    if (clampWidth(inst.props.width) !== 1) return false;
    this.driveInput(inst, index, inst.props.value ? 0 : 1);
    return true;
  }

  private driveInput(inst: Instance, index: number, value: number) {
    inst.props.value = value;
    this.app.sim?.setInput(index, value);
    this.app.persist();
    this.app.emit('tick', 'selection');
  }

  private place(defId: Id, x: number, y: number) {
    const app = this.app;
    const open = app.openDef;
    if (!isPrim(defId) && wouldRecurse(app.project, open.id, defId)) {
      app.toast('That would make the component contain itself', 'err');
      return;
    }
    const inst = makeInstance(defId, x, y);
    nameNewInstances(open, [inst]);
    app.mutate(() => { open.instances.push(inst); });
    app.selection.instances = new Set([inst.id]);
    app.wiresFollowParts();
    app.emit('selection');
  }

  /**
   * A drag always starts on an output and ends on an input, so any pair of
   * ends is a wire -- including the two ends of the same part. A gate feeding
   * itself is a real circuit, it is what the text form has always been able to
   * write, and refusing to draw it was the only place the two views disagreed.
   */
  private finishWire(from: PinHit, to: PinHit) {
    const app = this.app;
    const def = app.openDef;
    const fw = from.pin.pin.width;
    const tw = to.pin.pin.width;
    const width = Math.min(fw, tw);
    // Each end takes the next stretch of itself that is still free, so
    // fanning a bus out to one-bit gates walks up the bus drag by drag.
    const fromBits = nextFreeBits(def, from.inst.id, from.pin.pin.id, width, fw);
    const toBits = nextFreeBits(def, to.inst.id, to.pin.pin.id, width, tw);
    if (fw !== tw) {
      const wide = fw > tw ? from.pin.pin : to.pin.pin;
      const range = fw > tw ? fromBits : toBits;
      app.toast(
        `${from.pin.pin.name} is ${bits(fw)} and ${to.pin.pin.name} is ${bits(tw)}`
        + ` - connected ${wide.name}${rangeLabel(range.lo, range.hi)},`
        + ' adjust the range in the inspector',
      );
    }
    app.mutate(() => {
      connect(
        app.project, def,
        { inst: from.inst.id, pin: from.pin.pin.id, lo: fromBits.lo, hi: fromBits.hi },
        { inst: to.inst.id, pin: to.pin.pin.id, lo: toBits.lo, hi: toBits.hi },
      );
    });
  }

  /* ---------------- commands ---------------- */

  deleteSelection() {
    const app = this.app;
    const def = app.openDef;
    if (!app.selection.instances.size && !app.selection.wires.size) return;
    const instances = new Set(app.selection.instances);
    const wires = new Set(app.selection.wires);
    app.mutate(() => {
      removeWires(def, wires);
      removeInstances(def, instances);
    });
    app.clearSelection();
  }

  /**
   * Tidy the whole component. Purely presentational: it cannot change what the
   * circuit does, its pin order, or how it reads in the text editor.
   */
  arrange() {
    const app = this.app;
    const def = app.openDef;
    if (!def.instances.length) return;
    let moved = 0;
    app.mutate(() => { moved = arrangeDef(app.project, def); });
    if (!moved) { app.undo(); app.toast('Already arranged'); return; }
    this.fit();
    app.toast(`Arranged ${moved} part${moved === 1 ? '' : 's'} - undo to put them back`);
  }

  nudge(dx: number, dy: number) {
    const app = this.app;
    if (!app.selection.instances.size) return;
    const def = app.openDef;
    app.mutate(() => {
      for (const id of app.selection.instances) {
        const inst = def.instances.find((i) => i.id === id);
        if (inst) { inst.x += dx; inst.y += dy; }
      }
    });
  }

  get cursorGrid(): Point {
    return { x: Math.round(this.cursor.x), y: Math.round(this.cursor.y) };
  }

  /* ---------------- rendering ---------------- */

  private resize() {
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const w = this.host.clientWidth, h = this.host.clientHeight;
    for (const c of [this.canvas, this.grid]) {
      c.width = Math.max(1, Math.round(w * dpr));
      c.height = Math.max(1, Math.round(h * dpr));
    }
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.gridStale = true;
    this.invalidate();
  }

  private render() {
    if (!this.dirty) return;
    this.dirty = false;
    this.placedStale = true;

    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const ctx = this.ctx;
    const c = palette();
    this.buildPlaced();

    if (this.gridStale) this.paintGrid(dpr, c);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.grid, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.translate(this.view.tx, this.view.ty);
    ctx.scale(this.view.zoom, this.view.zoom);

    const sim = this.app.powered && this.app.sim && this.app.netlist ? this.app.sim : null;
    const def = this.app.openDef;

    // Selected wires go on top. Where wires overlap they are drawn in list
    // order, so a selected one underneath is hidden exactly where the overlap
    // is -- which is where seeing the selection matters most.
    const picked = this.app.selection.wires;
    for (const w of def.wires) if (!picked.has(w.id)) this.paintWire(ctx, c, w, sim);
    for (const w of def.wires) if (picked.has(w.id)) this.paintWire(ctx, c, w, sim);
    this.paintJunctions(ctx, c, sim);
    if (this.drag.kind === 'wire') this.paintPendingWire(ctx, c);
    for (const p of this.placed) this.paintBox(ctx, c, p, sim);
    if (this.drag.kind === 'band') this.paintBand(ctx, c);
  }

  private paintGrid(dpr: number, c: Record<string, string>) {
    this.gridStale = false;
    const g = this.gridCtx;
    const w = this.grid.width, h = this.grid.height;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = c['canvas-bg'];
    g.fillRect(0, 0, w, h);

    const step = GRID * this.view.zoom * dpr;
    if (step < 5) return;
    const ox = ((this.view.tx * dpr) % step + step) % step;
    const oy = ((this.view.ty * dpr) % step + step) % step;
    const size = Math.max(1, Math.round(dpr * (this.view.zoom > 1.6 ? 1.4 : 1)));
    // Every eighth dot is emphasised: enough structure to align against
    // without ever drawing a grid line.
    const startCol = Math.floor(-this.view.tx * dpr / step);
    const startRow = Math.floor(-this.view.ty * dpr / step);

    let col = startCol;
    for (let x = ox; x < w + step; x += step, col++) {
      let row = startRow;
      for (let y = oy; y < h + step; y += step, row++) {
        const major = col % 8 === 0 && row % 8 === 0;
        g.fillStyle = major ? c['grid-dot-major'] : c['grid-dot'];
        const s = major ? size + 1 : size;
        g.fillRect(Math.round(x), Math.round(y), s, s);
      }
    }
  }

  private netsFor(instId: Id, pinId: Id): number[] | undefined {
    return this.app.netlist?.rootPinNets.get(`${instId}:${pinId}`);
  }

  /** Fraction of the addressed bits that are high, or -1 when not simulating. */
  private pinLevel(sim: Simulatorish | null, instId: Id, pinId: Id, lo?: number, hi?: number): number {
    if (!sim) return -1;
    const nets = this.netsFor(instId, pinId);
    if (!nets) return -1;
    const slice = lo === undefined ? nets : nets.slice(lo, (hi ?? lo) + 1);
    if (!slice.length) return -1;
    let on = 0;
    for (const n of slice) if (sim.net[n]) on++;
    return on / slice.length;
  }

  private pinWidthOf(instId: Id, pinId: Id): number {
    return this.byId.get(instId)?.box.pins.find((x) => x.pin.id === pinId)?.pin.width ?? 1;
  }

  private paintWire(ctx: CanvasRenderingContext2D, c: Record<string, string>, w: Wire, sim: Simulatorish | null) {
    const path = this.wirePath(w);
    if (!path) return;
    const selected = this.app.selection.wires.has(w.id);
    const base = w.color || c.wire;
    const bits = w.from.hi - w.from.lo + 1;

    // The user picks the hue; the simulator only picks the brightness.
    let stroke = base;
    const level = this.pinLevel(sim, w.from.inst, w.from.pin, w.from.lo, w.from.hi);
    if (level > 0) stroke = mix(base, c['wire-hot'], Math.max(0.55, level));
    if (selected) stroke = c['wire-selected'];

    const scale = 1 / Math.max(0.6, Math.min(1, this.view.zoom));
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = stroke;
    ctx.lineWidth = (selected ? 2.4 : bits > 1 ? 2.2 : 1.4) * scale;
    ctx.beginPath();
    ctx.moveTo(path[0].x * GRID, path[0].y * GRID);
    for (let i = 1; i < path.length; i++) ctx.lineTo(path[i].x * GRID, path[i].y * GRID);
    ctx.stroke();
    ctx.restore();

    if (this.view.zoom > 0.7) {
      const label = sliceLabel(w.from.lo, w.from.hi, this.pinWidthOf(w.from.inst, w.from.pin));
      if (label) {
        const mid = path[Math.floor(path.length / 2)];
        ctx.save();
        ctx.font = PIN_FONT;
        ctx.fillStyle = c['box-pin-text'];
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(label, mid.x * GRID, mid.y * GRID - 3);
        ctx.restore();
      }
    }
  }

  /**
   * A filled dot where a branch leaves a trunk. Crossings without one are
   * exactly that -- two signals passing, not joined.
   */
  private paintJunctions(ctx: CanvasRenderingContext2D, c: Record<string, string>, sim: Simulatorish | null) {
    if (!this.routes.junctions.length) return;
    const def = this.app.openDef;
    const scale = 1 / Math.max(0.6, Math.min(1, this.view.zoom));
    ctx.save();
    const wireFor = (net: string) => def.wires.find(
      (w) => `${w.from.inst}:${w.from.pin}:${w.from.lo}-${w.from.hi}` === net,
    );
    // Same reason as the wires themselves: a junction on a selected wire must
    // not be painted over by an unselected one crossing it.
    const order = this.routes.junctions.slice().sort((a, b) =>
      Number(this.app.selection.wires.has(wireFor(a.net)?.id ?? '')) -
      Number(this.app.selection.wires.has(wireFor(b.net)?.id ?? '')));
    for (const j of order) {
      const wire = wireFor(j.net);
      if (!wire) continue;
      const base = wire.color || c.wire;
      const level = this.pinLevel(sim, wire.from.inst, wire.from.pin, wire.from.lo, wire.from.hi);
      const selected = this.app.selection.wires.has(wire.id);
      ctx.fillStyle = selected ? c['wire-selected']
        : level > 0 ? mix(base, c['wire-hot'], Math.max(0.55, level))
        : base;
      ctx.beginPath();
      ctx.arc(j.x * GRID, j.y * GRID, 2.6 * scale, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private paintPendingWire(ctx: CanvasRenderingContext2D, c: Record<string, string>) {
    if (this.drag.kind !== 'wire') return;
    const p = this.byId.get(this.drag.from.inst.id);
    if (!p) return;
    const start = this.pinPoint(p, this.drag.from.pin);
    const hovered = this.hoverPin && this.hoverPin.pin.side === 'in' ? this.byId.get(this.hoverPin.inst.id) : null;
    const target = hovered ? this.pinPoint(hovered, this.hoverPin!.pin) : this.drag.cursor;
    const path = routeWire(start, target);

    ctx.save();
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 1.8 / Math.max(0.6, Math.min(1, this.view.zoom));
    ctx.setLineDash([5, 4]);
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(path[0].x * GRID, path[0].y * GRID);
    for (let i = 1; i < path.length; i++) ctx.lineTo(path[i].x * GRID, path[i].y * GRID);
    ctx.stroke();
    ctx.restore();
  }

  private paintBand(ctx: CanvasRenderingContext2D, c: Record<string, string>) {
    if (this.drag.kind !== 'band') return;
    const x = Math.min(this.drag.x0, this.drag.x1) * GRID;
    const y = Math.min(this.drag.y0, this.drag.y1) * GRID;
    const w = Math.abs(this.drag.x1 - this.drag.x0) * GRID;
    const h = Math.abs(this.drag.y1 - this.drag.y0) * GRID;
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = c['accent-soft'];
    ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 1 / this.view.zoom;
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }

  private paintBox(ctx: CanvasRenderingContext2D, c: Record<string, string>, p: Placed, sim: Simulatorish | null) {
    const { inst, box } = p;
    const x = inst.x * GRID, y = inst.y * GRID;
    const w = box.w * GRID, h = box.h * GRID;
    const selected = this.app.selection.instances.has(inst.id);
    const kind = isPrim(inst.def) ? primKind(inst.def) : null;
    const name = kind ? primLabel(inst) : (nameOfDef(this.app, inst.def) ?? '?');

    let fill = c['box-fill'];
    let accentBar: string | null = null;
    if (kind === 'IN' || kind === 'OUT') {
      // A live port wears the hot bar, so a running circuit reads at a glance
      // without hunting for the wire colours.
      const on = sim ? this.pinLevel(sim, inst.id, kind === 'IN' ? 'out' : 'in') > 0 : false;
      accentBar = on ? c['pin-hot'] : c['accent-line'];
    } else if (kind === 'CLOCK') {
      // The clock is the one signal you are always watching, so its box says
      // where it is in the cycle rather than only that it is a clock.
      accentBar = sim && this.pinLevel(sim, inst.id, 'clk') > 0 ? c['pin-hot'] : c.ok;
    }
    else if (kind === 'ROM' || kind === 'RAM') accentBar = c['text-faint'];

    ctx.save();
    ctx.beginPath();
    roundRect(ctx, x, y, w, h, 4);
    ctx.fillStyle = fill;
    ctx.shadowColor = c['box-shadow'];
    ctx.shadowBlur = 4;
    ctx.shadowOffsetY = 1;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.lineWidth = selected ? 1.8 : 1;
    ctx.strokeStyle = selected ? c.accent : c['box-stroke'];
    ctx.stroke();

    if (accentBar) {
      ctx.save();
      ctx.beginPath();
      roundRect(ctx, x, y, w, h, 4);
      ctx.clip();
      ctx.fillStyle = accentBar;
      ctx.fillRect(x, y, w, 2.5);
      ctx.restore();
    }

    // The name sits centred; pin labels hug the edges. The box was sized to
    // fit both, so they can never collide.
    const valueText = this.boxValue(inst, kind, sim);
    const label = customLabel(inst);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let cy = y + h / 2 - (valueText ? 6 : 0) + (label ? 5 : 0);
    if (label) {
      // The name the author gave this part, above the type it is. Both are
      // worth seeing: the label says which one this is, the type says what.
      ctx.font = PIN_FONT;
      ctx.fillStyle = c.accent;
      ctx.fillText(label, x + w / 2, cy - 10);
    }
    ctx.font = NAME_FONT;
    ctx.fillStyle = c['box-text'];
    ctx.fillText(name, x + w / 2, cy);
    if (valueText) {
      ctx.font = `10px ${MONO}`;
      ctx.fillStyle = c.warn;
      ctx.fillText(valueText, x + w / 2, cy + 13);
    }

    ctx.font = PIN_FONT;
    ctx.textBaseline = 'middle';
    for (const pin of box.pins) {
      const px = (inst.x + pin.x) * GRID;
      const py = (inst.y + pin.y) * GRID;
      const hot = this.pinLevel(sim, inst.id, pin.pin.id) > 0;
      const hovered = this.hoverPin?.inst.id === inst.id && this.hoverPin.pin.pin.id === pin.pin.id;

      if (pin.pin.width > 1) {
        // Bus pins get a stub so width is visible without reading the label.
        ctx.fillStyle = hot ? c['pin-hot'] : c.pin;
        ctx.fillRect(pin.side === 'in' ? px - 3.5 : px, py - 3, 3.5, 6);
      }
      ctx.beginPath();
      ctx.arc(px, py, hovered ? 3.6 : 2.6, 0, Math.PI * 2);
      ctx.fillStyle = hot ? c['pin-hot'] : hovered ? c.accent : c.pin;
      ctx.fill();
      if (hovered) {
        ctx.beginPath();
        ctx.arc(px, py, 6, 0, Math.PI * 2);
        ctx.strokeStyle = c.accent;
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      if (this.view.zoom > 0.55 && showPinLabel(pin.pin, name, box.pins.length)) {
        ctx.fillStyle = c['box-pin-text'];
        ctx.textAlign = pin.side === 'in' ? 'left' : 'right';
        ctx.fillText(pin.pin.name, pin.side === 'in' ? px + 7 : px - 7, py);
      }
    }
    ctx.restore();
  }

  private boxValue(inst: Instance, kind: string | null, sim: Simulatorish | null): string | null {
    if (!kind) return null;
    const width = clampWidth(inst.props.width);
    if (kind === 'PROBE') {
      const nets = this.netsFor(inst.id, 'in');
      if (!sim || !nets) return null;
      let v = 0;
      for (let i = 0; i < nets.length; i++) if (sim.net[nets[i]]) v |= 1 << i;
      return formatValue(v >>> 0, width, inst.props.format ?? 'hex');
    }
    if (kind === 'CLOCK') {
      const nets = this.netsFor(inst.id, 'clk');
      if (!sim || !nets || !nets.length) return null;
      return sim.net[nets[0]] ? '1' : '0';
    }
    // A port shows what is on it: an input the value it is driving, an output
    // whatever has arrived. Both are the question you have while a circuit
    // runs, and neither was answerable without dropping a probe next to it.
    if (kind === 'IN' || kind === 'OUT') {
      const nets = this.netsFor(inst.id, kind === 'IN' ? 'out' : 'in');
      const show = (v: number) => (width === 1
        // A single bit is a single bit. "0x1" says the same thing and reads
        // like a number that happens to be small.
        ? String(v & 1)
        : formatValue(v, width, inst.props.format ?? 'hex'));
      if (sim && nets) {
        let v = 0;
        for (let i = 0; i < nets.length; i++) if (sim.net[nets[i]]) v |= 1 << i;
        return show(v >>> 0);
      }
      if (kind === 'IN' && width > 1) return show((inst.props.value ?? 0) >>> 0);
      return null;
    }
    if (kind === 'ROM' || kind === 'RAM') {
      const words = 1 << clampWidth(inst.props.addrWidth, 8);
      return `${words} x ${clampWidth(inst.props.dataWidth, 16)}`;
    }
    return null;
  }
}

function bits(n: number): string {
  return `${n} bit${n === 1 ? '' : 's'}`;
}

function rangeLabel(lo: number, hi: number): string {
  return lo === hi ? `[${lo}]` : `[${hi}..${lo}]`;
}

function nameOfDef(app: App, defId: Id): string | undefined {
  return app.project.defs.find((d) => d.id === defId)?.name;
}

export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
