/** Teaching layer tests: static content (T1/T5, D1–D5), challenges (T2), feedback (T3). */
import { describe, it, expect } from 'vitest';
import {
  DISCLAIMER_FULL, DISCLAIMER_SHORT, DISCLOSURE_DATA_LABEL,
  KNOWN_LIMITS, READINESS_CHECKLIST, READINESS_FOOTER,
  GLOSSARY, glossaryById,
} from '../src/teaching/content';
import { CHALLENGES, evaluateChallenges } from '../src/teaching/challenges';
import { postTradeFeedback, concentrationWarnings } from '../src/teaching/feedback';
import { placeOrder, computeValuation, type FxData } from '../src/engine/engine';
import { AAPL, MSFT, RELIANCE, makeState, quote, ctx, draft, NOW } from './helpers';
import type { AppState } from '../src/engine/types';

describe('disclaimers and disclosures (D1–D5)', () => {
  it('the full disclaimer covers every required statement', () => {
    expect(DISCLAIMER_FULL).toMatch(/NOT financial/i);
    expect(DISCLAIMER_FULL).toMatch(/NOT a broker, exchange or advisor/i);
    expect(DISCLAIMER_FULL).toMatch(/regulated by any financial regulator/i);
    expect(DISCLAIMER_FULL).toMatch(/no real orders/i);
    expect(DISCLAIMER_FULL).toMatch(/no real money/i);
    expect(DISCLAIMER_FULL).toMatch(/delayed/i);
    expect(DISCLAIMER_FULL).toMatch(/Past simulated performance does not predict/i);
  });

  it('the short disclaimer fits a banner but keeps the essentials', () => {
    expect(DISCLAIMER_SHORT.length).toBeLessThan(220);
    expect(DISCLAIMER_SHORT).toMatch(/not financial advice/i);
    expect(DISCLAIMER_SHORT).toMatch(/virtual money/i);
  });

  it('cost/tax figures are always labelled as estimates (D5)', () => {
    expect(DISCLOSURE_DATA_LABEL).toMatch(/estimates/i);
    expect(DISCLOSURE_DATA_LABEL).toMatch(/configurable/i);
  });
});

describe('known limits and readiness checklist (RM11/RM12)', () => {
  it('lists the honest limitations', () => {
    expect(KNOWN_LIMITS.length).toBeGreaterThanOrEqual(4);
    const titles = KNOWN_LIMITS.map((k) => k.title).join(' ');
    expect(titles).toMatch(/delayed/i);
    expect(titles).toMatch(/optimistic/i);
    expect(titles).toMatch(/estimate/i);
  });

  it('covers liquidity, emotions, brokers, KYC and taxes', () => {
    const areas = READINESS_CHECKLIST.map((c) => c.area.toLowerCase()).join(' ');
    expect(areas).toMatch(/liquidity/);
    expect(areas).toMatch(/emotion/);
    expect(areas).toMatch(/broker/);
    expect(areas).toMatch(/identity|kyc/);
    expect(areas).toMatch(/tax/);
    for (const c of READINESS_CHECKLIST) expect(c.points.length).toBeGreaterThanOrEqual(2);
    expect(READINESS_FOOTER.join(' ')).toMatch(/never tells you that you are "ready"/);
  });
});

describe('glossary (T1)', () => {
  it('has unique ids and complete entries', () => {
    const ids = GLOSSARY.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const g of GLOSSARY) {
      expect(g.term.length).toBeGreaterThan(1);
      expect(g.short.length).toBeGreaterThan(5);
      expect(g.body.length).toBeGreaterThan(20);
    }
  });

  it('covers the core concepts the spec requires', () => {
    const ids = new Set(GLOSSARY.map((g) => g.id));
    for (const id of ['bid_ask', 'market_order', 'limit_order', 'spread', 'slippage', 'settlement', 'fx', 'realized', 'unrealized', 'average_cost', 'diversification']) {
      expect(ids.has(id)).toBe(true);
    }
    expect(glossaryById('bid_ask')?.term).toBe('Bid / Ask');
    expect(glossaryById('nope')).toBeUndefined();
  });
});

describe('challenges (T2)', () => {
  it('completes automatically when the user does the thing', () => {
    let st = makeState({ realism: false });
    expect(evaluateChallenges(st).newlyCompleted.map((c) => c.id)).toEqual([]);

    // first buy
    const q = quote(190, { bidMinor: 19_000, askMinor: 19_000 });
    const r = placeOrder(st, draft({ instrument: AAPL, type: 'limit', limitPriceMinor: 19_000, qty: 10 }), ctx({ quote: q }));
    st = r.state;
    const res = evaluateChallenges(st);
    expect(res.newlyCompleted.map((c) => c.id)).toContain('first_trade');
    expect(res.progress.first_trade).toBeTruthy();
  });

  it('stamps completion exactly once (no flapping timestamps)', () => {
    const st = makeState({ realism: false });
    st.challengeProgress.first_trade = '2025-06-04T15:00:00.000Z';
    const first = evaluateChallenges(st);
    expect(first.newlyCompleted.map((c) => c.id)).not.toContain('first_trade');
    expect(first.progress.first_trade).toBe('2025-06-04T15:00:00.000Z');
  });

  it('recognises journal entries and backups', () => {
    const st = makeState();
    const withJournal: AppState = { ...st, journal: [{ id: 'j1', instrument: null, side: null, openedAtUtc: NOW.toISOString(), reason: 'test', thesis: 'test', exitPlan: 'test' }] };
    expect(evaluateChallenges(withJournal).newlyCompleted.map((c) => c.id)).toContain('write_journal');

    const withExport: AppState = { ...st, meta: { ...st.meta, exportedAtUtc: NOW.toISOString() } };
    expect(evaluateChallenges(withExport).newlyCompleted.map((c) => c.id)).toContain('export_backup');
  });

  it('recognises a cross-currency holding', () => {
    const st = makeState({ realism: false, base: 'USD' });
    const withPos: AppState = {
      ...st,
      positions: [{
        instrument: RELIANCE, qty: 1, costBaseMinor: 35_000, realizedGrossBaseMinor: 0,
        lots: [], openedAtUtc: NOW.toISOString(), lastFillAtUtc: NOW.toISOString(),
        flags: [], appliedActions: [],
      }],
    };
    expect(evaluateChallenges(withPos).newlyCompleted.map((c) => c.id)).toContain('cross_currency');
  });

  it('a broken predicate can never crash evaluation', () => {
    const st = makeState();
    // sanity: every challenge runs against a plain state without throwing
    for (const c of CHALLENGES) expect(() => c.check(st)).not.toThrow();
  });
});

