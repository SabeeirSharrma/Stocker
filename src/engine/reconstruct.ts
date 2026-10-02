/**
 * Serverless reconstruction (spec §6.4, §6.6 corporate actions).
 *
 * Nothing runs while the app is closed, so on open we deterministically
 * rebuild state from persisted data plus fetched market data:
 *
 *   R1 backfill missing daily snapshots from historical daily candles + FX
 *   R2 queued market orders fill at the first session open after placement
 *   R3 limit/stop/stop-limit orders evaluate candle high/low chronologically
 *   R4 missing data → order stays queued with a "waiting for data" state
 *   R5 running twice with the same inputs never double-fills (idempotent)
 *
 * Documented fill rules (also shown in Learn):
 *   market:           first eligible session → candle open
 *   buy  limit:       first candle with low  ≤ limit → min(limit, open)
 *   sell limit:       first candle with high ≥ limit → max(limit, open)
 *   buy  stop:        first candle with high ≥ stop  → max(stop, open)
 *   sell stop:        first candle with low  ≤ stop  → min(stop, open)
 *   buy  stop-limit:  trigger as buy stop, then fill in the same or a later
 *                     eligible candle if low  ≤ limit at min(limit, max(stop, open))
 *   sell stop-limit:  trigger as sell stop, then fill if high ≥ limit at
 *                     max(limit, min(stop, open))
 *
 * Orders created *during* a session are never evaluated against that same
 * session's candle (we cannot see intraday time within a daily candle), so we
 * never "fill in the past" — conservative and deterministic.
 *
 * Reconstruction fills use the candle price exactly as R2/R3 require (no
 * spread/slippage); trading costs (E5/RM2) are still charged at fill.
 */

import { dateKeyOf, exchangeInfo, marketStatus, toDateKey, utcFromLocal } from '../calendar/calendar';
import { executeFill, applyFill } from './engine';
import { convertMinor, quantizeRate, type Minor } from './money';
import {
  instrumentId, type AppState, type CashEvent, type Candle, type DividendRecord,
  type FxPoint, type Instrument, type Order, type Position, type SplitRecord,
} from './types';

export interface ReconstructionData {
  /** key = instrumentId("EXCH:SYM"), ascending by sessionDate */
  candles: Record<string, Candle[]>;
  /** key = "NATIVE->BASE", ascending by dateKey */
  fx: Record<string, FxPoint[]>;
  /** null = provider does not expose dividends (→ flag, X3) */
  dividends: Record<string, DividendRecord[]> | null;
  /** null = provider does not expose splits (→ flag, X2) */
  splits: Record<string, SplitRecord[]> | null;
  /** instrument ids whose candle fetch failed (R4) */
  missing: Record<string, true>;
}

export function emptyData(): ReconstructionData {
  return { candles: {}, fx: {}, dividends: null, splits: null, missing: {} };
}

export interface ReconstructionResult {
  state: AppState;
  notes: string[];
  filledOrderIds: string[];
  waitingOrderIds: string[];
  snapshotsCreated: string[];
}

/* --------------------------------------------------------- replay (R1/R5) */

export interface ReplayResult {
  positions: Position[];
  realizedGrossMinor: Minor;
  feesMinor: Minor;
  taxMinor: Minor;
  dividendsMinor: Minor;
  cashMinor: Minor;
}

/**
 * Recompute state as of `atUtc` by replaying fills in (timestamp, id) order.
 * Deterministic — the basis for snapshot backfill and dividend share counts.
 */
export function replayAt(state: AppState, atUtc: Date): ReplayResult {
  const acct = state.account;
  const ts = atUtc.getTime();
  let posState: AppState = { ...state, positions: [], fills: [] };
  const fills = [...state.fills].sort((a, b) =>
    a.timestampUtc === b.timestampUtc ? a.id.localeCompare(b.id) : a.timestampUtc < b.timestampUtc ? -1 : 1,
  );
  for (const f of fills) {
    if (Date.parse(f.timestampUtc) > ts) break;
    posState = applyFill(posState, f);
  }
  const cashEvents = state.cashEvents.filter((e) => Date.parse(e.paidAtUtc) <= ts);
  let realized = 0;
  for (const p of posState.positions) realized += p.realizedGrossBaseMinor;
  const fees = fills.reduce((s, f) => (Date.parse(f.timestampUtc) <= ts ? s + f.feesMinor : s), 0);
  const tax = fills.reduce((s, f) => (Date.parse(f.timestampUtc) <= ts ? s + f.taxWithheldMinor : s), 0);
  const dividends = cashEvents.reduce((s, e) => s + e.amountMinor, 0);
  let cash = acct?.startingBalanceMinor ?? 0;
  for (const f of fills) {
    if (Date.parse(f.timestampUtc) > ts) continue;
    cash += f.side === 'buy' ? -f.baseDebitedMinor : f.baseCreditedMinor;
  }
  cash += dividends;
  return {
    positions: posState.positions,
    realizedGrossMinor: realized,
    feesMinor: fees,
    taxMinor: tax,
    dividendsMinor: dividends,
    cashMinor: cash,
  };
}

