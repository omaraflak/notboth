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
    this.head.appendChild(button('Run', {
      icon: 'beaker', className: 'primary',
      disabled: !this.vectors.length,
      onClick: () => {
        this.results = runTests(app.project, def.id, {
          vectors: this.vectors,
          settleTicks: this.settleTicks,
          resetEachVector: this.resetEach,
        });
        this.render();
      },
    }));

    /* ----- the table ----- */

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
      tr.appendChild(h('td', { class: 'res', style: { color: 'var(--text-faint)' } }, String(i)));
      let col = 0;
      for (const p of sig.inputs) {
        const cell = this.cell(p, vec.in[p.id] ?? 0, (v) => { vec.in[p.id] = v; });
        cell.dataset.row = String(i);
        cell.dataset.col = String(col++);
        tr.appendChild(h('td', null, cell));
      }
      for (const p of sig.outputs) {
        const cell = this.cell(p, vec.out[p.id] ?? 0, (v) => { vec.out[p.id] = v; });
        cell.dataset.row = String(i);
        cell.dataset.col = String(col++);
        const td = h('td', null, cell);
        if (result && !result.pass) {
          td.title = `got ${this.show(result.actual[p.name] ?? 0, p)}`;
        }
        tr.appendChild(td);
      }
      tr.appendChild(h('td', { class: 'res' }, button(null, {
        icon: 'x', title: 'Remove row',
        onClick: () => { this.vectors.splice(i, 1); this.save(); this.render(); },
      })));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    this.tableWrap.appendChild(table);

    if (!this.vectors.length) {
      this.tableWrap.appendChild(h('div', { class: 'hint', style: { padding: '12px 2px' } },
        'No tests yet. Add one, then fill in the inputs and what the outputs should be.'));
    }

    /* ----- what happened ----- */

    const unmatched = [...new Set([...this.orphaned, ...(this.results?.unknownPins ?? [])])];
    if (unmatched.length) {
      const names = sig.inputs.concat(sig.outputs).map((p) => p.name).join(', ');
      this.summary.appendChild(h('div', { style: { color: 'var(--warn)' } },
        `Dropped ${unmatched.length} column${unmatched.length === 1 ? '' : 's'} `
        + `(${unmatched.join(', ')}) - no pin by that name any more. This component's pins are: ${names}.`));
    }
    if (this.results?.ran) {
      const failed = this.results.total - this.results.passed;
      this.summary.appendChild(h('div', { style: { color: failed ? 'var(--danger)' : 'var(--ok)' } },
        failed
          ? `${this.results.passed} of ${this.results.total} tests pass. Hover a red cell to see what it produced.`
          : this.results.total === 1 ? 'The test passes.' : `All ${this.results.total} tests pass.`));
    } else if (this.results?.errors.length) {
      this.summary.appendChild(h('div', { style: { color: 'var(--danger)' } },
        this.results.errors[0].message));
    }
    this.summary.appendChild(h('div', { class: 'hint' },
      'Arrow keys move between cells, Enter steps down a row. '
      + 'Leave ticks at 0 for combinational logic; the runner settles until nothing is left to '
      + 'propagate. Set it for sequential circuits so each test advances the clock by a fixed amount.'));
  }

  private columnName(pin: Pin): string {
    return pin.width > 1 ? `${pin.name}[${pin.width}]` : pin.name;
  }
}
