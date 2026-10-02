/**
 * Reconstruction tests (spec §6.4): R1 snapshot backfill, R2/R3 order fills,
 * R4 missing data, R5 idempotency — plus determinism (TST3) and corporate
 * actions (RM7).
 */
import { describe, it, expect } from 'vitest';
import { reconstruct, emptyData, replayAt, planFetchWindow, type ReconstructionData } from '../src/engine/reconstruct';
import { executeFill, computeValuation, reconcile, placeOrder } from '../src/engine/engine';
import { AAPL, RELIANCE, makeState, quote, ctx, draft, NOW, rid } from './helpers';
import type { AppState, Candle, Order, SplitRecord, DividendRecord, Instrument } from '../src/engine/types';

const AAPL_ID = 'NASDAQ:AAPL';

function candle(sessionDate: string, open: number, high: number, low: number, close: number): Candle {
  return {
    timeUtc: `${sessionDate}T13:30:00.000Z`,
    sessionDate,
    openMinor: open,
    highMinor: high,
    lowMinor: low,
    closeMinor: close,
    volume: 100_000_000,
  };
}

function queuedOrder(over: Partial<Order> = {}): Order {
  return {
    id: rid('ord'),
    instrument: AAPL,
    side: 'buy',
    type: 'market',
    duration: 'gtc',
    qty: 10,
    createdAtUtc: '2025-06-04T12:00:00.000Z', // before the 13:30Z open
    createdSessionDate: '2025-06-04',
    status: 'queued',
    ...over,
  };
}

function withOrders(state: AppState, orders: Order[]): AppState {
  return { ...state, orders: [...state.orders, ...orders] };
}

function data(over: Partial<ReconstructionData> = {}): ReconstructionData {
  return { ...emptyData(), ...over };
}

describe('R2: queued market orders fill at the next session open', () => {
  it('fills at the candle open of the first eligible session', () => {
    const st = makeState({ realism: false });
    const order = queuedOrder();
    const r = reconstruct({
      state: withOrders(st, [order]),
      nowUtc: NOW,
      data: data({ candles: { [AAPL_ID]: [candle('2025-06-04', 19_000, 19_500, 18_800, 19_300)] } }),
    });
    expect(r.filledOrderIds).toEqual([order.id]);
    const fill = r.state.fills[0];
    expect(fill.nativePriceMinor).toBe(19_000); // open
    expect(fill.timestampUtc).toBe('2025-06-04T13:30:00.000Z');
    expect(r.state.orders[0].status).toBe('filled');
    expect(r.state.positions[0].qty).toBe(10);
    expect(r.notes.some((n) => /reconstructed R2\/R3/.test(n))).toBe(true);
  });

  it('never fills against the same session candle when created mid-session', () => {
    const st = makeState({ realism: false });
    const order = queuedOrder({ createdAtUtc: NOW.toISOString() }); // 15:00Z, after open
    const r = reconstruct({
      state: withOrders(st, [order]),
      nowUtc: NOW,
      data: data({
        candles: {
          [AAPL_ID]: [
            candle('2025-06-04', 19_000, 19_500, 18_800, 19_300), // same day — skipped
            candle('2025-06-05', 19_400, 19_800, 19_200, 19_600), // next session — eligible
          ],
        },
      }),
    });
    expect(r.filledOrderIds).toEqual([order.id]);
    expect(r.state.fills[0].nativePriceMinor).toBe(19_400);
    expect(r.state.fills[0].timestampUtc).toBe('2025-06-05T13:30:00.000Z');
  });

  it('charges trading costs on reconstruction fills when Realism Mode is on', () => {
    const st = makeState({ realism: true });
    const order = queuedOrder({ side: 'sell', qty: 100 });
    // need a position first
    const bought = executeFill(st, queuedOrder({ id: 'seed', qty: 100, status: 'filled' }), {
      priceMinor: 19_000,
      fxRateNativeToBase: 1,
      atUtc: new Date('2025-06-03T14:00:00.000Z'),
      spreadBpsApplied: 0,
      slippageBpsApplied: 0,
    }).state;
    const r = reconstruct({
      state: withOrders(bought, [order]),
      nowUtc: NOW,
      data: data({ candles: { [AAPL_ID]: [candle('2025-06-04', 19_000, 19_500, 18_800, 19_300)] } }),
    });
    expect(r.filledOrderIds).toEqual([order.id]);
    const sellFill = r.state.fills.find((f) => f.orderId === order.id)!;
    expect(sellFill.feesMinor).toBeGreaterThan(0);
    expect(sellFill.baseCreditedMinor).toBe(sellFill.baseGrossMinor - sellFill.feesMinor);
  });
});

