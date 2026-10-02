/**
 * Simulation engine (spec §5, §6). Pure logic: no network, no DOM, no storage.
 *
 * ## Reconciliation identity (V5) — proven in test/reconciliation.test.ts
 *
 *   startingBalance
 *     + Σ realized (gross of fees, booked on sells, average-cost V3)
 *     + unrealized
 *     − Σ fees
 *     + Σ cash dividends
 *     − Σ estimated tax actually withheld from the wallet
 *   = total value (cash + positions)
 *
 * Cash = starting − Σ buys(debited) + Σ sells(credited) + dividends,
 * where buy debited = gross + fees and sell credited = gross − fees − tax (F4).
 * Position cost basis is the *gross* base amount of buys so that fees remain an
 * explicit, separately reconcilable line (this is what makes V5 hold with a
 * single "total fees" term). The exact debited/credited amounts are still
 * recorded on every fill (F4) and are what the wallet moves by.
 */

import { addTradingDays, dayOrderExpiryUtc, marketStatus, marketGroupForExchange, exchangeInfo } from '../calendar/calendar';
import { computeFees, computeSlippage, applyPriceAdjustments, estimateTaxForSell, presetForMarket, defaultCostPresets } from './costs';
import { convertMinor, mulDivRound, quantizeRate, type Minor } from './money';
import {
  emptyState, instrumentId, SCHEMA_VERSION,
  type Account, type AppState, type Fill, type FeeLine, type Instrument, type InstrumentKey,
  type Order, type OrderDraft, type Position, type Settings, type Side,
} from './types';

/* ------------------------------------------------------------------ quotes */

export interface QuoteData {
  priceMinor: Minor;
  bidMinor?: Minor;
  askMinor?: Minor;
  prevCloseMinor?: Minor;
  openMinor?: Minor;
  volume?: number;
  atUtc: string;
  delayed: boolean;
  stale: boolean;
}

export interface FxData {
  rate: number; // native → base, quantised
  atUtc: string;
  stale: boolean;
}

export type PriceLookup = (i: InstrumentKey) => QuoteData | null;
export type FxLookup = (currency: string) => FxData | null;

/* ---------------------------------------------------------------- account */

export function defaultSettings(baseCurrency: string): Settings {
  return {
    realismMode: true,
    providerId: 'twelvedata',
    fxSpreadBps: 10,
    defaultSpreadBps: null,
    slippage: { baseBps: 5, perAdvPercentBps: 50, capBps: 50 },
    costPresets: defaultCostPresets(),
    taxCountry: marketTaxDefault(baseCurrency),
    settlementByMarket: {},
    deductTaxFromWallet: false,
    displayCurrency: null,
    benchmark: { symbol: 'SPY', exchange: 'NYSE_ARCA' },
    staleFxThresholdMs: 15 * 60_000,
    includeKeysInExport: false,
  };
}

function marketTaxDefault(baseCurrency: string): string {
  return baseCurrency === 'INR' ? 'IN' : baseCurrency === 'USD' ? 'US' : 'NONE';
}

export function createAccount(input: {
  baseCurrency: string;
  startingBalanceMinor: Minor;
  nowUtc: Date;
  settings?: Partial<Settings>;
}): Account {
  if (input.startingBalanceMinor <= 0) throw new Error('Starting balance must be positive');
  return {
    id: `acct_${input.nowUtc.getTime().toString(36)}`,
    createdAtUtc: input.nowUtc.toISOString(),
    baseCurrency: input.baseCurrency,
    startingBalanceMinor: input.startingBalanceMinor,
    settings: { ...defaultSettings(input.baseCurrency), ...input.settings },
  };
}

