// Value Change Dump (IEEE 1364 §18) parser and helpers for the waveform viewer.

export interface Changes {
  t: number[]; // ascending times (in timescale units)
  v: string[]; // value at t[i]: binary string of `width` chars (0/1/x/z), or a real as text
}

export interface VcdSignal {
  key: string; // unique: scope path + name
  name: string; // e.g. "leds[15:0]" as declared (name + optional range)
  scope: string[];
  width: number;
  kind: string; // wire, reg, integer, parameter, real, ...
  changes: Changes; // shared between aliases of the same id code
}

export interface Vcd {
  timescale: string; // e.g. "1ns", "100 ns"
  timescaleSeconds: number; // seconds per time unit
  signals: VcdSignal[];
  endTime: number;
}

const UNIT: Record<string, number> = { s: 1, ms: 1e-3, us: 1e-6, ns: 1e-9, ps: 1e-12, fs: 1e-15 };

function extend(bits: string, width: number): string {
  if (bits.length >= width) return bits.slice(bits.length - width);
  const pad = bits[0] === 'x' || bits[0] === 'z' ? bits[0] : '0';
  return pad.repeat(width - bits.length) + bits;
}

export function parseVcd(text: string): Vcd {
  const tokens = text.split(/\s+/);
  const byId = new Map<string, { changes: Changes; width: number }>();
  const signals: VcdSignal[] = [];
  const scope: string[] = [];
  let timescale = '1ns';
  let now = 0;
  let endTime = 0;
  let i = 0;

  const until = (end = '$end'): string[] => {
    const out: string[] = [];
    while (i < tokens.length && tokens[i] !== end) out.push(tokens[i++]);
    i++; // skip $end
    return out;
  };

  const record = (id: string, value: string) => {
    const s = byId.get(id);
    if (!s) return;
    const c = s.changes;
    const last = c.t.length - 1;
    if (last >= 0 && c.t[last] === now) c.v[last] = value; // same timestep: last write wins
    else if (last < 0 || c.v[last] !== value) {
      c.t.push(now);
      c.v.push(value);
    }
  };

  while (i < tokens.length) {
    const tok = tokens[i++];
    if (!tok) continue;
    switch (tok) {
      case '$timescale':
        timescale = until().join('') || '1ns';
        continue;
      case '$scope': {
        const parts = until();
        scope.push(parts[1] ?? '?');
        continue;
      }
      case '$upscope':
        until();
        scope.pop();
        continue;
      case '$var': {
        const [kind, w, id, ...rest] = until();
        const width = Math.max(1, parseInt(w, 10) || 1);
        const name = rest.join('');
        let entry = byId.get(id);
        if (!entry) {
          entry = { changes: { t: [], v: [] }, width };
          byId.set(id, entry);
        }
        signals.push({ key: [...scope, name].join('.'), name, scope: [...scope], width, kind, changes: entry.changes });
        continue;
      }
      case '$comment':
      case '$date':
      case '$version':
        until();
        continue;
      case '$enddefinitions':
      case '$dumpvars':
      case '$dumpall':
      case '$dumpon':
      case '$dumpoff':
      case '$end':
        if (tok === '$enddefinitions') until();
        continue;
    }
    const c0 = tok[0];
    if (c0 === '#') {
      now = Number(tok.slice(1)) || 0;
      if (now > endTime) endTime = now;
    } else if (c0 === 'b' || c0 === 'B') {
      const id = tokens[i++];
      const e = byId.get(id);
      if (e) record(id, extend(tok.slice(1).toLowerCase(), e.width));
    } else if (c0 === 'r' || c0 === 'R') {
      record(tokens[i++], tok.slice(1));
    } else if ('01xXzZ'.includes(c0)) {
      const id = tok.slice(1);
      const e = byId.get(id);
      if (e) record(id, extend(c0.toLowerCase(), e.width));
    }
  }

  const m = /^(\d+)\s*([munpf]?s)$/.exec(timescale.trim());
  const timescaleSeconds = m ? Number(m[1]) * (UNIT[m[2]] ?? 1e-9) : 1e-9;
  return { timescale, timescaleSeconds, signals, endTime };
}

/** Index of the change in effect at `time` (last change with t <= time), or -1. */
export function changeIndexAt(c: Changes, time: number): number {
  let lo = 0;
  let hi = c.t.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (c.t[mid] <= time) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export function valueAt(sig: VcdSignal, time: number): string {
  const idx = changeIndexAt(sig.changes, time);
  return idx < 0 ? 'x'.repeat(sig.kind === 'real' ? 1 : sig.width) : sig.changes.v[idx];
}

export type Radix = 'hex' | 'bin' | 'dec' | 'sdec';

/** Format a binary value string for display. */
export function formatValue(bits: string, radix: Radix, kind = 'wire'): string {
  if (kind === 'real') return bits;
  if (/^[xz]+$/.test(bits)) return bits[0];
  if (/[xz]/.test(bits)) {
    if (radix === 'bin') return bits;
    if (radix === 'hex') {
      const padded = '0'.repeat((4 - (bits.length % 4)) % 4) + bits;
      let out = '';
      for (let k = 0; k < padded.length; k += 4) {
        const nib = padded.slice(k, k + 4);
        out += /x/.test(nib) ? 'x' : /z/.test(nib) ? 'z' : parseInt(nib, 2).toString(16);
      }
      return out;
    }
    return 'x';
  }
  if (radix === 'bin') return bits;
  const n = BigInt('0b' + bits);
  if (radix === 'hex') return n.toString(16).padStart(Math.ceil(bits.length / 4), '0');
  if (radix === 'sdec' && bits[0] === '1') return (n - (1n << BigInt(bits.length))).toString();
  return n.toString();
}

/** Human-readable time for a timestamp in timescale units, e.g. "1.25 µs". */
export function formatTime(t: number, secondsPerUnit: number): string {
  if (t === 0) return '0';
  const s = t * secondsPerUnit;
  const units: [number, string][] = [[1, 's'], [1e-3, 'ms'], [1e-6, 'µs'], [1e-9, 'ns'], [1e-12, 'ps'], [1e-15, 'fs']];
  for (const [scale, name] of units) {
    if (Math.abs(s) >= scale || scale === 1e-15) {
      const v = s / scale;
      return `${Number(v.toPrecision(4))} ${name}`;
    }
  }
  return `${t}`;
}

/**
 * One single-bit signal per bit of a bus, MSB first (as Vivado expands a bus).
 * Names use the declared range, e.g. "D[3:0]" → D[3], D[2], D[1], D[0].
 */
export function bitSignals(s: VcdSignal): VcdSignal[] {
  if (s.width <= 1 || s.kind === 'real') return [];
  const m = /^(.*)\[(-?\d+):(-?\d+)\]$/.exec(s.name);
  const base = m ? m[1] : s.name;
  const msb = m ? Number(m[2]) : s.width - 1;
  const lsb = m ? Number(m[3]) : 0;
  const step = msb >= lsb ? -1 : 1;
  return Array.from({ length: s.width }, (_, j) => {
    const idx = msb + step * j;
    const changes: Changes = { t: [], v: [] };
    s.changes.t.forEach((t, i) => {
      const ch = extend(s.changes.v[i], s.width)[j];
      if (changes.v.length && changes.v[changes.v.length - 1] === ch) return;
      changes.t.push(t);
      changes.v.push(ch);
    });
    return { key: `${s.key}#${idx}`, name: `${base}[${idx}]`, scope: s.scope, width: 1, kind: s.kind, changes };
  });
}
