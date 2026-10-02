/** TTL cache tests (spec C1–C3, A2/X4: stale is usable but never silent). */
import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach } from 'vitest';
import {
  TtlCache, MemoryCacheStore, IdbCacheStore, HybridCacheStore,
  DEFAULT_TTL, quoteTtlMs, cacheKeys,
} from '../src/data/cache';
import { closeDatabase } from '../src/storage/idb';
import { NOW } from './helpers';

afterEach(async () => {
  await closeDatabase();
});

describe('TtlCache', () => {
  it('returns fresh → stale → miss as time passes', async () => {
    let t = 0;
    const cache = new TtlCache(new MemoryCacheStore(), DEFAULT_TTL, () => t);
    expect(await cache.read('k')).toEqual({ kind: 'miss' });

    await cache.write('k', { px: 190 }, NOW.toISOString(), 1_000);
    expect(await cache.read('k')).toMatchObject({ kind: 'fresh', value: { px: 190 } });

    t = 999;
    expect(await cache.read('k')).toMatchObject({ kind: 'fresh' });

    t = 1_001;
    const stale = await cache.read('k');
    expect(stale).toMatchObject({ kind: 'stale', value: { px: 190 } }); // usable offline, marked stale (A2)

    await cache.remove('k');
    expect(await cache.read('k')).toEqual({ kind: 'miss' });
  });
});

describe('HybridCacheStore (RAM + IndexedDB)', () => {
  it('reads through from the backing store and survives its failure', async () => {
    const backing = new IdbCacheStore();
    const hybrid = new HybridCacheStore(backing);
    await hybrid.set('q|a|b', { value: 1, atUtc: NOW.toISOString(), expiresAtMs: Date.now() + 60_000 });
    expect(await backing.get('q|a|b')).toMatchObject({ value: 1 });

    // a fresh Hybrid instance reads the value back from IndexedDB (cross-session, A2)
    const fresh = new HybridCacheStore(backing);
    expect(await fresh.get('q|a|b')).toMatchObject({ value: 1 });

    const broken = new HybridCacheStore({
      get: async () => { throw new Error('idb unavailable'); },
      set: async () => { throw new Error('idb unavailable'); },
      delete: async () => { throw new Error('idb unavailable'); },
    });
    await broken.set('memory-only', { value: 2, atUtc: NOW.toISOString(), expiresAtMs: Date.now() + 60_000 });
    expect(await broken.get('memory-only')).toMatchObject({ value: 2 });
  });
});

describe('quote TTL policy (C1/C2)', () => {
  it('short TTL while the market is open, long while closed', () => {
    const open = quoteTtlMs('NASDAQ', DEFAULT_TTL, new Date('2025-06-04T15:00:00.000Z')); // Wed 11:00 ET
    const closed = quoteTtlMs('NASDAQ', DEFAULT_TTL, new Date('2025-06-07T15:00:00.000Z')); // Sat
    expect(open).toBe(DEFAULT_TTL.quoteOpenMs);
    expect(closed).toBe(DEFAULT_TTL.quoteClosedMs);
    expect(closed).toBeGreaterThan(open);
  });
});

describe('cache keys', () => {
  it('are namespaced and search keys lowercased', () => {
    expect(cacheKeys.quote('twelvedata', 'NASDAQ:AAPL')).toBe('q|twelvedata|NASDAQ:AAPL');
    expect(cacheKeys.search('finnhub', 'Apple')).toBe('s|finnhub|apple');
    expect(cacheKeys.fx('twelvedata', 'INR', 'USD')).toBe('fx|twelvedata|INR|USD');
  });
});
