// Drag handles between the Files, Editor and Output columns. Widths are kept
// per browser; double-click a handle to go back to the default width.
import { onLangChange, t } from './i18n';

const KEY = 'fpgaweb.paneWidths';
const STEP = 16; // arrow-key step, px
const EDITOR_MIN = 320;
const PANES = {
  files: { css: '--files-w', min: 140, max: 480 },
  output: { css: '--output-w', min: 260, max: 1200 },
} as const;
type Pane = keyof typeof PANES;

function load(): Partial<Record<Pane, number>> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Record<Pane, number>>;
  } catch {
    return {};
  }
}

function save(w: Partial<Record<Pane, number>>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(w));
  } catch {
    /* private mode: widths last until reload */
  }
}

export function initSplitters(main: HTMLElement): void {
  const files = main.querySelector<HTMLElement>('.panel-files')!;
  const output = main.querySelector<HTMLElement>('.panel-output')!;
  const widths = load();
  const other = (p: Pane) => (p === 'files' ? output : files);

  // Keep the editor at least EDITOR_MIN wide whatever the window size.
  const clamp = (p: Pane, px: number) => {
    const room = main.clientWidth - other(p).getBoundingClientRect().width - EDITOR_MIN - 12;
    return Math.round(Math.max(PANES[p].min, Math.min(PANES[p].max, room, px)));
  };
  const apply = (p: Pane, px: number | undefined) => {
    if (px === undefined) main.style.removeProperty(PANES[p].css);
    else main.style.setProperty(PANES[p].css, `${clamp(p, px)}px`);
  };
  const set = (p: Pane, px: number | undefined) => {
    apply(p, px);
    if (px === undefined) delete widths[p];
    else widths[p] = clamp(p, px);
    save(widths);
  };
  (Object.keys(PANES) as Pane[]).forEach((p) => apply(p, widths[p]));

  const handle = (p: Pane, before: HTMLElement) => {
    const el = document.createElement('div');
    el.className = 'splitter';
    el.tabIndex = 0;
    el.setAttribute('role', 'separator');
    el.setAttribute('aria-orientation', 'vertical');
    el.dataset.pane = p;
    const label = () => {
      el.title = t('split.title');
      el.setAttribute('aria-label', t('split.title'));
    };
    label();
    onLangChange(label);
    before.before(el);

    const pane = p === 'files' ? files : output;
    const width = () => pane.getBoundingClientRect().width;
    // The Files handle grows its pane to the right, the Output handle to the left.
    const sign = p === 'files' ? 1 : -1;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const x0 = e.clientX, w0 = width();
      document.body.classList.add('resizing');
      el.classList.add('dragging');
      const move = (ev: PointerEvent) => apply(p, w0 + sign * (ev.clientX - x0));
      const up = () => {
        el.removeEventListener('pointermove', move);
        document.body.classList.remove('resizing');
        el.classList.remove('dragging');
        set(p, width());
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up, { once: true });
      el.addEventListener('pointercancel', up, { once: true });
    });
    el.addEventListener('dblclick', () => set(p, undefined));
    el.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowRight' ? STEP : e.key === 'ArrowLeft' ? -STEP : 0;
      if (!d) return;
      e.preventDefault();
      set(p, width() + sign * d);
    });
  };
  handle('files', main.querySelector<HTMLElement>('.panel-editor')!);
  handle('output', output);

  // A narrower window must not squeeze the editor below its minimum.
  window.addEventListener('resize', () => (Object.keys(PANES) as Pane[]).forEach((p) => widths[p] !== undefined && apply(p, widths[p])));
}
