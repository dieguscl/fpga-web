import { describe, expect, it } from 'vitest';
import type { Circuit, Comp } from '../src/circuit/model';
import { CircuitSim } from '../src/circuit/sim';
import { AND_CIRCUIT, COUNTER_CIRCUIT } from './circuit-fixtures';

const comp = (id: string, type: Comp['type'], x: number, y: number, props: Comp['props'] = {}): Comp => ({ id, type, x, y, rot: 0, props });
const wire = (id: string, ax: number, ay: number, bx: number, by: number) => ({ id, a: { x: ax, y: ay }, b: { x: bx, y: by } });
const out = (sim: CircuitSim, circ: Circuit, id: string) => sim.pinValue(circ.components.find((c) => c.id === id)!, 'in');

describe('CircuitSim', () => {
  it('evaluates combinational logic as inputs change', () => {
    const sim = new CircuitSim(AND_CIRCUIT);
    expect(out(sim, AND_CIRCUIT, 'y')).toBe(0);
    sim.toggle('a');
    expect(out(sim, AND_CIRCUIT, 'y')).toBe(0);
    sim.toggle('b');
    expect(out(sim, AND_CIRCUIT, 'y')).toBe(1);
    expect(sim.oscillating).toBe(false);
  });

  it('counts on rising clock edges, honours clear, and wraps with overflow', () => {
    const sim = new CircuitSim(COUNTER_CIRCUIT);
    for (let i = 0; i < 6; i++) sim.tick(); // 3 rising edges
    expect(out(sim, COUNTER_CIRCUIT, 'q')).toBe(3);
    sim.toggle('clr');
    sim.tick();
    sim.tick();
    expect(out(sim, COUNTER_CIRCUIT, 'q')).toBe(0);
    sim.toggle('clr');
    for (let i = 0; i < 30; i++) sim.tick(); // 15 edges
    expect(out(sim, COUNTER_CIRCUIT, 'q')).toBe(15);
    expect(out(sim, COUNTER_CIRCUIT, 'ovf')).toBe(1);
    sim.tick();
    sim.tick();
    expect(out(sim, COUNTER_CIRCUIT, 'q')).toBe(0);
  });

  it('simulates sub-circuits by port order', () => {
    const top: Circuit = {
      version: 1,
      components: [
        comp('x', 'in', 0, 0, { label: 'x' }), comp('z', 'in', 0, 2, { label: 'z' }),
        comp('u', 'sub', 4, 0, { circuit: 'and2' }), // pins a (4,1), b (4,2), y (8,1)
        comp('o', 'out', 10, 0, { label: 'o' }), // in (10,1)
      ],
      wires: [wire('1', 2, 1, 4, 1), wire('2', 2, 3, 3, 3), wire('3', 3, 3, 3, 2), wire('4', 3, 2, 4, 2), wire('5', 8, 1, 10, 1)],
    };
    const sim = new CircuitSim(top, new Map([['and2', AND_CIRCUIT]]));
    sim.toggle('x');
    expect(out(sim, top, 'o')).toBe(0);
    sim.toggle('z');
    expect(out(sim, top, 'o')).toBe(1);
  });

  it('detects oscillation (a NOT gate feeding itself)', () => {
    const ring: Circuit = {
      version: 1,
      components: [comp('n', 'not', 2, 0)], // a (2,1), y (5,1)
      wires: [wire('1', 5, 1, 5, 3), wire('2', 5, 3, 1, 3), wire('3', 1, 3, 1, 1), wire('4', 1, 1, 2, 1)],
    };
    expect(new CircuitSim(ring).oscillating).toBe(true);
  });

  it('handles buses: split, merge, adder and mux', () => {
    const circ: Circuit = {
      version: 1,
      components: [
        comp('a', 'in', 0, 0, { label: 'a', bits: 4, value: 9 }), // out (2,1)
        comp('b', 'in', 0, 4, { label: 'b', bits: 4, value: 8 }), // out (2,5)
        comp('add', 'adder', 4, 0, { bits: 4 }), // a (4,1) b (4,2) ci (4,3) s (7,1) co (7,3)
        comp('s', 'out', 10, 0, { label: 's', bits: 4 }), // in (10,1)
        comp('co', 'out', 10, 2, { label: 'co' }), // in (10,3)
      ],
      wires: [wire('1', 2, 1, 4, 1), wire('2', 2, 5, 3, 5), wire('3', 3, 5, 3, 2), wire('4', 3, 2, 4, 2),
        wire('5', 7, 1, 10, 1), wire('6', 7, 3, 10, 3)],
    };
    const sim = new CircuitSim(circ);
    expect(out(sim, circ, 's')).toBe(1); // 9 + 8 = 17 → 0001 carry 1
    expect(out(sim, circ, 'co')).toBe(1);
  });
});
