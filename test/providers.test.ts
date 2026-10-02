/**
 * Provider registry + adapter tests (spec P4/P5/P6/P8, X1):
 *  - registry shape (keyless flag, adapter ids)
 *  - Twelve Data Basic/free-plan behaviour: 8/min · 800/day, real-time US,
 *    delayed elsewhere
 *  - yfinance (no API key): payload parsing, exchange mapping, session dates,
 *    dividends/splits, FX inversion, and typed error mapping
 *
 * No network: every adapter gets an injected fetchFn.
 */
import { describe, it, expect } from 'vitest';
import { PROVIDER_LIST, makeAdapter } from '../src/data/providers';
import { createTwelveData } from '../src/data/twelvedata';
import { createYfinance, YFINANCE_CHART, YFINANCE_SEARCH } from '../src/data/yfinance';
import { ProviderError } from '../src/data/provider';
import { AAPL, RELIANCE } from './helpers';
import type { Instrument } from '../src/engine/types';

/** JSON Response helper (Node ≥18 exposes fetch/Response globally). */
function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** Route-based fetch stub: match a substring of the URL to a response factory. */
function stubFetch(routes: Record<string, (url: URL) => Response | Promise<Response>>) {
  const calls: string[] = [];
  const fn = async (url: string): Promise<Response> => {
    calls.push(url);
    const u = new URL(url);
    for (const [needle, res] of Object.entries(routes)) {
      if (url.includes(needle)) return res(u);
    }
    return json({ error: `unstubbed URL: ${url}` }, 404);
  };
  return { fn, calls };
}

/* ------------------------------------------------------------------ registry */

describe('provider registry (P4)', () => {
  it('lists every adapter with a human blurb and a key requirement', () => {
    const ids = PROVIDER_LIST.map((p) => p.id);
    expect(ids).toEqual(['twelvedata', 'finnhub', 'yfinance']);
    for (const p of PROVIDER_LIST) {
      expect(p.name.length).toBeGreaterThan(3);
      expect(p.blurb.length).toBeGreaterThan(20);
      expect(typeof p.requiresKey).toBe('boolean');
    }
    expect(PROVIDER_LIST.find((p) => p.id === 'yfinance')?.requiresKey).toBe(false);
    expect(PROVIDER_LIST.find((p) => p.id === 'twelvedata')?.requiresKey).toBe(true);
  });

  it('makeAdapter returns an adapter for every registered id', () => {
    for (const p of PROVIDER_LIST) {
      const a = makeAdapter(p.id, () => null);
      expect(a.id).toBe(p.id);
      expect(a.rateLimits.minIntervalMs).toBeGreaterThan(0);
      expect(a.coverage.notes.length).toBeGreaterThan(10);
    }
  });

  it('keyless provider needs no key: adapter works with getKey returning null', async () => {
    const { fn } = stubFetch({
      [`${YFINANCE_CHART}/AAPL`]: () => json({ chart: { result: [{ meta: { regularMarketPrice: 190, regularMarketTime: 1749049200 } }] } }),
    });
    const a = createYfinance({ fetchFn: fn, isNative: () => true });
    const q = await a.quote(AAPL);
    expect(q.price).toBe(190);
    expect(q.delayed).toBe(false);
  });
});

/* --------------------------------------------------- twelve data basic (free) */

