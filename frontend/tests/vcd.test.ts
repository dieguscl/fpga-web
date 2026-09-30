import { describe, expect, it } from 'vitest';
import { changeIndexAt, formatTime, formatValue, parseVcd, valueAt } from '../src/vcd';

const VCD = `$date today $end
$version Icarus Verilog $end
$timescale 100ns $end
$scope module blinky_tb $end
$var wire 16 ! leds [15:0] $end
$var reg 1 % clk $end
$var real 1 & r $end
$scope module UUT $end
$var wire 1 % clk $end
$var reg 25 ' counter [24:0] $end
$upscope $end
$upscope $end
$enddefinitions $end
#0
$dumpvars
b0 !
1%
r0.5 &
bx '
$end
#1
0%
b1 '
#2
1%
b1010 !
b10 '
#3
0%
bz !
`;

describe('parseVcd', () => {
  const vcd = parseVcd(VCD);
  it('reads timescale, scopes, widths and end time', () => {
    expect(vcd.timescale).toBe('100ns');
    expect(vcd.timescaleSeconds).toBeCloseTo(1e-7);
    expect(vcd.endTime).toBe(3);
    expect(vcd.signals.map((s) => s.key)).toEqual([
      'blinky_tb.leds[15:0]', 'blinky_tb.clk', 'blinky_tb.r', 'blinky_tb.UUT.clk', 'blinky_tb.UUT.counter[24:0]',
    ]);
    expect(vcd.signals[0].width).toBe(16);
  });

  it('stores changes, extends vectors and shares aliased ids', () => {
    const [leds, clk, r, uutClk, counter] = vcd.signals;
    expect(clk.changes).toBe(uutClk.changes);
    expect(clk.changes.t).toEqual([0, 1, 2, 3]);
    expect(valueAt(leds, 0)).toBe('0'.repeat(16));
    expect(valueAt(leds, 2)).toBe('0'.repeat(12) + '1010');
    expect(valueAt(leds, 3)).toBe('z'.repeat(16));
    expect(valueAt(counter, 0)).toBe('x'.repeat(25));
    expect(valueAt(counter, 1.5)).toBe('0'.repeat(24) + '1');
    expect(valueAt(r, 2)).toBe('0.5');
  });

  it('finds the change in effect at a time', () => {
    const c = vcd.signals[1].changes;
    expect(changeIndexAt(c, -1)).toBe(-1);
    expect(changeIndexAt(c, 0)).toBe(0);
    expect(changeIndexAt(c, 2.9)).toBe(2);
    expect(changeIndexAt(c, 100)).toBe(3);
  });
});

describe('formatValue', () => {
  it('formats radixes, signed values and x/z', () => {
    expect(formatValue('00001010', 'hex')).toBe('0a');
    expect(formatValue('00001010', 'dec')).toBe('10');
    expect(formatValue('11111110', 'sdec')).toBe('-2');
    expect(formatValue('101', 'bin')).toBe('101');
    expect(formatValue('xxxx', 'hex')).toBe('x');
    expect(formatValue('0001x010', 'hex')).toBe('1x');
    expect(formatValue('z', 'dec')).toBe('z');
    expect(formatValue('1'.repeat(64), 'dec')).toBe('18446744073709551615');
  });
});

describe('formatTime', () => {
  it('picks a readable unit', () => {
    expect(formatTime(25, 1e-7)).toBe('2.5 µs');
    expect(formatTime(3, 1e-9)).toBe('3 ns');
    expect(formatTime(0, 1e-9)).toBe('0');
  });
});
