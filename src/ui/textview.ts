import { fromText, toText, type HdlIssue } from '../core/hdl';
import type { Id } from '../core/types';
import type { App } from './app';
import { button, clear, h, icon } from './dom';
import { onThemeChange } from './theme';

interface Range { start: number; end: number }

const WORD = /[A-Za-z0-9_]/;

/**
 * The same component, written down instead of drawn.
 *
 * Nothing is committed until it parses, so a half-typed line can never leave a
 * component in a broken state, and anything whose label did not change keeps
 * its position on the canvas.
 *
 * A textarea holds exactly one selection, so the multiple selections that
 * Cmd/Ctrl D builds up are kept here and painted as an overlay. That is only
 * possible because the text is monospaced and never wraps, which makes the
 * position of any character a matter of arithmetic.
 */
export class TextView {
  private root: HTMLElement;
  private area: HTMLTextAreaElement;
  private gutter: HTMLElement;
  private highlights: HTMLElement;
  private problems: HTMLElement;
  private status: HTMLElement;
  private loadedFrom: Id | null = null;
  private dirty = false;

  /** Every selection, in the order they were added. The last is the native one. */
  private multi: Range[] = [];
  private metrics = { charWidth: 7, lineHeight: 20, padLeft: 14, padTop: 12 };

  constructor(private app: App, host: HTMLElement) {
    this.gutter = h('div', { class: 'editor-gutter' });
    this.highlights = h('div', { class: 'editor-highlights' });
    this.area = h('textarea', {
      class: 'editor-text',
      spellcheck: false,
      autocapitalize: 'off',
      autocomplete: 'off',
      wrap: 'off',
    });
    this.problems = h('div', { class: 'editor-problems' });
    this.status = h('span', { class: 'row-meta' });

    this.area.addEventListener('input', () => {
      this.dirty = true;
      this.syncGutter();
      this.setStatus('Not applied yet');
    });
    this.area.addEventListener('scroll', () => {
      this.gutter.scrollTop = this.area.scrollTop;
      this.paintSelections();
    });
    this.area.addEventListener('pointerdown', () => this.clearMulti());
    this.area.addEventListener('blur', () => this.clearMulti());
    this.area.addEventListener('beforeinput', (e) => this.onBeforeInput(e as InputEvent));
    this.area.addEventListener('keydown', (e) => this.onKeyDown(e));

    this.root = h('div', { class: 'editor-pane' },
      h('div', { class: 'editor-body' },
        this.gutter,
        h('div', { class: 'editor-area' }, this.highlights, this.area),
      ),
      this.problems,
      h('div', { class: 'editor-foot' },
        this.status,
        h('div', { class: 'spacer' }),
        button('Revert', { className: 'bordered', onClick: () => this.load(true) }),
        button('Apply', { icon: 'check', className: 'primary', onClick: () => this.apply() }),
      ),
    );
    host.appendChild(this.root);

    app.on('view', () => this.sync());
    app.on('project', () => {
      if (app.mode !== 'text') return;
      if (this.loadedFrom !== app.openDef.id || !this.dirty) this.load();
    });
    onThemeChange(() => this.measure());
    new ResizeObserver(() => this.paintSelections()).observe(this.area);
    this.sync();
  }

  /* ---------------- showing ---------------- */

  private sync() {
    const showing = this.app.mode === 'text';
    this.root.style.display = showing ? '' : 'none';
    if (!showing) return;
    // Re-read the component on the way in: it may have been drawn on since we
    // were last here, and applying a stale buffer would undo that work. The
    // one thing that outranks it is text you typed and have not applied yet.
    if (this.loadedFrom !== this.app.openDef.id || !this.dirty) this.load();
    this.measure();
    this.area.focus();
  }

  load(announce = false) {
    const app = this.app;
    this.area.value = toText(app.project, app.openDef);
    this.loadedFrom = app.openDef.id;
    this.dirty = false;
    this.clearMulti();
    this.syncGutter();
    clear(this.problems);
    this.setStatus(announce ? 'Reverted to the schematic' : `${app.openDef.name} as text`, 'ok');
  }

  private setStatus(text: string, kind: 'ok' | 'warn' | 'err' = 'warn') {
    this.status.textContent = text;
    this.status.style.color = kind === 'err' ? 'var(--danger)'
      : kind === 'ok' ? 'var(--ok)' : 'var(--text-faint)';
  }

  private syncGutter() {
    const wanted = Math.max(this.area.value.split('\n').length, 1);
    if (this.gutter.childElementCount === wanted) return;
    clear(this.gutter);
    const frag = document.createDocumentFragment();
    for (let i = 1; i <= wanted; i++) frag.appendChild(h('div', null, String(i)));
    this.gutter.appendChild(frag);
  }

