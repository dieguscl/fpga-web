// Turn circuit geometry into nets: wires join at shared grid points and at
// T-junctions (a point lying on another wire's segment); pins join the wire
// points they sit on. Also reports width mismatches, shorts and floating inputs.
import { circuitInterface, placedPins, type Circuit, type PlacedPin, type Pt, type SubInterface } from './model';

export interface Net {
  id: number;
  pins: PlacedPin[];
  width: number;
  driver: PlacedPin | null;
  points: Pt[]; // all grid points belonging to the net (for drawing / hit tests)
}

export interface Problem {
  kind: 'width' | 'drivers' | 'floating' | 'undriven';
  message: string;
  compIds: string[];
  netId?: number;
}

export interface Netlist {
  nets: Net[];
  pinNet: Map<PlacedPin, Net>; // every placed pin → its net (unconnected pins get a singleton net)
  wireNet: Map<string, Net>; // wire id → net
  problems: Problem[];
  pins: PlacedPin[];
}

const key = (p: Pt) => `${p.x},${p.y}`;

function onSegment(p: Pt, a: Pt, b: Pt): boolean {
  if (a.x === b.x && p.x === a.x) return p.y > Math.min(a.y, b.y) && p.y < Math.max(a.y, b.y);
  if (a.y === b.y && p.y === a.y) return p.x > Math.min(a.x, b.x) && p.x < Math.max(a.x, b.x);
  return false;
}

export function buildNetlist(circ: Circuit, subs: Map<string, SubInterface> = new Map()): Netlist {
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = k;
    while (parent.get(c) !== r) {
      const n = parent.get(c)!;
      parent.set(c, r);
      c = n;
    }
    return r;
  };
  const add = (p: Pt) => {
    const k = key(p);
    if (!parent.has(k)) parent.set(k, k);
    return k;
  };
  const union = (a: string, b: string) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  const pins = circ.components.flatMap((c) => placedPins(c, subs));
  for (const w of circ.wires) union(add(w.a), add(w.b));
  for (const p of pins) add(p.at);

  // T-junctions: any known point lying strictly inside a wire segment joins it.
  const allPoints = [...parent.keys()].map((k) => {
    const [x, y] = k.split(',').map(Number);
    return { x, y };
  });
  for (const w of circ.wires) {
    for (const p of allPoints) if (onSegment(p, w.a, w.b)) union(key(p), key(w.a));
  }

  const groups = new Map<string, { pins: PlacedPin[]; points: Pt[] }>();
  for (const p of allPoints) {
    const r = find(key(p));
    if (!groups.has(r)) groups.set(r, { pins: [], points: [] });
    groups.get(r)!.points.push(p);
  }
  for (const p of pins) groups.get(find(key(p.at)))!.pins.push(p);

  const nets: Net[] = [];
  const pinNet = new Map<PlacedPin, Net>();
  const byRoot = new Map<string, Net>();
  const problems: Problem[] = [];
  let id = 0;
  for (const [root, g] of groups) {
    const drivers = g.pins.filter((p) => p.dir === 'out');
    const widths = new Set(g.pins.map((p) => p.bits));
    const net: Net = { id: id++, pins: g.pins, width: g.pins[0]?.bits ?? 1, driver: drivers[0] ?? null, points: g.points };
    nets.push(net);
    byRoot.set(root, net);
    for (const p of g.pins) pinNet.set(p, net);
    const ids = [...new Set(g.pins.map((p) => p.comp.id))];
    if (widths.size > 1) {
      problems.push({ kind: 'width', netId: net.id, compIds: ids,
        message: `connected pins have different widths (${[...widths].sort((a, b) => a - b).join(', ')} bits)` });
    }
    if (drivers.length > 1) {
      problems.push({ kind: 'drivers', netId: net.id, compIds: drivers.map((p) => p.comp.id),
        message: `${drivers.length} outputs drive the same wire` });
    }
    const inputs = g.pins.filter((p) => p.dir === 'in');
    if (!drivers.length && inputs.length) {
      problems.push({ kind: g.pins.length === inputs.length && g.points.length === 1 ? 'floating' : 'undriven', netId: net.id,
        compIds: inputs.map((p) => p.comp.id),
        message: `input ${inputs.map((p) => `${p.comp.props.label || p.comp.type}.${p.name}`).join(', ')} is not connected to any output` });
    }
  }
  const wireNet = new Map<string, Net>();
  for (const w of circ.wires) wireNet.set(w.id, byRoot.get(find(key(w.a)))!);
  return { nets, pinNet, wireNet, problems, pins };
}

export { circuitInterface };
