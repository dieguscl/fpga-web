import { describe, expect, it } from 'vitest';
import { parseLocations } from '../src/errors';

describe('parseLocations', () => {
  it('parses yosys errors', () => {
    expect(parseLocations('main.v:12: ERROR: syntax error, unexpected ;')).toEqual([{ file: 'main.v', line: 12 }]);
  });
  it('parses verilator errors with column and sandbox path', () => {
    expect(parseLocations('%Error: /job/cpu.sv:7:5: Cannot find')).toEqual([{ file: 'cpu.sv', line: 7 }]);
  });
  it('parses constraint files and multiple hits', () => {
    expect(parseLocations('pins.xdc:3 and top.v:4')).toEqual([
      { file: 'pins.xdc', line: 3 },
      { file: 'top.v', line: 4 },
    ]);
  });
  it('ignores non-project extensions', () => {
    expect(parseLocations('/usr/share/yosys/foo.txt:3')).toEqual([]);
  });
});
