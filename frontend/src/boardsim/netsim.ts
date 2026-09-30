// Cycle-based simulator for Yosys gate-level JSON (simple gates + $_DFF_P_/$_DFF_N_).
// The combinational logic is compiled to one straight-line JS function over a
// Uint8Array of net values; flip-flops update on edges of whatever net clocks
// them, so derived clocks (e.g. `always @(posedge slow_clk)`) work too.

type Bit = number | string;

interface YosysCell {
  type: string;
  connections: Record<string, Bit[]>;
}

interface YosysModule {
  ports: Record<string, { direction: 'input' | 'output' | 'inout'; bits: Bit[]; offset?: number; upto?: number }>;
  cells: Record<string, YosysCell>;
}

export interface Port {
  name: string;
  direction: 'input' | 'output' | 'inout';
  nets: number[]; // LSB first
  offset: number;
}

const GATES: Record<string, (a: string, b: string, s: string) => string> = {
  $_BUF_: (a) => a,
  $_NOT_: (a) => `${a}^1`,
  $_AND_: (a, b) => `${a}&${b}`,
  $_OR_: (a, b) => `${a}|${b}`,
  $_XOR_: (a, b) => `${a}^${b}`,
  $_NAND_: (a, b) => `(${a}&${b})^1`,
  $_NOR_: (a, b) => `(${a}|${b})^1`,
  $_XNOR_: (a, b) => `${a}^${b}^1`,
  $_ANDNOT_: (a, b) => `${a}&(${b}^1)`,
  $_ORNOT_: (a, b) => `${a}|(${b}^1)`,
  $_MUX_: (a, b, s) => `${s}?${b}:${a}`,
};

export class NetlistError extends Error {}

export class NetSim {
  readonly ports = new Map<string, Port>();
  readonly v: Uint8Array;
  readonly gateCount: number;
  readonly ffCount: number;
  private comb: (v: Uint8Array) => void;
  private ffD: Int32Array;
  private ffQ: Int32Array;
  private clockNets: Int32Array;
  private pos: Int32Array[]; // per clock net (same order as clockNets): FFs on the rising edge
  private neg: Int32Array[]; // … and on the falling edge
  private prev: Uint8Array; // previous level per net (only clock nets are used)
  private sample: Uint8Array; // sampled D values per FF
  private hit: Int32Array; // FFs triggered in the current round

