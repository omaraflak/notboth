/**
 * A circuit written in the editor's text form, drawn as an SVG.
 *
 * Nothing here decides where anything goes. The text is parsed by the same
 * parser the Code view uses, positioned by the same auto-arrange the Arrange
 * button uses, and the boxes and wires are placed by the same geometry the
 * canvas uses. This file only paints the result, because the editor paints to
 * a canvas and a page needs SVG.
 */

import { applyText } from '../src/core/hdl';
import {
  GRID, NAME_FONT, PIN_FONT, approxMeasure, layoutBox, planRoutes, showPinLabel, sliceLabel,
  type BoxLayout, type Obstacle, type WireGeom,
} from '../src/core/layout';
import { customLabel, isPrim, primLabel, viewportCells } from '../src/core/primitives';
import { arrange } from '../src/core/autolayout';
import { createProject, defSignature, emptyDef } from '../src/core/project';
import type { ComponentDef, Instance, Project } from '../src/core/types';

/** Room around the drawing, in grid cells. */
const MARGIN = 1.5;

interface Placed { inst: Instance; box: BoxLayout; name: string }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function nameOf(project: Project, inst: Instance): string {
  if (isPrim(inst.def)) return primLabel(inst);
  return project.defs.find((d) => d.id === inst.def)?.name ?? '?';
}

/**
 * One project for the whole manual, filled in as the pages are built.
 *
 * A named circuit stays in it, so a later stage can use the chips the earlier
 * stages answered -- which is the manual's own dependency order, checked. A
 * stage that reaches for a part it has not introduced yet fails the build.
 */
const project: Project = (() => {
  const p = createProject('manual');
  p.defs = [];
  return p;
})();

/** Parse the text into a component, alongside the ones already answered. */
function build(source: string, name: string): ComponentDef {
  const def = emptyDef(name, null);
  project.defs.push(def);
  const issues = applyText(project, def, source);
  if (issues.length) {
    throw new Error(`circuit "${name}": ${issues.map((i) => `line ${i.line}: ${i.message}`).join('; ')}`);
  }
  return def;
}

export function renderCircuit(source: string, name = 'Answer'): string {
  const def = build(source, name);

  // Positions come from the same pass the Arrange button runs, so a circuit in
  // the manual is laid out the way the editor would lay it out.
  arrange(project, def.instances, def.wires);

  const placed: Placed[] = def.instances.map((inst) => {
    const sig = defSignature(project, inst.def, inst.props);
    const name = nameOf(project, inst);
    return { inst, name, box: layoutBox(sig, name, approxMeasure, customLabel(inst), viewportCells(inst)) };
  });
  const byId = new Map(placed.map((p) => [p.inst.id, p]));

  const pinAt = (instId: string, pinId: string) => {
    const p = byId.get(instId);
    const pin = p?.box.pins.find((x) => x.pin.id === pinId);
    return p && pin ? { x: p.inst.x + pin.x, y: p.inst.y + pin.y } : null;
  };

  const geoms: WireGeom[] = [];
  for (const w of def.wires) {
    const from = pinAt(w.from.inst, w.from.pin);
    const to = pinAt(w.to.inst, w.to.pin);
    if (!from || !to) continue;
    geoms.push({
      id: w.id,
      net: `${w.from.inst}:${w.from.pin}:${w.from.lo}-${w.from.hi}`,
      from, to, via: w.via, fromInst: w.from.inst, toInst: w.to.inst,
    });
  }
  const obstacles: Obstacle[] = placed.map((p) => ({
    id: p.inst.id,
    x0: p.inst.x, y0: p.inst.y, x1: p.inst.x + p.box.w, y1: p.inst.y + p.box.h,
  }));
  const routes = planRoutes(geoms, obstacles);

  /* ---- the extent of everything, so the picture crops to its content ---- */

  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  const stretch = (x: number, y: number) => {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  };
  for (const p of placed) {
    stretch(p.inst.x, p.inst.y);
    stretch(p.inst.x + p.box.w, p.inst.y + p.box.h);
  }
  for (const path of routes.paths.values()) for (const pt of path) stretch(pt.x, pt.y);
  if (!Number.isFinite(minX)) return '';

  const ox = (minX - MARGIN) * GRID;
  const oy = (minY - MARGIN) * GRID;
  const width = Math.round((maxX - minX + MARGIN * 2) * GRID);
  const height = Math.round((maxY - minY + MARGIN * 2) * GRID);
  const X = (x: number) => +(x * GRID - ox).toFixed(1);
  const Y = (y: number) => +(y * GRID - oy).toFixed(1);

  /* ---- paint ---- */

  const out: string[] = [];
  // Drawn at the editor's own scale, but allowed to shrink into a page column
  // -- and only so far. Past half size the labels stop being readable, so a
  // circuit that wide is scrolled instead of squinted at.
  const style = `width:${width}px;min-width:${Math.round(width / 2)}px;max-width:100%;height:auto`;
  out.push(`<svg class="circuit" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"`
    + ` style="${style}" role="img" aria-label="circuit diagram">`);

  const widthOfNet = new Map<string, number>();
  for (const w of def.wires) {
    widthOfNet.set(`${w.from.inst}:${w.from.pin}:${w.from.lo}-${w.from.hi}`, w.from.hi - w.from.lo + 1);
  }
  for (const [net, path] of routes.paths) {
    const d = path.map((p, i) => `${i ? 'L' : 'M'}${X(p.x)},${Y(p.y)}`).join(' ');
    const bus = (widthOfNet.get(net) ?? 1) > 1;
    out.push(`<path class="cw${bus ? ' bus' : ''}" d="${d}"/>`);
  }
  for (const j of routes.junctions) {
    out.push(`<circle class="cj" cx="${X(j.x)}" cy="${Y(j.y)}" r="3"/>`);
  }

  for (const p of placed) {
    const x = X(p.inst.x); const y = Y(p.inst.y);
    const w = p.box.w * GRID; const h = p.box.h * GRID;
    const label = customLabel(p.inst);
    out.push(`<rect class="cb" x="${x}" y="${y}" width="${w}" height="${h}" rx="4"/>`);
    const cy = y + h / 2 + (label ? 5 : 0);
    if (label) out.push(`<text class="cl" x="${x + w / 2}" y="${cy - 10}" text-anchor="middle">${esc(label)}</text>`);
    out.push(`<text class="cn" x="${x + w / 2}" y="${cy}">${esc(p.name)}</text>`);

    for (const pin of p.box.pins) {
      const px = X(p.inst.x + pin.x); const py = Y(p.inst.y + pin.y);
      if (pin.pin.width > 1) {
        const sx = pin.side === 'in' ? px - 3.5 : px;
        out.push(`<rect class="cs" x="${sx}" y="${py - 3}" width="3.5" height="6"/>`);
      }
      out.push(`<circle class="cp" cx="${px}" cy="${py}" r="2.6"/>`);
      if (!showPinLabel(pin.pin, p.name, p.box.pins.length)) continue;
      const inward = pin.side === 'in' ? 7 : -7;
      out.push(`<text class="cpl" x="${px + inward}" y="${py}"`
        + ` text-anchor="${pin.side === 'in' ? 'start' : 'end'}">${esc(pin.pin.name)}</text>`);
    }
  }

  out.push('</svg>');
  return out.join('');
}

// Referenced so a reader can find where the fonts and slice labels come from,
// even though the stylesheet sets the type and these circuits carry no slices.
void NAME_FONT; void PIN_FONT; void sliceLabel;
