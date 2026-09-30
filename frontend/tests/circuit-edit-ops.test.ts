import { describe, expect, it } from 'vitest';
import { boxSelect, moveSelection } from '../src/circuit/edit-ops';
import { buildNetlist } from '../src/circuit/netlist';
import { AND_CIRCUIT } from './circuit-fixtures';

const sel = (comps: string[], wires: string[] = []) => ({ comps: new Set(comps), wires: new Set(wires) });

describe('boxSelect', () => {
  it('selects only parts and wires fully inside the box', () => {
    const s = boxSelect(AND_CIRCUIT, { x: -1, y: -1 }, { x: 4.5, y: 8 });
    expect([...s.comps].sort()).toEqual(['a', 'b']);
    expect([...s.wires].sort()).toEqual(['w2', 'w3']); // w1 and w4 reach x=6, outside the box
    const all = boxSelect(AND_CIRCUIT, { x: -1, y: -1 }, { x: 20, y: 20 });
    expect(all.comps.size).toBe(4);
    expect(all.wires.size).toBe(5);
  });
});

describe('moveSelection', () => {
  it('stretches attached wires and keeps them orthogonal with an L', () => {
    // move the AND gate down by 2: w1 (a→in0) was horizontal, becomes an L; w5 (y→out) too
    const moved = moveSelection(AND_CIRCUIT, sel(['g']), 0, 2);
    const g = moved.components.find((c) => c.id === 'g')!;
    expect([g.x, g.y]).toEqual([6, 3]);
    const w1 = moved.wires.filter((w) => w.id.startsWith('w1'));
    expect(w1.map((w) => [w.a, w.b])).toEqual([
      [{ x: 2, y: 1 }, { x: 6, y: 1 }],
      [{ x: 6, y: 1 }, { x: 6, y: 3 }],
    ]);
    for (const w of moved.wires) expect(w.a.x === w.b.x || w.a.y === w.b.y).toBe(true);
    // connectivity is preserved
    const nl = buildNetlist(moved);
    expect(nl.problems).toEqual([]);
  });

  it('translates wires attached at both ends and selected wires; leaves others', () => {
    const moved = moveSelection(AND_CIRCUIT, sel(['g', 'y']), 5, 0);
    const w5 = moved.wires.find((w) => w.id === 'w5')!;
    expect([w5.a, w5.b]).toEqual([{ x: 14, y: 2 }, { x: 17, y: 2 }]); // between two moved parts → translated
    const w2 = moved.wires.find((w) => w.id === 'w2')!;
    expect([w2.a, w2.b]).toEqual([{ x: 2, y: 5 }, { x: 4, y: 5 }]); // untouched
    expect(buildNetlist(moved).problems).toEqual([]);
  });

  it('is computed from the original, so drags do not accumulate segments', () => {
    const once = moveSelection(AND_CIRCUIT, sel(['g']), 0, 2);
    const again = moveSelection(AND_CIRCUIT, sel(['g']), 0, 2);
    expect(again).toEqual(once);
    const back = moveSelection(AND_CIRCUIT, sel(['g']), 0, 0);
    expect(back.wires).toEqual(AND_CIRCUIT.wires);
  });
});

describe('copy / paste', () => {
  it('pastes shifted copies with fresh ids and unique port labels, and they work', async () => {
    const { copySelection, pasteClip, clipOrigin } = await import('../src/circuit/edit-ops');
    const all = { comps: new Set(AND_CIRCUIT.components.map((c) => c.id)), wires: new Set(AND_CIRCUIT.wires.map((w) => w.id)) };
    const clip = copySelection(AND_CIRCUIT, all);
    expect(clipOrigin(clip)).toEqual({ x: 0, y: 0 });
    const { circ, sel } = pasteClip(AND_CIRCUIT, clip, 0, 10);
    expect(circ.components).toHaveLength(8);
    expect(circ.wires).toHaveLength(10);
    expect(sel.comps.size).toBe(4);
    expect(new Set([...circ.components.map((c) => c.id), ...circ.wires.map((w) => w.id)]).size).toBe(18);
    const labels = circ.components.map((c) => c.props.label).filter(Boolean);
    expect(new Set(labels).size).toBe(labels.length); // a, b, y + renamed copies
    expect(buildNetlist(circ).problems).toEqual([]); // the copy is wired correctly and separate
  });
});
