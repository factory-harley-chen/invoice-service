import { describe, expect, it } from 'vitest';
import { parseAmount } from './money.ts';

describe('parseAmount', () => {
  it.each([
    ['95.00', 9500],
    ['140.00', 14000],
    ['210.00', 21000],
    ['18.50', 1850],
    ['0.99', 99],
  ])('parses rate-card price %s', (value, expected) => {
    expect(parseAmount(value)).toBe(expected);
  });

  it('accepts a single fractional digit and whole amounts', () => {
    expect(parseAmount('18.5')).toBe(1850);
    expect(parseAmount('74')).toBe(7400);
  });

  it('ignores surrounding whitespace', () => {
    expect(parseAmount(' 22.00 ')).toBe(2200);
  });

  it.each(['', 'abc', '-5.00', '1,000.00', '12.345'])('rejects "%s"', (value) => {
    expect(() => parseAmount(value)).toThrow('Invalid amount');
  });
});
