/**
 * Money handling — spec W4 / W5.
 *
 * W4: ALL money values (balances, prices, price×qty, P&L, fees) are integers in
 *     the *minor units* of their currency (cents, paise, ...). Floating point is
 *     never used to store a money value.
 * W5: The single rounding rule of the whole app is **round half to even**
 *     (banker's rounding). It is applied whenever a non-integer must become an
 *     integer minor-unit value. Every path that loses precision goes through
 *     `mulDivRound` (exact, BigInt-backed integer arithmetic) or
 *     `roundHalfEven`. See `test/money.test.ts` for the executable definition.
 *
 * FX rates are *rates*, not money: they are quantised to 1e-8 (1e8 is
 * `RATE_SCALE`) on receipt so that conversion is exact integer arithmetic and
 * fully reproducible (determinism, R5).
 */

export type Minor = number;

export const RATE_SCALE = 100_000_000;

export interface CurrencyDef {
  code: string;
  name: string;
  symbol: string;
  /** number of minor units per major unit = 10^exponent */
  exponent: number;
  grouping: 'western' | 'indian';
}

export const CURRENCIES: Record<string, CurrencyDef> = {
  USD: { code: 'USD', name: 'US Dollar', symbol: '$', exponent: 2, grouping: 'western' },
  INR: { code: 'INR', name: 'Indian Rupee', symbol: '₹', exponent: 2, grouping: 'indian' },
  EUR: { code: 'EUR', name: 'Euro', symbol: '€', exponent: 2, grouping: 'western' },
  GBP: { code: 'GBP', name: 'British Pound', symbol: '£', exponent: 2, grouping: 'western' },
  JPY: { code: 'JPY', name: 'Japanese Yen', symbol: '¥', exponent: 0, grouping: 'western' },
  AUD: { code: 'AUD', name: 'Australian Dollar', symbol: 'A$', exponent: 2, grouping: 'western' },
  CAD: { code: 'CAD', name: 'Canadian Dollar', symbol: 'C$', exponent: 2, grouping: 'western' },
  CHF: { code: 'CHF', name: 'Swiss Franc', symbol: 'CHF', exponent: 2, grouping: 'western' },
  CNY: { code: 'CNY', name: 'Chinese Yuan', symbol: '¥', exponent: 2, grouping: 'western' },
  HKD: { code: 'HKD', name: 'Hong Kong Dollar', symbol: 'HK$', exponent: 2, grouping: 'western' },
  SGD: { code: 'SGD', name: 'Singapore Dollar', symbol: 'S$', exponent: 2, grouping: 'western' },
  KRW: { code: 'KRW', name: 'South Korean Won', symbol: '₩', exponent: 0, grouping: 'western' },
  AED: { code: 'AED', name: 'UAE Dirham', symbol: 'د.إ', exponent: 2, grouping: 'western' },
  BRL: { code: 'BRL', name: 'Brazilian Real', symbol: 'R$', exponent: 2, grouping: 'western' },
};

export function currencyExponent(code: string): number {
  const c = CURRENCIES[code];
  if (!c) throw new Error(`Unknown currency: ${code}`);
  return c.exponent;
}

