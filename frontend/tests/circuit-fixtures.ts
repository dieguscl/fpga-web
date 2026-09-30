import type { Circuit, Comp } from '../src/circuit/model';

export const comp = (id: string, type: Comp['type'], x: number, y: number, props: Comp['props'] = {}): Comp => ({ id, type, x, y, rot: 0, props });
export const wire = (id: string, ax: number, ay: number, bx: number, by: number) => ({ id, a: { x: ax, y: ay }, b: { x: bx, y: by } });

export const AND_CIRCUIT: Circuit = {
  version: 1,
  components: [
    comp('a', 'in', 0, 0, { label: 'a' }), comp('b', 'in', 0, 4, { label: 'b' }),
    comp('g', 'and', 6, 1), comp('y', 'out', 12, 1, { label: 'y' }),
  ],
  wires: [wire('w1', 2, 1, 6, 1), wire('w2', 2, 5, 4, 5), wire('w3', 4, 5, 4, 3), wire('w4', 4, 3, 6, 3), wire('w5', 9, 2, 12, 2)],
};

// clk → counter(4) → q (4-bit out); en tied to const 1; clr from input
export const COUNTER_CIRCUIT: Circuit = {
  version: 1,
  components: [
    comp('clk', 'clock', 0, 0, { label: 'clk' }), // out (2,1)
    comp('one', 'const', 0, 4, { value: 1 }), // out (2,5)
    comp('clr', 'in', 0, 8, { label: 'clr' }), // out (2,9)
    comp('cnt', 'counter', 6, 2, { bits: 4 }), // en (6,3) c (6,4) clr (6,5) q (9,3) ovf (9,4)
    comp('q', 'out', 12, 2, { label: 'q', bits: 4 }), // in (12,3)
    comp('ovf', 'out', 12, 6, { label: 'ovf' }), // in (12,7)
  ],
  wires: [
    wire('c1', 2, 1, 4, 1), wire('c2', 4, 1, 4, 4), wire('c3', 4, 4, 6, 4), // clk → c
    wire('e1', 2, 5, 3, 5), wire('e2', 3, 5, 3, 3), wire('e3', 3, 3, 6, 3), // const 1 → en
    wire('r1', 2, 9, 5, 9), wire('r2', 5, 9, 5, 5), wire('r3', 5, 5, 6, 5), // clr → clr
    wire('q1', 9, 3, 12, 3), // q → q
    wire('o1', 9, 4, 10, 4), wire('o2', 10, 4, 10, 7), wire('o3', 10, 7, 12, 7), // ovf → ovf
  ],
};

