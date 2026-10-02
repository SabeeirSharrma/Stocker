/** Screen 1 — Onboarding (spec §7.1, D3, S3, P1, RM1). */

import { useState } from 'react';
import type { AppStore } from '../state/store';
import type { ProviderId } from '../data/provider';
import { DISCLAIMER_FULL, DISCLAIMER_SHORT, KNOWN_LIMITS } from '../teaching/content';
import { Money, parseMajorToMinor, SimulatedBadge, Term } from './common';

const CURRENCIES_OPTS = [
  { code: 'USD', label: 'USD — US Dollar' },
  { code: 'INR', label: 'INR — Indian Rupee (₹, lakh grouping)' },
  { code: 'EUR', label: 'EUR — Euro' },
  { code: 'GBP', label: 'GBP — British Pound' },
  { code: 'JPY', label: 'JPY — Japanese Yen (no decimals)' },
  { code: 'HKD', label: 'HKD — Hong Kong Dollar' },
  { code: 'CAD', label: 'CAD — Canadian Dollar' },
  { code: 'AUD', label: 'AUD — Australian Dollar' },
];

export function Onboarding({ store }: { store: AppStore }) {
  const [step, setStep] = useState(0);
  const [ack, setAck] = useState(false);

  const [currency, setCurrency] = useState('USD');
  const [balanceText, setBalanceText] = useState('10000');
  const [realism, setRealism] = useState(true); // RM1: on by default

  const [providerId, setProviderId] = useState<ProviderId>('twelvedata');
  const [apiKey, setApiKey] = useState('');
  const [keyTest, setKeyTest] = useState<{ ok: boolean; message: string; plan?: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const balanceMinor = parseMajorToMinor(balanceText, currency);

  async function testKey() {
    setTesting(true);
    setKeyTest(null);
    const r = await store.testKey(providerId, apiKey.trim());
    setKeyTest(r);
    setTesting(false);
  }

  async function finish() {
    if (balanceMinor == null || balanceMinor <= 0) {
      setError('Starting balance must be a positive amount.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await store.completeOnboarding({
        baseCurrency: currency,
        startingBalanceMinor: balanceMinor,
        providerId,
        apiKey: apiKey.trim(),
        realismMode: realism,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <main className="app-main onboard">
        <div className="steps" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <span key={i} className={i <= step ? 'on' : ''} />
          ))}
        </div>

        {step === 0 && (
          <>
            <h1>Welcome to Stocker</h1>
            <p className="lede">
              A stock-trading <strong>simulator</strong>: virtual money, real market prices, zero real risk. <SimulatedBadge />
            </p>

            <div className="card">
              <h2>Read this first (D3)</h2>
              <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 14, margin: 0, color: 'var(--text)' }}>
                {DISCLAIMER_FULL}
              </pre>
            </div>

            <div className="card">
              <h2>Known limits (RM12)</h2>
              <div className="stack-sm">
                {KNOWN_LIMITS.map((l) => (
                  <div key={l.title}>
                    <strong className="small">{l.title}</strong>
                    <div className="small dim">{l.body}</div>
                  </div>
                ))}
              </div>
            </div>

            <label className="checkline">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              <span>I understand this is an educational simulation — not financial advice, not a broker.</span>
            </label>

            <button className="btn primary block" disabled={!ack} onClick={() => setStep(1)} aria-label="Continue to account setup">
              Continue
            </button>
            <p className="tiny dim center" style={{ marginTop: 10 }}>{DISCLAIMER_SHORT}</p>
          </>
        )}

        {step === 1 && (
          <>
            <h1>Your practice account</h1>
            <p className="lede">Everything here is simulated. You can reset it any time from Settings.</p>

            <div className="card">
              <div className="field">
                <label htmlFor="base-ccy">Base currency (W3)</label>
                <select id="base-ccy" value={currency} onChange={(e) => setCurrency(e.target.value)}>
                  {CURRENCIES_OPTS.map((c) => (
                    <option key={c.code} value={c.code}>{c.label}</option>
                  ))}
                </select>
                <span className="hint">Your wallet, P&amp;L and reports are shown in this currency. Foreign instruments are converted at live rates.</span>
              </div>

              <div className="field">
                <label htmlFor="balance">Starting balance (virtual money)</label>
                <input
                  id="balance"
                  inputMode="decimal"
                  value={balanceText}
                  onChange={(e) => setBalanceText(e.target.value)}
                  placeholder="10000"
                />
                {balanceMinor != null && balanceMinor > 0 ? (
                  <span className="hint">You'll start with <Money minor={balanceMinor} currency={currency} /> of virtual cash.</span>
                ) : (
                  <span className="err">Enter a positive amount, e.g. 10000.</span>
                )}
              </div>

              <label className="checkline">
                <input type="checkbox" checked={realism} onChange={(e) => setRealism(e.target.checked)} />
                <span>
                  <strong>Realism Mode (RM1)</strong> — itemised <Term id="spread">costs</Term>, <Term id="slippage">slippage</Term> and{' '}
                  <Term id="settlement">settlement</Term> delays. <em>On by default; recommended for honest numbers.</em>
                </span>
              </label>
            </div>

            <div className="row">
              <button className="btn ghost" onClick={() => setStep(0)}>Back</button>
              <button className="btn primary grow" onClick={() => setStep(2)}>Continue</button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h1>Market data provider</h1>
            <p className="lede">Stocker has no server — it calls your chosen provider directly from this device.</p>

            <div className="card">
              {store.providers().map((p) => (
                <label className="checkline" key={p.id}>
                  <input type="radio" name="provider" checked={providerId === p.id} onChange={() => { setProviderId(p.id); setKeyTest(null); }} />
                  <span className="grow">
                    <strong>{p.name}</strong>
                    <div className="tiny dim">{p.blurb}</div>
                  </span>
                </label>
              ))}
            </div>

            <div className="card">
              <div className="field">
                <label htmlFor="apikey">Your API key (P1 — never bundled with the app)</label>
                <input
                  id="apikey"
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="paste your free-tier key"
                />
                <span className="hint">
                  <strong>S3:</strong> the key is stored only on this device. Don't use a key tied to a paid plan if this is a shared device.
                </span>
              </div>
              <div className="row">
                <button className="btn" onClick={testKey} disabled={apiKey.trim().length < 5 || testing}>
                  {testing ? 'Testing…' : 'Test key'}
                </button>
                {keyTest && (
                  <span className={keyTest.ok ? 'badge ok' : 'badge warn'} role="status">
                    {keyTest.ok ? '✓ key works' : `✗ ${keyTest.message}`}
                  </span>
                )}
              </div>
              {keyTest?.plan && <p className="tiny dim">{keyTest.plan}</p>}
              {keyTest?.ok && <p className="tiny dim">Usage plan recorded so the app can respect the rate limits (P5).</p>}
            </div>

            {error && <div className="notice error" role="alert">{error}</div>}

            <div className="row">
              <button className="btn ghost" onClick={() => setStep(1)}>Back</button>
              <button className="btn primary grow" disabled={busy} onClick={finish}>
                {busy ? 'Creating…' : 'Create practice account'}
              </button>
            </div>
            <p className="tiny dim center" style={{ marginTop: 10 }}>
              You can change the provider and key later in Settings.
            </p>
          </>
        )}
      </main>
    </div>
  );
}