describe('R3: conditional orders evaluate candles chronologically', () => {
  it('buy limit fills only when a candle trades down to the limit', () => {
    const st = makeState({ realism: false });
    const order = queuedOrder({ type: 'limit', limitPriceMinor: 18_900 });
    const tooHigh = reconstruct({
      state: withOrders(st, [order]),
      nowUtc: NOW,
      data: data({ candles: { [AAPL_ID]: [candle('2025-06-04', 19_000, 19_500, 18_950, 19_300)] } }),
    });
    expect(tooHigh.filledOrderIds).toEqual([]);
    expect(tooHigh.state.orders[0].status).toBe('queued');

    const r = reconstruct({
      state: withOrders(st, [order]),
      nowUtc: NOW,
      data: data({ candles: { [AAPL_ID]: [candle('2025-06-04', 19_000, 19_500, 18_800, 19_300)] } }),
    });
    expect(r.filledOrderIds).toEqual([order.id]);
    // gap-down open: fills at min(limit, open) = the limit price
    expect(r.state.fills[0].nativePriceMinor).toBe(18_900);
  });

  it('sell limit fills at max(limit, open) when the high reaches the limit', () => {
    const st = makeState({ realism: false });
    const bought = executeFill(st, queuedOrder({ id: 'seed', status: 'filled' }), {
      priceMinor: 19_000,
      fxRateNativeToBase: 1,
      atUtc: new Date('2025-06-03T14:00:00.000Z'),
      spreadBpsApplied: 0,
      slippageBpsApplied: 0,
    }).state;
    const order = queuedOrder({ side: 'sell', type: 'limit', limitPriceMinor: 19_500 });
    const r = reconstruct({
      state: withOrders(bought, [order]),
      nowUtc: NOW,
      data: data({ candles: { [AAPL_ID]: [candle('2025-06-04', 19_000, 19_600, 18_800, 19_300)] } }),
    });
    expect(r.filledOrderIds).toEqual([order.id]);
    expect(r.state.fills.find((f) => f.orderId === order.id)!.nativePriceMinor).toBe(19_500);
    expect(r.state.positions[0].qty).toBe(0);
  });

  it('stop orders trigger on the stop side', () => {
    const st = makeState({ realism: false });
    const order = queuedOrder({ type: 'stop', stopPriceMinor: 19_200 }); // buy stop
    const r = reconstruct({
      state: withOrders(st, [order]),
      nowUtc: NOW,
      data: data({ candles: { [AAPL_ID]: [candle('2025-06-04', 19_000, 19_500, 18_800, 19_300)] } }),
    });
    // high 19_500 ≥ stop 19_200 → fills at max(stop, open) = 19_200
    expect(r.state.fills[0].nativePriceMinor).toBe(19_200);

    const never = reconstruct({
      state: withOrders(st, [queuedOrder({ type: 'stop', stopPriceMinor: 20_000 })]),
      nowUtc: NOW,
      data: data({ candles: { [AAPL_ID]: [candle('2025-06-04', 19_000, 19_500, 18_800, 19_300)] } }),
    });
    expect(never.filledOrderIds).toEqual([]);
  });
});

