// Schematic editor (Digital-style): SVG canvas with palette, placing, moving,
// rotating, wiring on a grid, properties, undo/redo, and a live-simulation mode.
// Labels and names are user text: SVG/DOM text via textContent only.

import { t, type Key } from '../i18n';
import {
  GATES, GRID, MAX_BITS, bitsOf, compDef, emptyCircuit, placedPins,
  type Circuit, type Comp, type CompType, type Pt, type Rot, type SubInterface, type Wire,
} from './model';
import { buildNetlist, type Net, type Netlist } from './netlist';
import { CircuitSim, subInterfaces } from './sim';

const NS = 'http://www.w3.org/2000/svg';

interface PaletteItem { type: CompType; key: Key; props?: Comp['props'] }
const PALETTE: { group: Key; items: PaletteItem[] }[] = [
  { group: 'ce.g.io', items: [
    { type: 'in', key: 'ce.c.in' }, { type: 'out', key: 'ce.c.out' }, { type: 'clock', key: 'ce.c.clock' },
    { type: 'const', key: 'ce.c.const', props: { value: 1 } }, { type: 'led', key: 'ce.c.led' },
  ] },
  { group: 'ce.g.gates', items: [
    { type: 'and', key: 'ce.c.and' }, { type: 'or', key: 'ce.c.or' }, { type: 'not', key: 'ce.c.not' },
    { type: 'nand', key: 'ce.c.nand' }, { type: 'nor', key: 'ce.c.nor' }, { type: 'xor', key: 'ce.c.xor' }, { type: 'xnor', key: 'ce.c.xnor' },
  ] },
  { group: 'ce.g.blocks', items: [
    { type: 'mux', key: 'ce.c.mux' }, { type: 'adder', key: 'ce.c.adder' }, { type: 'dff', key: 'ce.c.dff' },
    { type: 'register', key: 'ce.c.register', props: { bits: 4 } }, { type: 'counter', key: 'ce.c.counter', props: { bits: 4 } },
    { type: 'split', key: 'ce.c.split', props: { parts: '1,1' } }, { type: 'merge', key: 'ce.c.merge', props: { parts: '1,1' } },
  ] },
];

const SYMBOL: Partial<Record<CompType, string>> = {
  and: '&', nand: '&', or: '≥1', nor: '≥1', xor: '=1', xnor: '=1', not: '1', adder: 'Σ', dff: 'D', register: 'REG', counter: 'CTR',
};

type Drag =
  | { kind: 'move'; id: string; start: Pt; orig: Pt; moved: boolean }
  | { kind: 'wire'; from: Pt; to: Pt }
  | { kind: 'pan'; sx: number; sy: number; ox: number; oy: number };

export interface CircuitEditorHost {
  /** Called after every committed change with the new circuit. */
  onChange(circ: Circuit): void;
  /** Other circuits in the project (name → circuit), for sub-circuit blocks and simulation. */
  circuits(): Map<string, Circuit>;
}

export class CircuitEditor {
  private circ: Circuit = emptyCircuit();
  private name = '';
  private undo: string[] = [];
  private redo: string[] = [];
  private selected: { kind: 'comp' | 'wire'; id: string } | null = null;
  private placing: Comp | null = null;
  private drag: Drag | null = null;
  private mode: 'edit' | 'sim' = 'edit';
  private sim: CircuitSim | null = null;
  private timer: number | null = null;
  private view = { x: 20, y: 20, k: 1 };
  private hover: Pt = { x: 0, y: 0 };
  private subs = new Map<string, SubInterface>();
  private netlist: Netlist | null = null;

  private svg: SVGSVGElement;
  private layer: SVGGElement;
  private props: HTMLElement;
  private palette: HTMLElement;
  private problemsEl: HTMLElement;
  private modeBtns: HTMLButtonElement[] = [];
  private editTools: HTMLElement;
  private simTools: HTMLElement;
  private runBtn: HTMLButtonElement;
  private speed: HTMLSelectElement;

