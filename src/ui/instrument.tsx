/** Screen 4 — Instrument detail (spec §7.4, I3 read-only indices, U2 freshness,
 *  T1 glossary tooltips, T4 chart with range selector). */

import { useCallback, useEffect, useState } from 'react';
import type { AppStore } from '../state/store';
import { instrumentId, type Candle, type Instrument, type Side } from '../engine/types';
import { marketStatus } from '../calendar/calendar';
import { DISCLAIMER_SHORT } from '../teaching/content';
import {
  Freshness, LineChart, Money, Pnl, SimulatedBadge, Term, TopBar, num, useStore,
} from './common';

type Range = '1M' | '3M' | '6M' | '1Y';
const RANGE_DAYS: Record<Range, number> = { '1M': 31, '3M': 92, '6M': 183, '1Y': 366 };

export function InstrumentDetail({
  store,
  instrument,
  onBack,
  onTrade,
}: {
  store: AppStore;
  instrument: Instrument;
  onBack: () => void;
  onTrade: (side: Side) => void;
}) {
  useStore(store);
  const [range, setRange] = useState<Range>('3M');
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<{ bidAsk?: [number, number]; avgDailyVolume: number | null }>({ avgDailyVolume: null });

  const id = instrumentId(instrument);
  const base = store.baseCurrency();
  const now = new Date();
  const st = marketStatus(now, instrument.exchange);
  const quote = store.quotes.get(id) ?? null;
  const fx = store.fx.get(instrument.currency) ?? null;
  const held = store.state.positions.find(
    (p) => p.instrument.symbol === instrument.symbol && p.instrument.exchange === instrument.exchange,
  );

  // keep the store refreshing this instrument while the screen is open (C3)
  useEffect(() => {
    store.setScreenInstruments([instrument]);
    return () => store.setScreenInstruments([]);
  }, [store, instrument]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const to = new Date();
    const from = new Date(to.getTime() - RANGE_DAYS[range] * 86_400_000);
    void store.candlesFor(instrument, from, to).then((c) => {
      if (alive) {
        setCandles(c);
        setLoading(false);
      }
    });
    return () => {
      alive = false;
    };
  }, [store, instrument, range]);

  useEffect(() => {
    let alive = true;
    void store.buildContextFor(instrument).then((ctx) => {
      if (!alive || !ctx) return;
      setStats({
        bidAsk: ctx.quote.bidMinor != null && ctx.quote.askMinor != null ? [ctx.quote.bidMinor, ctx.quote.askMinor] : undefined,
        avgDailyVolume: ctx.avgDailyVolume,
      });
      // the context fetch also warms store.quotes → re-render for freshness
      store.refreshPrices([instrument]);
    });
    return () => {
      alive = false;
    };
  }, [store, instrument]);

  const refresh = useCallback(() => {
    void store.refreshPrices([instrument]).then(() => store.evaluateOpenOrders());
  }, [store, instrument]);

  const v = store.valuation(now);
  const row = v.rows.find((r) => instrumentId(r.instrument) === id);

  const series = (candles ?? [])
    .filter((c) => c.sessionDate >= fromKey(range))
    .map((c) => ({ x: c.sessionDate.slice(5), y: c.closeMinor }));
  const bench = undefined; // benchmark overlay is drawn on the Performance screen (T4)

  return (
    <>
      <TopBar
        title={instrument.symbol}
        onBack={onBack}
        right={
          <button className="btn ghost" onClick={refresh} aria-label="Refresh price" style={{ minHeight: 40, padding: '6px 10px' }}>
            ↻
          </button>
        }
      />
      <main className="app-main">
        <div className="card">
          <div className="row between wrap">
            <div>
              <div className="big-value" style={{ fontSize: 28 }}>
                {quote ? <Money minor={quote.priceMinor} currency={instrument.currency} /> : <span className="dim">—</span>}
              </div>
              <div className="small dim">
                {instrument.name} · <span className="badge">{instrument.exchange}</span>{' '}
                <span className="badge" title="Native currency">{instrument.currency}</span>
              </div>
              {quote && instrument.currency !== base && (
                <div className="small">
                  ≈{' '}
                  <Money
                    minor={Math.round(quote.priceMinor * (fx?.rate ?? 1))}
                    currency={base}
                  />{' '}
                  <span className="dim tiny">
                    at 1 {instrument.currency} = {fx ? fx.rate.toFixed(6) : '—'} {base}{' '}
                    {fx?.stale && <span className="badge warn">stale FX</span>}
                  </span>
                </div>
              )}
            </div>
            <div className="right">
              <span className={`badge ${st.isOpenNow ? 'ok' : ''}`}>
                {st.isOpenNow ? '● open' : '● closed'}
              </span>
              <div className="tiny dim">session {st.sessionDate}</div>
              <div style={{ marginTop: 6 }}>
                <SimulatedBadge />
              </div>
            </div>
          </div>

          <div style={{ marginTop: 8 }}>
            <Freshness atUtc={quote?.atUtc ?? null} stale={quote?.stale} delayed={quote?.delayed} provider={quote?.provider} />
          </div>

          {quote?.delayed && (
            <div className="notice warn small" style={{ marginTop: 8 }}>
              This feed is delayed — the price shown is not live.
            </div>
          )}
        </div>

        {instrument.isIndex && (
          <div className="notice info small">
            <strong>Read-only reference data.</strong> Indices cannot be bought — search for a fund that tracks it instead.
          </div>
        )}

        {!st.isOpenNow && (
          <div className="notice info small">
            Market closed. Orders placed now <strong>queue for the next session</strong> and fill at that session's open.
          </div>
        )}

        <div className="card">
          <div className="row between">
            <h2 style={{ margin: 0 }}>Price history</h2>
            <div className="seg" role="group" aria-label="Chart range" style={{ width: 220 }}>
              {(['1M', '3M', '6M', '1Y'] as Range[]).map((r) => (
                <button key={r} type="button" aria-pressed={range === r} onClick={() => setRange(r)} style={{ minHeight: 34 }}>
                  {r}
                </button>
              ))}
            </div>
          </div>
          {loading ? (
            <div className="empty">Loading candles…</div>
          ) : candles && candles.length > 1 ? (
            <>
              <LineChart series={series} ariaLabel={`${instrument.symbol} closing prices, ${range}`} />
              <div className="tiny dim" style={{ marginTop: 4 }}>
                Daily closes from {candles[0].sessionDate} to {candles[candles.length - 1].sessionDate} — real sessions only,
                gaps are not interpolated.
              </div>
            </>
          ) : (
            <div className="empty small">
              No chart available yet — the provider did not return candles for this range.
            </div>
          )}
        </div>

        <div className="card">
          <h2>Key stats</h2>
          <div className="kv"><span className="k">Previous close</span><span className="v">{quote?.prevCloseMinor ? <Money minor={quote.prevCloseMinor} currency={instrument.currency} /> : '—'}</span></div>
          <div className="kv"><span className="k">Open</span><span className="v">{quote?.openMinor ? <Money minor={quote.openMinor} currency={instrument.currency} /> : '—'}</span></div>
          <div className="kv">
            <span className="k"><Term id="bid_ask">Bid / Ask</Term></span>
            <span className="v">
              {stats.bidAsk ? (
                <>
                  <Money minor={stats.bidAsk[0]} currency={instrument.currency} /> / <Money minor={stats.bidAsk[1]} currency={instrument.currency} />
                </>
              ) : '—'}
            </span>
          </div>
          <div className="kv">
            <span className="k"><Term id="volume">Volume</Term></span>
            <span className="v">{quote?.volume != null ? num(quote.volume) : '—'}</span>
          </div>
          <div className="kv">
            <span className="k">Avg daily volume (ADV)</span>
            <span className="v">{stats.avgDailyVolume != null ? num(stats.avgDailyVolume) : '—'}</span>
          </div>
          {instrument.sector && <div className="kv"><span className="k">Sector</span><span className="v">{instrument.sector}</span></div>}
          <div className="kv"><span className="k">Asset type</span><span className="v">{instrument.assetType}</span></div>
        </div>

        {row && (
          <div className="card">
            <h2>Your position</h2>
            <div className="kv"><span className="k">Quantity</span><span className="v">{num(row.qty)} sh</span></div>
            <div className="kv"><span className="k">Value</span><span className="v"><Money minor={row.valueBaseMinor} currency={base} /></span></div>
            <div className="kv"><span className="k">Cost basis (avg cost)</span><span className="v"><Money minor={row.costBaseMinor} currency={base} /></span></div>
            <div className="kv">
              <span className="k">Open P&amp;L (<Term id="unrealized">unrealized</Term>)</span>
              <span className="v"><Pnl minor={row.unrealizedMinor} currency={base} /></span>
            </div>
            {row.fxStale && <div className="notice warn small">FX rate for {instrument.currency} is stale — the value may be out of date.</div>}
          </div>
        )}

        <div className="card row" style={{ gap: 10 }}>
          <button
            className="btn buy grow"
            disabled={!!instrument.isIndex}
            onClick={() => onTrade('buy')}
            aria-label={`Buy ${instrument.symbol}`}
          >
            Buy
          </button>
          <button
            className="btn sell grow"
            disabled={!!instrument.isIndex || !held}
            onClick={() => onTrade('sell')}
            aria-label={`Sell ${instrument.symbol}`}
            title={held ? undefined : 'You hold none of this instrument'}
          >
            Sell
          </button>
        </div>

        <div className="disclaimer tiny">{DISCLAIMER_SHORT}</div>
      </main>
    </>
  );
}

function fromKey(range: Range): string {
  const d = new Date(Date.now() - RANGE_DAYS[range] * 86_400_000);
  return d.toISOString().slice(0, 10);
}