describe('Twelve Data on the Basic (free) plan (P5/P6)', () => {
  const ok = () => json({ status: 'ok', meta: {}, values: [], close: '190.5', datetime: '2025-06-04 11:00:00', previous_close: '189' });

  it('matches the quoted plan limits: 8 credits/min, 800/day, 7.5s spacing', () => {
    const a = createTwelveData({ getKey: () => 'k' });
    expect(a.rateLimits).toEqual({ perMinute: 8, perDay: 800, minIntervalMs: 7_500 });
  });

  it('marks coverage as real-time (US market group is real-time on this plan)', () => {
    const a = createTwelveData({ getKey: () => 'k' });
    expect(a.coverage.delayed).toBe(false);
    expect(a.coverage.notes).toMatch(/real-time US/i);
    expect(a.coverage.notes).toMatch(/8 credits/i);
  });

  it('quotes US symbols as real-time and non-US as delayed', async () => {
    const { fn } = stubFetch({ '/quote?': ok });
    const a = createTwelveData({ getKey: () => 'k', fetchFn: fn });
    expect((await a.quote(AAPL)).delayed).toBe(false); // US market group
    expect((await a.quote(RELIANCE)).delayed).toBe(true); // IN market group
  });

  it('testKey reports the free plan wording', async () => {
    const { fn } = stubFetch({ '/quote?': ok });
    const a = createTwelveData({ getKey: () => 'k', fetchFn: fn });
    const r = await a.testKey();
    expect(r.ok).toBe(true);
    expect(r.plan).toMatch(/Basic plan \(free\)/);
    expect(r.plan).toMatch(/8 credits\/min/);
    expect(r.plan).toMatch(/800\/day/);
  });

  it('maps 429 to a typed rate-limit error quoting the plan budget', async () => {
    const { fn } = stubFetch({ '/quote?': () => json({}, 429, { 'retry-after': '60' }) });
    const a = createTwelveData({ getKey: () => 'k', fetchFn: fn });
    const e = await a.quote(AAPL).catch((err: unknown) => err as ProviderError);
    expect(e).toBeInstanceOf(ProviderError);
    expect((e as ProviderError).kind).toBe('rate_limit');
    expect((e as ProviderError).hint).toMatch(/8 credits\/minute/);
    expect((e as ProviderError).hint).toMatch(/800\/day/);
    expect((e as ProviderError).retryAfterMs).toBe(60_000);
  });

  it('requires a key before any request', async () => {
    const a = createTwelveData({ getKey: () => null });
    const e = await a.quote(AAPL).catch((err: unknown) => err as ProviderError);
    expect((e as ProviderError).kind).toBe('auth');
  });
});

/* ------------------------------------------------------------- yfinance (no key) */

const CHART_META = {
  currency: 'USD',
  symbol: 'AAPL',
  regularMarketPrice: 195.35,
  chartPreviousClose: 193.1,
  regularMarketTime: 1749049200, // 2025-06-04 15:00 UTC
  instrumentType: 'EQUETY',
};

