/**
 * Minimal promise-based IndexedDB wrapper (spec A3, X6).
 *
 * Databases are versioned; migrations run inside `onupgradeneeded` so schema
 * upgrades are transactional. All writes for a logical operation should go
 * through a single transaction (see exportimport.ts for atomic import).
 */

export const DB_NAME = 'stocker';
export const DB_VERSION = 1;

export const STORE_RECORDS = 'records'; // key → value (app state, meta)
export const STORE_CACHE = 'cache'; // key → { value, expiresAt }
export const STORE_KEYS = 'keys'; // provider id → API key (never in exports by default)

export type UpgradeFn = (db: IDBDatabase, oldVersion: number, tx: IDBTransaction) => void;

const defaultUpgrade: UpgradeFn = (db, _old, _tx) => {
  if (!db.objectStoreNames.contains(STORE_RECORDS)) db.createObjectStore(STORE_RECORDS);
  if (!db.objectStoreNames.contains(STORE_CACHE)) db.createObjectStore(STORE_CACHE);
  if (!db.objectStoreNames.contains(STORE_KEYS)) db.createObjectStore(STORE_KEYS);
};

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDatabase(name = DB_NAME, version = DB_VERSION, upgrade = defaultUpgrade): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available in this environment'));
      return;
    }
    const req = indexedDB.open(name, version);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      const tx = req.transaction!;
      upgrade(db, ev.oldVersion, tx);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Failed to open database'));
    req.onblocked = () => reject(new Error('Database open blocked by another tab'));
  });
  return dbPromise;
}

/** Test/reset helper — closes the cached connection. */
export async function closeDatabase(): Promise<void> {
  if (dbPromise) {
    const db = await dbPromise.catch(() => null);
    db?.close();
    dbPromise = null;
  }
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

export async function idbGet<T>(store: string, key: string): Promise<T | undefined> {
  const db = await openDatabase();
  return promisify<T | undefined>(db.transaction(store, 'readonly').objectStore(store).get(key));
}

export async function idbSet(store: string, key: string, value: unknown): Promise<void> {
  const db = await openDatabase();
  await promisify(db.transaction(store, 'readwrite').objectStore(store).put(value, key));
}

export async function idbDelete(store: string, key: string): Promise<void> {
  const db = await openDatabase();
  await promisify(db.transaction(store, 'readwrite').objectStore(store).delete(key));
}

export async function idbAll<T>(store: string): Promise<{ key: string; value: T }[]> {
  const db = await openDatabase();
  const tx = db.transaction(store, 'readonly');
  const os = tx.objectStore(store);
  const keys = await promisify(os.getAllKeys());
  const values = await promisify(os.getAll() as IDBRequest<T[]>);
  return keys.map((k, i) => ({ key: String(k), value: values[i] }));
}

export async function idbClear(store: string): Promise<void> {
  const db = await openDatabase();
  await promisify(db.transaction(store, 'readwrite').objectStore(store).clear());
}

/**
 * Run several operations in ONE transaction. If any op fails the transaction
 * aborts and nothing is written — used for atomic import (A4/X6).
 */
export async function idbAtomic<T>(stores: string[], fn: (tx: IDBTransaction) => Promise<T> | T): Promise<T> {
  const db = await openDatabase();
  const tx = db.transaction(stores, 'readwrite');
  let result: T;
  try {
    result = await fn(tx);
  } catch (e) {
    // never leave a half-applied batch on disk (A4): abort before rethrowing
    try {
      tx.abort();
    } catch {
      /* transaction already finished — nothing to abort */
    }
    throw e;
  }
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('Transaction failed'));
  });
  return result;
}
