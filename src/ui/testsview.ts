/**
 * The component's truth table, as a view of its own.
 *
 * Tests are not a dialog you visit and dismiss: by the time a library has
 * thirty components they are the only way a wrong wire inside an adder gets
 * noticed, so they sit next to the schematic and the code and save themselves
 * the same way those do.
 *
 * A multi-bit column is meaningless without saying which base it is written
 * in -- `10` is two, ten or sixteen depending on who is reading -- so the base
 * is chosen once for the whole table and every cell is shown and read in it.
 */
import { formatValue } from '../core/layout';
import { signatureOf } from '../core/project';
import { normalizeVectors, runTests } from '../core/testbench';
import type { NumberFormat, Pin, TestVector } from '../core/types';
import type { App } from './app';
import { button, clear, h } from './dom';

/** Geometry of the waveform view, in pixels. */
const COL_W = 26;
const ROW_H = 30;
const AMP = 14;
const VIEW_KEY = 'nand.tests.view';

/** Bases a column can be written in. Signed is a readout, not an input format. */
const BASES: Array<[NumberFormat, string, string]> = [
  ['bin', 'Bin', 'Binary, so 1010 is ten'],
  ['dec', 'Dec', 'Decimal'],
  ['hex', 'Hex', 'Hexadecimal, so FF is 255'],
];

export class TestsView {
  private root: HTMLElement;
  private body: HTMLElement;
  private tableWrap: HTMLElement;
  private summary: HTMLElement;
  private head: HTMLElement;

  private vectors: TestVector[] = [];
  private orphaned: string[] = [];
  private loadedFrom: string | null = null;
  private settleTicks = 0;
  private resetEach = false;
  private base: NumberFormat = 'dec';
  private results: ReturnType<typeof runTests> | undefined;
  /** Set while a run is in flight, so the button can say so. */
  private running = false;
  /**
   * Which way the same vectors are drawn. A viewing preference, not a property
   * of the circuit, so it lives in the browser rather than in the project --
   * the same place the code view keeps its text size.
   */
  private mode: 'grid' | 'wave' = readMode();

  constructor(private app: App, host: HTMLElement) {
    this.head = h('div', { class: 'tests-head' });
    this.tableWrap = h('div', { class: 'tests-table' });
    this.summary = h('div', { class: 'tests-summary' });
    this.body = h('div', { class: 'tests-body' }, this.head, this.tableWrap, this.summary);
    this.root = h('div', { class: 'tests-pane' }, this.body);
    host.appendChild(this.root);

    this.bindGridKeys();
    app.on('view', () => this.sync());
    app.on('project', () => { if (app.mode === 'tests') this.sync(true); });
    this.sync();
  }

  private sync(reload = false) {
    const showing = this.app.mode === 'tests';
    this.root.style.display = showing ? '' : 'none';
    if (!showing) return;
    if (reload || this.loadedFrom !== this.app.openDef.id) this.load();
    this.render();
  }

  private load() {
    const def = this.app.openDef;
    const migrated = normalizeVectors(signatureOf(def), structuredClone(def.tests?.vectors ?? []));
    this.vectors = migrated.vectors;
    this.orphaned = migrated.unknown;
    this.settleTicks = def.tests?.settleTicks ?? 0;
    this.resetEach = def.tests?.resetEachVector ?? false;
    this.base = def.tests?.base ?? 'dec';
    this.loadedFrom = def.id;
    this.results = undefined;
  }

  /**
   * Saved as you go, like everything else. Tests are notes about a component
   * rather than part of its circuit, so this never recompiles anything.
   */
  private save() {
    const def = this.app.openDef;
    def.tests = this.vectors.length
      ? {
        vectors: this.vectors,
        settleTicks: this.settleTicks,
        resetEachVector: this.resetEach,
        base: this.base,
      }
      : undefined;
    // Written straight to the component and persisted, without announcing a
    // change: nothing else on screen shows the tests, and an announcement
    // would rebuild this table out from under whoever is typing in it.
    this.app.persist();
  }

  /* ---------------- the grid ---------------- */

