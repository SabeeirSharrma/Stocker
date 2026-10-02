/**
 * On-device TTL cache for quotes, candles and FX (spec C1–C3, A2, X4).
 *
 * Per-type TTLs depend on provider rate limits and whether the market is open
 * (C1/C2): when a market is closed, the last close is the price, so quote TTL
 * becomes "until the next open" instead of seconds. Everything offline falls
 * back to the cache with a `stale` marker — never a fabricated value (X4).
 */

import { marketStatus } from '../calendar/calendar';
import { idbDelete, idbGet, idbSet, STORE_CACHE } from '../storage/idb';

export interface CacheEntry<T> {
  value: T;
  atUtc: string;
  expiresAtMs: number;
}

export interface TtlPolicy {
  /** ms a fresh quote stays valid while its market is open */
  quoteOpenMs: number;
  /** ms a fresh quote stays valid while its market is closed (C2: long) */
  quoteClosedMs: number;
  fxOpenMs: number;
  fxClosedMs: number;
  dailyCandleMs: number;
  searchMs: number;
  /** beyond this age a value is marked stale (A2/F3) */
  staleAfterMs: number;
}

export const DEFAULT_TTL: TtlPolicy = {
  quoteOpenMs: 15_000,
  quoteClosedMs: 6 * 60 * 60 * 1000,
  fxOpenMs: 60_000,
  fxClosedMs: 10 * 60_000,
  dailyCandleMs: 6 * 60 * 60 * 1000,
  searchMs: 24 * 60 * 60 * 1000,
  staleAfterMs: 5 * 60_000,
};

/** In-memory fallback when IndexedDB is unavailable (also used in tests). */
export class MemoryCacheStore {
  private map = new Map<string, CacheEntry<unknown>>();
  async get<T>(key: string): Promise<CacheEntry<T> | undefined> {
    return this.map.get(key) as CacheEntry<T> | undefined;
  }
  async set<T>(key: string, entry: CacheEntry<T>): Promise<void> {
    this.map.set(key, entry as CacheEntry<unknown>);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}

export class IdbCacheStore {
  async get<T>(key: string): Promise<CacheEntry<T> | undefined> {
    return idbGet<CacheEntry<T>>(STORE_CACHE, key);
  }
  async set<T>(key: string, entry: CacheEntry<T>): Promise<void> {
    await idbSet(STORE_CACHE, key, entry);
  }
  async delete(key: string): Promise<void> {
    await idbDelete(STORE_CACHE, key);
  }
}

/** Two-tier store: RAM for speed, IndexedDB for cross-session offline shell. */
export class HybridCacheStore implements CacheStore {
  private mem = new Map<string, CacheEntry<unknown>>();
  constructor(private backing: CacheStore) {}
  async get<T>(key: string): Promise<CacheEntry<T> | undefined> {
    const m = this.mem.get(key) as CacheEntry<T> | undefined;
    if (m) return m;
    try {
      const b = await this.backing.get<T>(key);
      if (b) this.mem.set(key, b as CacheEntry<unknown>);
      return b;
    } catch {
      return undefined; // IndexedDB unavailable → memory-only (app still works)
    }
  }
  async set<T>(key: string, entry: CacheEntry<T>): Promise<void> {
    this.mem.set(key, entry as CacheEntry<unknown>);
    try {
      await this.backing.set(key, entry);
    } catch {
      /* memory-only fallback */
    }
  }
  async delete(key: string): Promise<void> {
    this.mem.delete(key);
    try {
      await this.backing.delete(key);
    } catch {
      /* ignore */
    }
  }
}

export interface CacheStore {
  get<T>(key: string): Promise<CacheEntry<T> | undefined>;
  set<T>(key: string, entry: CacheEntry<T>): Promise<void>;
  delete(key: string): Promise<void>;
}

export type ReadResult<T> =
  | { kind: 'fresh'; value: T; atUtc: string }
  | { kind: 'stale'; value: T; atUtc: string } // expired but usable offline (A2)
  | { kind: 'miss' };

export class TtlCache {
  constructor(
    private store: CacheStore,
    private policy: TtlPolicy = DEFAULT_TTL,
    private now: () => number = Date.now,
  ) {}

  async read<T>(key: string): Promise<ReadResult<T>> {
    const entry = await this.store.get<T>(key);
    if (!entry) return { kind: 'miss' };
    if (entry.expiresAtMs > this.now()) return { kind: 'fresh', value: entry.value, atUtc: entry.atUtc };
    // expired: usable offline but must be marked stale (A2/X4)
    return { kind: 'stale', value: entry.value, atUtc: entry.atUtc };
  }

  async write<T>(key: string, value: T, atUtc: string, ttlMs: number): Promise<void> {
    await this.store.set(key, { value, atUtc, expiresAtMs: this.now() + ttlMs });
  }

  async remove(key: string): Promise<void> {
    await this.store.delete(key);
  }
}

/* ------------------------------------------------------------ key builders */

export const cacheKeys = {
  quote: (provider: string, id: string) => `q|${provider}|${id}`,
  candles: (provider: string, id: string, from: string, to: string) => `c|${provider}|${id}|${from}|${to}`,
  fx: (provider: string, native: string, base: string) => `fx|${provider}|${native}|${base}`,
  fxCandles: (provider: string, native: string, base: string, from: string, to: string) => `fxc|${provider}|${native}|${base}|${from}|${to}`,
  search: (provider: string, q: string) => `s|${provider}|${q.toLowerCase()}`,
  dividends: (provider: string, id: string) => `dv|${provider}|${id}`,
  splits: (provider: string, id: string) => `sp|${provider}|${id}`,
};

/** Quote TTL depends on the market's state (C1/C2). */
export function quoteTtlMs(exchangeId: string, policy: TtlPolicy = DEFAULT_TTL, now = new Date()): number {
  const st = marketStatus(now, exchangeId);
  if (!st.computed) return policy.quoteOpenMs;
  return st.isOpenNow ? policy.quoteOpenMs : policy.quoteClosedMs;
}
