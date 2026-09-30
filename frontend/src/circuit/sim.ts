// In-browser live simulation of a drawn circuit (Digital-style): click inputs,
// step or run the clock, watch every wire. Values are unsigned integers up to
// 32 bits; undriven inputs read as 0 (same as the generated Verilog).
import { bitsOf, circuitInterface, compDef, inputInverted, parseParts, type Circuit, type Comp, type PlacedPin, type SubInterface } from './model';
import { buildNetlist, type Net, type Netlist } from './netlist';

const MAX_DEPTH = 8;
const MAX_ITER = 200;

export const mask = (bits: number): number => (bits >= 32 ? 0xffffffff : (1 << bits) - 1) >>> 0;

export function subInterfaces(circuits: Map<string, Circuit>): Map<string, SubInterface> {
  return new Map([...circuits].map(([name, c]) => [name, circuitInterface(c)]));
}

export class CircuitSim {
  readonly netlist: Netlist;
  readonly values = new Map<Net, number>();
  oscillating = false;
  private state = new Map<string, number>(); // sequential component state
  private prevClk = new Map<string, number>(); // last seen clock level per sequential component
  private inputs = new Map<string, number>(); // in/clock component id → value
  private children = new Map<string, CircuitSim>();
  private pinsOf = new Map<Comp, Map<string, PlacedPin>>();
  private byY: Comp[];

  constructor(private circ: Circuit, private circuits: Map<string, Circuit> = new Map(), depth = 0) {
    const subs = subInterfaces(circuits);
    this.netlist = buildNetlist(circ, subs);
    for (const p of this.netlist.pins) {
      if (!this.pinsOf.has(p.comp)) this.pinsOf.set(p.comp, new Map());
      this.pinsOf.get(p.comp)!.set(p.name, p);
    }
    this.byY = [...circ.components].sort((a, b) => a.y - b.y || a.x - b.x);
    for (const c of circ.components) {
      if (c.type === 'in') this.inputs.set(c.id, (c.props.value ?? 0) & mask(bitsOf(c)));
      if (c.type === 'clock') this.inputs.set(c.id, 0);
      if (c.type === 'sub' && depth < MAX_DEPTH) {
        const child = circuits.get(c.props.circuit ?? '');
        if (child) this.children.set(c.id, new CircuitSim(child, circuits, depth + 1));
      }
    }
    this.settle();
  }

  // ── Public API ──
  inputValue(c: Comp): number {
    return this.inputs.get(c.id) ?? 0;
  }

  setInput(compId: string, value: number): void {
    const c = this.circ.components.find((x) => x.id === compId);
    if (!c) return;
    this.inputs.set(compId, (value >>> 0) & mask(c.type === 'clock' ? 1 : bitsOf(c)));
    this.settle();
  }

  toggle(compId: string): void {
    this.setInput(compId, this.inputs.get(compId) ? 0 : 1);
  }

  /** Half clock period: flip every clock input, then settle. */
  tick(): void {
    for (const c of this.circ.components) if (c.type === 'clock') this.inputs.set(c.id, this.inputs.get(c.id) ? 0 : 1);
    this.settle();
  }

  hasClock(): boolean {
    return this.circ.components.some((c) => c.type === 'clock');
  }

  netValue(net: Net | undefined): number {
    return net ? this.values.get(net) ?? 0 : 0;
  }

  pinValue(c: Comp, pin: string): number {
    const p = this.pinsOf.get(c)?.get(pin);
    return p ? this.netValue(this.netlist.pinNet.get(p)) : 0;
  }

  /** For sub-circuit use: drive this circuit's inputs by port order, read outputs. */
  setPorts(values: number[]): void {
    const ins = this.ports('in');
    ins.forEach((c, i) => this.inputs.set(c.id, (values[i] ?? 0) & mask(c.type === 'clock' ? 1 : bitsOf(c))));
    this.settle();
  }

  outputPorts(): number[] {
    return this.ports('out').map((c) => this.pinValue(c, 'in'));
  }

  // ── Engine ──
  private ports(kind: 'in' | 'out'): Comp[] {
    return this.byY.filter((c) => (kind === 'in' ? c.type === 'in' || c.type === 'clock' : c.type === 'out'));
  }

  private read(c: Comp, pin: string): number {
    return this.pinValue(c, pin);
  }

  private write(c: Comp, pin: string, v: number, changed: { v: boolean }): void {
    const p = this.pinsOf.get(c)?.get(pin);
    if (!p) return;
    const net = this.netlist.pinNet.get(p)!;
    if (net.driver !== p) return; // extra drivers are ignored (reported as a problem)
    const val = (v >>> 0) & mask(p.bits);
    if (this.values.get(net) !== val) {
      this.values.set(net, val);
      changed.v = true;
    }
  }

