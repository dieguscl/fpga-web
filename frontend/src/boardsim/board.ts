// Interactive virtual Basys 3: switches and buttons drive the design, LEDs and the
// 4-digit 7-segment display show its outputs. Wiring comes from the project's
// .xdc (the same file the pin planner edits), so it behaves like the real board.
import { iconButton, setIconButton } from '../icons';
import { BASYS3_PINS } from '../boards/basys3-pins';
import { applyStatic, t, type Key } from '../i18n';
import { parseXdc } from '../xdc';
import type { FromWorker, ToWorker, Watch } from './worker';

const NS = 'http://www.w3.org/2000/svg';
const BUTTONS = ['btnU', 'btnL', 'btnC', 'btnR', 'btnD'] as const;
const SPEEDUPS = [1, 10, 100, 1000];

interface NetlistJson {
  modules: Record<string, { ports: Record<string, { bits: (number | string)[]; offset?: number }> }>;
}

/** Net id for a port bit like "leds[3]" or "clk", or -1. */
export function portBitNet(json: NetlistJson, top: string, portBit: string): number {
  const mod = json.modules[top] ?? Object.values(json.modules)[0];
  const m = /^([A-Za-z_][\w$]*)(?:\[(\d+)\])?$/.exec(portBit.trim());
  const port = m && mod?.ports[m[1]];
  if (!port) return -1;
  const i = (m[2] ? Number(m[2]) : 0) - (port.offset ?? 0);
  const b = port.bits[i];
  return typeof b === 'number' ? b : -1;
}

/** Resolve every board signal the .xdc assigns to a net of the netlist. */
export function boardNets(json: NetlistJson, top: string, xdc: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const [signal, portBit] of parseXdc(xdc, BASYS3_PINS).assign) {
    const n = portBitNet(json, top, portBit);
    if (n >= 0) out.set(signal, n);
  }
  // No clock constraint? fall back to a port literally called clk.
  if (!out.has('clk')) {
    const n = portBitNet(json, top, 'clk');
    if (n >= 0) out.set('clk', n);
  }
  return out;
}

export interface BoardCallbacks {
  /** Ask the app to (re)build the netlist; resolves with {netlist, top, xdc} or throws. */
  load(speedup: number): Promise<{ netlist: NetlistJson; top: string; xdc: string }>;
}

export class VirtualBoard {
  private worker: Worker | null = null;
  private nets = new Map<string, number>();
  private switches = new Array(16).fill(0);
  private running = false;
  private svg: SVGSVGElement;
  private status: HTMLElement;
  private runBtn: HTMLButtonElement;
  private loadBtn: HTMLButtonElement;
  private speed: HTMLSelectElement;
  private ledEls: SVGElement[] = [];
  private swEls: SVGGElement[] = [];
  private segEls: SVGElement[][] = []; // [digit][segment 0..7]
  private statusKey: Key = 'vb.notLoaded';
  private statusVars: Record<string, string | number> = {};

  constructor(private host: HTMLElement, private cb: BoardCallbacks) {
    host.replaceChildren();
    host.classList.add('vb');
    const bar = document.createElement('div');
    bar.className = 'vb-toolbar';
    this.loadBtn = iconButton('cpu', 'vb.load', 'btn-primary', () => void this.load(), true);
    this.runBtn = iconButton('play', 'vb.run', 'btn-tertiary', () => this.toggleRun(), true);
    this.runBtn.disabled = true;
    const reset = iconButton('reset', 'ce.reset', 'btn-ghost', () => this.reset());
    const speedLabel = document.createElement('label');
    speedLabel.className = 'vb-speed';
    const sl = document.createElement('span');
    sl.dataset.i18n = 'vb.speedup';
    sl.textContent = t('vb.speedup');
    this.speed = document.createElement('select');
    for (const f of SPEEDUPS) this.speed.append(new Option(f === 1 ? t('vb.speedOff') : `×${f}`, String(f)));
    this.speed.title = t('vb.speedupHelp');
    speedLabel.append(sl, this.speed);
    this.status = document.createElement('span');
    this.status.className = 'vb-status';
    bar.append(this.loadBtn, this.runBtn, reset, speedLabel, this.status);
    this.svg = document.createElementNS(NS, 'svg');
    this.svg.setAttribute('viewBox', '0 0 1000 600');
    this.svg.classList.add('vb-board');
    host.append(bar, this.svg);
    this.draw();
    this.setStatus('vb.notLoaded');
  }

