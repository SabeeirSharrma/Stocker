/**
 * Twelve Data adapter (spec P4 — default provider: one key covers stocks,
 * ETFs and forex across many exchanges).
 *
 * Free tier: 8 requests/min, 800/day, usually delayed data (P6).
 * [VERIFY] free-tier coverage of NSE/BSE and other non-US exchanges (P7).
 * [VERIFY] direct browser (CORS) access (P8). Display-only usage (P9).
 */

import type {
  DividendRecord, Instrument, SplitRecord,
} from '../engine/types';
import { ProviderError, type KeyTestResult, type ProviderAdapter, type ProviderCandle, type ProviderFxPoint, type ProviderQuote } from './provider';

export const TWELVEDATA_BASE = 'https://api.twelvedata.com';

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface TwelvedataDeps {
  getKey: () => string | null;
  fetchFn?: FetchFn;
}

interface TdErrorBody {
  code?: number | string;
  message?: string;
  status?: string;
}

function isErrorBody(v: unknown): v is TdErrorBody {
  return typeof v === 'object' && v !== null && ('status' in v || 'code' in v);
}

export function createTwelveData(deps: TwelvedataDeps): ProviderAdapter {
  const fetchFn = deps.fetchFn ?? ((url, init) => fetch(url, init));

  async function api<T>(path: string, params: Record<string, string>): Promise<T> {
    const key = deps.getKey();
    if (!key) throw new ProviderError('auth', 'No API key configured', 'Add your Twelve Data API key in Settings → Provider.');
    const usp = new URLSearchParams({ ...params, apikey: key });
    const url = `${TWELVEDATA_BASE}/${path}?${usp.toString()}`;
    let res: Response;
    try {
      res = await fetchFn(url, { headers: { Accept: 'application/json' } });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new ProviderError('cors', `Browser request to Twelve Data failed: ${msg}`, 'Twelve Data normally allows browser calls; check your connection or try the other provider (P8).');
    }
    if (res.status === 429) {
      const retry = Number(res.headers.get('retry-after') ?? '60') * 1000;
      throw new ProviderError('rate_limit', 'Twelve Data rate limit hit', 'Free tier allows 8 requests/minute.', retry || 60_000);
    }
    if (res.status === 401 || res.status === 403) {
      throw new ProviderError('auth', 'Twelve Data rejected the API key', 'Check the key or create a new one at twelvedata.com.');
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new ProviderError('bad_response', `Twelve Data returned non-JSON (HTTP ${res.status})`, 'The service may be down; cached data stays available.');
    }
    if (isErrorBody(body) && (body.status === 'error' || body.code)) {
      const code = String(body.code ?? '');
      const message = String(body.message ?? 'provider error');
      if (code === '401' || code === '403' || /api key/i.test(message)) {
        throw new ProviderError('auth', message, 'Check the key in Settings → Provider.');
      }
      if (code === '429' || /rate limit|too many/i.test(message)) {
        throw new ProviderError('rate_limit', message, 'Free tier allows 8 requests/minute.', 60_000);
      }
      if (code === '404' || /not found|invalid symbol/i.test(message)) {
        throw new ProviderError('not_found', message, 'The symbol may be delisted or misspelled (X2).');
      }
      throw new ProviderError('bad_response', message, '');
    }
    if (!res.ok) throw new ProviderError('bad_response', `Twelve Data HTTP ${res.status}`, '');
    return body as T;
  }

  const coverage = {
    exchanges: ['NASDAQ', 'NYSE', 'AMEX', 'NYSE_ARCA', 'NSE', 'BSE', 'LSE', 'HKEX', 'FWB', 'TSE', 'TSX'],
    verifiedExchanges: [], // [VERIFY] run a real free key before promoting exchanges here (P7)
    assetTypes: ['stock', 'etf', 'index'] as const,
    indexQuotes: true,
    forex: true,
    delayed: true,
    cors: 'supported' as const,
    notes:
      'One key covers stocks, ETFs and forex across many exchanges. Free tier is delayed (P6). Exchange coverage per tier must be verified with a real free key (P7).',
  };

  const adapter: ProviderAdapter = {
    id: 'twelvedata',
    name: 'Twelve Data',
    coverage: { ...coverage, assetTypes: [...coverage.assetTypes] },
    rateLimits: { perMinute: 8, perDay: 800, minIntervalMs: 7_500 },

    async testKey(): Promise<KeyTestResult> {
      const r = await api<{ code?: number; message?: string; status?: string; meta?: unknown }>('quote', { symbol: 'AAPL', exchange: 'NASDAQ' });
      if (isErrorBody(r) && r.status === 'error') throw new ProviderError('bad_response', String(r.message ?? 'test failed'), '');
      return { ok: true, message: 'Key works — received a live quote for AAPL.', plan: 'Free tier (delayed data, 8 req/min)' };
    },

    async search(query: string, limit = 25): Promise<Instrument[]> {
      if (!query.trim()) return [];
      const r = await api<{ results?: { symbol: string; instrument_type?: string; exchange?: string; currency?: string; country?: string; type?: string }[] }>('search', {
        symbol: query.trim(),
        outputsize: String(limit),
      });
      return (r.results ?? []).map((x) => {
        const type = (x.instrument_type ?? x.type ?? 'Stock').toLowerCase();
        const assetType = type.includes('etf') ? 'etf' : type.includes('index') ? 'index' : 'stock';
        return {
          symbol: x.symbol,
          exchange: x.exchange ?? 'US',
          name: x.symbol,
          currency: x.currency ?? 'USD',
          assetType: assetType as Instrument['assetType'],
          providerId: x.symbol,
          provider: 'twelvedata',
          isIndex: assetType === 'index',
          sector: null,
        } satisfies Instrument;
      });
    },

    async quote(instrument: Instrument): Promise<ProviderQuote> {
      const r = await api<{
        close?: string; previous_close?: string; open?: string; high?: string; low?: string;
        volume?: string; datetime?: string; average_volume?: string; fifty_two_week?: { low?: string; high?: string };
      }>('quote', { symbol: instrument.symbol, ...(instrument.exchange !== 'US' ? { exchange: instrument.exchange } : {}) });
      const price = Number(r.close);
      if (!Number.isFinite(price) || price <= 0) throw new ProviderError('bad_response', 'Twelve Data returned no price', '');
      const iso = r.datetime ? normaliseTdDatetime(r.datetime) : new Date().toISOString();
      return {
        price,
        prevClose: num(r.previous_close),
        open: num(r.open),
        high: num(r.high),
        low: num(r.low),
        volume: num(r.volume),
        timestampUtc: iso,
        delayed: true,
      };
    },

    async dailyCandles(instrument: Instrument, fromUtc: Date, toUtc: Date): Promise<ProviderCandle[]> {
      const r = await api<{ values?: { datetime: string; open: string; high: string; low: string; close: string; volume?: string }[] }>('time_series', {
        symbol: instrument.symbol,
        ...(instrument.exchange !== 'US' ? { exchange: instrument.exchange } : {}),
        interval: '1day',
        start_date: fromUtc.toISOString().slice(0, 10),
        end_date: toUtc.toISOString().slice(0, 10),
        outputsize: '5000',
      });
      const values = (r.values ?? []).slice().reverse(); // API returns newest first
      const out: ProviderCandle[] = [];
      for (const v of values) {
        const close = Number(v.close);
        if (!Number.isFinite(close) || close <= 0) continue;
        const open = Number(v.open);
        const high = Number(v.high);
        const low = Number(v.low);
        const sessionDate = v.datetime.slice(0, 10);
        out.push({
          timeUtc: `${sessionDate}T00:00:00.000Z`,
          sessionDate,
          open: Number.isFinite(open) && open > 0 ? open : close,
          high: Number.isFinite(high) && high > 0 ? high : close,
          low: Number.isFinite(low) && low > 0 ? low : close,
          close,
          volume: num(v.volume) ?? 0,
        });
      }
      return out;
    },

    async fxRate(native: string, base: string): Promise<{ rate: number; timestampUtc: string }> {
      const direct = `${native}/${base}`;
      try {
        const r = await api<{ close?: string; datetime?: string }>('price', { symbol: direct });
        const rate = Number(r.close);
        if (Number.isFinite(rate) && rate > 0) return { rate, timestampUtc: r.datetime ? normaliseTdDatetime(r.datetime) : new Date().toISOString() };
      } catch (e) {
        if (!(e instanceof ProviderError) || (e.kind !== 'not_found' && e.kind !== 'bad_response' && e.kind !== 'auth')) throw e;
      }
      // fallback: inverted pair
      const r = await api<{ close?: string; datetime?: string }>('price', { symbol: `${base}/${native}` });
      const inv = Number(r.close);
      if (!Number.isFinite(inv) || inv <= 0) throw new ProviderError('not_found', `No FX rate for ${native}/${base}`, '');
      return { rate: 1 / inv, timestampUtc: r.datetime ? normaliseTdDatetime(r.datetime) : new Date().toISOString() };
    },

    async fxCandles(native: string, base: string, fromUtc: Date, toUtc: Date): Promise<ProviderFxPoint[]> {
      const collect = async (pair: string, invert: boolean): Promise<ProviderFxPoint[]> => {
        const r = await api<{ values?: { datetime: string; close: string }[] }>('time_series', {
          symbol: pair,
          interval: '1day',
          start_date: fromUtc.toISOString().slice(0, 10),
          end_date: toUtc.toISOString().slice(0, 10),
          outputsize: '5000',
        });
        const points: ProviderFxPoint[] = [];
        for (const v of r.values ?? []) {
          const c = Number(v.close);
          if (!Number.isFinite(c) || c <= 0) continue;
          const dateKey = v.datetime.slice(0, 10);
          points.push({ dateKey, rate: invert ? 1 / c : c, timeUtc: `${dateKey}T00:00:00.000Z` });
        }
        return points.sort((a, b) => (a.dateKey < b.dateKey ? -1 : 1));
      };
      try {
        const direct = await collect(`${native}/${base}`, false);
        if (direct.length > 0) return direct;
      } catch (e) {
        if (e instanceof ProviderError && (e.kind === 'auth' || e.kind === 'rate_limit' || e.kind === 'cors' || e.kind === 'network')) throw e;
      }
      const inverted = await collect(`${base}/${native}`, true);
      if (inverted.length === 0) throw new ProviderError('not_found', `No FX candles for ${native}/${base}`, '');
      return inverted;
    },

    // [VERIFY] Twelve Data corporate-action endpoints are not wired up in v1:
    // positions get flagged and total return may exclude dividends (X3/RM7).
    async dividends(_instrument: Instrument, _from: Date, _to: Date): Promise<DividendRecord[] | null> {
      return null;
    },
    async splits(_instrument: Instrument, _from: Date, _to: Date): Promise<SplitRecord[] | null> {
      return null;
    },
  };

  return adapter;
}

function num(v: string | number | undefined): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function normaliseTdDatetime(dt: string): string {
  if (dt.length <= 10) return `${dt}T00:00:00.000Z`;
  return new Date(dt).toISOString();
}
