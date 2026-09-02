import { clampWidth } from '../core/primitives';
import { createProject, defSignature, previewReplace, replaceAllUses, usageCount } from '../core/project';
import { downloadFile, exportProject, importProject, listProjects, pickFile, saveProject, deleteProject } from '../core/storage';
import type { Id, Instance, Project } from '../core/types';
import type { App } from './app';
import { append, brandMark, button, clear, h, icon } from './dom';

/* ------------------------------------------------------------------ *
 * Primitives
 * ------------------------------------------------------------------ */

interface ModalSpec {
  /** Omitted when the dialog would rather draw its own heading. */
  title?: string;
  wide?: boolean;
  /** An extra class on the modal, for one that needs its own look. */
  className?: string;
  build: (body: HTMLElement, close: (value?: unknown) => void) => void;
  foot?: (foot: HTMLElement, close: (value?: unknown) => void) => void;
}

/**
 * Every open modal, oldest first. A dialog can raise another -- the projects
 * list raises a name prompt, which raises nothing but could -- and only the
 * one on top should answer the keyboard.
 */
const modalStack: HTMLElement[] = [];

export function openModal(spec: ModalSpec): Promise<unknown> {
  return new Promise((resolve) => {
    const scrim = h('div', { class: 'scrim' });
    const modal = h('div', { class: `modal ${spec.wide ? 'wide' : ''} ${spec.className ?? ''}`.trim() });
    const body = h('div', { class: 'body' });
    const foot = h('div', { class: 'foot' });

    let settled = false;
    const close = (value?: unknown) => {
      if (settled) return;
      settled = true;
      scrim.remove();
      const at = modalStack.indexOf(scrim);
      if (at >= 0) modalStack.splice(at, 1);
      document.removeEventListener('keydown', onKey, true);
      resolve(value);
    };
    const onKey = (e: KeyboardEvent) => {
      // These listeners are on the document in the capture phase, so they fire
      // in the order the dialogs opened -- the oldest first. Without this, a
      // prompt raised from another dialog never sees its own Enter: the dialog
      // underneath takes it and clicks its own primary button instead.
      if (modalStack[modalStack.length - 1] !== scrim) return;
      if (e.key === 'Escape') { e.stopPropagation(); close(undefined); return; }
      // Enter confirms -- except in a textarea, where it is a newline. This
      // listener runs in the capture phase, so it has to stand aside
      // explicitly rather than relying on the target handling it first.
      const target = e.target as HTMLElement | null;
      if (e.key === 'Enter' && !e.shiftKey && target?.tagName !== 'TEXTAREA') {
        const primary = foot.querySelector('.btn.primary') as HTMLButtonElement | null;
        if (primary) { e.preventDefault(); e.stopPropagation(); primary.click(); }
      }
    };
    document.addEventListener('keydown', onKey, true);
    modalStack.push(scrim);
    scrim.addEventListener('pointerdown', (e) => { if (e.target === scrim) close(undefined); });

    if (spec.title) modal.appendChild(h('h2', null, spec.title));
    modal.appendChild(body);
    modal.appendChild(foot);
    scrim.appendChild(modal);
    document.body.appendChild(scrim);

    spec.build(body, close);
    if (spec.foot) spec.foot(foot, close);
    else foot.appendChild(button('Close', { className: 'bordered', onClick: () => close(undefined) }));

    const first = modal.querySelector('input, textarea, select') as HTMLElement | null;
    first?.focus();
    if (first instanceof HTMLInputElement) first.select();
  });
}

export function promptText(
  title: string, label: string, initial = '', placeholder = '',
): Promise<string | null> {
  return openModal({
    title,
    build: (body) => {
      const input = h('input', { type: 'text', value: initial, placeholder });
      body.appendChild(h('div', { class: 'field field-col' }, h('label', null, label), input));
    },
    foot: (foot, close) => {
      const input = () => (foot.parentElement!.querySelector('input') as HTMLInputElement);
      foot.appendChild(button('Cancel', { className: 'bordered', onClick: () => close(null) }));
      foot.appendChild(button('OK', { className: 'primary', onClick: () => close(input().value.trim() || null) }));
    },
  }) as Promise<string | null>;
}

