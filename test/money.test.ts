import { describe, expect, it } from 'vitest';
import {
  applyBps, convertMinor, formatMinor, mulDivRound, quantizeRate, roundHalfEven, toMajorString, toMinor,
} from '../src/engine/money';

describe('W5 rounding rule: round half to even', () => {
  it('rounds ties to the even neighbour', () => {
    expect(roundHalfEven(0.5)).toBe(0);
    expect(roundHalfEven(1.5)).toBe(2);
    expect(roundHalfEven(2.5)).toBe(2);
    expect(roundHalfEven(3.5)).toBe(4);
    expect(roundHalfEven(-0.5)).toBe(0);
    expect(roundHalfEven(-1.5)).toBe(-2);
    expect(roundHalfEven(-2.5)).toBe(-2);
  });

  it('rounds non-ties normally', () => {
    expect(roundHalfEven(0.4999)).toBe(0);
    expect(roundHalfEven(0.5001)).toBe(1);
    expect(roundHalfEven(-1.4)).toBe(-1);
    expect(roundHalfEven(-1.6)).toBe(-2);
  });

  it('mulDivRound implements half-even with exact integer math', () => {
    expect(mulDivRound(3, 1, 2)).toBe(2); // 1.5 → 2
    expect(mulDivRound(5, 1, 2)).toBe(2); // 2.5 → 2
    expect(mulDivRound(7, 1, 2)).toBe(4); // 3.5 → 4
    expect(mulDivRound(1, 1, 3)).toBe(0); // 0.333
    expect(mulDivRound(2, 1, 3)).toBe(1); // 0.667
    expect(mulDivRound(-3, 1, 2)).toBe(-2); // -1.5 → -2 (even)
    expect(mulDivRound(-5, 1, 2)).toBe(-2); // -2.5 → -2
    expect(mulDivRound(1, -3, 2)).toBe(-2); // -1.5 → -2
  });

  it('mulDivRound survives products beyond 2^53', () => {
    const big = 9_007_199_254_740_991; // Number.MAX_SAFE_INTEGER
    expect(mulDivRound(big, 4, 2)).toBe(big * 2); // exact via BigInt
    expect(mulDivRound(big, 1, 1)).toBe(big);
    expect(mulDivRound(big, 2, 4)).toBe(4_503_599_627_370_496); // 4.503…e15 .5 tie → even
    expect(Number.isSafeInteger(mulDivRound(big, 999_999, 1_000_001))).toBe(true);
  });

  it('rejects non-integer inputs', () => {
    expect(() => mulDivRound(1.5, 1, 2)).toThrow();
    expect(() => mulDivRound(1, 1, 0)).toThrow();
  });
});

describe('W4 minor units', () => {
  it('parses decimal strings exactly with half-even for extra digits', () => {
    expect(toMinor('123.45', 2)).toBe(12345);
    expect(toMinor('123.456', 2)).toBe(12346); // 123.456 → .46
    expect(toMinor('0.005', 2)).toBe(0); // tie → even
    expect(toMinor('0.015', 2)).toBe(2); // 1.5 cents → 2
    expect(toMinor('0.025', 2)).toBe(2); // 2.5 → 2
    expect(toMinor('-10.999', 2)).toBe(-1100); // -1099.9 cents → -1100 (half-even)
    expect(toMinor('1000', 2)).toBe(100000);
    expect(toMinor('0', 0)).toBe(0);
    expect(toMinor('1234.5', 0)).toBe(1234); // 1234.5 tie → even
  });

  it('rejects garbage', () => {
    expect(() => toMinor('abc', 2)).toThrow();
    expect(() => toMinor('', 2)).toThrow();
    expect(() => toMinor('1.2.3', 2)).toThrow();
  });

  it('formats back to major units', () => {
    expect(toMajorString(12345, 2)).toBe('123.45');
    expect(toMajorString(5, 2)).toBe('0.05');
    expect(toMajorString(-7, 2)).toBe('-0.07');
    expect(toMajorString(1234, 0)).toBe('1234');
  });

  it('roundtrips parse → format', () => {
    for (const s of ['0.01', '1.23', '999999.99', '0.00']) {
      expect(toMajorString(toMinor(s, 2), 2)).toBe(Number(s).toFixed(2));
    }
  });
});

describe('FX conversion (F1/F4)', () => {
  it('quantises rates to 1e-8 and converts exactly', () => {
    expect(quantizeRate(83.123456789)).toBe(83.12345679);
    expect(convertMinor(100_000, 83.5)).toBe(8_350_000);
  });

  it('half-even on conversion ties', () => {
    expect(convertMinor(1, 0.5)).toBe(0); // 0.5 → 0
    expect(convertMinor(3, 0.5)).toBe(2); // 1.5 → 2
    expect(convertMinor(5, 0.5)).toBe(2); // 2.5 → 2
  });

  it('is deterministic (reproducible fills, R5)', () => {
    const a = convertMinor(1_234_567, 123.45678912);
    const b = convertMinor(1_234_567, 123.45678912);
    expect(a).toBe(b);
  });
});

describe('bps fees (RM2)', () => {
  it('applies basis points with half-even', () => {
    expect(applyBps(1_000_000, 500)).toBe(50_000); // 5%
    expect(applyBps(100, 1)).toBe(0); // 0.01 → 0
    expect(applyBps(100_000, 1)).toBe(10);
    expect(applyBps(10, 150)).toBe(0); // 0.15 → 0
    expect(applyBps(1_000, 150)).toBe(15);
  });
});

describe('U3 formatting', () => {
  it('uses Indian grouping for INR', () => {
    // 123456789 paise = ₹12,34,567.89 (lakh/crore grouping)
    const s = formatMinor(123456789, 'INR');
    expect(s).toContain('12,34,567.89');
  });

  it('uses western grouping for USD', () => {
    const s = formatMinor(123456789, 'USD');
    expect(s).toContain('1,234,567.89');
  });

  it('JPY has no fraction digits', () => {
    expect(toMajorString(1234, 0)).toBe('1234');
  });
});
