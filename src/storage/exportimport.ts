/**
 * JSON export / import of the full app state (spec A4, X6, P2).
 *
 * - Export includes everything needed to restore the account. API keys are
 *   excluded unless the user explicitly opts in (P2, default off).
 * - Import validates the envelope, schema version and the full structure
 *   BEFORE touching the database, and writes in a single transaction, so a
 *   malformed file can never corrupt existing data (A4).
 */

import { SCHEMA_VERSION, emptyState, type AppState } from '../engine/types';
import { idbAtomic, STORE_KEYS, STORE_RECORDS } from './idb';

export const EXPORT_FORMAT = 'stocker-export';

export interface ExportEnvelope {
  format: typeof EXPORT_FORMAT;
  schemaVersion: number;
  exportedAt: string;
  includeKeys: boolean;
  app: AppState;
  keys?: Record<string, string>;
}

export function buildExport(state: AppState, keys: Record<string, string>, includeKeys: boolean): string {
  const env: ExportEnvelope = {
    format: EXPORT_FORMAT,
    schemaVersion: state.schemaVersion ?? SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    includeKeys,
    app: state,
    ...(includeKeys ? { keys } : {}),
  };
  return JSON.stringify(env, null, 2);
}

type Check = string | null;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isStr(v: unknown): v is string {
  return typeof v === 'string';
}
function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}
function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Structural validation of the whole state. Returns null when valid, else the error. */
export function validateState(app: unknown): Check {
  if (!isObj(app)) return 'app state must be an object';
  if (!isInt(app.schemaVersion)) return 'schemaVersion missing/not an integer';
  if (app.schemaVersion > SCHEMA_VERSION) return `Unsupported schema version ${app.schemaVersion} (this app understands ≤ ${SCHEMA_VERSION})`;
  for (const arr of ['positions', 'orders', 'fills', 'cashEvents', 'snapshots', 'journal']) {
    if (!Array.isArray(app[arr])) return `${arr} must be an array`;
  }
  if (!isObj(app.meta)) return 'meta missing';
  if (!isObj(app.challengeProgress)) return 'challengeProgress missing';

  const acct = app.account;
  if (acct !== null) {
    if (!isObj(acct)) return 'account must be an object or null';
    if (!isStr(acct.baseCurrency)) return 'account.baseCurrency missing';
    if (!isInt(acct.startingBalanceMinor)) return 'account.startingBalanceMinor must be an integer';
    if (!isObj(acct.settings)) return 'account.settings missing';
    if (!isObj(acct.settings.costPresets)) return 'account.settings.costPresets missing';
  }

  for (const p of app.positions as unknown[]) {
    if (!isObj(p)) return 'position must be an object';
    if (!isObj(p.instrument) || !isStr((p.instrument as Record<string, unknown>).symbol) || !isStr((p.instrument as Record<string, unknown>).exchange)) {
      return 'position.instrument must have symbol+exchange (I1)';
    }
    if (!isInt(p.qty) || (p.qty as number) < 0) return 'position.qty must be a non-negative integer';
    if (!isInt(p.costBaseMinor)) return 'position.costBaseMinor must be an integer';
    if (!Array.isArray(p.lots)) return 'position.lots must be an array';
    if (!Array.isArray(p.flags)) return 'position.flags must be an array';
    if (!Array.isArray(p.appliedActions)) return 'position.appliedActions must be an array';
  }

  const fillOrderIds = new Set<string>();
  for (const f of app.fills as unknown[]) {
    if (!isObj(f)) return 'fill must be an object';
    if (!isStr(f.id) || !isStr(f.orderId)) return 'fill.id/orderId must be strings';
    if (f.side !== 'buy' && f.side !== 'sell') return 'fill.side must be buy|sell';
    if (!isInt(f.qty) || (f.qty as number) <= 0) return 'fill.qty must be a positive integer';
    for (const field of ['nativePriceMinor', 'baseGrossMinor', 'feesMinor', 'baseDebitedMinor', 'baseCreditedMinor', 'taxWithheldMinor']) {
      if (!isInt(f[field])) return `fill.${field} must be an integer (W4)`;
    }
    if (!isNum(f.fxRate)) return 'fill.fxRate must be a number';
    if (!isStr(f.timestampUtc)) return 'fill.timestampUtc must be a string (X5)';
    fillOrderIds.add(f.orderId as string);
  }

  for (const o of app.orders as unknown[]) {
    if (!isObj(o)) return 'order must be an object';
    if (!isStr(o.id)) return 'order.id missing';
    if (!isInt(o.qty) || (o.qty as number) <= 0) return 'order.qty must be a positive integer';
    if (!['queued', 'filled', 'rejected', 'cancelled', 'expired', 'waiting_data'].includes(String(o.status))) return `order.status invalid: ${String(o.status)}`;
    if (o.status === 'filled' && !isStr(o.fillId)) return 'filled order must reference a fillId';
  }

  const seenSnap = new Set<string>();
  for (const s of app.snapshots as unknown[]) {
    if (!isObj(s) || !isStr(s.date)) return 'snapshot.date missing';
    if (!isInt(s.totalValueMinor)) return 'snapshot.totalValueMinor must be an integer';
    if (seenSnap.has(s.date as string)) return `duplicate snapshot for ${String(s.date)}`;
    seenSnap.add(s.date as string);
  }

  const meta = app.meta as Record<string, unknown>;
  if (typeof meta.onboardingComplete !== 'boolean') return 'meta.onboardingComplete must be boolean';
  if (!Array.isArray(meta.appliedCorporateActions)) return 'meta.appliedCorporateActions must be an array';
  return null;
}

