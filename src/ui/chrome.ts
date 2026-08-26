import { SPEEDS, type App, type EditorMode } from './app';
import { button, clear, h, icon } from './dom';
import { projectsDialog, promptText, shortcutsDialog, simulationHelpDialog } from './dialogs';
import { currentTheme, toggleTheme } from './theme';

export class Chrome {
  private left = h('div', { class: 'bar-left' });
  private tabs = h('div', { class: 'bar-tabs' });
  private center = h('div', { class: 'bar-center' });
  private right = h('div', { class: 'bar-right' });

  private projectBtn: HTMLButtonElement | null = null;
  private tabBtns = new Map<EditorMode, HTMLButtonElement>();
  private powerBtn: HTMLButtonElement | null = null;
  private powerLabel: HTMLSpanElement | null = null;
  private runBtn: HTMLButtonElement | null = null;
  private stepBtn: HTMLButtonElement | null = null;
  private resetBtn: HTMLButtonElement | null = null;
  private speedSlider: HTMLInputElement | null = null;
  private speedOut: HTMLSpanElement | null = null;
  private undoBtn: HTMLButtonElement | null = null;
  private redoBtn: HTMLButtonElement | null = null;
  private themeBtn: HTMLButtonElement | null = null;

  constructor(
    private app: App,
    topbar: HTMLElement,
    private statusbar: HTMLElement,
    private actions: { fit: () => void; setMode: (mode: EditorMode) => void },
  ) {
    topbar.appendChild(this.left);
    topbar.appendChild(this.tabs);
    topbar.appendChild(this.center);
    topbar.appendChild(this.right);

    app.on('project', () => { this.renderBars(); });
    app.on('selection', () => this.renderStatus());
    app.on('sim', () => { this.renderBars(); });
    app.on('view', () => this.renderTop());
    app.on('tick', () => this.renderStatus());
    this.renderBars();
  }

  private renderBars() {
    this.renderTop();
    this.renderStatus();
  }

  /**
   * The bar is built once and then kept in step, never re-created. That is not
   * only cheaper: a CSS transition cannot run on an element that was replaced
   * between frames, so rebuilding the power switch on every `sim` event is
   * exactly what stops its knob from sliding.
   */
  private buildTop() {
    const app = this.app;

    /* ----- left: project and open component ----- */

    this.projectBtn = button(app.project.name, {
      icon: 'layers', title: 'Projects', className: 'bordered project-name',
      onClick: () => projectsDialog(app),
    });
    this.left.appendChild(this.projectBtn);

    // The open component is named in the library, where it is highlighted, and
    // again at the top of the inspector -- so the bar does not repeat it.

    const seg = h('div', { class: 'seg' });
    const tab = (label: string, mode: EditorMode, hint: string) => {
      const el = h('button', { title: hint, onclick: () => this.actions.setMode(mode) }, label);
      this.tabBtns.set(mode, el);
      seg.appendChild(el);
    };
    tab('Schematic', 'schematic', 'Draw this component');
    tab('Code', 'code', 'Write this component out as text');
    tab('Tests', 'tests', 'Truth table for this component');
    // Sat against the left panel's edge, so the switch lines up with the pane
    // it switches rather than floating next to the project name.
    this.tabs.appendChild(seg);

    /* ----- centre: the power switch and what it drives ----- */

    this.powerLabel = h('span', { class: 'power-label' }, app.powered ? 'On' : 'Off');
    this.powerBtn = h('button', {
      class: 'power',
      role: 'switch',
      title: 'Turn the electricity on or off  (Cmd/Ctrl Enter)',
      onclick: () => app.togglePower(),
    },
    h('span', { class: 'power-track' }, h('span', { class: 'power-knob' })),
    this.powerLabel);
    this.center.appendChild(this.powerBtn);

    this.runBtn = button(null, {
      icon: 'play', onClick: () => (app.running ? app.pause() : app.resume()),
    });
    this.stepBtn = button(null, {
      icon: 'step', title: 'Advance one tick', onClick: () => app.stepOnce(1),
    });
    this.resetBtn = button(null, {
      icon: 'reset', title: 'Reset all state to zero', onClick: () => app.resetSim(),
    });
    this.center.appendChild(this.runBtn);
    this.center.appendChild(this.stepBtn);
    this.center.appendChild(this.resetBtn);

    this.center.appendChild(h('div', { class: 'sep' }));
    this.speedSlider = h('input', {
      type: 'range', min: '0', max: String(SPEEDS.length - 1), step: '1',
      value: String(app.speedIndex),
      style: { width: '92px' },
      title: 'Simulation speed',
      oninput: (e: Event) => app.setSpeed(Number((e.target as HTMLInputElement).value)),
    });
    this.speedOut = h('span', {
      class: 'row-meta speed-readout', style: { width: '52px', textAlign: 'left' },
    }, speedLabel(app.speed));
    this.center.appendChild(this.speedSlider);
    this.center.appendChild(this.speedOut);
    this.center.appendChild(button(null, {
      icon: 'help', title: 'What these controls do, and what a tick is',
      onClick: () => simulationHelpDialog(),
    }));

    /* ----- right: history, view, theme ----- */

    this.undoBtn = button(null, { icon: 'undo', title: 'Undo  (Cmd/Ctrl Z)', onClick: () => app.undo() });
    this.redoBtn = button(null, { icon: 'redo', title: 'Redo  (Shift Cmd/Ctrl Z)', onClick: () => app.redo() });
    this.themeBtn = button(null, {
      icon: currentTheme() === 'dark' ? 'sun' : 'moon',
      title: 'Switch theme',
      onClick: () => { toggleTheme(); this.renderTop(); },
    });
    this.right.appendChild(this.undoBtn);
    this.right.appendChild(this.redoBtn);
    this.right.appendChild(h('div', { class: 'sep' }));
    this.right.appendChild(button(null, { icon: 'fit', title: 'Fit to circuit  (Shift F)', onClick: () => this.actions.fit() }));
    this.right.appendChild(this.themeBtn);
    this.right.appendChild(button(null, {
      icon: 'help', title: 'Keyboard and mouse', onClick: () => shortcutsDialog(),
    }));
  }

