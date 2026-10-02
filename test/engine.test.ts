/**
 * Engine tests: order validation, fills, average cost, settlement, live order
 * evaluation and the V5 reconciliation identity under a randomized trade
 * sequence (spec TST1).
 */
import { describe, it, expect } from 'vitest';
import {
  placeOrder,
  estimateOrder,
  validateOrder,
  evaluateLiveOrder,
  computeValuation,
  reconcile,
  walletAt,
  cancelOrder,
  heldQty,
  type FxData,
} from '../src/engine/engine';
import { AAPL, MSFT, NIFTY_INDEX, RELIANCE, makeState, quote, ctx, draft, NOW, rid } from './helpers';
import type { AppState } from '../src/engine/types';

const usdFxOf = (): FxData | null => null;

function priceLookup(state: AppState) {
  return (i: { symbol: string; exchange: string }) => {
    const lastFill = [...state.fills].reverse().find((f) => f.instrument.symbol === i.symbol);
    const px = lastFill ? lastFill.nativePriceMinor : 19_000;
    return quote(px / 100, { prevCloseMinor: px });
  };
}

/** Fill an order at a fixed limit price (bid == ask == limit → always marketable). */
function fillAt(st: AppState, over: Parameters<typeof draft>[0], priceMinor: number) {
  const q = quote(priceMinor / 100, { bidMinor: priceMinor, askMinor: priceMinor });
  return placeOrder(st, draft(over), ctx({ quote: q }));
}

describe('order validation (§5)', () => {
  it('rejects indices (I3)', () => {
    const st = makeState();
    const r = placeOrder(st, draft({ instrument: NIFTY_INDEX, qty: 1 }), ctx());
    expect(r.rejectedReason).toMatch(/not tradeable/i);
    expect(r.fill).toBeNull();
  });

  it('rejects fractional quantities (I5)', () => {
    const st = makeState();
    const r = placeOrder(st, draft({ instrument: AAPL, qty: 1.5 }), ctx());
    expect(r.rejectedReason).toMatch(/whole number/i);
  });

  it('rejects lot-size violations (RM6)', () => {
    const st = makeState({ realism: true });
    st.account!.settings.costPresets.US.lotSize = 10;
    const r = placeOrder(st, draft({ instrument: AAPL, qty: 15 }), ctx());
    expect(r.rejectedReason).toMatch(/multiple/i);
  });

  it('rejects off-tick limit prices (RM6)', () => {
    const st = makeState({ realism: true });
    const r = placeOrder(
      st,
      draft({ instrument: RELIANCE, type: 'limit', limitPriceMinor: 10_001, qty: 1 }),
      ctx({ fx: { rate: 0.012, atUtc: NOW.toISOString(), stale: false } }),
    );
    expect(r.rejectedReason).toMatch(/tick size/i);
  });

  it('blocks cross-currency trading without a fresh FX rate (F3)', () => {
    const st = makeState();
    const noFx = placeOrder(st, draft({ instrument: RELIANCE, qty: 1 }), ctx({ fx: null }));
    expect(noFx.rejectedReason).toMatch(/FX rate/i);
    const stale = placeOrder(
      st,
      draft({ instrument: RELIANCE, qty: 1 }),
      ctx({ fx: { rate: 0.012, atUtc: NOW.toISOString(), stale: true } }),
    );
    expect(stale.rejectedReason).toMatch(/stale/i);
    const fresh = placeOrder(
      st,
      draft({ instrument: RELIANCE, qty: 1 }),
      ctx({ fx: { rate: 0.012, atUtc: NOW.toISOString(), stale: false } }),
    );
    expect(fresh.rejectedReason).toBeUndefined();
  });

  it('rejects selling shares you do not hold (E2, no shorting)', () => {
    const st = makeState();
    const r = placeOrder(st, draft({ instrument: AAPL, side: 'sell', qty: 5 }), ctx());
    expect(r.rejectedReason).toMatch(/do not hold/i);
  });

  it('rejects buying with insufficient settled cash (E1)', () => {
    const st = makeState({ balanceMajor: 1 });
    const r = placeOrder(st, draft({ instrument: AAPL, qty: 10 }), ctx());
    expect(r.rejectedReason).toMatch(/Insufficient settled cash/i);
  });
});

