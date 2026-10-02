/**
 * App shell: navigation (tabs + stacked instrument screen + ticket modal),
 * onboarding gate, error/offline banners (A2), challenge toasts (T2) and the
 * always-visible simulated-data labelling (D3).
 */

import { useEffect, useState } from 'react';
import type { AppStore } from './state/store';
import type { Instrument, Side } from './engine/types';
import { Onboarding } from './ui/onboarding';
import { Portfolio } from './ui/portfolio';
import { Search } from './ui/search';
import { InstrumentDetail } from './ui/instrument';
import { TradeTicket } from './ui/ticket';
import { Orders } from './ui/orders';
import { Performance } from './ui/performance';
import { Learn } from './ui/learn';
import { Settings } from './ui/settings';
import { BottomNav, GlossarySheet, type Tab, useStore } from './ui/common';
import { DISCLAIMER_SHORT } from './teaching/content';

export function App({ store }: { store: AppStore }) {
  useStore(store);

  const [tab, setTab] = useState<Tab>('home');
  const [detail, setDetail] = useState<Instrument | null>(null);
  const [ticket, setTicket] = useState<{ instrument: Instrument; side: Side } | null>(null);
  const [toast, setToast] = useState<string[]>([]);
  const [orderNotice, setOrderNotice] = useState<string | null>(null);

  // fire completed challenges as toasts (T2)
  useEffect(() => {
    const done = store.takeCompletedChallenges();
    if (done.length > 0) {
      setToast((t) => [...t, ...done.map((c) => `Challenge complete: ${c.title}`)]);
      const timer = setTimeout(() => setToast((t) => t.slice(done.length)), 6000);
      return () => clearTimeout(timer);
    }
  });

  // queued-order notice auto-dismiss
  useEffect(() => {
    if (!orderNotice) return;
    const t = setTimeout(() => setOrderNotice(null), 4000);
    return () => clearTimeout(t);
  }, [orderNotice]);

  if (!store.status.ready) {
    return (
      <div className="app">
        <main className="app-main center">
          <div className="empty">Loading your practice account…</div>
        </main>
      </div>
    );
  }

  if (!store.state.account || !store.state.meta.disclaimerAckAtUtc) {
    return (
      <>
        <Onboarding store={store} />
        <GlossarySheet />
      </>
    );
  }

  function goTab(t: Tab) {
    setDetail(null);
    setTab(t);
  }

  const status = store.status;

  return (
    <div className="app">
      {status.error && (
        <div className="notice error" role="alert" style={{ margin: '10px 16px 0' }}>
          <div className="row between">
            <strong>{status.error.title}</strong>
            <button className="btn ghost" style={{ minHeight: 32 }} onClick={() => store.clearStatusError()} aria-label="Dismiss">
              ✕
            </button>
          </div>
          <div className="small">{status.error.guidance}</div>
        </div>
      )}

      {status.offline && (
        <div className="notice warn small" style={{ margin: '10px 16px 0' }} role="status">
          Offline — showing cached data, clearly marked when stale. Your orders and history remain available.
        </div>
      )}

      {status.reconRunning && (
        <div className="notice info small" style={{ margin: '10px 16px 0' }} role="status">
          Reconstructing your history from market data… your snapshots stay consistent while it runs.
        </div>
      )}

      {orderNotice && (
        <div className="notice info small" style={{ margin: '10px 16px 0' }} role="status">
          {orderNotice}
        </div>
      )}

      {detail ? (
        <InstrumentDetail
          store={store}
          instrument={detail}
          onBack={() => setDetail(null)}
          onTrade={(side) => setTicket({ instrument: detail, side })}
        />
      ) : tab === 'home' ? (
        <Portfolio
          store={store}
          onOpenInstrument={setDetail}
          onOpenOrders={() => goTab('orders')}
          onSearch={() => goTab('search')}
        />
      ) : tab === 'search' ? (
        <Search store={store} onOpen={setDetail} />
      ) : tab === 'orders' ? (
        <Orders store={store} onOpenOrdersNotice={setOrderNotice} />
      ) : tab === 'perf' ? (
        <Performance store={store} />
      ) : tab === 'learn' ? (
        <Learn store={store} />
      ) : (
        <Settings store={store} />
      )}

      <BottomNav tab={tab} onTab={goTab} />

      {ticket && (
        <TradeTicket
          store={store}
          instrument={ticket.instrument}
          initialSide={ticket.side}
          onClose={() => setTicket(null)}
        />
      )}

      {toast.length > 0 && (
        <div style={{ position: 'fixed', bottom: 76, left: '50%', transform: 'translateX(-50%)', zIndex: 50, width: 'min(92%, 480px)' }}>
          {toast.map((t) => (
            <div className="notice info" key={t} role="status" style={{ marginBottom: 6 }}>
              🎯 {t}
            </div>
          ))}
        </div>
      )}

      <div className="tiny dim center" style={{ padding: '4px 16px 8px' }}>{DISCLAIMER_SHORT}</div>

      <GlossarySheet />
    </div>
  );
}
