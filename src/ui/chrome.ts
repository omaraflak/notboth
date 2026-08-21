import { SPEEDS, type App, type EditorMode } from './app';
import { button, clear, h } from './dom';
import { projectsDialog, promptText, shortcutsDialog } from './dialogs';
import { currentTheme, toggleTheme } from './theme';

export class Chrome {
  private left = h('div', { class: 'bar-left' });
  private tabs = h('div', { class: 'bar-tabs' });
  private center = h('div', { class: 'bar-center' });
  private right = h('div', { class: 'bar-right' });

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

  private renderTop() {
    const app = this.app;
    clear(this.left);
    clear(this.tabs);
    clear(this.center);
    clear(this.right);

    /* ----- left: project and open component ----- */

    this.left.appendChild(button(app.project.name, {
      icon: 'layers', title: 'Projects', className: 'bordered project-name',
      onClick: () => projectsDialog(app),
    }));

    // The open component is named in the library, where it is highlighted, and
    // again at the top of the inspector -- so the bar does not repeat it.

    const seg = h('div', { class: 'seg' });
    const tab = (label: string, mode: EditorMode, hint: string) => h('button', {
      class: app.mode === mode ? 'on' : '',
      title: hint,
      onclick: () => this.actions.setMode(mode),
    }, label);
    seg.appendChild(tab('Schematic', 'schematic', 'Draw this component'));
    seg.appendChild(tab('Code', 'code', 'Write this component out as text'));
    seg.appendChild(tab('Tests', 'tests', 'Truth table for this component'));
    // Sat against the left panel's edge, so the switch lines up with the pane
    // it switches rather than floating next to the project name.
    this.tabs.appendChild(seg);

    /* ----- centre: the power switch and what it drives ----- */

    const power = button(app.powered ? 'On' : 'Off', {
      icon: 'power',
      title: 'Turn the electricity on or off  (Cmd/Ctrl Enter)',
      className: app.powered ? 'primary' : 'bordered',
      onClick: () => app.togglePower(),
    });
    this.center.appendChild(power);

    this.center.appendChild(button(null, {
      icon: app.running ? 'pause' : 'play',
      title: app.running ? 'Pause' : 'Run',
      disabled: !app.powered,
      className: app.running ? 'on' : '',
      onClick: () => (app.running ? app.pause() : app.resume()),
    }));
    this.center.appendChild(button(null, {
      icon: 'step', title: 'Advance one tick', disabled: !app.powered,
      onClick: () => app.stepOnce(1),
    }));
    this.center.appendChild(button(null, {
      icon: 'reset', title: 'Reset all state to zero', disabled: !app.powered,
      onClick: () => app.resetSim(),
    }));

    this.center.appendChild(h('div', { class: 'sep' }));
    const slider = h('input', {
      type: 'range', min: '0', max: String(SPEEDS.length - 1), step: '1',
      value: String(app.speedIndex),
      style: { width: '92px' },
      title: 'Simulation speed',
      oninput: (e: Event) => app.setSpeed(Number((e.target as HTMLInputElement).value)),
    });
    this.center.appendChild(slider);
    this.center.appendChild(h('span', {
      class: 'row-meta speed-readout', style: { width: '52px', textAlign: 'left' },
    }, speedLabel(app.speed)));

    /* ----- right: history, view, theme ----- */

    this.right.appendChild(button(null, {
      icon: 'undo', title: 'Undo  (Cmd/Ctrl Z)', disabled: !app.canUndo, onClick: () => app.undo(),
    }));
    this.right.appendChild(button(null, {
      icon: 'redo', title: 'Redo  (Shift Cmd/Ctrl Z)', disabled: !app.canRedo, onClick: () => app.redo(),
    }));
    this.right.appendChild(h('div', { class: 'sep' }));
    this.right.appendChild(button(null, { icon: 'fit', title: 'Fit to circuit  (Shift F)', onClick: () => this.actions.fit() }));
    this.right.appendChild(button(null, {
      icon: currentTheme() === 'dark' ? 'sun' : 'moon',
      title: 'Switch theme',
      onClick: () => { toggleTheme(); this.renderTop(); },
    }));
    this.right.appendChild(button(null, {
      icon: 'help', title: 'Keyboard and mouse', onClick: () => shortcutsDialog(),
    }));
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

function speedLabel(speed: number): string {
  if (speed === Infinity) return 'max';
  if (speed >= 1000) return `${speed / 1000}k/s`;
  return `${speed}/s`;
}

export async function renameProject(app: App) {
  const name = await promptText('Rename project', 'Name', app.project.name);
  if (name) app.mutate(() => { app.project.name = name; });
}
