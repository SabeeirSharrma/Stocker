/**
 * Market data service (spec §3): provider adapters behind a single interface,
 * rate-limited queue (P5), on-device TTL cache (C1–C3), integer minor-unit
 * conversion at the boundary (W4), FX staleness policy (F3), and the fetch
 * planner for serverless reconstruction (R1–R4).
 *
 * Nothing here ever fabricates data: failures fall back to cache with a
 * `stale` marker (A2/X4), or to `null` so callers can wait (R4).
 */

import { marketStatus } from '../calendar/calendar';
import { currencyExponent, quantizeRate, type Minor } from '../engine/money';
import { planFetchWindow, type ReconstructionData } from '../engine/reconstruct';
import type { AppState, Candle, DividendRecord, Instrument, SplitRecord } from '../engine/types';
import { instrumentId } from '../engine/types';
import { cacheKeys, quoteTtlMs, TtlCache } from './cache';
import { ProviderError, type ProviderAdapter, type ProviderId } from './provider';
import { RateLimiter } from './queue';

export interface QuoteOut {
  priceMinor: Minor;
  bidMinor?: Minor;
  askMinor?: Minor;
  prevCloseMinor?: Minor;
  openMinor?: Minor;
  volume?: number;
  atUtc: string;
  delayed: boolean;
  stale: boolean;
  provider: string;
}

export interface FxOut {
  rate: number;
  atUtc: string;
  stale: boolean;
  provider: string;
}

export interface ServiceDeps {
  adapters: ProviderAdapter[];
  cache: TtlCache;
  now?: () => Date;
}

export class MarketDataService {
  private adapters = new Map<ProviderId, ProviderAdapter>();
  private limiters = new Map<ProviderId, RateLimiter>();
  private active: ProviderId;
  private lastErrors = new Map<ProviderId, ProviderError>();
  private volumeById = new Map<string, number>();
  private now: () => Date;

  constructor(private deps: ServiceDeps) {
    for (const a of deps.adapters) this.adapters.set(a.id, a);
    this.active = deps.adapters[0]?.id ?? 'twelvedata';
    this.now = deps.now ?? (() => new Date());
  }

  setProvider(id: ProviderId): void {
    if (!this.adapters.has(id)) throw new Error(`Unknown provider: ${id}`);
    this.active = id;
  }

  providerId(): ProviderId {
    return this.active;
  }

  adapter(id: ProviderId = this.active): ProviderAdapter {
    const a = this.adapters.get(id);
    if (!a) throw new Error(`Unknown provider: ${id}`);
    return a;
  }

  availableAdapters(): ProviderAdapter[] {
    return [...this.adapters.values()];
  }

  limiter(id: ProviderId = this.active): RateLimiter {
    let l = this.limiters.get(id);
    if (!l) {
      l = new RateLimiter(this.adapter(id).rateLimits);
      this.limiters.set(id, l);
    }
    return l;
  }

  lastError(id: ProviderId = this.active): ProviderError | null {
    return this.lastErrors.get(id) ?? null;
  }

  private noteError(e: unknown): void {
    if (e instanceof ProviderError) {
      this.lastErrors.set(this.active, e);
      if (e.kind === 'rate_limit') this.limiter().reportRateLimit(e.retryAfterMs ?? 60_000);
    }
  }

  private clearError(): void {
    this.lastErrors.delete(this.active);
  }

  /* --------------------------------------------------------------- quotes */

  async getQuote(instrument: Instrument): Promise<QuoteOut> {
    const provider = this.active;
    const key = cacheKeys.quote(provider, instrumentId(instrument));
    const closed = !marketStatus(this.now(), instrument.exchange).isOpenNow;
    const cached = await this.deps.cache.read<QuoteOut>(key);

    // C2: when the market is closed the last price is the price — no refetch.
    if (closed && cached.kind !== 'miss') {
      return { ...cached.value, stale: false };
    }
    if (cached.kind === 'fresh') return cached.value;

    try {
      await this.limiter().acquire();
      const q = await this.adapter().quote(instrument);
      const exp = currencyExponent(instrument.currency);
      const out: QuoteOut = {
        priceMinor: toMinorExact(q.price, exp),
        bidMinor: q.bid != null ? toMinorExact(q.bid, exp) : undefined,
        askMinor: q.ask != null ? toMinorExact(q.ask, exp) : undefined,
        prevCloseMinor: q.prevClose != null ? toMinorExact(q.prevClose, exp) : undefined,
        openMinor: q.open != null ? toMinorExact(q.open, exp) : undefined,
        volume: q.volume,
        atUtc: q.timestampUtc,
        delayed: q.delayed,
        stale: false,
        provider,
      };
      await this.deps.cache.write(key, out, out.atUtc, quoteTtlMs(instrument.exchange));
      this.clearError();
      return out;
    } catch (e) {
      this.noteError(e);
      if (cached.kind === 'stale') return { ...cached.value, stale: true }; // A2/X4
      throw e;
    }
  }

