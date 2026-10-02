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
import { Onboarding } from '../src/ui/onboarding';
import { Portfolio } from '../src/ui/portfolio';
import { Search } from '../src/ui/search';
import { InstrumentDetail } from '../src/ui/instrument';
import { TradeTicket } from '../src/ui/ticket';
import { Orders } from '../src/ui/orders';
import { Performance } from '../src/ui/performance';
import { Learn } from '../src/ui/learn';
import { Settings } from '../src/ui/settings';
import { createAppStore, type AppStore } from '../src/state/store';
import type { QuoteOut } from '../src/data/marketdata';
import type { QuoteData } from '../src/engine/engine';
import { closeDatabase } from '../src/storage/idb';
import { AAPL, MSFT, makeState, quote } from './helpers';

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

  it('performance shows the equity curve and the V5 identity', () => {
    const store = withQuotes(readyStore());
    const html = renderToString(createElement(Performance, { store }));
    expect(html).toMatch(/Equity curve/);
    expect(html).toMatch(/P&amp;L breakdown/);
    expect(html).toMatch(/Consistency check \(V5\)/);
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