export function newId(prefix: string, nowUtc: Date): string {
  return `${prefix}_${nowUtc.getTime().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/* ----------------------------------------------------------------- wallet */

export interface Wallet {
  /** all cash including proceeds pending settlement (receivable) */
  totalCashMinor: Minor;
  /** spendable right now (E1) */
  settledMinor: Minor;
  unsettledMinor: Minor;
  unsettled: { amountMinor: Minor; availableAtUtc: string; fillId: string }[];
}

/** Cash position at instant `atUtc` (derived from the fill ledger — no mutable wallet). */
export function walletAt(state: AppState, atUtc: Date): Wallet {
  const acct = state.account;
  if (!acct) return { totalCashMinor: 0, settledMinor: 0, unsettledMinor: 0, unsettled: [] };
  const ts = atUtc.getTime();
  let total = acct.startingBalanceMinor;
  let settled = acct.startingBalanceMinor;
  const unsettled: Wallet['unsettled'] = [];
  for (const f of state.fills) {
    const fts = Date.parse(f.timestampUtc);
    if (fts > ts) continue;
    if (f.side === 'buy') {
      total -= f.baseDebitedMinor;
      settled -= f.baseDebitedMinor;
    } else {
      total += f.baseCreditedMinor;
      if (f.availableAtUtc && Date.parse(f.availableAtUtc) <= ts) {
        settled += f.baseCreditedMinor;
      } else if (f.availableAtUtc) {
        unsettled.push({ amountMinor: f.baseCreditedMinor, availableAtUtc: f.availableAtUtc, fillId: f.id });
      } else {
        settled += f.baseCreditedMinor;
      }
    }
  }
  for (const e of state.cashEvents) {
    if (Date.parse(e.paidAtUtc) <= ts) {
      total += e.amountMinor;
      settled += e.amountMinor;
    }
  }
  const unsettledMinor = unsettled.reduce((s, u) => s + u.amountMinor, 0);
  return { totalCashMinor: total, settledMinor: settled, unsettledMinor, unsettled };
}

/* ------------------------------------------------------------- positions */

export function positionFor(state: AppState, key: InstrumentKey): Position | undefined {
  return state.positions.find((p) => instrumentId(p.instrument) === instrumentId(key));
}

export function heldQty(state: AppState, key: InstrumentKey): number {
  return positionFor(state, key)?.qty ?? 0;
}

function upsertPosition(positions: Position[], p: Position): Position[] {
  const idx = positions.findIndex((x) => instrumentId(x.instrument) === instrumentId(p.instrument));
  if (idx < 0) return [...positions, p];
  const next = positions.slice();
  next[idx] = p;
  return next;
}

/* ------------------------------------------------------------ fills (E4/E5) */

export interface BuildFillInput {
  order: Order;
  /** execution price in native minor units (already spread/slippage adjusted) */
  priceMinor: Minor;
  fxRateNativeToBase: number; // raw market rate (pre-spread)
  feeLines: FeeLine[];
  feesMinor: Minor;
  taxWithheldMinor: Minor;
  spreadBpsApplied: number;
  slippageBpsApplied: number;
  atUtc: Date;
  realism: boolean;
  settlementDays: number;
}

/**
 * Build the immutable fill record (E4). Records native price, qty, FX rate and
 * the exact base-currency amounts (F4).
 */
export function buildFill(state: AppState, input: BuildFillInput): Fill {
  const acct = state.account!;
  const { order } = input;
  const native = order.instrument.currency;
  const grossNative = input.priceMinor * order.qty; // integer × integer (W4)
  const sameCcy = native === acct.baseCurrency;
  const spread = input.realism && !sameCcy ? acct.settings.fxSpreadBps : 0;
  // F6: FX spread applies on conversion — buys pay more base, sells receive less.
  const fxRate = sameCcy
    ? 1
    : quantizeRate(input.fxRateNativeToBase * (order.side === 'buy' ? 1 + spread / 10_000 : 1 - spread / 10_000));
  const baseGross = sameCcy ? grossNative : convertMinor(grossNative, fxRate);
  const fees = input.feesMinor;
  const tax = input.taxWithheldMinor;
  const debited = order.side === 'buy' ? baseGross + fees : 0;
  const credited = order.side === 'sell' ? Math.max(0, baseGross - fees - tax) : 0;
  const availableAt =
    order.side === 'sell'
      ? addTradingDays(input.atUtc, input.settlementDays, order.instrument.exchange).toISOString()
      : null;
  return {
    id: newId('fill', input.atUtc),
    orderId: order.id,
    instrument: order.instrument,
    side: order.side,
    qty: order.qty,
    nativePriceMinor: input.priceMinor,
    nativeCurrency: native,
    fxRate,
    baseGrossMinor: baseGross,
    feesMinor: fees,
    feeLines: input.feeLines,
    taxWithheldMinor: tax,
    baseDebitedMinor: debited,
    baseCreditedMinor: credited,
    availableAtUtc: availableAt,
    timestampUtc: input.atUtc.toISOString(),
    exchange: order.instrument.exchange,
    realism: input.realism,
    spreadBpsApplied: input.spreadBpsApplied,
    slippageBpsApplied: input.slippageBpsApplied,
  };
}

/** Apply a fill to state: positions, lots, realized P&L (average cost, V3). */
export function applyFill(state: AppState, fill: Fill): AppState {
  const positions = state.positions.slice();
  const idx = positions.findIndex((p) => instrumentId(p.instrument) === instrumentId(fill.instrument));
  const now = fill.timestampUtc;
  let pos: Position =
    idx >= 0
      ? { ...positions[idx], lots: positions[idx].lots.slice(), flags: [...positions[idx].flags], appliedActions: [...positions[idx].appliedActions] }
      : {
          instrument: fill.instrument,
          qty: 0,
          costBaseMinor: 0,
          realizedGrossBaseMinor: 0,
          lots: [],
          openedAtUtc: now,
          lastFillAtUtc: now,
          flags: [],
          appliedActions: [],
        };

  if (fill.side === 'buy') {
    pos = {
      ...pos,
      qty: pos.qty + fill.qty,
      costBaseMinor: pos.costBaseMinor + fill.baseGrossMinor, // gross basis — see header note
      lots: [...pos.lots, { qty: fill.qty, costBaseMinor: fill.baseGrossMinor, acquiredAtUtc: now, fxRate: fill.fxRate }],
      lastFillAtUtc: now,
      flags: pos.flags.filter((f) => f !== 'price_stale' && f !== 'delisted_unknown'),
    };
  } else {
    const sold = Math.min(fill.qty, pos.qty);
    const removed =
      sold === pos.qty ? pos.costBaseMinor : mulDivRound(pos.costBaseMinor, sold, pos.qty);
    const realized = fill.baseGrossMinor - removed;
    // consume lots FIFO for holding-period tracking (tax); qty-driven, cost kept proportional to avg
    let remaining = sold;
    const lots = [];
    for (const lot of pos.lots) {
      if (remaining <= 0) {
        lots.push(lot);
        continue;
      }
      if (lot.qty <= remaining) {
        remaining -= lot.qty;
      } else {
        lots.push({ ...lot, qty: lot.qty - remaining });
        remaining = 0;
      }
    }
    pos = {
      ...pos,
      qty: pos.qty - sold,
      costBaseMinor: pos.costBaseMinor - removed,
      realizedGrossBaseMinor: pos.realizedGrossBaseMinor + realized,
      lots,
      lastFillAtUtc: now,
    };
    if (pos.qty === 0) {
      pos.costBaseMinor = 0;
      pos.lots = [];
    }
  }

  return {
    ...state,
    positions: upsertPosition(positions, pos),
    fills: [...state.fills, fill],
  };
}

/* -------------------------------------------------------- order validation */

export interface FillContext {
  nowUtc: Date;
  quote: QuoteData;
  fx: FxData | null; // native → base
  avgDailyVolume: number | null;
  marketOpen: boolean;
  sessionDate: string;
}

export type ValidationResult = { ok: true } | { ok: false; reason: string };

export function validateOrder(state: AppState, draft: OrderDraft, ctx: FillContext): ValidationResult {
  const acct = state.account;
  if (!acct) return { ok: false, reason: 'No account yet — finish onboarding first.' };
  if (draft.instrument.isIndex || draft.instrument.assetType === 'index') {
    return { ok: false, reason: 'Real indices are not tradeable — use an ETF proxy instead (I3).' };
  }
  if (!Number.isInteger(draft.qty) || draft.qty <= 0) {
    return { ok: false, reason: 'Quantity must be a whole number of shares (no fractional shares in v1).' };
  }
  const preset = presetForMarket(acct.settings.costPresets, marketGroupForExchange(draft.instrument.exchange));
  if (preset.lotSize > 1 && draft.qty % preset.lotSize !== 0) {
    return { ok: false, reason: `Lot size for this market is ${preset.lotSize} — order must be a multiple of it.` };
  }

  // prices per order type + tick size (RM6)
  const tick = preset.tickMinor;
  const checkTick = (v: Minor | undefined, label: string): ValidationResult => {
    if (v == null) return { ok: false, reason: `${label} price is required.` };
    if (v <= 0) return { ok: false, reason: `${label} price must be positive.` };
    if (tick > 0 && v % tick !== 0) {
      return { ok: false, reason: `${label} price breaks the tick size of this market (${tick} minor units).` };
    }
    return { ok: true };
  };
  if (draft.type === 'limit') {
    const r = checkTick(draft.limitPriceMinor, 'Limit');
    if (!r.ok) return r;
  } else if (draft.type === 'stop') {
    const r = checkTick(draft.stopPriceMinor, 'Stop');
    if (!r.ok) return r;
  } else if (draft.type === 'stop_limit') {
    const r1 = checkTick(draft.stopPriceMinor, 'Stop');
    if (!r1.ok) return r1;
    const r2 = checkTick(draft.stopLimitPriceMinor, 'Stop-limit');
    if (!r2.ok) return r2;
  }

  // FX freshness (F3): block trading when the rate is stale/missing
  const native = draft.instrument.currency;
  if (native !== acct.baseCurrency) {
    if (!ctx.fx) {
      return { ok: false, reason: `No FX rate ${native}→${acct.baseCurrency} available yet — trading is blocked until a fresh rate is fetched (F3).` };
    }
    if (ctx.fx.stale) {
      return { ok: false, reason: `FX rate ${native}→${acct.baseCurrency} is stale — trading is blocked until it refreshes (F3).` };
    }
  }

  const price = executionReferencePrice(draft, ctx);
  if (!price.ok) return price;

  // price band / circuit limit (RM6, estimate)
  if (preset.priceBandBps > 0 && ctx.quote.prevCloseMinor && ctx.quote.prevCloseMinor > 0) {
    const ref = price.refMinor;
    const devBps = Math.round((Math.abs(ref - ctx.quote.prevCloseMinor) * 10_000) / ctx.quote.prevCloseMinor);
    if (devBps > preset.priceBandBps) {
      return {
        ok: false,
        reason: `Estimated price band exceeded: reference is ${devBps} bps from the previous close (limit ${preset.priceBandBps} bps). Exchanges halt trading outside these bands — order rejected (RM6).`,
      };
    }
  }

  const est = estimateOrder(state, draft, ctx);
  if (draft.side === 'sell') {
    const held = heldQty(state, draft.instrument);
    if (held < draft.qty) {
      return {
        ok: false,
        reason:
          held === 0
            ? 'You do not hold this instrument. Short selling is not supported (E2).'
            : `You hold ${held} share(s) but tried to sell ${draft.qty} (E2).`,
      };
    }
  } else {
    const wallet = walletAt(state, ctx.nowUtc);
    if (est.totalBaseMinor > wallet.settledMinor) {
      const short = est.totalBaseMinor - wallet.settledMinor;
      const hint = wallet.unsettledMinor > 0
        ? ` (${formatMinorShort(wallet.unsettledMinor, acct.baseCurrency)} is pending settlement)`
        : '';
      return {
        ok: false,
        reason: `Insufficient settled cash: need ${formatMinorShort(est.totalBaseMinor, acct.baseCurrency)} including costs, have ${formatMinorShort(wallet.settledMinor, acct.baseCurrency)}${hint} (E1).`,
      };
    }
  }
  return { ok: true };
}

function formatMinorShort(m: Minor, ccy: string): string {
  return `${(m / 100).toFixed(2)} ${ccy}`; // display-only helper for messages; UI formats properly
}

/** Reference price (pre-fee) an order would execute against, per type + market state. */
function executionReferencePrice(draft: OrderDraft, ctx: FillContext): { ok: true; refMinor: Minor } | { ok: false; reason: string } {
  const q = ctx.quote;
  const ref = (side: Side): Minor => {
    if (side === 'buy') return q.askMinor ?? q.priceMinor;
    return q.bidMinor ?? q.priceMinor;
  };
  switch (draft.type) {
    case 'market':
      return { ok: true, refMinor: ref(draft.side) };
    case 'limit':
      return { ok: true, refMinor: draft.limitPriceMinor! };
    case 'stop':
      return { ok: true, refMinor: draft.stopPriceMinor! };
    case 'stop_limit':
      return { ok: true, refMinor: draft.stopLimitPriceMinor! };
    default:
      return { ok: false, reason: 'Unknown order type' };
  }
}

/* --------------------------------------------------------- order estimate */

export interface OrderEstimate {
  /** reference/exec price in native currency after spread+slippage (bid/ask aware) */
  fillPriceMinor: Minor;
  grossNativeMinor: Minor;
  fxRate: number;
  fxStale: boolean;
  sameCurrency: boolean;
  fxSpreadBps: number;
  grossBaseMinor: Minor;
  feeLines: FeeLine[];
  feesMinor: Minor;
  taxMinor: Minor;
  /** buy: total debited; sell: total credited */
  totalBaseMinor: Minor;
  resultingSettledCashMinor: Minor;
  positionPctOfWallet: number; // RM9
  concentrationWarning: string | null; // RM9
  slippageExplanation: string;
  spreadBps: number;
  slippageBps: number;
  queued: boolean;
  queuedNotice: string | null;
  settlementAvailableAtUtc: string | null;
  realism: boolean;
}

export function estimateOrder(state: AppState, draft: OrderDraft, ctx: FillContext): OrderEstimate {
  const acct = state.account!;
  const preset = presetForMarket(acct.settings.costPresets, marketGroupForExchange(draft.instrument.exchange));
  const realism = acct.settings.realismMode;
  const q = ctx.quote;

  // 1. choose bid/ask vs mid (RM3)
  const hasBidAsk = q.askMinor != null && q.bidMinor != null;
  let basePrice: Minor;
  if (draft.type === 'limit') basePrice = draft.limitPriceMinor!;
  else if (draft.type === 'stop') basePrice = draft.stopPriceMinor!;
  else if (draft.type === 'stop_limit') basePrice = draft.stopLimitPriceMinor!;
  else basePrice = hasBidAsk ? (draft.side === 'buy' ? q.askMinor! : q.bidMinor!) : q.priceMinor;

  // 2. spread + slippage (only applied to marketable prices; a limit price is a
  //    user-chosen ceiling/floor — charging spread on top would be wrong).
  //    A real bid/ask already contains the spread, so the modelled default
  //    spread is only a fallback when none is available (RM3).
  const slip = computeSlippage({
    side: draft.side,
    qty: draft.qty,
    avgDailyVolume: ctx.avgDailyVolume ?? draft.instrument.avgDailyVolume ?? null,
    hasBidAsk,
    settings: realism ? acct.settings.slippage : { baseBps: 0, perAdvPercentBps: 0, capBps: 0 },
  });
  const isLimitLike = draft.type !== 'market';
  const spreadBps = realism && !isLimitLike && !hasBidAsk ? (acct.settings.defaultSpreadBps ?? preset.defaultSpreadBps) : 0;
  const slippageBps = realism && !isLimitLike ? slip.slippageBps : 0;
  const adj = applyPriceAdjustments(basePrice, draft.side, spreadBps, slippageBps, preset.tickMinor);
  const fillPriceMinor = adj.priceMinor;

  const grossNativeMinor = fillPriceMinor * draft.qty;
  const sameCurrency = draft.instrument.currency === acct.baseCurrency;
  const rawFx = ctx.fx?.rate ?? 1;
  const fxSpread = realism && !sameCurrency ? acct.settings.fxSpreadBps : 0;
  const fxRate = sameCurrency ? 1 : quantizeRate(rawFx * (draft.side === 'buy' ? 1 + fxSpread / 10_000 : 1 - fxSpread / 10_000));
  const grossBaseMinor = sameCurrency ? grossNativeMinor : convertMinor(grossNativeMinor, fxRate);

  const fees = computeFees(preset, { side: draft.side, notionalMinor: grossBaseMinor, qty: draft.qty, realism });

  // tax estimate on sells (RM8) — withheld only when the user enabled it
  let taxMinor = 0;
  if (draft.side === 'sell' && acct.settings.deductTaxFromWallet) {
    const pos = positionFor(state, draft.instrument);
    if (pos) {
      const lots = consumeLotsFIFO(pos.lots, draft.qty);
      taxMinor = estimateTaxForSell({
        config: taxPresetFor(acct, preset.tax.country),
        proceedsBaseMinor: grossBaseMinor,
        sellUtc: ctx.nowUtc.toISOString(),
        lots,
      }).totalMinor;
    }
  }

  const totalBaseMinor = draft.side === 'buy' ? grossBaseMinor + fees.totalMinor : Math.max(0, grossBaseMinor - fees.totalMinor - taxMinor);
  const wallet = walletAt(state, ctx.nowUtc);
  const resulting = draft.side === 'buy' ? wallet.settledMinor - totalBaseMinor : wallet.settledMinor + totalBaseMinor;

  // position size as % of wallet (RM9)
  const totalValue = wallet.totalCashMinor + positionsValue(state, ctx);
  const positionPctOfWallet = totalValue > 0 ? totalBaseMinor / totalValue : 0;
  const concentrationWarning = concentrationNote(state, draft, positionPctOfWallet);

  // queued notice (M3): market orders (and untriggered stops) placed while closed
  const closed = !ctx.marketOpen;
  const wouldQueue = closed && draft.type === 'market';
  const queuedNotice = closed
    ? draft.type === 'market'
      ? `Market is closed — this market order will fill at the next open on ${ctx.sessionDate} (M3).`
      : `Market is closed — this ${draft.type.replace('_', '-')} order will be evaluated against the next session's prices (M3).`
    : null;

  const settlementAvailableAt =
    draft.side === 'sell' ? addTradingDays(ctx.nowUtc, preset.settlementDays, draft.instrument.exchange).toISOString() : null;

  return {
    fillPriceMinor,
    grossNativeMinor,
    fxRate,
    fxStale: ctx.fx?.stale ?? false,
    sameCurrency,
    fxSpreadBps: fxSpread,
    grossBaseMinor,
    feeLines: realism ? fees.lines : [],
    feesMinor: fees.totalMinor,
    taxMinor,
    totalBaseMinor,
    resultingSettledCashMinor: resulting,
    positionPctOfWallet,
    concentrationWarning,
    slippageExplanation: realism ? slip.explanation : 'Realism Mode is off — costs, spread and slippage are zero (idealized).',
    spreadBps,
    slippageBps,
    queued: wouldQueue,
    queuedNotice,
    settlementAvailableAtUtc: settlementAvailableAt,
    realism,
  };
}

