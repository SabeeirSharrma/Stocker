/**
 * Yahoo Finance (query1/query2) adapter — the keyless option (P1: no key is
 * ever bundled; this provider simply needs none).
 *
 * Uses the public JSON endpoints:
 *   - /v1/finance/search?q=…            → symbol search
 *   - /v8/finance/chart/{symbol}        → quote (meta), daily candles, FX,
 *                                          dividends and splits via events=
 *
 * [VERIFY] Yahoo does not publish these endpoints or a rate limit; the limits
 * below are conservative community-reported numbers. They are enforced by our
 * own queue, so the app stays polite regardless.
 *
 * CORS: Yahoo sends no CORS headers, so this adapter works on Android (native
 * HTTP via CapacitorHttp) but is blocked in a plain browser tab — it reports
 * ProviderError('cors') with guidance there.
 */

import type { DividendRecord, Instrument, SplitRecord } from '../engine/types';
import { toMinor, currencyExponent } from '../engine/money';
import { dateKeyOf, exchangeInfo } from '../calendar/calendar';
import { ProviderError, type KeyTestResult, type ProviderAdapter, type ProviderCandle, type ProviderFxPoint, type ProviderQuote } from './provider';

export const YFINANCE_SEARCH = 'https://query1.finance.yahoo.com/v1/finance/search';
export const YFINANCE_CHART = 'https://query1.finance.yahoo.com/v8/finance/chart';

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface YfinanceDeps {
  fetchFn?: FetchFn;
  /** test hook: are we running where fetch is native (Capacitor)? */
  isNative?: () => boolean;
}

/** Exchange-code mapping from Yahoo's `exchDisp`/`exchange` to our table. */
const EXCHANGE_MAP: Record<string, string> = {
  NMS: 'NASDAQ', NCM: 'NASDAQ', NGM: 'NASDAQ',
  NYQ: 'NYSE',
  ASE: 'AMEX', AMEX: 'AMEX',
  PNK: 'US', OTC: 'US',
  NSI: 'NSE', NSE: 'NSE', BSE: 'BSE',
  LON: 'LSE', LSE: 'LSE',
  HKG: 'HKEX', HKEX: 'HKEX',
  FRA: 'FWB', ETR: 'FWB', XETRA: 'FWB', GER: 'FWB',
  TKS: 'TSE', TOK: 'TSE', TSE: 'TSE',
  TSX: 'TSX', VSE: 'TSX',
};

function mapExchange(raw: string | undefined): string {
  if (!raw) return 'US';
  const code = raw.trim().toUpperCase();
  return EXCHANGE_MAP[code] ?? code;
}

interface ChartMeta {
  currency?: string;
  symbol?: string;
  exchangeName?: string;
  fullExchangeName?: string;
  regularMarketPrice?: number;
  chartPreviousClose?: number;
  previousClose?: number;
  regularMarketTime?: number;
  dataDelayedBy?: number;
  instrumentType?: string;
}

interface ChartBucket {
  meta?: ChartMeta;
  timestamp?: number[];
  indicators?: {
    quote?: {
      open?: (number | null)[];
      high?: (number | null)[];
      low?: (number | null)[];
      close?: (number | null)[];
      volume?: (number | null)[];
    }[];
  };
  events?: {
    dividends?: Record<string, { date?: number; amount?: number }>;
    splits?: Record<string, { date?: number; numerator?: number; denominator?: number; splitRatio?: string }>;
  };
}

type ChartResult = ChartBucket;

interface ChartResponse {
  chart?: {
    result?: ChartResult[];
    error?: { code?: string; description?: string } | null;
  };
}

interface SearchResponse {
  quotes?: {
    symbol?: string;
    shortname?: string;
    longname?: string;
    exchange?: string;
    exchDisp?: string;
    quoteType?: string;
    typeDisp?: string;
    currency?: string;
  }[];
}

function detectNative(): boolean {
  if (typeof window === 'undefined') return false;
  return 'Capacitor' in window;
}

