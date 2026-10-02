/**
 * Realism Mode cost model (RM2), slippage (RM3), settlement (RM5) and tax
 * estimation (RM8).
 *
 * ALL rates are configuration data — never hardcoded in the engine. Each
 * preset records its `source` and `sourceDate` and is user-editable in
 * settings. Every displayed cost is labelled an estimate (D5).
 *
 * Fee arithmetic is exact integer arithmetic (BigInt-backed) with the app-wide
 * rounding rule round-half-to-even (W5):
 *   - notional_ppm:      fee = round_half_even(notional * ppm / 1_000_000)
 *   - per_share_micro:   fee = round_half_even(qty * micro / 1_000)   (micro = 1e-6 minor units)
 *   - flat:              fee = flat (minor units)
 *   - GST-style:         fee = round_half_even(base * rateBps / 10_000)
 */

import { applyBps, mulDivRound, roundHalfEven, type Minor } from './money';
import type { CostComponent, CostPreset, FeeLine, Side, TaxConfig } from './types';

export function defaultCostPresets(): Record<string, CostPreset> {
  return {
    US: {
      id: 'US',
      market: 'US',
      label: 'United States (equity delivery, commission-free broker)',
      currency: 'USD',
      components: [
        { id: 'commission', label: 'Brokerage commission', side: 'both', basis: 'flat', value: 0 },
        { id: 'sec', label: 'SEC section 31 / trading fees (est.)', side: 'sell', basis: 'notional_ppm', value: 28 },
        { id: 'taf', label: 'FINRA trading activity fee (est.)', side: 'sell', basis: 'per_share_micro', value: 16_600, capMinor: 830 },
      ],
      settlementDays: 1,
      tickMinor: 1,
      lotSize: 1,
      priceBandBps: 0,
      defaultSpreadBps: 5,
      fxSpreadBps: 5,
      tax: {
        country: 'US',
        label: 'US federal capital gains (estimate)',
        shortTermRateBps: 2400, // ordinary-income assumption
        longTermRateBps: 1500,
        longTermHoldingDays: 366,
        source: 'IRS long-term 15% / short-term taxed as income; 24% bracket assumed',
        sourceDate: '2025-01-01',
        notes: 'State taxes not modelled. Estimate only (D5).',
      },
      source: 'SEC fee rate FY2025 (~$27.80/$1m), FINRA TAF $0.000166/share (max $8.30), zero-commission brokers',
      sourceDate: '2025-01-01',
    },
    IN: {
      id: 'IN',
      market: 'IN',
      label: 'India (NSE/BSE equity delivery)',
      currency: 'INR',
      components: [
        { id: 'brokerage', label: 'Brokerage (0.05%)', side: 'both', basis: 'notional_ppm', value: 500 },
        { id: 'stt', label: 'Securities transaction tax (0.1%)', side: 'both', basis: 'notional_ppm', value: 1000 },
        { id: 'exch', label: 'Exchange transaction charges', side: 'both', basis: 'notional_ppm', value: 30 },
        { id: 'sebi', label: 'SEBI turnover fees', side: 'both', basis: 'notional_ppm', value: 1 },
        { id: 'gst', label: 'GST @18% on brokerage + exchange + SEBI', side: 'both', basis: 'flat', value: 0, gstOn: ['brokerage', 'exch', 'sebi'], gstRateBps: 1800 },
        { id: 'stamp', label: 'Stamp duty (0.015%, buy only)', side: 'buy', basis: 'notional_ppm', value: 150 },
      ],
      settlementDays: 1,
      tickMinor: 5,
      lotSize: 1,
      priceBandBps: 2000,
      defaultSpreadBps: 10,
      fxSpreadBps: 10,
      tax: {
        country: 'IN',
        label: 'India capital gains on equity (estimate)',
        shortTermRateBps: 2000, // STCG <= 12 months (new tax regime)
        longTermRateBps: 1250, // LTCG 12.5%
        longTermHoldingDays: 365,
        exemptionMinor: 1_250_000, // ₹1,25,000 in paise
        source: 'Income-tax Act as amended by Finance Act 2024 (STCG 20%, LTCG 12.5% above ₹1.25L)',
        sourceDate: '2024-04-01',
        notes: 'Surcharge/cess and grandfathering not modelled. Estimate only (D5).',
      },
      source: 'NSE equity delivery charge structure: brokerage 0.05%, STT 0.1% both sides, exch 0.00297%, SEBI ₹10/cr, GST 18%, stamp 0.015% buy',
      sourceDate: '2025-01-01',
    },
    INTL: {
      id: 'INTL',
      market: 'INTL',
      label: 'International (default)',
      currency: 'USD',
      components: [
        { id: 'brokerage', label: 'Brokerage (0.05%)', side: 'both', basis: 'notional_ppm', value: 500 },
        { id: 'reg', label: 'Regulatory/exchange levies (est.)', side: 'both', basis: 'notional_ppm', value: 100 },
      ],
      settlementDays: 2,
      tickMinor: 1,
      lotSize: 1,
      priceBandBps: 0,
      defaultSpreadBps: 15,
      fxSpreadBps: 15,
      tax: {
        country: 'NONE',
        label: 'No tax configuration for this market',
        shortTermRateBps: 0,
        longTermRateBps: 0,
        longTermHoldingDays: 365,
        source: 'none',
        sourceDate: '2025-01-01',
        notes: 'Configure a country preset to estimate taxes.',
      },
      source: 'Generic placeholder — verify against your broker [VERIFY]',
      sourceDate: '2025-01-01',
    },
  };
}

