/**
 * Build public/manual.html from manual/.
 *
 * The manual is prose with five things prose cannot carry: a stage header, a
 * truth table, a timing diagram, an instruction layout, and the callout box.
 * Each of those gets a small syntax here so that the source stays something
 * you can read and edit in a text editor, and the geometry stays something a
 * machine works out.
 *
 *   ```truth          ```wave                   ```bits
 *   a | b | >out      !alt text                 !alt text
 *   0 | 0 | 0         clk  1100110011001100     0 : op
 *   ...               >q   0000111100001111     vvvvvvvvvvvvvvv : constant
 *   ```               @4 read                   ```
 *                     ~0-1 unknown at power-on
 *                     ```                       ::: watch
 *                                               ...text...
 *                                               :::
 *
 * In a truth table header, `>` marks an answer column and `.` a prose one. In
 * a waveform, `>` marks an output, `?` an unknown level, `@col` a labelled
 * instant and `~a-b` a labelled span. In a layout, one character per bit and
 * one line per field.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { marked } from 'marked';

const CONTENT = 'manual/content';
const OUT = 'public/manual.html';

/* ------------------------------------------------------------------ *
 * Waveform geometry. Nothing here is a choice a writer should have to
 * make, which is the whole reason the source says `clk 1100...` instead.
 * ------------------------------------------------------------------ */

const X0 = 76, U = 30, TOP = 10, ROW = 44, AMP = 20;

function wavePath(levels, top) {
  const y = (v) => (v === '1' ? top : v === '0' ? top + AMP : top + AMP / 2);
  const runs = [];
  levels.split('').forEach((v, i) => {
    const kind = v === '?' ? '?' : 'k';
    const last = runs[runs.length - 1];
    if (last && last.kind === kind) last.to = i;
    else runs.push({ kind, from: i, to: i });
  });
  return runs.map((run) => {
    const pts = [];
    let prev = null;
    for (let i = run.from; i <= run.to; i++) {
      const at = y(levels[i]);
      const x = X0 + i * U;
      if (prev !== null && at !== prev) pts.push([x, prev]);
      pts.push([x, at]);
      prev = at;
    }
    pts.push([X0 + (run.to + 1) * U, prev]);
    return { kind: run.kind, d: 'M' + pts.map(([x, v]) => `${x},${v}`).join(' L') };
  });
}

function wave(body) {
  const rows = [];
  const marks = [];
  const spans = [];
  let alt = 'Timing diagram';
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('!')) { alt = line.slice(1).trim(); continue; }
    if (line.startsWith('@')) {
      const m = /^@(\d+)\s+(.*)$/.exec(line);
      marks.push({ at: Number(m[1]), label: m[2] });
      continue;
    }
    if (line.startsWith('~')) {
      const m = /^~(\d+)-(\d+)\s+(.*)$/.exec(line);
      spans.push({ from: Number(m[1]), to: Number(m[2]), label: m[3] });
      continue;
    }
    const m = /^(>?)(\S+)\s+([01?]+)$/.exec(line);
    if (!m) throw new Error(`wave: cannot read "${line}"`);
    rows.push({ out: m[1] === '>', name: m[2], levels: m[3] });
  }
  const n = rows[0].levels.length;
  for (const r of rows) {
    if (r.levels.length !== n) throw new Error(`wave: "${r.name}" is ${r.levels.length} columns, expected ${n}`);
  }

  const parts = [];
  rows.forEach((r, i) => {
    const top = TOP + i * ROW;
    parts.push(`<text class="wv-lab" x="${X0 - 10}" y="${top + AMP / 2 + 4}" text-anchor="end">${r.name}</text>`);
    for (const p of wavePath(r.levels, top)) {
      const cls = p.kind === '?' ? 'wv-unk' : r.out ? 'wv-out' : 'wv-line';
      parts.push(`<path class="${cls}" d="${p.d}"/>`);
    }
  });

  const cap = TOP + rows.length * ROW - (ROW - AMP) + 6;
  for (const s of spans) {
    const x1 = X0 + s.from * U;
    const x2 = X0 + (s.to + 1) * U;
    // A caption centred over a span at the edge of the picture spills sideways
    // into its neighbour, so the outermost ones anchor to their own end.
    const [anchor, tx] = s.from === 0 ? ['start', x1]
      : s.to === n - 1 ? ['end', x2]
      : ['middle', (x1 + x2) / 2];
    parts.push(`<path class="wv-span" d="M${x1},${cap - 4} L${x1},${cap} L${x2},${cap} L${x2},${cap - 4}"/>`);
    parts.push(`<text class="wv-note" x="${tx}" y="${cap + 13}" text-anchor="${anchor}">${s.label}</text>`);
  }
  for (const m of marks) {
    const x = X0 + m.at * U;
    parts.push(`<line class="wv-mark" x1="${x}" y1="${TOP - 4}" x2="${x}" y2="${cap - 6}"/>`);
    parts.push(`<text class="wv-tick" x="${x}" y="${cap + 6}" text-anchor="middle">${m.label}</text>`);
  }

  const h = cap + (spans.length || marks.length ? 24 : 4);
  const w = X0 + U * n + 8;
  return `<figure class="wave" role="img" aria-label="${alt}">\n`
    + `  <svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">\n    `
    + parts.join('\n    ') + '\n  </svg>\n</figure>';
}

