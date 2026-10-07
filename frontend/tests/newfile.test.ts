import { describe, expect, it } from 'vitest';
import { checkStem, planNewFile, starterContent } from '../src/newfile';

describe('new file by kind', () => {
  it('numbers default names past existing files', () => {
    expect(planNewFile('module', {}, '.xdc', 'top')).toMatchObject({ name: 'module1.v', stem: 'module1', ext: '.v', fixed: false });
    expect(planNewFile('module', { 'module1.v': '' }, '.xdc', 'top').name).toBe('module2.v');
    expect(planNewFile('header', {}, '.xdc', 'top').name).toBe('defines1.vh');
    expect(planNewFile('memory', {}, '.xdc', 'top').name).toBe('data1.mem');
    expect(planNewFile('circuit', {}, '.xdc', 'top').name).toBe('circuit1.circ');
  });

  it('uses the board constraint extension and reopens an existing constraint file', () => {
    expect(planNewFile('constraints', {}, '.pcf', 'top')).toMatchObject({ name: 'pins.pcf', exists: false });
    expect(planNewFile('constraints', { 'basys3.xdc': '' }, '.xdc', 'top')).toMatchObject({ name: 'basys3.xdc', exists: true, fixed: true });
  });

  it('names testbenches after the top module', () => {
    expect(planNewFile('testbench', {}, '.xdc', 'counter')).toMatchObject({ name: 'counter_tb.v', fixed: true, exists: false });
    expect(planNewFile('testbench', { 'counter_tb.v': '' }, '.xdc', 'counter').exists).toBe(true);
  });

  it('checks edited names', () => {
    expect(checkStem('module', 'my counter', '.v', {})).toBe('invalid');
    expect(checkStem('module', '1abc', '.v', {})).toBe('invalid');
    expect(checkStem('module', 'abc', '.v', { 'abc.v': '' })).toBe('exists');
    expect(checkStem('memory', 'rom-1', '.mem', {})).toBeNull();
  });

  it('starts module files with a module of the same name', () => {
    expect(starterContent('module', 'alu', '.v', 'basys3')).toMatch(/^module alu \(/);
    expect(starterContent('constraints', 'pins', '.xdc', 'basys3')).toContain('basys3');
  });
});
