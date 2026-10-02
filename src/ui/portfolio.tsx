/** Screen 2 — Home / Portfolio (spec §7.2, U2–U4, X2/X3 flags). */

import { useEffect, useMemo, useState } from 'react';
import type { AppStore } from '../state/store';
import { instrumentId, type Instrument } from '../engine/types';
import { marketStatus } from '../calendar/calendar';
import { openOrders } from '../engine/engine';
import { concentrationWarnings } from '../teaching/feedback';
import { Freshness, LineChart, Money, Percent, Pnl, SimulatedBadge, TopBar, num, useStore } from './common';

export function Portfolio({
  store,
  onOpenInstrument,
  onOpenOrders,
  onSearch,
}: {
  store: AppStore;
  onOpenInstrument: (i: Instrument) => void;
  onOpenOrders: () => void;
  onSearch: () => void;
}) {
  useStore(store);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    void store.refreshRelevant();
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, [store]);

  const acct = store.account();
  const base = store.baseCurrency();
  const v = store.valuation(now);
  const display = store.toDisplay(v.totalValueMinor);
  const dayChange = v.rows.reduce((s, r) => s + (r.dayChangeMinor ?? 0), 0);
  const totalCost = v.rows.reduce((s, r) => s + r.costBaseMinor, 0);
  const overallPnl = v.realizedGrossMinor + v.unrealizedMinor;
  const pending = openOrders(store.state);
  const warnings = concentrationWarnings(v);
  const st = acct ? marketStatus(now, 'US') : null;

  const valueSeries = useMemo(
    () =>
      store.state.snapshots.map((s) => ({
        x: s.date.slice(5),
        y: display.currency === base ? s.totalValueMinor : s.totalValueMinor,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store.state.snapshots.length],
  );

  return (
    <>
      <TopBar
        title="Portfolio"
        right={<SimulatedBadge />}
      />
      <main className="app-main">
        {!acct && <div className="notice error">No account — finish onboarding first.</div>}

        <div className="card">
          <div className="row between">
            <h2 style={{ margin: 0 }}>Total value</h2>
            <Freshness atUtc={v.asOfUtc} stale={v.missingPrices.length > 0} />
          </div>
          <div className="big-value">
            <Money minor={display.minor} currency={display.currency} />
          </div>
          <div className="row wrap" style={{ gap: 14, marginTop: 6 }}>
            <span className="small">
              Day <Pnl minor={dayChange} currency={base} />
            </span>
            <span className="small">
              All-time <Pnl minor={overallPnl} currency={base} />
            </span>
            <span className="badge" title="Realized + unrealized, before estimated taxes">
              realized <Money minor={v.realizedGrossMinor} currency={base} signed />
            </span>
          </div>

          <div className="kv" style={{ marginTop: 10 }}>
            <span className="k">Cash</span>
            <span className="v"><Money minor={v.cashMinor} currency={base} /></span>
          </div>
          <div className="kv">
            <span className="k">
              Pending settlement <span className="tiny dim">(T+1 · RM5)</span>
            </span>
            <span className="v">{v.unsettledMinor > 0 ? <Money minor={v.unsettledMinor} currency={base} /> : '—'}</span>
          </div>
          <div className="kv">
            <span className="k">Invested</span>
            <span className="v"><Money minor={v.positionsValueMinor} currency={base} /> of <Money minor={totalCost} currency={base} /> cost</span>
          </div>
          <div className="kv">
            <span className="k">Fees paid</span>
            <span className="v"><Money minor={v.feesMinor} currency={base} /></span>
          </div>
          {v.dividendsMinor > 0 && (
            <div className="kv">
              <span className="k">Dividends</span>
              <span className="v"><Money minor={v.dividendsMinor} currency={base} /></span>
            </div>
          )}
        </div>

        {st && (
          <div className="notice info small">
            US market is <strong>{st.isOpenNow ? 'open' : 'closed'}</strong> — session {st.sessionDate}. Orders placed while closed queue for the next open (M3/R2).
          </div>
        )}

        {pending.length > 0 && (
          <button className="item card" onClick={onOpenOrders} style={{ width: '100%' }}>
            <span className="grow">
              <span className="sym">{pending.length} open order{pending.length > 1 ? 's' : ''}</span>
              <div className="tiny dim">Queued, waiting for data, or waiting for the price condition.</div>
            </span>
            <span aria-hidden="true">›</span>
          </button>
        )}

        {warnings.map((w) => (
          <div className="notice warn small" key={w}>{w}</div>
        ))}

        <div className="card">
          <h2>Value over time</h2>
          <LineChart series={valueSeries} ariaLabel="Portfolio value by session" formatY={(y) => `${(y / 100).toFixed(0)}`} />
          <div className="tiny dim" style={{ marginTop: 6 }}>
            Reconstructed daily from your fills and market closes (R1). Missing days are skipped, never guessed.
          </div>
        </div>

        <div className="card">
          <div className="row between">
            <h2 style={{ margin: 0 }}>Positions</h2>
            <button className="btn small" onClick={onSearch} style={{ minHeight: 36, padding: '6px 12px' }}>+ Find instrument</button>
          </div>

          {v.rows.length === 0 ? (
            <div className="empty">
              No positions yet.
              <div style={{ marginTop: 10 }}>
                <button className="btn primary" onClick={onSearch}>Search for your first instrument</button>
              </div>
            </div>
          ) : (
            <div className="list">
              {v.rows.map((row) => {
                const id = instrumentId(row.instrument);
                const q = store.quotes.get(id);
                const unreal = row.unrealizedMinor;
                return (
                  <button key={id} className="item" onClick={() => onOpenInstrument(row.instrument)}>
                    <span className="grow">
                      <span className="sym">{row.instrument.symbol}</span>{' '}
                      <span className="badge">{row.instrument.exchange}</span>
                      <div className="name">{row.instrument.name}</div>
                      <Freshness atUtc={row.priceAtUtc} stale={row.priceStale} delayed={q?.delayed} provider={q?.provider} />
                    </span>
                    <span className="right">
                      <div className="value">
                        {row.priceMinor != null ? <Money minor={row.priceMinor} currency={row.instrument.currency} /> : '—'}
                      </div>
                      <div className="small">
                        {num(row.qty)} sh · <Money minor={row.valueBaseMinor} currency={base} />
                      </div>
                      <div className="small">
                        <Pnl minor={unreal} currency={base} />
                        <span className="dim tiny"> open</span>
                      </div>
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {v.rows.some((r) => r.flags.length > 0) && (
            <div className="tiny dim" style={{ marginTop: 8 }}>
              ⚠ Some positions show flags: {v.rows.flatMap((r) => r.flags).filter((f, i, a) => a.indexOf(f) === i).join(', ')} — total return may exclude dividends (X3).
            </div>
          )}
          {v.missingPrices.length > 0 && (
            <div className="notice warn small" style={{ marginTop: 8 }}>
              Missing prices for {v.missingPrices.join(', ')} — valued at 0 until data is available, never fabricated (X4).
            </div>
          )}
        </div>

        <div className="card small dim">
          <div className="row between">
            <span>Overall P&amp;L (realized + unrealized)</span>
            <strong><Pnl minor={overallPnl} currency={base} /></strong>
          </div>
          {v.positionsValueMinor > 0 && (
            <div className="row between" style={{ marginTop: 4 }}>
              <span>Return on invested cost</span>
              <Percent value={totalCost > 0 ? v.unrealizedMinor / totalCost : 0} />
            </div>
          )}
          <div className="tiny" style={{ marginTop: 6 }}>Educational observations only — not advice.</div>
        </div>
      </main>
    </>
  );
}