  /* ---------------- multiple selections ---------------- */

  private measure() {
    const cs = getComputedStyle(this.area);
    this.metrics.lineHeight = parseFloat(cs.lineHeight) || 20;
    this.metrics.padLeft = parseFloat(cs.paddingLeft) || 0;
    this.metrics.padTop = parseFloat(cs.paddingTop) || 0;
    const probe = h('span', {
      style: {
        position: 'absolute', visibility: 'hidden', whiteSpace: 'pre',
        fontFamily: cs.fontFamily, fontSize: cs.fontSize, fontWeight: cs.fontWeight,
        letterSpacing: cs.letterSpacing,
      },
    }, 'M'.repeat(100));
    document.body.appendChild(probe);
    this.metrics.charWidth = probe.getBoundingClientRect().width / 100;
    probe.remove();
    this.paintSelections();
  }

  private clearMulti() {
    if (!this.multi.length) return;
    this.multi = [];
    this.paintSelections();
  }

  private onKeyDown(e: KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); this.apply(); return; }
    if (mod && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      e.stopPropagation();
      this.selectNextOccurrence();
      return;
    }
    if (e.key === 'Tab') { e.preventDefault(); this.insert('  '); return; }
    if (e.key === 'Escape' && this.multi.length) { e.preventDefault(); this.clearMulti(); return; }
    // Any deliberate move of the caret ends the multiple selection.
    if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End'
      || e.key === 'PageUp' || e.key === 'PageDown') this.clearMulti();
  }

  /** Cmd/Ctrl D: select this word, then each following occurrence of it. */
  private selectNextOccurrence() {
    const value = this.area.value;
    const start = this.area.selectionStart;
    const end = this.area.selectionEnd;

    if (start === end) {
      const word = wordAround(value, start);
      if (!word) return;
      this.multi = [word];
      this.area.setSelectionRange(word.start, word.end);
      this.reveal(word.start);
      this.paintSelections();
      this.announceSelections();
      return;
    }

    const needle = value.slice(start, end);
    if (!needle.trim()) return;
    if (!this.multi.length) this.multi = [{ start, end }];

    const last = this.multi[this.multi.length - 1];
    let at = value.indexOf(needle, last.end);
    if (at < 0) at = value.indexOf(needle, 0); // wrap around
    if (at < 0 || this.multi.some((r) => r.start === at)) {
      this.announceSelections(true);
      return;
    }

    this.multi.push({ start: at, end: at + needle.length });
    this.area.setSelectionRange(at, at + needle.length);
    this.reveal(at);
    this.paintSelections();
    this.announceSelections();
  }

  private announceSelections(exhausted = false) {
    const n = this.multi.length;
    if (n <= 1) { this.setStatus(this.dirty ? 'Not applied yet' : 'Selected'); return; }
    this.setStatus(exhausted
      ? `${n} selections - that is all of them`
      : `${n} selections - type to change them together`);
  }

  /**
   * Typing with several selections active edits all of them. Anything more
   * exotic than inserting or deleting drops back to a single caret rather
   * than guessing.
   */
  private onBeforeInput(e: InputEvent) {
    if (this.multi.length < 2) return;
    const type = e.inputType;
    let text: string | null = null;
    if (type === 'insertText') text = e.data ?? '';
    else if (type === 'insertLineBreak' || type === 'insertParagraph') text = '\n';
    else if (type === 'deleteContentBackward' || type === 'deleteContentForward') text = '';
    else { this.clearMulti(); return; }

    e.preventDefault();
    const back = type === 'deleteContentBackward';
    const forward = type === 'deleteContentForward';
    this.editEverySelection(text, back, forward);
  }

  private editEverySelection(text: string, back: boolean, forward: boolean) {
    const value = this.area.value;
    const ordered = [...this.multi].sort((a, b) => a.start - b.start);

    let out = '';
    let cursor = 0;
    let shift = 0;
    const next: Range[] = [];

    for (const range of ordered) {
      let { start, end } = range;
      if (back && start === end) start = Math.max(0, start - 1);
      if (forward && start === end) end = Math.min(value.length, end + 1);
      if (start < cursor) continue; // overlapping selections: keep the first
      out += value.slice(cursor, start) + text;
      const landed = start + shift + text.length;
      next.push({ start: landed, end: landed });
      shift += text.length - (end - start);
      cursor = end;
    }
    out += value.slice(cursor);

    this.area.value = out;
    this.multi = next;
    const primary = next[next.length - 1];
    if (primary) this.area.setSelectionRange(primary.start, primary.end);
    this.dirty = true;
    this.syncGutter();
    this.paintSelections();
    this.announceSelections();
  }

  private paintSelections() {
    clear(this.highlights);
    if (this.multi.length < 2) return;
    const { charWidth, lineHeight, padLeft, padTop } = this.metrics;
    const value = this.area.value;
    const primary = this.multi[this.multi.length - 1];
    const frag = document.createDocumentFragment();

    for (const range of this.multi) {
      if (range === primary) continue; // the browser draws this one
      const at = positionOf(value, range.start);
      if (value.slice(range.start, range.end).includes('\n')) continue;
      const width = Math.max(1, (range.end - range.start) * charWidth);
      frag.appendChild(h('div', {
        class: `editor-sel${range.end === range.start ? ' caret' : ''}`,
        style: {
          left: `${padLeft + at.column * charWidth - this.area.scrollLeft}px`,
          top: `${padTop + at.line * lineHeight - this.area.scrollTop}px`,
          width: `${range.end === range.start ? 2 : width}px`,
          height: `${lineHeight}px`,
        },
      }));
    }
    this.highlights.appendChild(frag);
  }

  /** Scroll an offset into view; the textarea will not do it for us. */
  private reveal(offset: number) {
    const { lineHeight, charWidth, padLeft } = this.metrics;
    const at = positionOf(this.area.value, offset);
    const top = at.line * lineHeight;
    const viewTop = this.area.scrollTop;
    const viewHeight = this.area.clientHeight - lineHeight * 2;
    if (top < viewTop) this.area.scrollTop = Math.max(0, top - lineHeight);
    else if (top > viewTop + viewHeight) this.area.scrollTop = top - viewHeight;

    const left = at.column * charWidth;
    if (left < this.area.scrollLeft) this.area.scrollLeft = Math.max(0, left - padLeft);
    else if (left > this.area.scrollLeft + this.area.clientWidth - 80) {
      this.area.scrollLeft = left - this.area.clientWidth + 120;
    }
    this.gutter.scrollTop = this.area.scrollTop;
  }

  private insert(text: string) {
    this.area.setRangeText(text, this.area.selectionStart, this.area.selectionEnd, 'end');
    this.dirty = true;
    this.syncGutter();
  }

  /* ---------------- committing ---------------- */

  /** Returns true when the text was good and the component was updated. */
  apply(): boolean {
    const app = this.app;
    const def = app.openDef;
    const parsed = fromText(app.project, this.area.value, def);

    clear(this.problems);
    if (parsed.issues.length) {
      for (const issue of parsed.issues) this.problems.appendChild(this.problemRow(issue));
      const n = parsed.issues.length;
      this.setStatus(`${n} problem${n === 1 ? '' : 's'} - nothing was changed`, 'err');
      return false;
    }

    const before = def.instances.length;
    app.mutate(() => {
      def.instances = parsed.instances;
      def.wires = parsed.wires;
    });
    this.dirty = false;
    const delta = def.instances.length - before;
    this.setStatus(
      delta === 0 ? 'Applied' : `Applied - ${delta > 0 ? '+' : ''}${delta} part${Math.abs(delta) === 1 ? '' : 's'}`,
      'ok',
    );
    return true;
  }

  private problemRow(issue: HdlIssue): HTMLElement {
    const row = h('button', { class: 'editor-problem' },
      icon('x', 11),
      h('span', { class: 'ln' }, `line ${issue.line}`),
      h('span', { class: 'msg' }, issue.message),
    );
    row.addEventListener('click', () => this.gotoLine(issue.line));
    return row;
  }

  private gotoLine(line: number) {
    const lines = this.area.value.split('\n');
    let offset = 0;
    for (let i = 0; i < Math.min(line - 1, lines.length); i++) offset += lines[i].length + 1;
    this.clearMulti();
    this.area.focus();
    this.area.setSelectionRange(offset, offset + (lines[line - 1]?.length ?? 0));
    this.reveal(offset);
  }

  get hasUnappliedEdits(): boolean { return this.dirty; }
}

/* ------------------------------------------------------------------ *
 * Text helpers
 * ------------------------------------------------------------------ */

function positionOf(value: string, offset: number): { line: number; column: number } {
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    if (value.charCodeAt(i) === 10) { line++; lineStart = i + 1; }
  }
  return { line, column: offset - lineStart };
}

function wordAround(value: string, offset: number): Range | null {
  let start = offset;
  let end = offset;
  while (start > 0 && WORD.test(value[start - 1])) start--;
  while (end < value.length && WORD.test(value[end])) end++;
  return end > start ? { start, end } : null;
}