/* ------------------------------------------------------------- helpers */

function seriesFor(map: Record<string, Candle[]>, id: string): Candle[] {
  return map[id] ?? [];
}

function candleOnOrBefore(candles: Candle[], dateKey: string, lookbackDays = 10): Candle | null {
  let best: Candle | null = null;
  for (const c of candles) {
    if (c.sessionDate <= dateKey) best = c;
    else break;
  }
  if (!best) return null;
  const diff = (Date.parse(dateKey) - Date.parse(best.sessionDate)) / 86_400_000;
  return diff <= lookbackDays ? best : null;
}

function fxOnOrBefore(points: FxPoint[] | undefined, dateKey: string, maxAgeDays = 7): number | null {
  if (!points || points.length === 0) return null;
  let best: FxPoint | null = null;
  for (const p of points) {
    if (p.dateKey <= dateKey) best = p;
    else break;
  }
  if (!best) return null;
  const age = (Date.parse(dateKey) - Date.parse(best.dateKey)) / 86_400_000;
  return age <= maxAgeDays ? best.rate : null;
}

function sessionOpenUtc(dateKey: string, exchangeId: string): string {
  const ex = exchangeInfo(exchangeId);
  const [y, m, d] = dateKey.split('-').map(Number);
  const [oh, om] = ex.session.open.split(':').map(Number);
  if (ex.id === 'UNKNOWN') return `${dateKey}T00:00:00.000Z`;
  return new Date(utcFromLocal(y, m, d, oh, om, ex.timeZone)).toISOString();
}

function endOfDayUtc(dateKey: string): string {
  return `${dateKey}T23:59:59.999Z`;
}

/** Latest FX rate ≤ dateKey for a pair "NATIVE->BASE". */
function fxAt(data: ReconstructionData, native: string, base: string, dateKey: string): number | null {
  if (native === base) return 1;
  return fxOnOrBefore(data.fx[`${native}->${base}`], dateKey);
}

/* ------------------------------------------------- corporate actions (RM7) */

function applySplits(state: AppState, data: ReconstructionData, todayKey: string, notes: string[]): AppState {
  if (data.splits === null) {
    // provider cannot report splits → flag positions (X2: flag, don't guess)
    return {
      ...state,
      positions: state.positions.map((p) =>
        p.flags.includes('split_unverified') ? p : { ...p, flags: [...p.flags, 'split_unverified'] },
      ),
    };
  }
  let positions = state.positions;
  let changed = false;
  for (const p of state.positions) {
    const records = data.splits[instrumentId(p.instrument)] ?? [];
    for (const rec of records) {
      const actionKey = `split:${rec.id}`;
      if (rec.exDate > todayKey) continue;
      if (p.appliedActions.includes(actionKey)) continue;
      const idx = positions.findIndex((x) => instrumentId(x.instrument) === instrumentId(p.instrument));
      const cur = positions[idx];
      if (cur.qty === 0) continue;
      // whole shares only (I5): if the split would create fractions, flag it
      const newQty = (cur.qty * rec.numerator) / rec.denominator;
      const lotsOk = cur.lots.every((l) => Number.isInteger((l.qty * rec.numerator) / rec.denominator));
      if (!Number.isInteger(newQty) || !lotsOk) {
        positions = replacePos(positions, idx, {
          ...cur,
          flags: cur.flags.includes('split_unverified') ? cur.flags : [...cur.flags, 'split_unverified'],
          appliedActions: [...cur.appliedActions, actionKey],
        });
        changed = true;
        notes.push(`${instrumentId(p.instrument)}: split ${rec.numerator}:${rec.denominator} on ${rec.exDate} would create fractional shares — flagged for manual handling (X2).`);
        continue;
      }
      // cost basis (base total) is unchanged by a split; per-share cost changes
      positions = replacePos(positions, idx, {
        ...cur,
        qty: newQty,
        lots: cur.lots.map((l) => ({ ...l, qty: (l.qty * rec.numerator) / rec.denominator })),
        appliedActions: [...cur.appliedActions, actionKey],
        flags: cur.flags.filter((f) => f !== 'split_unverified'),
      });
      changed = true;
      notes.push(`${instrumentId(p.instrument)}: split ${rec.numerator}:${rec.denominator} applied on ${rec.exDate} (RM7).`);
    }
  }
  return changed ? { ...state, positions } : state;
}

