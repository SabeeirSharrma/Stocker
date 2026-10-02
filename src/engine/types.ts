/**
 * Domain types for the simulation engine. Pure data — no network, no DOM.
 * All money/price fields are integer minor units (see money.ts, W4/W5).
 * All timestamps are UTC ISO-8601 strings (X5).
 */

import type { Minor } from './money';

export type Side = 'buy' | 'sell';
export type OrderType = 'market' | 'limit' | 'stop' | 'stop_limit';
export type OrderDuration = 'day' | 'gtc';
export type OrderStatus =
  | 'queued' // waiting for next session / trigger
  | 'filled'
  | 'rejected'
  | 'cancelled'
  | 'expired' // day order that never triggered before the session ended
  | 'waiting_data'; // R4: reconstruction needs data we don't have — never guess
export type AssetType = 'stock' | 'etf' | 'index';

export interface InstrumentKey {
  symbol: string;
  exchange: string; // I1: identity is (symbol, exchange)
}

export function instrumentId(k: InstrumentKey): string {
  return `${k.exchange}:${k.symbol}`;
}

export function sameInstrument(a: InstrumentKey, b: InstrumentKey): boolean {
  return a.symbol === b.symbol && a.exchange === b.exchange;
}

export interface Instrument extends InstrumentKey {
  name: string;
  currency: string; // native currency (I2)
  assetType: AssetType;
  sector?: string | null;
  providerId?: string; // provider-specific symbol if different from `symbol`
  provider?: string; // adapter id that knows this instrument
  avgDailyVolume?: number | null; // shares/day, used by the slippage model (RM3)
  isIndex?: boolean; // real indices are read-only reference data (I3)
}

/* ------------------------------------------------------------------ orders */

export interface OrderDraft {
  instrument: Instrument;
  side: Side;
  type: OrderType;
  duration: OrderDuration;
  qty: number; // whole shares only (I5)
  limitPriceMinor?: Minor;
  stopPriceMinor?: Minor;
  stopLimitPriceMinor?: Minor;
  note?: string;
}

export interface FeeLine {
  id: string;
  label: string;
  amountMinor: Minor; // always >= 0
}

export interface Order extends OrderDraft {
  id: string;
  createdAtUtc: string;
  status: OrderStatus;
  /** why an order was rejected/expired */
  reason?: string;
  /** R4: what data we are waiting for */
  waitingReason?: string;
  fillId?: string;
  /** estimated (pre-fill) totals shown on the ticket and kept for history */
  estBaseMinor?: Minor;
  estFeesMinor?: Minor;
  /** session (exchange date) the order was created in — used for day expiry */
  createdSessionDate?: string;
  lastSessionDate?: string;
  expiresAtUtc?: string;
}

/* ------------------------------------------------------------------- fills */

export interface Fill {
  id: string;
  orderId: string;
  instrument: Instrument;
  side: Side;
  qty: number;
  nativePriceMinor: Minor; // in instrument currency minor units
  nativeCurrency: string;
  fxRate: number; // quantised rate native→base used for this fill (F4)
  /** gross base-currency value of the trade (positive integer) */
  baseGrossMinor: Minor;
  feesMinor: Minor;
  feeLines: FeeLine[];
  /** estimated capital-gains tax withheld on a sell when the setting is on (RM8) */
  taxWithheldMinor: Minor;
  /** cash debited for this fill (buys): gross + fees (+ tax on buy, never in v1) */
  baseDebitedMinor: Minor;
  /** cash credited for this fill (sells): gross − fees − tax withheld */
  baseCreditedMinor: Minor;
  /** settlement: when the credit becomes spendable (RM5); null for buys */
  availableAtUtc: string | null;
  timestampUtc: string;
  exchange: string;
  realism: boolean; // Realism Mode flag at fill time (RM1)
  spreadBpsApplied: number;
  slippageBpsApplied: number;
}

/* -------------------------------------------------------------- positions */

