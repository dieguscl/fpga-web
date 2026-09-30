import { describe, expect, it } from 'vitest';
import { BASYS3_PINS } from '../src/boards/basys3-pins';
import { MANUAL_MARKER, generateXdc, parseXdc } from '../src/xdc';

const APIO_BLINKY = `set_property -dict { PACKAGE_PIN W5    IOSTANDARD LVCMOS33 } [get_ports {clk}]
set_property -dict { PACKAGE_PIN U16   IOSTANDARD LVCMOS33 } [get_ports {leds[0]}]
set_property -dict { PACKAGE_PIN E19   IOSTANDARD LVCMOS33 } [get_ports {leds[1]}]
`;

describe('parseXdc', () => {
  it('maps -dict lines to board signals', () => {
    const m = parseXdc(APIO_BLINKY, BASYS3_PINS);
    expect([...m.assign]).toEqual([['clk', 'clk'], ['led[0]', 'leds[0]'], ['led[1]', 'leds[1]']]);
    expect(m.manual).toEqual([]);
  });

  it('handles single-property lines, bare port names and CRLF', () => {
    const text = 'set_property PACKAGE_PIN V17 [get_ports sw0]\r\nset_property IOSTANDARD LVCMOS33 [get_ports sw0]\r\n';
    const m = parseXdc(text, BASYS3_PINS);
    expect([...m.assign]).toEqual([['sw[0]', 'sw0']]);
    expect(m.manual).toEqual([]);
  });

  it('keeps comments, clocks, unknown pins and config lines as manual', () => {
    const text = [
      '## my header',
      'create_clock -period 10 [get_ports clk]',
      'set_property PACKAGE_PIN W5 [get_ports clk]',
      'set_property -dict { PACKAGE_PIN A1 IOSTANDARD LVCMOS33 } [get_ports weird]',
      'set_property CFGBVS VCCO [current_design]',
      '#set_property -dict { PACKAGE_PIN U16 IOSTANDARD LVCMOS33 } [get_ports {led[0]}]',
    ].join('\n');
    const m = parseXdc(text, BASYS3_PINS);
    expect([...m.assign]).toEqual([['clk', 'clk']]);
    expect(m.manual).toEqual([
      '## my header',
      'create_clock -period 10 [get_ports clk]',
      'set_property -dict { PACKAGE_PIN A1 IOSTANDARD LVCMOS33 } [get_ports weird]',
      'set_property CFGBVS VCCO [current_design]',
      '#set_property -dict { PACKAGE_PIN U16 IOSTANDARD LVCMOS33 } [get_ports {led[0]}]',
    ]);
  });
});

describe('generateXdc', () => {
  it('writes board-ordered lines, pullups, and the manual section; round-trips', () => {
    const model = {
      assign: new Map([['PS2Clk', 'ps2_clk'], ['led[0]', 'leds[0]'], ['clk', 'clk']]),
      manual: ['create_clock -period 10 [get_ports clk]'],
    };
    const text = generateXdc(model, BASYS3_PINS);
    const lines = text.trim().split('\n');
    expect(lines.filter((l) => l.startsWith('set_property'))).toEqual([
      'set_property -dict { PACKAGE_PIN W5 IOSTANDARD LVCMOS33 } [get_ports { clk }]',
      'set_property -dict { PACKAGE_PIN U16 IOSTANDARD LVCMOS33 } [get_ports { leds[0] }]',
      'set_property -dict { PACKAGE_PIN C17 IOSTANDARD LVCMOS33 PULLUP true } [get_ports { ps2_clk }]',
    ]);
    expect(lines).toContain(MANUAL_MARKER);
    const again = parseXdc(text, BASYS3_PINS);
    expect(again.assign).toEqual(model.assign);
    expect(again.manual).toEqual(model.manual);
    expect(generateXdc(again, BASYS3_PINS)).toBe(text);
  });
});
