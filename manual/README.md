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
lists — plus three things markdown has no way to say.

### Truth tables

`>` on a heading marks an answer column, drawn in the accent colour. `.` marks
a prose column, set in the body face rather than the mono one.

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

### Watch out boxes

    ::: watch
    Give the clock a period comfortably longer than the deepest path of gates.
    :::
