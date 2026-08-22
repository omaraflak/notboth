import { formatValue } from '../core/layout';
import { MAX_WIDTH } from '../core/types';
import { clampWidth, isPrim, primKind, primName } from '../core/primitives';
import { asIdentifier, defSignature, movePort, signatureOf, usageCount } from '../core/project';
import type { Instance, NumberFormat, Wire } from '../core/types';
import type { App } from './app';
import { button, clear, h, icon } from './dom';
import { memoryEditor, memoryViewer, parseNumber } from './dialogs';

const WIRE_COLORS = ['', '#e0483a', '#e08b1f', '#2f9e57', '#2f7fe0', '#8b4fd8', '#c73f8f'];

export class Inspector {
  private editing = false;
  private tickUpdaters: (() => void)[] = [];
  /** Everything that scrolls. The footer below it does not. */
  private body: HTMLElement;
  private foot: HTMLElement;

  constructor(
    private app: App,
    host: HTMLElement,
    private onExtract: () => void,
    private onArrange: () => void = () => {},
  ) {
    this.body = h('div', { class: 'insp-body' });
    this.foot = h('div', { class: 'insp-foot' });
    host.appendChild(this.body);
    host.appendChild(this.foot);
    host.addEventListener('focusin', () => { this.editing = true; });
    host.addEventListener('focusout', () => {
      this.editing = false;
      setTimeout(() => { if (!this.editing) this.render(); }, 0);
    });

    app.on('selection', () => this.render(true));
    app.on('project', () => this.render());
    // The footer's one button is only meaningful over a schematic, so it goes
    // grey in the other views -- which means a change of view is a change to
    // this panel, and it has to be redrawn for it. Without this the button
    // stayed disabled after coming back from the code view, until some
    // unrelated edit happened to redraw the panel underneath it.
    app.on('view', () => this.render());
    app.on('sim', () => this.render());
    app.on('tick', () => { for (const fn of this.tickUpdaters) fn(); });
    this.render(true);
  }

  render(force = false) {
    // Re-rendering while a field has focus would steal the caret.
    if (this.editing && !force) return;
    const app = this.app;
    clear(this.body);
    clear(this.foot);
    this.tickUpdaters = [];

    const instances = app.selectedInstances;
    const wires = app.selectedWires;

    // The component itself is always the first thing here. What is selected is
    // a detail *about* this component, so it belongs underneath rather than in
    // place of it: selecting a gate should never hide what you are working on.
    this.componentSection();

    if (instances.length === 1) this.instanceSection(instances[0]);
    else if (instances.length > 1) this.multiSection(instances.length);
    // Wires attached to a selected part came along with it rather than being
    // picked, so they get a panel only when they are what was picked.
    else if (wires.length === 1) this.wireSection(wires[0]);
    else if (wires.length > 1) this.section('Wires', [h('div', { class: 'hint' }, `${wires.length} wires selected.`)]);

    this.errorSection();
    this.signalsSection();
    this.renderFoot();
  }

  /** Pinned to the bottom, so it is in the same place whatever is selected. */
  private renderFoot() {
    const def = this.app.openDef;
    this.foot.appendChild(button('Arrange schematic', {
      icon: 'layers', className: 'bordered',
      disabled: !def.instances.length || this.app.mode !== 'schematic',
      onClick: () => this.onArrange(),
    }));
  }

  private section(title: string, children: (Node | null)[]): HTMLElement {
    const el = h('div', { class: 'insp-section' }, h('h3', null, title));
    for (const c of children) if (c) el.appendChild(c);
    this.body.appendChild(el);
    return el;
  }

  /* ---------------- open component ---------------- */

