import { describe, expect, it } from 'vitest';
import { generateTestbench, testbenchName } from '../src/tbgen';

describe('generateTestbench', () => {
  it('declares regs for inputs, wires for outputs, a clock and reset release', () => {
    const tb = generateTestbench('main', [
      { name: 'clk', dir: 'input', msb: null, lsb: null },
      { name: 'rst_n', dir: 'input', msb: null, lsb: null },
      { name: 'sw', dir: 'input', msb: 15, lsb: 0 },
      { name: 'led', dir: 'output', msb: 15, lsb: 0 },
      { name: 'ja', dir: 'inout', msb: 7, lsb: 0 },
    ]);
    expect(testbenchName('main')).toBe('main_tb.v');
    expect(tb).toContain('module main_tb;');
    expect(tb).toContain('reg clk = 0;');
    expect(tb).toContain('reg rst_n = 0;');
    expect(tb).toContain('reg [15:0] sw = 0;');
    expect(tb).toContain('wire [15:0] led;');
    expect(tb).toContain('wire [7:0] ja;');
    expect(tb).toContain('always #5 clk = ~clk;');
    expect(tb).toContain('#20 rst_n = 1;');
    expect(tb).toContain('$dumpvars(0, main_tb);');
    expect(tb).toContain('$finish;');
    expect(tb).toMatch(/main uut \(\n {4}\.clk\(clk\),\n {4}\.rst_n\(rst_n\),/);
  });

  it('works without clock or reset', () => {
    const tb = generateTestbench('adder', [
      { name: 'a', dir: 'input', msb: 3, lsb: 0 },
      { name: 's', dir: 'output', msb: 4, lsb: 0 },
    ]);
    expect(tb).not.toContain('always #5');
    expect(tb).toContain('// #50 a = 1;');
  });
});