function consumeLotsFIFO(lots: Position['lots'], qty: number): { qty: number; costBaseMinor: Minor; acquiredAtUtc: string }[] {
  const out: { qty: number; costBaseMinor: Minor; acquiredAtUtc: string }[] = [];
  let remaining = qty;
  const totalLotQty = lots.reduce((s, l) => s + l.qty, 0);
  for (const lot of lots) {
    if (remaining <= 0) break;
    const take = Math.min(lot.qty, remaining);
    remaining -= take;
    // allocate this lot's cost proportionally to the shares taken (estimate, D5)
    const cost = totalLotQty > 0 ? mulDivRound(lot.costBaseMinor, take, lot.qty) : 0;
    out.push({ qty: take, costBaseMinor: cost, acquiredAtUtc: lot.acquiredAtUtc });
  }
  return out;
}

function taxPresetFor(acct: Account, marketTaxCountry: string) {
  // Which tax config to use: the user's chosen country preset if it exists,
  // otherwise the market's own preset config.
  const presets = Object.values(acct.settings.costPresets);
  const chosen = presets.find((p) => p.tax.country === acct.settings.taxCountry);
  if (chosen && acct.settings.taxCountry === marketTaxCountry) return chosen.tax;
  const marketOwn = presets.find((p) => p.tax.country === marketTaxCountry);
  if (chosen && !marketOwn) return chosen.tax;
  return (marketOwn ?? chosen ?? presets[0]).tax;
}

