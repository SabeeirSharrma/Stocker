/**
 * Application store (spec §2.1): owns AppState, persistence, the market-data
 * service wiring and all async actions. UI components subscribe via
 * `useSyncExternalStore` — the engine stays pure and UI-free.
 */

import { marketStatus, marketGroupForExchange } from '../calendar/calendar';
import { MarketDataService, type FxOut, type QuoteOut } from '../data/marketdata';
import { makeAdapter, PROVIDER_LIST } from '../data/providers';
import { ProviderError, describeProviderError, type ProviderAdapter, type ProviderId } from '../data/provider';
import {
  cancelOrder as engineCancelOrder,
  computeValuation,
  createAccount,
  emptyState,
  evaluateLiveOrder,
  estimateOrder,
  executeFill,
  newId,
  placeOrder as enginePlaceOrder,
  reconcile,
  type FillContext,
  type ReconcileResult,
  type Valuation,
} from '../engine/engine';
import { convertMinor, quantizeRate, type Minor } from '../engine/money';
import { reconstruct } from '../engine/reconstruct';
import { evaluateChallenges, type Challenge } from '../teaching/challenges';
import { postTradeFeedback, type Feedback } from '../teaching/feedback';
import {
  instrumentId, SCHEMA_VERSION,
  type AppState, type Fill, type Instrument, type JournalEntry, type OrderDraft, type Settings,
} from '../engine/types';
import { buildExport, importExport, parseExport } from '../storage/exportimport';
import { idbGet, idbSet, STORE_RECORDS } from '../storage/idb';
import { HybridCacheStore, IdbCacheStore, TtlCache } from '../data/cache';
import { KeyStore } from './keystore';

export type Listener = () => void;

export interface StoreStatus {
  ready: boolean;
  reconRunning: boolean;
  reconNotes: string[];
  refreshing: boolean;
  error: { title: string; guidance: string } | null;
  offline: boolean;
}

export interface PlaceOrderOutcome {
  ok: boolean;
  orderId: string;
  status: string;
  reason?: string;
  fill: Fill | null;
  feedback: Feedback[];
}

export class AppStore {
  state: AppState = emptyState();
  quotes = new Map<string, QuoteOut>();
  fx = new Map<string, FxOut>(); // native currency → rate to base
  displayFx: FxOut | null = null; // display currency → base
  status: StoreStatus = {
    ready: false,
    reconRunning: false,
    reconNotes: [],
    refreshing: false,
    error: null,
    offline: false,
  };
  private listeners = new Set<Listener>();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private svc: MarketDataService;
  private keys: KeyStore;
  private lastValuation: Valuation | null = null;

  constructor(svc: MarketDataService, keys: KeyStore) {
    this.svc = svc;
    this.keys = keys;
  }