  relabel(): void {
    applyStatic(this.host);
    this.speed.options[0].text = t('vb.speedOff');
    this.speed.title = t('vb.speedupHelp');
    this.setStatus(this.statusKey, this.statusVars);
  }

  stop(): void {
    this.post({ type: 'pause' });
    this.running = false;
    setIconButton(this.runBtn, 'play', 'vb.run', true);
  }

  private setStatus(key: Key, vars: Record<string, string | number> = {}): void {
    this.statusKey = key;
    this.statusVars = vars;
    this.status.textContent = t(key, vars);
  }

  private post(m: ToWorker): void {
    this.worker?.postMessage(m);
  }

  async load(): Promise<void> {
    this.stop();
    this.loadBtn.disabled = true;
    this.runBtn.disabled = true;
    this.setStatus('vb.building');
    try {
      const { netlist, top, xdc } = await this.cb.load(Number(this.speed.value));
      this.nets = boardNets(netlist, top, xdc);
      this.worker?.terminate();
      this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.onWorker(e.data);
      const watch: Watch = {
        clk: this.nets.get('clk') ?? -1,
        leds: Array.from({ length: 16 }, (_, i) => this.nets.get(`led[${i}]`) ?? -1),
        seg: [...Array.from({ length: 7 }, (_, i) => this.nets.get(`seg[${i}]`) ?? -1), this.nets.get('dp') ?? -1],
        an: Array.from({ length: 4 }, (_, i) => this.nets.get(`an[${i}]`) ?? -1),
      };
      this.post({ type: 'load', netlist, top, watch });
      this.paintMapping();
    } catch (e) {
      this.setStatus('vb.failed', { msg: (e as Error).message ?? String(e) });
    } finally {
      this.loadBtn.disabled = false;
    }
  }

  private onWorker(m: FromWorker): void {
    if (m.type === 'loaded') {
      this.runBtn.disabled = false;
      this.sendInputs();
      this.setStatus('vb.loaded', { gates: m.gates, ffs: m.ffs });
      this.toggleRun();
    } else if (m.type === 'error') {
      this.stop();
      this.setStatus('vb.failed', { msg: m.message });
    } else if (m.type === 'frame') {
      this.paintFrame(m.leds, m.digits);
      const mhz = m.rate / 1e6;
      this.setStatus(this.nets.has('clk') ? 'vb.rate' : 'vb.rateNoClk', {
        mhz: mhz >= 1 ? mhz.toFixed(2) : mhz.toFixed(3),
        slower: Math.max(1, Math.round(100e6 / Math.max(1, m.rate))),
      });
    }
  }

  private toggleRun(): void {
    if (!this.worker) return;
    if (this.running) return this.stop();
    this.running = true;
    this.post({ type: 'run' });
    setIconButton(this.runBtn, 'pause', 'vb.pause', true);
  }

  private reset(): void {
    this.post({ type: 'reset' });
    this.sendInputs();
  }

  private sendInputs(): void {
    this.switches.forEach((v, i) => this.setInput(`sw[${i}]`, v));
    for (const b of BUTTONS) this.setInput(b, 0);
  }

  private setInput(signal: string, value: number): void {
    const n = this.nets.get(signal);
    if (n !== undefined) this.post({ type: 'set', net: n, value });
  }

  // ── Drawing ──
  private el(tag: string, attrs: Record<string, string | number>, parent: Element = this.svg): SVGElement {
    const n = document.createElementNS(NS, tag) as SVGElement;
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    parent.append(n);
    return n;
  }

  private text(x: number, y: number, s: string, cls: string, parent: Element = this.svg): void {
    const n = this.el('text', { x, y, class: cls }, parent);
    n.textContent = s;
  }

