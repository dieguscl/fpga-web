import { describe, expect, it } from 'vitest';
import { placedPins, rotate, type Circuit, type Comp } from '../src/circuit/model';
import { buildNetlist } from '../src/circuit/netlist';

const comp = (id: string, type: Comp['type'], x: number, y: number, props: Comp['props'] = {}, rot: Comp['rot'] = 0): Comp =>
  ({ id, type, x, y, rot, props });

describe('model', () => {
  it('rotates pins clockwise around the origin', () => {
    expect(rotate(2, 1, 90)).toEqual({ x: -1, y: 2 });
    expect(rotate(2, 1, 180)).toEqual({ x: -2, y: -1 });
    const pins = placedPins(comp('a', 'and', 10, 10));
    expect(pins.map((p) => [p.name, p.at.x, p.at.y])).toEqual([['in0', 10, 10], ['in1', 10, 12], ['y', 13, 11]]);
  });
});

describe('buildNetlist', () => {
  // a ─┐
  //    AND ── y
  // b ─┘
  const circ: Circuit = {
    version: 1,
    components: [
      comp('a', 'in', 0, 0, { label: 'a' }), // out pin at (2,1)
      comp('b', 'in', 0, 4, { label: 'b' }), // out pin at (2,5)
      comp('g', 'and', 6, 1), // in0 (6,1), in1 (6,3), y (9,2)
      comp('y', 'out', 12, 1, { label: 'y' }), // in pin (12,2)
    ],
    wires: [
      { id: 'w1', a: { x: 2, y: 1 }, b: { x: 6, y: 1 } },
      { id: 'w2', a: { x: 2, y: 5 }, b: { x: 4, y: 5 } },
      { id: 'w3', a: { x: 4, y: 5 }, b: { x: 4, y: 3 } },
      { id: 'w4', a: { x: 4, y: 3 }, b: { x: 6, y: 3 } },
      { id: 'w5', a: { x: 9, y: 2 }, b: { x: 12, y: 2 } },
    ],
  };

  it('connects pins through wire chains', () => {
    const nl = buildNetlist(circ);
    const net = (compId: string, pin: string) => nl.pinNet.get(nl.pins.find((p) => p.comp.id === compId && p.name === pin)!)!;
    expect(net('a', 'out')).toBe(net('g', 'in0'));
    expect(net('b', 'out')).toBe(net('g', 'in1'));
    expect(net('g', 'y')).toBe(net('y', 'in'));
    expect(net('a', 'out')).not.toBe(net('b', 'out'));
    expect(nl.problems).toEqual([]);
    expect(nl.wireNet.get('w3')).toBe(net('b', 'out'));
  });

  it('joins T-junctions and reports shorts, widths and floating inputs', () => {
    const shorted: Circuit = {
      ...circ,
      wires: [...circ.wires, { id: 'w6', a: { x: 4, y: 1 }, b: { x: 4, y: 3 } }], // (4,1) lies on w1 → a and b shorted
    };
    const nl = buildNetlist(shorted);
    expect(nl.problems.map((p) => p.kind)).toContain('drivers');

    const wide: Circuit = { ...circ, components: circ.components.map((c) => (c.id === 'y' ? { ...c, props: { ...c.props, bits: 4 } } : c)) };
    expect(buildNetlist(wide).problems.map((p) => p.kind)).toEqual(['width']);

    const open: Circuit = { ...circ, wires: circ.wires.filter((w) => w.id !== 'w1') };
    const p = buildNetlist(open).problems;
    expect(p).toHaveLength(1);
    expect(p[0].kind).toBe('floating');
    expect(p[0].compIds).toEqual(['g']);
  });
});