function positionsValue(state: AppState, ctx: FillContext): Minor {
  // rough wallet-relative sizing helper: cost basis (stable, no network needed)
  return state.positions.reduce((s, p) => s + p.costBaseMinor, 0);
}

function concentrationNote(state: AppState, draft: OrderDraft, pct: number): string | null {
  if (draft.side !== 'buy' || pct <= 0.25) return null;
  return `This trade would make up ${(pct * 100).toFixed(0)}% of your wallet — concentrated positions carry more risk. (Educational observation, not advice.)`;
}

/* -------------------------------------------------------- placing orders */

export interface ExecuteFillOptions {
  priceMinor: Minor;
  /** raw market FX rate native→base (spread applied inside, F6) */
  fxRateNativeToBase: number;
  atUtc: Date;
  spreadBpsApplied: number;
  slippageBpsApplied: number;
}

/**
 * Compute costs (E5/RM2), build the immutable fill (E4/F4) and apply it.
 * Used for immediate fills and for reconstruction fills (R2/R3).
 */
export function executeFill(state: AppState, order: Order, opts: ExecuteFillOptions): { state: AppState; fill: Fill } {
  const acct = state.account!;
  const preset = presetForMarket(acct.settings.costPresets, marketGroupForExchange(order.instrument.exchange));
  const sameCcy = order.instrument.currency === acct.baseCurrency;
  const rawRate = opts.fxRateNativeToBase;
  const fxSpread = acct.settings.realismMode && !sameCcy ? acct.settings.fxSpreadBps : 0;
  const fxRate = sameCcy
    ? 1
    : quantizeRate(rawRate * (order.side === 'buy' ? 1 + fxSpread / 10_000 : 1 - fxSpread / 10_000));
  const grossBase = sameCcy ? opts.priceMinor * order.qty : convertMinor(opts.priceMinor * order.qty, fxRate);

  const fees = computeFees(preset, {
    side: order.side,
    notionalMinor: grossBase,
    qty: order.qty,
    realism: acct.settings.realismMode,
  });

  let taxMinor = 0;
  if (order.side === 'sell' && acct.settings.deductTaxFromWallet) {
    const pos = positionFor(state, order.instrument);
    if (pos) {
      taxMinor = estimateTaxForSell({
        config: taxPresetFor(acct, preset.tax.country),
        proceedsBaseMinor: grossBase,
        sellUtc: opts.atUtc.toISOString(),
        lots: consumeLotsFIFO(pos.lots, order.qty),
      }).totalMinor;
    }
  }

  const fill = buildFill(state, {
    order,
    priceMinor: opts.priceMinor,
    fxRateNativeToBase: rawRate,
    feeLines: fees.lines,
    feesMinor: fees.totalMinor,
    taxWithheldMinor: taxMinor,
    spreadBpsApplied: opts.spreadBpsApplied,
    slippageBpsApplied: opts.slippageBpsApplied,
    atUtc: opts.atUtc,
    realism: acct.settings.realismMode,
    settlementDays: preset.settlementDays,
  });
  return { state: applyFill(state, fill), fill };
}