  private draw(): void {
    this.el('path', { d: 'M0 0 H968 L1000 32 V600 H0 Z', class: 'vb-pcb' });
    this.text(60, 50, 'BASYS 3', 'vb-name');
    this.el('rect', { x: 470, y: 90, width: 140, height: 140, class: 'vb-chip' });
    this.text(540, 165, 'XC7A35T', 'vb-chip-label');
    // 7-segment display, digits left→right = AN3..AN0
    const segs: [number, number, number, number][] = [[10, 0, 40, 8], [50, 8, 8, 44], [50, 60, 8, 44], [10, 104, 40, 8], [2, 60, 8, 44], [2, 8, 8, 44], [10, 52, 40, 8]];
    for (let d = 0; d < 4; d++) {
      const an = 3 - d;
      const g = this.el('g', { transform: `translate(${80 + d * 86} 90)` });
      this.el('rect', { x: -8, y: -10, width: 84, height: 136, class: 'vb-digit' }, g);
      this.segEls[an] = [...segs.map(([x, y, w, h]) => this.el('rect', { x, y, width: w, height: h, class: 'vb-seg' }, g)),
        this.el('circle', { cx: 66, cy: 110, r: 5, class: 'vb-seg' }, g)];
    }
    // Buttons (hold to press)
    const bx = 800, by = 170, off = 60;
    const pos: Record<(typeof BUTTONS)[number], [number, number]> = { btnU: [bx, by - off], btnL: [bx - off, by], btnC: [bx, by], btnR: [bx + off, by], btnD: [bx, by + off] };
    for (const b of BUTTONS) {
      const [x, y] = pos[b];
      const g = this.el('g', { class: 'vb-btn', 'data-signal': b, transform: `translate(${x} ${y})` });
      this.el('circle', { cx: 0, cy: 0, r: 24, class: 'vb-btn-cap' }, g);
      this.text(0, 44, b.replace('btn', 'BTN'), 'vb-label', g);
      const press = (v: number) => (e: PointerEvent) => {
        e.preventDefault();
        g.classList.toggle('vb-pressed', v === 1);
        this.setInput(b, v);
      };
      g.addEventListener('pointerdown', (e) => {
        (g as Element).setPointerCapture(e.pointerId);
        press(1)(e);
      });
      g.addEventListener('pointerup', press(0));
      g.addEventListener('pointercancel', press(0));
    }
    // LEDs over switches, index 15 on the left
    for (let i = 0; i < 16; i++) {
      const x = 80 + (15 - i) * 52;
      this.ledEls[i] = this.el('rect', { x, y: 380, width: 24, height: 14, rx: 2, class: 'vb-led' });
      this.text(x + 12, 412, `LD${i}`, 'vb-label');
      const g = this.el('g', { class: 'vb-sw', 'data-signal': `sw[${i}]`, transform: `translate(${x} 440)` }) as SVGGElement;
      this.el('rect', { x: 0, y: 0, width: 24, height: 60, class: 'vb-sw-slot' }, g);
      this.el('rect', { x: 3, y: 33, width: 18, height: 24, class: 'vb-sw-knob' }, g);
      this.text(12, 80, `SW${i}`, 'vb-label', g);
      g.addEventListener('click', () => {
        this.switches[i] ^= 1;
        g.classList.toggle('vb-on', this.switches[i] === 1);
        this.setInput(`sw[${i}]`, this.switches[i]);
      });
      this.swEls[i] = g;
    }
  }

  /** Grey out board parts the .xdc does not connect to the design; tooltips show the wiring. */
  private paintMapping(): void {
    const mapped = (s: string) => this.nets.has(s);
    this.swEls.forEach((g, i) => g.classList.toggle('vb-unmapped', !mapped(`sw[${i}]`)));
    this.ledEls.forEach((l, i) => l.classList.toggle('vb-unmapped', !mapped(`led[${i}]`)));
    this.svg.querySelectorAll<SVGGElement>('.vb-btn').forEach((g) => g.classList.toggle('vb-unmapped', !mapped(g.dataset.signal!)));
  }

  private paintFrame(leds: number[], digits: number[][]): void {
    leds.forEach((f, i) => {
      this.ledEls[i].style.opacity = String(0.18 + 0.82 * Math.min(1, f));
      this.ledEls[i].classList.toggle('vb-lit', f > 0.02);
    });
    digits.forEach((row, d) => row.forEach((f, k) => {
      // multiplexed digits are lit ~1/4 of the time; scale so a fully driven digit looks fully on
      const b = Math.min(1, f * 4);
      const el = this.segEls[d][k];
      el.style.opacity = String(0.12 + 0.88 * b);
      el.classList.toggle('vb-lit', b > 0.05);
    }));
  }
}
