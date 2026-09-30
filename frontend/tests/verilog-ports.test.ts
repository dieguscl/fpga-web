import { describe, expect, it } from 'vitest';
import { expandBits, findModulePorts } from '../src/verilog-ports';

describe('findModulePorts', () => {
  it('parses ANSI-style ports with vectors, types and comments', () => {
    const src = `
      // module decoy(input x);
      /* module decoy2(input y); */
      module main #(parameter W = 8) (
        input  wire clk,            // 100 MHz
        input  [15:0] sw,
        output reg [15:0] led,
        output logic signed [6:0] seg,
        inout  [3:0] ja,
        output dp
      );
      endmodule`;
    expect(findModulePorts({ 'a.v': src }, 'main')).toEqual({
      ports: [
        { name: 'clk', dir: 'input', msb: null, lsb: null },
        { name: 'sw', dir: 'input', msb: 15, lsb: 0 },
        { name: 'led', dir: 'output', msb: 15, lsb: 0 },
        { name: 'seg', dir: 'output', msb: 6, lsb: 0 },
        { name: 'ja', dir: 'inout', msb: 3, lsb: 0 },
        { name: 'dp', dir: 'output', msb: null, lsb: null },
      ],
      warnings: [],
    });
  });

  it('parses several names in one declaration', () => {
    const src = 'module top(input btnU, btnD, output [3:0] an, output hs, vs); endmodule';
    expect(findModulePorts({ 't.v': src }, 'top').ports.map((p) => p.name)).toEqual(['btnU', 'btnD', 'an', 'hs', 'vs']);
    expect(findModulePorts({ 't.v': src }, 'top').ports[1].dir).toBe('input');
  });

  it('parses non-ANSI style ports declared in the body', () => {
    const src = `module top(clk, led, sw);
      input clk;
      output [7:0] led;
      input wire [1:0] sw;
      reg [7:0] led;
    endmodule`;
    expect(findModulePorts({ 't.v': src }, 'top').ports).toEqual([
      { name: 'clk', dir: 'input', msb: null, lsb: null },
      { name: 'led', dir: 'output', msb: 7, lsb: 0 },
      { name: 'sw', dir: 'input', msb: 1, lsb: 0 },
    ]);
  });

  it('resolves simple parameter widths and warns on unknown ones', () => {
    const src = `module top #(parameter N = 4, parameter M = 2) (
      output [N-1:0] a, output [M:0] b, output [K-1:0] c); endmodule`;
    const r = findModulePorts({ 't.v': src }, 'top');
    expect(r.ports.slice(0, 2)).toEqual([
      { name: 'a', dir: 'output', msb: 3, lsb: 0 },
      { name: 'b', dir: 'output', msb: 2, lsb: 0 },
    ]);
    expect(r.ports[2]).toEqual({ name: 'c', dir: 'output', msb: null, lsb: null });
    expect(r.warnings[0]).toMatch(/c/);
  });

  it('searches all files and ignores testbenches only by name match', () => {
    const files = { 'x_tb.v': 'module tb; endmodule', 'core.v': 'module other(input a); endmodule\nmodule top(input b); endmodule' };
    expect(findModulePorts(files, 'top').ports.map((p) => p.name)).toEqual(['b']);
  });

  it('reports a missing top module', () => {
    const r = findModulePorts({ 'a.v': 'module x(); endmodule' }, 'main');
    expect(r.ports).toEqual([]);
    expect(r.warnings[0]).toMatch(/main/);
  });
});

describe('expandBits', () => {
  it('expands vectors msb-first-agnostic and keeps scalars', () => {
    expect(expandBits([{ name: 'a', dir: 'input', msb: 1, lsb: 0 }, { name: 'b', dir: 'output', msb: null, lsb: null }]))
      .toEqual([
        { bit: 'a[0]', port: 'a', dir: 'input' },
        { bit: 'a[1]', port: 'a', dir: 'input' },
        { bit: 'b', port: 'b', dir: 'output' },
      ]);
    expect(expandBits([{ name: 'r', dir: 'output', msb: 0, lsb: 2 }]).map((b) => b.bit)).toEqual(['r[0]', 'r[1]', 'r[2]']);
  });
});
