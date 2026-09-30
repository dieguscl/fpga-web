import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { circuitInterface, type Circuit } from '../src/circuit/model';
import { generateVerilog } from '../src/circuit/verilog';

import { AND_CIRCUIT, COUNTER_CIRCUIT } from './circuit-fixtures';

describe('generateVerilog', () => {
  it('generates ports and a gate assignment', () => {
    const r = generateVerilog('and2', AND_CIRCUIT);
    expect(r.errors).toEqual([]);
    expect(r.verilog).toContain('module and2 (\n  input  wire a,\n  input  wire b,\n  output wire y\n);');
    expect(r.verilog).toContain('assign y = a & b;');
    expect(r.verilog).toContain('// Generated from and2.circ');
  });

  it('generates sequential logic with registers', () => {
    const r = generateVerilog('cnt4', COUNTER_CIRCUIT);
    expect(r.errors).toEqual([]);
    expect(r.verilog).toContain('input  wire clk');
    expect(r.verilog).toContain('output wire [3:0] q');
    expect(r.verilog).toMatch(/reg \[3:0\] r0 = 0;/);
    expect(r.verilog).toMatch(/always @\(posedge clk\) if \(clr\) r0 <= 0; else if \(n\d+\) r0 <= r0 \+ 1'b1;/);
    expect(circuitInterface(COUNTER_CIRCUIT).outputs).toEqual([{ name: 'q', bits: 4 }, { name: 'ovf', bits: 1 }]);
  });

  it('reports width errors', () => {
    const bad: Circuit = { ...AND_CIRCUIT, components: AND_CIRCUIT.components.map((c) => (c.id === 'y' ? { ...c, props: { ...c.props, bits: 2 } } : c)) };
    expect(generateVerilog('bad', bad).errors[0]).toMatch(/widths/);
  });

  const iverilog = join(homedir(), '.apio/packages/oss-cad-suite/bin/iverilog');
  it.skipIf(!existsSync(iverilog))('compiles and behaves correctly in Icarus Verilog', () => {
    const dir = mkdtempSync(join(tmpdir(), 'circ-'));
    writeFileSync(join(dir, 'and2.v'), generateVerilog('and2', AND_CIRCUIT).verilog);
    writeFileSync(join(dir, 'cnt4.v'), generateVerilog('cnt4', COUNTER_CIRCUIT).verilog);
    writeFileSync(join(dir, 'tb.v'), `module tb; reg a=0,b=0,clk=0,clr=1; wire y, ovf; wire [3:0] q;
      and2 u1(.a(a),.b(b),.y(y)); cnt4 u2(.clk(clk),.clr(clr),.q(q),.ovf(ovf));
      always #1 clk = ~clk;
      initial begin #1 a=1; #1 b=1; #1 $display("y=%b", y); #1 clr=0; #20 $display("q=%0d", q); $finish; end endmodule`);
    execFileSync(iverilog, ['-g2012', '-o', join(dir, 'sim.vvp'), join(dir, 'and2.v'), join(dir, 'cnt4.v'), join(dir, 'tb.v')]);
    const out = execFileSync(join(homedir(), '.apio/packages/oss-cad-suite/bin/vvp'), ['-n', join(dir, 'sim.vvp')]).toString();
    expect(out).toContain('y=1');
    expect(out).toMatch(/q=(9|10|11)/); // ~10 rising edges after clr release
  });
});
