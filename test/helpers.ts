/** Shared fixtures for engine/data tests (see spec: deterministic, no network). */

import { createAccount, emptyState, type FillContext, type QuoteData } from '../src/engine/engine';
import { toMinor } from '../src/engine/money';
import type { AppState, Instrument, OrderDraft } from '../src/engine/types';

/** Wednesday 2025-06-04 15:00 UTC = 11:00 ET — NYSE open, a trading day. */
export const NOW = new Date('2025-06-04T15:00:00.000Z');
export const nowMs = (): number => NOW.getTime();
/** Saturday — closed on every exchange in the table. */
export const CLOSED_SATURDAY = new Date('2025-06-07T15:00:00.000Z');

export const AAPL: Instrument = {
  symbol: 'AAPL', exchange: 'NASDAQ', name: 'Apple Inc.', currency: 'USD',
  assetType: 'stock', sector: 'Technology', provider: 'twelvedata', avgDailyVolume: 55_000_000,
};
export const MSFT: Instrument = {
  symbol: 'MSFT', exchange: 'NASDAQ', name: 'Microsoft', currency: 'USD',
  assetType: 'stock', sector: 'Technology', provider: 'twelvedata', avgDailyVolume: 22_000_000,
};
export const RELIANCE: Instrument = {
  symbol: 'RELIANCE', exchange: 'NSE', name: 'Reliance Industries', currency: 'INR',
  assetType: 'stock', sector: 'Energy', provider: 'twelvedata', avgDailyVolume: 8_000_000,
};
export const SPY: Instrument = {
  symbol: 'SPY', exchange: 'NYSE_ARCA', name: 'S&P 500 ETF', currency: 'USD',
  assetType: 'etf', sector: 'Diversified', provider: 'twelvedata', avgDailyVolume: 70_000_000,
};
export const NIFTY_INDEX: Instrument = {
  symbol: 'NIFTY 50', exchange: 'NSE', name: 'Nifty 50 index', currency: 'INR',
  assetType: 'index', isIndex: true, provider: 'twelvedata',
};

/** Fresh AppState with an account; realism off by default so costs are zero. */
export function makeState(
  opts: { realism?: boolean; base?: string; balanceMajor?: number; now?: Date } = {},
): AppState {
  const base = opts.base ?? 'USD';
  const s = emptyState();
  const account = createAccount({
    baseCurrency: base,
    startingBalanceMinor: toMinor(opts.balanceMajor ?? 100_000, 2),
    nowUtc: opts.now ?? NOW,
    settings: { realismMode: opts.realism ?? false },
  });
  return {
    ...s,
    account,
    meta: { ...s.meta, disclaimerAckAtUtc: NOW.toISOString(), onboardingComplete: true },
  };
}

/** Quote at a major-unit price. */
export function quote(priceMajor: number, over: Partial<QuoteData> = {}): QuoteData {
  return {
    priceMinor: toMinor(priceMajor, 2),
    atUtc: NOW.toISOString(),
    delayed: false,
    stale: false,
    ...over,
  };
}

/** FillContext: market open at NOW, same-currency US trade. */
export function ctx(over: Partial<FillContext> = {}): FillContext {
  return {
    nowUtc: NOW,
    quote: quote(190),
    fx: null,
    avgDailyVolume: null,
    marketOpen: true,
    sessionDate: '2025-06-04',
    ...over,
  };
}

export function draft(over: Partial<OrderDraft> & { instrument: Instrument }): OrderDraft {
  return {
    side: 'buy',
    type: 'market',
    duration: 'day',
    qty: 10,
    ...over,
  };
}

export function rid(prefix = 'x'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}