  constructor(private host: HTMLElement, private cb: CircuitEditorHost) {
    host.replaceChildren();
    host.classList.add('ce');
    const bar = div('ce-toolbar');
    const modes = div('seg-row ce-modes');
    for (const m of ['edit', 'sim'] as const) {
      const b = button(`ce.mode.${m}` as Key, () => this.setMode(m), 'seg-btn');
      b.dataset.mode = m;
      this.modeBtns.push(b);
      modes.append(b);
    }
    this.editTools = div('ce-tools');
    this.editTools.append(
      button('ce.undo', () => this.doUndo(), 'btn-ghost'),
      button('ce.redo', () => this.doRedo(), 'btn-ghost'),
      button('ce.rotate', () => this.rotateSelected(), 'btn-ghost'),
      button('ce.delete', () => this.deleteSelected(), 'btn-ghost'),
    );
    this.simTools = div('ce-tools');
    this.runBtn = button('ce.run', () => this.toggleRun(), 'btn-primary');
    this.speed = document.createElement('select');
    for (const hz of [1, 2, 5, 10, 50]) this.speed.append(new Option(`${hz} Hz`, String(hz), false, hz === 2));
    this.speed.onchange = () => { if (this.timer !== null) { this.stopRun(); this.toggleRun(); } };
    this.simTools.append(button('ce.step', () => this.step(), 'btn-tertiary'), this.runBtn, this.speed,
      button('ce.reset', () => this.resetSim(), 'btn-ghost'));
    const zoom = div('ce-tools');
    zoom.append(button('', () => this.zoomBy(1 / 1.2), 'btn-ghost btn-icon', '−'), button('', () => this.zoomBy(1.2), 'btn-ghost btn-icon', '+'),
      button('wv.fit', () => this.fit(), 'btn-ghost'));
    bar.append(modes, this.editTools, this.simTools, zoom);

    const body = div('ce-body');
    this.palette = div('ce-palette');
    this.svg = document.createElementNS(NS, 'svg');
    this.svg.classList.add('ce-canvas');
    this.svg.setAttribute('tabindex', '0');
    const defs = document.createElementNS(NS, 'defs');
    defs.innerHTML = `<pattern id="ce-grid" width="${GRID}" height="${GRID}" patternUnits="userSpaceOnUse"><circle cx="0" cy="0" r="1" class="ce-dot"/></pattern>`;
    this.svg.append(defs);
    this.layer = document.createElementNS(NS, 'g');
    this.svg.append(this.layer);
    this.props = div('ce-props');
    const side = div('ce-side');
    side.append(this.palette, this.props);
    body.append(side, this.svg);
    this.problemsEl = div('ce-problems');
    host.append(bar, body, this.problemsEl);
    this.bindEvents();
  }

  load(name: string, circ: Circuit): void {
    this.stopRun();
    this.name = name;
    this.circ = structuredClone(circ);
    this.undo = [];
    this.redo = [];
    this.selected = null;
    this.placing = null;
    this.setMode('edit', false);
    this.renderPalette();
    this.render();
    requestAnimationFrame(() => this.fit());
  }

