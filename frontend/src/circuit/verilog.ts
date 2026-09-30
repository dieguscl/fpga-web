// Generate a Verilog module from a drawn circuit.
import { bitsOf, circuitInterface, compDef, inputInverted, parseParts, portName, type Circuit, type Comp, type PlacedPin, type SubInterface } from './model';
import { buildNetlist, type Net, type Netlist } from './netlist';

export interface GenResult {
  verilog: string;
  netlist: Netlist;
  errors: string[]; // problems that make the Verilog invalid (width/drivers)
}

const range = (bits: number) => (bits > 1 ? `[${bits - 1}:0] ` : '');

export function generatedHeader(circuitFile: string): string {
  return `// Generated from ${circuitFile} by the FPGA Web circuit editor.\n// Edit the circuit, not this file: it is rewritten on every change.\n`;
}

export function generateVerilog(moduleName: string, circ: Circuit, subs: Map<string, SubInterface> = new Map(), sourceFile = `${moduleName}.circ`): GenResult {
  const nl = buildNetlist(circ, subs);
  const iface = circuitInterface(circ);
  const errors = nl.problems.filter((p) => p.kind === 'width' || p.kind === 'drivers').map((p) => p.message);

  // Name nets: a port's net takes the port name, others get n<id>.
  const netName = new Map<Net, string>();
  const byY = (a: Comp, b: Comp) => a.y - b.y || a.x - b.x;
  const inputs = circ.components.filter((c) => c.type === 'in' || c.type === 'clock').sort(byY);
  const outputs = circ.components.filter((c) => c.type === 'out').sort(byY);
  const pinOf = (c: Comp, name: string): PlacedPin => nl.pins.find((p) => p.comp === c && p.name === name)!;
  const used = new Set<string>();
  inputs.forEach((c, i) => {
    const n = iface.inputs[i].name;
    used.add(n);
    netName.set(nl.pinNet.get(pinOf(c, 'out'))!, n);
  });
  const outAssigns: string[] = [];
  outputs.forEach((c, i) => {
    const n = iface.outputs[i].name;
    used.add(n);
    const net = nl.pinNet.get(pinOf(c, 'in'))!;
    if (!netName.has(net)) netName.set(net, n);
    else outAssigns.push(`  assign ${n} = ${netName.get(net)};`); // output wired straight to an input or another output
  });
  let k = 0;
  const name = (net: Net) => {
    if (!netName.has(net)) {
      let n = `n${k++}`;
      while (used.has(n)) n = `n${k++}`;
      netName.set(net, n);
    }
    return netName.get(net)!;
  };
  const sig = (c: Comp, pin: string): string => {
    const p = pinOf(c, pin);
    const net = nl.pinNet.get(p)!;
    if (!net.driver && p.dir === 'in') return `${p.bits}'b0`; // unconnected input reads as 0
    return name(net);
  };

  const body: string[] = [];
  const regs: string[] = [];
  let inst = 0;
  const ops: Record<string, string> = { and: '&', or: '|', xor: '^', nand: '&', nor: '|', xnor: '^' };
  for (const c of [...circ.components].sort(byY)) {
    const b = bitsOf(c);
    const def = compDef(c, subs);
    const label = c.props.label ? ` // ${c.props.label.replace(/[\r\n]/g, ' ')}` : '';
    switch (c.type) {
      case 'in': case 'clock': case 'out':
        break;
      case 'led':
        break; // visual only
      case 'const':
        body.push(`  assign ${sig(c, 'out')} = ${b}'d${Math.max(0, Math.trunc(c.props.value ?? 0)) % 2 ** b};${label}`);
        break;
      case 'not':
        body.push(`  assign ${sig(c, 'y')} = ~${sig(c, 'a')};${label}`);
        break;
      case 'and': case 'or': case 'xor': case 'nand': case 'nor': case 'xnor': {
        const ins = def.pins.filter((p) => p.dir === 'in').map((p, i) => (inputInverted(c, i) ? '~' : '') + sig(c, p.name)).join(` ${ops[c.type]} `);
        const neg = c.type.startsWith('n') || c.type === 'xnor';
        body.push(`  assign ${sig(c, 'y')} = ${neg ? `~(${ins})` : ins};${label}`);
        break;
      }
      case 'mux': {
        const n = def.pins.filter((p) => p.name.startsWith('d')).length;
        const ds = Array.from({ length: n }, (_, i) => sig(c, `d${i}`));
        const s = sig(c, 'sel');
        const expr = n === 2 ? `${s} ? ${ds[1]} : ${ds[0]}` : `${s} == 2'd0 ? ${ds[0]} : ${s} == 2'd1 ? ${ds[1]} : ${s} == 2'd2 ? ${ds[2]} : ${ds[3]}`;
        body.push(`  assign ${sig(c, 'y')} = ${expr};${label}`);
        break;
      }
      case 'adder':
        body.push(`  assign {${sig(c, 'co')}, ${sig(c, 's')}} = ${sig(c, 'a')} + ${sig(c, 'b')} + ${sig(c, 'ci')};${label}`);
        break;
      case 'dff': {
        const r = `r${inst++}`;
        regs.push(`  reg ${range(b)}${r} = 0;`);
        body.push(`  always @(posedge ${sig(c, 'c')}) ${r} <= ${sig(c, 'd')};${label}`);
        body.push(`  assign ${sig(c, 'q')} = ${r};`, `  assign ${sig(c, 'nq')} = ~${r};`);
        break;
      }
      case 'register': {
        const r = `r${inst++}`;
        regs.push(`  reg ${range(b)}${r} = 0;`);
        body.push(`  always @(posedge ${sig(c, 'c')}) if (${sig(c, 'en')}) ${r} <= ${sig(c, 'd')};${label}`);
        body.push(`  assign ${sig(c, 'q')} = ${r};`);
        break;
      }
      case 'counter': {
        const r = `r${inst++}`;
        regs.push(`  reg ${range(b)}${r} = 0;`);
        body.push(`  always @(posedge ${sig(c, 'c')}) if (${sig(c, 'clr')}) ${r} <= 0; else if (${sig(c, 'en')}) ${r} <= ${r} + 1'b1;${label}`);
        body.push(`  assign ${sig(c, 'q')} = ${r};`, `  assign ${sig(c, 'ovf')} = ${sig(c, 'en')} & (&${r});`);
        break;
      }
      case 'split': {
        const parts = parseParts(c.props.parts, b);
        let lo = 0;
        parts.forEach((w, i) => {
          const src = sig(c, 'in');
          body.push(`  assign ${sig(c, `o${i}`)} = ${src.includes("'") ? `${w}'b0` : `${src}[${lo + w - 1}:${lo}]`};`);
          lo += w;
        });
        break;
      }
      case 'merge': {
        const parts = parseParts(c.props.parts, b);
        const pieces = parts.map((_, i) => sig(c, `i${i}`)).reverse().join(', ');
        body.push(`  assign ${sig(c, 'out')} = {${pieces}};`);
        break;
      }
      case 'sub': {
        const mod = (c.props.circuit ?? '').replace(/[^A-Za-z0-9_]/g, '_');
        const conns = def.pins.map((p) => `.${p.name}(${sig(c, p.name)})`).join(', ');
        body.push(`  ${mod} u${inst++}_${mod} (${conns});`);
        break;
      }
    }
  }

  const ports = [
    ...inputs.map((c, i) => `  input  wire ${range(iface.inputs[i].bits)}${iface.inputs[i].name}`),
    ...outputs.map((c, i) => `  output wire ${range(iface.outputs[i].bits)}${iface.outputs[i].name}`),
  ];
  const wires = [...netName.entries()]
    .filter(([, n]) => !used.has(n))
    .map(([net, n]) => `  wire ${range(net.width)}${n};`);
  const lines = [
    generatedHeader(sourceFile),
    `module ${moduleName} (`,
    ports.join(',\n'),
    ');',
    ...wires,
    ...regs,
    ...(wires.length || regs.length ? [''] : []),
    ...body,
    ...outAssigns,
    'endmodule',
    '',
  ];
  return { verilog: lines.join('\n'), netlist: nl, errors };
}
