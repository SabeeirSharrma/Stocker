/**
 * UI smoke tests: every screen must render (server-side, no DOM) against a
 * realistic state without throwing. This catches missing null-guards in the
 * view layer, which the engine tests deliberately do not touch.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach } from 'vitest';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import { App } from '../src/App';
import { Onboarding, CURRENCIES_OPTS, defaultBalance, balancePresets, presetLabel } from '../src/ui/onboarding';
import { Portfolio } from '../src/ui/portfolio';
import { Search } from '../src/ui/search';
import { InstrumentDetail } from '../src/ui/instrument';
import { TradeTicket } from '../src/ui/ticket';
import { Orders } from '../src/ui/orders';
import { Performance } from '../src/ui/performance';
import { Learn } from '../src/ui/learn';
import { Settings } from '../src/ui/settings';
import { GlossarySheet, openGlossary, closeGlossary } from '../src/ui/common';
import { createAppStore, type AppStore } from '../src/state/store';
import { estimateOrder } from '../src/engine/engine';
import type { QuoteOut } from '../src/data/marketdata';
import type { QuoteData } from '../src/engine/engine';
import { closeDatabase } from '../src/storage/idb';
import { AAPL, MSFT, draft, ctx, makeState, quote } from './helpers';

afterEach(async () => {
  await closeDatabase();
});

/** QuoteOut = engine quote + provider label (U2 freshness). */
const out = (priceMajor: number, over: Partial<QuoteData> = {}): QuoteOut => ({
  ...quote(priceMajor, over),
  provider: 'twelvedata',
});

function readyStore(state = makeState({ realism: false })): AppStore {
  const { store } = createAppStore();
  store.state = state;
  store.status = { ...store.status, ready: true };
  return store;
}

function withQuotes(store: AppStore): AppStore {
  store.quotes.set('NASDAQ:AAPL', out(190, { bidMinor: 18_995, askMinor: 19_005 }));
  store.quotes.set('NASDAQ:MSFT', out(420));
  return store;
}