export interface PlaceOrderResult {
  state: AppState;
  order: Order;
  fill: Fill | null;
  rejectedReason?: string;
}

/**
 * Validate + place an order. Fills immediately when the market is open and the
 * order is marketable; otherwise queues it for reconstruction (R2/R3).
 */
export function placeOrder(state: AppState, draft: OrderDraft, ctx: FillContext): PlaceOrderResult {
  const acct = state.account!;
  const now = ctx.nowUtc;
  const preset = presetForMarket(acct.settings.costPresets, marketGroupForExchange(draft.instrument.exchange));
  const est = estimateOrder(state, draft, ctx);
  const order: Order = {
    ...draft,
    id: newId('ord', now),
    createdAtUtc: now.toISOString(),
    status: 'queued',
    estBaseMinor: est.totalBaseMinor,
    estFeesMinor: est.feesMinor,
    createdSessionDate: ctx.sessionDate,
  };

  const valid = validateOrder(state, draft, ctx);
  if (!valid.ok) {
    const rejected: Order = { ...order, status: 'rejected', reason: valid.reason };
    return { state: { ...state, orders: [...state.orders, rejected] }, order: rejected, fill: null, rejectedReason: valid.reason };
  }

  // R4: never fill against stale data — queue instead of guessing.
  if (ctx.marketOpen && ctx.quote.stale && draft.type === 'market') {
    const waiting: Order = {
      ...order,
      status: 'waiting_data',
      waitingReason: 'Live quote is stale — waiting for fresh data before filling (R4).',
    };
    return { state: { ...state, orders: [...state.orders, waiting] }, order: waiting, fill: null };
  }

  // immediate execution?
  if (ctx.marketOpen && isImmediatelyMarketable(draft, ctx)) {
    const { state: next, fill } = executeFill({ ...state, orders: [...state.orders] }, order, {
      priceMinor: est.fillPriceMinor,
      fxRateNativeToBase: ctx.fx?.rate ?? 1,
      atUtc: now,
      spreadBpsApplied: est.spreadBps,
      slippageBpsApplied: est.slippageBps,
    });
    const filledOrder: Order = { ...order, status: 'filled', fillId: fill.id };
    return { state: { ...next, orders: [...next.orders, filledOrder] }, order: filledOrder, fill };
  }

  // queued (market orders while closed, or untriggered conditional orders)
  const expiry = draft.duration === 'day' ? dayExpiry(draft, ctx) : undefined;
  const queued: Order = {
    ...order,
    status: 'queued',
    expiresAtUtc: expiry,
    waitingReason:
      !ctx.marketOpen && draft.type === 'market'
        ? 'Waiting for the next session open (R2).'
        : draft.type === 'market'
          ? 'Waiting for data (R4).'
          : 'Waiting for the price condition to trigger (R3).',
  };
  return { state: { ...state, orders: [...state.orders, queued] }, order: queued, fill: null };
}