function replacePos(positions: Position[], idx: number, p: Position): Position[] {
  const next = positions.slice();
  next[idx] = p;
  return next;
}

function applyDividends(
  state: AppState,
  data: ReconstructionData,
  todayKey: string,
  notes: string[],
): AppState {
  if (data.dividends === null) {
    return {
      ...state,
      positions: state.positions.map((p) =>
        p.flags.includes('dividends_unverified') ? p : { ...p, flags: [...p.flags, 'dividends_unverified'] },
      ),
    };
  }
  let next = state;
  let flagged = false;
  for (const p of state.positions) {
    const records = data.dividends[instrumentId(p.instrument)] ?? [];
    for (const rec of records) {
      const actionKey = `div:${rec.id}`;
      if (rec.payDate > todayKey) continue;
      if (p.appliedActions.includes(actionKey)) continue;
      // shares held on the ex-date (approximate: replay-derived qty)
      const atEx = replayAt(state, new Date(`${endOfDayUtc(rec.exDate)}`)).positions.find(
        (x) => instrumentId(x.instrument) === instrumentId(p.instrument),
      );
      const qty = atEx?.qty ?? 0;
      if (qty <= 0) continue;
      const rate = fxAt(data, p.instrument.currency, next.account!.baseCurrency, rec.payDate);
      if (rate == null) {
        flagged = true;
        continue; // retry next run — never fabricate a rate (R4/X4)
      }
      const nativeAmount = rec.amountNativeMinor * qty;
      const baseAmount = convertMinor(nativeAmount, quantizeRate(rate));
      const actionId = `div:${rec.id}:${instrumentId(p.instrument)}`;
      if (next.cashEvents.some((e) => e.actionId === actionId)) continue;
      const event: CashEvent = {
        id: `ce_${actionId}`,
        type: 'dividend',
        instrument: p.instrument,
        qty,
        amountMinor: baseAmount,
        nativeAmountMinor: nativeAmount,
        fxRate: quantizeRate(rate),
        paidAtUtc: `${rec.payDate}T21:00:00.000Z`,
        actionId,
      };
      next = {
        ...next,
        cashEvents: [...next.cashEvents, event],
        positions: next.positions.map((x) =>
          instrumentId(x.instrument) === instrumentId(p.instrument)
            ? { ...x, appliedActions: [...x.appliedActions, actionKey] }
            : x,
        ),
      };
      notes.push(`Dividend ${instrumentId(p.instrument)} ${rec.amountNativeMinor}/sh on ${rec.payDate} credited (RM7).`);
    }
    if (flagged) break;
  }
  return next;
}

/* ------------------------------------------------------- orders (R2/R3) */

interface FillDecision {
  priceMinor: Minor;
  sessionDate: string;
  skip: 'more-data' | 'expired' | null;
}