/* ------------------------------------------------------------------ *
 * Instruction layouts. Drawn rather than typed: box-drawing characters are
 * not in the manual's mono face, so an ASCII diagram falls back to whatever
 * font has them and the rules stop meeting the cells they belong to.
 * ------------------------------------------------------------------ */

const BW = 27, BH = 26, BTOP = 15;

function bits(body) {
  let alt = 'Instruction layout';
  const fields = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('!')) { alt = line.slice(1).trim(); continue; }
    const m = /^(\S+)\s*:\s*(.*)$/.exec(line);
    if (!m) throw new Error(`bits: cannot read "${line}"`);
    fields.push({ syms: m[1].split(''), label: m[2].trim() });
  }
  const n = fields.reduce((t, f) => t + f.syms.length, 0);
  // Every word in this manual is sixteen bits wide, and the realistic mistake
  // is miscounting a run of placeholders, so it is worth refusing to build.
  if (n !== 16) throw new Error(`bits: fields add up to ${n} bits, expected 16`);

  const parts = [];
  const bottom = BTOP + BH;
  let at = 0;
  fields.forEach((f, i) => {
    const x = at * BW;
    const w = f.syms.length * BW;
    // Alternate fills do the grouping, so the labels below only have to say
    // which field is which, not draw a bracket to reach it.
    if (i % 2) parts.push(`<rect class="bt-fill" x="${x}" y="${BTOP}" width="${w}" height="${BH}"/>`);
    f.syms.forEach((sym, k) => {
      const cx = x + k * BW;
      if (k) parts.push(`<line class="bt-div" x1="${cx}" y1="${BTOP}" x2="${cx}" y2="${bottom}"/>`);
      parts.push(`<text class="bt-sym" x="${cx + BW / 2}" y="${BTOP + BH / 2 + 4}" text-anchor="middle">${sym}</text>`);
      parts.push(`<text class="bt-idx" x="${cx + BW / 2}" y="${BTOP - 5}" text-anchor="middle">${n - 1 - (at + k)}</text>`);
    });
    if (i) parts.push(`<line class="bt-edge" x1="${x}" y1="${BTOP}" x2="${x}" y2="${bottom}"/>`);
    if (f.label) {
      parts.push(`<text class="bt-lab" x="${x + w / 2}" y="${bottom + 15}" text-anchor="middle">${f.label}</text>`);
    }
    at += f.syms.length;
  });
  parts.push(`<rect class="bt-box" x="0" y="${BTOP}" width="${n * BW}" height="${BH}"/>`);

  const h = bottom + 20;
  return `<figure class="bits" role="img" aria-label="${alt}">\n`
    + `  <svg viewBox="-1 0 ${n * BW + 2} ${h}" xmlns="http://www.w3.org/2000/svg">\n    `
    + parts.join('\n    ') + '\n  </svg>\n</figure>';
}

/* ------------------------------------------------------------------ *
 * Truth tables
 * ------------------------------------------------------------------ */

function truth(bodyText) {
  const lines = bodyText.split('\n').map((l) => l.trim()).filter(Boolean);
  // A cell may need a literal pipe -- `D|A` is an expression the instruction
  // set in 4.01 has to name -- so `\\|` escapes the separator.
  const cells = (l) => l.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
  const heads = cells(lines[0]);
  const kind = heads.map((h) => (h.startsWith('>') ? 'o' : h.startsWith('.') ? 'l' : ''));
  const names = heads.map((h) => h.replace(/^[>.]/, ''));
  const rows = lines.slice(1).map(cells);
  for (const r of rows) {
    if (r.length !== names.length) throw new Error(`truth: row "${r.join(' | ')}" has ${r.length} cells, expected ${names.length}`);
  }
  const head = names.map((h) => `<th>${md(h)}</th>`).join('');
  const body = rows.map((r) =>
    '          <tr>' + r.map((c, i) => `<td${kind[i] ? ` class="${kind[i]}"` : ''}>${md(c)}</td>`).join('') + '</tr>').join('\n');
  return '      <div class="tt-wrap">\n        <table class="tt">\n'
    + `          <tr>${head}</tr>\n${body}\n        </table>\n      </div>`;
}