export function confirmDialog(
  title: string, message: string,
  opts: { confirmLabel?: string; danger?: boolean } = {},
): Promise<boolean> {
  return openModal({
    title,
    build: (body) => { body.appendChild(h('div', { class: 'hint', style: { fontSize: '12px' } }, message)); },
    foot: (foot, close) => {
      foot.appendChild(button('Cancel', { className: 'bordered', onClick: () => close(false) }));
      foot.appendChild(button(opts.confirmLabel ?? 'Confirm', {
        className: opts.danger ? 'primary' : 'primary',
        onClick: () => close(true),
      }));
    },
  }).then((v) => v === true);
}

export type MenuItem =
  | 'divider'
  | { header: string }
  | { label: string; icon?: string; danger?: boolean; onClick: () => void };

export function contextMenu(x: number, y: number, items: MenuItem[]) {
  document.querySelector('.menu')?.remove();
  const menu = h('div', { class: 'menu' });
  for (const item of items) {
    if (item === 'divider') { menu.appendChild(h('div', { class: 'divider' })); continue; }
    if ('header' in item) { menu.appendChild(h('div', { class: 'label' }, item.header)); continue; }
    const b = h('button', {
      class: item.danger ? 'danger' : '',
      onclick: () => { menu.remove(); item.onClick(); },
    });
    if (item.icon) b.appendChild(icon(item.icon, 12));
    else b.appendChild(h('span', { class: 'icon-slot' }));
    b.appendChild(h('span', null, item.label));
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - r.height - 8)}px`;

  const dismiss = (e: Event) => {
    if (menu.contains(e.target as Node)) return;
    menu.remove();
    window.removeEventListener('pointerdown', dismiss, true);
    window.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') dismiss(e); };
  setTimeout(() => {
    window.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('keydown', onKey, true);
  }, 0);
}

/* ------------------------------------------------------------------ *
 * Number parsing shared by the memory and test-bench editors
 * ------------------------------------------------------------------ */

export function parseNumber(token: string): number | null {
  const t = token.trim().toLowerCase().replace(/_/g, '');
  if (!t) return null;
  let n: number;
  if (t.startsWith('0x')) n = parseInt(t.slice(2), 16);
  else if (t.startsWith('0b')) n = parseInt(t.slice(2), 2);
  else if (/^-?\d+$/.test(t)) n = parseInt(t, 10);
  else n = NaN;
  return Number.isFinite(n) ? n >>> 0 : null;
}

export function parseWords(text: string): { words: number[]; bad: number } {
  const words: number[] = [];
  let bad = 0;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.split('//')[0];
    for (const token of line.split(/[\s,]+/)) {
      if (!token) continue;
      const n = parseNumber(token);
      if (n === null) bad++;
      else words.push(n);
    }
  }
  return { words, bad };
}

/* ------------------------------------------------------------------ *
 * Memory editor
 * ------------------------------------------------------------------ */

/**
 * Loading a program is deliberately a text paste, not a wiring exercise --
 * the whole point of a ROM is that you do not enter software one bit at a time.
 */
export function memoryEditor(app: App, inst: Instance, kind: 'ROM' | 'RAM') {
  const addrWidth = clampWidth(inst.props.addrWidth, 8);
  const dataWidth = clampWidth(inst.props.dataWidth, 16);
  const capacity = 1 << addrWidth;

  openModal({
    title: `${kind} contents`,
    wide: true,
    build: (body, close) => {
      const initial = (inst.props.contents ?? [])
        .map((v) => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(Math.ceil(dataWidth / 4), '0'))
        .join('\n');
      const area = h('textarea', {
        class: 'hex-editor',
        value: initial,
        spellcheck: false,
        placeholder: 'One word per line. 0x1F, 0b0101 and 42 all work.\n// comments are ignored',
      });
      const status = h('div', { class: 'hint' });
      const update = () => {
        const { words, bad } = parseWords(area.value);
        const over = words.length > capacity;
        status.textContent =
          `${words.length} of ${capacity} words, ${dataWidth} bits each` +
          (bad ? ` - ${bad} token${bad === 1 ? '' : 's'} could not be read` : '') +
          (over ? ' - the extra words will not fit and are ignored' : '');
        status.style.color = bad || over ? 'var(--danger)' : '';
      };
      area.addEventListener('input', update);

      const load = button('Load file', {
        icon: 'upload', className: 'bordered',
        onClick: async () => {
          const text = await pickFile('.txt,.hex,.bin,.asm,text/*');
          if (text !== null) { area.value = text; update(); }
        },
      });

      body.appendChild(h('div', { class: 'field', style: { marginBottom: '8px' } }, load));
      body.appendChild(area);
      body.appendChild(status);
      update();

      (body as HTMLElement & { commit?: () => void }).commit = () => {
        const { words } = parseWords(area.value);
        const mask = dataWidth >= 32 ? 0xffffffff : ((1 << dataWidth) - 1) >>> 0;
        const clipped = words.slice(0, capacity).map((w) => (w & mask) >>> 0);
        app.mutate(() => { inst.props.contents = clipped; });
        // A running simulation picks the new program up without a reset.
        const index = app.netlist?.mems.findIndex((m) => m.instId === inst.id) ?? -1;
        if (index >= 0) app.sim?.loadMemory(index, clipped);
        app.toast(`Loaded ${clipped.length} words`);
        close(true);
      };
    },
    foot: (foot, close) => {
      foot.appendChild(button('Cancel', { className: 'bordered', onClick: () => close(false) }));
      foot.appendChild(button('Load into ' + kind, {
        className: 'primary',
        onClick: () => {
          const body = foot.parentElement!.querySelector('.body') as HTMLElement & { commit?: () => void };
          body.commit?.();
        },
      }));
    },
  });
}

/** Read-only view of what a RAM currently holds, while the machine runs. */

export function replaceDialog(app: App, fromId: Id) {
  const from = app.project.defs.find((d) => d.id === fromId);
  if (!from) return;
  const candidates = app.project.defs.filter((d) => d.id !== fromId);
  if (!candidates.length) { app.toast('There is nothing else to swap in', 'err'); return; }

  openModal({
    title: `Replace every use of ${from.name}`,
    build: (body, close) => {
      const select = h('select', null,
        ...candidates.map((d) => h('option', { value: d.id }, d.name)));
      const report = h('div', { class: 'hint' });

      const update = () => {
        const preview = previewReplace(app.project, fromId, select.value);
        clear(report);
        const lines = [
          `${preview.instances} instance${preview.instances === 1 ? '' : 's'} across ${preview.defs} component${preview.defs === 1 ? '' : 's'}.`,
        ];
        if (preview.droppedPins.length) lines.push(`No match for pin${preview.droppedPins.length === 1 ? '' : 's'}: ${[...new Set(preview.droppedPins)].join(', ')}.`);
        if (preview.resizedPins.length) lines.push(`Different width: ${[...new Set(preview.resizedPins)].join(', ')}.`);
        if (preview.wiresDropped) lines.push(`${preview.wiresDropped} wire${preview.wiresDropped === 1 ? '' : 's'} will be removed.`);
        else lines.push('Every wire reconnects cleanly.');
        for (const line of lines) report.appendChild(h('div', null, line));
        report.style.color = preview.wiresDropped ? 'var(--danger)' : '';
      };
      select.addEventListener('change', update);

      body.appendChild(h('div', { class: 'field field-col' },
        h('label', null, 'Replace with'), select));
      body.appendChild(report);
      update();

      (body as HTMLElement & { commit?: () => void }).commit = () => {
        const toId = select.value;
        app.mutate(() => { replaceAllUses(app.project, fromId, toId); });
        app.toast(`Swapped every ${from.name} for ${app.project.defs.find((d) => d.id === toId)?.name}`);
        close(true);
      };
    },
    foot: (foot, close) => {
      foot.appendChild(button('Cancel', { className: 'bordered', onClick: () => close(false) }));
      foot.appendChild(button('Replace', {
        className: 'primary',
        onClick: () => {
          const body = foot.parentElement!.querySelector('.body') as HTMLElement & { commit?: () => void };
          body.commit?.();
        },
      }));
    },
  });
}

/**
 * Deleting a component in use is the moment to offer a replacement, which is
 * the workflow that "recreate it with the same id" was really reaching for.
 */
export async function deleteComponentDialog(app: App, defId: Id, onDelete: () => void) {
  const def = app.project.defs.find((d) => d.id === defId);
  if (!def) return;
  const uses = usageCount(app.project, defId);
  if (!uses) {
    const ok = await confirmDialog('Delete component', `Delete "${def.name}"? It is not used anywhere.`, {
      confirmLabel: 'Delete', danger: true,
    });
    if (ok) onDelete();
    return;
  }

  openModal({
    title: `Delete ${def.name}`,
    build: (body) => {
      body.appendChild(h('div', { style: { fontSize: '12px', lineHeight: '1.6' } },
        `"${def.name}" is used ${uses} time${uses === 1 ? '' : 's'}. Deleting it removes every instance and the wires attached to them.`));
      body.appendChild(h('div', { class: 'hint' },
        'If you built a replacement, swap the uses over first - that keeps the circuits wired.'));
    },
    foot: (foot, close) => {
      foot.appendChild(button('Cancel', { className: 'bordered', onClick: () => close(false) }));
      foot.appendChild(h('div', { class: 'spacer' }));
      foot.appendChild(button('Replace with...', {
        icon: 'swap', className: 'bordered',
        onClick: () => { close(false); replaceDialog(app, defId); },
      }));
      foot.appendChild(button('Delete anyway', {
        className: 'primary danger',
        onClick: () => { close(true); onDelete(); },
      }));
    },
  });
}

/* ------------------------------------------------------------------ *
 * Projects
 * ------------------------------------------------------------------ */

export function projectsDialog(app: App) {
  openModal({
    title: 'Projects',
    build: async (body, close) => {
      const list = h('div');
      body.appendChild(list);

      const refresh = async () => {
        clear(list);
        const projects = await listProjects();
        for (const p of projects) {
          const current = p.id === app.project.id;
          const row = h('div', { class: `row ${current ? 'selected' : ''}` });
          row.appendChild(h('div', { class: 'row-glyph' }, icon('layers', 12)));
          row.appendChild(h('div', { class: 'row-name' }, p.name));
          row.appendChild(h('div', { class: 'row-meta' }, `${p.defs.length} comp`));
          row.addEventListener('click', async () => {
            if (current) return close(false);
            await app.switchProject(p);
            close(true);
          });
          // Two actions, both on the row. A menu to reach two things is a
          // click and a guess more than showing them.
          const act = (name: string, title: string, danger: boolean, run: () => void) => {
            const b = h('button', { class: `row-act${danger ? ' danger' : ''}`, title }, icon(name, 12));
            b.addEventListener('click', (e) => { e.stopPropagation(); run(); });
            return b;
          };
          row.appendChild(act('download', 'Export as JSON', false,
            () => downloadFile(`${slug(p.name)}.nand.json`, exportProject(p))));
          row.appendChild(act('trash', 'Delete project', true, async () => {
            const ok = await confirmDialog('Delete project',
              `Delete "${p.name}" permanently? This cannot be undone.`,
              { confirmLabel: 'Delete', danger: true });
            if (!ok) return;
            // Leave first, delete second. Switching away saves the project
            // being left -- which is right, an unsaved edit must not vanish
            // because you changed project -- so deleting before switching
            // writes the thing straight back, and it takes two goes to remove.
            if (current) {
              const rest = (await listProjects()).find((x) => x.id !== p.id)
                ?? createProject('Untitled');
              await app.switchProject(rest);
            }
            await deleteProject(p.id);
            refresh();
          }));
          list.appendChild(row);
        }
        if (!projects.length) list.appendChild(h('div', { class: 'empty-note' }, 'No saved projects yet.'));
      };
      await refresh();
      (body as HTMLElement & { refresh?: () => void }).refresh = refresh;
    },
    foot: (foot, close) => {
      foot.appendChild(button('Import', {
        icon: 'upload', className: 'bordered',
        onClick: async () => {
          const text = await pickFile('.json,application/json');
          if (!text) return;
          try {
            const project = importProject(text);
            await saveProject(project);
            await app.switchProject(project);
            app.toast(`Imported ${project.name}`);
            close(true);
          } catch (err) {
            app.toast(`Could not import: ${(err as Error).message}`, 'err');
          }
        },
      }));
      foot.appendChild(h('div', { class: 'spacer' }));
      foot.appendChild(button('New project', {
        icon: 'plus', className: 'primary',
        onClick: async () => {
          const name = await promptText('New project', 'Name', 'Untitled');
          if (!name) return;
          const project = createProject(name);
          await saveProject(project);
          await app.switchProject(project);
          close(true);
        },
      }));
    },
  });
}

/**
 * What the simulation controls do, and what a tick is. The tick is the one
 * idea in the app that cannot be guessed from the interface, so it gets the
 * longer half of the dialog.
 */
export function simulationHelpDialog() {
  const controls: [string, string, string][] = [
    ['power', 'On / Off',
      'Connects the circuit to electricity. Switching on rebuilds it from scratch, so every stored bit starts at zero.'],
    ['play', 'Run / Pause',
      'Lets simulated time (ticks) flow, or holds it still. Pausing changes nothing in the circuit.'],
    ['step', 'Step',
      'Advances simulated time by exactly one tick and stops. This is how you watch a signal go through a circuit gate by gate.'],
    ['reset', 'Reset',
      'Puts every wire and every stored bit back to zero and restarts the tick count, without switching the power off.'],
    ['gauge', 'Speed',
      'How many ticks pass per second of real time.'],
  ];
  const ticks: [string, string, string][] = [
    ['info', 'One tick is one gate delay',
      'Everything you build is made of NAND gates. A tick is the time a signal takes to cross a NAND gate.'],
    ['info', 'A clock period is ticks too',
      'A Clock with a period of 512 spends 256 ticks high and 256 low.'],
    ['info', 'Memory is the exception',
      'The built-in RAM and ROM are not built from NANDs, so they cost no ticks of their own.'],
    ['info', 'Tick count at the bottom',
      'The status bar shows how many ticks have passed since you switched on the circuit.'],
  ];
  openModal({
    title: 'Running a circuit',
    wide: true,
    build: (body) => {
      const grid = (rows: [string, string, string][]) => {
        const el = h('div', { class: 'help-grid' });
        for (const [ico, name, text] of rows) {
          el.appendChild(h('span', { class: 'help-ico' }, ico ? icon(ico, 14) : null));
          el.appendChild(h('span', { class: 'help-name' }, name));
          el.appendChild(h('span', { class: 'help-text' }, text));
        }
        return el;
      };
      body.appendChild(h('h3', { class: 'help-head' }, 'The controls'));
      body.appendChild(grid(controls));
      body.appendChild(h('h3', { class: 'help-head' }, 'What a tick is'));
      body.appendChild(grid(ticks));
    },
  });
}

/**
 * Shown while a project is still untouched -- every visit, not just the first.
 *
 * Somebody who has not built anything yet has not necessarily seen this
 * before: they may have closed the tab and come back a week later. It stops
 * appearing the moment they place a gate, which is a better signal than
 * remembering whether the box has been shut once.
 *
 * It is dressed as the manual's masthead rather than as an ordinary dialog --
 * the orange stamp over a rule, the heavy tight-set title, the standfirst,
 * numbered stages in mono. This is the first thing anyone sees, and where it
 * is pointing them is the manual, so it should look like the same publication
 * rather than like a settings box that happens to mention one.
 */
export function welcomeDialog() {
  const steps: [string, string, string][] = [
    ['01', 'Place a part', 'Pick one on the left, then click the grid.'],
    ['02', 'Wire it up', 'Drag from an output pin to an input pin.'],
    ['03', 'Make it a component',
      'Select what you built and right-click. It then works like a built-in, '
      + 'and the next thing you build can use it.'],
  ];
  openModal({
    className: 'welcome',
    build: (body) => {
      const stamp = h('div', { class: 'welcome-stamp' },
        brandMark(15), h('span', null, 'notboth'), h('i'));
      body.appendChild(h('div', { class: 'welcome-head' },
        stamp,
        h('h1', null, 'Build a computer from one gate'),
        h('p', { class: 'welcome-standfirst' },
          'A circuit editor with one logic gate in it: NAND. Arithmetic, memory, '
          + 'a whole processor: all of it out of NANDs, and out of the parts you '
          + 'make from them.'),
      ));

      const list = h('ol', { class: 'welcome-steps' });
      for (const [n, name, text] of steps) {
        list.appendChild(h('li', null,
          h('span', { class: 'n' }, n),
          h('b', null, name),
          h('span', { class: 'say' }, text)));
      }
      body.appendChild(list);
    },
    foot: (foot, close) => {
      foot.appendChild(button('Start building', { className: 'bordered', onClick: () => close() }));
      foot.appendChild(h('span', { class: 'spacer' }));
      foot.appendChild(button('Open the manual', {
        className: 'manual', icon: 'book',
        onClick: () => { window.open('/manual.html', '_blank', 'noopener'); close(); },
      }));
    },
  });
}

export function shortcutsDialog() {
  const rows: [string, string][] = [
    ['Pan', 'Space + drag, middle drag, or two-finger scroll'],
    ['Zoom', 'Cmd/Ctrl + scroll'],
    ['Fit to circuit', 'Shift F'],
    ['Draw a wire', 'Drag from an output pin to an input pin'],
    ['Detach a wire', 'Drag away from the input pin it feeds'],
    ['Switch view', 'Schematic / Code / Tests, in the top bar'],
    ['Select next occurrence', 'Cmd/Ctrl D in the code view, then type to change them all'],
    ['Text size', 'Cmd/Ctrl + and Cmd/Ctrl - in the code view'],
    ['Place a component', 'Click it in the library, then click the grid'],
    ['Edit a component', 'Double-click it in the library, or its box on the canvas'],
    ['Make a component', 'Select parts, then right-click - or Cmd/Ctrl G'],
    ['Select many', 'Drag on empty canvas, or Shift-click'],
    ['Delete selection', 'Delete or Backspace'],
    ['Nudge selection', 'Arrow keys'],
    ['Copy / paste', 'Cmd/Ctrl C, Cmd/Ctrl V'],
    ['Undo / redo', 'Cmd/Ctrl Z, Shift Cmd/Ctrl Z'],
    ['Power on/off', 'Cmd/Ctrl Enter'],
    ['Single tick', 'Right arrow while paused, or the Step button'],
    ['Place repeatedly', 'Hold Shift while placing'],
  ];
  openModal({
    title: 'Keyboard and mouse',
    build: (body) => {
      for (const [what, how] of rows) {
        body.appendChild(h('div', { class: 'field' },
          h('label', { style: { width: '150px' } }, what),
          h('div', { class: 'control', style: { color: 'var(--text-dim)' } }, how)));
      }
    },
  });
}

/* ------------------------------------------------------------------ *
 * Component signature preview, used by the library tooltip
 * ------------------------------------------------------------------ */

export function signatureSummary(project: Project, defId: Id): string {
  const sig = defSignature(project, defId);
  const fmt = (list: typeof sig.inputs) =>
    list.map((p) => (p.width > 1 ? `${p.name}[${p.width}]` : p.name)).join(', ') || '-';
  return `in: ${fmt(sig.inputs)}\nout: ${fmt(sig.outputs)}`;
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
}

export { append };
