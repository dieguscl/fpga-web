// Visual pin planner for the Digilent Basys 3: click a board resource, pick a
// top-module port bit from a dropdown, and the .xdc is regenerated.
// All user-derived text (port names, file contents) goes through textContent
// or option.text — never innerHTML.

import { setIconButton } from './icons';
import { BASYS3_PINS, type PinDef } from './boards/basys3-pins';
import { applyStatic, onLangChange, t, type Key } from './i18n';
import { expandBits, type PortBit, type PortScan } from './verilog-ports';
import { generateXdc, parseXdc, type XdcModel } from './xdc';

const SVG_NS = 'http://www.w3.org/2000/svg';
type Dir = 'in' | 'out' | 'io';

interface Group {
  id: string;
  title: string; // English title (tests / fallback); the UI shows t(`pp.g.${id}`)
  signals: string[];
}

// Digilent names Pmod pins JA[0..7] (silkscreen JA1-4, JA7-10) and JXADC[0..7] (XA1_P..XA4_N).
const PMOD_ORDER = ['1', '2', '3', '4', '7', '8', '9', '10'];
const XADC_NAMES = ['XA1_P', 'XA2_P', 'XA3_P', 'XA4_P', 'XA1_N', 'XA2_N', 'XA3_N', 'XA4_N'];
const pmodSignals = (h: string) => range(8).map((i) => `${h}[${i}]`);
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

export const BASYS3_GROUPS: Group[] = [
  { id: 'clk', title: 'Clock · 100 MHz', signals: ['clk'] },
  { id: 'sw', title: 'Switches', signals: range(16).map((i) => `sw[${i}]`) },
  { id: 'led', title: 'LEDs', signals: range(16).map((i) => `led[${i}]`) },
  { id: 'btn', title: 'Buttons', signals: ['btnC', 'btnU', 'btnL', 'btnR', 'btnD'] },
  { id: 'seg', title: '7-segment display', signals: [...range(7).map((i) => `seg[${i}]`), 'dp', ...range(4).map((i) => `an[${i}]`)] },
  { id: 'ja', title: 'Pmod JA', signals: pmodSignals('JA') },
  { id: 'jb', title: 'Pmod JB', signals: pmodSignals('JB') },
  { id: 'jc', title: 'Pmod JC', signals: pmodSignals('JC') },
  { id: 'jxadc', title: 'Pmod JXADC', signals: pmodSignals('JXADC') },
  { id: 'vga', title: 'VGA', signals: [...['vgaRed', 'vgaGreen', 'vgaBlue'].flatMap((c) => range(4).map((i) => `${c}[${i}]`)), 'Hsync', 'Vsync'] },
  { id: 'uart', title: 'USB-UART', signals: ['RsRx', 'RsTx'] },
  { id: 'ps2', title: 'USB HID (PS/2)', signals: ['PS2Clk', 'PS2Data'] },
];

const SEG_NAMES = ['CA', 'CB', 'CC', 'CD', 'CE', 'CF', 'CG'];

export function signalLabel(s: string): string {
  let m: RegExpExecArray | null;
  if ((m = /^sw\[(\d+)\]$/.exec(s))) return `SW${m[1]}`;
  if ((m = /^led\[(\d+)\]$/.exec(s))) return `LD${m[1]}`;
  if ((m = /^seg\[(\d+)\]$/.exec(s))) return SEG_NAMES[+m[1]];
  if ((m = /^an\[(\d+)\]$/.exec(s))) return `AN${m[1]}`;
  if ((m = /^vga(Red|Green|Blue)\[(\d+)\]$/.exec(s))) return `${m[1][0]}${m[2]}`;
  if ((m = /^JXADC\[(\d+)\]$/.exec(s))) return XADC_NAMES[+m[1]];
  if ((m = /^J([ABC])\[(\d+)\]$/.exec(s))) return `J${m[1]}${PMOD_ORDER[+m[2]]}`;
  const fixed: Record<string, string> = {
    clk: 'CLK', dp: 'DP', btnC: 'BTNC', btnU: 'BTNU', btnL: 'BTNL', btnR: 'BTNR', btnD: 'BTND',
    Hsync: 'HS', Vsync: 'VS', RsRx: 'RX', RsTx: 'TX', PS2Clk: 'PS2 CLK', PS2Data: 'PS2 DATA',
  };
  return fixed[s] ?? s;
}