  private componentSection() {
    const app = this.app;
    const def = app.openDef;
    const sig = signatureOf(def);
    const uses = usageCount(app.project, def.id);

    const pins = h('div');
    const list = (label: string, arr: typeof sig.inputs) => {
      if (!arr.length) return;
      pins.appendChild(h('div', { class: 'hint', style: { marginTop: '6px', marginBottom: '2px' } }, label));
      for (const p of arr) {
        pins.appendChild(h('div', { class: 'sig-pin' },
          h('div', { class: 'dot' }),
          h('span', null, p.name),
          p.width > 1 ? h('span', { class: 'w' }, `[${p.width}]`) : null));
      }
    };
    list('Inputs', sig.inputs);
    list('Outputs', sig.outputs);
    if (!sig.inputs.length && !sig.outputs.length) {
      pins.appendChild(h('div', { class: 'hint' },
        'No ports yet. Place In and Out markers to give this component pins; each one carries as many bits as its Width says.'));
    }

    this.section(def.name, [
      h('div', { class: 'hint', style: { marginTop: '-4px' } },
        uses ? `Used ${uses} time${uses === 1 ? '' : 's'} in this project.` : 'Not used anywhere yet.'),
      pins,
    ]);
  }

  /* ---------------- instance ---------------- */

  private instanceSection(inst: Instance) {
    const app = this.app;
    const kind = isPrim(inst.def) ? primKind(inst.def) : null;

    if (!kind) {
      const def = app.project.defs.find((d) => d.id === inst.def);
      const sig = defSignature(app.project, inst.def);
      this.section(def?.name ?? 'Component', [
        h('div', { class: 'hint', style: { marginTop: '-4px' } },
          `${sig.inputs.length} in, ${sig.outputs.length} out. Instances follow the definition, so editing it updates every copy.`),
        h('div', { class: 'field', style: { marginTop: '8px' } },
          button('Open definition', { icon: 'chip', className: 'bordered', onClick: () => app.openComponent(inst.def) })),
      ]);
      return;
    }

    const fields: (Node | null)[] = [];
    const mutate = (fn: () => void) => app.mutate(fn);

    switch (kind) {
      case 'NAND':
        fields.push(h('div', { class: 'hint', style: { marginTop: '-4px' } },
          'Nand has no settings. Every gate takes exactly one tick to propagate, which is what makes feedback loops latch predictably.'));
        break;

      case 'IN':
      case 'OUT': {
        fields.push(this.textField('Name', inst.props.name ?? kind.toLowerCase(),
          (v) => mutate(() => { inst.props.name = asIdentifier(v, kind.toLowerCase()); })));
        fields.push(this.widthField(inst, mutate));
        const sig = signatureOf(app.openDef);
        const list = kind === 'IN' ? sig.inputs : sig.outputs;
        const at = list.findIndex((p) => p.id === inst.id);
        fields.push(h('div', { class: 'field' },
          h('label', null, 'Order'),
          h('div', { class: 'control', style: { display: 'flex', gap: '4px', alignItems: 'center' } },
            button(null, {
              icon: 'chevron', title: 'Earlier in the pin list',
              className: 'rot-up', disabled: at <= 0,
              onClick: () => mutate(() => { movePort(app.openDef, inst.id, -1); }),
            }),
            button(null, {
              icon: 'chevron', title: 'Later in the pin list',
              className: 'rot-down', disabled: at < 0 || at >= list.length - 1,
              onClick: () => mutate(() => { movePort(app.openDef, inst.id, 1); }),
            }),
            h('span', { class: 'row-meta' }, `${at + 1} of ${list.length}`),
          )));
        fields.push(h('div', { class: 'hint' },
          'Port markers are this component\'s pins. Bits is how wide the pin is -- 1 for a single '
          + 'signal, 16 for a whole 16-bit bus down one wire. Their order is independent of where '
          + 'they sit, so arranging the schematic never changes the interface.'));
        break;
      }

      case 'TOGGLE': {
        fields.push(this.textField('Name', inst.props.name ?? 'sw',
          (v) => mutate(() => { inst.props.name = asIdentifier(v, 'sw'); })));
        fields.push(this.widthField(inst, mutate));
        fields.push(this.valueField(inst));
        break;
      }

      case 'CONST':
        fields.push(this.widthField(inst, mutate));
        fields.push(this.numberField('Value', inst.props.value ?? 0, (v) => mutate(() => { inst.props.value = v; })));
        break;

      case 'CLOCK': {
        const period = Math.max(2, inst.props.period ?? 16);
        fields.push(this.numberField('Period', period, (v) => mutate(() => { inst.props.period = Math.max(2, v); }), 2, 100000));
        fields.push(h('div', { class: 'hint' },
          `Measured in ticks: high for ${Math.floor(period / 2)}, low for ${Math.floor(period / 2)}. `
          + 'Keep it comfortably longer than the deepest chain of gates it drives, so logic settles before the next edge.'));
        break;
      }

      case 'PROBE': {
        fields.push(this.textField('Name', inst.props.name ?? 'probe',
          (v) => mutate(() => { inst.props.name = asIdentifier(v, 'probe'); })));
        fields.push(this.widthField(inst, mutate));
        fields.push(this.selectField('Format', inst.props.format ?? 'hex',
          [['hex', 'Hex'], ['bin', 'Binary'], ['dec', 'Decimal'], ['sdec', 'Signed']],
          (v) => mutate(() => { inst.props.format = v as NumberFormat; })));
        break;
      }

      case 'ROM':
      case 'RAM': {
        const addrWidth = clampWidth(inst.props.addrWidth, 8);
        const dataWidth = clampWidth(inst.props.dataWidth, 16);
        fields.push(this.numberField('Address', addrWidth, (v) => mutate(() => { inst.props.addrWidth = clampWidth(v, 8); }), 1, 20));
        fields.push(this.numberField('Data', dataWidth, (v) => mutate(() => { inst.props.dataWidth = clampWidth(v, 16); }), 1, MAX_WIDTH));
        fields.push(h('div', { class: 'hint' },
          `${(1 << addrWidth).toLocaleString()} words of ${dataWidth} bits. `
          + 'Backed by a real array rather than gates, the way SRAM is a cell and not a netlist.'));
        fields.push(h('div', { class: 'field', style: { marginTop: '8px' } },
          button(kind === 'ROM' ? 'Edit program' : 'Set initial contents', {
            icon: 'memory', className: 'bordered', onClick: () => memoryEditor(app, inst, kind),
          })));
        if (kind === 'RAM') {
          fields.push(h('div', { class: 'field' },
            button('View live memory', {
              icon: 'search', className: 'bordered',
              disabled: !app.powered,
              onClick: () => memoryViewer(app, inst),
            })));
        }
        break;
      }
    }

    this.section(primName(kind), fields);
  }