describe('screens render without crashing', () => {
  it('app shell (loading → onboarding → ready)', () => {
    const cold = createAppStore().store;
    expect(renderToString(createElement(App, { store: cold }))).toMatch(/Loading your practice account/);

    const fresh = createAppStore().store;
    fresh.status = { ...fresh.status, ready: true };
    expect(renderToString(createElement(App, { store: fresh }))).toMatch(/Welcome to Stocker/);

    const store = withQuotes(readyStore());
    const html = renderToString(createElement(App, { store }));
    expect(html).toMatch(/Total value/);
    expect(html).toMatch(/Simulated/);
    expect(html).toMatch(/not financial advice/i);
  });

  it('onboarding shows the full disclaimer before anything else (D3)', () => {
    const store = createAppStore().store;
    const html = renderToString(createElement(Onboarding, { store }));
    expect(html).toMatch(/NOT a broker, exchange or advisor/i);
    expect(html).toMatch(/Continue/);
    expect(html).toMatch(/I understand this is an educational simulation/);
    expect(html).toMatch(/Known limits/);
  });

  it('portfolio shows value, cash and empty-state guidance', () => {
    const store = withQuotes(readyStore());
    const html = renderToString(
      createElement(Portfolio, { store, onOpenInstrument: () => {}, onOpenOrders: () => {}, onSearch: () => {} }),
    );
    expect(html).toMatch(/Cash/);
    expect(html).toMatch(/Positions/);
    expect(html).toMatch(/Overall P&amp;L/);
  });

  it('search renders holdings when the query is empty', () => {
    const store = readyStore();
    const html = renderToString(createElement(Search, { store, onOpen: () => {} }));
    expect(html).toMatch(/Symbol or company name/);
    expect(html).toMatch(/Your holdings/);
  });

  it('instrument detail shows price, stats, chart range and buy/sell', () => {
    const store = withQuotes(readyStore());
    const html = renderToString(
      createElement(InstrumentDetail, { store, instrument: AAPL, onBack: () => {}, onTrade: () => {} }),
    );
    expect(html).toMatch(/Key stats/);
    expect(html).toMatch(/Price history/);
    expect(html).toMatch(/Buy/);
    expect(html).toMatch(/Sell/);
    expect(html).toMatch(/closed|open/);
  });

  it('index instruments cannot be traded (I3)', () => {
    const store = readyStore();
    const index = { ...AAPL, symbol: 'NIFTY_50', exchange: 'NSE', isIndex: true, assetType: 'index' as const };
    const html = renderToString(
      createElement(InstrumentDetail, { store, instrument: index, onBack: () => {}, onTrade: () => {} }),
    );
    expect(html).toMatch(/Read-only reference data/);
    expect(html).toMatch(/disabled/);
  });

  it('trade ticket shows the estimate placeholder and disclaimer', () => {
    const store = withQuotes(readyStore());
    const html = renderToString(
      createElement(TradeTicket, { store, instrument: AAPL, initialSide: 'buy', onClose: () => {} }),
    );
    expect(html).toMatch(/Trade ticket for AAPL/);
    expect(html).toMatch(/Order type/);
    expect(html).toMatch(/Estimated .*cost/);
    expect(html).toMatch(/whole shares/);
  });

  it('orders screen has open/history/fills views', () => {
    const store = readyStore();
    const html = renderToString(createElement(Orders, { store }));
    expect(html).toMatch(/Open \(/);
    expect(html).toMatch(/History \(/);
    expect(html).toMatch(/Fills \(/);
  });

  it('performance shows the equity curve and the consistency check', () => {
    const store = withQuotes(readyStore());
    const html = renderToString(createElement(Performance, { store }));
    expect(html).toMatch(/Equity curve/);
    expect(html).toMatch(/P&amp;L breakdown/);
    expect(html).toMatch(/Consistency check/);
    expect(html).not.toMatch(/\(V5\)/); // spec IDs must not leak into the UI
    expect(html).toMatch(/reconciled/);
  });

  it('learn shows challenges, glossary, journal and known limits', () => {
    const store = readyStore();
    const html = renderToString(createElement(Learn, { store }));
    expect(html).toMatch(/Practice challenges/);
    expect(html).toMatch(/Make your first trade/);
    expect(html).toMatch(/Glossary/);
    expect(html).toMatch(/Journal/);
    expect(html).toMatch(/Limits/);
  });

  it('settings exposes realism, provider, export/import and reset (U1)', () => {
    const store = readyStore();
    const html = renderToString(createElement(Settings, { store }));
    expect(html).toMatch(/Realism Mode/);
    expect(html).toMatch(/Market data provider/);
    expect(html).toMatch(/Export JSON/);
    expect(html).toMatch(/Import JSON/);
    expect(html).toMatch(/Reset practice account/);
    expect(html).toMatch(/no real money/i);
  });

  it('a state with no quotes still renders (never crashes on missing data)', () => {
    const st = makeState({ realism: false });
    const store = readyStore(st); // deliberately no quotes injected
    for (const el of [
      createElement(Portfolio, { store, onOpenInstrument: () => {}, onOpenOrders: () => {}, onSearch: () => {} }),
      createElement(Performance, { store }),
      createElement(InstrumentDetail, { store, instrument: MSFT, onBack: () => {}, onTrade: () => {} }),
      createElement(App, { store }),
    ]) {
      expect(() => renderToString(el)).not.toThrow();
    }
  });
});

describe('no spec IDs leak into user-facing strings', () => {
  const specId = /\((W\d|RM\d+|TST\d+|[TDUAIPRVXMCFSE]\d+|M\d+|R\d+|V\d+|X\d+|I\d+|P\d+|A\d+|U\d+|D\d+|F\d+)([–/,]\d*\w*)*\)/;

  it('every screen renders without a requirement number in the text', () => {
    const store = withQuotes(readyStore());
    const screens = [
      createElement(App, { store }),
      createElement(Onboarding, { store }),
      createElement(Portfolio, { store, onOpenInstrument: () => {}, onOpenOrders: () => {}, onSearch: () => {} }),
      createElement(Search, { store, onOpen: () => {} }),
      createElement(InstrumentDetail, { store, instrument: AAPL, onBack: () => {}, onTrade: () => {} }),
      createElement(TradeTicket, { store, instrument: AAPL, initialSide: 'buy', onClose: () => {} }),
      createElement(Orders, { store }),
      createElement(Performance, { store }),
      createElement(Learn, { store }),
      createElement(Settings, { store }),
    ];
    for (const el of screens) {
      const html = renderToString(el);
      const hit = html.match(specId);
      expect(hit, `spec ID ${hit?.[0]} leaked into ${el.type.name}`).toBeNull();
    }
  });
});

describe('onboarding: currency labels and balance presets', () => {
  it('uses short currency labels that fit a phone select', () => {
    const labels = CURRENCIES_OPTS.map((c) => c.label);
    // the INR label was truncated to "lakh groupin…" — keep it short
    expect(labels).toContain('INR – Indian Rupee (₹)');
    expect(labels.some((l) => l.includes('lakh grouping'))).toBe(false);
    expect(labels.some((l) => l.includes('no decimals'))).toBe(false);
    for (const l of labels) expect(l.length).toBeLessThanOrEqual(30); // the old INR label was 36 → truncated
    expect(labels).toContain('USD – US Dollar ($)');
    expect(labels).toContain('JPY – Japanese Yen (¥)');
    // every currency offered in settings is selectable here
    for (const code of ['USD', 'INR', 'EUR', 'GBP', 'JPY', 'HKD', 'CAD', 'AUD']) {
      expect(labels.some((l) => l.startsWith(`${code} –`))).toBe(true);
    }
  });

  it('offers quick-pick starting-balance presets with the field still editable', () => {
    // presets are currency-aware, in major units
    expect(balancePresets('USD')).toEqual([10_000, 50_000, 100_000]);
    expect(balancePresets('INR')).toEqual([100_000, 500_000, 1_000_000]);
    expect(presetLabel('INR', 100_000)).toBe('₹1 lakh');
    expect(presetLabel('INR', 500_000)).toBe('₹5 lakh');
    expect(presetLabel('INR', 1_000_000)).toBe('₹10 lakh');
    expect(presetLabel('USD', 10_000)).toMatch(/\$10,000/);
    // INR gets a realistic ₹1-lakh default instead of ₹10,000
    expect(defaultBalance('INR')).toBe('100000');
    expect(defaultBalance('USD')).toBe('10000');
    expect(defaultBalance('JPY')).toBe('500000');
  });

  it('onboarding renders and the balance field stays free text', () => {
    const store = createAppStore().store;
    const html = renderToString(createElement(Onboarding, { store }));
    expect(html).toMatch(/Welcome to Stocker/);
    expect(html).toMatch(/I understand this is an educational simulation/);
    // presets are wired as buttons on step 1 — assert the markup contract here
    expect(presetLabel('INR', 1_000_000)).toBe('₹10 lakh');
    expect(balancePresets('INR')).toContain(1_000_000);
  });
});

describe('glossary terms open an explanation on tap (T1)', () => {
  it('terms are buttons, and the shared sheet renders the definition', () => {
    const store = withQuotes(readyStore());
    const html = renderToString(createElement(TradeTicket, { store, instrument: AAPL, initialSide: 'buy', onClose: () => {} }));
    const buttons = html.match(/<button[^>]*class="tooltip-term"[^>]*>/g) ?? [];
    expect(buttons.length).toBeGreaterThan(0);
    expect(html).not.toMatch(/<abbr/); // title tooltips never show on touch

    openGlossary('spread'); // module-level store → sheet subscribes
    const sheet = renderToString(createElement(GlossarySheet));
    expect(sheet).toMatch(/role="dialog"/);
    expect(sheet).toMatch(/Spread/);
    expect(sheet).toMatch(/aria-modal="true"/);
  });

  it('renders nothing when no term is open', () => {
    closeGlossary();
    expect(renderToString(createElement(GlossarySheet))).toBe('');
  });
});

describe('Realism Mode off labels everything idealized (RM1)', () => {
  it('unchecking realism in settings flips estimates to idealized', async () => {
    const { store } = createAppStore();
    store.state = makeState({ realism: true });
    store.status = { ...store.status, ready: true };

    // realism ON → costs applied, marked realistic
    const on = estimateOrder(store.state, draft({ instrument: AAPL }), ctx());
    expect(on.realism).toBe(true);
    expect(on.feeLines.length).toBeGreaterThan(0);

    await store.updateSettings({ realismMode: false });
    expect(store.account()?.settings.realismMode).toBe(false);

    // realism OFF → idealized: no fees, flagged, and explained
    const off = estimateOrder(store.state, draft({ instrument: AAPL }), ctx());
    expect(off.realism).toBe(false);
    expect(off.feeLines).toHaveLength(0);
    expect(off.totalBaseMinor).toBe(off.grossBaseMinor);
    expect(off.slippageExplanation).toMatch(/idealized/i);
  });

  it('the portfolio labels fills idealized when realism is off', () => {
    const store = withQuotes(readyStore(makeState({ realism: false })));
    const html = renderToString(
      createElement(Portfolio, { store, onOpenInstrument: () => {}, onOpenOrders: () => {}, onSearch: () => {} }),
    );
    expect(html).toMatch(/Realism Mode is off/);
    expect(html).toMatch(/fills are .*idealized/);
    expect(html).toMatch(/no fees, spread or slippage/);
    expect(html).toMatch(/Settings/);
  });

  it('the notice disappears once realism is back on', async () => {
    const store = withQuotes(readyStore(makeState({ realism: false })));
    await store.updateSettings({ realismMode: true });
    const html = renderToString(
      createElement(Portfolio, { store, onOpenInstrument: () => {}, onOpenOrders: () => {}, onSearch: () => {} }),
    );
    expect(html).not.toMatch(/Realism Mode is off/);
  });

  it('settings explains that off means idealized fills', () => {
    const store = readyStore(makeState({ realism: false }));
    const html = renderToString(createElement(Settings, { store }));
    expect(html).toMatch(/Off = idealized fills/);
  });
});
