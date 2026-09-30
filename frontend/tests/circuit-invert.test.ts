import { describe, expect, it } from 'vitest';
import type { Circuit } from '../src/circuit/model';
import { CircuitSim } from '../src/circuit/sim';
import { generateVerilog } from '../src/circuit/verilog';
import { AND_CIRCUIT } from './circuit-fixtures';

// AND gate with its second input negated: y = a & ~b
const withInvert = (invert: number[]): Circuit => ({
  ...AND_CIRCUIT,
  components: AND_CIRCUIT.components.map((c) => (c.id === 'g' ? { ...c, props: { ...c.props, invert } } : c)),
});
const y = (sim: CircuitSim, circ: Circuit) => sim.pinValue(circ.components.find((c) => c.id === 'y')!, 'in');

describe('negated gate inputs', () => {
  it('simulates y = a & ~b', () => {
    const circ = withInvert([1]);
    const sim = new CircuitSim(circ);
    expect(y(sim, circ)).toBe(0);
    sim.toggle('a');
    expect(y(sim, circ)).toBe(1); // a=1, b=0
    sim.toggle('b');
    expect(y(sim, circ)).toBe(0); // a=1, b=1
  });

  it('negates only the chosen inputs in the generated Verilog', () => {
    const v = generateVerilog('top', withInvert([1])).verilog;
    expect(v).toMatch(/assign \S+ = \S+ & ~\S+;/);
    expect(generateVerilog('top', withInvert([0, 1])).verilog).toMatch(/assign \S+ = ~\S+ & ~\S+;/);
    expect(generateVerilog('top', AND_CIRCUIT).verilog).not.toContain('~');
  });
});