describe('R4: missing data never produces a guessed fill', () => {
  it('marks orders waiting_data when there are no candles', () => {
    const st = makeState({ realism: false });
    const order = queuedOrder();
    const r = reconstruct({ state: withOrders(st, [order]), nowUtc: NOW, data: data() });
    expect(r.waitingOrderIds).toEqual([order.id]);
    expect(r.state.orders[0].status).toBe('waiting_data');
    expect(r.state.orders[0].waitingReason).toMatch(/Never guessed/);
    expect(r.state.fills).toHaveLength(0);
  });

  it('marks orders waiting_data when the fetch explicitly failed', () => {
    const st = makeState({ realism: false });
    const order = queuedOrder();
    const r = reconstruct({
      state: withOrders(st, [order]),
      nowUtc: NOW,
      data: data({ missing: { [AAPL_ID]: true } }),
    });
    expect(r.waitingOrderIds).toEqual([order.id]);
    expect(r.state.fills).toHaveLength(0);
  });

  it('keeps waiting when the cross-currency FX history is missing', () => {
    const st = makeState({ base: 'USD', realism: false });
    const order = queuedOrder({ instrument: RELIANCE, createdAtUtc: '2025-06-03T12:00:00.000Z', createdSessionDate: '2025-06-03' });
    const r = reconstruct({
      state: withOrders(st, [order]),
      nowUtc: NOW,
      data: data({ candles: { 'NSE:RELIANCE': [candle('2025-06-04', 290_000, 295_000, 288_000, 292_000)] } }),
    });
    expect(r.waitingOrderIds).toEqual([order.id]);
    expect(r.state.orders[0].waitingReason).toMatch(/FX INR->USD/);
    expect(r.state.fills).toHaveLength(0);
  });
});

describe('R5: idempotency and determinism (TST3)', () => {
  it('running twice never double-fills', () => {
    const st = makeState({ realism: false });
    const order = queuedOrder();
    const d = data({ candles: { [AAPL_ID]: [candle('2025-06-04', 19_000, 19_500, 18_800, 19_300)] } });
    const first = reconstruct({ state: withOrders(st, [order]), nowUtc: NOW, data: d });
    expect(first.state.fills).toHaveLength(1);

    const second = reconstruct({ state: first.state, nowUtc: NOW, data: d });
    expect(second.state.fills).toHaveLength(1); // still one
    expect(second.state.positions[0].qty).toBe(10); // qty unchanged
    expect(second.filledOrderIds).toEqual([]);
    expect(second.state.orders[0].status).toBe('filled');
  });

  it('same inputs → same economic outcome (deterministic reconstruction)', () => {
    const base = makeState({ realism: true });
    const order = queuedOrder();
    const d = data({ candles: { [AAPL_ID]: [candle('2025-06-04', 19_000, 19_500, 18_800, 19_300)] } });
    const now = new Date('2025-06-10T12:00:00.000Z');

    const a = reconstruct({ state: withOrders(base, [order]), nowUtc: now, data: structuredClone(d) });
    const b = reconstruct({ state: withOrders(base, [order]), nowUtc: now, data: structuredClone(d) });

    expect(a.state.fills.length).toBe(b.state.fills.length);
    expect(a.state.fills.map((f) => [f.nativePriceMinor, f.feesMinor, f.baseGrossMinor, f.timestampUtc]))
      .toEqual(b.state.fills.map((f) => [f.nativePriceMinor, f.feesMinor, f.baseGrossMinor, f.timestampUtc]));
    expect(a.state.positions.map((p) => [p.qty, p.costBaseMinor, p.realizedGrossBaseMinor]))
      .toEqual(b.state.positions.map((p) => [p.qty, p.costBaseMinor, p.realizedGrossBaseMinor]));
    expect(a.state.snapshots).toEqual(b.state.snapshots); // no randomness in snapshots
    expect(a.filledOrderIds).toEqual(b.filledOrderIds);
    expect(a.waitingOrderIds).toEqual(b.waitingOrderIds);
    expect(a.snapshotsCreated).toEqual(b.snapshotsCreated);
  });

  it('replayAt recomputes the same cash as the wallet ledger', () => {
    const st = makeState({ realism: true });
    const order = queuedOrder();
    const d = data({ candles: { [AAPL_ID]: [candle('2025-06-04', 19_000, 19_500, 18_800, 19_300)] } });
    const r = reconstruct({ state: withOrders(st, [order]), nowUtc: NOW, data: d });
    const replay = replayAt(r.state, new Date('2025-06-04T23:59:59.999Z'));
    const v = computeValuation(r.state, () => quote(193, { prevCloseMinor: 19_000 }), () => null, new Date('2025-06-04T23:59:59.999Z'));
    expect(replay.cashMinor).toBe(v.cashMinor);
    expect(replay.positions[0].qty).toBe(10);
    // and the V5 identity still holds after reconstruction
    expect(reconcile(r.state, v).ok).toBe(true);
  });
});

