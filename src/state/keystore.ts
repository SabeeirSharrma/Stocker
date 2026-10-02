/**
 * API key storage (spec P1–P3, S2).
 *
 * Keys live in their own IndexedDB object store, are never logged, are never
 * part of the app-state export unless the user explicitly opts in (P2), and
 * are never written into URLs the app itself logs. On web, provider requests
 * necessarily put the key in the request — visible in the user's own network
 * tools, which is acceptable because the key is theirs (S2).
 */

import { idbAll, idbDelete, idbGet, idbSet, STORE_KEYS } from '../storage/idb';
import type { ProviderId } from '../data/provider';

export class KeyStore {
  private cache = new Map<string, string>();

  async load(): Promise<void> {
    try {
      const rows = await idbAll<string>(STORE_KEYS);
      this.cache = new Map(rows.map((r) => [r.key, r.value]));
    } catch {
      this.cache = new Map();
    }
  }

  get(id: ProviderId | string): string | null {
    return this.cache.get(id) ?? null;
  }

  async set(id: ProviderId | string, key: string): Promise<void> {
    this.cache.set(id, key);
    await idbSet(STORE_KEYS, id, key);
  }

  async remove(id: ProviderId | string): Promise<void> {
    this.cache.delete(id);
    await idbDelete(STORE_KEYS, id);
  }

  async all(): Promise<Record<string, string>> {
    return Object.fromEntries(this.cache.entries());
  }
}