function evaluateOrderAgainstCandles(order: Order, candles: Candle[], createdKey: string, createdOpenMs: number): FillDecision | null {
  for (const c of candles) {
    if (c.sessionDate < createdKey) continue;
    const createdInSession = c.sessionDate === createdKey && Date.parse(order.createdAtUtc) >= createdOpenMs;
    if (createdInSession) continue; // never fill before/at placement within the same daily candle
    const firstEligible = c.sessionDate === createdKey || c.sessionDate > createdKey;
    if (!firstEligible) continue;
    if (c.openMinor <= 0 || c.highMinor <= 0 || c.lowMinor <= 0) continue; // bad candle → keep waiting (R4)

    switch (order.type) {
      case 'market':
        return { priceMinor: c.openMinor, sessionDate: c.sessionDate, skip: null };
      case 'limit': {
        if (order.side === 'buy' && c.lowMinor <= order.limitPriceMinor!) {
          return { priceMinor: Math.min(order.limitPriceMinor!, c.openMinor), sessionDate: c.sessionDate, skip: null };
        }
        if (order.side === 'sell' && c.highMinor >= order.limitPriceMinor!) {
          return { priceMinor: Math.max(order.limitPriceMinor!, c.openMinor), sessionDate: c.sessionDate, skip: null };
        }
        break;
      }
      case 'stop': {
        if (order.side === 'buy' && c.highMinor >= order.stopPriceMinor!) {
          return { priceMinor: Math.max(order.stopPriceMinor!, c.openMinor), sessionDate: c.sessionDate, skip: null };
        }
        if (order.side === 'sell' && c.lowMinor <= order.stopPriceMinor!) {
          return { priceMinor: Math.min(order.stopPriceMinor!, c.openMinor), sessionDate: c.sessionDate, skip: null };
        }
        break;
      }
      case 'stop_limit': {
        const stop = order.stopPriceMinor!;
        const limit = order.stopLimitPriceMinor!;
        const triggered = order.side === 'buy' ? c.highMinor >= stop : c.lowMinor <= stop;
        if (!triggered) break;
        if (order.side === 'buy' && c.lowMinor <= limit) {
          return { priceMinor: Math.min(limit, Math.max(stop, c.openMinor)), sessionDate: c.sessionDate, skip: null };
        }
        if (order.side === 'sell' && c.highMinor >= limit) {
          return { priceMinor: Math.max(limit, Math.min(stop, c.openMinor)), sessionDate: c.sessionDate, skip: null };
        }
        break;
      }
    }
  }
  return null;
}

function reconstructOrders(state: AppState, data: ReconstructionData, nowUtc: Date, notes: string[]): {
  state: AppState;
  filled: string[];
  waiting: string[];
} {
  let next = state;
  const filled: string[] = [];
  const waiting: string[] = [];
  const pending = state.orders
    .filter((o) => o.status === 'queued' || o.status === 'waiting_data')
    .sort((a, b) => (a.createdAtUtc === b.createdAtUtc ? a.id.localeCompare(b.id) : a.createdAtUtc < b.createdAtUtc ? -1 : 1));

  for (const order of pending) {
    // idempotency guard (R5): never double-fill
    if (next.fills.some((f) => f.orderId === order.id)) {
      next = markOrder(next, order.id, { status: 'filled', reason: undefined, waitingReason: undefined });
      continue;
    }
    const id = instrumentId(order.instrument);
    const candles = seriesFor(data.candles, id);

    if (data.missing[id] || candles.length === 0) {
      next = markOrder(next, order.id, {
        status: 'waiting_data',
        waitingReason: 'Waiting for candle data (R4) — the order will fill once market data is available. Never guessed.',
      });
      waiting.push(order.id);
      continue;
    }

    const createdKey = order.createdSessionDate ?? marketStatus(new Date(order.createdAtUtc), order.instrument.exchange).sessionDate;
    const ex = exchangeInfo(order.instrument.exchange);
    const [oy, om, od] = createdKey.split('-').map(Number);
    const [oh, omm] = ex.session.open.split(':').map(Number);
    const createdOpenMs = ex.id === 'UNKNOWN' ? 0 : utcFromLocal(oy, om, od, oh, omm, ex.timeZone);

    // limit eligible candles by day-order expiry
    let eligible = candles;
    let expired = false;
    if (order.duration === 'day') {
      const expiryTs = order.expiresAtUtc ? Date.parse(order.expiresAtUtc) : null;
      const expiryKey = order.expiresAtUtc ? dateKeyOf(new Date(order.expiresAtUtc), ex.timeZone) : null;
      eligible = expiryKey ? candles.filter((c) => c.sessionDate <= expiryKey) : candles;
      if (expiryTs != null && nowUtc.getTime() > expiryTs) expired = true;
    }

    const decision = evaluateOrderAgainstCandles(order, eligible, createdKey, createdOpenMs);

    if (!decision) {
      if (expired) {
        next = markOrder(next, order.id, {
          status: 'expired',
          reason: 'Day order expired before its price condition triggered (RM4).',
          waitingReason: undefined,
        });
        notes.push(`Order ${order.id} expired at session close without triggering (RM4).`);
      } else {
        next = markOrder(next, order.id, {
          status: 'queued',
          waitingReason: order.type === 'market' ? 'Waiting for the next session open (R2).' : 'Waiting for the price condition to trigger (R3).',
        });
      }
      continue;
    }

    if (decision.skip === 'more-data') continue;

    // FX for the fill session — unavailable → keep waiting (R4)
    const base = next.account!.baseCurrency;
    const rate = fxAt(data, order.instrument.currency, base, decision.sessionDate);
    if (rate == null && order.instrument.currency !== base) {
      next = markOrder(next, order.id, {
        status: 'waiting_data',
        waitingReason: `Waiting for historical FX ${order.instrument.currency}->${base} for ${decision.sessionDate} (R4).`,
      });
      waiting.push(order.id);
      continue;
    }

    const at = new Date(sessionOpenUtc(decision.sessionDate, order.instrument.exchange));
    const { state: st, fill } = executeFill(next, order, {
      priceMinor: decision.priceMinor,
      fxRateNativeToBase: rate ?? 1,
      atUtc: at,
      spreadBpsApplied: 0, // R2/R3 fill at the documented candle price
      slippageBpsApplied: 0,
    });
    next = markOrder(st, order.id, { status: 'filled', fillId: fill.id, waitingReason: undefined, reason: undefined });
    filled.push(order.id);
    notes.push(
      `${order.side} ${order.qty} ${instrumentId(order.instrument)} filled at ${fill.nativePriceMinor} on ${decision.sessionDate} (${order.type} order, reconstructed R2/R3).`,
    );
  }
  return { state: next, filled, waiting };
}

