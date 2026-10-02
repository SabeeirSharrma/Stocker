/** Screen 7 — Performance (spec §7.7): equity curve vs benchmark (T4), full
 *  P&L breakdown, per-position attribution, and the V5 identity on display. */

import { useEffect, useMemo, useState } from 'react';
import type { AppStore } from '../state/store';
import { instrumentId, type Candle, type Instrument } from '../engine/types';
import { Freshness, LineChart, Money, Percent, Pnl, SimulatedBadge, Term, TopBar, num, useStore } from './common';

export function Performance({ store }: { store: AppStore }) {
  useStore(store);
  const base = store.baseCurrency();
  const acct = store.account();
  const now = new Date();
  const v = store.valuation(now);
  const rec = store.reconcileNow();

  const [benchCandles, setBenchCandles] = useState<Candle[] | null>(null);
  const [benchStatus, setBenchStatus] = useState<'loading' | 'ok' | 'none'>('loading');

  const snaps = store.state.snapshots;
  const benchKey = acct?.settings.benchmark ?? { symbol: 'SPY', exchange: 'NASDAQ' };

  useEffect(() => {
    if (snaps.length < 2) {
      setBenchStatus('none');
      return;
    }
    let alive = true;
    const from = new Date(`${snaps[0].date}T00:00:00.000Z`);
    const benchInstrument: Instrument = {
      symbol: benchKey.symbol,
      exchange: benchKey.exchange,
      name: benchKey.symbol,
      currency: 'USD', // only used for display of native values; the ratio math below cancels it
      assetType: 'etf',
    };
    setBenchStatus('loading');
    void store.candlesFor(benchInstrument, from, now).then((c) => {
      if (!alive) return;
      setBenchCandles(c);
      setBenchStatus(c && c.length > 1 ? 'ok' : 'none');
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, snaps.length, benchKey.symbol, benchKey.exchange]);

  const { series, benchmark } = useMemo(() => {
    const s = snaps.map((x) => ({ x: x.date.slice(5), y: x.totalValueMinor }));
    let b: { x: string; y: number }[] = [];
    if (benchCandles && benchCandles.length > 1 && snaps.length > 0) {
      const byDate = new Map(benchCandles.map((c) => [c.sessionDate, c.closeMinor]));
      // anchor both series at the first date we have for each, then scale the
      // benchmark to the portfolio's starting value (ratio → currency-agnostic)
      let baseDate: string | null = null;
      for (const snap of snaps) {
        if (byDate.has(snap.date)) {
          baseDate = snap.date;
          break;
        }
      }
      if (baseDate) {
        const benchBase = byDate.get(baseDate)!;
        const portBase = snaps.find((x) => x.date === baseDate)!.totalValueMinor;
        b = snaps
          .filter((x) => x.date >= baseDate && byDate.has(x.date))
          .map((x) => ({ x: x.date.slice(5), y: Math.round((portBase * byDate.get(x.date)!) / benchBase) }));
      }
    }
    return { series: s, benchmark: b.length > 1 ? b : undefined };
  }, [snaps, benchCandles]);

  const dayChange = v.rows.reduce((s, r) => s + (r.dayChangeMinor ?? 0), 0);
  const unrealPct = v.positionsValueMinor > 0 ? v.unrealizedMinor / v.positionsValueMinor : 0;

  return (
    <>
      <TopBar title="Performance" right={<SimulatedBadge />} />
      <main className="app-main">
        <div className="card">
          <div className="row between">
            <h2 style={{ margin: 0 }}>Equity curve</h2>
            <Freshness atUtc={v.asOfUtc} stale={v.missingPrices.length > 0} />
          </div>
          <LineChart
            series={series}
            benchmark={benchmark}
            ariaLabel="Portfolio value by session versus benchmark"
            formatY={(y) => num(Math.round(y / 100))}
          />
          <div className="chart-legend" style={{ marginTop: 6 }}>
            <span>
              <span className="swatch" style={{ background: 'var(--accent)' }} /> Your portfolio ({base})
            </span>
            <span>
              <span className="swatch" style={{ background: 'var(--warn)' }} /> {benchKey.symbol} buy-and-hold
            </span>
          </div>
          <div className="tiny dim" style={{ marginTop: 6 }}>
            {benchStatus === 'loading' && 'Loading benchmark…'}
            {benchStatus === 'none' && `Benchmark (${benchKey.symbol}) data unavailable — showing your portfolio only. Nothing is guessed.`}
            {benchStatus === 'ok' &&
              'Both curves start at the same value so you compare growth, not size. Cached daily closes — not a live feed.'}
          </div>
        </div>

        <div className="card">
          <h2>P&amp;L breakdown</h2>
          <div className="kv">
            <span className="k">Starting balance</span>
            <span className="v"><Money minor={acct?.startingBalanceMinor ?? 0} currency={base} /></span>
          </div>
          <div className="kv">
            <span className="k">Realized (gross, <Term id="realized">realized</Term>)</span>
            <span className="v"><Pnl minor={v.realizedGrossMinor} currency={base} /></span>
          </div>
          <div className="kv">
            <span className="k">Unrealized (open)</span>
            <span className="v"><Pnl minor={v.unrealizedMinor} currency={base} /> {v.positionsValueMinor > 0 && <Percent value={unrealPct} />}</span>
          </div>
          <div className="kv">
            <span className="k">Fees paid</span>
            <span className="v"><Money minor={-v.feesMinor} currency={base} signed /></span>
          </div>
          <div className="kv">
            <span className="k">Tax (estimated, withheld)</span>
            <span className="v"><Money minor={-v.taxMinor} currency={base} signed /></span>
          </div>
          <div className="kv">
            <span className="k">Dividends</span>
            <span className="v"><Money minor={v.dividendsMinor} currency={base} signed /></span>
          </div>
          <div className="kv">
            <span className="k">Day change</span>
            <span className="v"><Pnl minor={dayChange} currency={base} /></span>
          </div>
          <div className="kv">
            <span className="k"><strong>Total value</strong></span>
            <span className="v value"><Money minor={v.totalValueMinor} currency={base} /></span>
          </div>
          <p className="tiny dim" style={{ marginBottom: 0 }}>
            Tax figures are estimates from the configured model — the app is not a tax authority.
          </p>
        </div>

        <div className="card">
          <h2>By position</h2>
          {v.rows.length === 0 ? (
            <div className="empty small">No positions yet.</div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="hist">
                <thead>
                  <tr>
                    <th>Instrument</th>
                    <th className="num">Value</th>
                    <th className="num">Open P&amp;L</th>
                    <th className="num">Realized</th>
                    <th className="num">Return</th>
                  </tr>
                </thead>
                <tbody>
                  {v.rows.map((r) => {
                    const pos = store.state.positions.find(
                      (p) => instrumentId(p.instrument) === instrumentId(r.instrument),
                    );
                    const realized = pos?.realizedGrossBaseMinor ?? 0;
                    const total = realized + r.unrealizedMinor;
                    const ret = r.costBaseMinor > 0 ? total / r.costBaseMinor : 0;
                    return (
                      <tr key={instrumentId(r.instrument)}>
                        <td>
                          <strong>{r.instrument.symbol}</strong> <span className="badge">{r.instrument.exchange}</span>
                          <div className="tiny dim">{num(r.qty)} sh · {r.instrument.currency}</div>
                        </td>
                        <td className="num"><Money minor={r.valueBaseMinor} currency={base} /></td>
                        <td className="num"><Pnl minor={r.unrealizedMinor} currency={base} /></td>
                        <td className="num"><Pnl minor={realized} currency={base} /></td>
                        <td className="num"><Percent value={ret} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {v.rows.some((r) => r.flags.length > 0) && (
            <div className="tiny dim" style={{ marginTop: 8 }}>
              ⚠ Flags present: {v.rows.flatMap((r) => r.flags).filter((f, i, a) => a.indexOf(f) === i).join(', ')} —
              returns may exclude unverified dividends/splits.
            </div>
          )}
          {v.missingPrices.length > 0 && (
            <div className="notice warn small" style={{ marginTop: 8 }}>
              Missing prices: {v.missingPrices.join(', ')} — valued at 0, never fabricated.
            </div>
          )}
        </div>

        <div className="card">
          <h2>Consistency check</h2>
          {rec ? (
            <>
              <div className="kv">
                <span className="k">starting + realized + unrealized − fees + dividends − tax</span>
                <span className="v"><Money minor={rec.expectedMinor} currency={base} /></span>
              </div>
              <div className="kv">
                <span className="k">actual total value</span>
                <span className="v"><Money minor={rec.actualMinor} currency={base} /></span>
              </div>
              <div className="kv">
                <span className="k">difference</span>
                <span className="v">
                  {rec.diffMinor === 0 ? (
                    <span className="badge ok">✓ reconciled</span>
                  ) : (
                    <span className="badge warn">✗ {rec.diffMinor} {base}</span>
                  )}
                </span>
              </div>
              {rec.missingPrices.length > 0 && (
                <div className="tiny dim">Missing prices: {rec.missingPrices.join(', ')}</div>
              )}
            </>
          ) : (
            <div className="empty small">No account yet.</div>
          )}
          <div className="tiny dim" style={{ marginTop: 6 }}>
            Your cash, positions and P&amp;L always satisfy this identity — if a number ever looks wrong, this line is
            how you check it.
          </div>
        </div>
      </main>
    </> 
  );
}
