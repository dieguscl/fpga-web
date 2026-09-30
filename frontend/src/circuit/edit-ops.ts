// Pure editing operations: box selection and moving a selection with
// rubber-banding wires (Digital-style: wires attached to moved parts follow).
import { compDef, placedPins, rotate, type Circuit, type Comp, type Pt, type SubInterface, type Wire } from './model';

export interface Selection {
  comps: Set<string>;
  wires: Set<string>;
}

export const emptySelection = (): Selection => ({ comps: new Set(), wires: new Set() });

const key = (p: Pt) => `${p.x},${p.y}`;

/** Extent of a component in grid units: body corners and pins. */
export function compPoints(c: Comp, subs?: Map<string, SubInterface>): Pt[] {
  const d = compDef(c, subs);
  const corners = [[0, 0], [d.w, 0], [0, d.h], [d.w, d.h]].map(([x, y]) => {
    const r = rotate(x, y, c.rot);
    return { x: c.x + r.x, y: c.y + r.y };
  });
  return [...corners, ...placedPins(c, subs).map((p) => p.at)];
}

/** Everything fully inside the rectangle spanned by a and b (grid units, may be fractional). */
export function boxSelect(circ: Circuit, a: Pt, b: Pt, subs?: Map<string, SubInterface>): Selection {
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
  const inside = (p: Pt) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
  return {
    comps: new Set(circ.components.filter((c) => compPoints(c, subs).every(inside)).map((c) => c.id)),
    wires: new Set(circ.wires.filter((w) => inside(w.a) && inside(w.b)).map((w) => w.id)),
  };
}

/**
 * Move the selection by (dx, dy), computed from the original circuit so repeated
 * calls during a drag never accumulate. Wires whose ends sit on moved pins (or
 * on moved wires) follow: fully attached wires translate, half-attached ones
 * stretch, and a stretch that would turn diagonal becomes an L (keeping the
 * wire's original direction from its fixed end).
 */
export function moveSelection(orig: Circuit, sel: Selection, dx: number, dy: number, subs?: Map<string, SubInterface>): Circuit {
  const moving = new Set<string>();
  for (const c of orig.components) {
    if (sel.comps.has(c.id)) for (const p of placedPins(c, subs)) moving.add(key(p.at));
  }
  for (const w of orig.wires) {
    if (sel.wires.has(w.id)) {
      moving.add(key(w.a));
      moving.add(key(w.b));
    }
  }
  const shift = (p: Pt): Pt => ({ x: p.x + dx, y: p.y + dy });
  const components = orig.components.map((c) => (sel.comps.has(c.id) ? { ...c, x: c.x + dx, y: c.y + dy } : c));
  // Pin positions after the move: an L corner must not land on one (that would short it).
  const pinSpots = new Set(components.flatMap((c) => placedPins(c, subs).map((p) => key(p.at))));
  const ids = new Set(orig.wires.map((w) => w.id));
  const wires: Wire[] = [];
  for (const w of orig.wires) {
    const am = sel.wires.has(w.id) || moving.has(key(w.a));
    const bm = sel.wires.has(w.id) || moving.has(key(w.b));
    if (am && bm) wires.push({ ...w, a: shift(w.a), b: shift(w.b) });
    else if (!am && !bm) wires.push(w);
    else {
      const fixed = am ? w.b : w.a;
      const moved = shift(am ? w.a : w.b);
      if (fixed.x === moved.x && fixed.y === moved.y) continue; // collapsed to a point
      if (fixed.x === moved.x || fixed.y === moved.y) {
        wires.push(am ? { ...w, a: moved, b: fixed } : { ...w, a: fixed, b: moved }); // keep a/b orientation
        continue;
      }
      const horizontal = w.a.y === w.b.y;
      const keepDir = horizontal ? { x: moved.x, y: fixed.y } : { x: fixed.x, y: moved.y };
      const otherDir = horizontal ? { x: fixed.x, y: moved.y } : { x: moved.x, y: fixed.y };
      const corner = pinSpots.has(key(keepDir)) && !pinSpots.has(key(otherDir)) ? otherDir : keepDir;
      let id2 = `${w.id}_`;
      while (ids.has(id2)) id2 += '_';
      ids.add(id2);
      wires.push({ ...w, a: fixed, b: corner }, { id: id2, a: corner, b: moved });
    }
  }
  return { ...orig, components, wires: wires.filter((w) => w.a.x !== w.b.x || w.a.y !== w.b.y) };
}

/** The wire endpoint (if any) at grid point p. */
export function wireEndAt(circ: Circuit, p: Pt): boolean {
  return circ.wires.some((w) => (w.a.x === p.x && w.a.y === p.y) || (w.b.x === p.x && w.b.y === p.y));
}

// ── Copy / paste ──
export interface Clip {
  components: Comp[];
  wires: Wire[];
}

export function copySelection(circ: Circuit, sel: Selection): Clip {
  return structuredClone({
    components: circ.components.filter((c) => sel.comps.has(c.id)),
    wires: circ.wires.filter((w) => sel.wires.has(w.id)),
  });
}

/** Top-left grid point of a clip (component origins and wire ends). */
export function clipOrigin(clip: Clip): Pt {
  const pts = [...clip.components.map((c) => ({ x: c.x, y: c.y })), ...clip.wires.flatMap((w) => [w.a, w.b])];
  return pts.length ? { x: Math.min(...pts.map((p) => p.x)), y: Math.min(...pts.map((p) => p.y)) } : { x: 0, y: 0 };
}

/**
 * Paste a clip shifted by (dx, dy): fresh ids, and labels of ports (in/out/clock)
 * renumbered when they would clash, so the module's ports stay unique.
 */
export function pasteClip(circ: Circuit, clip: Clip, dx: number, dy: number): { circ: Circuit; sel: Selection } {
  const ids = new Set([...circ.components.map((c) => c.id), ...circ.wires.map((w) => w.id)]);
  const fresh = (prefix: string) => {
    let i = 1;
    while (ids.has(`${prefix}${i}`)) i++;
    ids.add(`${prefix}${i}`);
    return `${prefix}${i}`;
  };
  const labels = new Set(circ.components.map((c) => c.props.label).filter(Boolean));
  const uniqueLabel = (label: string) => {
    if (!labels.has(label)) {
      labels.add(label);
      return label;
    }
    const base = label.replace(/\d+$/, '') || 'p';
    let i = 0;
    while (labels.has(`${base}${i}`)) i++;
    labels.add(`${base}${i}`);
    return `${base}${i}`;
  };
  const sel = emptySelection();
  const components = clip.components.map((c) => {
    const id = fresh('c');
    sel.comps.add(id);
    const props = { ...c.props };
    if (props.label && (c.type === 'in' || c.type === 'out' || c.type === 'clock')) props.label = uniqueLabel(props.label);
    return { ...c, id, x: c.x + dx, y: c.y + dy, props };
  });
  const wires = clip.wires.map((w) => {
    const id = fresh('w');
    sel.wires.add(id);
    return { id, a: { x: w.a.x + dx, y: w.a.y + dy }, b: { x: w.b.x + dx, y: w.b.y + dy } };
  });
  return { circ: { ...circ, components: [...circ.components, ...components], wires: [...circ.wires, ...wires] }, sel };
}