export interface Lot {
  qty: number;
  costBaseMinor: Minor; // total base-currency cost of this lot (F4 basis)
  acquiredAtUtc: string;
  fxRate: number;
}

export type PositionFlag =
  | 'price_stale' // X2: valued from last known price
  | 'dividends_unverified' // X3/RM7: provider did not expose dividend data
  | 'split_unverified' // X2/RM7: possible split not confirmed by provider
  | 'delisted_unknown'; // X2: instrument no longer resolvable

export interface Position {
  instrument: Instrument;
  qty: number;
  /** total remaining base-currency cost basis of the position (average-cost, V3) */
  costBaseMinor: Minor;
  /** cumulative realized gross P&L (before fees — see engine.reconcile, V5) */
  realizedGrossBaseMinor: Minor;
  lots: Lot[];
  openedAtUtc: string;
  lastFillAtUtc: string;
  flags: PositionFlag[];
  /** corporate-action records already applied (idempotency, R5) */
  appliedActions: string[];
  /** last native price we could not refresh (X2), minor units */
  lastKnownPriceMinor?: Minor;
  lastKnownPriceAtUtc?: string;
}

/* ------------------------------------------------------------ cash events */

export interface CashEvent {
  id: string;
  type: 'dividend';
  instrument: Instrument;
  qty: number;
  amountMinor: Minor; // base-currency amount actually credited (F4)
  nativeAmountMinor: Minor;
  fxRate: number;
  paidAtUtc: string;
  actionId: string; // provider corporate-action id — idempotency key (R5)
}

/* --------------------------------------------------------------- snapshot */

export interface Snapshot {
  date: string; // YYYY-MM-DD (UTC date of the session day)
  cashMinor: Minor;
  positionsValueMinor: Minor;
  totalValueMinor: Minor;
  realizedCumMinor: Minor;
  unrealizedMinor: Minor;
  feesCumMinor: Minor;
  dividendsCumMinor: Minor;
  taxPaidCumMinor: Minor;
  fxRates: Record<string, number>; // e.g. "USD->INR": 83.41
  stale?: boolean; // prices or FX came from cache beyond TTL (A2)
}

/* --------------------------------------------------------------- account */

export interface CostComponent {
  id: string;
  label: string;
  side: Side | 'both';
  /**
   * 'notional_ppm': value = parts-per-million of notional (1 ppm = 0.0001%).
   * 'notional_bps': value = basis points of notional (hand-edited presets).
   * 'per_share_micro': value = 1e-6 minor units per share (optionally capMinor).
   * 'flat': value = flat minor units per order.
   */
  basis: 'notional_ppm' | 'notional_bps' | 'per_share_micro' | 'flat';
  value: number;
  /** cap for per_share_micro components, in minor units */
  capMinor?: Minor;
  /** charge computed on the sum of the listed components, e.g. GST (IN) */
  gstOn?: string[]; // component ids whose sum is the GST base
  gstRateBps?: number;
}

export interface TaxConfig {
  country: string;
  label: string;
  shortTermRateBps: number; // applied to gains when held <= longTermHoldingDays
  longTermRateBps: number;
  longTermHoldingDays: number;
  /** annual exemption in base-currency minor units (applied to realized gains, informational) */
  exemptionMinor?: Minor;
  source: string;
  sourceDate: string;
  notes: string;
}

export interface CostPreset {
  id: string;
  /** market group key: exchange or country grouping */
  market: string;
  label: string;
  currency: string;
  components: CostComponent[];
  settlementDays: number; // RM5 (business days)
  tickMinor: Minor; // RM6 minimum price increment in the market currency
  lotSize: number; // RM6
  /** RM6 price band vs previous close; 0 = not enforced */
  priceBandBps: number;
  defaultSpreadBps: number; // RM3 fallback when bid/ask unavailable
  fxSpreadBps: number; // F6 realistic FX spread applied at conversion
  tax: TaxConfig;
  source: string;
  sourceDate: string;
}