describe('order estimates and Realism Mode (RM1–RM3)', () => {
  it('realism off → zero costs and no spread/slippage', () => {
    const st = makeState({ realism: false });
    const est = estimateOrder(st, draft({ instrument: AAPL, qty: 10 }), ctx());
    expect(est.feesMinor).toBe(0);
    expect(est.feeLines).toEqual([]);
    expect(est.fillPriceMinor).toBe(19_000); // exactly the mid quote
    expect(est.realism).toBe(false);
  });

  it('realism on → buy fills above the reference (adverse spread)', () => {
    const st = makeState({ realism: true });
    const est = estimateOrder(st, draft({ instrument: AAPL, qty: 10 }), ctx());
    expect(est.fillPriceMinor).toBeGreaterThan(19_000);
    expect(est.spreadBps).toBeGreaterThan(0);
  });

  it('a real bid/ask suppresses the modelled spread (RM3)', () => {
    const st = makeState({ realism: true });
    const q = quote(190, { bidMinor: 18_995, askMinor: 19_005 });
    const est = estimateOrder(st, draft({ instrument: AAPL, qty: 10 }), ctx({ quote: q }));
    expect(est.spreadBps).toBe(0); // spread already in the quote
    expect(est.fillPriceMinor).toBe(19_005); // ask for a buy
    const sell = estimateOrder(st, draft({ instrument: AAPL, side: 'sell', qty: 10 }), ctx({ quote: q }));
    expect(sell.fillPriceMinor).toBe(18_995); // bid for a sell
  });

  it('US preset charges fees on sells only, itemised (RM2/D5)', () => {
    const st = makeState({ realism: true });
    const buy = estimateOrder(st, draft({ instrument: AAPL, side: 'buy', qty: 100 }), ctx());
    expect(buy.feesMinor).toBe(0); // commission-free, SEC/FINRA are sell-side
    const sell = estimateOrder(st, draft({ instrument: AAPL, side: 'sell', qty: 100 }), ctx());
    expect(sell.feesMinor).toBeGreaterThan(0);
    expect(sell.feeLines.map((l) => l.id)).toContain('sec');
    expect(sell.feeLines.map((l) => l.id)).toContain('taf');
    // FINRA TAF: 100 shares × $0.000166 = 1.66¢ → 2¢ (half-even)
    const taf = sell.feeLines.find((l) => l.id === 'taf');
    expect(taf?.amountMinor).toBe(2);
  });

  it('per-share fee respects its cap', () => {
    const st = makeState({ realism: true });
    const sell = estimateOrder(st, draft({ instrument: AAPL, side: 'sell', qty: 100_000 }), ctx());
    const taf = sell.feeLines.find((l) => l.id === 'taf');
    expect(taf?.amountMinor).toBe(830); // capMinor
  });

  it('FX spread: buys pay a worse rate than sells (F6)', () => {
    const st = makeState({ realism: true, base: 'USD' });
    const c = ctx({ fx: { rate: 0.012, atUtc: NOW.toISOString(), stale: false } });
    const buy = estimateOrder(st, draft({ instrument: RELIANCE, side: 'buy', qty: 1 }), c);
    const sell = estimateOrder(st, draft({ instrument: RELIANCE, side: 'sell', qty: 1 }), c);
    expect(buy.fxRate).toBeGreaterThan(sell.fxRate);
    expect(buy.sameCurrency).toBe(false);
  });

  it('warns when a buy would concentrate the wallet (RM9)', () => {
    const st = makeState({ balanceMajor: 1_000 });
    const est = estimateOrder(st, draft({ instrument: AAPL, qty: 4 }), ctx());
    expect(est.positionPctOfWallet).toBeGreaterThan(0.25);
    expect(est.concentrationWarning).toMatch(/concentrated/i);
  });

  it('explains what happens when the market is closed (M3)', () => {
    const st = makeState();
    const est = estimateOrder(st, draft({ instrument: AAPL }), ctx({ marketOpen: false }));
    expect(est.queued).toBe(true);
    expect(est.queuedNotice).toMatch(/next open/i);
  });
});