export function parseExport(text: string): { ok: true; env: ExportEnvelope } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'File is not valid JSON.' };
  }
  if (!isObj(raw)) return { ok: false, error: 'File is not a Stocker export (root must be an object).' };
  if (raw.format !== EXPORT_FORMAT) return { ok: false, error: `Unrecognised file format (expected "${EXPORT_FORMAT}").` };
  if (!isInt(raw.schemaVersion)) return { ok: false, error: 'schemaVersion missing.' };
  if (raw.schemaVersion > SCHEMA_VERSION) {
    return { ok: false, error: `Export schema v${raw.schemaVersion} is newer than this app (v${SCHEMA_VERSION}). Update the app first.` };
  }
  if (raw.schemaVersion < SCHEMA_VERSION) {
    // future migrations hook in here; v1 has no older versions yet
    return { ok: false, error: `No migration available from schema v${raw.schemaVersion} to v${SCHEMA_VERSION}.` };
  }
  const stateErr = validateState(raw.app);
  if (stateErr) return { ok: false, error: `Invalid app data: ${stateErr}` };
  if (raw.keys !== undefined && !isObj(raw.keys)) return { ok: false, error: 'keys must be an object when present' };
  if (isObj(raw.keys)) {
    for (const [k, v] of Object.entries(raw.keys)) {
      if (!isStr(v)) return { ok: false, error: `keys.${k} must be a string` };
    }
  }
  return { ok: true, env: raw as unknown as ExportEnvelope };
}

/**
 * Replace the stored state with the imported one, atomically. Validation has
 * already happened (parseExport) — this only writes. Throws on storage failure
 * and the transaction abort leaves the previous state intact.
 */
export async function importExport(env: ExportEnvelope): Promise<void> {
  const app: AppState = { ...env.app, schemaVersion: SCHEMA_VERSION };
  await idbAtomic([STORE_RECORDS, STORE_KEYS], async (tx) => {
    tx.objectStore(STORE_RECORDS).put(app, 'app');
    if (env.keys && Object.keys(env.keys).length > 0) {
      const os = tx.objectStore(STORE_KEYS);
      for (const [provider, key] of Object.entries(env.keys)) os.put(key, provider);
    }
  });
}

export { emptyState };
