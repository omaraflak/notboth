import { extractSelection } from '../core/extract';
import { PALETTE_PRIMITIVES, primDefId, primName } from '../core/primitives';
import {
  createFolder, deleteDef, deleteFolder, emptyDef, folderContains, folderPath,
  signatureOf, uniqueName, usageCount,
} from '../core/project';
import type { ComponentDef, Folder, Id } from '../core/types';
import type { App } from './app';
import { button, clear, h, icon } from './dom';
import {
  confirmDialog, contextMenu, deleteComponentDialog, promptText, replaceDialog,
  signatureSummary,
} from './dialogs';

/** Folders the reader has shut, remembered between visits. */
const COLLAPSED_KEY = 'nand.collapsed';

/** How long to hover over a shut folder while dragging before it opens. */
const SPRING_MS = 600;

/** What is currently being dragged: several components, or one folder. */
interface Drag { kind: 'def' | 'folder'; ids: Id[] }

export class Library {
  private scroll: HTMLElement;
  private searchInput: HTMLInputElement;
  private query = '';

  /**
   * Which folders are shut.
   *
   * Kept here and in local storage rather than in the project, for two
   * reasons: shutting a folder is not an edit, so it has no business in the
   * undo history or in an exported file, and it is a fact about how one
   * person is reading the list rather than about the circuits themselves.
   */
  private collapsed = new Set<Id>(readCollapsed());

  private drag: Drag | null = null;
  private aimed: HTMLElement | null = null;
  private springTimer: number | null = null;

  /**
   * Components picked out for a group operation.
   *
   * Separate from `app.armed`, which is the one component waiting to be put on
   * the canvas, and from the open component. A plain click still means "place
   * this"; holding a modifier is how you say you meant the list instead.
   */
  private picked = new Set<Id>();
  private anchor: Id | null = null;
  /** Component rows top to bottom, so shift can select a run of them. */
  private visibleDefs: Id[] = [];
  private rowOf = new Map<Id, HTMLElement>();

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

    // A drag can end anywhere -- outside the window, on the canvas, nowhere at
    // all -- and the highlight has to go with it wherever that is.
    // Clicking the background means none of them.
    this.scroll.addEventListener('click', (e) => {
      if (!(e.target as HTMLElement).closest('.row')) this.clearPicked();
    });

    this.scroll.addEventListener('dragleave', (e) => {
      if (!this.scroll.contains(e.relatedTarget as Node | null)) this.aim(null);
    });
    document.addEventListener('dragend', () => this.endDrag());