describe('R1: snapshot backfill', () => {
  function stateWithPosition(): AppState {
    const st = makeState({ realism: false });
    const q = quote(190, { bidMinor: 19_000, askMinor: 19_000 });
    const r = placeOrder(st, draft({ instrument: AAPL, type: 'limit', limitPriceMinor: 19_000, qty: 10 }), ctx({ quote: q }));
    expect(r.order.status).toBe('filled');
    return r.state;
  }

  it('creates missing daily snapshots and is idempotent on re-run', () => {
    const st = stateWithPosition();
    const now = new Date('2025-06-10T12:00:00.000Z');
    const d = data({ candles: { [AAPL_ID]: [candle('2025-06-04', 19_000, 19_500, 18_800, 19_300)] } });
    const r = reconstruct({ state: st, nowUtc: now, data: d });
    expect(r.snapshotsCreated).toEqual(['2025-06-04', '2025-06-05', '2025-06-06', '2025-06-07', '2025-06-08', '2025-06-09']);
    expect(r.state.snapshots).toHaveLength(6);
    expect(r.state.meta.lastSnapshotDate).toBe('2025-06-09');
    for (const s of r.state.snapshots) {
      expect(s.totalValueMinor).toBe(s.cashMinor + s.positionsValueMinor);
      expect(Number.isInteger(s.totalValueMinor)).toBe(true);
    }
    // first day prices are fresh; later days reuse the last close → stale (A2)
    expect(r.state.snapshots[0].stale).toBe(false);
    expect(r.state.snapshots[1].stale).toBe(true);

    // second run adds nothing (R5)
    const again = reconstruct({ state: r.state, nowUtc: now, data: d });
    expect(again.snapshotsCreated).toEqual([]);
    expect(again.state.snapshots).toHaveLength(6);
  });

  it('skips days it cannot price instead of guessing (R4)', () => {
    const st = stateWithPosition();
    const now = new Date('2025-06-10T12:00:00.000Z');
    const r = reconstruct({ state: st, nowUtc: now, data: data() }); // no candles
    expect(r.snapshotsCreated).toEqual([]);
    expect(r.notes.some((n) => /skipped: market data unavailable/.test(n))).toBe(true);
    expect(r.state.meta.lastSnapshotDate).toBeNull();
  });
});