describe('placing orders', () => {
  it('fills a market order immediately while open', () => {
    const st = makeState({ realism: true });
    const r = placeOrder(st, draft({ instrument: AAPL, qty: 10 }), ctx());
    expect(r.order.status).toBe('filled');
    expect(r.fill).not.toBeNull();
    expect(heldQty(r.state, AAPL)).toBe(10);
    const w = walletAt(r.state, NOW);
    expect(w.totalCashMinor).toBeLessThan(st.account!.startingBalanceMinor);
    expect(w.settledMinor).toBe(w.totalCashMinor); // buys settle immediately
  });

  it('queues a market order while the market is closed (R2)', () => {
    const st = makeState();
    const r = placeOrder(st, draft({ instrument: AAPL, qty: 10 }), ctx({ marketOpen: false }));
    expect(r.order.status).toBe('queued');
    expect(r.fill).toBeNull();
    expect(r.order.waitingReason).toMatch(/next session open/i);
    expect(r.order.expiresAtUtc).toBeTruthy(); // day order
  });

  it('queues instead of filling on a stale quote (R4)', () => {
    const st = makeState();
    const r = placeOrder(st, draft({ instrument: AAPL, qty: 10 }), ctx({ quote: quote(190, { stale: true }) }));
    expect(r.order.status).toBe('waiting_data');
    expect(r.fill).toBeNull();
  });

  it('queues a non-marketable limit order', () => {
    const st = makeState();
    const r = placeOrder(st, draft({ instrument: AAPL, type: 'limit', limitPriceMinor: 10_000, qty: 10 }), ctx());
    expect(r.order.status).toBe('queued');
    expect(r.fill).toBeNull();
  });

  it('fills a marketable limit immediately at the limit price', () => {
    const st = makeState({ realism: true });
    const q = quote(190, { bidMinor: 18_995, askMinor: 19_005 });
    const r = placeOrder(st, draft({ instrument: AAPL, type: 'limit', limitPriceMinor: 19_100, qty: 10 }), ctx({ quote: q }));
    expect(r.order.status).toBe('filled');
    // a limit price is the user's ceiling — no spread charged on top (RM3)
    expect(r.fill!.nativePriceMinor).toBe(19_100);
  });

  it('cancelOrder only cancels queued orders', () => {
    const st = makeState();
    const r = placeOrder(st, draft({ instrument: AAPL, qty: 10 }), ctx({ marketOpen: false }));
    const cancelled = cancelOrder(r.state, r.order.id);
    expect(cancelled.orders[0].status).toBe('cancelled');
    const filledState = placeOrder(makeState(), draft({ instrument: AAPL, qty: 1 }), ctx()).state;
    const after = cancelOrder(filledState, filledState.orders[0].id);
    expect(after.orders[0].status).toBe('filled');
  });
});

describe('average cost and realized P&L (V3)', () => {
  it('buys accumulate a weighted average cost', () => {
    let st = makeState({ realism: false, balanceMajor: 100_000 });
    st = fillAt(st, { instrument: AAPL, type: 'limit', limitPriceMinor: 10_000, qty: 10 }, 10_000).state;
    expect(st.positions[0].qty).toBe(10);
    expect(st.positions[0].costBaseMinor).toBe(100_000); // 10 × $100.00
    st = fillAt(st, { instrument: AAPL, type: 'limit', limitPriceMinor: 11_000, qty: 20 }, 11_000).state;
    expect(st.positions[0].qty).toBe(30);
    expect(st.positions[0].costBaseMinor).toBe(320_000); // $1,000 + $2,200
    expect(st.positions[0].lots).toHaveLength(2);
  });

  it('a sell realizes gross P&L and shrinks the position', () => {
    let st = makeState({ realism: false, balanceMajor: 100_000 });
    st = fillAt(st, { instrument: AAPL, type: 'limit', limitPriceMinor: 10_000, qty: 10 }, 10_000).state;
    st = fillAt(st, { instrument: AAPL, side: 'sell', type: 'limit', limitPriceMinor: 12_000, qty: 10 }, 12_000).state;
    expect(st.positions[0].qty).toBe(0);
    expect(st.positions[0].realizedGrossBaseMinor).toBe(20_000); // +$200
    expect(st.positions[0].costBaseMinor).toBe(0);
    expect(st.positions[0].lots).toHaveLength(0);
  });

  it('realism on: sell credit is reduced by fees (F4)', () => {
    let st = makeState({ realism: true, balanceMajor: 100_000 });
    st = fillAt(st, { instrument: AAPL, type: 'limit', limitPriceMinor: 10_000, qty: 100 }, 10_000).state;
    const before = walletAt(st, NOW).totalCashMinor;
    const r = fillAt(st, { instrument: AAPL, side: 'sell', type: 'limit', limitPriceMinor: 12_000, qty: 100 }, 12_000);
    expect(r.order.status).toBe('filled');
    const fill = r.fill!;
    expect(fill.feesMinor).toBeGreaterThan(0);
    expect(fill.baseCreditedMinor).toBe(fill.baseGrossMinor - fill.feesMinor - fill.taxWithheldMinor);
    const wAfter = walletAt(r.state, NOW);
    // credit is pending settlement (RM5): total cash grows, settled cash lags
    expect(wAfter.totalCashMinor).toBeGreaterThan(before);
    expect(wAfter.unsettledMinor).toBeGreaterThan(0);
  });
});