    // Escape abandons a drag. Most browsers cancel the drag themselves and
    // send dragend, but not every one does, and a drag that is still holding
    // three components when the reader has said no is worse than useless --
    // so the state is dropped here too, and the drop that may still arrive
    // finds nothing to act on.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.drag) this.endDrag();
    }, true);

    app.on('project', () => this.render());
    app.on('selection', () => this.render());
    this.render();
  }

  private matches(name: string): boolean {
    return !this.query || name.toLowerCase().includes(this.query);
  }

  /**
   * Is this folder shut?
   *
   * A search overrides it. Hiding a match inside a shut folder would make the
   * search look as though it had found nothing, so while there is a query
   * every folder is open.
   */
  private isShut(folderId: Id): boolean {
    return !this.query && this.collapsed.has(folderId);
  }

  private clearPicked() {
    if (!this.picked.size) return;
    this.picked.clear();
    this.anchor = null;
    this.render();
  }

  /** Everything between the last plainly-clicked row and this one. */
  private pickRange(to: Id) {
    const order = this.visibleDefs;
    const from = order.indexOf(this.anchor ?? to);
    const here = order.indexOf(to);
    if (from < 0 || here < 0) { this.picked.add(to); this.render(); return; }
    for (let i = Math.min(from, here); i <= Math.max(from, here); i++) this.picked.add(order[i]);
    this.render();
  }

  private setShut(folderId: Id, shut: boolean) {
    if (shut) this.collapsed.add(folderId);
    else this.collapsed.delete(folderId);
    writeCollapsed(this.collapsed);
    this.render();
  }

  render() {
    const app = this.app;
    const scrollTop = this.scroll.scrollTop;
    clear(this.scroll);
    this.visibleDefs = [];
    this.rowOf = new Map();

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
    const label = h('div', { class: 'tree-label' }, 'My components');
    group.appendChild(label);
    for (const f of folders) group.appendChild(this.folderRow(f, 0));
    for (const d of sortDefs(rootDefs)) group.appendChild(this.defRow(d));
    if (!rootDefs.length && !folders.length) {
      group.appendChild(h('div', { class: 'empty-note' },
        this.query
          ? 'Nothing matches.'
          : 'Wire something up, select it, then right-click and choose Make component.'));
    }
    // Dropping anywhere in this group that is not a folder means the top
    // level, which is the only way back out of a folder by dragging.
    this.dropZone(group, label, null);
    this.scroll.appendChild(group);
    this.scroll.scrollTop = scrollTop;

    // A component that has been deleted or filed away cannot stay picked.
    const alive = new Set(this.visibleDefs);
    for (const id of [...this.picked]) if (!alive.has(id)) this.picked.delete(id);

    // The list can be redrawn in the middle of a drag -- a shut folder
    // springing open under the pointer does exactly that -- and the rows being
    // carried have to go on looking like it in the new list.
    if (this.drag?.kind === 'def') {
      for (const id of this.drag.ids) this.rowOf.get(id)?.classList.add('lifting');
    }
  }

  private primRow(kind: string): HTMLElement {
    const defId = primDefId(kind as never);
    const armed = this.app.armed === defId;
    const row = h('div', {
      class: `row ${armed ? 'armed' : ''}`,
      title: `${primName(kind as never)}\n${signatureSummary(this.app.project, defId)}`,
    });
    row.appendChild(h('div', { class: 'row-twisty' }));
    row.appendChild(h('div', { class: 'row-glyph' }, icon(glyphFor(kind), 12)));
    row.appendChild(h('div', { class: 'row-name' }, primName(kind as never)));
    row.addEventListener('click', () => { this.picked.clear(); this.arm(defId); });
    return row;
  }

  private folderRow(folder: Folder, depth: number): HTMLElement {
    const app = this.app;
    const wrap = h('div', { class: 'folder-wrap' });
    const kids = app.project.defs.filter((d) => d.folder === folder.id && this.matches(d.name));
    const subfolders = app.project.folders.filter((f) => f.parent === folder.id);
    if (this.query && !kids.length && !subfolders.length && !this.matches(folder.name)) return wrap;

    const shut = this.isShut(folder.id);
    const row = h('div', {
      class: `row folder ${shut ? 'shut' : ''}`,
      draggable: true,
      title: `${folder.name}\n\nClick to ${shut ? 'open' : 'close'}  -  drag to move`,
    });
    row.appendChild(h('div', { class: 'row-twisty' }, icon('chevron', 11)));
    row.appendChild(h('div', { class: 'row-glyph' }, icon('folder', 12)));
    row.appendChild(h('div', { class: 'row-name' }, folder.name));
    row.appendChild(h('div', { class: 'row-meta' }, String(kids.length)));

    // The whole row is the switch. A folder with nothing to reveal still
    // toggles, so an empty one does not look broken.
    row.addEventListener('click', () => this.setShut(folder.id, !this.collapsed.has(folder.id)));

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
        {
          label: 'New folder here', icon: 'folder',
          onClick: () => this.newFolder(folder.id),
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

    this.dragSource(row, () => ({ kind: 'folder', ids: [folder.id] }));

    wrap.appendChild(row);
    if (!shut) {
      const children = h('div', { class: 'folder-children' });
      for (const f of subfolders) children.appendChild(this.folderRow(f, depth + 1));
      for (const d of sortDefs(kids)) children.appendChild(this.defRow(d));
      wrap.appendChild(children);
    }

    // Anywhere in the folder's own region counts, not only the one row: aiming
    // at a 25 pixel strip while holding the mouse button down is a poor thing
    // to ask of anybody. And since the whole region accepts the drop, the
    // whole region is what lights up -- the folder together with everything
    // already in it -- so what is about to happen is not a guess.
    this.dropZone(wrap, wrap, folder.id, folder);
    return wrap;
  }

  private defRow(def: ComponentDef): HTMLElement {
    const app = this.app;
    const isOpen = app.project.openDefId === def.id;
    const armed = app.armed === def.id;
    const sig = signatureOf(def);
    const picked = this.picked.has(def.id);
    const row = h('div', {
      class: `row ${picked ? 'picked' : ''} ${isOpen ? 'selected' : ''} ${armed ? 'armed' : ''}`,
      draggable: true,
      title: `${def.name}\n${signatureSummary(app.project, def.id)}\n\n`
        + 'Click to place  -  double-click to edit  -  drag to file\n'
        + 'Shift or Cmd to pick out several at once',
    });
    this.visibleDefs.push(def.id);
    this.rowOf.set(def.id, row);
    // An empty twisty, so every glyph in the list stands in the same column
    // whether or not the thing beside it can be opened.
    row.appendChild(h('div', { class: 'row-twisty' }));
    row.appendChild(h('div', { class: 'row-glyph' }, icon('chip', 12)));
    row.appendChild(h('div', { class: 'row-name' }, def.name));
    row.appendChild(h('div', { class: 'row-meta' }, `${sig.inputs.length}/${sig.outputs.length}`));

    const more = h('button', { class: 'row-more' }, icon('more', 12));
    more.addEventListener('click', (e) => { e.stopPropagation(); this.defMenu(def, more); });
    row.appendChild(more);

    // A component behaves exactly like a built-in: one click arms it for
    // placement. Editing is a deliberate act -- double-click, or the menu.
    // A modifier says the click was about the list, not the canvas, so it
    // picks rather than arms.
    row.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey) {
        if (!this.picked.delete(def.id)) this.picked.add(def.id);
        this.anchor = def.id;
        this.render();
      } else if (e.shiftKey) {
        this.pickRange(def.id);
      } else {
        this.picked = new Set([def.id]);
        this.anchor = def.id;
        this.arm(def.id);       // arming redraws, which paints the pick too
      }
    });
    row.addEventListener('dblclick', () => {
      app.armed = null;
      app.openComponent(def.id);
    });
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); this.defMenu(def, more, e); });

    // What travels is the whole pick when this row is part of one, and just
    // this row when it is not -- which is what dragging a file out of a
    // multiple selection does everywhere else.
    this.dragSource(row, () => ({
      kind: 'def',
      ids: this.picked.has(def.id) && this.picked.size > 1 ? [...this.picked] : [def.id],
    }));
    return row;
  }

  /* ------------------------------------------------------------------ *
   * Dragging things into folders
   * ------------------------------------------------------------------ */

  /**
   * Make a row draggable.
   *
   * Note what this does *not* do: react to the drag starting. An earlier
   * version armed the component for placement here, which redrew the list,
   * which destroyed the very element the browser was dragging -- and the drag
   * died on the spot. A drag has to leave the tree alone until it lands.
   */
  private dragSource(row: HTMLElement, what: () => Drag) {
    row.addEventListener('dragstart', (e) => {
      // Read at the last moment: what is picked may have changed since the
      // list was drawn, and the drag should carry what is picked now.
      const drag = what();
      this.drag = drag;
      for (const id of drag.ids) (this.rowOf.get(id) ?? row).classList.add('lifting');

      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        // A custom type is what the drop reads; the plain one is so that
        // dropping into a text field somewhere does something sensible
        // rather than nothing.
        e.dataTransfer.setData(`text/nand-${drag.kind}`, drag.ids.join(' '));
        e.dataTransfer.setData('text/plain', row.textContent ?? '');
        // Dragging four components while the cursor carries a picture of one
        // of them is a small lie about what is happening.
        if (drag.ids.length > 1) {
          const badge = h('div', { class: 'drag-badge' }, `${drag.ids.length} components`);
          document.body.appendChild(badge);
          e.dataTransfer.setDragImage(badge, 14, 14);
          setTimeout(() => badge.remove(), 0);
        }
      }
    });
    row.addEventListener('dragend', () => this.endDrag());
  }

  /** Can what is being dragged go here? */
  private canDrop(target: Id | null): boolean {
    const drag = this.drag;
    if (!drag) return false;
    if (drag.kind === 'def') return true;
    // A folder cannot be put inside itself, nor inside anything it holds --
    // that would cut the branch off the tree, with everything on it.
    if (drag.ids[0] === target) return false;
    return !folderContains(this.app.project, drag.ids[0], target);
  }

  /**
   * Accept drops over `zone`, showing `highlight` as the thing being aimed at.
   *
   * Zones nest, so the innermost one to see the pointer claims it and stops
   * the event: dragging over a component inside a folder means the folder,
   * not the whole list.
   */
  private dropZone(zone: HTMLElement, highlight: HTMLElement, target: Id | null, folder?: Folder) {
    zone.addEventListener('dragover', (e) => {
      if (!this.canDrop(target)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      this.aim(highlight);
      // Hovering over a shut folder opens it, so its contents can be reached
      // without letting go and starting again.
      if (folder && this.isShut(folder.id) && this.springTimer === null) {
        this.springTimer = window.setTimeout(() => {
          this.springTimer = null;
          const held = this.drag;
          this.setShut(folder.id, false);
          this.drag = held;      // the redraw must not lose the drag in flight
        }, SPRING_MS);
      }
    });

    zone.addEventListener('drop', (e) => {
      if (!this.canDrop(target)) return;
      e.preventDefault();
      e.stopPropagation();
      const drag = this.drag;
      this.endDrag();
      if (!drag) return;
      const app = this.app;

      if (drag.kind === 'def') {
        const moving = app.project.defs.filter((d) => drag.ids.includes(d.id) && d.folder !== target);
        if (!moving.length) return;
        // One edit for the whole handful, so one undo puts them all back.
        app.mutate(() => { for (const d of moving) d.folder = target; });
        if (target) this.setShut(target, false);
      } else {
        const moved = app.project.folders.find((f) => f.id === drag.ids[0]);
        if (moved && moved.parent !== target) app.mutate(() => { moved.parent = target; });
        if (target) this.setShut(target, false);
      }
    });
  }

  /** Light up one drop target at a time. */
  private aim(el: HTMLElement | null) {
    if (this.aimed === el) return;
    this.aimed?.classList.remove('drop');
    this.aimed = el;
    this.aimed?.classList.add('drop');
  }

  private endDrag() {
    this.drag = null;
    this.aim(null);
    for (const row of this.scroll.querySelectorAll('.row.lifting')) row.classList.remove('lifting');
    if (this.springTimer !== null) {
      clearTimeout(this.springTimer);
      this.springTimer = null;
    }
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

  async newFolder(parent: Id | null = null) {
    const app = this.app;
    const name = await promptText('New folder', 'Name', 'Folder');
    if (!name) return;
    if (parent) this.setShut(parent, false);
    app.mutate(() => { createFolder(app.project, name, parent); });
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
    app.wiresFollowParts();
    app.emit('selection');
    app.toast(`Created ${made.def.name} with ${made.inputs} in and ${made.outputs} out`);
  }
}

function readCollapsed(): Id[] {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((x): x is Id => typeof x === 'string') : [];
  } catch {
    return [];      // private browsing, or something else wrote there
  }
}

function writeCollapsed(ids: Set<Id>) {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...ids]));
  } catch { /* nothing to be done, and nothing important lost */ }
}

function sortDefs(defs: ComponentDef[]): ComponentDef[] {
  return [...defs].sort((a, b) => a.name.localeCompare(b.name));
}

function glyphFor(kind: string): string {
  switch (kind) {
    case 'NAND': return 'chip';
    case 'CLOCK': return 'gauge';
    case 'CONST': return 'zap';
    case 'IN': return 'chevron';
    case 'OUT': return 'chevron';
    case 'PROBE': return 'search';
    case 'ROM': case 'RAM': return 'memory';
    default: return 'chip';
  }
}