  /** Bring the existing controls in line with the app, touching nothing else. */
  private renderTop() {
    const app = this.app;
    if (!this.projectBtn) this.buildTop();

    setLabel(this.projectBtn!, app.project.name);
    for (const [mode, el] of this.tabBtns) el.classList.toggle('on', app.mode === mode);

    this.powerBtn!.classList.toggle('on', app.powered);
    this.powerBtn!.setAttribute('aria-checked', String(app.powered));
    this.powerLabel!.textContent = app.powered ? 'On' : 'Off';

    setIcon(this.runBtn!, app.running ? 'pause' : 'play');
    this.runBtn!.title = app.running ? 'Pause' : 'Run';
    this.runBtn!.classList.toggle('on', app.running);
    for (const b of [this.runBtn!, this.stepBtn!, this.resetBtn!]) b.disabled = !app.powered;

    this.speedSlider!.value = String(app.speedIndex);
    this.speedOut!.textContent = speedLabel(app.speed);

    this.undoBtn!.disabled = !app.canUndo;
    this.redoBtn!.disabled = !app.canRedo;
    setIcon(this.themeBtn!, currentTheme() === 'dark' ? 'sun' : 'moon');
  }

  private renderStatus() {
    const app = this.app;
    clear(this.statusbar);
    const nl = app.netlist;

    const add = (label: string, value: string) => {
      this.statusbar.appendChild(h('span', null, `${label} `, h('span', { class: 'num' }, value)));
    };

    if (nl) {
      add('gates', nl.gateCount.toLocaleString());
      add('nets', nl.netCount.toLocaleString());
    }
    if (app.powered && app.sim) {
      add('tick', app.sim.tick.toLocaleString());
      if (app.sim.unstable) {
        this.statusbar.appendChild(h('span', { class: 'badge warn' }, 'oscillating'));
      }
    }

    this.statusbar.appendChild(h('div', { class: 'spacer' }));

    if (app.armed) {
      const name = app.armed.startsWith('prim:')
        ? app.armed.slice(5)
        : app.project.defs.find((d) => d.id === app.armed)?.name ?? '';
      this.statusbar.appendChild(h('span', { style: { color: 'var(--accent)' } },
        `Click to place ${name} - hold Shift for several - Esc to cancel`));
      this.statusbar.appendChild(h('div', { class: 'spacer' }));
    }

    const errors = app.errors;
    if (errors.length) {
      const unique = new Set(errors.map((e) => e.message)).size;
      this.statusbar.appendChild(h('span', { class: 'badge err' },
        `${unique} problem${unique === 1 ? '' : 's'}`));
    } else if (nl && nl.gateCount > 0) {
      this.statusbar.appendChild(h('span', { class: 'badge ok' }, 'ready'));
    }
    if (nl) add('compiled in', `${app.compileMs.toFixed(app.compileMs < 10 ? 1 : 0)}ms`);
  }
}

/** Swap a button's glyph without disturbing anything else on it. */
function setIcon(btn: HTMLButtonElement, name: string) {
  btn.querySelector('svg')?.replaceWith(icon(name));
}

/** Replace a button's text, leaving its glyph in place. */
function setLabel(btn: HTMLButtonElement, text: string) {
  const node = [...btn.childNodes].find((n) => n.nodeType === Node.TEXT_NODE);
  if (node) node.textContent = text; else btn.appendChild(document.createTextNode(text));
  btn.title = btn.title || text;
}

function speedLabel(speed: number): string {
  if (speed === Infinity) return 'max';
  if (speed >= 1000) return `${speed / 1000}k/s`;
  return `${speed}/s`;
}

export async function renameProject(app: App) {
  const name = await promptText('Rename project', 'Name', app.project.name);
  if (name) app.mutate(() => { app.project.name = name; });
}
