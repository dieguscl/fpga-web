// Web Worker: runs the virtual board off the main thread and reports what the
// eye would see (LED duty cycles, multiplexed 7-segment digits) ~30×/s.
import { NetSim, NetlistError } from './netsim';

export interface Watch {
  clk: number; // clock net (-1: none)
  leds: number[]; // 16 nets (-1 = unmapped)
  seg: number[]; // 8 nets: CA..CG, DP (active low)
  an: number[]; // 4 nets (active low)
}

export type ToWorker =
  | { type: 'load'; netlist: unknown; top: string; watch: Watch }
  | { type: 'set'; net: number; value: number }
  | { type: 'run' }
  | { type: 'pause' }
  | { type: 'reset' };

export type FromWorker =
  | { type: 'loaded'; gates: number; ffs: number }
  | { type: 'error'; message: string }
  | { type: 'frame'; leds: number[]; digits: number[][]; rate: number; cycles: number };

let sim: NetSim | null = null;
let watch: Watch | null = null;
let running = false;
let totalCycles = 0;
const FRAME_MS = 33;

const post = (m: FromWorker) => (self as unknown as Worker).postMessage(m);

function loop(): void {
  if (!running || !sim || !watch) return;
  const s = sim, w = watch;
  const start = performance.now();
  let cycles = 0, samples = 0;
  const ledOn = new Array(16).fill(0);
  const segOn = [0, 1, 2, 3].map(() => new Array(8).fill(0));
  let stride = 1;
  while (performance.now() - start < FRAME_MS - 5) {
    for (let i = 0; i < 256; i++) {
      if (w.clk >= 0) s.cycle(w.clk);
      else s.settle();
      cycles++;
      if (cycles % stride === 0) {
        samples++;
        for (let k = 0; k < 16; k++) if (w.leds[k] >= 0 && s.get(w.leds[k])) ledOn[k]++;
        for (let d = 0; d < 4; d++) {
          if (w.an[d] < 0 || s.get(w.an[d])) continue; // anode active low
          for (let k = 0; k < 8; k++) if (w.seg[k] >= 0 && !s.get(w.seg[k])) segOn[d][k]++;
        }
      }
    }
    stride = Math.max(1, Math.floor(cycles / 4000)); // ~4000 samples per frame is plenty
  }
  const dt = (performance.now() - start) / 1000;
  totalCycles += cycles;
  post({
    type: 'frame',
    leds: ledOn.map((n) => n / Math.max(1, samples)),
    digits: segOn.map((row) => row.map((n) => n / Math.max(1, samples))),
    rate: cycles / dt,
    cycles: totalCycles,
  });
  setTimeout(loop, 0);
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  try {
    if (m.type === 'load') {
      running = false;
      sim = new NetSim(m.netlist as never, m.top);
      watch = m.watch;
      totalCycles = 0;
      post({ type: 'loaded', gates: sim.gateCount, ffs: sim.ffCount });
    } else if (m.type === 'set' && sim) {
      sim.set(m.net, m.value);
      if (!running) sim.settle();
    } else if (m.type === 'run') {
      if (!running) {
        running = true;
        loop();
      }
    } else if (m.type === 'pause') running = false;
    else if (m.type === 'reset' && sim) {
      sim.reset();
      totalCycles = 0;
    }
  } catch (err) {
    running = false;
    post({ type: 'error', message: err instanceof NetlistError ? err.message : String(err) });
  }
};
