import { fromText, toText, type HdlIssue } from '../core/hdl';
import type { ComponentDef, Id, Instance, Wire } from '../core/types';
import type { App } from './app';
import { clear, h, icon } from './dom';
import type { CodeEditor } from './editor';

/** How long the typing has to stop before the text is committed. */
const COMMIT_DELAY = 500;

/**
 * The same component, written down instead of drawn.
 *
 * Like the schematic, this saves itself: there is no Apply. Typing stops, and
 * half a second later the text becomes the component. The safety property that
 * used to belong to the button belongs to the parser instead -- a version that
 * does not parse is simply not committed, so the last good one stands and the
 * problems are listed underneath until the line is finished.
 *
 * The editing surface is CodeMirror, which is worth a dependency for one thing
 * in particular: several cursors at once. Renaming a signal that appears in
 * eight lines is the most common edit there is here, and the hand-rolled
 * version -- one real caret and painted imitations of the others -- worked
 * only for plain typing and fell apart on paste, word-delete and undo.
 *
 * It is loaded on demand, because it is larger than the whole of the rest of
 * the app and the schematic is what has to be on screen first.
 */
export class TextView {
  private root: HTMLElement;
  private body: HTMLElement;
  private problems: HTMLElement;
  private status: HTMLElement;
  private editor: CodeEditor | null = null;
  private loading: Promise<typeof import('./editor')> | null = null;
  private loadedFrom: Id | null = null;
  private dirty = false;
  private timer: number | null = null;
  /** Set while committing, so our own change is not mistaken for someone else's. */
  private committing = false;

  constructor(private app: App, host: HTMLElement) {
    this.problems = h('div', { class: 'editor-problems' });
    this.status = h('span', { class: 'row-meta' });
    this.body = h('div', { class: 'editor-body' });

    this.root = h('div', { class: 'editor-pane' },
      this.body,
      this.problems,
      h('div', { class: 'editor-foot' }, this.status),
    );
    host.appendChild(this.root);

    app.on('view', () => { void this.sync(); });
    // A project event that we did not cause means the component changed under
    // us -- an undo from the toolbar, a different component opened -- and the
    // buffer has to be re-read. Our own commits are skipped, because rewriting
    // the buffer from what was just parsed would reformat the text and drop
    // the comments out from under whoever is typing.
    app.on('project', () => {
      if (app.mode !== 'code' || !this.editor || this.committing) return;
      this.load();
    });
    void this.sync();
  }


  /**
   * Fetch the editor's code. This is the expensive half -- a third of a
   * megabyte to download and parse -- so the app asks for it once it has gone
   * quiet, well before anyone clicks Text.
   */
  preload(): Promise<typeof import('./editor')> {
    if (!this.loading) this.loading = import('./editor');
    return this.loading;
  }

  /**
   * Build the editor, which must happen while the pane is on screen.
   * CodeMirror measures the character grid as it starts up, and a hidden
   * container measures as nothing: it would come up believing every line was
   * the height of an unstyled one and would then draw the caret and the
   * selection in the wrong places, or not at all.
   */
  private async mount() {
    if (this.editor) return;
    const { CodeEditor } = await this.preload();
    if (this.editor) return; // Two switches raced; the first one won.
    this.editor = new CodeEditor(this.body, { onChange: () => this.onChange() });
  }

  /* ---------------- showing ---------------- */

  private async sync() {
    const showing = this.app.mode === 'code';
    this.root.style.display = showing ? '' : 'none';
    if (!showing) return;
    await this.mount();
    // Re-read the component on the way in: it may have been drawn on since we
    // were last here, and committing a stale buffer would undo that work. The
    // one thing that outranks it is text typed and not yet committed.
    if (this.loadedFrom !== this.app.openDef.id || !this.dirty) this.load();
    // The mode may have been switched back while the chunk was in flight.
    if (this.app.mode === 'code') this.editor?.focus();
  }

  private load() {
    const app = this.app;
    if (!this.editor) return;
    this.cancel();
    this.editor.setText(toText(app.project, app.openDef));
    this.loadedFrom = app.openDef.id;
    this.dirty = false;
    clear(this.problems);
    this.setStatus(`${app.openDef.name} as text`, 'ok');
  }

  private setStatus(text: string, kind: 'ok' | 'warn' | 'err' = 'warn') {
    this.status.textContent = text;
    this.status.style.color = kind === 'err' ? 'var(--danger)'
      : kind === 'ok' ? 'var(--ok)' : 'var(--text-faint)';
  }

  /* ---------------- committing ---------------- */

  private onChange() {
    this.dirty = true;
    this.setStatus('Editing');
    this.cancel();
    this.timer = window.setTimeout(() => this.commit(), COMMIT_DELAY);
  }

  private cancel() {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
  }

  /**
   * Commit the buffer if it parses. Returns false when it does not, which is
   * the one case where leaving the text view has to be refused: the schematic
   * still holds the last good version and switching would discard the rest.
   */
  commit(): boolean {
    this.cancel();
    const app = this.app;
    const def = app.openDef;
    if (!this.editor || !this.dirty) return true;

    const parsed = fromText(app.project, this.editor.text, def);
    clear(this.problems);
    if (parsed.issues.length) {
      for (const issue of parsed.issues) this.problems.appendChild(this.problemRow(issue));
      const n = parsed.issues.length;
      this.setStatus(`${n} problem${n === 1 ? '' : 's'} - not saved`, 'err');
      return false;
    }

    // Most keystrokes change the text without changing the circuit: a comment,
    // a blank line, a column of spaces lined up. Those must not push a snapshot
    // onto the undo stack, or eighty of them would quietly evict every real
    // edit -- and there is no sense recompiling for them either. The margins
    // are still saved; the text editor has its own undo for those.
    if (!structural(parsed.instances, parsed.wires, def)) {
      if (JSON.stringify(parsed.notes ?? null) !== JSON.stringify(def.notes ?? null)) {
        def.notes = parsed.notes;
        app.persist();
      }
      this.dirty = false;
      this.setStatus('Saved', 'ok');
      return true;
    }

    this.committing = true;
    try {
      app.mutate(() => {
        def.instances = parsed.instances;
        def.wires = parsed.wires;
        def.notes = parsed.notes;
      });
    } finally {
      this.committing = false;
    }
    this.dirty = false;
    this.setStatus('Saved', 'ok');
    return true;
  }

  private problemRow(issue: HdlIssue): HTMLElement {
    const row = h('button', { class: 'editor-problem' },
      icon('x', 11),
      h('span', { class: 'ln' }, `line ${issue.line}`),
      h('span', { class: 'msg' }, issue.message),
    );
    row.addEventListener('click', () => this.editor?.selectLine(issue.line));
    return row;
  }
}

/**
 * Whether a parse actually differs from what the component already holds.
 * Comparing the serialised form is cheaper than the deep clone that `mutate`
 * would otherwise do, and a false negative only costs a redundant snapshot.
 */
function structural(instances: Instance[], wires: Wire[], def: ComponentDef): boolean {
  return JSON.stringify(instances) !== JSON.stringify(def.instances)
    || JSON.stringify(wires) !== JSON.stringify(def.wires);
}
