import { describe, expect, it } from 'vitest';
import { bitSignals, type VcdSignal } from '../src/vcd';

const bus = (name: string, width: number, t: number[], v: string[]): VcdSignal =>
  ({ key: `tb.${name}`, name, scope: ['tb'], width, kind: 'reg', changes: { t, v } });

describe('bitSignals', () => {
  it('splits a bus MSB first using the declared range, keeping only real changes', () => {
    const bits = bitSignals(bus('D[3:0]', 4, [0, 10, 20], ['0000', '0001', '0011']));
    expect(bits.map((b) => b.name)).toEqual(['D[3]', 'D[2]', 'D[1]', 'D[0]']);
    expect(bits[3].changes).toEqual({ t: [0, 10], v: ['0', '1'] });
    expect(bits[2].changes).toEqual({ t: [0, 20], v: ['0', '1'] });
    expect(bits[0].changes).toEqual({ t: [0], v: ['0'] });
    expect(bits.every((b) => b.width === 1)).toBe(true);
  });

  it('handles ascending ranges, missing ranges, short values and scalars', () => {
    expect(bitSignals(bus('a[0:1]', 2, [0], ['10'])).map((b) => [b.name, b.changes.v[0]])).toEqual([['a[0]', '1'], ['a[1]', '0']]);
    expect(bitSignals(bus('n', 3, [0], ['1'])).map((b) => [b.name, b.changes.v[0]])).toEqual([['n[2]', '0'], ['n[1]', '0'], ['n[0]', '1']]);
    expect(bitSignals(bus('x', 1, [0], ['1']))).toEqual([]);
  });
});
