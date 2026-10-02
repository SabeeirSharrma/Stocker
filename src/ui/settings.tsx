/** Screen 9 — Settings & data (spec §7.9): Realism Mode, provider + key (P1/P4),
 *  display currency (W3), benchmark (T4), export/import (A4/P2), reset (U1),
 *  re-readable disclaimers (D1–D5) and the V5 debug view. */

import { useRef, useState } from 'react';
import type { AppStore } from '../state/store';
import type { ProviderId } from '../data/provider';
import { DISCLAIMER_FULL, DISCLAIMER_SHORT, DISCLOSURE_DATA_LABEL, KNOWN_LIMITS } from '../teaching/content';
import { TopBar, useStore } from './common';

const DISPLAY_CURRENCIES = ['USD', 'INR', 'EUR', 'GBP', 'JPY', 'HKD', 'CAD', 'AUD'];

export function Settings({ store }: { store: AppStore }) {
  useStore(store);
  const acct = store.account();
  const s = acct?.settings;

  const [providerId, setProviderId] = useState(store.providerId());
  const [apiKey, setApiKey] = useState('');
  const [keyMsg, setKeyMsg] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importText, setImportText] = useState('');
  const [confirmReset, setConfirmReset] = useState<'off' | 'ask' | 'final'>('off');
  const [includeKeys, setIncludeKeys] = useState(!!s?.includeKeysInExport);
  const fileRef = useRef<HTMLInputElement>(null);

  async function run(fn: () => Promise<void>, okMsg?: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (okMsg) setNotice(okMsg);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function doExport() {
    // P2: exporting keys is an explicit, warned, per-export decision
    let include = includeKeys;
    if (includeKeys) {
      const ok = window.confirm(
        'Include API keys in this file?\n\nKeys are secrets: only do this on your own private device, and delete the file once imported elsewhere (P2).\n\nCancel exports WITHOUT keys.',
      );
      if (!ok) include = false;
    }
    await run(async () => {
      const text = await store.exportJson(include);
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `stocker-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5_000);
    }, include ? 'Backup exported WITH API keys — treat the file like a password.' : 'Backup exported (keys excluded).');
  }

  async function doImport(text: string) {
    await run(async () => {
      await store.importJson(text);
      setImportText('');
    }, 'Backup imported and validated — state replaced atomically (A4).');
  }

  function onFile(file: File | undefined) {
    if (!file) return;
    const r = new FileReader();
    r.onload = () => void doImport(String(r.result ?? ''));
    r.readAsText(file);
  }

  return (
    <>
      <TopBar title="Settings" />
      <main className="app-main">
        {notice && <div className="notice info" role="status">{notice}</div>}
        {error && <div className="notice error" role="alert">{error}</div>}

        {/* ------------------------------------------------------ simulation */}
        <div className="card">
          <h2>Simulation</h2>
          <label className="checkline">
            <input
              type="checkbox"
              checked={!!s?.realismMode}
              onChange={(e) => void store.updateSettings({ realismMode: e.target.checked })}
              aria-describedby="realism-desc"
            />
            <span>
              <strong>Realism Mode (RM1)</strong>
              <div id="realism-desc" className="tiny dim">
                Applies itemised costs, <abbr title="difference between bid and ask">spread</abbr>, slippage and
                settlement delays. Off = idealised fills (clearly labelled).
              </div>
            </span>
          </label>
          <label className="checkline">
            <input
              type="checkbox"
              checked={!!s?.deductTaxFromWallet}
              onChange={(e) => void store.updateSettings({ deductTaxFromWallet: e.target.checked })}
            />
            <span>
              <strong>Deduct estimated tax from the wallet on sells (RM8)</strong>
              <div className="tiny dim">Off by default — tax figures are estimates, not filings.</div>
            </span>
          </label>
          <div className="field" style={{ marginTop: 8 }}>
            <label htmlFor="bench">Benchmark instrument (T4)</label>
            <div className="row">
              <input
                id="bench"
                value={s?.benchmark.symbol ?? ''}
                onChange={(e) =>
                  void store.updateSettings({ benchmark: { ...s!.benchmark, symbol: e.target.value.toUpperCase() } })
                }
                style={{ maxWidth: 140 }}
              />
              <input
                aria-label="Benchmark exchange"
                value={s?.benchmark.exchange ?? ''}
                onChange={(e) =>
                  void store.updateSettings({ benchmark: { ...s!.benchmark, exchange: e.target.value.toUpperCase() } })
                }
                style={{ maxWidth: 140 }}
              />
            </div>
            <span className="hint">Your equity curve is compared against this symbol (default SPY · NASDAQ).</span>
          </div>
        </div>

        {/* -------------------------------------------------------- currency */}
        <div className="card">
          <h2>Currency &amp; locale (W3)</h2>
          <div className="field">
            <label htmlFor="basec">Base currency (your wallet)</label>
            <input id="basec" value={acct?.baseCurrency ?? ''} readOnly className="dim" />
            <span className="hint">Fixed after onboarding — changing it would rewrite every P&amp;L figure. Export + reset to start fresh.</span>
          </div>
          <div className="field">
            <label htmlFor="dispc">Display currency</label>
            <select
              id="dispc"
              value={s?.displayCurrency ?? acct?.baseCurrency ?? 'USD'}
              onChange={(e) =>
                void store.updateSettings({
                  displayCurrency: e.target.value === (acct?.baseCurrency ?? 'USD') ? null : e.target.value,
                })
              }
            >
              {[acct?.baseCurrency ?? 'USD', ...DISPLAY_CURRENCIES.filter((c) => c !== acct?.baseCurrency)].map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            <span className="hint">Display-only conversion — P&amp;L maths always runs in the base currency.</span>
          </div>
        </div>

        {/* --------------------------------------------------------- provider */}
        <div className="card">
          <h2>Market data provider (P4)</h2>
          <div className="field">
            <label htmlFor="prov">Provider</label>
            <select id="prov" value={providerId} onChange={(e) => setProviderId(e.target.value as ProviderId)}>
              {store.providers().map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="k">API key {store.hasApiKey(providerId) ? '(a key is stored on this device)' : '(none stored)'}</label>
            <div className="row">
              <input
                id="k"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={store.hasApiKey(providerId) ? '•••••••• (enter to replace)' : 'paste your key'}
              />
              <button
                className="btn"
                disabled={busy || !apiKey.trim()}
                onClick={() =>
                  void run(async () => {
                    await store.setApiKey(providerId, apiKey.trim());
                    setApiKey('');
                  }, 'Key saved to this device only.')
                }
              >
                Save
              </button>
            </div>
            <span className="hint">
              P1: keys live in this device's storage and are excluded from exports unless you opt in. They are sent
              only to the provider you selected.
            </span>
          </div>
          <div className="row">
            <button
              className="btn"
              disabled={busy}
              onClick={() => {
                setKeyMsg(null);
                void store.testKey(providerId, apiKey.trim() || '').then(setKeyMsg);
              }}
            >
              Test key
            </button>
            {keyMsg && <span className={keyMsg.ok ? 'badge ok' : 'badge warn'} role="status">{keyMsg.ok ? '✓ works' : `✗ ${keyMsg.message}`}</span>}
          </div>
        </div>

        {/* ------------------------------------------------- export / import */}
        <div className="card">
          <h2>Export &amp; import (A4)</h2>
          <p className="small dim">
            {DISCLOSURE_DATA_LABEL}
          </p>
          <label className="checkline">
            <input type="checkbox" checked={includeKeys} onChange={(e) => setIncludeKeys(e.target.checked)} />
            <span className="small">Include API keys in exports (off = safer, P2)</span>
          </label>
          <div className="row" style={{ gap: 10, marginTop: 8 }}>
            <button className="btn grow" disabled={busy} onClick={() => void doExport()}>
              Export JSON
            </button>
            <button className="btn grow" disabled={busy} onClick={() => fileRef.current?.click()}>
              Import JSON…
            </button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={(e) => {
              onFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          <div className="field" style={{ marginTop: 10 }}>
            <label htmlFor="paste">…or paste the backup JSON</label>
            <textarea id="paste" value={importText} onChange={(e) => setImportText(e.target.value)} placeholder='{"format":…}' />
            <button className="btn" disabled={busy || !importText.trim()} onClick={() => void doImport(importText.trim())}>
              Validate &amp; import
            </button>
          </div>
          <p className="tiny dim">
            Imports are fully validated first; an invalid file is rejected without touching your current data, and a
            valid file replaces it in one transaction.
          </p>
        </div>

        {/* ----------------------------------------------------------- reset */}
        <div className="card">
          <h2>Reset (U1)</h2>
          {confirmReset === 'off' && (
            <button className="btn danger block" onClick={() => setConfirmReset('ask')}>
              Reset practice account…
            </button>
          )}
          {confirmReset === 'ask' && (
            <>
              <div className="notice warn small">
                <strong>There is no cloud backup.</strong> Export your account first, or everything will be
                unrecoverable.
              </div>
              <div className="row" style={{ gap: 10 }}>
                <button
                  className="btn grow"
                  onClick={() => {
                    setConfirmReset('off');
                    void doExport();
                  }}
                >
                  Export a backup first
                </button>
                <button className="btn danger grow" onClick={() => setConfirmReset('final')}>
                  I have a backup — continue
                </button>
              </div>
            </>
          )}
          {confirmReset === 'final' && (
            <>
              <div className="notice error small">
                Final step: this deletes positions, orders, fills, snapshots, journal and challenge progress on this
                device.
              </div>
              <div className="row" style={{ gap: 10 }}>
                <button className="btn grow" onClick={() => setConfirmReset('off')}>Cancel</button>
                <button
                  className="btn danger grow"
                  onClick={() =>
                    void run(async () => {
                      await store.resetAccount({ keepKeys: true });
                      setConfirmReset('off');
                    }, 'Practice account reset. API key kept — remove it below if you want.')
                  }
                >
                  Reset now
                </button>
              </div>
            </>
          )}
        </div>

        {/* ------------------------------------------------- disclaimers/About */}
        <div className="card">
          <h2>About &amp; disclaimers (D1–D5)</h2>
          <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 13, margin: 0 }}>{DISCLAIMER_FULL}</pre>
          <p className="tiny dim" style={{ marginTop: 8 }}>{DISCLAIMER_SHORT}</p>
          <ul className="tiny dim" style={{ paddingLeft: 18 }}>
            {KNOWN_LIMITS.map((l) => (
              <li key={l.title}>
                <strong>{l.title}:</strong> {l.body}
              </li>
            ))}
          </ul>
        </div>

        <div className="card">
          <h2>Diagnostics (V5)</h2>
          <button className="btn block" onClick={() => setNotice(store.debugReconcile())}>
            Run consistency check
          </button>
          {notice && notice.includes('identity') && (
            <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: 12 }}>{notice}</pre>
          )}
          <div className="tiny dim" style={{ marginTop: 6 }}>
            Reconstruction: {store.state.meta.lastReconstructAtUtc ? `last ran ${new Date(store.state.meta.lastReconstructAtUtc).toLocaleString()}` : 'never'} ·
            snapshots: {store.state.snapshots.length} ·
            schema v{store.state.schemaVersion}
          </div>
        </div>
      </main>
    </>
  );
}