export function presetForMarket(presets: Record<string, CostPreset>, marketGroup: string): CostPreset {
  return presets[marketGroup] ?? presets.INTL ?? Object.values(presets)[0];
}

export interface FeeInput {
  side: Side;
  notionalMinor: Minor; // gross base-currency notional (price × qty converted)
  qty: number;
  realism: boolean;
}

export interface FeeResult {
  lines: FeeLine[];
  totalMinor: Minor;
}

const MICRO_SCALE = 1_000_000; // ppm: 1e-6 of notional
const PER_SHARE_SCALE = 1_000_000; // micro minor units → minor units (1e-6)

/** Itemised trading costs for a fill (RM2). Zero and empty when Realism Mode is off (RM1). */
export function computeFees(preset: CostPreset, input: FeeInput): FeeResult {
  if (!input.realism) return { lines: [], totalMinor: 0 };
  const lines: FeeLine[] = [];
  const chargedIds = new Set<string>();
  const bases = new Map<string, Minor>();

  for (const c of preset.components) {
    if (c.side !== 'both' && c.side !== input.side) continue;
    if (c.gstOn) continue; // pseudo-component computed below
    const amount = componentAmount(c, input.notionalMinor, input.qty);
    lines.push({ id: c.id, label: c.label, amountMinor: amount });
    chargedIds.add(c.id);
    bases.set(c.id, amount);
  }

  for (const c of preset.components) {
    if (!c.gstOn) continue;
    if (c.side !== 'both' && c.side !== input.side) continue;
    let base: Minor = 0;
    for (const id of c.gstOn) base += bases.get(id) ?? 0;
    const amount = c.gstRateBps ? applyBps(base, c.gstRateBps) : 0;
    lines.push({ id: c.id, label: c.label, amountMinor: amount });
  }

  const totalMinor = lines.reduce((s, l) => s + l.amountMinor, 0);
  return { lines, totalMinor };
}

function componentAmount(c: CostComponent, notionalMinor: Minor, qty: number): Minor {
  switch (c.basis) {
    case 'notional_ppm':
    case 'notional_bps': {
      // 'notional_bps' is accepted for hand-edited presets: value = basis points.
      const ppm = c.basis === 'notional_bps' ? Math.round(Number(c.value) * 100) : Math.round(Number(c.value));
      return mulDivRound(notionalMinor, ppm, MICRO_SCALE);
    }
    case 'per_share_micro': {
      const raw = mulDivRound(qty, Math.round(Number(c.value)), PER_SHARE_SCALE);
      return c.capMinor != null ? Math.min(raw, c.capMinor) : raw;
    }
    case 'flat':
      return Math.round(Number(c.value)) || 0;
    default:
      return 0;
  }
}

/* ------------------------------------------------------------- slippage (RM3) */

export interface SlippageInput {
  side: Side;
  qty: number;
  /** average daily volume in shares over the recent window, if known */
  avgDailyVolume: number | null;
  hasBidAsk: boolean;
  settings: { baseBps: number; perAdvPercentBps: number; capBps: number };
}

export interface SlippageResult {
  /** total adverse price move applied, in bps of price (spread is separate) */
  slippageBps: number;
  /** spread bps actually applied (0 when a real bid/ask is used) */
  spreadBps: number;
  explanation: string;
}

/**
 * Documented slippage model (RM3):
 *   sizeComponent = min(capBps, round(perAdvPercentBps × orderParticipation))
 *   where orderParticipation = qty / avgDailyVolume (×100 for percent).
 *   total = (hasBidAsk ? 0 : baseBps) + sizeComponent
 * Buys pay upward, sells receive downward (adverse direction).
 */