describe('corporate actions (RM7)', () => {
  function stateWithOldPosition(): AppState {
    const st = makeState({ realism: false });
    const order: Order = { ...draft({ instrument: AAPL, qty: 10 }), id: 'seed', createdAtUtc: '2025-06-01T12:00:00.000Z', createdSessionDate: '2025-06-01', status: 'filled' };
    const { state } = executeFill(st, order, {
      priceMinor: 19_000,
      fxRateNativeToBase: 1,
      atUtc: new Date('2025-06-01T14:00:00.000Z'),
      spreadBpsApplied: 0,
      slippageBpsApplied: 0,
    });
    return state;
  }

  it('credits dividends once (idempotent by action id)', () => {
    const st = stateWithOldPosition();
    const now = new Date('2025-06-10T12:00:00.000Z');
    const div: DividendRecord = { id: 'div-1', exDate: '2025-06-02', payDate: '2025-06-06', amountNativeMinor: 50, currency: 'USD' };
    const d = data({ dividends: { [AAPL_ID]: [div] }, splits: {} });
    const r = reconstruct({ state: st, nowUtc: now, data: d });
    expect(r.state.cashEvents).toHaveLength(1);
    expect(r.state.cashEvents[0].amountMinor).toBe(500); // 10 shares × 50¢
    expect(r.state.cashEvents[0].qty).toBe(10); // held on the ex-date
    expect(r.state.positions[0].appliedActions).toContain('div:div-1');

    const again = reconstruct({ state: r.state, nowUtc: now, data: d });
    expect(again.state.cashEvents).toHaveLength(1); // never double-credited
  });

  it('flags positions when the provider does not expose dividends (X3)', () => {
    const st = stateWithOldPosition();
    const r = reconstruct({ state: st, nowUtc: new Date('2025-06-10T12:00:00.000Z'), data: data({ dividends: null, splits: {} }) });
    expect(r.state.positions[0].flags).toContain('dividends_unverified');
    expect(r.state.cashEvents).toHaveLength(0);
  });

  it('applies a split once, keeping total cost basis', () => {
    const st = stateWithOldPosition();
    const now = new Date('2025-06-10T12:00:00.000Z');
    const split: SplitRecord = { id: 'sp-1', exDate: '2025-06-05', numerator: 2, denominator: 1 };
    const d = data({ splits: { [AAPL_ID]: [split] }, dividends: {} });
    const r = reconstruct({ state: st, nowUtc: now, data: d });
    expect(r.state.positions[0].qty).toBe(20);
    expect(r.state.positions[0].costBaseMinor).toBe(10 * 19_000); // unchanged by a split
    expect(r.state.positions[0].lots[0].qty).toBe(20);

    const again = reconstruct({ state: r.state, nowUtc: now, data: d });
    expect(again.state.positions[0].qty).toBe(20); // applied exactly once
  });

  it('flags fractional splits instead of creating fractional shares (I5/X2)', () => {
    const st = stateWithOldPosition(); // qty 10
    const split: SplitRecord = { id: 'sp-4', exDate: '2025-06-05', numerator: 1, denominator: 4 }; // 10 → 2.5
    const d = data({ splits: { [AAPL_ID]: [split] }, dividends: {} });
    const r = reconstruct({ state: st, nowUtc: new Date('2025-06-10T12:00:00.000Z'), data: d });
    expect(r.state.positions[0].qty).toBe(10); // unchanged
    expect(r.state.positions[0].flags).toContain('split_unverified');
    expect(r.notes.some((n) => /fractional shares/.test(n))).toBe(true);
  });
});

describe('fetch window planning (C3: only what is needed)', () => {
  it('returns null for an empty account', () => {
    const st = makeState();
    expect(planFetchWindow(st, NOW)).toBeNull();
  });

  it('includes held and queued instruments plus their FX pairs', () => {
    const st = makeState({ base: 'USD' });
    const order = queuedOrder({ instrument: RELIANCE });
    const withOrder = withOrders(st, [order]);
    const window = planFetchWindow(withOrder, NOW);
    expect(window).not.toBeNull();
    const ids = window!.instruments.map((i: Instrument) => `${i.exchange}:${i.symbol}`);
    expect(ids).toContain('NSE:RELIANCE');
    expect(window!.fxPairs).toEqual([{ native: 'INR', base: 'USD' }]);
    expect(window!.toUtc).toEqual(NOW);
    expect(window!.fromUtc.getTime()).toBeLessThanOrEqual(Date.parse('2025-06-04T12:00:00.000Z'));
  });

  it('stretches back to the last snapshot date', () => {
    const st = makeState();
    const withSnap: AppState = { ...st, meta: { ...st.meta, lastSnapshotDate: '2025-06-02' }, positions: [{ instrument: AAPL, qty: 5, costBaseMinor: 95_000, realizedGrossBaseMinor: 0, lots: [], openedAtUtc: '2025-06-03T14:00:00.000Z', lastFillAtUtc: '2025-06-03T14:00:00.000Z', flags: [], appliedActions: [] }] };
    const w = planFetchWindow(withSnap, NOW);
    expect(w!.fromUtc.toISOString()).toBe('2025-06-02T00:00:00.000Z');
  });
});