describe('settlement (RM5/E1)', () => {
  it('sell proceeds become spendable only after settlement', () => {
    let st = makeState({ realism: false, balanceMajor: 600 });
    st = fillAt(st, { instrument: AAPL, type: 'limit', limitPriceMinor: 5_000, qty: 10 }, 5_000).state;
    const rs = fillAt(st, { instrument: AAPL, side: 'sell', type: 'limit', limitPriceMinor: 6_000, qty: 10 }, 6_000);
    expect(rs.order.status).toBe('filled');
    st = rs.state;
    const fill = rs.fill!;
    expect(fill.availableAtUtc).toBeTruthy();

    const atFill = walletAt(st, NOW);
    expect(atFill.unsettledMinor).toBe(fill.baseCreditedMinor);
    expect(atFill.settledMinor).toBe(atFill.totalCashMinor - fill.baseCreditedMinor);

    const later = new Date(Date.parse(fill.availableAtUtc!) + 1000);
    const after = walletAt(st, later);
    expect(after.unsettledMinor).toBe(0);
    expect(after.settledMinor).toBe(after.totalCashMinor);
  });

  it('pending settlement cash cannot be spent (E1)', () => {
    let st = makeState({ realism: false, balanceMajor: 600 }); // $600
    st = fillAt(st, { instrument: AAPL, type: 'limit', limitPriceMinor: 5_000, qty: 10 }, 5_000).state; // $500 spent
    st = fillAt(st, { instrument: AAPL, side: 'sell', type: 'limit', limitPriceMinor: 6_000, qty: 10 }, 6_000).state;
    const w = walletAt(st, NOW);
    expect(w.settledMinor).toBe(10_000); // $100 left; $600 pending
    expect(w.unsettledMinor).toBe(60_000);
    const r2 = placeOrder(st, draft({ instrument: MSFT, type: 'limit', limitPriceMinor: 20_000, qty: 5 }), ctx({ quote: quote(200) }));
    expect(r2.rejectedReason).toMatch(/Insufficient settled cash/);
    expect(r2.rejectedReason).toMatch(/pending settlement/);
  });
});

describe('live order evaluation (in-session, R3 semantics)', () => {
  function queuedBuyLimit(limitMinor: number) {
    const st = makeState({ balanceMajor: 100_000 });
    const q = quote(190, { bidMinor: 18_995, askMinor: 19_005 });
    const r = placeOrder(st, draft({ instrument: AAPL, side: 'buy', type: 'limit', limitPriceMinor: limitMinor, qty: 10 }), ctx({ quote: q }));
    expect(r.order.status).toBe('queued');
    return r.state;
  }

  it('fills a queued buy limit once the ask reaches the limit', () => {
    const st = queuedBuyLimit(18_900);
    const fresh = quote(189, { bidMinor: 18_895, askMinor: 18_900 });
    const res = evaluateLiveOrder(st, st.orders[0], ctx({ quote: fresh }));
    expect(res.type).toBe('filled');
    if (res.type !== 'filled') return;
    expect(res.fill.nativePriceMinor).toBe(18_900);
    expect(res.state.orders[0].status).toBe('filled');
    expect(heldQty(res.state, AAPL)).toBe(10);
  });

  it('does not fill while the market is closed or the quote is stale (R4)', () => {
    const st = queuedBuyLimit(18_500);
    const closed = evaluateLiveOrder(st, st.orders[0], ctx({ marketOpen: false }));
    expect(closed.type).toBe('none');
    const stale = evaluateLiveOrder(st, st.orders[0], ctx({ quote: quote(200, { stale: true }) }));
    expect(stale.type).toBe('none');
  });

  it('fills at the better of ask vs limit, never worse than the limit', () => {
    const st = queuedBuyLimit(19_000);
    const fresh = quote(188, { bidMinor: 18_795, askMinor: 18_800 });
    const res = evaluateLiveOrder(st, st.orders[0], ctx({ quote: fresh }));
    expect(res.type).toBe('filled');
    if (res.type !== 'filled') return;
    expect(res.fill.nativePriceMinor).toBe(18_800); // price improvement below the limit
    expect(res.fill.nativePriceMinor).toBeLessThanOrEqual(19_000);
  });
});