  private focusCell(row: number, col: number): boolean {
    const el = this.tableWrap.querySelector<HTMLInputElement>(
      `input[data-row="${row}"][data-col="${col}"]`,
    );
    if (!el) return false;
    el.focus();
    el.select();
    return true;
  }

  /**
   * Arrow keys walk the grid. Left and right only leave the cell when the
   * caret is already at that edge, so they still move the caret while you are
   * part-way through typing a value.
   */
  private bindGridKeys() {
    this.tableWrap.addEventListener('keydown', (e) => {
      const input = e.target as HTMLInputElement;
      if (!(input instanceof HTMLInputElement) || input.dataset.row === undefined) return;
      const row = Number(input.dataset.row);
      const col = Number(input.dataset.col);
      const len = input.value.length;
      const from = input.selectionStart ?? 0;
      const to = input.selectionEnd ?? 0;
      const whole = len > 0 && from === 0 && to === len;
      const atStart = len === 0 || whole || (from === 0 && to === 0);
      const atEnd = len === 0 || whole || (from === len && to === len);

      let target: [number, number] | null = null;
      switch (e.key) {
        case 'ArrowUp': target = [row - 1, col]; break;
        case 'ArrowDown': target = [row + 1, col]; break;
        case 'ArrowLeft': if (atStart) target = [row, col - 1]; break;
        case 'ArrowRight': if (atEnd) target = [row, col + 1]; break;
        case 'Enter': target = [row + (e.shiftKey ? -1 : 1), col]; break;
        default: return;
      }
      if (!target) return;
      e.preventDefault();
      e.stopPropagation();
      this.focusCell(target[0], target[1]);
    });
  }

  private cell(pin: Pin, value: number, onChange: (v: number) => void): HTMLInputElement {
    const input = h('input', { type: 'text', value: this.show(value, pin) });
    input.addEventListener('input', () => {
      const n = this.read(input.value);
      input.style.color = n === null ? 'var(--danger)' : '';
      if (n !== null) { onChange(n); this.save(); }
    });
    // Re-write the cell in canonical form once the caret leaves it, so a value
    // typed as `0xff` settles as `FF` and the column stays readable.
    input.addEventListener('blur', () => {
      const n = this.read(input.value);
      if (n !== null) input.value = this.show(n, pin);
    });
    return input;
  }

  private show(value: number, pin: Pin): string {
    return this.base === 'dec'
      ? String(value >>> 0)
      : formatValue(value, pin.width, this.base).replace(/^0x/, '');
  }

  /** Read a cell in the chosen base, but never refuse an explicit prefix. */
  private read(text: string): number | null {
    const t = text.trim().toLowerCase().replace(/_/g, '');
    if (!t) return null;
    let n: number;
    if (t.startsWith('0x')) n = parseInt(t.slice(2), 16);
    else if (t.startsWith('0b')) n = parseInt(t.slice(2), 2);
    else if (this.base === 'bin') n = /^[01]+$/.test(t) ? parseInt(t, 2) : NaN;
    else if (this.base === 'hex') n = /^[0-9a-f]+$/.test(t) ? parseInt(t, 16) : NaN;
    else n = /^-?\d+$/.test(t) ? parseInt(t, 10) : NaN;
    return Number.isFinite(n) ? n >>> 0 : null;
  }

  /* ---------------- reordering ---------------- */

  /**
   * Drag a row by its number to move it. The grip is deliberately not the
   * whole row: a row is mostly text fields, and making those draggable would
   * cost the ability to select what is in them.
   *
   * Nothing is re-rendered until the drag ends, because rebuilding the table
   * mid-drag would throw away the element holding the pointer capture. A line
   * shows where the row would land instead.
   */
  private startDrag(e: PointerEvent, from: number, grip: HTMLElement) {
    const tbody = this.tableWrap.querySelector('tbody');
    if (!tbody || this.vectors.length < 2) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);

