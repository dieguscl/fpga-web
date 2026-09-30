// Generate a starter testbench for a top module from its scanned ports.
import type { Port } from './verilog-ports';

const CLOCK_RE = /^(clk|clock|sysclk|sys_clk|clk_?\d+(mhz)?|clk_i)$/i;
const RESET_RE = /^(rst|reset|rst_n|resetn|reset_n|rst_i)$/i;

function range(p: Port): string {
  return p.msb === null || p.lsb === null ? '' : `[${p.msb}:${p.lsb}] `;
}

export function testbenchName(top: string): string {
  return `${top}_tb.v`;
}

export function generateTestbench(top: string, ports: Port[]): string {
  const tb = `${top}_tb`;
  const inputs = ports.filter((p) => p.dir === 'input');
  const others = ports.filter((p) => p.dir !== 'input');
  const clock = inputs.find((p) => CLOCK_RE.test(p.name) && p.msb === null);
  const reset = inputs.find((p) => RESET_RE.test(p.name) && p.msb === null);
  const activeLow = reset ? /n$/i.test(reset.name) : false;

  const lines: string[] = [
    '`timescale 1ns / 1ps',
    '',
    `module ${tb};`,
    '',
  ];
  if (inputs.length) lines.push('  // Inputs of the design under test: drive them from here');
  for (const p of inputs) {
    const init = p === reset ? (activeLow ? '0' : '1') : '0';
    lines.push(`  reg ${range(p)}${p.name} = ${init};`);
  }
  if (others.length) lines.push('', '  // Outputs (and inouts) to observe in the waveform');
  for (const p of others) lines.push(`  wire ${range(p)}${p.name};`);
  lines.push('', `  ${top} uut (`);
  lines.push(ports.map((p) => `    .${p.name}(${p.name})`).join(',\n'));
  lines.push('  );', '');
  if (clock) lines.push(`  // 100 MHz clock`, `  always #5 ${clock.name} = ~${clock.name};`, '');
  lines.push('  initial begin');
  lines.push(`    $dumpvars(0, ${tb});`);
  if (reset) {
    lines.push(`    #20 ${reset.name} = ${activeLow ? '1' : '0'};  // release reset`);
  }
  lines.push('');
  lines.push('    // TODO: stimulus, e.g.');
  const example = inputs.find((p) => p !== clock && p !== reset);
  if (example) lines.push(`    // #50 ${example.name} = 1;`);
  lines.push('    #1000;');
  lines.push('    $display("simulation finished at %0t", $time);');
  lines.push('    $finish;');
  lines.push('  end', '', 'endmodule', '');
  return lines.join('\n');
}
