import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import type { BoardInfo } from '../src/api';
import { exportZip, newProject } from '../src/project';
import { expandXdcWildcards, importUpload, parseXpr, partKey, pickBoard } from '../src/vivado';

const board = (id: string, part: string) => ({ id, part, arch: 'xilinx' }) as BoardInfo;
const BOARDS = [
  board('basys3', 'XC7A35T-1CPG236'),
  board('cmod-a7-35t', 'XC7A35T-1CPG236'),
  board('arty-a7-35t', 'XC7A35T-1CSG324'),
  board('arty-s7-50', 'XC7S50-1CSGA324'),
  board('icestick', 'ICE40HX1K-TQ144'),
];

const file = (path: string, extra = '') =>
  `      <File Path="${path}">\n        <FileInfo>${extra}\n          <Attr Name="UsedIn" Val="synthesis"/>\n        </FileInfo>\n      </File>\n`;

function xpr(opts: { part?: string; boardPart?: string; top?: string; srcs?: string[]; xdcs?: string[]; sims?: string[]; extraSets?: string }) {
  const { part = 'xc7a35ticpg236-1L', boardPart = '', top = 'top', srcs = [], xdcs = [], sims = [], extraSets = '' } = opts;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Project Product="Vivado" Version="7" Minor="72" Path="/home/u/p/demo.xpr">
  <Configuration>
    <Option Name="Part" Val="${part}"/>
    <Option Name="BoardPart" Val="${boardPart}"/>
    <Option Name="ActiveSimSet" Val="sim_1"/>
  </Configuration>
  <FileSets Version="1" Minor="32">
    <FileSet Name="sources_1" Type="DesignSrcs" RelSrcDir="$PSRCDIR/sources_1" RelGenDir="$PGENDIR/sources_1">
      <Filter Type="Srcs"/>
${srcs.join('')}      <Config>
        <Option Name="DesignMode" Val="RTL"/>
${top ? `        <Option Name="TopModule" Val="${top}"/>\n` : ''}      </Config>
    </FileSet>
    <FileSet Name="constrs_1" Type="Constrs" RelSrcDir="$PSRCDIR/constrs_1" RelGenDir="$PGENDIR/constrs_1">
      <Filter Type="Constrs"/>
${xdcs.join('')}      <Config>
        <Option Name="ConstrsType" Val="XDC"/>
      </Config>
    </FileSet>
    <FileSet Name="sim_1" Type="SimulationSrcs" RelSrcDir="$PSRCDIR/sim_1" RelGenDir="$PGENDIR/sim_1">
${sims.join('')}      <Config>
        <Option Name="TopModule" Val="top_teste1"/>
      </Config>
    </FileSet>
${extraSets}  </FileSets>
  <Runs Version="1" Minor="22">
    <Run Id="synth_1" Type="Ft3:Synth" SrcSet="sources_1" Part="${part}" ConstrsSet="constrs_1" State="current">
    </Run>
  </Runs>
</Project>
`;
}

const zip = (entries: Record<string, string>) => {
  const out: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(entries)) out[k] = strToU8(v);
  return { name: 'proj.zip', bytes: zipSync(out) };
};

describe('partKey', () => {
  it('matches Vivado and Apio spellings of the same chip', () => {
    expect(partKey('xc7a35ticpg236-1L')).toBe('xc7a35t/cpg236');
    expect(partKey('xc7a35tcpg236-1')).toBe('xc7a35t/cpg236');
    expect(partKey('XC7A35T-1CPG236')).toBe('xc7a35t/cpg236');
    expect(partKey('xc7s50csga324-1')).toBe('xc7s50/csga324');
    expect(partKey('XC7S50-1CSGA324')).toBe('xc7s50/csga324');
    expect(partKey('xc7z020clg400-1')).toBe('xc7z020/clg400');
    expect(partKey('ICE40HX1K-TQ144')).toBeNull();
  });
});

describe('pickBoard', () => {
  it('uses the board part to choose between boards with the same chip', () => {
    expect(pickBoard({ part: 'xc7a35tcpg236-1', boardPart: 'digilentinc.com:cmod_a7-35t:part0:1.1' }, BOARDS, 'icestick').board).toBe('cmod-a7-35t');
    expect(pickBoard({ part: 'xc7a35tcpg236-1', boardPart: 'digilentinc.com:basys3:part0:1.2' }, BOARDS, 'icestick').board).toBe('basys3');
  });
  it('prefers the current board, then the first match, and lists the alternatives', () => {
    expect(pickBoard({ part: 'xc7a35tcpg236-1', boardPart: '' }, BOARDS, 'cmod-a7-35t')).toEqual({ board: 'cmod-a7-35t', matched: true, others: ['basys3'] });
    expect(pickBoard({ part: 'xc7a35tcpg236-1', boardPart: '' }, BOARDS, 'icestick').board).toBe('basys3');
  });
  it('keeps the current board when no board has the part', () => {
    expect(pickBoard({ part: 'xc7k325tffg900-2', boardPart: '' }, BOARDS, 'arty-a7-35t')).toEqual({ board: 'arty-a7-35t', matched: false, others: [] });
  });
});

describe('parseXpr', () => {
  it('rejects files that are not Vivado projects', () => {
    expect(() => parseXpr('<Project Product="Quartus"/>')).toThrow(/not a Vivado/);
  });
  it('reads part, sets and top', () => {
    const x = parseXpr(xpr({ srcs: [file('$PSRCDIR/sources_1/new/a&amp;b.v')] }));
    expect(x.part).toBe('xc7a35ticpg236-1L');
    expect(x.srcSet).toBe('sources_1');
    expect(x.constrsSet).toBe('constrs_1');
    expect(x.fileSets.find((s) => s.name === 'sources_1')).toMatchObject({ top: 'top', files: [{ path: '$PSRCDIR/sources_1/new/a&b.v', enabled: true }] });
  });
});

describe('importUpload (Vivado)', () => {
  it('imports a zipped project folder: sources, constraints, testbenches, top, board', () => {
    const r = importUpload([zip({
      'demo/demo.xpr': xpr({
        srcs: [file('$PSRCDIR/sources_1/new/top.v'), file('$PSRCDIR/sources_1/new/sub.v')],
        xdcs: [file('$PSRCDIR/constrs_1/new/basys3.xdc')],
        sims: [file('$PSRCDIR/sim_1/new/top_teste1.v'), file('$PSRCDIR/sim_1/new/sub_tb.v', '\n          <Attr Name="AutoDisabled" Val="1"/>')],
      }),
      'demo/demo.srcs/sources_1/new/top.v': 'module top(input a, output b); sub s(.a(a), .b(b)); endmodule\n',
      'demo/demo.srcs/sources_1/new/sub.v': 'module sub(input a, output b); assign b = a; endmodule\n',
      'demo/demo.srcs/constrs_1/new/basys3.xdc': 'set_property PACKAGE_PIN V17 [get_ports a]\n',
      'demo/demo.srcs/sim_1/new/top_teste1.v': 'module top_teste1; endmodule\n',
      'demo/demo.srcs/sim_1/new/sub_tb.v': 'module sub_tb; endmodule\n',
      'demo/demo.runs/impl_1/top.bit': 'BITSTREAM',
      'demo/demo.cache/wt/project.wpc': 'x',
      'demo/demo.hw/demo.lpr': 'x',
    })], BOARDS, 'icestick');
    expect(r.vivado).toBe(true);
    expect(r.project).toMatchObject({ name: 'demo', board: 'basys3', top: 'top' });
    expect(Object.keys(r.project.files).sort()).toEqual(['basys3.xdc', 'sub.v', 'sub_tb.v', 'top.v', 'top_teste1_tb.v']);
    expect(r.project.files['top_teste1_tb.v']).toBe('module top_teste1; endmodule\n');
    expect(r.notes).toContainEqual({ kind: 'renamedTb', file: 'top_teste1.v', to: 'top_teste1_tb.v' });
    expect(r.notes).toContainEqual({ kind: 'board', part: 'xc7a35ticpg236-1L', board: 'basys3', others: ['cmod-a7-35t'] });
  });

  it('finds sources referenced outside the project folder ($PPRDIR/../..) by name', () => {
    const r = importUpload([zip({
      'lab/vivado/mux/mux.xpr': xpr({
        top: 'mux',
        srcs: [file('$PPRDIR/../../mux/mux.v')],
        xdcs: [file('$PPRDIR/../../mux/mux.xdc')],
        sims: [file('$PPRDIR/../../mux/mux_teste1.v')],
      }),
      'lab/mux/mux.v': 'module mux; endmodule\n',
      'lab/mux/mux.xdc': '',
      'lab/mux/mux_teste1.v': 'module mux_teste1; endmodule\n',
      'lab/other/mux.v': 'module wrong; endmodule\n',
    })], BOARDS, 'basys3');
    expect(r.project.files['mux.v']).toBe('module mux; endmodule\n');
    expect(Object.keys(r.project.files).sort()).toEqual(['mux.v', 'mux.xdc', 'mux_teste1_tb.v']);
  });

  it('works with the .xpr picked together with loose source files', () => {
    const r = importUpload([
      { name: 'mux.xpr', bytes: strToU8(xpr({ top: 'mux', srcs: [file('C:/Users/me/lab/mux.v')], xdcs: [file('$PPRDIR/../../mux/mux.xdc')] })) },
      { name: 'mux.v', bytes: strToU8('module mux; endmodule\n') },
      { name: 'mux.xdc', bytes: strToU8('') },
    ], BOARDS, 'basys3');
    expect(Object.keys(r.project.files).sort()).toEqual(['mux.v', 'mux.xdc']);
    expect(r.project.top).toBe('mux');
  });

  it('reports missing, VHDL and unsupported files and skips user-disabled ones', () => {
    const r = importUpload([zip({
      'p/p.xpr': xpr({
        srcs: [
          file('$PSRCDIR/sources_1/new/top.v'),
          file('$PSRCDIR/sources_1/new/gone.v'),
          file('$PSRCDIR/sources_1/new/old.vhd'),
          file('$PSRCDIR/sources_1/ip/clk/clk.xci'),
          file('$PSRCDIR/sources_1/new/off.v', '\n          <Attr Name="IsEnabled" Val="0"/>'),
        ],
      }),
      'p/p.srcs/sources_1/new/top.v': 'module top; endmodule\n',
      'p/p.srcs/sources_1/new/off.v': 'module off; endmodule\n',
    })], BOARDS, 'basys3');
    expect(Object.keys(r.project.files)).toEqual(['top.v']);
    expect(r.notes).toEqual(expect.arrayContaining([
      { kind: 'missing', file: 'gone.v' },
      { kind: 'vhdl', file: 'old.vhd' },
      { kind: 'skipped', file: 'clk.xci' },
    ]));
  });

  it('merges several constraint files into one', () => {
    const r = importUpload([zip({
      'p/p.xpr': xpr({ srcs: [file('$PSRCDIR/sources_1/new/top.v')], xdcs: [file('$PSRCDIR/constrs_1/new/pins.xdc'), file('$PSRCDIR/constrs_1/new/clk.xdc')] }),
      'p/p.srcs/sources_1/new/top.v': 'module top; endmodule\n',
      'p/p.srcs/constrs_1/new/pins.xdc': 'PINS',
      'p/p.srcs/constrs_1/new/clk.xdc': 'CLK\n',
    })], BOARDS, 'basys3');
    expect(Object.keys(r.project.files).sort()).toEqual(['p.xdc', 'top.v']);
    expect(r.project.files['p.xdc']).toBe('## ---- pins.xdc ----\nPINS\n\n## ---- clk.xdc ----\nCLK\n');
  });

  it('guesses the top module when the .xpr has none', () => {
    const r = importUpload([zip({
      'p/p.xpr': xpr({ top: '', srcs: [file('$PSRCDIR/sources_1/new/a.v'), file('$PSRCDIR/sources_1/new/b.v')] }),
      'p/p.srcs/sources_1/new/a.v': 'module leaf(input x); endmodule\n',
      'p/p.srcs/sources_1/new/b.v': 'module system(input x);\n  leaf u0 (.x(x));\nendmodule\n',
    })], BOARDS, 'basys3');
    expect(r.project.top).toBe('system');
    expect(r.notes).toContainEqual({ kind: 'guessedTop', top: 'system' });
  });

  it('makes file names the backend accepts and keeps clashing names apart', () => {
    const r = importUpload([zip({
      'p/p.xpr': xpr({ srcs: [file('$PSRCDIR/sources_1/new/my top.V'), file('$PSRCDIR/sources_1/a/x.v'), file('$PSRCDIR/sources_1/b/x.v')] }),
      'p/p.srcs/sources_1/new/my top.V': 'module top; endmodule\n',
      'p/p.srcs/sources_1/a/x.v': 'module xa; endmodule\n',
      'p/p.srcs/sources_1/b/x.v': 'module xb; endmodule\n',
    })], BOARDS, 'basys3');
    expect(Object.keys(r.project.files).sort()).toEqual(['my_top.v', 'x.v', 'x_2.v']);
  });

  it('fails clearly when there is nothing to import', () => {
    expect(() => importUpload([zip({ 'a.v': 'x' })], BOARDS, 'basys3')).toThrow(/no Vivado project/);
    expect(() => importUpload([{ name: 'a.v', bytes: strToU8('x') }], BOARDS, 'basys3')).toThrow(/\.xpr/);
    expect(() => importUpload([zip({ 'p/p.xpr': xpr({ srcs: [file('$PSRCDIR/x.v')] }) })], BOARDS, 'basys3')).toThrow(/no Verilog design sources/);
  });

  it('still imports fpga-web project exports', () => {
    const p = newProject('demo', 'basys3', { top: 'main', files: { 'main.v': 'module main; endmodule\n' } });
    const r = importUpload([{ name: 'demo.zip', bytes: exportZip(p) }], BOARDS, 'icestick');
    expect(r.vivado).toBe(false);
    expect(r.project).toMatchObject({ name: 'demo', board: 'basys3', top: 'main', files: p.files });
  });
});

describe('expandXdcWildcards', () => {
  it('repeats wildcard get_ports lines for each explicitly pinned port', () => {
    const xdc = [
      'set_property PACKAGE_PIN U2 [get_ports {an[0]}]',
      'set_property PACKAGE_PIN U4 [get_ports {an[1]}]',
      '    set_property IOSTANDARD LVCMOS33 [get_ports {an[*]}]',
      'set_property -dict { PACKAGE_PIN W5 IOSTANDARD LVCMOS33 } [get_ports clk]',
      '# set_property IOSTANDARD LVCMOS33 [get_ports {an[*]}]',
      'set_property IOSTANDARD LVCMOS33 [get_ports {nothing*}]',
    ].join('\n');
    const r = expandXdcWildcards(xdc);
    expect(r.changed).toBe(true);
    expect(r.text.split('\n')).toEqual([
      'set_property PACKAGE_PIN U2 [get_ports {an[0]}]',
      'set_property PACKAGE_PIN U4 [get_ports {an[1]}]',
      '    set_property IOSTANDARD LVCMOS33 [get_ports {an[0]}]',
      '    set_property IOSTANDARD LVCMOS33 [get_ports {an[1]}]',
      'set_property -dict { PACKAGE_PIN W5 IOSTANDARD LVCMOS33 } [get_ports clk]',
      '# set_property IOSTANDARD LVCMOS33 [get_ports {an[*]}]',
      'set_property IOSTANDARD LVCMOS33 [get_ports {nothing*}]',
    ]);
  });
  it('leaves files without wildcards alone', () => {
    const xdc = 'set_property PACKAGE_PIN V17 [get_ports a]\n';
    expect(expandXdcWildcards(xdc)).toEqual({ text: xdc, changed: false });
  });
});

describe('review fixes', () => {
  const tbXpr = (sims: string[], srcs = [file('$PSRCDIR/sources_1/new/top.v')]) => xpr({ srcs, sims });
  it('lower-cases _TB and keeps _tb when numbering clashes', () => {
    const r = importUpload([zip({
      'p/p.xpr': tbXpr([file('$PSRCDIR/sim_1/new/Counter_TB.v'), file('$PSRCDIR/sim_1/new/foo.v'), file('$PSRCDIR/sim_1/a/foo_tb.v')]),
      'p/p.srcs/sources_1/new/top.v': 'module top; endmodule\n',
      'p/p.srcs/sim_1/new/Counter_TB.v': 'module c; endmodule\n',
      'p/p.srcs/sim_1/new/foo.v': 'module f; endmodule\n',
      'p/p.srcs/sim_1/a/foo_tb.v': 'module g; endmodule\n',
    })], BOARDS, 'basys3');
    expect(Object.keys(r.project.files).sort()).toEqual(['Counter_tb.v', 'foo_2_tb.v', 'foo_tb.v', 'top.v']);
  });
  it('reads zips with backslash entry names', () => {
    const r = importUpload([zip({
      'p\\p.xpr': tbXpr([]),
      'p\\p.srcs\\sources_1\\new\\top.v': 'module top; endmodule\n',
    })], BOARDS, 'basys3');
    expect(Object.keys(r.project.files)).toEqual(['top.v']);
  });
  it('guesses a parameterised top', () => {
    const r = importUpload([zip({
      'p/p.xpr': xpr({ top: '', srcs: [file('$PSRCDIR/a.v')] }),
      'p/p.srcs/a.v': 'module top #(parameter N = 4) (input x);\n  leaf u (.x(x));\nendmodule\nmodule leaf(input x); endmodule\n',
    })], BOARDS, 'basys3');
    expect(r.project.top).toBe('top');
  });
  it('treats simulation-only files in the design set as testbenches', () => {
    const r = importUpload([zip({
      'p/p.xpr': xpr({ srcs: [file('$PSRCDIR/top.v'), `      <File Path="$PSRCDIR/check.v">\n        <FileInfo>\n          <Attr Name="UsedIn" Val="simulation"/>\n        </FileInfo>\n      </File>\n`] }),
      'p/p.srcs/top.v': 'module top; endmodule\n',
      'p/p.srcs/check.v': 'module check; endmodule\n',
    })], BOARDS, 'basys3');
    expect(Object.keys(r.project.files).sort()).toEqual(['check_tb.v', 'top.v']);
  });
  it('does not pick a same-named file from an unrelated folder when several exist', () => {
    const r = importUpload([zip({
      'lab/p/p.xpr': xpr({ srcs: [file('$PSRCDIR/sources_1/new/top.v'), file('$PPRDIR/../src/util.v')] }),
      'lab/p/p.srcs/sources_1/new/top.v': 'module top; endmodule\n',
      'old/x/util.v': 'module stale; endmodule\n',
      'old/y/util.v': 'module stale2; endmodule\n',
    })], BOARDS, 'basys3');
    expect(r.notes).toContainEqual({ kind: 'missing', file: 'util.v' });
  });
  it('ignores commented-out ports when expanding wildcards', () => {
    const r = expandXdcWildcards('set_property PACKAGE_PIN U16 [get_ports {led[0]}]\n#set_property PACKAGE_PIN E19 [get_ports {led[1]}]\nset_property IOSTANDARD LVCMOS33 [get_ports {led[*]}]\n');
    expect(r.text).toBe('set_property PACKAGE_PIN U16 [get_ports {led[0]}]\n#set_property PACKAGE_PIN E19 [get_ports {led[1]}]\nset_property IOSTANDARD LVCMOS33 [get_ports {led[0]}]\n');
  });
});