/* ------------------------------------------------------------------ *
 * Markdown
 * ------------------------------------------------------------------ */

marked.setOptions({ mangle: false, headerIds: false });

/** Inline markdown, with no wrapping paragraph. */
function md(text) {
  return marked.parseInline(text ?? '').trim();
}

/**
 * Block markdown. Anything the manual needs and markdown does not have is
 * lifted out first and put back after, so marked only ever sees prose.
 */
function blocks(text) {
  const held = [];
  const keep = (html) => `<!--HOLD:${held.push(html) - 1}-->`;
  let t = text;
  const custom = { wave, truth, bits };
  t = t.replace(/^```(wave|truth|bits)\n([\s\S]*?)\n```$/gm,
    (_, kind, body) => keep(custom[kind](body)));
  t = t.replace(/^::: watch\n([\s\S]*?)\n:::$/gm,
    (_, body) => keep(`<div class="watch"><b>Watch out</b>${md(body.replace(/\n/g, ' '))}</div>`));
  let html = marked.parse(t);
  html = html.replace(/<!--HOLD:(\d+)-->/g, (_, i) => held[Number(i)]);
  return html.trim();
}

/* ------------------------------------------------------------------ *
 * Sources
 * ------------------------------------------------------------------ */

function frontMatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) throw new Error('missing front matter');
  const meta = {};
  for (const line of m[1].split('\n')) {
    const at = line.indexOf(':');
    if (at > 0) meta[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return { meta, body: text.slice(m[0].length) };
}

const docs = readdirSync(CONTENT).filter((f) => f.endsWith('.md')).sort()
  .map((file) => {
    try {
      const { meta, body } = frontMatter(readFileSync(`${CONTENT}/${file}`, 'utf8'));
      return { file, meta, body };
    } catch (e) {
      throw new Error(`${file}: ${e.message}`);
    }
  });

/* ------------------------------------------------------------------ *
 * Assembly
 * ------------------------------------------------------------------ */

const idOf = (num) => (/^[A-Z]/.test(num) ? num.toLowerCase().replace('.', '') : 's' + num.replace('.', ''));

const body = [];
const toc = [];
let group = null;

for (const { file, meta, body: text } of docs) {
  if (meta.kind === 'part') {
    body.push('<div class="part-head">\n'
      + `  <div class="roman">${md(meta.roman)}</div>\n  <div>\n`
      + `    <h2>${md(meta.title)}</h2>\n`
      + blocks(text).split('\n').map((l) => '    ' + l).join('\n')
      + '\n  </div>\n</div>\n<div class="part-rule"></div>');
    group = { roman: meta.roman, title: meta.short ?? meta.title, links: [] };
    toc.push(group);
    continue;
  }
  if (!meta.num || !meta.title) throw new Error(`${file}: a stage needs num and title`);
  const id = idOf(meta.num);
  const rail = `<span class="num">${meta.num}</span>`
    + (meta.needs ? `<span class="deps"><b>Needs</b>${md(meta.needs)}</span>` : '');
  body.push(`<article class="stage" id="${id}">\n  <div class="rail">${rail}</div>\n  <div>\n`
    + `    <h3>${md(meta.title)}</h3>\n`
    + (meta.sig ? `    <div class="sig">${md(meta.sig)}</div>\n` : '')
    + blocks(text).split('\n').map((l) => '    ' + l).join('\n')
    + '\n  </div>\n</article>');
  if (group) {
    // Appendix entries are lettered rather than numbered, and their numbers say
    // nothing useful in a contents list, so they are listed by title alone.
    const label = /^[A-Z]/.test(meta.num) ? '' : `<i>${meta.num}</i>`;
    group.links.push(`      <a href="#${id}">${label}${md(meta.short ?? meta.title)}</a>`);
  }
}

const tocHtml = '<nav class="toc">\n  <h2>Contents</h2>\n  <div class="toc-grid">\n'
  + toc.filter((g) => g.links.length).map((g) =>
    `    <div class="toc-part">\n      <b><i>${md(g.roman)}</i>${md(g.title)}</b>\n`
    + g.links.join('\n') + '\n    </div>').join('\n')
  + '\n  </div>\n</nav>';

const stages = docs.filter((d) => d.meta.num && !/^[A-Z]/.test(d.meta.num)).length;
const html = readFileSync('manual/template.html', 'utf8')
  .replace('<!--TOC-->', tocHtml)
  .replace('<!--BODY-->', body.join('\n\n'))
  .replace(/(<div><b>Stages<\/b><span>)\d+(<\/span>)/, `$1${stages}$2`);

// Git does not track empty directories, so on a fresh clone public/ may not
// exist at all -- and then the build fails on its very last line.
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, html);
console.log(`manual: ${docs.length} sources, ${stages} stages -> ${OUT}`);
