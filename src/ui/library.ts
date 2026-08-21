import { extractSelection } from '../core/extract';
import { PALETTE_PRIMITIVES, primDefId, primName } from '../core/primitives';
import {
  createFolder, deleteDef, deleteFolder, emptyDef, folderPath,
  signatureOf, uniqueName, usageCount,
} from '../core/project';
import { runTests } from '../core/testbench';
import type { ComponentDef, Folder, Id } from '../core/types';
import type { App } from './app';
import { button, clear, h, icon } from './dom';
import {
  confirmDialog, contextMenu, deleteComponentDialog, promptText, replaceDialog,
  signatureSummary, testBenchDialog,
} from './dialogs';

export class Library {
  private scroll: HTMLElement;
  private searchInput: HTMLInputElement;
  private query = '';

  constructor(private app: App, host: HTMLElement) {
    this.searchInput = h('input', {
      type: 'text', placeholder: 'Search components',
      oninput: () => { this.query = this.searchInput.value.trim().toLowerCase(); this.render(); },
    });
    this.scroll = h('div', { class: 'side-scroll' });

    host.appendChild(h('div', { class: 'side-head' },
      h('h2', null, 'Components'),
      button(null, { icon: 'folder', title: 'New folder', onClick: () => this.newFolder() }),
      button(null, { icon: 'plus', title: 'New component', onClick: () => this.newComponent() }),
    ));
    host.appendChild(h('div', { class: 'side-search' }, this.searchInput));
    host.appendChild(this.scroll);
    host.appendChild(h('div', { class: 'side-foot' },
      h('button', {
        class: 'manual-link',
        title: 'The build manual: what to make next, and why',
        onclick: () => window.open('/manual.html', '_blank', 'noopener'),
      },
        icon('book', 13),
        h('span', { class: 'grow' }, 'Manual'),
        h('span', { class: 'out' }, icon('external', 11)),
      )));

    app.on('project', () => this.render());
    app.on('selection', () => this.render());
    this.render();
  }

  private matches(name: string): boolean {
    return !this.query || name.toLowerCase().includes(this.query);
  }

  render() {
    const app = this.app;
    const scrollTop = this.scroll.scrollTop;
    clear(this.scroll);

    // Built-ins first. Everything else in the list was built out of these.
    const prims = PALETTE_PRIMITIVES.filter((k) => this.matches(k));
    if (prims.length) {
      const group = h('div', { class: 'tree-group' });
      group.appendChild(h('div', { class: 'tree-label' }, 'Built in'));
      for (const kind of prims) group.appendChild(this.primRow(kind));
      this.scroll.appendChild(group);
    }

    const rootDefs = app.project.defs.filter((d) => !d.folder && this.matches(d.name));
    const folders = app.project.folders.filter((f) => !f.parent);

    const group = h('div', { class: 'tree-group' });
    group.appendChild(h('div', { class: 'tree-label' }, 'My components'));
    for (const f of folders) group.appendChild(this.folderRow(f, 0));
    for (const d of sortDefs(rootDefs)) group.appendChild(this.defRow(d));
    if (!rootDefs.length && !folders.length) {
      group.appendChild(h('div', { class: 'empty-note' },
        this.query
          ? 'Nothing matches.'
          : 'Wire something up, select it, then right-click and choose Make component.'));
    }
    this.scroll.appendChild(group);
    this.scroll.scrollTop = scrollTop;
  }

  private primRow(kind: string): HTMLElement {
    const defId = primDefId(kind as never);
    const armed = this.app.armed === defId;
    const row = h('div', {
      class: `row ${armed ? 'armed' : ''}`,
      title: `${primName(kind as never)}\n${signatureSummary(this.app.project, defId)}`,
    });
    row.appendChild(h('div', { class: 'row-glyph' }, icon(glyphFor(kind), 12)));
    row.appendChild(h('div', { class: 'row-name' }, primName(kind as never)));
    row.addEventListener('click', () => this.arm(defId));
    return row;
  }