  /** Re-render labels after a language change. */
  relabel(): void {
    this.host.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n as Key)));
    this.renderPalette();
    this.render();
  }

  destroy(): void {
    this.stopRun();
  }

  // ── State changes ──
  private commit(mutate: () => void): void {
    this.undo.push(JSON.stringify(this.circ));
    if (this.undo.length > 100) this.undo.shift();
    this.redo = [];
    mutate();
    this.cb.onChange(structuredClone(this.circ));
    this.render();
  }

  private doUndo(): void {
    const prev = this.undo.pop();
    if (!prev) return;
    this.redo.push(JSON.stringify(this.circ));
    this.circ = JSON.parse(prev);
    this.selected = null;
    this.cb.onChange(structuredClone(this.circ));
    this.render();
  }

  private doRedo(): void {
    const next = this.redo.pop();
    if (!next) return;
    this.undo.push(JSON.stringify(this.circ));
    this.circ = JSON.parse(next);
    this.selected = null;
    this.cb.onChange(structuredClone(this.circ));
    this.render();
  }

  private newId(prefix: string): string {
    const ids = new Set([...this.circ.components.map((c) => c.id), ...this.circ.wires.map((w) => w.id)]);
    let i = 1;
    while (ids.has(`${prefix}${i}`)) i++;
    return `${prefix}${i}`;
  }

  private defaultLabel(type: CompType): string | undefined {
    const prefix = type === 'in' ? 'in' : type === 'out' ? 'out' : type === 'clock' ? 'clk' : null;
    if (!prefix) return undefined;
    const used = new Set(this.circ.components.map((c) => c.props.label));
    if (type === 'clock' && !used.has('clk')) return 'clk';
    let i = 0;
    while (used.has(`${prefix}${i}`)) i++;
    return `${prefix}${i}`;
  }

  private rotateSelected(): void {
    const c = this.selectedComp();
    if (this.placing) {
      this.placing.rot = (((this.placing.rot + 90) % 360) as Rot);
      this.render();
    } else if (c) this.commit(() => (c.rot = ((c.rot + 90) % 360) as Rot));
  }

  private deleteSelected(): void {
    const s = this.selected;
    if (!s) return;
    this.commit(() => {
      if (s.kind === 'comp') this.circ.components = this.circ.components.filter((c) => c.id !== s.id);
      else this.circ.wires = this.circ.wires.filter((w) => w.id !== s.id);
      this.selected = null;
    });
  }

  private selectedComp(): Comp | undefined {
    return this.selected?.kind === 'comp' ? this.circ.components.find((c) => c.id === this.selected!.id) : undefined;
  }

  // ── Modes / simulation ──
  private setMode(m: 'edit' | 'sim', render = true): void {
    this.mode = m;
    this.stopRun();
    this.modeBtns.forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
    this.editTools.hidden = m !== 'edit';
    this.simTools.hidden = m !== 'sim';
    (this.palette.parentElement as HTMLElement).hidden = m !== 'edit';
    this.placing = null;
    this.sim = m === 'sim' ? new CircuitSim(this.circ, this.cb.circuits()) : null;
    this.host.classList.toggle('ce-simulating', m === 'sim');
    if (render) this.render();
  }

  private resetSim(): void {
    this.stopRun();
    this.sim = new CircuitSim(this.circ, this.cb.circuits());
    this.render();
  }

  private step(): void {
    if (!this.sim) return;
    this.sim.tick();
    this.render();
  }

  private toggleRun(): void {
    if (this.timer !== null) return this.stopRun();
    const hz = Number(this.speed.value) || 2;
    this.timer = window.setInterval(() => this.step(), 500 / hz); // two ticks per period
    this.runBtn.dataset.i18n = 'ce.pause';
    this.runBtn.textContent = t('ce.pause');
  }

  private stopRun(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    if (this.runBtn) {
      this.runBtn.dataset.i18n = 'ce.run';
      this.runBtn.textContent = t('ce.run');
    }
  }

  // ── View ──
  private applyView(): void {
    this.layer.setAttribute('transform', `translate(${this.view.x} ${this.view.y}) scale(${this.view.k})`);
  }

  private zoomBy(f: number, at?: { x: number; y: number }): void {
    const r = this.svg.getBoundingClientRect();
    const px = at?.x ?? r.width / 2, py = at?.y ?? r.height / 2;
    const k = Math.min(4, Math.max(0.25, this.view.k * f));
    this.view.x = px - ((px - this.view.x) * k) / this.view.k;
    this.view.y = py - ((py - this.view.y) * k) / this.view.k;
    this.view.k = k;
    this.applyView();
  }

  private fit(): void {
    const pts = [...this.circ.components.flatMap((c) => [{ x: c.x, y: c.y }, ...placedPins(c, this.subs).map((p) => p.at)]),
      ...this.circ.wires.flatMap((w) => [w.a, w.b])];
    const r = this.svg.getBoundingClientRect();
    if (!pts.length || !r.width) {
      this.view = { x: 40, y: 40, k: 1 };
      return this.applyView();
    }
    const minX = Math.min(...pts.map((p) => p.x)) - 2, maxX = Math.max(...pts.map((p) => p.x)) + 3;
    const minY = Math.min(...pts.map((p) => p.y)) - 2, maxY = Math.max(...pts.map((p) => p.y)) + 3;
    const k = Math.min(2, Math.max(0.3, Math.min(r.width / ((maxX - minX) * GRID), r.height / ((maxY - minY) * GRID))));
    this.view = { k, x: -minX * GRID * k + (r.width - (maxX - minX) * GRID * k) / 2, y: -minY * GRID * k + (r.height - (maxY - minY) * GRID * k) / 2 };
    this.applyView();
  }

  private toGrid(e: { clientX: number; clientY: number }): Pt {
    const r = this.svg.getBoundingClientRect();
    return {
      x: Math.round((e.clientX - r.left - this.view.x) / this.view.k / GRID),
      y: Math.round((e.clientY - r.top - this.view.y) / this.view.k / GRID),
    };
  }

  // ── Events ──
  private bindEvents(): void {
    this.svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = this.svg.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) this.zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1, { x: e.clientX - r.left, y: e.clientY - r.top });
      else {
        this.view.x -= e.deltaX;
        this.view.y -= e.deltaY;
        this.applyView();
      }
    }, { passive: false });

    this.svg.addEventListener('pointerdown', (e) => {
      this.svg.focus();
      const g = this.toGrid(e);
      if (e.button === 1 || e.button === 2 || (e.button === 0 && e.altKey)) {
        this.drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, ox: this.view.x, oy: this.view.y };
        this.svg.setPointerCapture(e.pointerId);
        return;
      }
      if (e.button !== 0) return;
      if (this.mode === 'sim') return this.simClick(e.target as Element);
      if (this.placing) {
        const c = { ...this.placing, x: g.x, y: g.y, id: this.newId('c'), props: { ...this.placing.props } };
        this.commit(() => {
          this.circ.components.push(c);
          this.selected = { kind: 'comp', id: c.id };
        });
        if (!e.shiftKey) this.placing = null; // shift-click keeps placing
        this.render();
        return;
      }
      const target = (e.target as Element).closest('[data-comp],[data-wire]');
      const compId = target?.getAttribute('data-comp');
      const onPin = (e.target as Element).closest('[data-pin]');
      if (compId && !onPin) {
        const c = this.circ.components.find((x) => x.id === compId)!;
        this.selected = { kind: 'comp', id: c.id };
        this.drag = { kind: 'move', id: c.id, start: g, orig: { x: c.x, y: c.y }, moved: false };
      } else if (target?.getAttribute('data-wire') && !onPin) {
        this.selected = { kind: 'wire', id: target.getAttribute('data-wire')! };
        this.drag = { kind: 'wire', from: g, to: g };
      } else {
        this.selected = null;
        this.drag = { kind: 'wire', from: g, to: g };
      }
      this.svg.setPointerCapture(e.pointerId);
      this.render();
    });

    this.svg.addEventListener('pointermove', (e) => {
      const g = this.toGrid(e);
      this.hover = g;
      const d = this.drag;
      if (d?.kind === 'pan') {
        this.view.x = d.ox + e.clientX - d.sx;
        this.view.y = d.oy + e.clientY - d.sy;
        return this.applyView();
      }
      if (d?.kind === 'move') {
        const c = this.circ.components.find((x) => x.id === d.id);
        if (!c) return;
        const nx = d.orig.x + g.x - d.start.x, ny = d.orig.y + g.y - d.start.y;
        if (nx !== c.x || ny !== c.y) {
          if (!d.moved) this.undo.push(JSON.stringify(this.circ));
          d.moved = true;
          c.x = nx;
          c.y = ny;
          this.render();
        }
        return;
      }
      if (d?.kind === 'wire') {
        if (d.to.x !== g.x || d.to.y !== g.y) {
          d.to = g;
          this.render();
        }
        return;
      }
      if (this.placing) this.render();
    });

    const end = () => {
      const d = this.drag;
      this.drag = null;
      if (d?.kind === 'move' && d.moved) {
        this.redo = [];
        this.cb.onChange(structuredClone(this.circ));
      }
      if (d?.kind === 'wire' && (d.from.x !== d.to.x || d.from.y !== d.to.y)) {
        const segs = lPath(d.from, d.to);
        this.commit(() => {
          for (const [a, b] of segs) this.circ.wires.push({ id: this.newId('w'), a, b });
        });
        return;
      }
      this.render();
    };
    this.svg.addEventListener('pointerup', end);
    this.svg.addEventListener('pointercancel', end);
    this.svg.addEventListener('contextmenu', (e) => e.preventDefault());

    this.svg.addEventListener('keydown', (e) => {
      if (this.mode !== 'edit') return;
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); this.deleteSelected(); }
      else if (e.key === 'r' || e.key === 'R') this.rotateSelected();
      else if (e.key === 'Escape') { this.placing = null; this.selected = null; this.render(); }
      else if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); this.doUndo(); }
      else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); this.doRedo(); }
    });
    new ResizeObserver(() => this.applyView()).observe(this.svg);
  }

  private simClick(target: Element): void {
    const id = target.closest('[data-comp]')?.getAttribute('data-comp');
    const c = id ? this.circ.components.find((x) => x.id === id) : undefined;
    if (!c || !this.sim) return;
    if (c.type === 'clock') this.sim.toggle(c.id);
    else if (c.type === 'in') {
      if (bitsOf(c) === 1) this.sim.toggle(c.id);
      else {
        const cur = this.sim.inputValue(c);
        const raw = prompt(t('ce.enterValue', { bits: bitsOf(c) }), `0x${cur.toString(16)}`);
        if (raw === null) return;
        const v = raw.trim().toLowerCase().startsWith('0b') ? parseInt(raw.trim().slice(2), 2) : Number(raw.trim());
        if (Number.isFinite(v)) this.sim.setInput(c.id, v);
      }
    } else return;
    this.render();
  }

  // ── Palette & properties ──
  private renderPalette(): void {
    const items: Node[] = [];
    const circuits = [...this.cb.circuits().keys()].filter((n) => n !== this.name).sort();
    const groups = [...PALETTE, ...(circuits.length ? [{ group: 'ce.g.circuits' as Key, items: circuits.map((n) => ({ type: 'sub' as CompType, key: 'ce.c.sub' as Key, props: { circuit: n } })) }] : [])];
    for (const g of groups) {
      const h = div('label');
      h.textContent = t(g.group);
      items.push(h);
      const grid = div('ce-palette-grid');
      for (const it of g.items) {
        const b = document.createElement('button');
        b.className = 'ce-pal-btn';
        b.dataset.type = it.type;
        b.textContent = it.type === 'sub' ? it.props!.circuit! : t(it.key);
        b.title = b.textContent;
        b.onclick = () => {
          this.placing = { id: '', type: it.type, x: this.hover.x, y: this.hover.y, rot: 0,
            props: { ...(it.props ?? {}), ...(this.defaultLabel(it.type) ? { label: this.defaultLabel(it.type) } : {}) } };
          this.selected = null;
          this.svg.focus();
          this.render();
        };
        grid.append(b);
      }
      items.push(grid);
    }
    const hint = div('ce-hint');
    hint.textContent = t('ce.hint');
    items.push(hint);
    this.palette.replaceChildren(...items);
  }

  private renderProps(): void {
    const c = this.selectedComp();
    if (!c) {
      const p = div('ce-hint');
      p.textContent = this.selected?.kind === 'wire' ? t('ce.wireSelected') : t('ce.noSelection');
      this.props.replaceChildren(p);
      return;
    }
    const rows: Node[] = [];
    const title = div('label');
    title.textContent = t(`ce.c.${c.type}` as Key);
    rows.push(title);
    const field = (key: Key, input: HTMLElement) => {
      const l = document.createElement('label');
      l.className = 'ce-field';
      const s = document.createElement('span');
      s.textContent = t(key);
      l.append(s, input);
      rows.push(l);
    };
    const num = (value: number, min: number, max: number, apply: (v: number) => void) => {
      const i = document.createElement('input');
      i.type = 'number';
      i.min = String(min);
      i.max = String(max);
      i.value = String(value);
      i.onchange = () => {
        const v = Math.min(max, Math.max(min, Math.trunc(Number(i.value)) || min));
        this.commit(() => apply(v));
      };
      return i;
    };
    const text = (value: string, apply: (v: string) => void) => {
      const i = document.createElement('input');
      i.value = value;
      i.spellcheck = false;
      i.onchange = () => this.commit(() => apply(i.value.trim()));
      return i;
    };
    if (['in', 'out', 'clock', 'led', 'const', 'register', 'counter', 'dff', 'sub'].includes(c.type) || GATES.includes(c.type)) {
      field('ce.p.label', text(c.props.label ?? '', (v) => (c.props.label = v || undefined)));
    }
    if (!['clock', 'led', 'split', 'merge', 'sub'].includes(c.type)) {
      field('ce.p.bits', num(bitsOf(c), 1, MAX_BITS, (v) => (c.props.bits = v)));
    }
    if (GATES.includes(c.type)) field('ce.p.inputs', num(c.props.inputs ?? 2, 2, 4, (v) => (c.props.inputs = v)));
    if (c.type === 'mux') field('ce.p.sel', num(c.props.sel ?? 1, 1, 2, (v) => (c.props.sel = v)));
    if (c.type === 'const' || c.type === 'in') field('ce.p.value', num(c.props.value ?? 0, 0, 0xffffffff, (v) => (c.props.value = v)));
    if (c.type === 'split' || c.type === 'merge') field('ce.p.parts', text(c.props.parts ?? '1,1', (v) => (c.props.parts = v)));
    const actions = div('ce-prop-actions');
    actions.append(button('ce.rotate', () => this.rotateSelected(), 'btn-ghost'), button('ce.delete', () => this.deleteSelected(), 'btn-ghost'));
    rows.push(actions);
    this.props.replaceChildren(...rows);
  }

  // ── Rendering ──
  private render(): void {
    this.subs = subInterfaces(this.cb.circuits());
    // In live mode the circuit is frozen: reuse the simulator's netlist so net values line up.
    this.netlist = this.sim ? this.sim.netlist : buildNetlist(this.circ, this.subs);
    const nl = this.netlist;
    const bad = new Set(nl.problems.filter((p) => p.kind !== 'floating').flatMap((p) => p.compIds));
    const warn = new Set(nl.problems.filter((p) => p.kind === 'floating').flatMap((p) => p.compIds));
    const conflict = new Set(nl.problems.filter((p) => p.kind === 'drivers' || p.kind === 'width').map((p) => p.netId));

    const g = document.createElementNS(NS, 'g');
    const bg = el('rect', { x: -5000, y: -5000, width: 10000, height: 10000, fill: 'url(#ce-grid)', class: 'ce-bg' });
    g.append(bg);

    // Wires
    for (const w of this.circ.wires) {
      const net = nl.wireNet.get(w.id)!;
      const cls = ['ce-wire', this.wireClass(net, conflict), this.selected?.kind === 'wire' && this.selected.id === w.id ? 'ce-sel' : '']
        .filter(Boolean).join(' ');
      const line = el('line', { x1: w.a.x * GRID, y1: w.a.y * GRID, x2: w.b.x * GRID, y2: w.b.y * GRID, class: cls, 'data-wire': w.id });
      g.append(line);
      const hit = el('line', { x1: w.a.x * GRID, y1: w.a.y * GRID, x2: w.b.x * GRID, y2: w.b.y * GRID, class: 'ce-wire-hit', 'data-wire': w.id });
      g.append(hit);
    }
    // Junction dots where 3+ wire ends / pins meet, and bus values
    for (const net of nl.nets) {
      const count = new Map<string, number>();
      for (const w of this.circ.wires) {
        if (nl.wireNet.get(w.id) !== net) continue;
        for (const p of [w.a, w.b]) count.set(`${p.x},${p.y}`, (count.get(`${p.x},${p.y}`) ?? 0) + 1);
      }
      for (const [k, n] of count) {
        if (n < 3) continue;
        const [x, y] = k.split(',').map(Number);
        g.append(el('circle', { cx: x * GRID, cy: y * GRID, r: 3.5, class: `ce-junction ${this.wireClass(net, conflict)}` }));
      }
      if (this.sim && net.width > 1) {
        const ws = this.circ.wires.filter((w) => nl.wireNet.get(w.id) === net);
        const longest = ws.sort((a, b) => len(b) - len(a))[0];
        if (longest) {
          const tx = el('text', { x: ((longest.a.x + longest.b.x) / 2) * GRID, y: ((longest.a.y + longest.b.y) / 2) * GRID - 5, class: 'ce-bus-value' });
          tx.textContent = `0x${this.sim.netValue(net).toString(16)}`;
          g.append(tx);
        }
      }
    }
    // Components
    for (const c of this.circ.components) {
      const cls = [bad.has(c.id) ? 'ce-bad' : warn.has(c.id) ? 'ce-warn' : '', this.selected?.kind === 'comp' && this.selected.id === c.id ? 'ce-sel' : ''];
      g.append(this.drawComp(c, cls.filter(Boolean).join(' ')));
    }
    // Wire preview / placing ghost
    if (this.drag?.kind === 'wire' && (this.drag.from.x !== this.drag.to.x || this.drag.from.y !== this.drag.to.y)) {
      for (const [a, b] of lPath(this.drag.from, this.drag.to)) {
        g.append(el('line', { x1: a.x * GRID, y1: a.y * GRID, x2: b.x * GRID, y2: b.y * GRID, class: 'ce-wire ce-preview' }));
      }
    }
    if (this.placing && this.mode === 'edit') {
      g.append(this.drawComp({ ...this.placing, x: this.hover.x, y: this.hover.y }, 'ce-ghost'));
    }
    this.layer.replaceChildren(g);
    this.applyView();
    this.renderProps();
    this.renderProblems();
  }

  private wireClass(net: Net, conflict: Set<number | undefined>): string {
    if (conflict.has(net.id)) return 'ce-v-err';
    if (!this.sim) return net.width > 1 ? 'ce-bus' : '';
    if (net.width > 1) return 'ce-bus ce-v-bus';
    if (!net.driver) return 'ce-v-float';
    return this.sim.netValue(net) ? 'ce-v-1' : 'ce-v-0';
  }

  private drawComp(c: Comp, extra: string): SVGGElement {
    const def = compDef(c, this.subs);
    const grp = document.createElementNS(NS, 'g');
    grp.setAttribute('class', `ce-comp ce-t-${c.type} ${extra}`);
    grp.setAttribute('data-comp', c.id);
    grp.setAttribute('transform', `translate(${c.x * GRID} ${c.y * GRID}) rotate(${c.rot})`);
    const W = def.w * GRID, H = def.h * GRID;
    const body = (attrs: Record<string, string | number>) => grp.append(el('rect', { class: 'ce-body', ...attrs }));
    const label = (x: number, y: number, s: string, cls = 'ce-text') => {
      const tx = el('text', { x, y, class: cls });
      tx.textContent = s;
      grp.append(tx);
    };
    const simVal = (pin: string) => (this.sim ? this.sim.pinValue(c, pin) : null);
    switch (c.type) {
      case 'in': case 'out': case 'const': {
        body({ x: 0, y: 0, width: W, height: H });
        const v = c.type === 'in' ? (this.sim ? this.sim.inputValue(c) : c.props.value ?? 0) : c.type === 'const' ? c.props.value ?? 0 : simVal('in');
        const bits = bitsOf(c);
        const txt = v === null ? (c.type === 'in' ? 'IN' : 'OUT') : bits === 1 ? String(v & 1) : `0x${(v >>> 0).toString(16)}`;
        const on = this.sim && bits === 1 && v === 1;
        if (on) grp.classList.add('ce-on');
        label(W / 2, H / 2 + 4, txt, 'ce-text ce-value');
        if (c.props.label) label(c.type === 'out' ? W + 6 : -6, -6, c.props.label, `ce-label ${c.type === 'out' ? 'ce-left' : 'ce-right'}`);
        break;
      }
      case 'clock': {
        body({ x: 0, y: 0, width: W, height: H });
        grp.append(el('path', { d: `M8 28 H14 V12 H22 V28 H28`, class: 'ce-glyph' }));
        if (this.sim?.inputValue(c)) grp.classList.add('ce-on');
        if (c.props.label) label(-6, -6, c.props.label, 'ce-label ce-right');
        break;
      }
      case 'led': {
        const on = simVal('in') === 1;
        grp.append(el('circle', { cx: GRID, cy: GRID, r: GRID * 0.8, class: `ce-led ${on ? 'ce-led-on' : ''}` }));
        if (c.props.label) label(GRID, -6, c.props.label, 'ce-label');
        break;
      }
      case 'mux':
        grp.append(el('path', { d: `M0 0 L${W} ${GRID * 0.8} L${W} ${H - GRID * 0.8} L0 ${H + GRID * 0.4} Z`, class: 'ce-body' }));
        label(W / 2 - 4, H / 2 + 4, 'MUX', 'ce-text ce-small');
        break;
      case 'split': case 'merge':
        grp.append(el('rect', { x: c.type === 'split' ? -2 : W - 2, y: -6, width: 4, height: H + 12, class: 'ce-bar' }));
        break;
      default: {
        body({ x: 0, y: -GRID / 2, width: W, height: H + GRID });
        label(W / 2, 14 - GRID / 2 + 4, SYMBOL[c.type] ?? (c.type === 'sub' ? c.props.circuit ?? '?' : c.type), 'ce-text');
        if (['dff', 'register', 'counter', 'adder', 'sub'].includes(c.type)) {
          for (const p of def.pins) {
            const isIn = p.dir === 'in';
            if (p.dy >= def.h + 1) continue;
            label(isIn ? p.dx * GRID + 5 : p.dx * GRID - 5, p.dy * GRID + 4, p.name === 'c' ? '>' : p.name, `ce-pin-name ${isIn ? 'ce-right' : 'ce-left'}`);
          }
        }
        if (c.props.label && c.type !== 'sub') label(W / 2, H + GRID / 2 + 14, c.props.label, 'ce-label');
      }
    }
    // inverted outputs get a bubble
    const inverted = c.type === 'not' || c.type === 'nand' || c.type === 'nor' || c.type === 'xnor';
    for (const p of def.pins) {
      const x = p.dx * GRID, y = p.dy * GRID;
      if (inverted && p.dir === 'out') grp.append(el('circle', { cx: x - 5, cy: y, r: 4, class: 'ce-bubble' }));
      const stub = p.dir === 'in' ? { x1: x, x2: x + 4 } : { x1: x - (inverted ? 9 : 4), x2: x };
      grp.append(el('line', { ...stub, y1: y, y2: y, class: 'ce-stub' }));
      grp.append(el('circle', { cx: x, cy: y, r: 3, class: `ce-pin ${p.bits > 1 ? 'ce-pin-bus' : ''}`, 'data-pin': p.name }));
    }
    return grp;
  }

  private renderProblems(): void {
    const nl = this.netlist!;
    const msgs = nl.problems.map((p) => ({ text: p.message, warn: p.kind === 'floating' || p.kind === 'undriven' }));
    if (this.sim?.oscillating) msgs.unshift({ text: t('ce.oscillating'), warn: false });
    this.problemsEl.hidden = msgs.length === 0;
    this.problemsEl.replaceChildren(...msgs.slice(0, 8).map((m) => {
      const d = div(m.warn ? 'ce-problem ce-problem-warn' : 'ce-problem');
      d.textContent = m.text;
      return d;
    }));
  }
}

// ── helpers ──
function div(cls: string): HTMLElement {
  const d = document.createElement('div');
  d.className = cls;
  return d;
}

function button(key: Key | '', onClick: () => void, cls: string, text?: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = cls;
  if (key) {
    b.dataset.i18n = key;
    b.textContent = t(key);
  } else b.textContent = text ?? '';
  b.onclick = onClick;
  return b;
}

function el(tag: string, attrs: Record<string, string | number>): SVGElement {
  const n = document.createElementNS(NS, tag) as SVGElement;
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}

function len(w: Wire): number {
  return Math.abs(w.a.x - w.b.x) + Math.abs(w.a.y - w.b.y);
}

/** Orthogonal L-shaped path: horizontal first, then vertical. */
export function lPath(a: Pt, b: Pt): [Pt, Pt][] {
  if (a.x === b.x || a.y === b.y) return [[a, b]];
  const corner = { x: b.x, y: a.y };
  return [[a, corner], [corner, b]];
}


