/** Cost model tests: RM2 fees, RM3 slippage/spread, RM6 tick snapping, RM8 tax. */
import { describe, it, expect } from 'vitest';
import {
  defaultCostPresets,
  presetForMarket,
  computeFees,
  computeSlippage,
  applyPriceAdjustments,
  estimateTaxForSell,
} from '../src/engine/costs';

const US = defaultCostPresets();
const SLIP = { baseBps: 5, perAdvPercentBps: 50, capBps: 50 };

describe('cost presets (RM2, configuration data with sources)', () => {
  it('every preset records a source and date', () => {
    for (const p of Object.values(US)) {
      expect(p.source.length).toBeGreaterThan(5);
      expect(p.sourceDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(p.settlementDays).toBeGreaterThanOrEqual(0);
      expect(p.tax.source).toBeTruthy();
    }
  });

  it('falls back to INTL for unknown markets', () => {
    expect(presetForMarket(US, 'NOPE').id).toBe('INTL');
    expect(presetForMarket(US, 'IN').id).toBe('IN');
    expect(presetForMarket(US, 'US').id).toBe('US');
  });
});

describe('fee arithmetic (exact integers, half-even)', () => {
  it('US sell: SEC ppm + FINRA per-share (capped)', () => {
    const r = computeFees(US.US, { side: 'sell', notionalMinor: 1_000_000, qty: 100, realism: true });
    const sec = r.lines.find((l) => l.id === 'sec')!;
    const taf = r.lines.find((l) => l.id === 'taf')!;
    expect(sec.amountMinor).toBe(28); // 28 ppm of $10,000 = $0.28
    expect(taf.amountMinor).toBe(2); // 100 × $0.000166 = 1.66¢ → 2¢ (half-even)
    expect(r.totalMinor).toBe(30);
    expect(r.lines.every((l) => l.amountMinor >= 0)).toBe(true);
  });

  it('US sell caps the per-share fee at $8.30', () => {
    const r = computeFees(US.US, { side: 'sell', notionalMinor: 100_000_000, qty: 100_000, realism: true });
    expect(r.lines.find((l) => l.id === 'taf')!.amountMinor).toBe(830);
  });

  it('US buy charges nothing (commission-free, sell-side levies only)', () => {
    const r = computeFees(US.US, { side: 'buy', notionalMinor: 1_000_000, qty: 100, realism: true });
    expect(r.totalMinor).toBe(0);
  });

  it('IN buy: GST is computed on its listed base components', () => {
    const r = computeFees(US.IN, { side: 'buy', notionalMinor: 1_000_000, qty: 10, realism: true });
    const byId = Object.fromEntries(r.lines.map((l) => [l.id, l.amountMinor]));
    expect(byId.brokerage).toBe(500); // 0.05%
    expect(byId.stt).toBe(1000); // 0.1%
    expect(byId.exch).toBe(30);
    expect(byId.sebi).toBe(1);
    expect(byId.stamp).toBe(150); // buy only
    // GST 18% on brokerage + exch + sebi = 531 → 95.58 → 96 (half-even)
    expect(byId.gst).toBe(96);
    expect(r.totalMinor).toBe(500 + 1000 + 30 + 1 + 150 + 96);
  });

  it('IN sell omits stamp duty (buy-only component)', () => {
    const r = computeFees(US.IN, { side: 'sell', notionalMinor: 1_000_000, qty: 10, realism: true });
    expect(r.lines.find((l) => l.id === 'stamp')).toBeUndefined();
  });

  it('realism off → no costs at all (RM1)', () => {
    for (const preset of Object.values(US)) {
      const r = computeFees(preset, { side: 'sell', notionalMinor: 1_000_000, qty: 100, realism: false });
      expect(r.totalMinor).toBe(0);
      expect(r.lines).toEqual([]);
    }
  });
});

describe('slippage model (RM3)', () => {
  it('uses the configured bps per 1% of ADV', () => {
    const r = computeSlippage({ side: 'buy', qty: 5_000, avgDailyVolume: 1_000_000, hasBidAsk: false, settings: SLIP });
    expect(r.slippageBps).toBe(25); // 0.5% participation × 50 bps per 1%
    const onePct = computeSlippage({ side: 'buy', qty: 10_000, avgDailyVolume: 1_000_000, hasBidAsk: false, settings: SLIP });
    expect(onePct.slippageBps).toBe(50); // exactly 1% of ADV → the configured 50 bps
  });

  it('caps the size component', () => {
    const r = computeSlippage({ side: 'buy', qty: 900_000, avgDailyVolume: 1_000_000, hasBidAsk: false, settings: SLIP });
    expect(r.slippageBps).toBe(50); // cap
  });

  it('adds the base bps only when no bid/ask exists', () => {
    const withBa = computeSlippage({ side: 'buy', qty: 100, avgDailyVolume: 1_000_000, hasBidAsk: true, settings: SLIP });
    expect(withBa.spreadBps).toBe(0);
    const without = computeSlippage({ side: 'buy', qty: 100, avgDailyVolume: 1_000_000, hasBidAsk: false, settings: SLIP });
    expect(without.spreadBps).toBe(5);
  });

  it('is zero without volume data', () => {
    const r = computeSlippage({ side: 'buy', qty: 100, avgDailyVolume: null, hasBidAsk: false, settings: SLIP });
    expect(r.slippageBps).toBe(0);
  });
});

describe('price adjustments (RM3/RM6)', () => {
  it('buys move up and sells move down (never better than reference)', () => {
    const buy = applyPriceAdjustments(10_000, 'buy', 100, 0, 1);
    expect(buy.priceMinor).toBe(10_100);
    const sell = applyPriceAdjustments(10_000, 'sell', 100, 0, 1);
    expect(sell.priceMinor).toBe(9_900);
    expect(buy.priceMinor).toBeGreaterThan(10_000);
    expect(sell.priceMinor).toBeLessThan(10_000);
  });

  it('snaps to the tick, adversely', () => {
    expect(applyPriceAdjustments(10_002, 'buy', 0, 5, 5).priceMinor).toBe(10_010); // ceil up
    expect(applyPriceAdjustments(10_002, 'sell', 0, 5, 5).priceMinor).toBe(9_995); // floor down
    // never better than the unadjusted reference on either side
    expect(applyPriceAdjustments(10_002, 'buy', 0, 5, 5).priceMinor).toBeGreaterThanOrEqual(10_002);
    expect(applyPriceAdjustments(10_002, 'sell', 0, 5, 5).priceMinor).toBeLessThanOrEqual(10_002);
  });

  it('does nothing when no adjustment applies', () => {
    expect(applyPriceAdjustments(10_000, 'buy', 0, 0, 5).priceMinor).toBe(10_000);
  });
});

describe('tax estimation (RM8, estimates only — D5)', () => {
  const cfg = US.US.tax;

  it('short-term gains use the short-term rate', () => {
    const r = estimateTaxForSell({
      config: cfg,
      proceedsBaseMinor: 100_000,
      sellUtc: '2025-06-04T15:00:00.000Z',
      lots: [{ qty: 10, costBaseMinor: 90_000, acquiredAtUtc: '2025-06-01T15:00:00.000Z' }],
    });
    expect(r.detail[0].holdingDays).toBe(3);
    expect(r.detail[0].gainMinor).toBe(10_000);
    expect(r.totalMinor).toBe(2_400); // 24%
  });

  it('long-term gains use the long-term rate', () => {
    const r = estimateTaxForSell({
      config: cfg,
      proceedsBaseMinor: 100_000,
      sellUtc: '2025-06-04T15:00:00.000Z',
      lots: [{ qty: 10, costBaseMinor: 90_000, acquiredAtUtc: '2024-01-01T15:00:00.000Z' }],
    });
    expect(r.detail[0].holdingDays).toBeGreaterThan(366);
    expect(r.totalMinor).toBe(1_500); // 15%
  });

  it('losses are never taxed', () => {
    const r = estimateTaxForSell({
      config: cfg,
      proceedsBaseMinor: 80_000,
      sellUtc: '2025-06-04T15:00:00.000Z',
      lots: [{ qty: 10, costBaseMinor: 90_000, acquiredAtUtc: '2025-06-01T15:00:00.000Z' }],
    });
    expect(r.totalMinor).toBe(0);
  });

  it('zero-rate presets produce zero tax', () => {
    const r = estimateTaxForSell({
      config: US.INTL.tax,
      proceedsBaseMinor: 100_000,
      sellUtc: '2025-06-04T15:00:00.000Z',
      lots: [{ qty: 10, costBaseMinor: 10_000, acquiredAtUtc: '2025-06-01T15:00:00.000Z' }],
    });
    expect(r.totalMinor).toBe(0);
  });

  it('is deterministic (same input → same output)', () => {
    const input = {
      config: cfg,
      proceedsBaseMinor: 123_457,
      sellUtc: '2025-06-04T15:00:00.000Z',
      lots: [{ qty: 7, costBaseMinor: 90_003, acquiredAtUtc: '2025-05-01T15:00:00.000Z' }],
    };
    expect(estimateTaxForSell(input)).toEqual(estimateTaxForSell(input));
  });
});