  private multiSection(count: number) {
    this.section(`${count} selected`, [
      h('div', { class: 'field' },
        button('Make component', {
          icon: 'chip', className: 'bordered',
          onClick: () => this.onExtract(),
        })),
      h('div', { class: 'hint' },
        'Packages the selection into a new named component and drops it back in place. '
        + 'Wires crossing the boundary become its pins. Also on the right-click menu.'),
    ]);
  }

  /* ---------------- wire ---------------- */

  private wireSection(wire: Wire) {
    const app = this.app;
    const def = app.openDef;
    const pinInfo = (endpoint: { inst: string; pin: string }) => {
      const inst = def.instances.find((i) => i.id === endpoint.inst);
      if (!inst) return { name: '?', width: 1 };
      const sig = defSignature(app.project, inst.def, inst.props);
      const pin = [...sig.inputs, ...sig.outputs].find((p) => p.id === endpoint.pin);
      return { name: pin?.name ?? '?', width: pin?.width ?? 1 };
    };
    const from = pinInfo(wire.from);
    const to = pinInfo(wire.to);
    const bits = wire.from.hi - wire.from.lo + 1;
    const mismatch = bits !== wire.to.hi - wire.to.lo + 1;

    const swatches = h('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap' } });
    for (const color of WIRE_COLORS) {
      const sw = h('button', {
        title: color || 'Default',
        style: {
          width: '20px', height: '20px', borderRadius: '5px',
          background: color || 'var(--wire)',
          border: `2px solid ${(wire.color ?? '') === color ? 'var(--accent)' : 'transparent'}`,
        },
        onclick: () => app.mutate(() => { if (color) wire.color = color; else delete wire.color; }),
      });
      swatches.appendChild(sw);
    }

    this.section('Wire', [
      h('div', { class: 'sig-pin' }, h('span', null, `${from.name}[${from.width}]`),
        icon('chevron', 10), h('span', null, `${to.name}[${to.width}]`)),
      h('div', { class: 'hint', style: { marginTop: '2px', marginBottom: '8px' } },
        `${bits} bit${bits === 1 ? '' : 's'}${mismatch ? ' - the two ends do not match' : ''}`),
      this.rangeField('From bits', wire.from.lo, wire.from.hi, from.width,
        (lo, hi) => app.mutate(() => { wire.from.lo = lo; wire.from.hi = hi; })),
      this.rangeField('To bits', wire.to.lo, wire.to.hi, to.width,
        (lo, hi) => app.mutate(() => { wire.to.lo = lo; wire.to.hi = hi; })),
      h('div', { class: 'hint', style: { marginBottom: '8px' } },
        'Slice a bus here to split it, or drive different bit ranges of one input from different sources to merge.'),
      h('div', { class: 'field field-col' }, h('label', null, 'Colour'), swatches),
    ]);
  }

  /* ---------------- errors and live signals ---------------- */

  private errorSection() {
    const errors = this.app.errors;
    if (!errors.length) return;
    const list = h('div', { class: 'err-list' });
    const seen = new Set<string>();
    for (const e of errors) {
      if (seen.has(e.message)) continue;
      seen.add(e.message);
      list.appendChild(h('div', { class: 'err-item' }, icon('x', 12), h('span', null, e.message)));
    }
    this.section(`${seen.size} problem${seen.size === 1 ? '' : 's'}`, [list]);
  }

  /**
   * Toggles and probes nested inside components are unreachable on the canvas,
   * so the flattener surfaces them here by their path through the hierarchy.
   */
  private signalsSection() {
    const app = this.app;
    const nl = app.netlist;
    if (!app.powered || !nl || !app.sim) return;
    const nested = nl.toggles.filter((t) => !t.top);
    const probes = nl.probes;
    if (!nested.length && !probes.length) return;

    const rows: Node[] = [];
    nested.forEach((t) => {
      const index = nl.toggles.indexOf(t);
      const bits = h('div', { style: { display: 'flex', gap: '2px' } });
      for (let b = t.width - 1; b >= 0; b--) {
        const cell = h('button', { class: 'bit' }, String(b));
        cell.addEventListener('click', () => {
          const next = (t.value ^ (1 << b)) >>> 0;
          app.sim!.setToggle(index, next);
          app.emit('tick');
        });
        bits.appendChild(cell);
        this.tickUpdaters.push(() => {
          const on = (app.sim!.readNets(t.nets) >>> b) & 1;
          cell.classList.toggle('on', !!on);
          cell.textContent = on ? '1' : '0';
        });
      }
      rows.push(h('div', { class: 'signal-row' }, h('span', { class: 'path' }, t.path), bits));
    });

    probes.forEach((p) => {
      const val = h('span', { class: 'val' });
      this.tickUpdaters.push(() => {
        val.textContent = formatValue(app.sim!.readNets(p.nets), p.width, p.format);
      });
      rows.push(h('div', { class: 'signal-row' }, h('span', { class: 'path' }, p.path), val));
    });

    this.section('Signals', rows);
    for (const fn of this.tickUpdaters) fn();
  }

  /* ---------------- field builders ---------------- */

  private textField(label: string, value: string, onCommit: (v: string) => void): HTMLElement {
    const input = h('input', { type: 'text', value });
    const commit = () => {
      const v = input.value.trim();
      if (v && v !== value) onCommit(v);
    };
    input.addEventListener('change', commit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
    return h('div', { class: 'field' }, h('label', null, label), h('div', { class: 'control' }, input));
  }

  private numberField(
    label: string, value: number, onCommit: (v: number) => void, min = 0, max = 1 << 30,
  ): HTMLElement {
    const input = h('input', { type: 'number', value: String(value), min: String(min), max: String(max) });
    input.addEventListener('change', () => {
      const v = Number(input.value);
      if (Number.isFinite(v) && v !== value) onCommit(Math.max(min, Math.min(max, Math.round(v))));
    });
    return h('div', { class: 'field' }, h('label', null, label), h('div', { class: 'control' }, input));
  }

  private selectField(
    label: string, value: string, options: [string, string][], onChange: (v: string) => void,
  ): HTMLElement {
    const select = h('select', null,
      ...options.map(([v, text]) => h('option', { value: v, selected: v === value }, text)));
    select.addEventListener('change', () => onChange(select.value));
    return h('div', { class: 'field' }, h('label', null, label), h('div', { class: 'control' }, select));
  }

  private widthField(inst: Instance, mutate: (fn: () => void) => void): HTMLElement {
    return this.numberField('Bits', clampWidth(inst.props.width), (v) => {
      mutate(() => { inst.props.width = clampWidth(v); });
    }, 1, MAX_WIDTH);
  }

  /** A toggle's value is live state, not an edit, so it bypasses undo. */
  private valueField(inst: Instance): HTMLElement {
    const app = this.app;
    const width = clampWidth(inst.props.width);
    const wrap = h('div', { style: { display: 'flex', gap: '2px', flexWrap: 'wrap' } });
    const apply = (next: number) => {
      inst.props.value = next >>> 0;
      const index = app.netlist?.toggles.findIndex((t) => t.instId === inst.id) ?? -1;
      if (index >= 0) app.sim?.setToggle(index, next);
      app.persist();
      app.emit('tick');
      sync();
    };
    const cells: HTMLButtonElement[] = [];
    for (let b = width - 1; b >= 0; b--) {
      const bit = b;
      const cell = h('button', { class: 'bit' });
      cell.addEventListener('click', () => apply(((inst.props.value ?? 0) ^ (1 << bit)) >>> 0));
      cells.push(cell);
      wrap.appendChild(cell);
    }
    const readout = h('span', { class: 'val', style: { marginLeft: '6px' } });
    const sync = () => {
      const v = inst.props.value ?? 0;
      cells.forEach((cell, i) => {
        const bit = width - 1 - i;
        const on = (v >>> bit) & 1;
        cell.classList.toggle('on', !!on);
        cell.textContent = on ? '1' : '0';
      });
      readout.textContent = width > 1 ? formatValue(v, width, 'hex') : '';
    };
    sync();
    this.tickUpdaters.push(sync);
    return h('div', { class: 'field field-col' },
      h('label', null, 'Value'),
      h('div', { style: { display: 'flex', alignItems: 'center' } }, wrap, readout));
  }

  private rangeField(
    label: string, lo: number, hi: number, width: number, onCommit: (lo: number, hi: number) => void,
  ): HTMLElement {
    const input = h('input', {
      type: 'text',
      value: lo === hi ? String(lo) : `${hi}..${lo}`,
      placeholder: `0..${width - 1}`,
    });
    input.addEventListener('change', () => {
      const text = input.value.trim();
      const m = text.match(/^(\d+)\s*(?:\.\.\s*(\d+))?$/);
      if (!m) { input.value = lo === hi ? String(lo) : `${hi}..${lo}`; return; }
      const a = parseNumber(m[1]) ?? 0;
      const b = m[2] !== undefined ? (parseNumber(m[2]) ?? a) : a;
      const nextHi = Math.min(width - 1, Math.max(a, b));
      const nextLo = Math.max(0, Math.min(a, b));
      onCommit(nextLo, nextHi);
    });
    return h('div', { class: 'field' },
      h('label', null, label),
      h('div', { class: 'control' }, input),
      h('span', { class: 'row-meta' }, `/${width}`));
  }
}