function markOrder(state: AppState, orderId: string, patch: Partial<Order>): AppState {
  return {
    ...state,
    orders: state.orders.map((o) => (o.id === orderId ? { ...o, ...patch } : o)),
  };
}

/* ---------------------------------------------- snapshot backfill (R1) */

function buildSnapshot(
  state: AppState,
  dateKey: string,
  data: ReconstructionData,
): { snapshot: import('./types').Snapshot; rates: Record<string, number> } | null {
  const acct = state.account!;
  const replay = replayAt(state, new Date(endOfDayUtc(dateKey)));
  let positionsValue = 0;
  let unreal = 0;
  let stale = false;
  const fxRates: Record<string, number> = {};
  for (const p of replay.positions) {
    const candles = seriesFor(data.candles, instrumentId(p.instrument));
    const candle = candleOnOrBefore(candles, dateKey);
    if (!candle) return null; // no price data → skip this date (R4, never guess)
    if (candle.sessionDate !== dateKey) stale = true;
    const native = p.instrument.currency;
    let rate = 1;
    if (native !== acct.baseCurrency) {
      const r = fxAt(data, native, acct.baseCurrency, dateKey);
      if (r == null) return null; // missing FX → skip date (R4)
      rate = r;
      fxRates[`${native}->${acct.baseCurrency}`] = rate;
    }
    const value = convertMinor(candle.closeMinor * p.qty, rate);
    positionsValue += value;
    unreal += value - p.costBaseMinor;
  }
  const total = replay.cashMinor + positionsValue;
  const snapshot: import('./types').Snapshot = {
    date: dateKey,
    cashMinor: replay.cashMinor,
    positionsValueMinor: positionsValue,
    totalValueMinor: total,
    realizedCumMinor: replay.realizedGrossMinor,
    unrealizedMinor: unreal,
    feesCumMinor: replay.feesMinor,
    dividendsCumMinor: replay.dividendsMinor,
    taxPaidCumMinor: replay.taxMinor,
    fxRates,
    stale,
  };
  return { snapshot, rates: fxRates };
}

