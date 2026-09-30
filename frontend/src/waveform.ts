// Canvas waveform viewer for VCD results: time ruler, 1-bit traces, buses
// with values, zoom (wheel / buttons), pan (drag / horizontal wheel), a
// cursor showing every value, per-signal radix, and a signal picker.
// Signal names from the VCD are user-controlled: DOM text via textContent,
// canvas text via fillText — never innerHTML.

import { iconButton } from './icons';
import { t } from './i18n';
import { changeIndexAt, formatTime, formatValue, valueAt, type Radix, type Vcd, type VcdSignal } from './vcd';

const ROW = 28;
const RULER = 26;
const MAX_DEFAULT = 40;

interface Colors {
  bg: string; grid: string; text: string; muted: string; hi: string; bus: string; busFill: string; x: string; z: string; cursor: string;
}

export class WaveformViewer {
  private vcd: Vcd | null = null;
  private shown: VcdSignal[] = [];
  private radix = new Map<string, Radix>();
  private t0 = 0;
  private scale = 1; // px per time unit
  private cursor: number | null = null;

  private titleEl: HTMLElement;
  private rangeEl: HTMLElement;
  private cursorEl: HTMLElement;
  private picker: HTMLElement;
  private filter: HTMLInputElement;
  private pickList: HTMLElement;
  private names: HTMLElement;
  private wrap: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  constructor(private host: HTMLElement) {
    host.replaceChildren();
    host.classList.add('wv');
    const bar = el('div', 'wv-toolbar');
    this.titleEl = el('span', 'wv-title');
    this.rangeEl = el('span', 'wv-range');
    this.cursorEl = el('span', 'wv-cursor-label');
    const add = iconButton('listPlus', 'wv.signals', 'btn-ghost', () => this.togglePicker(), true);
    add.id = 'wv-signals';
    const zin = iconButton('zoomIn', 'wv.zoomIn', 'btn-ghost', () => this.zoom(2));
    const zout = iconButton('zoomOut', 'wv.zoomOut', 'btn-ghost', () => this.zoom(0.5));
    const fit = iconButton('fit', 'wv.fit', 'btn-ghost', () => this.fit());
    bar.append(this.titleEl, this.rangeEl, this.cursorEl, add, zout, zin, fit);

    this.picker = el('div', 'wv-picker');
    this.picker.hidden = true;
    this.filter = document.createElement('input');
    this.filter.placeholder = t('wv.filter');
    this.filter.oninput = () => this.renderPicker();
    this.pickList = el('div', 'wv-picklist');
    this.picker.append(this.filter, this.pickList);

    const main = el('div', 'wv-main');
    this.names = el('div', 'wv-names');
    this.wrap = el('div', 'wv-canvas-wrap');
    this.canvas = document.createElement('canvas');
    this.wrap.append(this.canvas);
    main.append(this.names, this.wrap);
    host.append(bar, this.picker, main);
    this.ctx = this.canvas.getContext('2d')!;

    new ResizeObserver(() => this.draw()).observe(this.wrap);
    window.addEventListener('resize', () => this.draw()); // also fired on theme changes
    this.bindInput();
  }

  load(vcd: Vcd, title: string): void {
    this.vcd = vcd;
    const top = vcd.signals.filter((s) => s.scope.length <= 1 && s.kind !== 'parameter');
    this.shown = (top.length ? top : vcd.signals).slice(0, MAX_DEFAULT);
    this.cursor = null;
    this.titleEl.textContent = title;
    this.rangeEl.textContent = `0 – ${formatTime(vcd.endTime, vcd.timescaleSeconds)}`;
    this.picker.hidden = true;
    this.renderNames();
    requestAnimationFrame(() => this.fit());
  }

  // ── Interaction ──
  private bindInput(): void {
    this.canvas.addEventListener('wheel', (e) => {
      if (!this.vcd) return;
      e.preventDefault();
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) {
        this.t0 += (e.shiftKey ? e.deltaY : e.deltaX) / this.scale;
      } else {
        this.zoom(e.deltaY < 0 ? 1.25 : 0.8, e.offsetX);
        return;
      }
      this.clamp();
      this.draw();
    }, { passive: false });

