import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NetSim, NetlistError } from '../src/boardsim/netsim';

// Hand-written gate netlist: q toggles every clock (q <= ~q), y = a & q
const TOGGLE = {
  modules: {
    t: {
      ports: {
        clk: { direction: 'input' as const, bits: [2] },
        a: { direction: 'input' as const, bits: [3] },
        q: { direction: 'output' as const, bits: [4] },
        y: { direction: 'output' as const, bits: [6] },
      },
      cells: {
        inv: { type: '$_NOT_', connections: { A: [4], Y: [5] } },
        ff: { type: '$_DFF_P_', connections: { C: [2], D: [5], Q: [4] } },
        g: { type: '$_AND_', connections: { A: [3], B: [4], Y: [6] } },
      },
    },
  },
};

describe('NetSim', () => {
  it('toggles a flip-flop on rising edges and evaluates gates', () => {
    const s = new NetSim(TOGGLE);
    const clk = s.netOf('clk')!, a = s.netOf('a')!, q = s.netOf('q')!, y = s.netOf('y')!;
    expect(s.get(q)).toBe(0);
    s.cycle(clk);
    expect(s.get(q)).toBe(1);
    s.set(a, 1);
    s.settle();
    expect(s.get(y)).toBe(1);
    s.cycle(clk);
    expect(s.get(q)).toBe(0);
    expect(s.get(y)).toBe(0);
    expect(s.ffCount).toBe(1);
  });

  it('rejects loops and unsupported cells', () => {
    const loop = structuredClone(TOGGLE);
    loop.modules.t.cells = { a: { type: '$_NOT_', connections: { A: [5], Y: [4] } }, b: { type: '$_NOT_', connections: { A: [4], Y: [5] } } } as never;
    expect(() => new NetSim(loop)).toThrow(/loop/);
    const latch = structuredClone(TOGGLE);
    latch.modules.t.cells = { l: { type: '$_DLATCH_P_', connections: { E: [2], D: [3], Q: [4] } } } as never;
    expect(() => new NetSim(latch)).toThrow(NetlistError);
  });

  const yosys = join(homedir(), '.apio/packages/oss-cad-suite/bin/yosys');
  it.skipIf(!existsSync(yosys))('runs a real Yosys netlist: divider, derived clock, 7-segment mux', () => {
    const dir = mkdtempSync(join(tmpdir(), 'netsim-'));
    writeFileSync(join(dir, 'top.v'), `module top(input clk, input [3:0] sw, input btnC, output reg [7:0] led = 0, output [3:0] an);
      reg [3:0] div = 0; reg slow = 0;
      always @(posedge clk) if (div == 4'd9) begin div <= 0; slow <= ~slow; end else div <= div + 1;
      always @(posedge slow or posedge btnC) if (btnC) led <= 0; else led <= led + sw;   // async reset, derived clock
      reg [1:0] r = 0; always @(posedge clk) r <= r + 1;
      assign an = ~(4'b1 << r);
    endmodule`);
    execFileSync(yosys, ['-q', '-p', 'read_verilog top.v; hierarchy -check -top top; proc; flatten; opt -full; memory; opt -full; write_json word.json'], { cwd: dir });
    execFileSync(yosys, ['-q', '-p', 'read_json word.json; techmap; opt -fast; async2sync; dffunmap; setundef -zero; opt_clean -purge; write_json gate.json'], { cwd: dir });
    const s = new NetSim(JSON.parse(readFileSync(join(dir, 'gate.json'), 'utf8')), 'top');
    const clk = s.netOf('clk')!;
    const led = () => Array.from({ length: 8 }, (_, i) => s.get(s.netOf('led', i)!) << i).reduce((x, y) => x | y, 0);
    s.set(s.netOf('sw', 0)!, 1);
    s.set(s.netOf('sw', 1)!, 1); // sw = 3
    for (let i = 0; i < 20 * 5; i++) s.cycle(clk); // slow rises every 20 clk cycles → 5 increments
    expect(led()).toBe(15);
    s.set(s.netOf('btnC')!, 1);
    s.cycle(clk);
    expect(led()).toBe(0);
    s.set(s.netOf('btnC')!, 0);
    const an = () => Array.from({ length: 4 }, (_, i) => s.get(s.netOf('an', i)!) << i).reduce((x, y) => x | y, 0);
    const seen = new Set<number>();
    for (let i = 0; i < 4; i++) { s.cycle(clk); seen.add(an()); }
    expect(seen).toEqual(new Set([0b1110, 0b1101, 0b1011, 0b0111]));
  });
});