export function computeSlippage(input: SlippageInput): SlippageResult {
  const { baseBps, perAdvPercentBps, capBps } = input.settings;
  let sizeBps = 0;
  if (input.avgDailyVolume && input.avgDailyVolume > 0) {
    const participationPct = (input.qty / input.avgDailyVolume) * 100; // % of a day's volume
    sizeBps = Math.min(capBps, roundHalfEven(perAdvPercentBps * participationPct));
  }
  // Real bid/ask already contains the market spread; otherwise charge the
  // configured default spread for the market.
  const spreadBps = input.hasBidAsk ? 0 : baseBps;
  const slippageBps = sizeBps;
  const parts: string[] = [];
  if (input.hasBidAsk) parts.push('real bid/ask used (spread already in the quote)');
  else parts.push(`default spread ${spreadBps} bps (no live bid/ask available)`);
  const participationPct = input.avgDailyVolume ? (input.qty / input.avgDailyVolume) * 100 : 0;
  parts.push(`size slippage ${slippageBps} bps ≈ ${participationPct.toFixed(1)}% of daily volume`);
  return { slippageBps, spreadBps, explanation: parts.join('; ') };
}

/**
 * Apply spread + slippage to a reference price for a side (RM3).
 * Buys move up, sells move down — always adverse to the user, never better
 * than the reference. Results are snapped to the tick (RM6).
 */
export function applyPriceAdjustments(
  priceMinor: Minor,
  side: Side,
  spreadBps: number,
  slippageBps: number,
  tickMinor: Minor,
): { priceMinor: Minor; totalBps: number } {
  const totalBps = spreadBps + slippageBps;
  if (totalBps === 0) return { priceMinor, totalBps };
  // adverse direction: buys pay more, sells receive less
  const factor = side === 'buy' ? 10_000 + totalBps : 10_000 - totalBps;
  const raw = mulDivRound(priceMinor, factor, 10_000);
  if (tickMinor <= 1) return { priceMinor: Math.max(raw, 1), totalBps };
  if (side === 'buy') {
    const snapped = Math.ceil(raw / tickMinor) * tickMinor;
    return { priceMinor: Math.max(snapped, 1), totalBps };
  }
  const snapped = Math.floor(raw / tickMinor) * tickMinor;
  return { priceMinor: Math.max(snapped, 1), totalBps };
}

/* ------------------------------------------------------------ taxes (RM8) */

export interface TaxLotConsumption {
  qty: number;
  costBaseMinor: Minor;
  acquiredAtUtc: string;
  holdingDays: number;
  gainMinor: Minor; // allocated proceeds − allocated cost (can be negative)
  taxMinor: Minor;
}

export interface TaxEstimateInput {
  config: TaxConfig;
  proceedsBaseMinor: Minor; // gross base proceeds of the sell
  sellUtc: string;
  /** lots consumed by this sell, FIFO, with qty and per-lot cost */
  lots: { qty: number; costBaseMinor: Minor; acquiredAtUtc: string }[];
}

/**
 * Capital-gains tax estimate for a sell (RM8). Uses FIFO lots for holding
 * periods (average-cost is used for the P&L ledger itself — documented split)
 * and allocates proceeds proportionally to quantity. Returns per-lot detail so
 * the report can show short vs long term (RM10). Estimates only (D5).
 */
export function estimateTaxForSell(input: TaxEstimateInput): { totalMinor: Minor; detail: TaxLotConsumption[]; exemptionApplied: boolean } {
  const { config, proceedsBaseMinor, sellUtc, lots } = input;
  const totalQty = lots.reduce((s, l) => s + l.qty, 0);
  if (totalQty <= 0 || config.shortTermRateBps === 0 && config.longTermRateBps === 0) {
    return { totalMinor: 0, detail: [], exemptionApplied: false };
  }
  const sellTs = Date.parse(sellUtc);
  const detail: TaxLotConsumption[] = [];
  let total = 0;
  let gainsForYear = 0;
  for (const lot of lots) {
    const proceeds = mulDivRound(proceedsBaseMinor, lot.qty, totalQty);
    const holdingDays = Math.max(0, Math.floor((sellTs - Date.parse(lot.acquiredAtUtc)) / 86_400_000));
    const gain = proceeds - lot.costBaseMinor;
    const rateBps = holdingDays > config.longTermHoldingDays ? config.longTermRateBps : config.shortTermRateBps;
    const tax = gain > 0 ? applyBps(gain, rateBps) : 0;
    gainsForYear += gain;
    detail.push({ qty: lot.qty, costBaseMinor: lot.costBaseMinor, acquiredAtUtc: lot.acquiredAtUtc, holdingDays, gainMinor: gain, taxMinor: tax });
    total += tax;
  }
  // exemption is applied at report level, not per fill (kept visible in the report)
  const exemptionApplied = total > 0 && !!config.exemptionMinor && gainsForYear > 0;
  return { totalMinor: total, detail, exemptionApplied };
}