function backfillSnapshots(state: AppState, data: ReconstructionData, nowUtc: Date, notes: string[]): {
  state: AppState;
  created: string[];
} {
  const acct = state.account;
  if (!acct) return { state, created: [] };
  const createdDate = acct.createdAtUtc.slice(0, 10);
  const todayKey = dateKeyOf(nowUtc, 'UTC');
  let cursorDate = state.meta.lastSnapshotDate;
  const snapshots = state.snapshots.slice();
  const created: string[] = [];

  const startDate = cursorDate ? nextDay(cursorDate) : createdDate;
  let date = startDate;
  while (date < todayKey) {
    if (Date.parse(date) >= Date.parse(createdDate)) {
      const built = buildSnapshot(state, date, data);
      if (built) {
        snapshots.push(built.snapshot);
        created.push(date);
        notes.push(`Snapshot backfilled for ${date}${built.snapshot.stale ? ' (using last available price — stale)' : ''}.`);
      } else {
        notes.push(`Snapshot for ${date} skipped: market data unavailable (R4).`);
      }
    }
    date = nextDay(date);
  }
  const last = created.length > 0 ? created[created.length - 1] : state.meta.lastSnapshotDate;
  return {
    state: { ...state, snapshots: sortSnapshots(snapshots), meta: { ...state.meta, lastSnapshotDate: last } },
    created,
  };
}

function sortSnapshots<T extends { date: string }>(s: T[]): T[] {
  return s.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

function nextDay(dateKey: string): string {
  const t = Date.parse(dateKey) + 86_400_000;
  const d = new Date(t);
  return toDateKey(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/* ------------------------------------------------------------- main entry */

export function reconstruct(input: { state: AppState; nowUtc: Date; data: ReconstructionData }): ReconstructionResult {
  const { state, nowUtc, data } = input;
  const notes: string[] = [];
  if (!state.account) return { state, notes: ['No account — nothing to reconstruct.'], filledOrderIds: [], waitingOrderIds: [], snapshotsCreated: [] };

  const todayKey = dateKeyOf(nowUtc, 'UTC');
  let next = state;

  // corporate actions first (positions must be correct before snapshotting)
  next = applySplits(next, data, todayKey, notes);
  next = applyDividends(next, data, todayKey, notes);

  // queued orders (R2/R3)
  const ordersResult = reconstructOrders(next, data, nowUtc, notes);
  next = ordersResult.state;

  // snapshots (R1) — always last, so they include everything above
  const snapResult = backfillSnapshots(next, data, nowUtc, notes);
  next = snapResult.state;

  next = {
    ...next,
    meta: { ...next.meta, lastReconstructAtUtc: nowUtc.toISOString() },
  };

  return {
    state: next,
    notes,
    filledOrderIds: ordersResult.filled,
    waitingOrderIds: ordersResult.waiting,
    snapshotsCreated: snapResult.created,
  };
}

/* ------------------------------------------------- fetch window planning */

export interface FetchWindow {
  fromUtc: Date;
  toUtc: Date;
  instruments: Instrument[];
  fxPairs: { native: string; base: string }[];
}

/**
 * What market data do we need for reconstruction? Only what is held/queued —
 * never bulk-fetch (C3). Returns null when nothing is needed.
 */
export function planFetchWindow(state: AppState, nowUtc: Date): FetchWindow | null {
  if (!state.account) return null;
  const base = state.account.baseCurrency;
  const fromCandidates: number[] = [];
  const createdDate = Date.parse(`${state.account.createdAtUtc.slice(0, 10)}T00:00:00.000Z`);
  fromCandidates.push(createdDate);

  const instruments = new Map<string, Instrument>();
  for (const p of state.positions) {
    instruments.set(instrumentId(p.instrument), p.instrument);
    fromCandidates.push(Date.parse(p.openedAtUtc));
    // corporate actions may need data from acquisition
    if (p.appliedActions.length >= 0) fromCandidates.push(Date.parse(p.openedAtUtc));
  }
  for (const o of state.orders) {
    if (o.status === 'queued' || o.status === 'waiting_data') {
      fromCandidates.push(Date.parse(o.createdAtUtc));
      instruments.set(instrumentId(o.instrument), o.instrument);
    }
  }
  if (state.meta.lastSnapshotDate) {
    fromCandidates.push(Date.parse(`${state.meta.lastSnapshotDate}T00:00:00.000Z`));
  }
  const from = new Date(Math.min(...fromCandidates));

  const fxPairs: { native: string; base: string }[] = [];
  const seen = new Set<string>();
  for (const inst of instruments.values()) {
    if (inst.currency !== base && !seen.has(`${inst.currency}->${base}`)) {
      seen.add(`${inst.currency}->${base}`);
      fxPairs.push({ native: inst.currency, base });
    }
  }
  if (instruments.size === 0 && !state.meta.lastSnapshotDate) return null;
  return { fromUtc: from, toUtc: nowUtc, instruments: [...instruments.values()], fxPairs };
}
