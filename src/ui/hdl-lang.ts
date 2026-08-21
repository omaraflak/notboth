/**
 * Syntax highlighting for the component text form.
 *
 * The grammar is small enough that a character-at-a-time tokeniser is the
 * honest tool: there is no nesting to speak of beyond a parenthesised argument
 * list, and a statement never spans a construct the parser in `core/hdl.ts`
 * could not also read line by line.
 *
 * Every token is given a *class* rather than a colour, so the palette stays
 * where every other colour in the app lives -- the two blocks at the top of
 * `style.css`.
 */
import { HighlightStyle, StreamLanguage, syntaxHighlighting, type StreamParser } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

/** What the token before this one was, when that changes how this one reads. */
type Prev = 'none' | 'port' | 'dot';

interface State {
  /** Depth of open parentheses, so a continuation line is not a new statement. */
  depth: number;
  /** The next identifier names a component type, because a `:` just closed. */
  expectType: boolean;
  /** Nothing has been read yet on this statement. */
  first: boolean;
  prev: Prev;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*/;

const parser: StreamParser<State> = {
  name: 'hdl',

  startState: () => ({ depth: 0, expectType: false, first: true, prev: 'none' }),
  copyState: (s) => ({ ...s }),

  token(stream, state) {
    // A new line only starts a new statement when no bracket is still open.
    if (stream.sol() && state.depth === 0) {
      state.first = true;
      state.expectType = false;
      state.prev = 'none';
    }
    if (stream.eatSpace()) return null;

    if (stream.peek() === '#') {
      stream.skipToEnd();
      return 'comment';
    }

    const prev = state.prev;
    state.prev = 'none';

    if (stream.match(/^0[xX][0-9a-fA-F]+/) || stream.match(/^0[bB][01]+/) || stream.match(/^\d+/)) {
      state.first = false;
      return 'number';
    }

    if (stream.match(IDENT)) {
      const word = stream.current();
      const wasFirst = state.first;
      state.first = false;

      if (state.expectType) { state.expectType = false; return 'type'; }
      if (wasFirst && (word === 'in' || word === 'out')) { state.prev = 'port'; return 'keyword'; }
      // The name a port declaration or a part declaration introduces.
      if (prev === 'port' || stream.match(/^\s*:/, false)) return 'label';
      // `g1.y`, and the pin names on the left of an argument.
      if (prev === 'dot' || (state.depth > 0 && stream.match(/^\s*=/, false))) return 'pin';
      return 'name';
    }

    const ch = stream.next();
    state.first = false;
    switch (ch) {
      case '(': state.depth++; return 'punct';
      case ')': state.depth = Math.max(0, state.depth - 1); return 'punct';
      case ':': state.expectType = true; return 'punct';
      case '.': state.prev = 'dot'; return 'punct';
      case '=': case ',': case '[': case ']': return 'punct';
      default: return null;
    }
  },

  // Lets Cmd/Ctrl / comment a block out.
  languageData: { commentTokens: { line: '#' } },

  tokenTable: {
    comment: t.lineComment,
    keyword: t.keyword,
    type: t.typeName,
    label: t.definition(t.variableName),
    pin: t.propertyName,
    number: t.number,
    name: t.variableName,
    punct: t.punctuation,
  },
};

const style = HighlightStyle.define([
  { tag: t.lineComment, class: 'tok-comment' },
  { tag: t.keyword, class: 'tok-keyword' },
  { tag: t.typeName, class: 'tok-type' },
  { tag: t.definition(t.variableName), class: 'tok-label' },
  { tag: t.propertyName, class: 'tok-pin' },
  { tag: t.number, class: 'tok-number' },
  { tag: t.variableName, class: 'tok-name' },
  { tag: t.punctuation, class: 'tok-punct' },
]);

export const hdlLanguage = [
  StreamLanguage.define(parser),
  syntaxHighlighting(style),
];