function dayExpiry(draft: OrderDraft, ctx: FillContext): string | undefined {
  if (draft.duration !== 'day') return undefined;
  // expires at the close of the session it was created for
  return dayOrderExpiryUtc(ctx.nowUtc, draft.instrument.exchange).toISOString();
}

/** Is a conditional order immediately marketable at the current quote? */
export function isImmediatelyMarketable(draft: OrderDraft, ctx: FillContext): boolean {
  const q = ctx.quote;
  const ask = q.askMinor ?? q.priceMinor;
  const bid = q.bidMinor ?? q.priceMinor;
  switch (draft.type) {
    case 'market':
      return true;
    case 'limit':
      return draft.side === 'buy' ? ask <= draft.limitPriceMinor! : bid >= draft.limitPriceMinor!;
    case 'stop': {
      // stop buy triggers when price rises to stop; stop sell when price falls to stop
      return draft.side === 'buy' ? q.priceMinor >= draft.stopPriceMinor! : q.priceMinor <= draft.stopPriceMinor!;
    }
    case 'stop_limit':
      return false; // evaluate the stop first in reconstruction for determinism (R3)
    default:
      return false;
  }
}

export function cancelOrder(state: AppState, orderId: string): AppState {
  return {
    ...state,
    orders: state.orders.map((o) =>
      o.id === orderId && (o.status === 'queued' || o.status === 'waiting_data')
        ? { ...o, status: 'cancelled', reason: 'Cancelled by user.' }
        : o,
    ),
  };
}

