import { describe, expect, it } from 'vitest';
import { plainQuotes } from '../src/editor';

describe('plainQuotes (paste filter)', () => {
  it('turns typographic quotes and dashes into plain ASCII', () => {
    expect(plainQuotes('S = 2’b00; D = 4‘b0001; $display(“hi”); x = a – b; y​')).toBe(
      'S = 2\'b00; D = 4\'b0001; $display("hi"); x = a - b; y');
    expect(plainQuotes('ação ok')).toBe('ação ok');
  });
});