  /* -------------------------------------------------------------- candles */

  /** Daily candles (minor units) or null when unavailable — R4: never guess. */
  async tryDailyCandles(instrument: Instrument, fromUtc: Date, toUtc: Date): Promise<Candle[] | null> {
    const provider = this.active;
    const key = cacheKeys.candles(provider, instrumentId(instrument), fromUtc.toISOString().slice(0, 10), toUtc.toISOString().slice(0, 10));
    try {
      const cached = await this.deps.cache.read<Candle[]>(key);
      if (cached.kind === 'fresh') return cached.value;
      await this.limiter().acquire();
      const raw = await this.adapter().dailyCandles(instrument, fromUtc, toUtc);
      const exp = currencyExponent(instrument.currency);
      const candles: Candle[] = raw
        .map((c) => ({
          timeUtc: c.timeUtc,
          sessionDate: c.sessionDate,
          openMinor: toMinorExact(c.open, exp),
          highMinor: toMinorExact(c.high, exp),
          lowMinor: toMinorExact(c.low, exp),
          closeMinor: toMinorExact(c.close, exp),
          volume: c.volume,
        }))
        .sort((a, b) => (a.sessionDate < b.sessionDate ? -1 : a.sessionDate > b.sessionDate ? 1 : 0));
      // TTL grows with age: fresh days cache long, the (in-progress) last day short
      await this.deps.cache.write(key, candles, this.now().toISOString(), candles.length > 0 && isSeriesComplete(candles, this.now()) ? 24 * 3_600_000 : 300_000);
      if (candles.length > 0) {
        const tail = candles.slice(-20);
        this.volumeById.set(instrumentId(instrument), Math.round(tail.reduce((s, c) => s + c.volume, 0) / tail.length));
      }
      this.clearError();
      return candles;
    } catch (e) {
      this.noteError(e);
      return null;
    }
  }

  /** Average daily volume over the most recent candles (slippage model, RM3). */
  async avgDailyVolume(instrument: Instrument): Promise<number | null> {
    const id = instrumentId(instrument);
    const known = this.volumeById.get(id);
    if (known != null) return known;
    const provider = this.active;
    const to = this.now();
    const from = new Date(to.getTime() - 40 * 86_400_000);
    const key = cacheKeys.candles(provider, id, from.toISOString().slice(0, 10), to.toISOString().slice(0, 10));
    const cached = await this.deps.cache.read<Candle[]>(key);
    if (cached.kind === 'miss') return null;
    const tail = cached.value.slice(-20);
    if (tail.length === 0) return null;
    return Math.round(tail.reduce((s, c) => s + c.volume, 0) / tail.length);
  }

  /* ------------------------------------------------------------------ FX */

  async getFx(native: string, base: string, staleThresholdMs = 15 * 60_000): Promise<FxOut | null> {
    if (native === base) return { rate: 1, atUtc: this.now().toISOString(), stale: false, provider: 'identity' };
    const provider = this.active;
    const key = cacheKeys.fx(provider, native, base);
    const cached = await this.deps.cache.read<FxOut>(key);
    const weekend = [0, 6].includes(this.now().getUTCDay());

    if (cached.kind === 'fresh') return this.applyFxStaleness(cached.value, staleThresholdMs, weekend);

    try {
      await this.limiter().acquire();
      const r = await this.adapter().fxRate(native, base);
      const out: FxOut = { rate: quantizeRate(r.rate), atUtc: r.timestampUtc, stale: false, provider };
      await this.deps.cache.write(key, out, out.atUtc, weekend ? 600_000 : 60_000);
      this.clearError();
      return this.applyFxStaleness(out, staleThresholdMs, weekend);
    } catch (e) {
      this.noteError(e);
      if (cached.kind === 'stale') return this.applyFxStaleness(cached.value, staleThresholdMs, weekend);
      return null;
    }
  }

  /**
   * F3: an FX rate older than the threshold is `stale` and blocks trading —
   * except at weekends, where the market itself is closed and the last close
   * is the valid rate (C2 analogue).
   */
  private applyFxStaleness(out: FxOut, thresholdMs: number, weekend: boolean): FxOut {
    if (weekend) return { ...out, stale: false };
    const age = this.now().getTime() - Date.parse(out.atUtc);
    return { ...out, stale: age > thresholdMs };
  }