    const rows = [...tbody.rows];
    const bounds = rows.map((r) => r.getBoundingClientRect());
    const frame = this.tableWrap.getBoundingClientRect();
    const line = h('div', { class: 'drop-line' });
    this.tableWrap.appendChild(line);
    rows[from].classList.add('lifting');

    let to = from;
    const place = (y: number) => {
      to = bounds.filter((b) => y > b.top + b.height / 2).length;
      const edge = to < bounds.length ? bounds[to].top : bounds[bounds.length - 1].bottom;
      line.style.top = `${edge - frame.top}px`;
    };
    place(e.clientY);

    const move = (ev: PointerEvent) => place(ev.clientY);
    const done = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', done);
      grip.removeEventListener('pointercancel', done);
      line.remove();
      rows[from].classList.remove('lifting');
      if (to !== from && to !== from + 1) {
        const landing = to > from ? to - 1 : to;
        this.vectors.splice(landing, 0, ...this.vectors.splice(from, 1));
        // A verdict belongs to the test that earned it, so it travels with it
        // rather than staying with the row number.
        const verdicts = this.results?.results;
        if (verdicts) verdicts.splice(landing, 0, ...verdicts.splice(from, 1));
        this.save();
      }
      this.render();
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', done);
    grip.addEventListener('pointercancel', done);
  }

  /* ---------------- painting ---------------- */

  private render() {
    const app = this.app;
    const def = app.openDef;
    const sig = signatureOf(def);

    clear(this.head);
    clear(this.tableWrap);
    clear(this.summary);

    if (!sig.inputs.length && !sig.outputs.length) {
      this.tableWrap.appendChild(h('div', { class: 'tests-empty' },
        h('div', null, 'This component has no pins yet'),
        h('div', { class: 'hint', style: { marginTop: '6px' } },
          'Place In and Out markers on the schematic first. A test says what the '
          + 'outputs should be for a given set of inputs, so there has to be something to set.')));
      return;
    }

    /* ----- head: base, run, and the settling controls ----- */

    const seg = h('div', { class: 'seg' });
    for (const [value, label, hint] of BASES) {
      seg.appendChild(h('button', {
        class: this.base === value ? 'on' : '',
        title: hint,
        onclick: () => { this.base = value; this.save(); this.render(); },
      }, label));
    }
    this.head.appendChild(h('div', { class: 'field' },
      h('label', null, 'Values in'), h('div', { class: 'control' }, seg)));

    // The same vectors, drawn two ways. A grid reads better for wide buses --
    // nobody wants an adder's operands as sixteen square waves -- and a
    // waveform reads better for anything whose answer depends on when, which
    // is every latch, every register and the whole of the clocked machine.
    const modes = h('div', { class: 'seg' });
    for (const [value, label, hint] of [
      ['grid', 'Grid', 'One row per test, values typed'],
      ['wave', 'Wave', 'One column per test, signals drawn over time'],
    ] as const) {
      modes.appendChild(h('button', {
        class: this.mode === value ? 'on' : '',
        title: hint,
        onclick: () => {
          this.mode = value;
          try { localStorage.setItem(VIEW_KEY, value); } catch { /* private mode */ }
          this.render();
        },
      }, label));
    }
    this.head.appendChild(h('div', { class: 'field' },
      h('label', null, 'Shown as'), h('div', { class: 'control' }, modes)));

    const ticks = h('input', {
      type: 'number', min: '0', value: String(this.settleTicks), style: { width: '64px' },
      oninput: (e: Event) => {
        this.settleTicks = Number((e.target as HTMLInputElement).value) || 0;
        this.save();
      },
    });
    this.head.appendChild(h('div', { class: 'field' },
      h('label', null, 'Ticks'), h('div', { class: 'control' }, ticks)));

    const reset = h('input', {
      type: 'checkbox', checked: this.resetEach, style: { width: 'auto' },
      onchange: (e: Event) => {
        this.resetEach = (e.target as HTMLInputElement).checked;
        this.save();
      },
    });
    this.head.appendChild(h('div', { class: 'field' },
      h('label', null, 'Reset each'), h('div', { class: 'control' }, reset)));

    this.head.appendChild(h('div', { class: 'spacer' }));
    this.head.appendChild(button('Add test', {
      icon: 'plus', className: 'bordered',
      onClick: () => {
        const blank: TestVector = { in: {}, out: {} };
        for (const p of sig.inputs) blank.in[p.id] = 0;
        for (const p of sig.outputs) blank.out[p.id] = 0;
        this.vectors.push(blank);
        this.save();
        this.render();
        this.focusCell(this.vectors.length - 1, 0);
      },
    }));
    this.head.appendChild(this.running
      ? h('button', { class: 'btn primary', disabled: true },
        h('span', { class: 'spinner' }), 'Running')
      : button('Run', {
        icon: 'beaker', className: 'primary',
        disabled: !this.vectors.length,
        onClick: () => { void this.run(); },
      }));

    /* ----- the vectors, drawn whichever way ----- */

    if (this.mode === 'wave') this.renderWave(sig);
    else this.renderGrid(sig);

    if (!this.vectors.length) {
      this.tableWrap.appendChild(h('div', { class: 'hint', style: { padding: '12px 2px' } },
        this.mode === 'wave'
          ? 'No tests yet. Add a column, then draw the inputs and what the outputs should be.'
          : 'No tests yet. Add one, then fill in the inputs and what the outputs should be.'));
    }

    this.renderSummary(sig);
  }

  /**
   * Run the vectors, having first let the button say that it is doing so.
   *
   * The work is one long synchronous burst -- compile the whole component,
   * then step a few thousand gates once per vector -- and on anything the size
   * of a RAM it is comfortably long enough to see. Yielding two frames before
   * starting is what puts the spinner on screen, since a render that is never
   * painted before the thread blocks is the same as no render at all. The
   * spinner itself animates a transform and nothing else, so the compositor
   * keeps turning it while this thread is busy.
   *
   * The timer beside the frame request is not belt and braces. A hidden tab
   * never paints, so requestAnimationFrame never fires there, and waiting on
   * it alone would leave the run unstarted and the button reading Running
   * until someone came back to look -- which is exactly when nobody is.
   */
  private async run() {
    if (this.running) return;
    const app = this.app;
    const def = app.openDef;
    this.running = true;
    this.render();
    await new Promise((done) => {
      requestAnimationFrame(() => requestAnimationFrame(done));
      setTimeout(done, 60);
    });
    try {
      this.results = runTests(app.project, def.id, {
        vectors: this.vectors,
        settleTicks: this.settleTicks,
        resetEachVector: this.resetEach,
      });
    } finally {
      this.running = false;
      this.render();
    }
  }

  /* ---------------- the grid ---------------- */

  private renderGrid(sig: ReturnType<typeof signatureOf>) {
    const table = h('table', { class: 'grid-table' });
    const head = h('tr');
    head.appendChild(h('th', null, ''));
    for (const p of sig.inputs) head.appendChild(h('th', null, this.columnName(p)));
    for (const p of sig.outputs) head.appendChild(h('th', null, `= ${this.columnName(p)}`));
    head.appendChild(h('th', null, ''));
    table.appendChild(h('thead', null, head));

    const tbody = h('tbody');
    this.vectors.forEach((vec, i) => {
      const result = this.results?.results[i];
      const tr = h('tr', { class: result ? (result.pass ? 'pass' : 'fail') : '' });
      const grip = h('div', { class: 'grip', title: 'Drag to reorder' }, String(i));
      grip.addEventListener('pointerdown', (e) => this.startDrag(e, i, grip));
      tr.appendChild(h('td', { class: 'res' }, grip));
      let col = 0;
      for (const p of sig.inputs) {
        const cell = this.cell(p, vec.in[p.id] ?? 0, (v) => { vec.in[p.id] = v; });
        cell.dataset.row = String(i);
        cell.dataset.col = String(col++);
        tr.appendChild(h('td', null, h('div', { class: 'cell' }, cell)));
      }
      for (const p of sig.outputs) {
        const cell = this.cell(p, vec.out[p.id] ?? 0, (v) => { vec.out[p.id] = v; });
        cell.dataset.row = String(i);
        cell.dataset.col = String(col++);
        const wrap = h('div', { class: 'cell' }, cell);
        // What you asked for stays where you typed it, and what the circuit
        // actually did is put beside it. Reading the difference is the whole
        // job of a failing test, and it should not need a hover to do it.
        const got = result?.actual[p.name];
        if (got !== undefined && got !== ((result?.expected[p.name] ?? 0) >>> 0)) {
          wrap.appendChild(h('span', {
            class: 'got', title: `${p.name} came out as this`,
          }, this.show(got, p)));
        }
        tr.appendChild(h('td', null, wrap));
      }
      tr.appendChild(h('td', { class: 'res' }, button(null, {
        icon: 'x', title: 'Remove row',
        onClick: () => { this.vectors.splice(i, 1); this.save(); this.render(); },
      })));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    this.tableWrap.appendChild(table);
  }

  /* ---------------- the waveform ---------------- */

  /**
   * The same vectors, laid out along time instead of down the page.
   *
   * Nothing about the test changes: a vector is still one step, the circuit is
   * still not reset between them, and the runner is the same. What changes is
   * that a one-bit signal is drawn rather than typed, because a latch is
   * defined by what it does when its inputs are *not* changing, and a column
   * of noughts and ones hides exactly that. Wide pins keep their numbers --
   * there is no honest way to draw sixteen bits as one line -- and the columns
   * widen to fit them so the rows stay in step.
   */
  private renderWave(sig: ReturnType<typeof signatureOf>) {
    const wide = sig.inputs.concat(sig.outputs).filter((p) => p.width > 1);
    if (wide.length) {
      const names = wide.map((p) => this.columnName(p)).join(', ');
      this.tableWrap.appendChild(h('div', { class: 'tests-empty' },
        h('div', null, 'Nothing here can be drawn as a waveform'),
        h('div', { class: 'hint', style: { marginTop: '6px' } },
          `${names} ${wide.length === 1 ? 'is' : 'are'} more than one bit wide, and a `
          + 'number has no up and down. Use the grid, which is the better way to read '
          + 'a wide value anyway.')));
      return;
    }

    const cols = this.vectors.length;
    const colW = COL_W;
    const grid = h('div', { class: 'wave-grid' });

    /* ----- the time axis ----- */

    const axis = h('div', { class: 'wave-axis' }, h('div', { class: 'wave-gutter' }, 'step'));
    const strip = h('div', { class: 'wave-strip' });
    this.vectors.forEach((_, i) => {
      const result = this.results?.results[i];
      const cell = h('div', {
        class: `wave-tick${result ? (result.pass ? ' pass' : ' fail') : ''}`,
        style: { width: `${colW}px` },
        title: 'Remove this step',
        onclick: () => { this.vectors.splice(i, 1); this.save(); this.render(); },
      }, h('span', { class: 'n' }, String(i)), h('span', { class: 'x' }, '\u00d7'));
      strip.appendChild(cell);
    });
    strip.appendChild(button(null, {
      icon: 'plus', title: 'Add a step',
      onClick: () => {
        const blank: TestVector = { in: {}, out: {} };
        // A new step starts where the last one left off, because a waveform is
        // read as "and then": holding a signal steady is the commonest thing
        // to draw, and it should not need drawing twice.
        const last = this.vectors[this.vectors.length - 1];
        for (const p of sig.inputs) blank.in[p.id] = last?.in[p.id] ?? 0;
        for (const p of sig.outputs) blank.out[p.id] = last?.out[p.id] ?? 0;
        this.vectors.push(blank);
        this.save();
        this.render();
      },
    }));
    axis.appendChild(strip);
    grid.appendChild(axis);

    /* ----- one row per pin ----- */

    const row = (pin: Pin, side: 'in' | 'out', first = false) => {
      const store = side === 'in' ? 'in' : 'out';
      const get = (c: number) => this.vectors[c]?.[store][pin.id] ?? 0;
      const set = (c: number, v: number) => { this.vectors[c][store][pin.id] = v; };
      const track = h('div', { class: 'wave-track', style: { width: `${cols * colW}px` } });

      const svg = svgEl('svg', {
        class: 'wave-svg', width: String(cols * colW), height: String(ROW_H),
        viewBox: `0 0 ${cols * colW} ${ROW_H}`,
      });
      const path = svgEl('path', { class: side === 'in' ? 'wv-in' : 'wv-exp' });
      // Shown under the pointer: the value this column would take if it were
      // clicked, so the hint reads as where you are about to put it rather
      // than where it already is.
      const flips: SVGElement[] = [];
      const redraw = () => {
        path.setAttribute('d', wavePath(cols, colW, get));
        flips.forEach((t, c) => { t.textContent = get(c) ? '0' : '1'; });
      };

      // What the circuit actually did, when it disagrees. Drawn over the
      // expectation rather than beside it so the divergence is a shape.
      if (this.results?.ran && side === 'out') {
        const actual = (c: number) =>
          (this.results!.results[c]?.actual[pin.name] ?? 0) & 1;
        if (this.vectors.some((_, c) => actual(c) !== get(c))) {
          // Nudged down a little. Where the two agree they would otherwise
          // lie on exactly the same pixels, and the expectation would look
          // like a dashed line rather than like a line being met.
          svg.appendChild(svgEl('path', {
            class: 'wv-got', d: wavePath(cols, colW, actual),
            transform: 'translate(0 3)',
          }));
        }
      }
      for (let c = 0; c < cols; c++) {
        svg.appendChild(svgEl('rect', {
          class: 'wave-hit', x: String(c * colW), y: '0',
          width: String(colW), height: String(ROW_H),
        }));
        const hint = svgEl('text', {
          class: 'wave-flip', x: String(c * colW + colW / 2), y: String(ROW_H / 2),
          'text-anchor': 'middle', 'dominant-baseline': 'central',
        });
        flips.push(hint);
        svg.appendChild(hint);
      }
      // Last, so the signal is drawn over its own hover tint rather than under
      // it. It takes no pointer events, or it would shadow the cell it sits on.
      svg.appendChild(path);
      redraw();

      // Painting is driven off the pointer's x rather than off which cell it
      // entered. A quick drag only produces a handful of move events, and
      // one of them can straddle two columns -- so every column between the
      // last one painted and this one is filled in, and a fast sweep leaves
      // no gaps behind it.
      const colAt = (clientX: number) => {
        const box = svg.getBoundingClientRect();
        return Math.max(0, Math.min(cols - 1, Math.floor((clientX - box.left) / colW)));
      };
      svg.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        const first = colAt(e.clientX);
        const value = get(first) ? 0 : 1;
        let last = first;
        const paint = (to: number) => {
          for (let c = Math.min(last, to); c <= Math.max(last, to); c++) set(c, value);
          last = to;
          redraw();
        };
        paint(first);
        // Listeners before capture, and capture allowed to fail: the save
        // happens on pointerup, and nothing that is merely an optimisation
        // for dragging outside the row should be able to stop it running.
        const move = (m: PointerEvent) => paint(colAt(m.clientX));
        const done = () => {
          svg.removeEventListener('pointermove', move);
          this.save();
          this.render();
        };
        svg.addEventListener('pointermove', move);
        svg.addEventListener('pointerup', done, { once: true });
        svg.addEventListener('pointercancel', done, { once: true });
        try { svg.setPointerCapture(e.pointerId); } catch { /* moves still arrive */ }
      });
      track.appendChild(svg);
      grid.appendChild(h('div', { class: `wave-row ${side}${first ? ' first' : ''}` },
        h('div', { class: 'wave-gutter', title: this.columnName(pin) }, pin.name),
        track));
    };

    sig.inputs.forEach((p, i) => row(p, 'in', i === 0));
    sig.outputs.forEach((p, i) => row(p, 'out', i === 0));
    this.tableWrap.appendChild(grid);
  }

  /* ---------------- what happened ---------------- */

  private renderSummary(sig: ReturnType<typeof signatureOf>) {

    const unmatched = [...new Set([...this.orphaned, ...(this.results?.unknownPins ?? [])])];
    if (unmatched.length) {
      const n = unmatched.length;
      // Most orphans are keyed by pin id, which means nothing to read; only
      // the ones written under a name are worth naming back.
      const named = unmatched.filter((k) => !/^i_/.test(k));
      const which = named.length ? ` (${named.join(', ')})` : '';
      const pins = sig.inputs.concat(sig.outputs).map((p) => p.name).join(', ');
      this.summary.appendChild(h('div', { style: { color: 'var(--warn)' } },
        `${n} saved column${n === 1 ? '' : 's'}${which} `
        + `${n === 1 ? 'belongs' : 'belong'} to a pin this component no longer has, so `
        + `${n === 1 ? 'it is' : 'they are'} not shown. Nothing has been deleted: if the pin `
        + `comes back, so does the column. This component's pins are ${pins}.`));
    }
    if (this.results?.unstable) {
      this.summary.appendChild(h('div', { style: { color: 'var(--warn)' } },
        'Some steps never settled. With ticks at 0 the runner waits for the circuit to go '
        + 'quiet and gives up after 20,000 of them, which is most of why a run like this is '
        + 'slow. A circuit with a latch in it is not meant to go quiet on its own: give it a '
        + 'tick count instead, comfortably more than its deepest path of gates.'));
    }
    if (this.results?.ran) {
      const failed = this.results.total - this.results.passed;
      this.summary.appendChild(h('div', { style: { color: failed ? 'var(--danger)' : 'var(--ok)' } },
        failed
          ? `${this.results.passed} of ${this.results.total} tests pass.`
          : this.results.total === 1 ? 'The test passes.' : `All ${this.results.total} tests pass.`));
    } else if (this.results?.errors.length) {
      this.summary.appendChild(h('div', { style: { color: 'var(--danger)' } },
        this.results.errors[0].message));
    }
    this.summary.appendChild(h('div', { class: 'hint' },
      this.mode === 'wave'
        ? 'Click or drag along a row to draw it; drag paints whatever you started with. '
          + 'Each column is one step in time, and the circuit is not reset between them, so a '
          + 'column means "and then". Ticks is how long a column lasts, and it has to be longer '
          + 'than the deepest path of gates in the circuit or you are reading it midway through '
          + 'settling: a couple for a gate, a couple of dozen for anything with a flip-flop in it.'
        : 'Arrow keys move between cells, Enter steps down a row. '
          + 'Leave ticks at 0 for combinational logic; the runner settles until nothing is left to '
          + 'propagate. Set it for sequential circuits so each test advances the clock by a fixed amount.'));
  }

  private columnName(pin: Pin): string {
    return pin.width > 1 ? `${pin.name}[${pin.width}]` : pin.name;
  }
}

/** An SVG element with attributes; `h` builds HTML, which will not do here. */
function svgEl(tag: string, attrs: Record<string, string>): SVGElement {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

/**
 * A square wave across `cols` columns. High sits at the top of the band and
 * low at the bottom, with a vertical wherever the value changes -- the edge is
 * the part worth seeing, so it is drawn rather than implied by a step in a
 * table.
 */
function wavePath(cols: number, colW: number, at: (col: number) => number): string {
  if (!cols) return '';
  const top = (ROW_H - AMP) / 2;
  const y = (v: number) => (v ? top : top + AMP);
  const pts: Array<[number, number]> = [];
  let prev: number | null = null;
  for (let c = 0; c < cols; c++) {
    const next = y(at(c));
    if (prev !== null && next !== prev) pts.push([c * colW, prev]);
    pts.push([c * colW, next]);
    prev = next;
  }
  pts.push([cols * colW, prev!]);
  return 'M' + pts.map(([x, v]) => `${x},${v}`).join(' L');
}

function readMode(): 'grid' | 'wave' {
  return localStorage.getItem(VIEW_KEY) === 'wave' ? 'wave' : 'grid';
}
