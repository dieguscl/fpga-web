// Circuit document model and component library (Digital-style schematic).
// Coordinates are in grid units (1 unit = GRID px on screen); pins sit on
// integer grid points so wires can connect to them.

export const GRID = 20;
export const MAX_BITS = 32;

export type Rot = 0 | 90 | 180 | 270;

export type CompType =
  | 'in' | 'out' | 'clock' | 'const' | 'led'
  | 'and' | 'or' | 'nand' | 'nor' | 'xor' | 'xnor' | 'not'
  | 'mux' | 'adder' | 'dff' | 'register' | 'counter'
  | 'split' | 'merge' | 'sub';

export interface CompProps {
  label?: string;
  bits?: number; // data width
  inputs?: number; // gate inputs (2..4)
  invert?: number[]; // gate input indexes that are negated (bubble on the input)
  value?: number; // const value / in initial value
  sel?: number; // mux select bits (1..2)
  parts?: string; // splitter/merger widths, low bits first, e.g. "4,4"
  circuit?: string; // sub-circuit name (without .circ)
}

export interface Comp {
  id: string;
  type: CompType;
  x: number;
  y: number;
  rot: Rot;
  props: CompProps;
}

export interface Pt {
  x: number;
  y: number;
}

export interface Wire {
  id: string;
  a: Pt;
  b: Pt; // straight segment between two grid points
}

export interface Circuit {
  version: 1;
  components: Comp[];
  wires: Wire[];
}

export interface PinDef {
  name: string;
  dir: 'in' | 'out';
  dx: number; // offset from component origin before rotation
  dy: number;
  bits: number;
}

export interface CompDef {
  type: CompType;
  w: number; // body size in grid units (before rotation), origin top-left
  h: number;
  pins: PinDef[];
}

/** Interface of another circuit, used for 'sub' components. */
export interface SubInterface {
  inputs: { name: string; bits: number }[];
  outputs: { name: string; bits: number }[];
}

export const GATES: CompType[] = ['and', 'or', 'nand', 'nor', 'xor', 'xnor'];

/** Whether gate input `i` is negated (Digital's "inverted inputs"). */
export function inputInverted(c: Comp, i: number): boolean {
  return GATES.includes(c.type) && !!c.props.invert?.includes(i);
}

export function emptyCircuit(): Circuit {
  return { version: 1, components: [], wires: [] };
}

export function bitsOf(c: Comp): number {
  return Math.min(MAX_BITS, Math.max(1, c.props.bits ?? 1));
}

export function parseParts(parts: string | undefined, fallback: number): number[] {
  const list = (parts ?? '').split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => n > 0 && n <= MAX_BITS);
  return list.length ? list : [fallback];
}