/** Round half to even (banker's rounding) — THE rounding rule of this app (W5). */
export function roundHalfEven(x: number): number {
  if (!Number.isFinite(x)) throw new Error('roundHalfEven: non-finite input');
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  // exact tie: pick the even neighbour
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * Exact integer computation of round-half-even(a * b / den) using BigInt so no
 * intermediate product can overflow IEEE-754 doubles. All inputs must be
 * integers (b may be negative, den > 0).
 */
export function mulDivRound(a: number, b: number, den: number): number {
  assertInt(a, 'a');
  assertInt(b, 'b');
  assertInt(den, 'den');
  if (den === 0) throw new Error('mulDivRound: division by zero');
  const A = BigInt(a);
  const B = BigInt(b);
  const D = BigInt(den);
  const num = A * B;
  const negative = num < 0n;
  const abs = negative ? -num : num;
  const absD = D < 0n ? -D : D;
  const q = abs / absD;
  const r = abs % absD;
  const twice = r * 2n;
  let out: bigint;
  if (twice > absD) out = q + 1n;
  else if (twice < absD) out = q;
  else out = q % 2n === 0n ? q : q + 1n; // tie → even
  return Number(negative ? -out : out);
}

function assertInt(v: number, name: string): void {
  if (!Number.isInteger(v)) throw new Error(`mulDivRound: ${name} must be an integer, got ${v}`);
}

/** amount * bps / 10000, round half to even. bps may be fractional? no — integer bps. */
export function applyBps(amount: Minor, bps: number): Minor {
  return mulDivRound(amount, Math.round(bps), 10_000);
}

/** Quantise an FX rate to 1e-8 so all conversions are exact integer arithmetic. */
export function quantizeRate(rate: number): number {
  if (!Number.isFinite(rate) || rate <= 0) throw new Error(`Invalid FX rate: ${rate}`);
  return Math.round(rate * RATE_SCALE) / RATE_SCALE;
}

/** Convert a minor-unit amount in currency A to currency B at `rate` (A→B). */
export function convertMinor(amount: Minor, rate: number): Minor {
  const q = quantizeRate(rate);
  return mulDivRound(amount, Math.round(q * RATE_SCALE), RATE_SCALE);
}

/**
 * Parse a decimal string/number of *major* units into integer minor units.
 * Extra fractional digits are rounded half to even (W5).
 */
export function toMinor(major: string | number, exponent: number): Minor {
  const s = typeof major === 'number' ? majorToPlainString(major) : major.trim();
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) throw new Error(`Invalid money amount: "${s}"`);
  const sign = m[1] === '-' ? -1 : 1;
  const intPart = m[2] || '0';
  const fracRaw = m[3] || '';
  const frac = fracRaw.slice(0, exponent).padEnd(exponent, '0');
  const rest = fracRaw.slice(exponent);
  let value = Number(intPart) * Math.pow(10, exponent) + Number(frac === '' ? '0' : frac);
  if (!Number.isSafeInteger(value)) {
    // fall back to BigInt for very large inputs
    const big =
      BigInt(intPart) * 10n ** BigInt(exponent) +
      (frac === '' ? 0n : BigInt(frac));
    let v = big;
    if (rest !== '') {
      const tie = rest.replace(/0+$/, '');
      const restVal = Number('0.' + tie);
      const cmp = restVal > 0.5 ? 1 : restVal < 0.5 ? -1 : 0;
      if (cmp > 0) v += 1n;
      else if (cmp === 0 && v % 2n !== 0n) v += 1n;
    }
    return sign * Number(v);
  }
  if (rest !== '') {
    const trimmed = rest.replace(/0+$/, '');
    const restVal = Number('0.' + trimmed);
    if (restVal > 0.5) value += 1;
    else if (restVal === 0.5) value = value % 2 === 0 ? value : value + 1;
  }
  return sign * value;
}

function majorToPlainString(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`Invalid money number: ${n}`);
  const s = String(n);
  if (s.includes('e') || s.includes('E')) return n.toFixed(12).replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

/** Integer minor units → decimal string of major units (no formatting). */
export function toMajorString(minor: Minor, exponent: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  if (exponent === 0) return sign + String(abs);
  const s = String(abs).padStart(exponent + 1, '0');
  return sign + s.slice(0, -exponent) + '.' + s.slice(-exponent);
}

/** Format money for display (U3). Locale is chosen per-currency for correct grouping. */
export function formatMinor(
  minor: Minor,
  currencyCode: string,
  opts: { locale?: string; withSymbol?: boolean; maxFractionDigits?: number } = {},
): string {
  const def = CURRENCIES[currencyCode];
  const exponent = def ? def.exponent : 2;
  const locale =
    opts.locale ??
    (def?.grouping === 'indian' ? 'en-IN' : typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en-US');
  const value = Number(toMajorString(minor, exponent));
  try {
    return new Intl.NumberFormat(locale, {
      style: opts.withSymbol === false ? 'decimal' : 'currency',
      currency: opts.withSymbol === false ? undefined : currencyCode,
      minimumFractionDigits: opts.maxFractionDigits ?? Math.min(exponent, 2),
      maximumFractionDigits: opts.maxFractionDigits ?? Math.min(exponent, 2),
    }).format(value);
  } catch {
    return `${currencyCode} ${toMajorString(minor, exponent)}`;
  }
}

/** Plain locale-aware number formatting (quantities, volumes). */
export function formatNumber(n: number, locale?: string, maxFrac = 0): string {
  try {
    return new Intl.NumberFormat(locale ?? (typeof navigator !== 'undefined' ? navigator.language : 'en-US'), {
      maximumFractionDigits: maxFrac,
    }).format(n);
  } catch {
    return String(n);
  }
}

/** Percentage string from a ratio, half-even rounded to 2 dp. */
export function formatPercent(ratio: number, locale?: string): string {
  try {
    return new Intl.NumberFormat(locale ?? (typeof navigator !== 'undefined' ? navigator.language : 'en-US'), {
      style: 'percent',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(ratio);
  } catch {
    return `${(ratio * 100).toFixed(2)}%`;
  }
}

/** +/− sign for deltas. Color is never the only indicator (U4) — sign is always shown. */
export function signedMinor(minor: Minor): string {
  return minor > 0 ? `+${minor}` : String(minor);
}