export interface SlippageSettings {
  /** base slippage in bps applied when no bid/ask is available */
  baseBps: number;
  /** bps added per 1% of average daily volume consumed by the order */
  perAdvPercentBps: number;
  /** cap on the size-driven component */
  capBps: number;
}

export interface Settings {
  realismMode: boolean; // RM1 (on by default)
  /** active market-data provider (P4) */
  providerId: string;
  fxSpreadBps: number; // F6
  defaultSpreadBps: number | null; // RM3 fallback (null → use the market preset's default)
  slippage: SlippageSettings;
  /** user-editable cost presets keyed by market group (RM2) */
  costPresets: Record<string, CostPreset>;
  taxCountry: string;
  settlementByMarket: Record<string, number>; // RM5 overrides
  deductTaxFromWallet: boolean; // RM8 default off
  displayCurrency: string | null; // W3 display-only change; null = base
  benchmark: InstrumentKey; // T4
  staleFxThresholdMs: number; // F3
  includeKeysInExport: boolean; // P2 default false
}

export interface Account {
  id: string;
  createdAtUtc: string;
  baseCurrency: string;
  startingBalanceMinor: Minor;
  settings: Settings;
}

/* ------------------------------------------------------- journal (RM9) */

export interface JournalEntry {
  id: string;
  instrument: InstrumentKey | null;
  side: Side | null;
  openedAtUtc: string;
  reason: string;
  thesis: string;
  exitPlan: string;
  closedAtUtc?: string;
  outcomeNote?: string;
  reviewedAtUtc?: string;
}

/* ------------------------------------------------------ market data shapes */

/** Daily OHLC candle, prices in integer minor units of the instrument currency. */
export interface Candle {
  timeUtc: string; // provider timestamp of the candle (UTC)
  /** authoritative trading session date (YYYY-MM-DD) as the provider means it */
  sessionDate: string;
  openMinor: Minor;
  highMinor: Minor;
  lowMinor: Minor;
  closeMinor: Minor;
  volume: number;
}

/** Historical FX point: rate native→base for a date. */
export interface FxPoint {
  timeUtc?: string;
  dateKey: string;
  rate: number; // quantised
}

export interface DividendRecord {
  id: string;
  exDate: string; // YYYY-MM-DD
  payDate: string; // YYYY-MM-DD
  amountNativeMinor: Minor; // per share
  currency: string;
}

export interface SplitRecord {
  id: string;
  exDate: string; // YYYY-MM-DD
  numerator: number;
  denominator: number;
}

/* ------------------------------------------------------------ app state */

export interface Meta {
  disclaimerAckAtUtc: string | null; // D3
  onboardingComplete: boolean;
  lastSnapshotDate: string | null; // R1
  lastReconstructAtUtc: string | null;
  appliedCorporateActions: string[]; // R5 idempotency
  exportIncludeKeysOptIn: boolean; // P2
  /** set when the user exports a backup (teaching challenge, T2) */
  exportedAtUtc: string | null;
}

export const SCHEMA_VERSION = 1;

export interface AppState {
  schemaVersion: number;
  account: Account | null;
  positions: Position[];
  orders: Order[];
  fills: Fill[];
  cashEvents: CashEvent[];
  snapshots: Snapshot[];
  journal: JournalEntry[];
  challengeProgress: Record<string, string>; // challenge id → completedAtUtc
  meta: Meta;
}

export function emptyState(): AppState {
  return {
    schemaVersion: SCHEMA_VERSION,
    account: null,
    positions: [],
    orders: [],
    fills: [],
    cashEvents: [],
    snapshots: [],
    journal: [],
    challengeProgress: {},
    meta: {
      disclaimerAckAtUtc: null,
      onboardingComplete: false,
      lastSnapshotDate: null,
      lastReconstructAtUtc: null,
      appliedCorporateActions: [],
      exportIncludeKeysOptIn: false,
      exportedAtUtc: null,
    },
  };
}