function signalDir(s: string): Dir {
  if (/^(clk|sw\[|btn|RsRx)/.test(s)) return 'in';
  if (/^(led\[|seg\[|dp$|an\[|vga|Hsync|Vsync|RsTx)/.test(s)) return 'out';
  return 'io';
}

function dirMatches(sig: Dir, port: PortBit['dir']): boolean {
  if (sig === 'io' || port === 'inout') return true;
  return (sig === 'in') === (port === 'input');
}

// ── Auto-assign by name ─────────────────────────────────────────────────────
const ALIASES: Record<string, string[]> = {
  clk: ['clk', 'clock', 'sysclk', 'sys_clk', 'clk100', 'clk100mhz', 'clk_100mhz', 'clk_i'],
  sw: ['sw', 'sws', 'switch', 'switches', 'sw_i'],
  led: ['led', 'leds', 'led_o'],
  seg: ['seg', 'segs', 'segment', 'segments', 'seg_o'],
  an: ['an', 'anode', 'anodes', 'an_o'],
  dp: ['dp', 'dot'],
  vgaRed: ['vgared', 'vga_r', 'red', 'r'],
  vgaGreen: ['vgagreen', 'vga_g', 'green', 'g'],
  vgaBlue: ['vgablue', 'vga_b', 'blue', 'b'],
  Hsync: ['hsync', 'hs', 'vga_hs', 'vga_hsync', 'h_sync'],
  Vsync: ['vsync', 'vs', 'vga_vs', 'vga_vsync', 'v_sync'],
  RsRx: ['rsrx', 'rx', 'uart_rx', 'uart_rxd', 'rxd'],
  RsTx: ['rstx', 'tx', 'uart_tx', 'uart_txd', 'txd'],
  btnC: ['btnc', 'btn_c', 'center', 'reset', 'rst'],
  btnU: ['btnu', 'btn_u', 'up'],
  btnL: ['btnl', 'btn_l', 'left'],
  btnR: ['btnr', 'btn_r', 'right'],
  btnD: ['btnd', 'btn_d', 'down'],
  PS2Clk: ['ps2clk', 'ps2_clk'],
  PS2Data: ['ps2data', 'ps2_data'],
};

/** Map board signals to port bits by conventional names (e.g. `leds[3]` → LD3). */
export function autoAssign(bits: PortBit[], current: Map<string, string>): Map<string, string> {
  const next = new Map(current);
  const used = new Set(next.values());
  const byLower = new Map(bits.map((b) => [b.bit.toLowerCase(), b.bit]));
  const tryBit = (signal: string, candidate: string) => {
    if (next.has(signal)) return true;
    const bit = byLower.get(candidate.toLowerCase());
    if (!bit || used.has(bit)) return false;
    next.set(signal, bit);
    used.add(bit);
    return true;
  };
  for (const def of BASYS3_PINS) {
    const s = def.signal;
    const vec = /^(\w+)\[(\d+)\]$/.exec(s);
    const base = vec ? vec[1] : s;
    const names = ALIASES[base] ?? [base];
    for (const n of names) if (tryBit(s, vec ? `${n}[${vec[2]}]` : n)) break;
    // Pmods: a port named ja/jb/jc/jxadc[7:0] maps bit i to JA[i] (JA1-4, JA7-10) via the
    // generic `${base}[i]` match above (case-insensitive).
  }
  return next;
}

// ── Planner widget ──────────────────────────────────────────────────────────
export class PinPlanner {
  private model: XdcModel = { assign: new Map(), manual: [] };
  private bits: PortBit[] = [];
  private warnings: string[] = [];
  private top = '';
  private selectedGroup = 'led';
  private svg: SVGSVGElement;
  private side: HTMLElement;
  private summary: HTMLElement;
  private readonly board: PinDef[] = BASYS3_PINS;
  private readonly pinOf = new Map(BASYS3_PINS.map((p) => [p.signal, p.pin]));

  constructor(private host: HTMLElement, private onChange: (xdc: string) => void) {
    host.replaceChildren();
    const toolbar = document.createElement('div');
    toolbar.className = 'pp-toolbar';
    const title = document.createElement('span');
    title.className = 'pp-title';
    title.dataset.i18n = 'pp.title';
    this.summary = document.createElement('span');
    this.summary.className = 'pp-summary';
    const auto = document.createElement('button');
    auto.className = 'btn-ghost';
    auto.id = 'pp-auto';
    auto.dataset.i18n = 'pp.auto';
    auto.onclick = () => {
      this.model.assign = autoAssign(this.bits, this.model.assign);
      this.commit();
    };
    const clear = document.createElement('button');
    clear.className = 'btn-ghost';
    clear.dataset.i18n = 'pp.clear';
    setIconButton(auto, 'wand', 'pp.auto', true);
    setIconButton(clear, 'eraser', 'pp.clear', true);
    clear.onclick = () => {
      if (this.model.assign.size && !confirm(t('pp.clearConfirm'))) return;
      this.model.assign = new Map();
      this.commit();
    };
    toolbar.append(title, this.summary, auto, clear);

    const body = document.createElement('div');
    body.className = 'pp-body';
    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.setAttribute('viewBox', '0 0 1000 640');
    this.svg.setAttribute('class', 'pp-board');
    this.svg.setAttribute('role', 'img');
    this.svg.dataset.i18nAria = 'pp.boardAria';
    this.svg.addEventListener('click', (e) => {
      const t = (e.target as Element).closest('[data-group]');
      if (!t) return;
      this.selectedGroup = t.getAttribute('data-group')!;
      this.renderSide(t.getAttribute('data-signal'));
      this.paint();
    });
    this.side = document.createElement('div');
    this.side.className = 'pp-side';
    body.append(this.svg, this.side);
    host.append(toolbar, body);
    this.drawBoard();
    this.relabel();
    onLangChange(() => this.relabel());
  }

  /** Apply the current language to the static parts of the widget. */
  private relabel(): void {
    applyStatic(this.host);
    this.svg.setAttribute('aria-label', t('pp.boardAria'));
  }

  /** Load the .xdc text and the top module's ports. */
  open(xdcText: string, scan: PortScan, top: string): void {
    this.model = parseXdc(xdcText, this.board);
    this.bits = expandBits(scan.ports);
    this.warnings = scan.warnings;
    this.top = top;
    this.renderSide(null);
    this.paint();
  }

  private commit(): void {
    this.onChange(generateXdc(this.model, this.board));
    this.renderSide(null);
    this.paint();
  }

  private assign(signal: string, bit: string): void {
    for (const [s, b] of this.model.assign) if (b === bit && s !== signal) this.model.assign.delete(s);
    if (bit) this.model.assign.set(signal, bit);
    else this.model.assign.delete(signal);
    this.commit();
  }

  // ── Drawing ──
  private node<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent: Element = this.svg): SVGElementTagNameMap[K] {
    const n = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    parent.append(n);
    return n;
  }

  private text(x: number, y: number, s: string, cls = 'pp-label', anchor = 'middle'): SVGTextElement {
    const t = this.node('text', { x, y, class: cls, 'text-anchor': anchor });
    t.textContent = s;
    return t;
  }

  private hit(group: string, signal: string | null, el: SVGElement): SVGElement {
    el.setAttribute('data-group', group);
    if (signal) {
      el.setAttribute('data-signal', signal);
      el.classList.add('pp-pin');
      this.node('title', {}, el).textContent = signalLabel(signal);
    }
    return el;
  }

  private drawBoard(): void {
    this.node('path', { d: 'M0 0 H968 L1000 32 V640 H0 Z', class: 'pp-pcb' });
    this.text(110, 50, 'BASYS 3', 'pp-board-name', 'start');
    this.text(110, 70, t('pp.hint'), 'pp-hint', 'start').dataset.i18n = 'pp.hint';

    // FPGA + oscillator
    this.node('rect', { x: 470, y: 110, width: 150, height: 150, class: 'pp-chip' });
    this.text(545, 180, 'XC7A35T', 'pp-chip-label');
    this.text(545, 198, 'CPG236', 'pp-hint');
    const osc = this.hit('clk', 'clk', this.node('rect', { x: 650, y: 130, width: 74, height: 40, class: 'pp-part' }));
    void osc;
    this.text(687, 155, '100 MHz', 'pp-part-label');

    // 7-segment display: digits left→right are AN3..AN0.
    for (let d = 0; d < 4; d++) {
      const an = 3 - d;
      const dx = 110 + d * 80;
      this.node('rect', { x: dx - 6, y: 92, width: 76, height: 128, class: 'pp-digit' });
      const segs: [number, number, number, number][] = [
        [dx + 10, 100, 40, 8], [dx + 50, 108, 8, 42], [dx + 50, 158, 8, 42],
        [dx + 10, 200, 40, 8], [dx + 2, 158, 8, 42], [dx + 2, 108, 8, 42], [dx + 10, 150, 40, 8],
      ];
      segs.forEach(([x, y, w, h], i) => this.hit('seg', `seg[${i}]`, this.node('rect', { x, y, width: w, height: h })));
      this.hit('seg', 'dp', this.node('circle', { cx: dx + 62, cy: 206, r: 4 }));
      this.hit('seg', `an[${an}]`, this.node('rect', { x: dx + 8, y: 228, width: 44, height: 18, class: 'pp-tag' }));
      this.text(dx + 30, 241, `AN${an}`, 'pp-tag-label');
    }

    // Buttons (cross)
    const bx = 805, by = 230, off = 62;
    const btns: [string, number, number][] = [['btnU', bx, by - off], ['btnL', bx - off, by], ['btnC', bx, by], ['btnR', bx + off, by], ['btnD', bx, by + off]];
    for (const [s, x, y] of btns) {
      this.hit('btn', s, this.node('circle', { cx: x, cy: y, r: 22 }));
      this.text(x, y + 38, signalLabel(s), 'pp-label');
    }

    // Blocks: USB-UART, PS/2, VGA
    const block = (group: string, x: number, y: number, w: number, label: string, sub: string) => {
      this.hit(group, null, this.node('rect', { x, y, width: w, height: 54, class: 'pp-block' }));
      this.text(x + w / 2, y + 25, label, 'pp-part-label');
      this.text(x + w / 2, y + 42, sub, 'pp-hint');
    };
    block('uart', 110, 300, 130, 'USB-UART', 'RX · TX');
    block('ps2', 260, 300, 150, 'USB HID', 'PS/2 CLK · DATA');
    block('vga', 470, 300, 150, 'VGA', 'RGB 4:4:4 · HS · VS');

    // LEDs and switches: index 15 on the left, 0 on the right (as on the board).
    for (let i = 0; i < 16; i++) {
      const x = 110 + (15 - i) * 52;
      this.hit('led', `led[${i}]`, this.node('rect', { x, y: 430, width: 22, height: 12 }));
      this.text(x + 11, 462, `LD${i}`, 'pp-label');
      this.hit('sw', `sw[${i}]`, this.node('rect', { x, y: 482, width: 22, height: 46 }));
      this.text(x + 11, 548, `SW${i}`, 'pp-label');
    }

    // Pmod headers: two columns of 6 (pins 1-4 / 7-10, then GND, VCC).
    const pmod = (group: string, x: number, y: number, label: string, names: string[]) => {
      this.text(x + 26, y - 10, label, 'pp-part-label');
      for (let r = 0; r < 6; r++) {
        for (let c = 0; c < 2; c++) {
          const px = x + c * 28, py = y + r * 26;
          if (r < 4) {
            const signal = names[c * 4 + r];
            this.hit(group, signal, this.node('rect', { x: px, y: py, width: 22, height: 22 }));
          } else {
            this.node('rect', { x: px, y: py, width: 22, height: 22, class: r === 4 ? 'pp-gnd' : 'pp-vcc' });
          }
        }
      }
    };
    pmod('jxadc', 24, 110, 'JXADC', pmodSignals('JXADC'));
    pmod('jc', 24, 300, 'JC', pmodSignals('JC'));
    pmod('ja', 924, 110, 'JA', pmodSignals('JA'));
    pmod('jb', 924, 300, 'JB', pmodSignals('JB'));
  }

  /** Update colours/tooltips of every clickable element from the model. */
  private paint(): void {
    this.svg.querySelectorAll<SVGElement>('[data-group]').forEach((el) => {
      const g = el.getAttribute('data-group')!;
      const s = el.getAttribute('data-signal');
      el.classList.toggle('pp-selected-group', g === this.selectedGroup);
      if (s) {
        const port = this.model.assign.get(s);
        el.classList.toggle('pp-assigned', !!port);
        const title = el.querySelector('title');
        if (title) title.textContent = `${signalLabel(s)} (${this.pinOf.get(s)})${port ? ` → ${port}` : ''}`;
      } else {
        const group = BASYS3_GROUPS.find((x) => x.id === g)!;
        el.classList.toggle('pp-assigned', group.signals.some((sig) => this.model.assign.has(sig)));
      }
    });
    const assignedBits = new Set(this.model.assign.values());
    const missing = this.bits.filter((b) => !assignedBits.has(b.bit));
    this.summary.textContent = this.bits.length
      ? t('pp.summary', { top: this.top, placed: this.bits.length - missing.length, total: this.bits.length })
      : t('pp.noPorts', { top: this.top });
    this.summary.classList.toggle('pp-warn', missing.length > 0 || this.warnings.length > 0);
  }

  private renderSide(focusSignal: string | null): void {
    const group = BASYS3_GROUPS.find((g) => g.id === this.selectedGroup)!;
    const frag: Node[] = [];
    const h = document.createElement('div');
    h.className = 'label';
    h.textContent = t(`pp.g.${group.id}` as Key);
    frag.push(h);

    const used = new Map<string, string>();
    for (const [s, b] of this.model.assign) used.set(b, s);

    const list = document.createElement('div');
    list.className = 'pp-rows';
    for (const signal of group.signals) {
      const row = document.createElement('label');
      row.className = 'pp-row';
      if (signal === focusSignal) row.classList.add('pp-focus');
      const name = document.createElement('span');
      name.className = 'pp-row-name';
      name.textContent = signalLabel(signal);
      const pin = document.createElement('span');
      pin.className = 'pp-row-pin';
      pin.textContent = this.pinOf.get(signal) ?? '';
      const sel = document.createElement('select');
      sel.setAttribute('data-signal', signal);
      sel.setAttribute('aria-label', t('pp.portFor', { sig: signalLabel(signal) }));
      sel.append(new Option(t('pp.notUsed'), ''));
      const dir = signalDir(signal);
      const current = this.model.assign.get(signal) ?? '';
      const fits = document.createElement('optgroup');
      fits.label = t(dir === 'in' ? 'pp.inputs' : dir === 'out' ? 'pp.outputs' : 'pp.ports');
      const others = document.createElement('optgroup');
      others.label = t('pp.otherPorts');
      for (const b of this.bits) {
        const owner = used.get(b.bit);
        const suffix = owner && owner !== signal ? `  ${t('pp.onOther', { sig: signalLabel(owner) })}` : '';
        const opt = new Option(`${b.bit}${suffix}`, b.bit, false, b.bit === current);
        (dirMatches(dir, b.dir) ? fits : others).append(opt);
      }
      if (current && !this.bits.some((b) => b.bit === current)) {
        fits.append(new Option(`${current}  ${t('pp.notPort', { top: this.top })}`, current, false, true));
      }
      if (fits.children.length) sel.append(fits);
      if (others.children.length) sel.append(others);
      sel.value = current;
      sel.onchange = () => this.assign(signal, sel.value);
      row.append(name, pin, sel);
      list.append(row);
    }
    frag.push(list);

    const assignedBits = new Set(this.model.assign.values());
    const missing = this.bits.filter((b) => !assignedBits.has(b.bit));
    const notes = [...this.warnings];
    if (missing.length) notes.push(t('pp.notPlaced', { list: `${missing.slice(0, 12).map((b) => b.bit).join(', ')}${missing.length > 12 ? ` … (+${missing.length - 12})` : ''}` }));
    for (const n of notes) {
      const p = document.createElement('p');
      p.className = 'pp-note';
      p.textContent = n;
      frag.push(p);
    }
    this.side.replaceChildren(...frag);
    if (focusSignal) this.side.querySelector<HTMLSelectElement>(`select[data-signal="${CSS.escape(focusSignal)}"]`)?.focus();
  }
}
