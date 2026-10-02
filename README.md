# Stocker

**A stock-trading trainer: virtual money, real market prices, no real money.**

Stocker is an installable PWA (and Android APK) where you practise investing and
trading against real, possibly-delayed market data — with an honest simulation of
the costs, delays and rules you'd meet at a real broker.

> **Not financial advice. Not a broker, exchange or advisor. Not regulated by any
> financial regulator. It places no real orders and uses no real money.**

## What it does

- **Virtual wallet** — pick a base currency and starting balance; everything is
  stored on-device (IndexedDB). No backend, no accounts, no telemetry.
- **Real market data** — bring your own free-tier API key for **Twelve Data**
  (default), **Finnhub** or **MarketData**. Keys live only on your device and are
  excluded from exports unless you opt in.
- **Full order types** — market, limit, stop, stop-limit; day / GTC; queued orders
  fill at the next session's open, never retroactively against the same day's candle.
- **Realism Mode (on by default)** — itemised fees per market (US SEC/FINRA, IN
  brokerage+STT+GST, …), bid/ask spread, volume-aware slippage, tick-size snapping,
  T+1 settlement, estimated tax withholding, dividends and splits.
- **Reconstruction** — your history is rebuilt deterministically from your fills
  and daily candles, with snapshot backfill (R1–R5), so your equity curve survives
  reloads and offline periods.
- **Reconciliation you can check** — `starting + realized + unrealized − fees +
  dividends − tax = total value` is displayed on the Performance screen (V5).
- **Teaching layer** — glossary, glossary tooltips, automatic challenges,
  post-trade explanations, trade journal, known-limits statement and a "what real
  trading adds" readiness checklist.
- **Works offline** — app shell cached by a service worker; stale data is always
  labelled with its timestamp, never silently shown as fresh.

## Development

```bash
npm install
npm run dev        # dev server
npm test           # 166 deterministic tests (no network): engine, money,
                   # calendar, reconstruction, storage, queue/cache, teaching, UI
npm run typecheck  # tsc -b
npm run build      # production bundle → dist/
```

## Android APK

```bash
npm run build
npx cap add android     # once (already committed)
npx cap sync android    # copy dist/ into the native project
cd android
JAVA_HOME=<jdk 21> ANDROID_HOME=<android-sdk> ./gradlew assembleRelease
# → android/app/build/outputs/apk/release/app-release.apk
```

Without signing secrets the release build falls back to the local debug key so
the APK is always installable during development.

## Releasing (GitHub Actions)

Push a tag — the `Release APK` workflow typechecks, runs the whole test suite,
builds the bundle, assembles a signed release APK and attaches it (plus a
SHA-256 checksum) to the GitHub Release for that tag:

```bash
git tag 0.1
git push origin 0.1
```

Optional repository secrets for stable upgrade-able signatures
(Android requires the same signature for every upgrade of an installed app):

| Secret | Meaning |
| --- | --- |
| `ANDROID_KEYSTORE_B64` | base64-encoded `.keystore` / `.jks` |
| `ANDROID_KEYSTORE_PASSWORD` | keystore password |
| `ANDROID_KEY_ALIAS` | key alias |
| `ANDROID_KEY_PASSWORD` | key password |

Without them an ephemeral throwaway key is generated for that run.

## Layout

```
src/engine/      pure, deterministic core: money (integer minor units, banker's
                 rounding), fees/slippage/tax, order lifecycle, valuation,
                 reconciliation, reconstruction
src/calendar/    exchange sessions + static holiday tables
src/data/        provider adapters, rate-limited queue, TTL cache, FX policy
src/storage/     IndexedDB wrapper, validated atomic JSON export/import
src/state/       application store (UI-facing actions), API-key keystore
src/teaching/    disclaimers, glossary, challenges, post-trade feedback
src/ui/          screens: onboarding, portfolio, search, instrument, ticket,
                 orders, performance, learn, settings
test/            vitest suites (engine TST1–TST3, storage A4, UI smoke)
```

## License

MIT — see [LICENSE](LICENSE).