  constructor(json: { modules: Record<string, YosysModule> }, top?: string) {
    const names = Object.keys(json.modules ?? {});
    const modName = top && json.modules[top] ? top : names[0];
    const mod = json.modules?.[modName];
    if (!mod) throw new NetlistError('netlist has no modules');

    // Net numbering: constants map to fixed slots 0 ("0") and 1 ("1"); x/z read as 0.
    let maxNet = 1;
    const net = (b: Bit): number => (typeof b === 'number' ? b : b === '1' ? 1 : 0);
    const seen = (bits: Bit[]) => bits.forEach((b) => { if (typeof b === 'number' && b > maxNet) maxNet = b; });
    for (const p of Object.values(mod.ports)) seen(p.bits);
    for (const c of Object.values(mod.cells)) Object.values(c.connections).forEach(seen);
    this.v = new Uint8Array(maxNet + 1);
    this.v[1] = 1;
    this.prev = new Uint8Array(maxNet + 1);

    for (const [name, p] of Object.entries(mod.ports)) {
      this.ports.set(name, { name, direction: p.direction, nets: p.bits.map(net), offset: p.offset ?? 0 });
    }

    // Split cells into combinational gates and flip-flops.
    const gates: { y: number; ins: number[]; expr: string }[] = [];
    const ffs: { c: number; d: number; q: number; neg: boolean }[] = [];
    for (const [name, c] of Object.entries(mod.cells)) {
      const k = c.connections;
      if (c.type === '$_DFF_P_' || c.type === '$_DFF_N_') {
        ffs.push({ c: net(k.C[0]), d: net(k.D[0]), q: net(k.Q[0]), neg: c.type === '$_DFF_N_' });
        continue;
      }
      const gen = GATES[c.type];
      if (!gen) throw new NetlistError(`unsupported cell ${c.type} (${name}) — latches and vendor primitives cannot run on the virtual board`);
      const a = k.A ? net(k.A[0]) : 0, b = k.B ? net(k.B[0]) : 0, s = k.S ? net(k.S[0]) : 0;
      const ins = [a, ...(k.B ? [b] : []), ...(k.S ? [s] : [])];
      gates.push({ y: net(k.Y[0]), ins, expr: gen(`v[${a}]`, `v[${b}]`, `v[${s}]`) });
    }
    this.gateCount = gates.length;
    this.ffCount = ffs.length;

    // Topological order (Kahn): a gate is ready once all gate-driven inputs are computed.
    const driver = new Map<number, number>();
    gates.forEach((g, i) => driver.set(g.y, i));
    const indeg = new Int32Array(gates.length);
    const users = new Map<number, number[]>();
    gates.forEach((g, i) => {
      for (const n of g.ins) {
        const d = driver.get(n);
        if (d === undefined) continue;
        indeg[i]++;
        if (!users.has(d)) users.set(d, []);
        users.get(d)!.push(i);
      }
    });
    const order: number[] = [];
    const queue: number[] = [];
    indeg.forEach((d, i) => { if (d === 0) queue.push(i); });
    while (queue.length) {
      const i = queue.pop()!;
      order.push(i);
      for (const u of users.get(i) ?? []) if (--indeg[u] === 0) queue.push(u);
    }
    if (order.length !== gates.length) throw new NetlistError('the design has a combinational loop');
    const body = order.map((i) => `v[${gates[i].y}]=${gates[i].expr};`).join('\n');
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    this.comb = new Function('v', body) as (v: Uint8Array) => void; // generated from numbers only

    this.ffD = Int32Array.from(ffs.map((f) => f.d));
    this.ffQ = Int32Array.from(ffs.map((f) => f.q));
    const clocks = [...new Set(ffs.map((f) => f.c))];
    this.clockNets = Int32Array.from(clocks);
    this.pos = clocks.map((c) => Int32Array.from(ffs.flatMap((f, i) => (f.c === c && !f.neg ? [i] : []))));
    this.neg = clocks.map((c) => Int32Array.from(ffs.flatMap((f, i) => (f.c === c && f.neg ? [i] : []))));
    this.sample = new Uint8Array(ffs.length);
    this.hit = new Int32Array(ffs.length);
    this.settle();
  }

  /** Net for bit `index` of a port (index in the Verilog range, e.g. led[3] → 3). */
  netOf(port: string, index = 0): number | null {
    const p = this.ports.get(port);
    if (!p) return null;
    const i = index - p.offset;
    return i >= 0 && i < p.nets.length ? p.nets[i] : null;
  }

  set(netId: number, value: number): void {
    if (netId > 1) this.v[netId] = value ? 1 : 0;
  }

  get(netId: number): number {
    return this.v[netId];
  }

  reset(): void {
    this.v.fill(0);
    this.v[1] = 1;
    this.prev.fill(0);
    this.settle();
  }

  /** Evaluate logic and propagate flip-flop edges until stable. */
  settle(): void {
    const v = this.v, prev = this.prev, clocks = this.clockNets, hit = this.hit, sample = this.sample;
    const ffD = this.ffD, ffQ = this.ffQ;
    this.comb(v);
    for (let round = 0; round < 32; round++) {
      let n = 0;
      for (let k = 0; k < clocks.length; k++) {
        const c = clocks[k], now = v[c];
        if (now === prev[c]) continue;
        prev[c] = now;
        const list = now ? this.pos[k] : this.neg[k];
        for (let j = 0; j < list.length; j++) hit[n++] = list[j];
      }
      if (n === 0) return;
      for (let j = 0; j < n; j++) sample[j] = v[ffD[hit[j]]]; // sample all D first …
      for (let j = 0; j < n; j++) v[ffQ[hit[j]]] = sample[j]; // … then update all Q together
      this.comb(v);
    }
  }

  /** One full period of the clock net: high then low. */
  cycle(clockNet: number): void {
    this.v[clockNet] = 1;
    this.settle();
    this.v[clockNet] = 0;
    this.settle();
  }
}