export function createYfinance(deps: YfinanceDeps = {}): ProviderAdapter {
  const fetchFn = deps.fetchFn ?? ((url, init) => fetch(url, init));
  const isNative = deps.isNative ?? detectNative;

  async function api<T>(url: string): Promise<T> {
    let res: Response;
    try {
      res = await fetchFn(url, { headers: { Accept: 'application/json' } });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isNative()) {
        throw new ProviderError('network', `Request to Yahoo Finance failed: ${msg}`, 'Check your connection and try again.');
      }
      throw new ProviderError(
        'cors',
        `Browser request to Yahoo Finance failed: ${msg}`,
        'Yahoo Finance sends no CORS headers, so plain browsers block it. This works in the Android app; on the web, use Twelve Data or Finnhub instead.',
      );
    }
    if (res.status === 429) {
      const retry = Number(res.headers.get('retry-after') ?? '30') * 1000;
      throw new ProviderError('rate_limit', 'Yahoo Finance rate limit hit', 'Wait a moment and try again.', retry || 30_000);
    }
    if (res.status === 401 || res.status === 403) {
      throw new ProviderError('auth', 'Yahoo Finance refused the request', 'This provider needs no key; the endpoint may be blocking automated clients.');
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new ProviderError('bad_response', `Yahoo Finance returned non-JSON (HTTP ${res.status})`, 'The service may be down; cached data stays available.');
    }
    const chart = (body as ChartResponse).chart;
    if (chart?.error) {
      const desc = String(chart.error.description ?? 'provider error');
      if (/not found|delisted|no data/i.test(desc)) throw new ProviderError('not_found', desc, 'The symbol may be misspelled or delisted.');
      throw new ProviderError('bad_response', desc, '');
    }
    if (!res.ok) throw new ProviderError('bad_response', `Yahoo Finance HTTP ${res.status}`, '');
    return body as T;
  }

  async function chart(symbol: string, params: Record<string, string>): Promise<ChartResult> {
    const usp = new URLSearchParams(params);
    const body = await api<ChartResponse>(`${YFINANCE_CHART}/${encodeURIComponent(symbol)}?${usp.toString()}`);
    const result = body.chart?.result?.[0];
    if (!result) throw new ProviderError('not_found', `No data for ${symbol}`, 'The symbol may be misspelled or delisted.');
    return result;
  }

  const coverage = {
    exchanges: ['NASDAQ', 'NYSE', 'AMEX', 'NYSE_ARCA', 'NSE', 'BSE', 'LSE', 'HKEX', 'FWB', 'TSE', 'TSX'],
    verifiedExchanges: [], // [VERIFY] confirm with live responses before promoting
    assetTypes: ['stock', 'etf', 'index'] as const,
    indexQuotes: true,
    forex: true,
    delayed: false, // Yahoo reports regular-market (real-time) prices for US equities
    cors: 'blocked' as const,
    notes:
      'No API key required. Coverage depends on Yahoo’s public endpoints — no uptime or rate-limit guarantee. Blocked by CORS in plain browser tabs; works natively in the Android app.',
  };

  const adapter: ProviderAdapter = {
    id: 'yfinance',
    name: 'Yahoo Finance (no API key)',
    coverage: { ...coverage, assetTypes: [...coverage.assetTypes] },
    // conservative community-reported limits; enforced by our own queue [VERIFY]
    rateLimits: { perMinute: 20, perDay: 1500, minIntervalMs: 1_500 },

    async testKey(): Promise<KeyTestResult> {
      await chart('AAPL', { interval: '1d', range: '1d' });
      return {
        ok: true,
        message: 'Connected to Yahoo Finance — no API key needed.',
        plan: 'No key required · ~20 requests/min (self-limited)',
      };
    },

    async search(query: string, limit = 25): Promise<Instrument[]> {
      if (!query.trim()) return [];
      const usp = new URLSearchParams({ q: query.trim(), quotesCount: String(limit), newsCount: '0', listsCount: '0' });
      const body = await api<SearchResponse>(`${YFINANCE_SEARCH}?${usp.toString()}`);
      const out: Instrument[] = [];
      for (const q of body.quotes ?? []) {
        if (!q.symbol) continue;
        const type = (q.quoteType ?? q.typeDisp ?? '').toUpperCase();
        const assetType: Instrument['assetType'] = type.includes('ETF') || type.includes('FUND') ? 'etf' : type.includes('INDEX') ? 'index' : 'stock';
        const exchange = mapExchange(q.exchange ?? q.exchDisp);
        out.push({
          symbol: q.symbol,
          exchange,
          name: q.longname ?? q.shortname ?? q.symbol,
          currency: q.currency ?? exchangeInfo(exchange).currency ?? 'USD',
          assetType,
          providerId: q.symbol,
          provider: 'yfinance',
          isIndex: assetType === 'index',
          sector: null,
        });
        if (out.length >= limit) break;
      }
      return out;
    },

    async quote(instrument: Instrument): Promise<ProviderQuote> {
      const res = await chart(instrument.symbol, { interval: '1d', range: '1d' });
      const m = res.meta ?? {};
      const price = m.regularMarketPrice;
      if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
        throw new ProviderError('bad_response', 'Yahoo Finance returned no price', '');
      }
      const prevClose = m.chartPreviousClose ?? m.previousClose;
      const ts = typeof m.regularMarketTime === 'number' ? m.regularMarketTime * 1000 : Date.now();
      return {
        price,
        prevClose: typeof prevClose === 'number' && prevClose > 0 ? prevClose : undefined,
        timestampUtc: new Date(ts).toISOString(),
        delayed: false,
      };
    },

    async dailyCandles(instrument: Instrument, fromUtc: Date, toUtc: Date): Promise<ProviderCandle[]> {
      const meta = await chart(instrument.symbol, {
        interval: '1d',
        period1: String(Math.floor(fromUtc.getTime() / 1000)),
        period2: String(Math.ceil(toUtc.getTime() / 1000)),
      });
      const timestamps = meta.timestamp ?? [];
      const q = meta.indicators?.quote?.[0];
      if (!q) return [];
      const tz = exchangeInfo(instrument.exchange).timeZone;
      const out: ProviderCandle[] = [];
      for (let i = 0; i < timestamps.length; i++) {
        const close = q.close?.[i];
        if (typeof close !== 'number' || !Number.isFinite(close) || close <= 0) continue; // halted/missing bar → skip, never fabricate
        const at = new Date(timestamps[i] * 1000);
        const open = q.open?.[i];
        const high = q.high?.[i];
        const low = q.low?.[i];
        out.push({
          timeUtc: at.toISOString(),
          sessionDate: dateKeyOf(at, tz),
          open: typeof open === 'number' && open > 0 ? open : close,
          high: typeof high === 'number' && high > 0 ? high : close,
          low: typeof low === 'number' && low > 0 ? low : close,
          close,
          volume: q.volume?.[i] ?? 0,
        });
      }
      return out;
    },

    async fxRate(native: string, base: string): Promise<{ rate: number; timestampUtc: string }> {
      const direct = await fxChart(native, base);
      if (direct) return direct;
      const inverted = await fxChart(base, native);
      if (inverted) return { rate: 1 / inverted.rate, timestampUtc: inverted.timestampUtc };
      throw new ProviderError('not_found', `No FX rate for ${native}/${base}`, '');
    },

    async fxCandles(native: string, base: string, fromUtc: Date, toUtc: Date): Promise<ProviderFxPoint[]> {
      const direct = await fxCandleList(native, base, fromUtc, toUtc);
      if (direct.length > 0) return direct;
      const inverted = await fxCandleList(base, native, fromUtc, toUtc);
      if (inverted.length === 0) throw new ProviderError('not_found', `No FX candles for ${native}/${base}`, '');
      return inverted.map((p) => ({ ...p, rate: 1 / p.rate }));
    },

    async dividends(instrument: Instrument, fromUtc: Date, toUtc: Date): Promise<DividendRecord[] | null> {
      const meta = await chart(instrument.symbol, {
        interval: '1d',
        period1: String(Math.floor(fromUtc.getTime() / 1000)),
        period2: String(Math.ceil(toUtc.getTime() / 1000)),
        events: 'div',
      });
      const events = meta.events?.dividends;
      if (!events) return [];
      const exp = currencyExponent(instrument.currency);
      const out: DividendRecord[] = [];
      for (const [key, d] of Object.entries(events)) {
        if (typeof d.date !== 'number' || typeof d.amount !== 'number' || d.amount <= 0) continue;
        const day = dateKeyOf(new Date(d.date * 1000), exchangeInfo(instrument.exchange).timeZone);
        out.push({
          id: `${instrument.symbol}:div:${key}`,
          exDate: day,
          payDate: day, // Yahoo's chart events carry only the ex/pay date shown [VERIFY]
          amountNativeMinor: toMinor(d.amount, exp),
          currency: instrument.currency,
        });
      }
      return out.sort((a, b) => (a.exDate < b.exDate ? -1 : 1));
    },

    async splits(instrument: Instrument, fromUtc: Date, toUtc: Date): Promise<SplitRecord[] | null> {
      const meta = await chart(instrument.symbol, {
        interval: '1day',
        period1: String(Math.floor(fromUtc.getTime() / 1000)),
        period2: String(Math.ceil(toUtc.getTime() / 1000)),
        events: 'split',
      });
      const events = meta.events?.splits;
      if (!events) return [];
      const out: SplitRecord[] = [];
      for (const [key, s] of Object.entries(events)) {
        if (typeof s.date !== 'number') continue;
        let num = typeof s.numerator === 'number' ? s.numerator : 0;
        let den = typeof s.denominator === 'number' ? s.denominator : 0;
        if ((!num || !den) && s.splitRatio) {
          const [a, b] = s.splitRatio.split(':').map(Number);
          num = a || 0;
          den = b || 0;
        }
        if (!num || !den) continue;
        out.push({
          id: `${instrument.symbol}:split:${key}`,
          exDate: dateKeyOf(new Date(s.date * 1000), exchangeInfo(instrument.exchange).timeZone),
          numerator: num,
          denominator: den,
        });
      }
      return out.sort((a, b) => (a.exDate < b.exDate ? -1 : 1));
    },
  };

  /** `PAIR=X` spot rate via chart meta; null when the pair does not exist. */
  async function fxChart(native: string, base: string): Promise<{ rate: number; timestampUtc: string } | null> {
    if (native === base) return { rate: 1, timestampUtc: new Date().toISOString() };
    try {
      const res = await chart(`${native}${base}=X`, { interval: '1d', range: '5d' });
      const m = res.meta ?? {};
      const rate = m.regularMarketPrice;
      if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) return null;
      const ts = typeof m.regularMarketTime === 'number' ? m.regularMarketTime * 1000 : Date.now();
      return { rate, timestampUtc: new Date(ts).toISOString() };
    } catch (e) {
      if (e instanceof ProviderError && (e.kind === 'not_found' || e.kind === 'bad_response')) return null;
      throw e;
    }
  }

  async function fxCandleList(native: string, base: string, fromUtc: Date, toUtc: Date): Promise<ProviderFxPoint[]> {
    if (native === base) return [];
    let res: ChartResult;
    try {
      res = await chart(`${native}${base}=X`, {
        interval: '1d',
        period1: String(Math.floor(fromUtc.getTime() / 1000)),
        period2: String(Math.ceil(toUtc.getTime() / 1000)),
      });
    } catch (e) {
      if (e instanceof ProviderError && (e.kind === 'not_found' || e.kind === 'bad_response')) return [];
      throw e;
    }
    const timestamps = res.timestamp ?? [];
    const closes = res.indicators?.quote?.[0]?.close ?? [];
    const out: ProviderFxPoint[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const c = closes[i];
      if (typeof c !== 'number' || !Number.isFinite(c) || c <= 0) continue;
      const at = new Date(timestamps[i] * 1000);
      out.push({ dateKey: dateKeyOf(at, 'UTC'), rate: c, timeUtc: at.toISOString() });
    }
    return out.sort((a, b) => (a.dateKey < b.dateKey ? -1 : 1));
  }

  return adapter;
}