  private folderRow(folder: Folder, depth: number): HTMLElement {
    const app = this.app;
    const wrap = h('div');
    const kids = app.project.defs.filter((d) => d.folder === folder.id && this.matches(d.name));
    const subfolders = app.project.folders.filter((f) => f.parent === folder.id);
    if (this.query && !kids.length && !subfolders.length && !this.matches(folder.name)) return wrap;

    const row = h('div', { class: 'row folder' });
    row.appendChild(h('div', { class: 'row-glyph' }, icon('folder', 12)));
    row.appendChild(h('div', { class: 'row-name' }, folder.name));
    row.appendChild(h('div', { class: 'row-meta' }, String(kids.length)));

    const more = h('button', { class: 'row-more' }, icon('more', 12));
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = more.getBoundingClientRect();
      contextMenu(r.left, r.bottom + 4, [
        {
          label: 'Rename folder', onClick: async () => {
            const name = await promptText('Rename folder', 'Name', folder.name);
            if (name) app.mutate(() => { folder.name = name; });
          },
        },
        {
          label: 'New component here', icon: 'plus',
          onClick: () => this.newComponent(folder.id),
        },
        'divider',
        {
          label: 'Delete folder', icon: 'trash', danger: true,
          onClick: async () => {
            const ok = await confirmDialog('Delete folder',
              `Delete "${folder.name}"? Components inside it move up a level; nothing is lost.`,
              { confirmLabel: 'Delete', danger: true });
            if (ok) app.mutate(() => deleteFolder(app.project, folder.id));
          },
        },
      ]);
    });
    row.appendChild(more);

    // Folders accept dropped components.
    row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('drop'); });
    row.addEventListener('dragleave', () => row.classList.remove('drop'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.classList.remove('drop');
      const id = e.dataTransfer?.getData('text/nand-def');
      const def = id ? app.project.defs.find((d) => d.id === id) : undefined;
      if (def && def.folder !== folder.id) app.mutate(() => { def.folder = folder.id; });
    });

    wrap.appendChild(row);
    const children = h('div', { class: 'folder-children' });
    for (const f of subfolders) children.appendChild(this.folderRow(f, depth + 1));
    for (const d of sortDefs(kids)) children.appendChild(this.defRow(d));
    wrap.appendChild(children);
    return wrap;
  }

  private defRow(def: ComponentDef): HTMLElement {
    const app = this.app;
    const isOpen = app.project.openDefId === def.id;
    const armed = app.armed === def.id;
    const sig = signatureOf(def);
    const row = h('div', {
      class: `row ${isOpen ? 'selected' : ''} ${armed ? 'armed' : ''}`,
      draggable: true,
      title: `${def.name}\n${signatureSummary(app.project, def.id)}\n\nClick to place  -  double-click to edit`,
    });
    row.appendChild(h('div', { class: 'row-glyph' }, icon('chip', 12)));
    row.appendChild(h('div', { class: 'row-name' }, def.name));
    row.appendChild(h('div', { class: 'row-meta' }, `${sig.inputs.length}/${sig.outputs.length}`));

    const more = h('button', { class: 'row-more' }, icon('more', 12));
    more.addEventListener('click', (e) => { e.stopPropagation(); this.defMenu(def, more); });
    row.appendChild(more);

    // A component behaves exactly like a built-in: one click arms it for
    // placement. Editing is a deliberate act -- double-click, or the menu.
    row.addEventListener('click', () => this.arm(def.id));
    row.addEventListener('dblclick', () => {
      app.armed = null;
      app.openComponent(def.id);
    });
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); this.defMenu(def, more, e); });
    row.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData('text/nand-def', def.id);
      this.arm(def.id);
    });
    return row;
  }

  private defMenu(def: ComponentDef, anchor: HTMLElement, event?: MouseEvent) {
    const app = this.app;
    const r = anchor.getBoundingClientRect();
    const x = event?.clientX ?? r.left;
    const y = event?.clientY ?? r.bottom + 4;
    const uses = usageCount(app.project, def.id);
    const folders = app.project.folders;

    contextMenu(x, y, [
      { header: `${def.name}${uses ? ` - used ${uses}x` : ''}` },
      { label: 'Place on canvas', icon: 'plus', onClick: () => this.arm(def.id) },
      {
        label: 'Edit this component', icon: 'chip',
        onClick: () => { app.armed = null; app.openComponent(def.id); },
      },
      'divider',
      {
        label: def.tests?.vectors.length ? 'Edit tests...' : 'Add tests...',
        icon: 'beaker', onClick: () => testBenchDialog(app, def),
      },
      {
        label: def.tests?.vectors.length ? `Run ${def.tests.vectors.length} tests` : 'Run tests',
        icon: 'check',
        onClick: () => {
          const run = runTests(app.project, def.id);
          if (!run.ran) {
            app.toast(run.errors.length ? run.errors[0].message : `${def.name} has no tests yet`, 'err');
          } else if (run.passed === run.total) {
            app.toast(`${def.name}: all ${run.total} vectors pass`);
          } else {
            app.toast(`${def.name}: ${run.total - run.passed} of ${run.total} vectors fail`, 'err');
          }
        },
      },
      'divider',
      {
        label: 'Rename', onClick: async () => {
          const name = await promptText('Rename component', 'Name', def.name);
          if (name) app.mutate(() => { def.name = uniqueName(app.project, name, def.id); });
        },
      },
      {
        label: 'Duplicate', icon: 'copy', onClick: () => {
          app.mutate(() => {
            const copy = structuredClone(def);
            copy.id = `c_${Math.random().toString(36).slice(2, 12)}`;
            copy.name = uniqueName(app.project, `${def.name} copy`);
            app.project.defs.push(copy);
          });
        },
      },
      {
        label: 'Replace all uses...', icon: 'swap',
        onClick: () => replaceDialog(app, def.id),
      },
      ...(folders.length || def.folder
        ? ['divider' as const, { header: 'Move to' },
          ...(def.folder ? [{ label: 'Top level', onClick: () => app.mutate(() => { def.folder = null; }) }] : []),
          ...folders.filter((f) => f.id !== def.folder).map((f) => ({
            label: folderPath(app.project, f.id),
            icon: 'folder',
            onClick: () => app.mutate(() => { def.folder = f.id; }),
          }))]
        : []),
      'divider',
      {
        label: 'Delete', icon: 'trash', danger: true,
        onClick: () => deleteComponentDialog(app, def.id, () => {
          app.mutate(() => deleteDef(app.project, def.id));
        }),
      },
    ]);
  }

  private arm(defId: Id) {
    this.app.armed = this.app.armed === defId ? null : defId;
    this.app.emit('project');
  }

  async newComponent(folder: Id | null = null) {
    const app = this.app;
    const name = await promptText('New component', 'Name', uniqueName(app.project, 'Component'));
    if (!name) return;
    const def = emptyDef(uniqueName(app.project, name), folder);
    app.mutate(() => { app.project.defs.push(def); });
    app.openComponent(def.id);
  }

  async newFolder() {
    const app = this.app;
    const name = await promptText('New folder', 'Name', 'Folder');
    if (!name) return;
    app.mutate(() => { createFolder(app.project, name); });
  }

  /** Turn the current selection into a named component, in place. */
  async extractSelection() {
    const app = this.app;
    if (app.selection.instances.size < 1) {
      app.toast('Select the parts you want to package first', 'err');
      return;
    }
    const name = await promptText(
      'Save selection as component', 'Name',
      uniqueName(app.project, 'Component'),
    );
    if (!name) return;
    const def = app.openDef;
    let created: ReturnType<typeof extractSelection> = null;
    app.mutate(() => {
      created = extractSelection(app.project, def, new Set(app.selection.instances), name);
    });
    if (!created) {
      app.undo();
      app.toast('Nothing to package - port markers stay in the parent circuit', 'err');
      return;
    }
    const made = created as NonNullable<ReturnType<typeof extractSelection>>;
    app.selection.instances = new Set([made.instance.id]);
    app.selection.wires.clear();
    app.emit('selection');
    app.toast(`Created ${made.def.name} with ${made.inputs} in and ${made.outputs} out`);
  }
}

function sortDefs(defs: ComponentDef[]): ComponentDef[] {
  return [...defs].sort((a, b) => a.name.localeCompare(b.name));
}

function glyphFor(kind: string): string {
  switch (kind) {
    case 'NAND': return 'chip';
    case 'CLOCK': return 'gauge';
    case 'TOGGLE': return 'power';
    case 'CONST': return 'zap';
    case 'IN': return 'chevron';
    case 'OUT': return 'chevron';
    case 'PROBE': return 'search';
    case 'ROM': case 'RAM': return 'memory';
    default: return 'chip';
  }
}
