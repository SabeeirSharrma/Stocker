/** Screen 5 — Trade ticket (spec §7.5, RM2 costs, RM3 spread/slippage, RM9
 *  position sizing, queued-order notice, T3 post-trade feedback, U4). */

import { useEffect, useMemo, useState } from 'react';
import type { AppStore, PlaceOrderOutcome } from '../state/store';
import { instrumentId, type OrderDraft, type OrderDuration, type OrderType, type Side } from '../engine/types';
import { validateOrder, type FillContext, type OrderEstimate } from '../engine/engine';
import { DISCLAIMER_SHORT } from '../teaching/content';
import { Freshness, Money, Term, num, parseMajorToMinor, useStore } from './common';

const TYPES: { value: OrderType; label: string; hint: string }[] = [
  { value: 'market', label: 'Market', hint: 'Fills now at the best available price (when open).' },
  { value: 'limit', label: 'Limit', hint: 'Only fills at your price or better — may not fill.' },
  { value: 'stop', label: 'Stop', hint: 'Triggers a market order once the stop price is hit.' },
  { value: 'stop_limit', label: 'Stop-limit', hint: 'Triggers a limit order at the stop price.' },
];

export function TradeTicket({
  store,
  instrument,
  initialSide,
  onClose,
}: {
  store: AppStore;
  instrument: import('../engine/types').Instrument;
  initialSide: Side;
  onClose: () => void;
}) {
  useStore(store);
  const base = store.baseCurrency();

  const [side, setSide] = useState<Side>(initialSide);
  const [type, setType] = useState<OrderType>('market');
  const [duration, setDuration] = useState<OrderDuration>('day');
  const [qtyText, setQtyText] = useState('1');
  const [limitText, setLimitText] = useState('');
  const [stopText, setStopText] = useState('');
  const [stopLimitText, setStopLimitText] = useState('');
  const [note, setNote] = useState('');

  const [ctx, setCtx] = useState<FillContext | null>(null);
  const [loadingCtx, setLoadingCtx] = useState(true);
  const [result, setResult] = useState<PlaceOrderOutcome | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const held = store.state.positions.find(
    (p) => p.instrument.symbol === instrument.symbol && p.instrument.exchange === instrument.exchange,
  );

  function loadCtx() {
    setLoadingCtx(true);
    void store.buildContextFor(instrument).then((c) => {
      setCtx(c);
      setLoadingCtx(false);
    });
  }

  useEffect(loadCtx, [store, instrument]); // eslint-disable-line react-hooks/exhaustive-deps

  // prime price inputs from the quote so limit/stop start near the market
  useEffect(() => {
    if (!ctx) return;
    const px = ctx.quote.priceMinor;
    const f = (minor: number) => (minor / 100).toFixed(px % 100 === 0 ? 0 : 2);
    if (!limitText && ctx.quote.askMinor != null) setLimitText(f(ctx.quote.askMinor));
    else if (!limitText && px) setLimitText(f(px));
    if (!stopText && px) setStopText(f(Math.max(1, px - Math.max(50, Math.round(px * 0.05)))));
    if (!stopLimitText && px) setStopLimitText(f(Math.max(1, px - Math.max(50, Math.round(px * 0.05)))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx]);

  const qty = /^\d+$/.test(qtyText.trim()) ? Number(qtyText.trim()) : 0;
  const limitMinor = parseMajorToMinor(limitText, instrument.currency);
  const stopMinor = parseMajorToMinor(stopText, instrument.currency);
  const stopLimitMinor = parseMajorToMinor(stopLimitText, instrument.currency);

  const draft: OrderDraft = {
    instrument,
    side,
    type,
    duration,
    qty,
    limitPriceMinor: type === 'limit' ? limitMinor ?? undefined : undefined,
    stopPriceMinor: type === 'stop' ? stopMinor ?? undefined : undefined,
    stopLimitPriceMinor: type === 'stop_limit' ? stopLimitMinor ?? undefined : undefined,
    note: note.trim() || undefined,
  };

  const validation = ctx ? validateOrder(store.state, draft, ctx) : { ok: false as const, reason: 'Loading market data…' };
  const est: OrderEstimate | null = useMemo(() => {
    if (!ctx || !validation.ok || qty <= 0) return null;
    try {
      return store.estimate(draft, ctx);
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, validation.ok, side, type, duration, qty, limitMinor, stopMinor, stopLimitMinor]);

  async function confirm() {
    if (!validation.ok) return;
    setSubmitting(true);
    setResult(null);
    try {
      const r = await store.placeOrder(draft);
      setResult(r);
      if (r.ok) {
        await store.refreshPrices([instrument]);
        loadCtx();
      }
    } catch (e) {
      setResult({
        ok: false,
        orderId: '',
        status: 'rejected',
        reason: e instanceof Error ? e.message : String(e),
        fill: null,
        feedback: [],
      });
    } finally {
      setSubmitting(false);
    }
  }

  const quote = ctx?.quote;
  const typeHint = TYPES.find((t) => t.value === type)?.hint ?? '';

  return (
    <div className="sheet-backdrop" role="dialog" aria-modal="true" aria-label={`Trade ticket for ${instrument.symbol}`}>
      <div className="sheet">
        <div className="row between">
          <div>
            <h2>
              {side === 'buy' ? 'Buy' : 'Sell'} {instrument.symbol}
            </h2>
            <div className="tiny dim">
              {instrument.name} · {instrument.exchange} · native {instrument.currency} → base {base}
            </div>
          </div>
          <button className="btn ghost" onClick={onClose} aria-label="Close trade ticket" style={{ minHeight: 40 }}>
            ✕
          </button>
        </div>

        {result ? (
          <TradeResult result={result} base={base} onClose={onClose} onAgain={() => setResult(null)} />
        ) : (
          <>
            <div className="seg" role="group" aria-label="Side" style={{ margin: '12px 0' }}>
              <button type="button" aria-pressed={side === 'buy'} className="buy" onClick={() => setSide('buy')} style={{ background: side === 'buy' ? '#1d6b47' : undefined, color: side === 'buy' ? '#6ff0ab' : undefined }}>
                Buy
              </button>
              <button type="button" aria-pressed={side === 'sell'} onClick={() => setSide('sell')} style={{ background: side === 'sell' ? '#6b1d33' : undefined, color: side === 'sell' ? '#ff9aa8' : undefined }}>
                Sell {held ? `(${num(held.qty)} held)` : ''}
              </button>
            </div>

            <div className="field">
              <label htmlFor="ttype">Order type</label>
              <select id="ttype" value={type} onChange={(e) => setType(e.target.value as OrderType)}>
                {TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
              <span className="hint">
                <Term id={type === 'market' ? 'market_order' : type === 'limit' ? 'limit_order' : 'stop_order'}>{typeHint}</Term>
              </span>
            </div>

            <div className="field">
              <label htmlFor="tqty">Quantity (whole shares — I5)</label>
              <input id="tqty" inputMode="numeric" value={qtyText} onChange={(e) => setQtyText(e.target.value)} placeholder="1" />
              {side === 'buy' && est && (
                <span className="hint">Max affordable ≈ {maxAffordableText(est, store)} shares at this price.</span>
              )}
            </div>

            {type === 'limit' && (
              <div className="field">
                <label htmlFor="tlimit">Limit price ({instrument.currency})</label>
                <input id="tlimit" inputMode="decimal" value={limitText} onChange={(e) => setLimitText(e.target.value)} />
                <span className="hint">Your ceiling (buy) or floor (sell). No spread is charged on top of a limit price.</span>
              </div>
            )}
            {type === 'stop' && (
              <div className="field">
                <label htmlFor="tstop">Stop trigger price ({instrument.currency})</label>
                <input id="tstop" inputMode="decimal" value={stopText} onChange={(e) => setStopText(e.target.value)} />
                <span className="hint">Once hit, it becomes a market order.</span>
              </div>
            )}
            {type === 'stop_limit' && (
              <>
                <div className="field">
                  <label htmlFor="tstop2">Stop trigger price ({instrument.currency})</label>
                  <input id="tstop2" inputMode="decimal" value={stopText} onChange={(e) => setStopText(e.target.value)} />
                </div>
                <div className="field">
                  <label htmlFor="tlimit2">Limit price ({instrument.currency})</label>
                  <input id="tlimit2" inputMode="decimal" value={stopLimitText} onChange={(e) => setStopLimitText(e.target.value)} />
                </div>
              </>
            )}

            <div className="seg" role="group" aria-label="Duration" style={{ marginBottom: 12 }}>
              <button type="button" aria-pressed={duration === 'day'} onClick={() => setDuration('day')}>
                Day
              </button>
              <button type="button" aria-pressed={duration === 'gtc'} onClick={() => setDuration('gtc')}>
                <Term id="gtc">GTC</Term>
              </button>
            </div>

            <div className="field">
              <label htmlFor="tnote">Note (optional, saved with the order)</label>
              <input id="tnote" value={note} onChange={(e) => setNote(e.target.value)} placeholder="why am I doing this?" />
            </div>

            {/* ------------------------------------------------ estimate panel */}
            <div className="card">
              <div className="row between">
                <h2 style={{ margin: 0 }}>Estimated {side === 'buy' ? 'cost' : 'proceeds'}</h2>
                <button className="btn ghost" onClick={loadCtx} style={{ minHeight: 34, padding: '4px 10px' }}>
                  ↻ refresh price
                </button>
              </div>

              {loadingCtx && !ctx ? (
                <div className="empty small">Fetching a fresh quote…</div>
              ) : !validation.ok ? (
                <div className="notice warn small" role="status">
                  {validation.reason}
                </div>
              ) : est ? (
                <>
                  <div className="kv">
                    <span className="k">Execution price (native)</span>
                    <span className="v">
                      <Money minor={est.fillPriceMinor} currency={instrument.currency} />
                    </span>
                  </div>
                  <div className="kv">
                    <span className="k">Gross (native)</span>
                    <span className="v">
                      <Money minor={est.grossNativeMinor} currency={instrument.currency} />
                    </span>
                  </div>
                  <div className="kv">
                    <span className="k">
                      Gross (base {base}) <span className="tiny">FX {est.sameCurrency ? 'n/a (same currency)' : `1 ${instrument.currency} = ${est.fxRate.toFixed(6)} ${base}`}</span>
                    </span>
                    <span className="v">
                      <Money minor={est.grossBaseMinor} currency={base} />
                      {est.fxStale && <span className="badge warn" style={{ marginLeft: 6 }}>stale FX</span>}
                    </span>
                  </div>

                  <h2 style={{ margin: '12px 0 6px' }}>Itemised costs (RM2 — estimates)</h2>
                  {est.feeLines.length === 0 ? (
                    <div className="kv"><span className="k">Fees &amp; taxes</span><span className="v">none for this market/side</span></div>
                  ) : (
                    est.feeLines.map((f) => (
                      <div className="kv" key={f.id}>
                        <span className="k">{f.label}</span>
                        <span className="v">
                          <Money minor={f.amountMinor} currency={base} />
                        </span>
                      </div>
                    ))
                  )}
                  {est.taxMinor > 0 && (
                    <div className="kv">
                      <span className="k">Estimated tax withheld (RM8)</span>
                      <span className="v">
                        <Money minor={est.taxMinor} currency={base} />
                      </span>
                    </div>
                  )}
                  <div className="kv">
                    <span className="k">Total {side === 'buy' ? 'debited' : 'credited'}</span>
                    <span className="v value">
                      <Money minor={est.totalBaseMinor} currency={base} signed={side === 'sell'} />
                    </span>
                  </div>

                  <h2 style={{ margin: '12px 0 6px' }}>
                    <Term id="spread">Spread</Term> &amp; <Term id="slippage">slippage</Term> (RM3)
                  </h2>
                  <div className="kv">
                    <span className="k">Modelled impact</span>
                    <span className="v">
                      {est.spreadBps} bps spread + {est.slippageBps} bps slippage
                    </span>
                  </div>
                  <div className="tiny dim">{est.slippageExplanation}</div>

                  <h2 style={{ margin: '12px 0 6px' }}>After the trade (RM9)</h2>
                  <div className="kv">
                    <span className="k">Position size</span>
                    <span className="v">
                      {est.positionPctOfWallet.toFixed(1)}% of wallet
                    </span>
                  </div>
                  <div className="kv">
                    <span className="k">Resulting cash</span>
                    <span className="v">
                      <Money minor={est.resultingSettledCashMinor} currency={base} />
                    </span>
                  </div>
                  {est.settlementAvailableAtUtc && side === 'sell' && (
                    <div className="kv">
                      <span className="k">
                        <Term id="settlement">Proceeds available</Term>
                      </span>
                      <span className="v tiny">{new Date(est.settlementAvailableAtUtc).toLocaleString()}</span>
                    </div>
                  )}
                  {est.concentrationWarning && (
                    <div className="notice warn small" role="status">
                      {est.concentrationWarning} (Observation, not advice.)
                    </div>
                  )}

                  {!est.realism && (
                    <div className="notice info small">
                      <strong>Idealized mode:</strong> fees, spread and slippage are switched off, so these numbers are
                      friendlier than a real broker's.
                    </div>
                  )}

                  {est.queued && est.queuedNotice && (
                    <div className="notice warn" role="status">
                      <strong>Queued order.</strong> {est.queuedNotice}
                    </div>
                  )}
                  {ctx && !ctx.marketOpen && type === 'market' && !est.queued && (
                    <div className="notice warn" role="status">
                      The market is closed — this order will queue for the next session (M3/R2).
                    </div>
                  )}

                  {quote && (
                    <div style={{ marginTop: 8 }}>
                      <Freshness atUtc={quote.atUtc} stale={quote.stale} delayed={quote.delayed} provider={store.providerId()} />
                    </div>
                  )}
                </>
              ) : null}
            </div>

            <button
              className={`btn block ${side === 'buy' ? 'buy' : 'sell'}`}
              disabled={!validation.ok || submitting || !est}
              onClick={confirm}
              aria-label={`Confirm ${side} order for ${instrument.symbol}`}
            >
              {submitting ? 'Placing…' : `Confirm ${side} of ${qty || '?'} ${instrument.symbol}`}
            </button>

            <p className="tiny dim center" style={{ marginTop: 8 }}>
              {DISCLAIMER_SHORT}
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/** Rough affordability hint: floor(cash ÷ per-share cost in base). Fees ignored. */
function maxAffordableText(est: OrderEstimate, store: AppStore): string {
  if (est.fillPriceMinor <= 0 || est.grossBaseMinor <= 0 || est.grossNativeMinor <= 0) return '0';
  // cost per share in base currency, derived from the whole-order gross
  const perShareMinor = Math.max(1, Math.round(est.grossBaseMinor / est.grossNativeMinor * est.fillPriceMinor));
  const cash = store.valuation().settledMinor;
  return String(Math.max(0, Math.floor(cash / perShareMinor)));
}

function TradeResult({
  result,
  base,
  onClose,
  onAgain,
}: {
  result: PlaceOrderOutcome;
  base: string;
  onClose: () => void;
  onAgain: () => void;
}) {
  return (
    <div style={{ marginTop: 12 }}>
      <div className={result.ok ? 'notice' : 'notice error'} role="status">
        <strong>
          {result.status === 'filled'
            ? 'Filled ✓'
            : result.status === 'queued'
              ? 'Queued — waiting for the market'
              : 'Rejected'}
        </strong>
        {result.reason && <div className="small">{result.reason}</div>}
        {result.status === 'queued' && (
          <div className="small dim">
            You'll find it under Orders. It fills automatically when its condition is met, or expires at the session
            close if it's a day order (RM4).
          </div>
        )}
      </div>

      {result.fill && (
        <div className="card">
          <h2>Fill details</h2>
          <div className="kv">
            <span className="k">Quantity</span>
            <span className="v">{num(result.fill.qty)} sh</span>
          </div>
          <div className="kv">
            <span className="k">Price</span>
            <span className="v">
              <Money minor={result.fill.nativePriceMinor} currency={result.fill.nativeCurrency} />
            </span>
          </div>
          <div className="kv">
            <span className="k">Gross</span>
            <span className="v">
              <Money minor={result.fill.baseGrossMinor} currency={base} />
            </span>
          </div>
          <div className="kv">
            <span className="k">Fees</span>
            <span className="v">
              <Money minor={result.fill.feesMinor} currency={base} />
            </span>
          </div>
          {result.fill.taxWithheldMinor > 0 && (
            <div className="kv">
              <span className="k">Tax withheld</span>
              <span className="v">
                <Money minor={result.fill.taxWithheldMinor} currency={base} />
              </span>
            </div>
          )}
          <div className="kv">
            <span className="k">{result.fill.side === 'buy' ? 'Debited' : 'Credited'}</span>
            <span className="v value">
              <Money minor={result.fill.side === 'buy' ? result.fill.baseDebitedMinor : result.fill.baseCreditedMinor} currency={base} />
            </span>
          </div>
          {result.fill.availableAtUtc && (
            <div className="kv">
              <span className="k">Proceeds available</span>
              <span className="v tiny">{new Date(result.fill.availableAtUtc).toLocaleString()}</span>
            </div>
          )}
          {!result.fill.realism && (
            <div className="tiny" style={{ marginTop: 6 }}>
              <span className="badge warn">idealized fill</span> — no fees, spread or slippage were applied (RM1).
            </div>
          )}
        </div>
      )}

      {result.feedback.length > 0 && (
        <div className="card">
          <h2>What just happened (T3)</h2>
          {result.feedback.map((f) => (
            <div key={f.id} className="challenge">
              <div className="title">{f.title}</div>
              <div className="desc">{f.body}</div>
            </div>
          ))}
        </div>
      )}

      <div className="row" style={{ gap: 10 }}>
        <button className="btn grow" onClick={onAgain}>
          Place another
        </button>
        <button className="btn primary grow" onClick={onClose}>
          Done
        </button>
      </div>
      <p className="tiny dim center" style={{ marginTop: 8 }}>
        Observations are educational, not advice.
      </p>
    </div>
  );
}