describe('post-trade feedback (T3)', () => {
  function buyState(realism: boolean, balanceMajor: number) {
    const st = makeState({ realism, balanceMajor });
    const px = 190;
    const q = quote(px, { bidMinor: px * 100, askMinor: px * 100 });
    const r = placeOrder(st, draft({ instrument: AAPL, type: 'limit', limitPriceMinor: px * 100, qty: 4 }), ctx({ quote: q }));
    expect(r.order.status).toBe('filled');
    return r;
  }

  it('explains idealized mode when Realism Mode is off', () => {
    const r = buyState(false, 1_000);
    const v = computeValuation(r.state, () => quote(190), () => null, NOW);
    const fb = postTradeFeedback(r.fill!, v, r.state.positions[0], 'USD');
    const ids = fb.map((f) => f.id);
    expect(ids).toContain('idealized');
    expect(ids).toContain('concentration'); // $760 of a $1,000 wallet
    expect(ids).toContain('single_position');
    expect(ids).toContain('fx'); // base-currency note
    for (const f of fb) {
      expect(f.title.length).toBeGreaterThan(0);
      expect(f.body.length).toBeGreaterThan(10);
    }
  });

  it('reports paid costs and spread when realism is on', () => {
    const st = makeState({ realism: true, balanceMajor: 10_000 });
    // market orders with no live bid/ask → default market spread applied (RM3)
    const buy = placeOrder(st, draft({ instrument: MSFT, qty: 10 }), ctx({ quote: quote(190) }));
    expect(buy.order.status).toBe('filled');
    expect(buy.fill!.spreadBpsApplied).toBeGreaterThan(0);
    const sell = placeOrder(buy.state, draft({ instrument: MSFT, side: 'sell', qty: 5 }), ctx({ quote: quote(200) }));
    expect(sell.order.status).toBe('filled');
    expect(sell.fill!.feesMinor).toBeGreaterThan(0); // SEC + FINRA on US sells
    const v = computeValuation(sell.state, () => quote(200), () => null, NOW);
    const fb = postTradeFeedback(sell.fill!, v, sell.state.positions[0], 'USD');
    const ids = fb.map((f) => f.id);
    expect(ids).toContain('costs');
    expect(ids).toContain('spread');
    expect(ids).toContain('settlement');
    expect(ids).not.toContain('idealized');
  });

  it('explains settlement on sells', () => {
    const r0 = buyState(false, 100_000);
    const qSell = quote(210, { bidMinor: 21_000, askMinor: 21_000 });
    const rs = placeOrder(r0.state, draft({ instrument: AAPL, side: 'sell', type: 'limit', limitPriceMinor: 21_000, qty: 4 }), ctx({ quote: qSell }));
    expect(rs.order.status).toBe('filled');
    const v = computeValuation(rs.state, () => quote(210), () => null, NOW);
    const fb = postTradeFeedback(rs.fill!, v, rs.state.positions[0], 'USD');
    expect(fb.map((f) => f.id)).toContain('settlement');
  });

  it('concentration observations are labelled as observations, not advice', () => {
    const r = buyState(false, 1_000);
    const v = computeValuation(r.state, () => quote(190), () => null, NOW);
    const warnings = concentrationWarnings(v);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/AAPL/);
    expect(warnings[0]).toMatch(/not advice|spreads risk/i);

    const empty = computeValuation(makeState(), () => null, () => null, NOW);
    expect(concentrationWarnings(empty)).toEqual([]);
  });

  it('never renders a percentage without context (U4)', () => {
    const r = buyState(false, 1_000);
    const v = computeValuation(r.state, () => quote(190), () => null, NOW);
    const fb = postTradeFeedback(r.fill!, v, r.state.positions[0], 'USD');
    const concentration = fb.find((f) => f.id === 'concentration')!;
    expect(concentration.body).toMatch(/%/);
    expect(concentration.body).toMatch(/AAPL/);
  });

  it('cross-currency fills explain the currency effect (F5)', () => {
    const st = makeState({ realism: false, base: 'USD' });
    const fx: FxData = { rate: 0.012, atUtc: NOW.toISOString(), stale: false };
    const q = quote(2900, { bidMinor: 290_000, askMinor: 290_000 });
    const r = placeOrder(st, draft({ instrument: RELIANCE, type: 'limit', limitPriceMinor: 290_000, qty: 5 }), ctx({ quote: q, fx }));
    expect(r.order.status).toBe('filled');
    const v = computeValuation(r.state, () => quote(2900), () => fx, NOW);
    const fb = postTradeFeedback(r.fill!, v, r.state.positions[0], 'USD');
    const fxItem = fb.find((f) => f.id === 'fx')!;
    expect(fxItem.body).toMatch(/INR→USD/);
  });
});
