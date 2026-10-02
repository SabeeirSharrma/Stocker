/**
 * Provider adapter interface (spec P1–P9) + typed errors (X1).
 * Adapters translate provider payloads into neutral shapes; the market-data
 * service (marketdata.ts) converts to integer minor units and caches.
 */

import type { AssetType, DividendRecord, Instrument, SplitRecord } from '../engine/types';

export type ProviderId = 'twelvedata' | 'finnhub' | 'yfinance';

export interface CoverageDescriptor {
  /** exchanges this adapter can return *and* we know about */
  exchanges: string[];
  /** exchanges verified with a real free-tier key (P7) */
  verifiedExchanges: string[];
  assetTypes: AssetType[];
  /** can serve real index quotes (read-only reference, I3) */
  indexQuotes: boolean;
  /** forex capability (F2) */
  forex: boolean;
  /** free tiers are usually delayed (P6) */
  delayed: boolean;
  /** P8 [VERIFY]: direct browser calls; 'blocked' = native-only (CORS) */
  cors: 'supported' | 'unverified' | 'blocked';
  notes: string;
}

export interface RateLimits {
  /** rolling-minute budget */
  perMinute: number;
  perDay?: number;
  /** minimum spacing between requests (ms) */
  minIntervalMs: number;
}

export interface ProviderQuote {
  price: number; // major units (float at the provider boundary only)
  bid?: number;
  ask?: number;
  prevClose?: number;
  open?: number;
  high?: number;
  low?: number;
  volume?: number;
  timestampUtc: string;
  delayed: boolean;
}

export interface ProviderCandle {
  timeUtc: string;
  sessionDate: string; // authoritative trading session date (YYYY-MM-DD)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ProviderFxPoint {
  dateKey: string;
  rate: number;
  timeUtc?: string;
}

export interface KeyTestResult {
  ok: boolean;
  message: string;
  plan?: string;
}

export interface ProviderAdapter {
  id: ProviderId;
  name: string;
  coverage: CoverageDescriptor;
  rateLimits: RateLimits;
  /** P1: key comes from the user, never from the app bundle */
  testKey(): Promise<KeyTestResult>;
  search(query: string, limit?: number): Promise<Instrument[]>;
  quote(instrument: Instrument): Promise<ProviderQuote>;
  dailyCandles(instrument: Instrument, fromUtc: Date, toUtc: Date): Promise<ProviderCandle[]>;
  fxRate(native: string, base: string): Promise<{ rate: number; timestampUtc: string }>;
  fxCandles(native: string, base: string, fromUtc: Date, toUtc: Date): Promise<ProviderFxPoint[]>;
  /** null = provider does not expose this (→ positions flagged, X2/X3) */
  dividends(instrument: Instrument, fromUtc: Date, toUtc: Date): Promise<DividendRecord[] | null>;
  splits(instrument: Instrument, fromUtc: Date, toUtc: Date): Promise<SplitRecord[] | null>;
}

export type ProviderErrorKind = 'auth' | 'rate_limit' | 'network' | 'bad_response' | 'cors' | 'not_found' | 'unsupported';

export class ProviderError extends Error {
  kind: ProviderErrorKind;
  hint: string;
  retryAfterMs?: number;
  constructor(kind: ProviderErrorKind, message: string, hint = '', retryAfterMs?: number) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.hint = hint;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Human-facing guidance for X1 scenarios. */
export function describeProviderError(e: unknown): { title: string; guidance: string } {
  if (e instanceof ProviderError) {
    switch (e.kind) {
      case 'auth':
        return { title: 'API key rejected', guidance: 'Check the key in Settings → Provider. Keys can expire or be reset on the provider’s website. ' + e.hint };
      case 'rate_limit':
        return { title: 'Rate limit reached', guidance: `Your provider's free tier limits request frequency. The app queued the request — try again in a moment. ${e.hint}` };
      case 'cors':
        return { title: 'Blocked by the browser', guidance: 'This provider rejected a browser request (CORS). Use a different provider in Settings.' };
      case 'network':
        return { title: 'Network unavailable', guidance: 'You are offline or the provider is down. The app keeps working with cached data, marked stale.' };
      case 'not_found':
        return { title: 'Symbol not found', guidance: 'The symbol may be delisted or renamed. Try searching again.' };
      case 'unsupported':
        return { title: 'Not supported by this provider', guidance: 'The data you asked for is not exposed by this provider. The app flags affected data instead of guessing.' };
    }
    return { title: 'Data provider error', guidance: e.message };
  }
  return { title: 'Unexpected error', guidance: e instanceof Error ? e.message : String(e) };
}