  /** Historical FX series for snapshots (R1). Empty when unavailable. */
  async tryFxCandles(native: string, base: string, fromUtc: Date, toUtc: Date): Promise<{ dateKey: string; rate: number }[] | null> {
    if (native === base) return [];
    const provider = this.active;
    const key = cacheKeys.fxCandles(provider, native, base, fromUtc.toISOString().slice(0, 10), toUtc.toISOString().slice(0, 10));
    try {
      const cached = await this.deps.cache.read<{ dateKey: string; rate: number }[]>(key);
      if (cached.kind === 'fresh') return cached.value;
      await this.limiter().acquire();
      const raw = await this.adapter().fxCandles(native, base, fromUtc, toUtc);
      const points = raw.map((p) => ({ dateKey: p.dateKey, rate: quantizeRate(p.rate) }));
      await this.deps.cache.write(key, points, this.now().toISOString(), 3_600_000);
      this.clearError();
      return points;
    } catch (e) {
      this.noteError(e);
      return null;
    }
  }

  /* -------------------------------------------------------------- search */

  async search(query: string, limit = 25): Promise<Instrument[]> {
    const provider = this.active;
    const key = cacheKeys.search(provider, query);
    const cached = await this.deps.cache.read<Instrument[]>(key);
    try {
      if (cached.kind === 'fresh') return cached.value;
      await this.limiter().acquire();
      const results = await this.adapter().search(query, limit);
      await this.deps.cache.write(key, results, this.now().toISOString(), 3_600_000);
      this.clearError();
      return results;
    } catch (e) {
      this.noteError(e);
      if (cached.kind !== 'miss') return cached.value; // offline fallback (A2/X4)
      throw e;
    }
  }

  /* --------------------------------------------- reconstruction fetching */

  async fetchReconstructionData(state: AppState, nowUtc: Date): Promise<ReconstructionData> {
    const plan = planFetchWindow(state, nowUtc);
    const data: ReconstructionData = { candles: {}, fx: {}, dividends: null, splits: null, missing: {} };
    if (!plan) return data;

    let dividendsSupported = false;
    let splitsSupported = false;

    for (const inst of plan.instruments) {
      const id = instrumentId(inst);
      const candles = await this.tryDailyCandles(inst, plan.fromUtc, nowUtc);
      if (candles == null) data.missing[id] = true;
      else data.candles[id] = candles;

      // corporate actions (RM7) — capability-aware, never guess (R4/X2/X3)
      try {
        const dv = await this.safeActions(() => this.adapter().dividends(inst, plan.fromUtc, nowUtc));
        if (dv !== undefined) {
          dividendsSupported = true;
          data.dividends = data.dividends ?? {};
          data.dividends[id] = dv as DividendRecord[];
        }
      } catch { /* transient — leave unflagged, retry next run */ }
      try {
        const sp = await this.safeActions(() => this.adapter().splits(inst, plan.fromUtc, nowUtc));
        if (sp !== undefined) {
          splitsSupported = true;
          data.splits = data.splits ?? {};
          data.splits[id] = sp as SplitRecord[];
        }
      } catch { /* transient */ }
    }

    if (!dividendsSupported) data.dividends = null;
    if (!splitsSupported) data.splits = null;

    for (const pair of plan.fxPairs) {
      const points = await this.tryFxCandles(pair.native, pair.base, plan.fromUtc, nowUtc);
      if (points && points.length > 0) data.fx[`${pair.native}->${pair.base}`] = points;
    }
    return data;
  }

  private async safeActions(fn: () => Promise<unknown[] | null>): Promise<unknown[] | undefined> {
    const r = await fn();
    if (r === null) return undefined; // provider does not expose this capability
    return Array.isArray(r) ? r : undefined;
  }
}

/* --------------------------------------------------------------- helpers */

function isSeriesComplete(candles: Candle[], now: Date): boolean {
  const last = candles[candles.length - 1];
  if (!last) return false;
  // only cache "long" when the series doesn't include today's forming bar
  return last.sessionDate < now.toISOString().slice(0, 10);
}

/** Float → integer minor units using round-half-even (W5). */
export function toMinorExact(value: number, exponent: number): Minor {
  if (!Number.isFinite(value)) throw new Error(`Non-finite price: ${value}`);
  const factor = Math.pow(10, exponent);
  const scaled = value * factor;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}