/** Pin layout for a component (unrotated, relative to its origin). */
export function compDef(c: Comp, subs: Map<string, SubInterface> = new Map()): CompDef {
  const b = bitsOf(c);
  switch (c.type) {
    case 'in':
    case 'clock':
    case 'const':
      return { type: c.type, w: 2, h: 2, pins: [{ name: 'out', dir: 'out', dx: 2, dy: 1, bits: c.type === 'clock' ? 1 : b }] };
    case 'out':
    case 'led':
      return { type: c.type, w: 2, h: 2, pins: [{ name: 'in', dir: 'in', dx: 0, dy: 1, bits: c.type === 'led' ? 1 : b }] };
    case 'not':
      return { type: c.type, w: 2, h: 2, pins: [{ name: 'a', dir: 'in', dx: 0, dy: 1, bits: b }, { name: 'y', dir: 'out', dx: 3, dy: 1, bits: b }] };
    case 'and': case 'or': case 'nand': case 'nor': case 'xor': case 'xnor': {
      const n = Math.min(4, Math.max(2, c.props.inputs ?? 2));
      // Inputs placed symmetrically around the output so gate symbols stay symmetric.
      const ys = n === 2 ? [0, 2] : n === 3 ? [0, 1, 2] : [0, 1, 3, 4];
      const outY = n === 4 ? 2 : 1;
      const ins: PinDef[] = ys.map((dy, i) => ({ name: `in${i}`, dir: 'in', dx: 0, dy, bits: b }));
      return { type: c.type, w: 3, h: ys[ys.length - 1], pins: [...ins, { name: 'y', dir: 'out', dx: 3, dy: outY, bits: b }] };
    }
    case 'mux': {
      const sel = Math.min(2, Math.max(1, c.props.sel ?? 1));
      const n = 1 << sel;
      const ins: PinDef[] = [];
      for (let i = 0; i < n; i++) ins.push({ name: `d${i}`, dir: 'in', dx: 0, dy: i + 1, bits: b });
      return { type: c.type, w: 2, h: n + 1, pins: [{ name: 'sel', dir: 'in', dx: 1, dy: n + 1, bits: sel }, ...ins, { name: 'y', dir: 'out', dx: 2, dy: Math.ceil((n + 1) / 2), bits: b }] };
    }
    case 'adder':
      return { type: c.type, w: 3, h: 4, pins: [
        { name: 'a', dir: 'in', dx: 0, dy: 1, bits: b }, { name: 'b', dir: 'in', dx: 0, dy: 2, bits: b },
        { name: 'ci', dir: 'in', dx: 0, dy: 3, bits: 1 },
        { name: 's', dir: 'out', dx: 3, dy: 1, bits: b }, { name: 'co', dir: 'out', dx: 3, dy: 3, bits: 1 },
      ] };
    case 'dff':
      return { type: c.type, w: 3, h: 3, pins: [
        { name: 'd', dir: 'in', dx: 0, dy: 1, bits: b }, { name: 'c', dir: 'in', dx: 0, dy: 2, bits: 1 },
        { name: 'q', dir: 'out', dx: 3, dy: 1, bits: b }, { name: 'nq', dir: 'out', dx: 3, dy: 2, bits: b },
      ] };
    case 'register':
      return { type: c.type, w: 3, h: 4, pins: [
        { name: 'd', dir: 'in', dx: 0, dy: 1, bits: b }, { name: 'c', dir: 'in', dx: 0, dy: 2, bits: 1 },
        { name: 'en', dir: 'in', dx: 0, dy: 3, bits: 1 }, { name: 'q', dir: 'out', dx: 3, dy: 1, bits: b },
      ] };
    case 'counter':
      return { type: c.type, w: 3, h: 4, pins: [
        { name: 'en', dir: 'in', dx: 0, dy: 1, bits: 1 }, { name: 'c', dir: 'in', dx: 0, dy: 2, bits: 1 },
        { name: 'clr', dir: 'in', dx: 0, dy: 3, bits: 1 },
        { name: 'q', dir: 'out', dx: 3, dy: 1, bits: b }, { name: 'ovf', dir: 'out', dx: 3, dy: 2, bits: 1 },
      ] };
    case 'split': {
      const parts = parseParts(c.props.parts, b);
      const total = parts.reduce((s, p) => s + p, 0);
      return { type: c.type, w: 1, h: Math.max(2, parts.length), pins: [
        { name: 'in', dir: 'in', dx: 0, dy: 0, bits: total },
        ...parts.map((p, i) => ({ name: `o${i}`, dir: 'out' as const, dx: 1, dy: i, bits: p })),
      ] };
    }
    case 'merge': {
      const parts = parseParts(c.props.parts, b);
      const total = parts.reduce((s, p) => s + p, 0);
      return { type: c.type, w: 1, h: Math.max(2, parts.length), pins: [
        ...parts.map((p, i) => ({ name: `i${i}`, dir: 'in' as const, dx: 0, dy: i, bits: p })),
        { name: 'out', dir: 'out', dx: 1, dy: 0, bits: total },
      ] };
    }
    case 'sub': {
      const iface = subs.get(c.props.circuit ?? '') ?? { inputs: [], outputs: [] };
      const rows = Math.max(iface.inputs.length, iface.outputs.length, 1);
      return { type: c.type, w: 4, h: rows + 1, pins: [
        ...iface.inputs.map((p, i) => ({ name: p.name, dir: 'in' as const, dx: 0, dy: i + 1, bits: p.bits })),
        ...iface.outputs.map((p, i) => ({ name: p.name, dir: 'out' as const, dx: 4, dy: i + 1, bits: p.bits })),
      ] };
    }
  }
}

/** Rotate an offset around the component origin (clockwise, in 90° steps). */
export function rotate(dx: number, dy: number, rot: Rot): Pt {
  switch (rot) {
    case 90: return { x: -dy, y: dx };
    case 180: return { x: -dx, y: -dy };
    case 270: return { x: dy, y: -dx };
    default: return { x: dx, y: dy };
  }
}

export interface PlacedPin extends PinDef {
  comp: Comp;
  at: Pt; // absolute grid position
}

export function placedPins(c: Comp, subs?: Map<string, SubInterface>): PlacedPin[] {
  return compDef(c, subs).pins.map((p) => {
    const r = rotate(p.dx, p.dy, c.rot);
    return { ...p, comp: c, at: { x: c.x + r.x, y: c.y + r.y } };
  });
}

/** Interface of a circuit (its In/Clock and Out/LED components, sorted top-to-bottom). */
export function circuitInterface(circ: Circuit): SubInterface {
  const byY = (a: Comp, b: Comp) => a.y - b.y || a.x - b.x;
  const ins = circ.components.filter((c) => c.type === 'in' || c.type === 'clock').sort(byY);
  const outs = circ.components.filter((c) => c.type === 'out').sort(byY);
  return {
    inputs: ins.map((c, i) => ({ name: portName(c, `in${i}`), bits: c.type === 'clock' ? 1 : bitsOf(c) })),
    outputs: outs.map((c, i) => ({ name: portName(c, `out${i}`), bits: bitsOf(c) })),
  };
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VERILOG_KEYWORDS = new Set(('always and assign begin buf case default else end endcase endmodule for function if initial ' +
  'inout input integer module nand negedge nor not or output parameter posedge reg wire xnor xor logic').split(' '));

/** Sanitised port/net identifier from a component label. */
export function portName(c: Comp, fallback: string): string {
  const raw = (c.props.label ?? '').trim().replace(/[^A-Za-z0-9_]/g, '_');
  if (!raw) return fallback;
  const name = /^[0-9]/.test(raw) ? `_${raw}` : raw;
  return IDENT.test(name) && !VERILOG_KEYWORDS.has(name) ? name : `${name}_`;
}

export function parseCircuit(text: string): Circuit {
  try {
    const d = JSON.parse(text);
    if (d && Array.isArray(d.components) && Array.isArray(d.wires)) return { version: 1, components: d.components, wires: d.wires };
  } catch {
    /* fall through */
  }
  return emptyCircuit();
}

export function serializeCircuit(c: Circuit): string {
  return JSON.stringify(c, null, 1) + '\n';
}
