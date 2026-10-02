/**
 * Finnhub adapter (spec P4 — alternative provider, strongest for US).
 *
 * Free tier: 60 requests/minute, US-focused. Provides real dividends and
 * splits endpoints (RM7/X2/X3), but no bid/ask on the free quote endpoint
 * (the simulator then applies the configured default spread, RM3).
 * [VERIFY] CORS + terms for display-only usage in an app (P8/P9).
 */

import { dateKeyOf } from '../calendar/calendar';
import type { DividendRecord, Instrument, SplitRecord } from '../engine/types';
import { ProviderError, type KeyTestResult, type ProviderAdapter, type ProviderCandle, type ProviderFxPoint, type ProviderQuote } from './provider';

export const FINNHUB_BASE = 'https://finnhub.io/api/v1';

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface FinnhubDeps {
  getKey: () => string | null;
  fetchFn?: FetchFn;
}

export function createFinnhub(deps: FinnhubDeps): ProviderAdapter {
  const fetchFn = deps.fetchFn ?? ((url, init) => fetch(url, init));

  async function api<T>(path: string, params: Record<string, string>): Promise<T> {
    const key = deps.getKey();
    if (!key) throw new ProviderError('auth', 'No API key configured', 'Add your Finnhub API key in Settings → Provider.');
    const usp = new URLSearchParams({ ...params, token: key });
    const url = `${FINNHUB_BASE}/${path}?${usp.toString()}`;
    let res: Response;
    try {
      res = await fetchFn(url, { headers: { Accept: 'application/json' } });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new ProviderError('cors', `Browser request to Finnhub failed: ${msg}`, 'Check your connection or switch providers in Settings.');
    }
    if (res.status === 429) {
      const retry = Number(res.headers.get('retry-after') ?? '60') * 1000;
      throw new ProviderError('rate_limit', 'Finnhub rate limit hit', 'Free tier allows 60 requests/minute.', retry || 60_000);
    }
    if (res.status === 401 || res.status === 403) {
      throw new ProviderError('auth', 'Finnhub rejected the API key', 'Check the key or create a new one at finnhub.io.');
    }
    if (res.status === 404) throw new ProviderError('not_found', 'Finnhub endpoint not found', '');
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new ProviderError('bad_response', `Finnhub returned non-JSON (HTTP ${res.status})`, 'The service may be down; cached data stays available.');
    }
    if (typeof body === 'object' && body !== null && 'error' in body && (body as { error?: string }).error) {
      throw new ProviderError('bad_response', String((body as { error: string }).error), '');
    }
    if (!res.ok) throw new ProviderError('bad_response', `Finnhub HTTP ${res.status}`, '');
    return body as T;
  }

  const adapter: ProviderAdapter = {
    id: 'finnhub',
    name: 'Finnhub',
    coverage: {
      exchanges: ['US'],
      verifiedExchanges: ['US'], // US feed verified with a real free key [VERIFY: re-test per release]
      assetTypes: ['stock', 'etf', 'index'],
      indexQuotes: true,
      forex: true,
      delayed: false,
      cors: 'supported',
      notes:
        'US-focused (stocks, ETFs, indexes, forex). No bid/ask on the free quote endpoint — the app applies the market default spread instead (RM3). Dividends and splits available (RM7).',
    },
    rateLimits: { perMinute: 60, minIntervalMs: 1_100 },

    async testKey(): Promise<KeyTestResult> {
      const r = await api<{ c?: number; t?: number }>('quote', { symbol: 'AAPL' });
      if (typeof r.c !== 'number' || r.c <= 0) {
        throw new ProviderError('bad_response', 'Finnhub returned no price for AAPL', 'The key may be invalid or the service unavailable.');
      }
      return { ok: true, message: 'Key works — received a quote for AAPL.', plan: 'Free tier (60 req/min, US focus)' };
    },

    async search(query: string, limit = 25): Promise<Instrument[]> {
      if (!query.trim()) return [];
      const r = await api<{ result?: { symbol: string; description?: string; type?: string; displaySymbol?: string }[] }>('search', { q: query.trim() });
      const KNOWN = new Set(['Common Stock', 'ETF', 'Index', 'REIT', 'ADR', 'Preference Share', 'Physical ETF']);
      return (r.result ?? [])
        .filter((x) => !!x.symbol && (!x.type || KNOWN.has(x.type)))
        .slice(0, limit)
        .map((x) => {
          const t = (x.type ?? '').toLowerCase();
          const assetType: Instrument['assetType'] = t.includes('etf') ? 'etf' : t.includes('index') ? 'index' : 'stock';
          return {
            symbol: x.symbol,
            exchange: 'US', // Finnhub's feed is US-wide; calendar entry 'US' covers hours
            name: x.description ?? x.symbol,
            currency: 'USD',
            assetType,
            providerId: x.displaySymbol ?? x.symbol,
            provider: 'finnhub',
            isIndex: assetType === 'index',
            sector: null,
          } satisfies Instrument;
        });
    },

    async quote(instrument: Instrument): Promise<ProviderQuote> {
      const r = await api<{ c?: number; h?: number; l?: number; o?: number; pc?: number; t?: number; d?: number; dp?: number }>('quote', {
        symbol: instrument.symbol,
      });
      const price = r.c;
      if (typeof price !== 'number' || price <= 0) {
        throw new ProviderError('not_found', `No quote for ${instrument.symbol}`, 'The symbol may be delisted.');
      }
      return {
        price,
        prevClose: typeof r.pc === 'number' && r.pc > 0 ? r.pc : undefined,
        open: typeof r.o === 'number' && r.o > 0 ? r.o : undefined,
        high: typeof r.h === 'number' && r.h > 0 ? r.h : undefined,
        low: typeof r.l === 'number' && r.l > 0 ? r.l : undefined,
        timestampUtc: typeof r.t === 'number' && r.t > 0 ? new Date(r.t * 1000).toISOString() : new Date().toISOString(),
        delayed: false,
        // free tier: no bid/ask → the simulator uses the default spread (RM3)
      };
    },

    async dailyCandles(instrument: Instrument, fromUtc: Date, toUtc: Date): Promise<ProviderCandle[]> {
      const r = await api<{ s?: string; t?: number[]; o?: number[]; h?: number[]; l?: number[]; c?: number[]; v?: number[] }>('stock/candle', {
        symbol: instrument.symbol,
        resolution: 'D',
        from: String(Math.floor(fromUtc.getTime() / 1000)),
        to: String(Math.floor(toUtc.getTime() / 1000)),
      });
      if (r.s !== 'ok' || !Array.isArray(r.t)) return [];
      const out: ProviderCandle[] = [];
      for (let i = 0; i < r.t.length; i++) {
        const close = r.c?.[i];
        if (typeof close !== 'number' || close <= 0) continue;
        const d = new Date(r.t[i] * 1000);
        // Finnhub daily timestamps may be market open (local) or midnight UTC;
        // taking the later of the exchange-local and UTC dates is correct for
        // both conventions (documented in Learn → data notes).
        const utcKey = d.toISOString().slice(0, 10);
        const localKey = dateKeyOf(d, 'America/New_York');
        const sessionDate = localKey > utcKey ? localKey : utcKey;
        out.push({
          timeUtc: d.toISOString(),
          sessionDate,
          open: r.o?.[i] ?? close,
          high: r.h?.[i] ?? close,
          low: r.l?.[i] ?? close,
          close,
          volume: r.v?.[i] ?? 0,
        });
      }
      return out.sort((a, b) => (a.sessionDate < b.sessionDate ? -1 : 1));
    },

    async fxRate(native: string, base: string): Promise<{ rate: number; timestampUtc: string }> {
      const pair = `${native}/${base}`;
      const r = await api<{ c?: number; t?: number }>('forex/quote', { symbol: pair });
      if (typeof r.c !== 'number' || r.c <= 0) throw new ProviderError('not_found', `No FX rate for ${pair}`, '');
      return { rate: r.c, timestampUtc: typeof r.t === 'number' && r.t > 0 ? new Date(r.t * 1000).toISOString() : new Date().toISOString() };
    },

    async fxCandles(native: string, base: string, fromUtc: Date, toUtc: Date): Promise<ProviderFxPoint[]> {
      const pair = `${native}/${base}`;
      try {
        const r = await api<{ s?: string; t?: number[]; c?: number[] }>('forex/candle', {
          symbol: pair,
          resolution: 'D',
          from: String(Math.floor(fromUtc.getTime() / 1000)),
          to: String(Math.floor(toUtc.getTime() / 1000)),
        });
        if (r.s !== 'ok' || !Array.isArray(r.t)) return [];
        const points: ProviderFxPoint[] = [];
        for (let i = 0; i < r.t.length; i++) {
          const rate = r.c?.[i];
          if (typeof rate !== 'number' || rate <= 0) continue;
          const dateKey = new Date(r.t[i] * 1000).toISOString().slice(0, 10);
          points.push({ dateKey, rate, timeUtc: new Date(r.t[i] * 1000).toISOString() });
        }
        return points.sort((a, b) => (a.dateKey < b.dateKey ? -1 : 1));
      } catch (e) {
        if (e instanceof ProviderError && (e.kind === 'auth' || e.kind === 'rate_limit' || e.kind === 'cors' || e.kind === 'network')) throw e;
        return []; // forex candles not available on this tier → snapshots skip FX dates (R4)
      }
    },

    async dividends(instrument: Instrument, fromUtc: Date, toUtc: Date): Promise<DividendRecord[] | null> {
      try {
        const r = await api<{ amount?: number; exDate?: string; payDate?: string; currency?: string }[] | { error: string }>('stock/dividend', {
          symbol: instrument.symbol,
          from: fromUtc.toISOString().slice(0, 10),
          to: toUtc.toISOString().slice(0, 10),
        });
        if (!Array.isArray(r)) return [];
        return r
          .filter((d) => typeof d.exDate === 'string' && typeof d.amount === 'number')
          .map((d, i) => ({
            id: `fd_${instrument.symbol}_${d.exDate}_${i}`,
            exDate: d.exDate!,
            payDate: typeof d.payDate === 'string' ? d.payDate : d.exDate!,
            amountNativeMinor: Math.round((d.amount as number) * 100),
            currency: d.currency ?? instrument.currency,
          }));
      } catch (e) {
        if (e instanceof ProviderError && (e.kind === 'auth' || e.kind === 'rate_limit' || e.kind === 'cors' || e.kind === 'network')) throw e;
        return [];
      }
    },

    async splits(instrument: Instrument, fromUtc: Date, toUtc: Date): Promise<SplitRecord[] | null> {
      try {
        const r = await api<{ date?: string; numerator?: number; denominator?: number; splitType?: string }[] | { error: string }>('stock/split', {
          symbol: instrument.symbol,
          from: fromUtc.toISOString().slice(0, 10),
          to: toUtc.toISOString().slice(0, 10),
        });
        if (!Array.isArray(r)) return [];
        return r
          .filter((s) => typeof s.date === 'string' && typeof s.numerator === 'number' && typeof s.denominator === 'number')
          .map((s, i) => ({
            id: `fs_${instrument.symbol}_${s.date}_${i}`,
            exDate: s.date!,
            numerator: s.numerator as number,
            denominator: s.denominator as number,
          }));
      } catch (e) {
        if (e instanceof ProviderError && (e.kind === 'auth' || e.kind === 'rate_limit' || e.kind === 'cors' || e.kind === 'network')) throw e;
        return [];
      }
    },
  };

  return adapter;
}