describe('yfinance adapter (no API key)', () => {
  it('uses the conservative self-imposed rate limits and reports CORS as blocked', () => {
    const a = createYfinance({ fetchFn: async () => json({}) });
    expect(a.rateLimits).toEqual({ perMinute: 20, perDay: 1500, minIntervalMs: 1_500 });
    expect(a.coverage.cors).toBe('blocked');
    expect(a.coverage.notes).toMatch(/No API key/i);
  });

  it('parses search results with exchange-code mapping', async () => {
    const { fn } = stubFetch({
      [YFINANCE_SEARCH]: () =>
        json({
          quotes: [
            { symbol: 'AAPL', shortname: 'Apple Inc.', exchange: 'NMS', quoteType: 'EQUITY' },
            { symbol: 'INFY', longname: 'Infosys', exchange: 'NSI', quoteType: 'EQUITY' },
            { symbol: 'HSBA', shortname: 'HSBC', exchange: 'LON', quoteType: 'EQUITY' },
            { symbol: 'SPY', shortname: 'SPDR S&P 500', exchange: 'NYQ', quoteType: 'ETF' },
            { symbol: '^NSEI', shortname: 'Nifty 50', exchange: 'NSI', quoteType: 'INDEX' },
            { exchange: 'NMS' }, // no symbol → dropped
          ],
        }),
    });
    const a = createYfinance({ fetchFn: fn, isNative: () => true });
    const out = await a.search('a');
    expect(out.map((i) => [i.symbol, i.exchange])).toEqual([
      ['AAPL', 'NASDAQ'],
      ['INFY', 'NSE'],
      ['HSBA', 'LSE'],
      ['SPY', 'NYSE'],
      ['^NSEI', 'NSE'],
    ]);
    expect(out[3].assetType).toBe('etf');
    expect(out[4].assetType).toBe('index');
    expect(out[4].isIndex).toBe(true);
    expect(out.every((i) => i.provider === 'yfinance')).toBe(true);
    expect(out[1].currency).toBe('INR'); // from our exchange table
    expect(out[0].currency).toBe('USD');
  });

  it('quotes from chart meta without needing a key', async () => {
    const { fn } = stubFetch({ [`${YFINANCE_CHART}/`]: () => json({ chart: { result: [{ meta: CHART_META }] } }) });
    const a = createYfinance({ fetchFn: fn, isNative: () => true });
    const q = await a.quote(AAPL);
    expect(q.price).toBe(195.35);
    expect(q.prevClose).toBe(193.1);
    expect(q.timestampUtc).toBe(new Date(1749049200 * 1000).toISOString());
    expect(q.delayed).toBe(false);
  });

  it('builds daily candles with exchange-local session dates and skips empty bars', async () => {
    const body = {
      chart: {
        result: [
          {
            meta: CHART_META,
            // 2025-06-03 13:30Z and 2025-06-04 13:30Z = 09:30 ET sessions
            timestamp: [1748960200, 1749046600],
            indicators: {
              quote: [
                {
                  open: [190.1, null],
                  high: [191.5, null],
                  low: [189.2, null],
                  close: [190.4, null], // second bar halted → dropped
                  volume: [1_000, 0],
                },
              ],
            },
          },
        ],
      },
    };
    const { fn } = stubFetch({ [`${YFINANCE_CHART}/`]: () => json(body) });
    const a = createYfinance({ fetchFn: fn, isNative: () => true });
    const candles = await a.dailyCandles(AAPL, new Date('2025-06-01'), new Date('2025-06-05'));
    expect(candles).toHaveLength(1);
    expect(candles[0].sessionDate).toBe('2025-06-03'); // NYSE-local day
    expect(candles[0].close).toBe(190.4);
    expect(candles[0].open).toBe(190.1);
    expect(candles[0].volume).toBe(1_000);
  });

  it('reads dividends and splits from chart events', async () => {
    const body = {
      chart: {
        result: [
          {
            meta: CHART_META,
            events: {
              dividends: { '1748793600': { date: 1748793600, amount: 0.25 } },
              splits: { '1748793600': { date: 1748793600, numerator: 4, denominator: 1 } },
            },
          },
        ],
      },
    };
    const { fn } = stubFetch({ [`${YFINANCE_CHART}/`]: () => json(body) });
    const a = createYfinance({ fetchFn: fn, isNative: () => true });
    const divs = await a.dividends(AAPL, new Date('2025-06-01'), new Date('2025-06-05'));
    expect(divs).toHaveLength(1);
    expect(divs![0].amountNativeMinor).toBe(25); // $0.25 → 25 minor
    expect(divs![0].currency).toBe('USD');
    const splits = await a.splits(AAPL, new Date('2025-06-01'), new Date('2025-06-05'));
    expect(splits).toHaveLength(1);
    expect(splits![0]).toMatchObject({ numerator: 4, denominator: 1 });
  });

  it('fetches FX spot rates and falls back to the inverted pair', async () => {
    let pair = '';
    const { fn } = stubFetch({
      [`${YFINANCE_CHART}/`]: (u) => {
        pair = decodeURIComponent(u.pathname.split('/').pop() ?? '');
        if (pair === 'USDINR=X') return json({ chart: { result: [{ meta: { regularMarketPrice: 83.5, regularMarketTime: 1749049200 } }] } });
        if (pair === 'EURGBP=X') return json({ chart: { result: [{ meta: { regularMarketPrice: 0.85 } }] } });
        return json({ chart: { result: [], error: { code: 'Not Found', description: 'No data found, symbol may be delisted' } } }, 404);
      },
    });
    const a = createYfinance({ fetchFn: fn, isNative: () => true });
    const r = await a.fxRate('USD', 'INR');
    expect(r.rate).toBe(83.5);

    // inverted fallback: ask for GBP→EUR, only EURGBP exists
    const inv = await a.fxRate('GBP', 'EUR');
    expect(inv.rate).toBeCloseTo(1 / 0.85, 6);
    expect(pair).toBe('EURGBP=X'); // requested the direct pair first
  });

  it('inverts FX candles when only the opposite pair exists', async () => {
    const body = {
      chart: {
        result: [
          {
            meta: CHART_META,
            timestamp: [1748960200, 1749046600],
            indicators: { quote: [{ close: [83.5, 83.6] }] },
          },
        ],
      },
    };
    const { fn } = stubFetch({
      [`${YFINANCE_CHART}/`]: (u) => {
        const p = decodeURIComponent(u.pathname.split('/').pop() ?? '');
        return p === 'USDINR=X' ? json(body) : json({ chart: { result: [], error: { code: 'Not Found', description: 'No data found' } } }, 404);
      },
    });
    const a = createYfinance({ fetchFn: fn, isNative: () => true });
    const direct = await a.fxCandles('USD', 'INR', new Date('2025-06-01'), new Date('2025-06-05'));
    expect(direct.map((p) => p.rate)).toEqual([83.5, 83.6]);
    const inverted = await a.fxCandles('INR', 'USD', new Date('2025-06-01'), new Date('2025-06-05'));
    expect(inverted[0].rate).toBeCloseTo(1 / 83.5, 6);
    expect(inverted[0].dateKey).toBe('2025-06-03'); // UTC day of 13:30Z
  });

  it('testKey confirms connectivity without any key', async () => {
    const { fn } = stubFetch({ [`${YFINANCE_CHART}/`]: () => json({ chart: { result: [{ meta: CHART_META }] } }) });
    const a = createYfinance({ fetchFn: fn, isNative: () => true });
    const r = await a.testKey();
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/no API key needed/i);
  });

  /* --------------------------------------------------------- error mapping (X1) */

  it('maps 429 to a typed rate-limit error', async () => {
    const { fn } = stubFetch({ [`${YFINANCE_CHART}/`]: () => json({}, 429, { 'retry-after': '30' }) });
    const a = createYfinance({ fetchFn: fn, isNative: () => true });
    const e = await a.quote(AAPL).catch((err: unknown) => err as ProviderError);
    expect((e as ProviderError).kind).toBe('rate_limit');
    expect((e as ProviderError).retryAfterMs).toBe(30_000);
  });

  it('maps a thrown TypeError to CORS in the browser', async () => {
    const a = createYfinance({
      fetchFn: async () => {
        throw new TypeError('Failed to fetch');
      },
      isNative: () => false,
    });
    const e = await a.quote(AAPL).catch((err: unknown) => err as ProviderError);
    expect((e as ProviderError).kind).toBe('cors');
    expect((e as ProviderError).hint).toMatch(/Android app/);
    expect((e as ProviderError).hint).toMatch(/Twelve Data or Finnhub/);
  });

  it('maps the same failure to a network error on native (CapacitorHttp)', async () => {
    const a = createYfinance({
      fetchFn: async () => {
        throw new TypeError('Failed to fetch');
      },
      isNative: () => true,
    });
    const e = await a.quote(AAPL).catch((err: unknown) => err as ProviderError);
    expect((e as ProviderError).kind).toBe('network');
  });

  it('maps "no data" chart errors to not_found', async () => {
    const { fn } = stubFetch({
      [`${YFINANCE_CHART}/`]: () => json({ chart: { result: [], error: { code: 'Not Found', description: 'No data found, symbol may be delisted' } } }, 404),
    });
    const a = createYfinance({ fetchFn: fn, isNative: () => true });
    const e = await a.quote(AAPL as Instrument).catch((err: unknown) => err as ProviderError);
    expect((e as ProviderError).kind).toBe('not_found');
  });

  it('maps non-JSON responses to bad_response', async () => {
    const a = createYfinance({
      fetchFn: async () => new Response('<html>oops</html>', { status: 200 }),
      isNative: () => true,
    });
    const e = await a.quote(AAPL).catch((err: unknown) => err as ProviderError);
    expect((e as ProviderError).kind).toBe('bad_response');
  });
});
