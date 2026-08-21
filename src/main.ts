import './style.css';
import { App } from './ui/app';
import { CanvasView, isTyping } from './ui/canvas';
import { Chrome } from './ui/chrome';
import { Inspector } from './ui/inspector';
import { Library } from './ui/library';
import { TextView } from './ui/textview';
import { h } from './ui/dom';
import { initTheme } from './ui/theme';
import { requestPersistence } from './core/storage';

async function boot() {
  initTheme();
  // Not awaited: whether the browser agrees to keep the database changes
  // nothing about starting up, and Firefox shows a prompt we should not
  // make the first screen wait on.
  void requestPersistence();
  const app = await App.boot();

  const topbar = h('div', { class: 'topbar' });
  const sidebar = h('div', { class: 'sidebar' });
  const canvasWrap = h('div', { class: 'canvas-wrap' });
  const inspectorEl = h('div', { class: 'inspector' });
  const statusbar = h('div', { class: 'statusbar' });

  const shell = h('div', { class: 'shell' }, topbar, sidebar, canvasWrap, inspectorEl, statusbar);
  const root = document.getElementById('app')!;
  root.appendChild(shell);

  // The library is built first so the sidebar has its real width before the
  // canvas measures the space it has been given.
  const library = new Library(app, sidebar);
  const extract = () => library.extractSelection();
  const canvas = new CanvasView(app, canvasWrap, { extract });
  const text = new TextView(app, canvasWrap);
  new Inspector(app, inspectorEl, extract, () => canvas.arrange());
  new Chrome(app, topbar, statusbar, {
    fit: () => canvas.fit(),
    // Leaving the text editor commits what is written, or refuses and says
    // why -- switching away must never quietly discard an edit.
    setMode: (mode) => {
      if (mode === 'schematic' && app.mode === 'text' && !text.commit()) {
        app.toast('Fix the problems below before going back to the schematic', 'err');
        return;
      }
      app.setMode(mode);
      if (mode === 'schematic') requestAnimationFrame(() => canvas.fit());
    },
  });

  // Handy when poking at state from the console.
  (window as unknown as Record<string, unknown>).nand = { app, canvas, text };

  mountHint(app, canvasWrap);
  mountToast(app);
  bindKeys(app, canvas, extract);

  app.compileNow();
  // One frame later, so the panels have been laid out and the canvas knows
  // how much room it actually has.
  requestAnimationFrame(() => canvas.fit());

  // Fetch the code editor once the first paint is out of the way, so that
  // switching to text is instant without the schematic having waited for it.
  const idle = window.requestIdleCallback ?? ((fn: () => void) => setTimeout(fn, 1200));
  idle(() => void text.preload());

  // A half-finished edit should not be lost to a closed tab -- including one
  // typed in the last half second, before the editor committed it.
  window.addEventListener('beforeunload', () => {
    text.commit();
    app.persist(true);
  });
}

/** Shown only while the open component is empty. */
function mountHint(app: App, host: HTMLElement) {
  const hint = h('div', { class: 'canvas-hint' });
  hint.appendChild(h('div', null, 'Empty component'));
  hint.appendChild(h('div', { style: { marginTop: '6px', fontSize: '11.5px' } },
    'Pick something from the left, then click the grid to place it.'));
  hint.appendChild(h('div', { style: { marginTop: '2px', fontSize: '11.5px' } },
    'Drag from an output pin to an input pin to wire them together.'));
  hint.appendChild(h('div', { style: { marginTop: '2px', fontSize: '11.5px' } },
    'Select what you built, then right-click to make it a component.'));
  host.appendChild(hint);
  const sync = () => {
    hint.style.display = app.openDef.instances.length || app.mode === 'text' ? 'none' : '';
  };
  app.on('project', sync);
  app.on('view', sync);
  sync();
}

function mountToast(app: App) {
  let el: HTMLElement | null = null;
  app.on('toast', () => {
    el?.remove();
    el = null;
    if (!app.toastText) return;
    el = h('div', { class: `toast ${app.toastKind === 'err' ? 'err' : ''}` }, app.toastText);
    document.body.appendChild(el);
  });
}

function bindKeys(app: App, canvas: CanvasView, extract: () => void) {
  window.addEventListener('keydown', (e) => {
    if (isTyping(e.target)) return;
    // Canvas shortcuts have no meaning while the text editor is showing.
    if (app.mode === 'text') return;
    if (document.querySelector('.scrim')) return;
    const mod = e.metaKey || e.ctrlKey;

    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) app.redo(); else app.undo();
      return;
    }
    if (mod && e.key === 'Enter') { e.preventDefault(); app.togglePower(); return; }
    if (mod && e.key.toLowerCase() === 'c') { e.preventDefault(); app.copySelection(); return; }
    if (mod && e.key.toLowerCase() === 'v') {
      e.preventDefault();
      const at = canvas.cursorGrid;
      app.paste(at.x, at.y);
      return;
    }
    if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); app.duplicateSelection(); return; }
    if (mod && e.key.toLowerCase() === 'g') { e.preventDefault(); extract(); return; }
    if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); app.selectAll(); return; }
    if (mod) return;

    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); canvas.deleteSelection(); return; }
    if (e.key === 'Escape') {
      if (app.armed) { app.armed = null; app.emit('project'); }
      else app.clearSelection();
      return;
    }
    if (e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); canvas.fit(); return; }
    if (e.key === '=' || e.key === '+') { e.preventDefault(); canvas.zoomBy(1.2); return; }
    if (e.key === '-' || e.key === '_') { e.preventDefault(); canvas.zoomBy(1 / 1.2); return; }

    const nudges: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
    };
    const nudge = nudges[e.key];
    if (nudge) {
      e.preventDefault();
      if (app.selection.instances.size) canvas.nudge(nudge[0], nudge[1]);
      else if (app.powered && e.key === 'ArrowRight') app.stepOnce(e.shiftKey ? 100 : 1);
    }
  });
}

boot().catch((err) => {
  document.getElementById('app')!.appendChild(
    h('div', { style: { padding: '40px', fontFamily: 'var(--mono)', color: 'var(--danger)' } },
      `Failed to start: ${(err as Error).message}`),
  );
  console.error(err);
});