describe('reconciliation identity (V5 / TST1)', () => {
  function check(st: AppState, at: Date) {
    const v = computeValuation(st, priceLookup(st), usdFxOf, at);
    const r = reconcile(st, v);
    expect(r.missingPrices).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.diffMinor).toBe(0);
    return r;
  }

  it('holds for an empty account', () => {
    const st = makeState();
    check(st, NOW);
  });

  it('holds after buy → sell round trips (realism on)', () => {
    let st = makeState({ realism: true, balanceMajor: 100_000 });
    const prices = [190, 195, 188, 201, 176, 210, 165, 230];
    let i = 0;
    for (const px of prices) {
      const side = i % 3 === 2 ? 'sell' : 'buy';
      const qty = 1 + ((i * 7) % 13);
      const r = fillAt(
        st,
        { instrument: i % 2 === 0 ? AAPL : MSFT, side, type: 'limit', limitPriceMinor: px * 100, qty },
        px * 100,
      );
      if (r.order.status === 'filled') st = r.state;
      i++;
      check(st, NOW);
    }
    expect(st.fills.length).toBeGreaterThan(3);
    check(st, NOW);
  });

  it('holds under a seeded random sequence of 200 actions', () => {
    let st = makeState({ realism: true, balanceMajor: 250_000 });
    let seed = 123456789;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const insts = [AAPL, MSFT];
    for (let i = 0; i < 200; i++) {
      const inst = insts[rnd() < 0.5 ? 0 : 1];
      const px = 50 + Math.floor(rnd() * 300);
      const side = rnd() < 0.55 ? 'buy' : 'sell';
      const qty = 1 + Math.floor(rnd() * 40);
      if (side === 'sell' && heldQty(st, inst) < qty) continue;
      const r = fillAt(st, { instrument: inst, side, type: 'limit', limitPriceMinor: px * 100, qty }, px * 100);
      if (r.order.status === 'filled') st = r.state;
      check(st, NOW);
    }
    expect(st.fills.length).toBeGreaterThan(20);
  });

  it('holds with a dividend cash event (RM7)', () => {
    let st = makeState({ realism: false, balanceMajor: 100_000 });
    st = fillAt(st, { instrument: AAPL, type: 'limit', limitPriceMinor: 10_000, qty: 100 }, 10_000).state;
    st = {
      ...st,
      cashEvents: [
        {
          id: rid('ce'), type: 'dividend', instrument: AAPL, qty: 100,
          amountMinor: 15_000, nativeAmountMinor: 15_000, fxRate: 1,
          paidAtUtc: NOW.toISOString(), actionId: 'div:test:1',
        },
      ],
    };
    const r = check(st, NOW);
    expect(r.terms.dividendsMinor).toBe(15_000);
  });

  it('cross-currency (INR held in a USD account) still balances (TST2)', () => {
    const fx: FxData = { rate: 0.012, atUtc: NOW.toISOString(), stale: false };
    let st = makeState({ realism: true, base: 'USD', balanceMajor: 100_000 });
    const withFx = placeOrder(
      st,
      draft({ instrument: RELIANCE, type: 'limit', limitPriceMinor: 290_000, qty: 5 }),
      ctx({ quote: quote(2900, { bidMinor: 290_000, askMinor: 290_000 }), fx }),
    );
    expect(withFx.order.status).toBe('filled');
    st = withFx.state;
    const v = computeValuation(
      st,
      () => quote(2900, { prevCloseMinor: 289_000 }),
      () => fx,
      NOW,
    );
    const rec = reconcile(st, v);
    expect(rec.ok).toBe(true);
    expect(rec.diffMinor).toBe(0);
  });
});

describe('valuation', () => {
  it('flags missing prices instead of inventing values (X4)', () => {
    let st = makeState({ realism: false });
    st = fillAt(st, { instrument: AAPL, type: 'limit', limitPriceMinor: 10_000, qty: 10 }, 10_000).state;
    const v = computeValuation(st, () => null, () => null, NOW);
    expect(v.missingPrices).toContain('NASDAQ:AAPL');
    expect(v.positionsValueMinor).toBe(0);
    expect(v.rows[0].flags).toContain('price_stale');
    expect(v.rows[0].missing).toBe(true);
  });

  it('day change uses the previous close', () => {
    let st = makeState({ realism: false });
    st = fillAt(st, { instrument: AAPL, type: 'limit', limitPriceMinor: 10_000, qty: 10 }, 10_000).state;
    const v = computeValuation(st, () => quote(110, { prevCloseMinor: 10_000 }), () => null, NOW);
    expect(v.rows[0].dayChangeMinor).toBe(10_000); // +$1.00 × 10 shares
    // starting $100,000 − $1,000 cost + $1,100 current value
    expect(v.totalValueMinor).toBe(10_000_000 - 100_000 + 110_000);
  });
});

describe('validation determinism', () => {
  it('same input → same verdict', () => {
    const st = makeState();
    const d = draft({ instrument: AAPL, qty: 10 });
    const c = ctx();
    const a = validateOrder(st, d, c);
    const b = validateOrder(st, d, c);
    expect(a).toEqual(b);
    expect(a.ok).toBe(true);
  });
});
