import { describe, expect, it } from 'vitest';
import { BASYS3_PINS } from '../src/boards/basys3-pins';
import { BASYS3_GROUPS, autoAssign, signalLabel } from '../src/pinplanner';
import { expandBits } from '../src/verilog-ports';

const bits = expandBits([
  { name: 'clk', dir: 'input', msb: null, lsb: null },
  { name: 'leds', dir: 'output', msb: 15, lsb: 0 },
  { name: 'SW', dir: 'input', msb: 3, lsb: 0 },
  { name: 'seg', dir: 'output', msb: 6, lsb: 0 },
  { name: 'an', dir: 'output', msb: 3, lsb: 0 },
  { name: 'btnC', dir: 'input', msb: null, lsb: null },
  { name: 'ja', dir: 'inout', msb: 7, lsb: 0 },
  { name: 'uart_tx', dir: 'output', msb: null, lsb: null },
]);

describe('autoAssign', () => {
  it('matches conventional names and aliases, case-insensitively', () => {
    const a = autoAssign(bits, new Map());
    expect(a.get('clk')).toBe('clk');
    expect(a.get('led[0]')).toBe('leds[0]');
    expect(a.get('led[15]')).toBe('leds[15]');
    expect(a.get('sw[3]')).toBe('SW[3]');
    expect(a.has('sw[4]')).toBe(false);
    expect(a.get('seg[6]')).toBe('seg[6]');
    expect(a.get('an[2]')).toBe('an[2]');
    expect(a.get('btnC')).toBe('btnC');
    expect(a.get('JA[0]')).toBe('ja[0]');
    expect(a.get('JA[4]')).toBe('ja[4]');
    expect(a.get('RsTx')).toBe('uart_tx');
  });

  it('keeps existing assignments and never uses a port bit twice', () => {
    const a = autoAssign(bits, new Map([['led[0]', 'leds[5]']]));
    expect(a.get('led[0]')).toBe('leds[5]');
    expect(a.has('led[5]')).toBe(false);
    expect(new Set(a.values()).size).toBe(a.size);
  });
});

describe('board definition', () => {
  it('every group signal exists in the pin table exactly once', () => {
    const signals = BASYS3_GROUPS.flatMap((g) => g.signals);
    const pins = new Set(BASYS3_PINS.map((p) => p.signal));
    expect(signals.filter((s) => !pins.has(s))).toEqual([]);
    expect(new Set(signals).size).toBe(signals.length);
    expect(signals.length).toBe(BASYS3_PINS.length);
  });

  it('labels signals like the silkscreen', () => {
    expect(['led[3]', 'sw[12]', 'seg[0]', 'seg[6]', 'an[1]', 'vgaRed[2]', 'btnU', 'JA[4]', 'JXADC[5]'].map(signalLabel))
      .toEqual(['LD3', 'SW12', 'CA', 'CG', 'AN1', 'R2', 'BTNU', 'JA7', 'XA2_N']);
  });
});
