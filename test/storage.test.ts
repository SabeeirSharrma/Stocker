/**
 * Storage tests: IndexedDB wrapper (A3/X6), export/import validation and
 * atomicity (A4/P2), TTL cache persistence.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  openDatabase, closeDatabase, idbGet, idbSet, idbDelete, idbAll, idbClear, idbAtomic,
  STORE_RECORDS, STORE_CACHE, STORE_KEYS,
} from '../src/storage/idb';
import { buildExport, parseExport, validateState, importExport, EXPORT_FORMAT } from '../src/storage/exportimport';
import { emptyState, SCHEMA_VERSION, type AppState } from '../src/engine/types';
import { makeState } from './helpers';

beforeEach(async () => {
  await openDatabase();
  await idbClear(STORE_RECORDS);
  await idbClear(STORE_CACHE);
  await idbClear(STORE_KEYS);
});

afterAll(async () => {
  await closeDatabase();
});

describe('IndexedDB wrapper', () => {
  it('round-trips values', async () => {
    await idbSet(STORE_RECORDS, 'answer', { n: 42 });
    expect(await idbGet(STORE_RECORDS, 'answer')).toEqual({ n: 42 });
    expect(await idbGet(STORE_RECORDS, 'missing')).toBeUndefined();
  });

  it('deletes and lists', async () => {
    await idbSet(STORE_CACHE, 'a', 1);
    await idbSet(STORE_CACHE, 'b', 2);
    const all = await idbAll<number>(STORE_CACHE);
    expect(all).toHaveLength(2);
    await idbDelete(STORE_CACHE, 'a');
    expect(await idbAll<number>(STORE_CACHE)).toEqual([{ key: 'b', value: 2 }]);
    await idbClear(STORE_CACHE);
    expect(await idbAll(STORE_CACHE)).toEqual([]);
  });

  it('keeps API keys in their own store (P2)', async () => {
    await idbSet(STORE_KEYS, 'twelvedata', 'secret-123');
    expect(await idbGet(STORE_KEYS, 'twelvedata')).toBe('secret-123');
    expect(await idbAll(STORE_RECORDS)).toEqual([]); // not mixed with app data
  });

  it('atomic transactions commit all writes together', async () => {
    await idbAtomic([STORE_RECORDS, STORE_KEYS], (tx) => {
      tx.objectStore(STORE_RECORDS).put('state', 'app');
      tx.objectStore(STORE_KEYS).put('key', 'prov');
    });
    expect(await idbGet(STORE_RECORDS, 'app')).toBe('state');
    expect(await idbGet(STORE_KEYS, 'prov')).toBe('key');
  });
});

describe('export / import (A4, P2)', () => {
  it('validates a freshly built export end-to-end', () => {
    const st = makeState({ realism: true });
    const text = buildExport(st, { twelvedata: 'sekrit' }, false);
    const parsed = parseExport(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.env.format).toBe(EXPORT_FORMAT);
    expect(parsed.env.schemaVersion).toBe(SCHEMA_VERSION);
    expect(parsed.env.includeKeys).toBe(false);
    expect(parsed.env.keys).toBeUndefined(); // P2: keys excluded by default
    expect(validateState(parsed.env.app)).toBeNull();
  });

  it('includes keys only on explicit opt-in', () => {
    const st = emptyState();
    const withKeys = parseExport(buildExport(st, { twelvedata: 'sekrit' }, true));
    expect(withKeys.ok).toBe(true);
    if (withKeys.ok) expect(withKeys.env.keys).toEqual({ twelvedata: 'sekrit' });
  });

  it('rejects garbage without touching the database', async () => {
    expect(parseExport('not json').ok).toBe(false);
    expect(parseExport('[]')).toMatchObject({ ok: false });
    const wrongFormat = JSON.stringify({ format: 'something-else', schemaVersion: 1 });
    expect(parseExport(wrongFormat)).toMatchObject({ ok: false, error: expect.stringContaining('Unrecognised file format') });
    const future = JSON.stringify({ format: EXPORT_FORMAT, schemaVersion: SCHEMA_VERSION + 1 });
    expect(parseExport(future)).toMatchObject({ ok: false, error: expect.stringContaining('newer than this app') });
    const past = JSON.stringify({ format: EXPORT_FORMAT, schemaVersion: 0 });
    expect(parseExport(past)).toMatchObject({ ok: false, error: expect.stringContaining('No migration') });
  });

  it('rejects structurally invalid app data', () => {
    const st = emptyState();
    const broken = JSON.parse(buildExport(st, {}, false));
    delete broken.app.meta;
    const r = parseExport(JSON.stringify(broken));
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('meta missing') });

    const badMoney = JSON.parse(buildExport(makeState(), {}, false));
    badMoney.app.fills = [{ id: 'f', orderId: 'o', side: 'buy', qty: 1, nativePriceMinor: 1.5, baseGrossMinor: 1, feesMinor: 0, baseDebitedMinor: 1, baseCreditedMinor: 0, taxWithheldMinor: 0, fxRate: 1, timestampUtc: 'now' }];
    const r2 = parseExport(JSON.stringify(badMoney));
    expect(r2).toMatchObject({ ok: false, error: expect.stringContaining('W4') });
  });

  it('rejects unknown future order statuses', () => {
    const bad = JSON.parse(buildExport(emptyState(), {}, false));
    bad.app.orders = [{ id: 'o', qty: 1, status: 'yolo' }];
    expect(validateState(bad.app)).toMatch(/order.status invalid/);
  });

  it('imports atomically into IndexedDB and round-trips', async () => {
    const st = makeState({ realism: true });
    st.meta.exportedAtUtc = '2025-06-04T15:00:00.000Z';
    const parsed = parseExport(buildExport(st, { twelvedata: 'sekrit' }, true));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    await importExport(parsed.env);
    const stored = await idbGet<AppState>(STORE_RECORDS, 'app');
    expect(stored).toEqual(parsed.env.app);
    expect(await idbGet<string>(STORE_KEYS, 'twelvedata')).toBe('sekrit');
  });

  it('a failed import leaves the previous state intact', async () => {
    const original = makeState();
    await idbSet(STORE_RECORDS, 'app', original);
    await expect(
      idbAtomic([STORE_RECORDS], (tx) => {
        tx.objectStore(STORE_RECORDS).put({ bogus: true }, 'app');
        throw new Error('boom');
      }),
    ).rejects.toThrow();
    expect(await idbGet(STORE_RECORDS, 'app')).toEqual(original);
  });

  it('validateState accepts a complete valid state', () => {
    expect(validateState(makeState())).toBeNull();
    expect(validateState(emptyState())).toBeNull();
    expect(validateState('nope')).toMatch(/object/);
    expect(validateState({ ...emptyState(), schemaVersion: 999 })).toMatch(/Unsupported schema version/);
  });
});