/* ------------------------------------------------ live order evaluation */

export type LiveOrderResult =
  | { type: 'none' }
  | { type: 'expired' }
  | { type: 'filled'; state: AppState; fill: Fill };

/**
 * Evaluate a queued order against a *live* quote while the app is open — the
 * in-session counterpart of reconstruction (R2/R3). Deterministic given the
 * inputs; a stale quote or closed market never fills (R4).
 */
export function evaluateLiveOrder(state: AppState, order: Order, ctx: FillContext): LiveOrderResult {
  if (order.status !== 'queued' && order.status !== 'waiting_data') return { type: 'none' };
  if (order.duration === 'day' && order.expiresAtUtc && Date.parse(order.expiresAtUtc) <= ctx.nowUtc.getTime()) {
    return { type: 'expired' };
  }
  if (!ctx.marketOpen || ctx.quote.stale || !state.account) return { type: 'none' };

  const q = ctx.quote;
  const ask = q.askMinor ?? q.priceMinor;
  const bid = q.bidMinor ?? q.priceMinor;
  let fillPrice: Minor | null = null;
  let spreadBps = 0;
  let slippageBps = 0;

  switch (order.type) {
    case 'market': {
      const est = estimateOrder(state, order, ctx);
      fillPrice = est.fillPriceMinor;
      spreadBps = est.spreadBps;
      slippageBps = est.slippageBps;
      break;
    }
    case 'limit': {
      if (order.side === 'buy' && ask <= order.limitPriceMinor!) fillPrice = Math.min(order.limitPriceMinor!, ask);
      if (order.side === 'sell' && bid >= order.limitPriceMinor!) fillPrice = Math.max(order.limitPriceMinor!, bid);
      break;
    }
    case 'stop': {
      const triggered = order.side === 'buy' ? q.priceMinor >= order.stopPriceMinor! : q.priceMinor <= order.stopPriceMinor!;
      if (triggered) fillPrice = order.side === 'buy' ? Math.max(order.stopPriceMinor!, ask) : Math.min(order.stopPriceMinor!, bid);
      break;
    }
    case 'stop_limit': {
      const stop = order.stopPriceMinor!;
      const limit = order.stopLimitPriceMinor!;
      const trig = order.side === 'buy' ? q.priceMinor >= stop : q.priceMinor <= stop;
      if (trig) {
        if (order.side === 'buy' && ask <= limit) fillPrice = Math.min(limit, Math.max(stop, ask));
        if (order.side === 'sell' && bid >= limit) fillPrice = Math.max(limit, Math.min(stop, bid));
      }
      break;
    }
  }

  if (fillPrice == null || fillPrice <= 0) return { type: 'none' };

  const { state: next, fill } = executeFill(state, order, {
    priceMinor: fillPrice,
    fxRateNativeToBase: ctx.fx?.rate ?? 1,
    atUtc: ctx.nowUtc,
    spreadBpsApplied: spreadBps,
    slippageBpsApplied: slippageBps,
  });
  const orders = next.orders.map((o) =>
    o.id === order.id ? { ...o, status: 'filled' as const, fillId: fill.id, waitingReason: undefined, reason: undefined } : o,
  );
  return { type: 'filled', state: { ...next, orders }, fill };
}

/* ------------------------------------------------------------- valuation */

export interface PositionValuation {
  instrument: Instrument;
  qty: number;
  priceMinor: Minor | null;
  priceAtUtc: string | null;
  priceStale: boolean;
  valueBaseMinor: Minor;
  costBaseMinor: Minor;
  unrealizedMinor: Minor;
  prevValueBaseMinor: Minor | null;
  dayChangeMinor: Minor | null;
  fxRate: number;
  fxStale: boolean;
  missing: boolean;
  flags: Position['flags'];
}

export interface Valuation {
  cashMinor: Minor;
  settledMinor: Minor;
  unsettledMinor: Minor;
  positionsValueMinor: Minor;
  totalValueMinor: Minor;
  unrealizedMinor: Minor;
  realizedGrossMinor: Minor;
  feesMinor: Minor;
  taxMinor: Minor;
  dividendsMinor: Minor;
  rows: PositionValuation[];
  missingPrices: string[];
  staleFxCurrencies: string[];
  asOfUtc: string;
}

