# The manual

`public/manual.html` is generated. Edit the files here instead and run:

```
npm run manual
```

It also runs as part of `npm run build`, so a forgotten rebuild cannot ship a
stale page.

## Layout

One file per stage in `content/`, named after its number so that plain
alphabetical order is reading order. `N-part.md` is a part header, `A-part.md`
the appendix. `template.html` is the page around the stages: the head, all the
CSS, the masthead and the closing section. The contents list is generated from
the stage files, so adding a stage means adding one file and nothing else.

## Front matter

```
---
num: 3.05
title: Bit
sig: Bit(in, load, clk) → out
needs: 3.04, 1.05
short: Bit                 # optional: a shorter title for the contents list
---
```

A part header uses `kind: part`, `roman:` and `title:` instead.

## Body

Ordinary markdown — paragraphs, `**bold**`, `*italic*`, `` `code` `` and `-`
lists — plus four things markdown has no way to say.

### Truth tables

`>` on a heading marks an answer column, drawn in the accent colour. `.` marks
a prose column, set in the body face rather than the mono one. A cell that
needs a literal `|` escapes it as `\|` — the instruction set in 4.01 has to
name expressions like `D|A`.

    ```truth
    a | b | >out
    0 | 0 | 0
    0 | 1 | 0
    1 | 0 | 0
    1 | 1 | 1
    ```

### Timing diagrams

One line per signal, one character per step. `>` marks an output, `?` a level
that is not yet known. `@col` puts a labelled dashed line at a column boundary,
`~a-b` a labelled bracket underneath. `!` sets the alt text.

    ```wave
    !Timing diagram for the flip-flop
    clk 1100110011001100
    d   1001110001110100
    >q  0000111100001111
    @4 read
    @8 read
    @12 read
    ```

All the geometry — coordinates, edges, where a caption has to anchor so it does
not collide with its neighbour — is worked out at build time. Every signal must
have the same number of columns, and the build fails loudly if one does not.

### Notes

A blockquote is an aside: a remark that belongs in the middle of a
specification without breaking its flow. It takes any markdown inside,
including several paragraphs, and it goes wherever you put it.

    Ordinary paragraph.

    > **Lead-in, if you want one.** The rest of the note, which can hold
    > `code`, *emphasis*, and lists.

    The specification continues here.

Use it for something a reader wants while reading, and a `::: watch` box for
something that will bite them while building. The note is filled and quiet;
Watch out is ruled, labelled and sits at the end of the stage.

### Instruction layouts

One character per bit, one line per field, `label` after the colon. The build
draws the boxes, numbers the bits from the left, and refuses to build if the
fields do not add up to sixteen.

    ```bits
    !Layout of a C-instruction
    1 : op
    11 : unused
    a : a
    cccccc : compute
    ddd : dest
    jjj : jump
    ```

Keep the labels to one short word. They are centred under their field, and a
long one on a narrow field will collide with its neighbour — say the rest in
the prose underneath.

Do not draw a layout with box-drawing characters in a plain code block. They
are not in the manual's mono face, so they fall back to whatever font has
them, and the rules stop lining up with the cells they belong to.

### Code blocks

A plain fenced block, for bit layouts, machine code and assembly listings. It
is monospace and scrolls inside its own box, so a wide layout never stretches
the page.

Name a language after the opening fence and it is highlighted:

    ```python
    def decode(instruction):
        return instruction >> 15
    ```

Highlighting happens at build time, so the page carries no script and no
highlighter. Any language `highlight.js` knows will do; one it does not know
is a build error rather than a silently unhighlighted block, because that is
almost always a typo in the fence. The colours are the manual's own two --
keywords take the accent, literals sit at full ink, comments fade -- rather
than a syntax rainbow.

### Mathematics

A fence named `latex` is set as displayed mathematics:

    ```latex
    \text{out} = \overline{a \land b}
    ```

Also build time: KaTeX renders it to MathML, which browsers set themselves, so
there is no stylesheet to load and no font to download and the manual stays a
single file. LaTeX that does not parse fails the build with KaTeX's own
message. There is no inline math -- a fence is the only form.

### Subheadings

`##` inside a stage renders as a small tracked label. Only a stage long enough
to need signposting should use one — 4.01 is the only one that does. Do not
use `###`: an `h3` is the stage title itself.

### Watch out boxes

    ::: watch
    Give the clock a period comfortably longer than the deepest path of gates.
    :::
