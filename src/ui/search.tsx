/** Screen 3 — Search (spec §7.3): provider-wide symbol search with exchange
 *  and currency on every result (I1/I2), offline/stale behaviour (A2). */

import { useEffect, useRef, useState } from 'react';
import type { AppStore } from '../state/store';
import { instrumentId, type Instrument } from '../engine/types';
import { Freshness, TopBar, useStore } from './common';

export function Search({
  store,
  onOpen,
}: {
  store: AppStore;
  onOpen: (i: Instrument) => void;
}) {
  useStore(store);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Instrument[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  // debounce 300 ms; ignore out-of-order responses
  useEffect(() => {
    const q = query.trim();
    const my = ++seq.current;
    if (!q) {
      setResults([]);
      setSearching(false);
      setError(null);
      return;
    }
    setSearching(true);
    const t = setTimeout(() => {
      void store.search(q).then((r) => {
        if (seq.current !== my) return;
        setResults(r);
        setSearching(false);
        setError(store.status.error ? store.status.error.guidance : null);
      });
    }, 300);
    return () => clearTimeout(t);
  }, [query, store]);

  const held = store.state.positions.map((p) => p.instrument);

  return (
    <>
      <TopBar title="Search" />
      <main className="app-main">
        <div className="field">
          <label htmlFor="q">Symbol or company name</label>
          <input
            id="q"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="AAPL, RELIANCE, Vanguard…"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
          />
          <span className="hint">
            Search runs against the active provider directly from this device — there is no Stocker server.
          </span>
        </div>

        {store.status.offline && (
          <div className="notice warn small">
            You appear to be offline. Showing whatever was cached — results may be missing or stale.
          </div>
        )}
        {error && <div className="notice error small">{error}</div>}

        {searching && <div className="empty">Searching…</div>}

        {!searching && query.trim() && results.length === 0 && (
          <div className="empty">
            No matches for “{query.trim()}”.
            <div className="tiny" style={{ marginTop: 6 }}>
              Try the bare symbol (e.g. <code>AAPL</code>) or check that your API key covers that market.
            </div>
          </div>
        )}

        {!query.trim() && (
          <div className="card">
            <h2>Your holdings</h2>
            {held.length === 0 ? (
              <div className="empty small">Nothing yet — type a symbol above to get started.</div>
            ) : (
              <div className="list">
                {held.map((i) => (
                  <button key={instrumentId(i)} className="item" onClick={() => onOpen(i)}>
                    <span className="grow">
                      <span className="sym">{i.symbol}</span> <span className="badge">{i.exchange}</span>
                      <div className="name">{i.name}</div>
                    </span>
                    <span className="badge">{i.currency}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {results.length > 0 && (
          <div className="card">
            <h2>{results.length} result{results.length > 1 ? 's' : ''}</h2>
            <div className="list">
              {results.map((i) => {
                const q = store.quotes.get(instrumentId(i));
                return (
                  <button key={instrumentId(i)} className="item" onClick={() => onOpen(i)}>
                    <span className="grow">
                      <span className="sym">{i.symbol}</span>{' '}
                      <span className="badge" title="Exchange (identity is symbol + exchange)">{i.exchange}</span>
                      {i.isIndex && <span className="badge warn">index · read-only</span>}
                      <div className="name">{i.name}</div>
                      {q && <Freshness atUtc={q.atUtc} stale={q.stale} delayed={q.delayed} provider={q.provider} />}
                    </span>
                    <span className="right">
                      <span className="badge" title="Native currency">{i.currency}</span>
                      <div className="tiny dim">{i.assetType.toUpperCase()}</div>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <p className="tiny dim center">
          Data is supplied by your chosen provider and may be delayed. Educational use only — not advice.
        </p>
      </main>
    </>
  );
}