    let downX: number | null = null;
    let downT0 = 0;
    this.canvas.addEventListener('pointerdown', (e) => {
      downX = e.clientX;
      downT0 = this.t0;
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (downX === null) return;
      this.t0 = downT0 - (e.clientX - downX) / this.scale;
      this.clamp();
      this.draw();
    });
    this.canvas.addEventListener('pointerup', (e) => {
      if (downX !== null && Math.abs(e.clientX - downX) < 4) {
        this.cursor = Math.max(0, this.t0 + e.offsetX / this.scale);
        this.renderValues();
        this.draw();
      }
      downX = null;
    });
  }

  private zoom(factor: number, atX?: number): void {
    if (!this.vcd) return;
    const w = this.wrap.clientWidth;
    const x = atX ?? (this.cursor !== null ? (this.cursor - this.t0) * this.scale : w / 2);
    const tAt = this.t0 + x / this.scale;
    const minScale = w / Math.max(1, this.vcd.endTime) / 2;
    this.scale = Math.min(Math.max(this.scale * factor, minScale), 400);
    this.t0 = tAt - x / this.scale;
    this.clamp();
    this.draw();
  }

  private fit(): void {
    if (!this.vcd) return;
    this.t0 = 0;
    this.scale = Math.max(1e-9, (this.wrap.clientWidth - 8) / Math.max(1, this.vcd.endTime));
    this.draw();
  }

  private clamp(): void {
    if (!this.vcd) return;
    const span = this.wrap.clientWidth / this.scale;
    this.t0 = Math.min(Math.max(this.t0, -span * 0.05), Math.max(0, this.vcd.endTime - span * 0.95));
  }

  // ── Signal list ──
  private togglePicker(): void {
    this.picker.hidden = !this.picker.hidden;
    if (!this.picker.hidden) {
      this.renderPicker();
      this.filter.focus();
    }
  }

  private renderPicker(): void {
    if (!this.vcd) return;
    const q = this.filter.value.trim().toLowerCase();
    const shown = new Set(this.shown);
    const rows = this.vcd.signals
      .filter((s) => !q || s.key.toLowerCase().includes(q))
      .slice(0, 400)
      .map((s) => {
        const row = document.createElement('label');
        row.className = 'wv-pick';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = shown.has(s);
        cb.onchange = () => {
          if (cb.checked) this.shown.push(s);
          else this.shown = this.shown.filter((x) => x !== s);
          this.renderNames();
          this.draw();
        };
        const name = el('span');
        name.textContent = s.key;
        const w = el('span', 'wv-pick-width');
        w.textContent = s.kind === 'real' ? 'real' : `${s.width}b`;
        row.append(cb, name, w);
        return row;
      });
    this.pickList.replaceChildren(...rows);
  }

  private renderNames(): void {
    const spacer = el('div', 'wv-names-head');
    spacer.style.height = `${RULER}px`;
    const rows = this.shown.map((s) => {
      const row = el('div', 'wv-name');
      row.style.height = `${ROW}px`;
      const label = el('span', 'wv-name-label');
      label.textContent = s.scope.length > 1 ? `${s.scope.slice(1).join('.')}.${s.name}` : s.name;
      label.title = s.key;
      const val = el('span', 'wv-name-value');
      val.dataset.key = s.key;
      row.append(label, val);
      if (s.width > 1 && s.kind !== 'real') {
        const sel = document.createElement('select');
        for (const r of ['hex', 'dec', 'sdec', 'bin'] as Radix[]) sel.append(new Option(r, r));
        sel.value = this.radix.get(s.key) ?? 'hex';
        sel.onchange = () => {
          this.radix.set(s.key, sel.value as Radix);
          this.renderValues();
          this.draw();
        };
        row.append(sel);
      }
      const rm = document.createElement('button');
      rm.className = 'wv-remove';
      rm.textContent = '×';
      rm.title = t('wv.remove');
      rm.onclick = () => {
        this.shown = this.shown.filter((x) => x !== s);
        this.renderNames();
        this.draw();
        if (!this.picker.hidden) this.renderPicker();
      };
      row.append(rm);
      return row;
    });
    this.names.replaceChildren(spacer, ...rows);
    this.renderValues();
  }

  private renderValues(): void {
    if (!this.vcd) return;
    this.cursorEl.textContent = this.cursor === null ? t('wv.clickHint') : `⌖ ${formatTime(this.cursor, this.vcd.timescaleSeconds)}`;
    const byKey = new Map(this.shown.map((s) => [s.key, s]));
    this.names.querySelectorAll<HTMLElement>('.wv-name-value').forEach((v) => {
      const s = byKey.get(v.dataset.key!);
      v.textContent = s && this.cursor !== null ? formatValue(valueAt(s, this.cursor), this.radix.get(s.key) ?? 'hex', s.kind) : '';
    });
  }

  // ── Drawing ──
  private colors(): Colors {
    const cs = getComputedStyle(this.host);
    const v = (n: string, d: string) => cs.getPropertyValue(n).trim() || d;
    return {
      bg: v('--hf-surface-dim', '#070E1D'), grid: v('--hf-outline-variant', '#333'), text: v('--hf-text', '#eee'),
      muted: v('--hf-text-muted', '#888'), hi: v('--hf-primary', '#69F6B8'), bus: v('--hf-tertiary', '#77E6FF'),
      busFill: 'rgba(119, 230, 255, 0.10)', x: v('--hf-error', '#FF716C'), z: v('--syn-number', '#F7C66B'), cursor: v('--syn-number', '#F7C66B'),
    };
  }

  private draw(): void {
    const w = this.wrap.clientWidth;
    const h = RULER + this.shown.length * ROW + 4;
    const dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.canvas.style.width = `${w}px`;
      this.canvas.style.height = `${h}px`;
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const c = this.colors();
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, w, h);
    if (!this.vcd || w === 0) return;
    ctx.font = '11px "JetBrains Mono", ui-monospace, monospace';
    ctx.textBaseline = 'middle';

    // Ruler with "nice" steps (1/2/5 × 10^k) at least ~90 px apart.
    const span = w / this.scale;
    const raw = 90 / this.scale;
    const p10 = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 5, 10].map((m) => m * p10).find((s) => s >= raw) ?? raw;
    const first = Math.ceil(this.t0 / step) * step;
    ctx.fillStyle = c.muted;
    ctx.strokeStyle = c.grid;
    ctx.lineWidth = 1;
    for (let tt = first; tt <= this.t0 + span; tt += step) {
      const x = Math.round((tt - this.t0) * this.scale) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, RULER - 6);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.fillText(formatTime(tt, this.vcd.timescaleSeconds), x + 4, RULER / 2);
    }

    this.shown.forEach((s, row) => this.drawSignal(s, RULER + row * ROW, w, c));

    if (this.cursor !== null) {
      const x = Math.round((this.cursor - this.t0) * this.scale) + 0.5;
      ctx.strokeStyle = c.cursor;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
  }

  private drawSignal(s: VcdSignal, top: number, w: number, c: Colors): void {
    const ctx = this.ctx;
    const ch = s.changes;
    const y0 = top + 5;
    const y1 = top + ROW - 5;
    const tEnd = this.t0 + w / this.scale;
    const end = this.vcd!.endTime;
    let i = Math.max(0, changeIndexAt(ch, this.t0));
    const xOf = (tt: number) => (tt - this.t0) * this.scale;
    const bus = s.width > 1 || s.kind === 'real';
    const radix = this.radix.get(s.key) ?? 'hex';
    let denseFrom: number | null = null;

    const flushDense = (x: number) => {
      if (denseFrom === null) return;
      ctx.fillStyle = bus ? c.bus : c.hi;
      ctx.globalAlpha = 0.35;
      ctx.fillRect(denseFrom, y0, Math.max(1, x - denseFrom), y1 - y0);
      ctx.globalAlpha = 1;
      denseFrom = null;
    };

    for (; i < ch.t.length && ch.t[i] <= tEnd; i++) {
      const tA = Math.max(ch.t[i], this.t0);
      const tB = i + 1 < ch.t.length ? ch.t[i + 1] : end;
      if (tB < this.t0) continue;
      const xa = Math.max(0, xOf(tA));
      const xb = Math.min(w, xOf(Math.max(tB, tA)));
      const val = ch.v[i];
      if (xb - xa < 1.5 && i + 1 < ch.t.length) {
        if (denseFrom === null) denseFrom = xa;
        continue;
      }
      flushDense(xa);
      const isX = /x/.test(val) && s.kind !== 'real';
      const isZ = /^z+$/.test(val);
      ctx.lineWidth = 1.5;
      if (!bus) {
        if (isX) {
          ctx.fillStyle = c.x;
          ctx.globalAlpha = 0.35;
          ctx.fillRect(xa, y0, xb - xa, y1 - y0);
          ctx.globalAlpha = 1;
          continue;
        }
        const y = isZ ? (y0 + y1) / 2 : val === '1' ? y0 : y1;
        ctx.strokeStyle = isZ ? c.z : c.hi;
        ctx.beginPath();
        if (i > 0 && ch.t[i] >= this.t0) {
          ctx.moveTo(xa, y0);
          ctx.lineTo(xa, y1);
        }
        ctx.moveTo(xa, y);
        ctx.lineTo(xb, y);
        ctx.stroke();
      } else {
        const slant = Math.min(3, (xb - xa) / 2);
        const mid = (y0 + y1) / 2;
        ctx.beginPath();
        ctx.moveTo(xa, mid);
        ctx.lineTo(xa + slant, y0);
        ctx.lineTo(xb - slant, y0);
        ctx.lineTo(xb, mid);
        ctx.lineTo(xb - slant, y1);
        ctx.lineTo(xa + slant, y1);
        ctx.closePath();
        ctx.fillStyle = isX ? 'rgba(255,113,108,0.25)' : c.busFill;
        ctx.fill();
        ctx.strokeStyle = isX ? c.x : isZ ? c.z : c.bus;
        ctx.stroke();
        const text = formatValue(val, radix, s.kind);
        const room = xb - xa - 2 * slant - 6;
        if (room > 8) {
          ctx.fillStyle = c.text;
          let shown = text;
          while (shown.length > 1 && ctx.measureText(shown).width > room) shown = shown.slice(0, -2) + '…';
          if (ctx.measureText(shown).width <= room) ctx.fillText(shown, xa + slant + 3, mid);
        }
      }
    }
    flushDense(Math.min(w, xOf(Math.min(end, tEnd))));
  }
}

function el(tag: string, cls = ''): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
}