export function computeValuation(state: AppState, priceOf: PriceLookup, fxOf: FxLookup, nowUtc: Date): Valuation {
  const acct = state.account;
  const wallet = walletAt(state, nowUtc);
  const rows: PositionValuation[] = [];
  const missingPrices: string[] = [];
  const staleFx = new Set<string>();
  let positionsValue = 0;
  let prevValue = 0;
  let hasPrev = true;

  for (const p of state.positions) {
    const q = priceOf(p.instrument);
    const native = p.instrument.currency;
    const fx = native === acct?.baseCurrency ? { rate: 1, atUtc: nowUtc.toISOString(), stale: false } : fxOf(native);
    if (!q) {
      missingPrices.push(instrumentId(p.instrument));
      rows.push({
        instrument: p.instrument, qty: p.qty, priceMinor: p.lastKnownPriceMinor ?? null,
        priceAtUtc: p.lastKnownPriceAtUtc ?? null, priceStale: true,
        valueBaseMinor: 0, costBaseMinor: p.costBaseMinor, unrealizedMinor: 0,
        prevValueBaseMinor: null, dayChangeMinor: null, fxRate: fx?.rate ?? 1,
        fxStale: fx?.stale ?? false, missing: true, flags: [...p.flags, 'price_stale'],
      });
      continue;
    }
    if (fx && fx.stale) staleFx.add(native);
    const value = convertMinor(q.priceMinor * p.qty, fx?.rate ?? 1);
    const unreal = value - p.costBaseMinor;
    let prevV: Minor | null = null;
    if (q.prevCloseMinor != null) {
      prevV = convertMinor(q.prevCloseMinor * p.qty, fx?.rate ?? 1);
      prevValue += prevV;
    } else {
      hasPrev = false;
    }
    positionsValue += value;
    rows.push({
      instrument: p.instrument,
      qty: p.qty,
      priceMinor: q.priceMinor,
      priceAtUtc: q.atUtc,
      priceStale: q.stale,
      valueBaseMinor: value,
      costBaseMinor: p.costBaseMinor,
      unrealizedMinor: unreal,
      prevValueBaseMinor: prevV,
      dayChangeMinor: prevV != null ? value - prevV : null,
      fxRate: fx?.rate ?? 1,
      fxStale: fx?.stale ?? false,
      missing: false,
      flags: p.flags,
    });
  }

  const realizedGross = state.positions.reduce((s, p) => s + p.realizedGrossBaseMinor, 0);
  const fees = state.fills.reduce((s, f) => s + f.feesMinor, 0);
  const tax = state.fills.reduce((s, f) => s + f.taxWithheldMinor, 0);
  const dividends = state.cashEvents.reduce((s, e) => s + e.amountMinor, 0);
  const unrealized = rows.reduce((s, r) => s + r.unrealizedMinor, 0);
  void hasPrev;

  return {
    cashMinor: wallet.totalCashMinor,
    settledMinor: wallet.settledMinor,
    unsettledMinor: wallet.unsettledMinor,
    positionsValueMinor: positionsValue,
    totalValueMinor: wallet.totalCashMinor + positionsValue,
    unrealizedMinor: unrealized,
    realizedGrossMinor: realizedGross,
    feesMinor: fees,
    taxMinor: tax,
    dividendsMinor: dividends,
    rows,
    missingPrices,
    staleFxCurrencies: [...staleFx],
    asOfUtc: nowUtc.toISOString(),
  };
}

export interface ReconcileResult {
  ok: boolean;
  expectedMinor: Minor;
  actualMinor: Minor;
  diffMinor: Minor;
  terms: {
    startingMinor: Minor;
    realizedMinor: Minor;
    unrealizedMinor: Minor;
    feesMinor: Minor;
    dividendsMinor: Minor;
    taxMinor: Minor;
  };
  missingPrices: string[];
}

/** V5 internal consistency check — run in tests and in the debug view. */
export function reconcile(state: AppState, v: Valuation): ReconcileResult {
  const acct = state.account!;
  const starting = acct.startingBalanceMinor;
  const expected =
    starting + v.realizedGrossMinor + v.unrealizedMinor - v.feesMinor + v.dividendsMinor - v.taxMinor;
  return {
    ok: expected === v.totalValueMinor,
    expectedMinor: expected,
    actualMinor: v.totalValueMinor,
    diffMinor: expected - v.totalValueMinor,
    terms: {
      startingMinor: starting,
      realizedMinor: v.realizedGrossMinor,
      unrealizedMinor: v.unrealizedMinor,
      feesMinor: v.feesMinor,
      dividendsMinor: v.dividendsMinor,
      taxMinor: v.taxMinor,
    },
    missingPrices: v.missingPrices,
  };
}

/** Status of an order for the UI (open/queued/filled/rejected). */
export function openOrders(state: AppState): Order[] {
  return state.orders.filter((o) => o.status === 'queued' || o.status === 'waiting_data');
}

export { emptyState, instrumentId, SCHEMA_VERSION, marketStatus, exchangeInfo, marketGroupForExchange };
