/**
 * The code editor, behind a small facade.
 *
 * CodeMirror is four times the size of the rest of the app, and the schematic
 * is what the first paint has to show, so this module is loaded on demand --
 * see `TextView`, which imports it dynamically and prefetches it once the app
 * is idle. Keeping the surface narrow is what makes that split possible: the
 * caller never names a CodeMirror type, so nothing drags the library back into
 * the main chunk.
 */
import {
  defaultKeymap, history, historyKeymap, indentWithTab, toggleComment,
} from '@codemirror/commands';
import { indentUnit } from '@codemirror/language';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { Compartment, EditorSelection, EditorState } from '@codemirror/state';
import {
  EditorView, crosshairCursor, drawSelection, dropCursor, highlightActiveLine,
  highlightActiveLineGutter, keymap, lineNumbers, rectangularSelection,
} from '@codemirror/view';

import { hdlLanguage } from './hdl-lang';
import { currentTheme, onThemeChange } from './theme';

/**
 * Chrome for the editor, expressed in the app's own tokens so that a dark
 * palette is still a single edit in `style.css` rather than a second theme
 * kept in step by hand.
 */
const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '12px', backgroundColor: 'var(--bg-panel)', color: 'var(--text)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.65', overflow: 'auto' },
  '.cm-content': { padding: '12px 0', caretColor: 'var(--accent)' },
  '.cm-line': { padding: '0 14px' },

  '.cm-gutters': {
    backgroundColor: 'var(--bg-sunken)',
    color: 'var(--text-faint)',
    borderRight: '1px solid var(--line)',
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 14px', minWidth: '38px' },
  // The active line is a real background inside the content, and the selection
  // is a layer behind the content, so an opaque line highlight hides the
  // selection completely -- and a selection never leaves the active line, so
  // it would hide every one of them. While anything is selected the line
  // highlight stands down; the gutter keeps showing where the cursor is.
  '.cm-activeLine': { backgroundColor: 'var(--bg-hover)' },
  '&.cm-selecting .cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--bg-active)', color: 'var(--text-dim)' },

  // Every caret is drawn the same, primary or not: with several of them the
  // whole point is that you cannot tell which one the browser thinks is real.
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  // CodeMirror's own rule for this is four classes deep behind two child
  // combinators, so a shorter selector loses to it however late it is
  // declared. Matching its shape, plus one class, is what makes the token win.
  '&.cm-editor .cm-selectionLayer .cm-selectionBackground': { backgroundColor: 'var(--select-off)' },
  '&.cm-editor.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    backgroundColor: 'var(--select-bg)',
  },
  // The occurrence highlighter marks the selected text as well as its twins.
  // Left alone it paints over the selection itself, which is the one range
  // that is already being shown -- and being shown better.
  '.cm-selectionMatch': { backgroundColor: 'var(--select-match)' },
  '.cm-selectionMatch.cm-selectionMatch-main': { backgroundColor: 'transparent' },
  '.cm-searchMatch': { backgroundColor: 'var(--select-match)', outline: '1px solid var(--accent-line)' },
  '.cm-searchMatch-selected': { backgroundColor: 'var(--select-bg)' },

  '.cm-panels': { backgroundColor: 'var(--bg-elev)', color: 'var(--text)' },
  '.cm-panels-bottom': { borderTop: '1px solid var(--line)' },
  '.cm-panel.cm-search': { padding: '6px 10px', fontFamily: 'var(--font)', fontSize: '11.5px' },
  '.cm-panel.cm-search input, .cm-panel.cm-search button': {
    fontFamily: 'inherit',
    fontSize: '11.5px',
    color: 'var(--text)',
    background: 'var(--bg-panel)',
    border: '1px solid var(--line-strong)',
    borderRadius: 'var(--radius)',
    padding: '3px 6px',
    margin: '0 4px 0 0',
  },
  '.cm-panel.cm-search label': { color: 'var(--text-dim)' },
  '.cm-panel.cm-search [name="close"]': { border: 'none', background: 'none', color: 'var(--text-dim)' },
});

export interface EditorHooks {
  /** The document changed because someone typed in it. */
  onChange(): void;
}

/**
 * CodeMirror keeps a light and a dark variant of its own base theme and picks
 * between them from this facet. Everything visible is overridden above, but
 * leaving it lying about which palette is in use means any corner that is not
 * overridden -- a panel, a button, a special character -- comes out of the
 * wrong half.
 */
const darkFlag = new Compartment();

export class CodeEditor {
  private view: EditorView;

  constructor(parent: HTMLElement, hooks: EditorHooks) {
    this.view = new EditorView({
      parent,
      extensions: [
        darkFlag.of(EditorView.darkTheme.of(currentTheme() === 'dark')),
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        history(),
        drawSelection(),
        dropCursor(),
        rectangularSelection(),
        crosshairCursor(),
        highlightSelectionMatches(),
        EditorState.allowMultipleSelections.of(true),
        EditorState.tabSize.of(2),
        indentUnit.of('  '),
        theme,
        hdlLanguage,
        keymap.of([
          { key: 'Mod-/', run: toggleComment, preventDefault: true },
          ...searchKeymap,
          ...historyKeymap,
          ...defaultKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) hooks.onChange();
          if (u.docChanged || u.selectionSet) {
            const selecting = u.state.selection.ranges.some((r) => !r.empty);
            u.view.dom.classList.toggle('cm-selecting', selecting);
          }
        }),
      ],
    });

    onThemeChange(() => this.view.dispatch({
      effects: darkFlag.reconfigure(EditorView.darkTheme.of(currentTheme() === 'dark')),
    }));
  }

  get text(): string { return this.view.state.doc.toString(); }

  /** Replace everything. Used when a different component is opened. */
  setText(text: string) {
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text },
      selection: EditorSelection.cursor(0),
    });
  }

  /** Select a whole line and scroll to it, for jumping to a parse error. */
  selectLine(n: number) {
    const doc = this.view.state.doc;
    const line = doc.line(Math.min(Math.max(1, n), doc.lines));
    this.view.focus();
    this.view.dispatch({
      selection: EditorSelection.range(line.from, line.to),
      scrollIntoView: true,
    });
  }

  focus() {
    this.view.requestMeasure();
    this.view.focus();
  }
}