  private evalComb(changed: { v: boolean }): void {
    for (const c of this.byY) {
      const b = bitsOf(c);
      const m = mask(b);
      switch (c.type) {
        case 'in': case 'clock':
          this.write(c, 'out', this.inputs.get(c.id) ?? 0, changed);
          break;
        case 'const':
          this.write(c, 'out', c.props.value ?? 0, changed);
          break;
        case 'not':
          this.write(c, 'y', ~this.read(c, 'a') & m, changed);
          break;
        case 'and': case 'or': case 'xor': case 'nand': case 'nor': case 'xnor': {
          const ins = compDef(c).pins.filter((p) => p.dir === 'in').map((p, i) => (inputInverted(c, i) ? ~this.read(c, p.name) : this.read(c, p.name)) & m);
          let r = ins[0];
          for (const x of ins.slice(1)) r = c.type.includes('and') ? r & x : c.type.includes('xor') || c.type === 'xnor' ? r ^ x : r | x;
          if (c.type === 'nand' || c.type === 'nor' || c.type === 'xnor') r = ~r;
          this.write(c, 'y', r & m, changed);
          break;
        }
        case 'mux':
          this.write(c, 'y', this.read(c, `d${this.read(c, 'sel')}`), changed);
          break;
        case 'adder': {
          const sum = this.read(c, 'a') + this.read(c, 'b') + (this.read(c, 'ci') & 1);
          this.write(c, 's', sum, changed);
          this.write(c, 'co', b >= 32 ? Number(sum > 0xffffffff) : (sum >>> b) & 1, changed);
          break;
        }
        case 'dff': {
          const q = this.state.get(c.id) ?? 0;
          this.write(c, 'q', q, changed);
          this.write(c, 'nq', ~q & m, changed);
          break;
        }
        case 'register':
          this.write(c, 'q', this.state.get(c.id) ?? 0, changed);
          break;
        case 'counter': {
          const q = this.state.get(c.id) ?? 0;
          this.write(c, 'q', q, changed);
          this.write(c, 'ovf', this.read(c, 'en') & 1 && q === m ? 1 : 0, changed);
          break;
        }
        case 'split': {
          const v = this.read(c, 'in');
          let lo = 0;
          parseParts(c.props.parts, b).forEach((w, i) => {
            this.write(c, `o${i}`, lo >= 32 ? 0 : (v >>> lo) & mask(w), changed);
            lo += w;
          });
          break;
        }
        case 'merge': {
          let v = 0;
          let lo = 0;
          parseParts(c.props.parts, b).forEach((w, i) => {
            if (lo < 32) v |= (this.read(c, `i${i}`) & mask(w)) << lo;
            lo += w;
          });
          this.write(c, 'out', v >>> 0, changed);
          break;
        }
        case 'sub': {
          const child = this.children.get(c.id);
          if (!child) break;
          const iface = circuitInterface(this.circuits.get(c.props.circuit ?? '')!);
          child.setPorts(iface.inputs.map((p) => this.read(c, p.name)));
          child.outputPorts().forEach((v, i) => this.write(c, iface.outputs[i].name, v, changed));
          if (child.oscillating) this.oscillating = true;
          break;
        }
        default:
          break;
      }
    }
  }

  /** Rising edges: all sequential components sample their inputs, then update together. */
  private clockEdges(): boolean {
    const updates: [string, number][] = [];
    for (const c of this.byY) {
      if (c.type !== 'dff' && c.type !== 'register' && c.type !== 'counter') continue;
      const clk = this.read(c, 'c') & 1;
      const prev = this.prevClk.get(c.id) ?? clk;
      this.prevClk.set(c.id, clk);
      if (!(prev === 0 && clk === 1)) continue;
      const m = mask(bitsOf(c));
      const q = this.state.get(c.id) ?? 0;
      if (c.type === 'dff') updates.push([c.id, this.read(c, 'd')]);
      else if (c.type === 'register') { if (this.read(c, 'en') & 1) updates.push([c.id, this.read(c, 'd')]); }
      else if (this.read(c, 'clr') & 1) updates.push([c.id, 0]);
      else if (this.read(c, 'en') & 1) updates.push([c.id, (q + 1) & m]);
    }
    for (const [id, v] of updates) this.state.set(id, v >>> 0);
    return updates.length > 0;
  }

  private settle(): void {
    this.oscillating = false;
    for (let round = 0; round < MAX_ITER; round++) {
      let stable = false;
      for (let i = 0; i < MAX_ITER; i++) {
        const changed = { v: false };
        this.evalComb(changed);
        if (!changed.v) {
          stable = true;
          break;
        }
      }
      if (!stable) {
        this.oscillating = true;
        return;
      }
      if (!this.clockEdges()) return;
    }
    this.oscillating = true;
  }
}
