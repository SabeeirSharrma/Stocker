/** Screen 6 — Orders & history (spec §7.6): open/queued orders with reasons
 *  and cancel (U1), fill history with itemised fees, dividend events. */

import { useState } from 'react';
import type { AppStore } from '../state/store';
import { openOrders } from '../engine/engine';
import { instrumentId, type Order } from '../engine/types';
import { Freshness, Money, TopBar, num, useStore } from './common';

const STATUS_LABEL: Record<Order['status'], string> = {
  queued: 'queued',
  filled: 'filled',
  rejected: 'rejected',
  cancelled: 'cancelled',
  expired: 'expired',
  waiting_data: 'waiting for data',
};

export function Orders({ store, onOpenOrdersNotice }: { store: AppStore; onOpenOrdersNotice?: (m: string) => void }) {
  useStore(store);
  const base = store.baseCurrency();
  const [tab, setTab] = useState<'open' | 'history' | 'fills'>('open');

  const open = openOrders(store.state);
  const history = store.state.orders.filter((o) => o.status !== 'queued' && o.status !== 'waiting_data');
  const fills = [...store.state.fills].sort((a, b) => b.timestampUtc.localeCompare(a.timestampUtc));
  const events = store.state.cashEvents;

  return (
    <>
      <TopBar
        title="Orders"
        right={open.length > 0 ? <span className="badge warn">{open.length} open</span> : undefined}
      />
      <main className="app-main">
        <div className="seg" role="group" aria-label="Order view" style={{ marginBottom: 12 }}>
          <button type="button" aria-pressed={tab === 'open'} onClick={() => setTab('open')}>
            Open ({open.length})
          </button>
          <button type="button" aria-pressed={tab === 'history'} onClick={() => setTab('history')}>
            History ({history.length})
          </button>
          <button type="button" aria-pressed={tab === 'fills'} onClick={() => setTab('fills')}>
            Fills ({fills.length})
          </button>
        </div>

        {tab === 'open' && (
          <div className="card">
            <h2>Open orders</h2>
            {open.length === 0 ? (
              <div className="empty small">
                Nothing pending. Orders appear here while they are queued for the next session, waiting for a price
                trigger, or waiting for data.
              </div>
            ) : (
              <div className="list">
                {open.map((o) => (
                  <div key={o.id} className="item" style={{ cursor: 'default' }}>
                    <span className="grow">
                      <span className="sym">{o.side === 'buy' ? 'BUY' : 'SELL'} {num(o.qty)}</span>{' '}
                      <span className="sym">{o.instrument.symbol}</span>{' '}
                      <span className="badge">{o.type}</span>{' '}
                      <span className="badge">{STATUS_LABEL[o.status]}</span>
                      <div className="name">
                        {o.type !== 'market' && (
                          <>
                            @ <Money minor={o.limitPriceMinor ?? o.stopPriceMinor ?? o.stopLimitPriceMinor ?? 0} currency={o.instrument.currency} /> ·{' '}
                          </>
                        )}
                        {o.duration.toUpperCase()} · placed {new Date(o.createdAtUtc).toLocaleString()}
                      </div>
                      {o.waitingReason && <div className="tiny dim">{o.waitingReason}</div>}
                      {o.reason && <div className="tiny dim">{o.reason}</div>}
                      {o.note && <div className="tiny dim">note: “{o.note}”</div>}
                    </span>
                    <button
                      className="btn danger"
                      style={{ minHeight: 40 }}
                      onClick={() => {
                        store.cancelOrder(o.id);
                        onOpenOrdersNotice?.('Order cancelled.');
                      }}
                      aria-label={`Cancel order for ${o.instrument.symbol}`}
                    >
                      Cancel
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === 'history' && (
          <div className="card">
            <h2>Order history</h2>
            {history.length === 0 ? (
              <div className="empty small">No closed orders yet.</div>
            ) : (
              <div className="list">
                {[...history]
                  .sort((a, b) => b.createdAtUtc.localeCompare(a.createdAtUtc))
                  .map((o) => (
                    <div key={o.id} className="item" style={{ cursor: 'default' }}>
                      <span className="grow">
                        <span className="sym">{o.side === 'buy' ? 'BUY' : 'SELL'} {num(o.qty)} {o.instrument.symbol}</span>{' '}
                        <span className={`badge ${o.status === 'filled' ? 'ok' : o.status === 'rejected' ? 'warn' : ''}`}>
                          {STATUS_LABEL[o.status]}
                        </span>
                        <div className="name">
                          {new Date(o.createdAtUtc).toLocaleString()} · {o.type} · {o.instrument.exchange}
                        </div>
                        {o.reason && <div className="tiny dim">{o.reason}</div>}
                      </span>
                      <span className="right small">
                        {o.estBaseMinor != null ? <Money minor={o.estBaseMinor} currency={base} /> : '—'}
                      </span>
                    </div>
                  ))}
              </div>
            )}
          </div>
        )}

        {tab === 'fills' && (
          <>
            <div className="card">
              <h2>Fills</h2>
              {fills.length === 0 ? (
                <div className="empty small">No fills yet — place your first order from an instrument screen.</div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table className="hist">
                    <thead>
                      <tr>
                        <th>When</th>
                        <th>Instrument</th>
                        <th className="num">Qty</th>
                        <th className="num">Price</th>
                        <th className="num">Fees</th>
                        <th className="num">Net</th>
                      </tr>
                    </thead>
                    <tbody>
                      {fills.map((f) => (
                        <tr key={f.id}>
                          <td className="tiny">{new Date(f.timestampUtc).toLocaleDateString()}<div className="tiny dim">{new Date(f.timestampUtc).toLocaleTimeString()}</div></td>
                          <td>
                            <strong>{f.instrument.symbol}</strong> <span className="badge">{f.instrument.exchange}</span>
                            <div className="tiny dim">{f.side} · {f.realism ? 'realistic' : 'idealized'}</div>
                          </td>
                          <td className="num">{num(f.qty)}</td>
                          <td className="num">
                            <Money minor={f.nativePriceMinor} currency={f.nativeCurrency} />
                            <div className="tiny dim">
                              {f.spreadBpsApplied > 0 && `+${f.spreadBpsApplied}bp spr `}
                              {f.slippageBpsApplied > 0 && `+${f.slippageBpsApplied}bp slip`}
                            </div>
                          </td>
                          <td className="num">
                            <Money minor={f.feesMinor} currency={base} />
                            {f.feeLines.map((l) => (
                              <div key={l.id} className="tiny dim">{l.label}</div>
                            ))}
                          </td>
                          <td className="num">
                            <Money
                              minor={f.side === 'buy' ? -f.baseDebitedMinor : f.baseCreditedMinor}
                              currency={base}
                              signed
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="card">
              <h2>Cash events</h2>
              {events.length === 0 ? (
                <div className="empty small">
                  No dividends or other cash events yet. They are credited when the provider reports them —
                  otherwise the position is flagged instead of guessed.
                </div>
              ) : (
                <div className="list">
                  {events.map((e) => (
                    <div key={e.id} className="item" style={{ cursor: 'default' }}>
                      <span className="grow">
                        <span className="sym">Dividend {e.instrument.symbol}</span>
                        <div className="name">
                          {new Date(e.paidAtUtc).toLocaleDateString()} · {num(e.qty)} sh ×{' '}
                          <Money minor={e.nativeAmountMinor} currency={e.instrument.currency} />
                        </div>
                      </span>
                      <span className="up value">
                        +<Money minor={e.amountMinor} currency={base} />
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        <div className="card small dim">
          <div className="row between">
            <span>Provider / data freshness</span>
            <Freshness atUtc={latestQuoteAt(store)} stale={store.status.offline} provider={store.providerId()} />
          </div>
          {store.status.reconRunning && <div className="tiny">Reconstruction is running in the background…</div>}
        </div>
      </main>
    </>
  );
}

function latestQuoteAt(store: AppStore): string | null {
  let latest: string | null = null;
  for (const q of store.quotes.values()) {
    if (!latest || q.atUtc > latest) latest = q.atUtc;
  }
  return latest;
}

/** Exposed for the position list: the exchange label of a held instrument. */
export function exchangeLabel(store: AppStore, key: { symbol: string; exchange: string }): string {
  const p = store.state.positions.find((x) => instrumentId(x.instrument) === instrumentId(key));
  return p ? p.instrument.exchange : key.exchange;
}