  /* ------------------------------------------------------------ plumbing */

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }

  private setState(next: AppState): void {
    // teaching layer: challenge progress after every change (T2)
    const { progress, newlyCompleted } = evaluateChallenges(next);
    if (newlyCompleted.length > 0) {
      next = { ...next, challengeProgress: progress };
      this.pendingCompleted.push(...newlyCompleted);
    }
    this.state = next;
    this.schedulePersist();
    this.emit();
  }

  pendingCompleted: Challenge[] = [];

  takeCompletedChallenges(): Challenge[] {
    const out = this.pendingCompleted;
    this.pendingCompleted = [];
    return out;
  }

  private schedulePersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      void this.persistNow();
    }, 120);
  }

  async persistNow(): Promise<void> {
    try {
      await idbSet(STORE_RECORDS, 'app', this.state);
    } catch (e) {
      this.setStatusError(e);
    }
  }

  private setStatusError(e: unknown): void {
    const d = describeProviderError(e);
    this.status = { ...this.status, error: d };
    this.emit();
  }

  clearStatusError(): void {
    if (this.status.error) {
      this.status = { ...this.status, error: null };
      this.emit();
    }
  }

  /* ---------------------------------------------------------------- init */

  async init(): Promise<void> {
    await this.keys.load();
    let rec: AppState | undefined;
    try {
      rec = await idbGet<AppState>(STORE_RECORDS, 'app');
    } catch {
      rec = undefined;
    }
    this.state = rec ? { ...emptyState(), ...rec } : emptyState();
    if (this.state.schemaVersion !== SCHEMA_VERSION) {
      // future migrations go here; for now reset the version stamp only
      this.state = { ...this.state, schemaVersion: SCHEMA_VERSION };
    }
    const providerId = this.state.account?.settings.providerId ?? 'twelvedata';
    try {
      this.svc.setProvider(providerId as ProviderId);
    } catch {
      this.svc.setProvider('twelvedata');
    }
    this.status = { ...this.status, ready: true };
    this.emit();
    if (this.state.account) {
      // fire and forget — the UI reads status.reconRunning
      void this.runReconstruction();
    }
  }

  /* ------------------------------------------------------------- lookups */

  account() {
    return this.state.account;
  }

  baseCurrency(): string {
    return this.state.account?.baseCurrency ?? 'USD';
  }

  valuation(now: Date = new Date()): Valuation {
    const acct = this.state.account;
    if (!acct) {
      return {
        cashMinor: 0, settledMinor: 0, unsettledMinor: 0, positionsValueMinor: 0, totalValueMinor: 0,
        unrealizedMinor: 0, realizedGrossMinor: 0, feesMinor: 0, taxMinor: 0, dividendsMinor: 0,
        rows: [], missingPrices: [], staleFxCurrencies: [], asOfUtc: now.toISOString(),
      };
    }
    const v = computeValuation(
      this.state,
      (i) => this.quotes.get(instrumentId(i)) ?? null,
      (c) => this.fx.get(c) ?? null,
      now,
    );
    this.lastValuation = v;
    return v;
  }

  reconcileNow(): ReconcileResult | null {
    if (!this.state.account) return null;
    return reconcile(this.state, this.valuation());
  }

  lastValuationOrNull(): Valuation | null {
    return this.lastValuation;
  }

  /** Convert a base-currency amount to the display currency (W3, display only). */
  toDisplay(minorBase: Minor): { minor: Minor; currency: string } {
    const acct = this.state.account;
    if (!acct) return { minor: 0, currency: 'USD' };
    const display = acct.settings.displayCurrency;
    if (!display || display === acct.baseCurrency) return { minor: minorBase, currency: acct.baseCurrency };
    // displayFx stores display→base; invert for base→display
    const rate = this.displayFx ? 1 / this.displayFx.rate : null;
    if (rate == null) return { minor: minorBase, currency: acct.baseCurrency };
    return { minor: convertMinor(minorBase, quantizeRate(rate)), currency: display };
  }

  /* ------------------------------------------------------------ data ops */

  private async buildContext(instrument: Instrument, now = new Date()): Promise<FillContext> {
    const acct = this.state.account!;
    const st = marketStatus(now, instrument.exchange);
    let quote: QuoteOut;
    try {
      quote = await this.svc.getQuote(instrument);
    } catch (e) {
      this.setStatusError(e);
      throw e;
    }
    const engineQuote = {
      priceMinor: quote.priceMinor,
      bidMinor: quote.bidMinor,
      askMinor: quote.askMinor,
      prevCloseMinor: quote.prevCloseMinor,
      openMinor: quote.openMinor,
      volume: quote.volume,
      atUtc: quote.atUtc,
      delayed: quote.delayed,
      stale: quote.stale,
    };
    let fx: { rate: number; atUtc: string; stale: boolean } | null = null;
    if (instrument.currency !== acct.baseCurrency) {
      const r = await this.svc.getFx(instrument.currency, acct.baseCurrency, acct.settings.staleFxThresholdMs);
      fx = r ? { rate: r.rate, atUtc: r.atUtc, stale: r.stale } : null;
      if (r) this.fx.set(instrument.currency, r);
    }
    const avg = await this.svc.avgDailyVolume(instrument);
    return {
      nowUtc: now,
      quote: engineQuote,
      fx,
      avgDailyVolume: avg ?? instrument.avgDailyVolume ?? null,
      marketOpen: st.isOpenNow,
      sessionDate: st.sessionDate,
    };
  }

  /** Daily candles for a chart (instrument detail, T4). Returns null on failure — never guesses (R4). */
  async candlesFor(instrument: Instrument, fromUtc: Date, toUtc: Date): Promise<import('../engine/types').Candle[] | null> {
    try {
      return await this.svc.tryDailyCandles(instrument, fromUtc, toUtc);
    } catch (e) {
      this.setStatusError(e);
      return null;
    }
  }

  /** Refresh quotes/FX for instruments the screen actually needs (C3). */
  async refreshPrices(instruments: Instrument[]): Promise<void> {
    if (!this.state.account) return;
    this.status = { ...this.status, refreshing: true };
    this.emit();
    const base = this.baseCurrency();
    const threshold = this.state.account?.settings.staleFxThresholdMs ?? 900_000;
    for (const inst of instruments) {
      try {
        const q = await this.svc.getQuote(inst);
        this.quotes.set(instrumentId(inst), q);
        if (inst.currency !== base) {
          const r = await this.svc.getFx(inst.currency, base, threshold);
          if (r) this.fx.set(inst.currency, r);
        }
      } catch (e) {
        this.setStatusError(e); // cached/stale data already served inside the service
      }
    }
    await this.refreshDisplayFx();
    this.status = { ...this.status, refreshing: false };
    this.emit();
  }

  async refreshDisplayFx(): Promise<void> {
    const acct = this.state.account;
    if (!acct?.settings.displayCurrency || acct.settings.displayCurrency === acct.baseCurrency) {
      this.displayFx = null;
      return;
    }
    try {
      const r = await this.svc.getFx(acct.settings.displayCurrency, acct.baseCurrency, acct.settings.staleFxThresholdMs);
      this.displayFx = r;
    } catch {
      this.displayFx = null;
    }
  }

  /** Held instruments + instruments with open orders + a screen instrument (C3). */
  screenInstruments: Instrument[] = [];

  setScreenInstruments(list: Instrument[]): void {
    this.screenInstruments = list;
  }

  async refreshRelevant(): Promise<void> {
    const map = new Map<string, Instrument>();
    for (const p of this.state.positions) map.set(instrumentId(p.instrument), p.instrument);
    for (const o of this.state.orders) {
      if (o.status === 'queued' || o.status === 'waiting_data') map.set(instrumentId(o.instrument), o.instrument);
    }
    for (const i of this.screenInstruments) map.set(instrumentId(i), i);
    if (map.size === 0) return;
    await this.refreshPrices([...map.values()]);
    await this.evaluateOpenOrders();
  }

  /** Live evaluation of queued orders against fresh quotes while the app is open (R3 live path). */
  async evaluateOpenOrders(): Promise<void> {
    const open = this.state.orders.filter((o) => o.status === 'queued' || o.status === 'waiting_data');
    if (open.length === 0) return;
    let next = this.state;
    for (const order of open) {
      try {
        const ctx = await this.buildContext(order.instrument);
        const result = evaluateLiveOrder(next, order, ctx);
        if (result.type === 'expired') {
          next = { ...next, orders: next.orders.map((o) => (o.id === order.id ? { ...o, status: 'expired', reason: 'Day order expired before its condition triggered (RM4).' } : o)) };
        } else if (result.type === 'filled') {
          next = result.state;
        }
      } catch {
        // quote unavailable → leave queued (R4)
      }
    }
    if (next !== this.state) this.setState(next);
  }

  async search(query: string): Promise<Instrument[]> {
    try {
      return await this.svc.search(query);
    } catch (e) {
      this.setStatusError(e);
      return [];
    }
  }

  /* ----------------------------------------------------------- trading */

  estimate(draft: OrderDraft, ctx: FillContext) {
    return estimateOrder(this.state, draft, ctx);
  }

  async buildContextFor(instrument: Instrument): Promise<FillContext | null> {
    if (!this.state.account) return null;
    try {
      return await this.buildContext(instrument);
    } catch {
      return null;
    }
  }

  async placeOrder(draft: OrderDraft): Promise<PlaceOrderOutcome> {
    if (!this.state.account) {
      return { ok: false, orderId: '', status: 'rejected', reason: 'No account yet — finish onboarding first.', fill: null, feedback: [] };
    }
    const ctx = await this.buildContext(draft.instrument);
    const result = enginePlaceOrder(this.state, draft, ctx);
    this.setState(result.state);

    const valuation = this.valuation();
    const position = result.state.positions.find((p) => instrumentId(p.instrument) === instrumentId(draft.instrument));
    const feedback: Feedback[] = result.fill
      ? postTradeFeedback(result.fill, valuation, position, this.baseCurrency())
      : [];
    return {
      ok: !!result.fill || result.order.status === 'queued',
      orderId: result.order.id,
      status: result.order.status,
      reason: result.rejectedReason ?? result.order.reason,
      fill: result.fill,
      feedback,
    };
  }

  cancelOrder(orderId: string): void {
    this.setState(engineCancelOrder(this.state, orderId));
  }

  /* ------------------------------------------------- reconstruction (R1) */

  async runReconstruction(): Promise<void> {
    if (!this.state.account) return;
    this.status = { ...this.status, reconRunning: true };
    this.emit();
    try {
      const now = new Date();
      const data = await this.svc.fetchReconstructionData(this.state, now);
      const result = reconstruct({ state: this.state, nowUtc: now, data });
      this.setState(result.state);
      this.status = { ...this.status, reconNotes: result.notes };
    } catch (e) {
      this.status = { ...this.status, reconNotes: [`Reconstruction could not complete: ${e instanceof Error ? e.message : String(e)}`] };
    } finally {
      this.status = { ...this.status, reconRunning: false };
      this.emit();
    }
  }

  /* -------------------------------------------------------- onboarding */

  acknowledgeDisclaimer(): void {
    this.setState({ ...this.state, meta: { ...this.state.meta, disclaimerAckAtUtc: new Date().toISOString() } });
  }

  async completeOnboarding(input: {
    baseCurrency: string;
    startingBalanceMinor: Minor;
    providerId: ProviderId;
    apiKey: string;
    realismMode: boolean;
    displayLocale?: string;
  }): Promise<void> {
    const now = new Date();
    const account = createAccount({
      baseCurrency: input.baseCurrency,
      startingBalanceMinor: input.startingBalanceMinor,
      nowUtc: now,
      settings: { realismMode: input.realismMode, providerId: input.providerId },
    });
    await this.keys.set(input.providerId, input.apiKey);
    this.svc.setProvider(input.providerId);
    this.setState({
      ...emptyState(),
      account,
      meta: {
        ...emptyState().meta,
        disclaimerAckAtUtc: this.state.meta.disclaimerAckAtUtc ?? now.toISOString(),
        onboardingComplete: true,
      },
    });
    await this.persistNow();
    await this.runReconstruction();
  }

  /** Settings screen: replace or clear the stored provider API key (P1/P4). */
  async setApiKey(providerId: ProviderId, key: string): Promise<void> {
    if (key) await this.keys.set(providerId, key);
    else await this.keys.remove(providerId);
  }

  /** Whether an API key is present for a provider (the value itself never leaves the device). */
  hasApiKey(providerId: ProviderId): boolean {
    return this.keys.get(providerId) != null;
  }

  async testKey(providerId: ProviderId, key: string): Promise<{ ok: boolean; message: string; plan?: string }> {
    const adapter: ProviderAdapter = makeAdapter(providerId, () => key || null);
    try {
      await this.svc.limiter(providerId).acquire();
      return await adapter.testKey();
    } catch (e) {
      if (e instanceof ProviderError) return { ok: false, message: `${e.message}${e.hint ? ` — ${e.hint}` : ''}` };
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  /* ---------------------------------------------------------- settings */

  async updateSettings(patch: Partial<Settings>): Promise<void> {
    const acct = this.state.account;
    if (!acct) return;
    const settings = { ...acct.settings, ...patch };
    if (patch.providerId && patch.providerId !== acct.settings.providerId) {
      try {
        this.svc.setProvider(patch.providerId as ProviderId);
      } catch {
        /* keep previous */
      }
    }
    if (patch.displayCurrency !== undefined) await this.refreshDisplayFx();
    this.setState({ ...this.state, account: { ...acct, settings } });
    await this.persistNow();
  }

  async addJournal(entry: Omit<JournalEntry, 'id' | 'openedAtUtc'> & { openedAtUtc?: string }): Promise<void> {
    const e: JournalEntry = {
      ...entry,
      id: newId('jr', new Date()),
      openedAtUtc: entry.openedAtUtc ?? new Date().toISOString(),
    };
    this.setState({ ...this.state, journal: [...this.state.journal, e] });
  }

  async updateJournal(id: string, patch: Partial<JournalEntry>): Promise<void> {
    this.setState({ ...this.state, journal: this.state.journal.map((j) => (j.id === id ? { ...j, ...patch } : j)) });
  }

  async removeJournal(id: string): Promise<void> {
    this.setState({ ...this.state, journal: this.state.journal.filter((j) => j.id !== id) });
  }

  /* --------------------------------------------------- export / import */

  async exportJson(includeKeys?: boolean): Promise<string> {
    const acct = this.state.account;
    const include = includeKeys ?? acct?.settings.includeKeysInExport ?? false;
    // record the backup so the "export a backup" challenge completes (T2)
    this.state = { ...this.state, meta: { ...this.state.meta, exportedAtUtc: new Date().toISOString() } };
    this.setState(this.state);
    const keys = await this.keys.all();
    const text = buildExport(this.state, keys, include);
    await this.persistNow();
    return text;
  }

  async importJson(text: string): Promise<void> {
    const parsed = parseExport(text);
    if (!parsed.ok) throw new Error(parsed.error); // rejected before any write (A4)
    await importExport(parsed.env);
    this.state = { ...emptyState(), ...parsed.env.app, schemaVersion: SCHEMA_VERSION };
    const providerId = this.state.account?.settings.providerId ?? 'twelvedata';
    try {
      this.svc.setProvider(providerId as ProviderId);
    } catch {
      this.svc.setProvider('twelvedata');
    }
    this.quotes.clear();
    this.fx.clear();
    this.emit();
    await this.runReconstruction();
  }

  /** U1: reset requires confirmation + a first-class export offer. */
  async resetAccount(opts: { keepKeys?: boolean } = {}): Promise<void> {
    this.state = emptyState();
    this.quotes.clear();
    this.fx.clear();
    this.lastValuation = null;
    if (opts.keepKeys === false) {
      for (const p of PROVIDER_LIST) await this.keys.remove(p.id);
    }
    await idbSet(STORE_RECORDS, 'app', this.state);
    this.emit();
  }

  /* --------------------------------------------------------- misc getters */

  providerId(): ProviderId {
    return this.svc.providerId();
  }

  providers() {
    return PROVIDER_LIST;
  }

  marketGroupFor(instrument: Instrument): string {
    return marketGroupForExchange(instrument.exchange);
  }

  /** Debug view (V5): run the internal consistency check. */
  debugReconcile(): string {
    const r = this.reconcileNow();
    if (!r) return 'No account.';
    const t = r.terms;
    return [
      `identity: start(${t.startingMinor}) + realized(${t.realizedMinor}) + unrealized(${t.unrealizedMinor}) − fees(${t.feesMinor}) + dividends(${t.dividendsMinor}) − tax(${t.taxMinor}) = ${r.expectedMinor}`,
      `actual total value: ${r.actualMinor}   diff: ${r.diffMinor}   ${r.ok ? 'RECONCILED ✓' : 'MISMATCH ✗'}`,
      r.missingPrices.length ? `missing prices: ${r.missingPrices.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
}

/** Build a store wired to IndexedDB-backed storage (browser) or memory (tests). */
export function createAppStore(deps?: { cache?: TtlCache }): { store: AppStore; svc: MarketDataService; keys: KeyStore } {
  const keys = new KeyStore();
  const cache = deps?.cache ?? new TtlCache(new HybridCacheStore(new IdbCacheStore()));
  const adapters = PROVIDER_LIST.map((p) => makeAdapter(p.id, () => keys.get(p.id)));
  const svc = new MarketDataService({ adapters, cache });
  const store = new AppStore(svc, keys);
  return { store, svc, keys };
}
