# Stocker Specification v0.2

Status: draft for review and refinement. No code is included on purpose. Requirements are numbered so they can be referenced, edited, and tested individually. Anything marked **[VERIFY]** is an assumption that must be checked before it is relied on.

---

## 1. Purpose

A stock-trading trainer. Users get a virtual wallet, "buy" and "sell" real instruments at real market prices, and see their balance change according to real profit and loss. Nothing is real money. The goal is to teach the basics of trading with realistic mechanics and consequences.

### 1.1 Goals
- G1. Teach trading basics through realistic simulation using real market data.
- G2. Cover US, Indian, and international markets, plus index exposure (e.g. S&P 500, Nifty 50).
- G3. Work with no backend: the client fetches data, and users supply their own API keys.
- G4. Mobile-first, also usable on the web, from one codebase.
- G5. Keep all balances, trades, and P&L internally consistent and reproducible.
- G6. Be as realistic as possible (costs, spreads, order types, settlement, corporate actions, taxes) so a user who later chooses to trade with real money is not surprised by how markets actually work. See section 6.6.

### 1.2 Non-goals (v1)
- Social features: leaderboards, sharing, classrooms, accounts, sync.
- Real brokerage connections or real money of any kind.
- Shorting, margin, options, futures, crypto.
- Server-side anything. No backend, no database server, no background workers.

### 1.3 Disclaimer and regulatory-status requirements
- D1. The app must state that it is an educational simulation and not financial, investment, tax, or legal advice.
- D2. The app must state plainly that it is a simulator only: it is **not** a broker, exchange, or advisor; it is **not approved, endorsed, licensed, or regulated by any financial regulator or government agency**; it places no real orders and uses no real money.
- D3. Placement: a notice the user must acknowledge at first launch; repeated in onboarding; permanently reachable from About/Settings; a short "Simulated" label on the trade ticket and portfolio screens; and included in the readiness checklist (RM11).
- D4. Branding and copy must never use the names or logos of regulators or government agencies, or words like "official", "certified", or "approved", or otherwise imply affiliation. Third-party tickers, company names, and market data belong to their owners and are used per the data provider's terms.
- D5. All costs, taxes, and rules shown are estimates based on configurable data and may differ from real-world outcomes. Say so wherever they are displayed.
- D6. **[VERIFY]** The author should consider a legal review before public release, since rules on financial education and information vary by jurisdiction.

---

## 2. Platform and architecture

- A1. Delivered as a Progressive Web App (PWA), designed mobile-first (small viewport is the primary layout; larger screens adapt).
- A2. Installable to the home screen, with an offline shell. Offline use shows the last known data, clearly marked as stale.
- A3. All persistence is on-device (IndexedDB). There is no server and no account system.
- A4. Provide JSON export and import of the full app state as the only backup/transfer mechanism. Import must validate the schema version and reject malformed files without corrupting existing data.
- A5. The architecture should keep the UI, the simulation engine, the data-provider layer, and storage as separate modules, so the PWA could later be wrapped for native (e.g. Capacitor) without rewriting the engine.

### 2.1 Module overview
1. **UI layer**: screens and components.
2. **Simulation engine**: wallet, orders, fills, positions, P&L, valuation. Pure logic, no network access, fully unit-testable.
3. **Market data layer**: provider adapters, caching, rate-limit handling, FX.
4. **Market calendar module**: per-exchange hours and holidays.
5. **Storage layer**: IndexedDB access, schema versioning, migrations, export/import.
6. **Teaching layer**: glossary, challenges, post-trade feedback.

---

## 3. Data providers and API keys

- P1. The user supplies their own API key during onboarding. The developer ships no key.
- P2. Keys are stored on-device only, never logged, never included in exports unless the user explicitly opts in (default: excluded).
- P3. Market data is accessed through a **provider adapter interface** so providers are swappable. Every adapter must expose these capabilities: symbol search, latest quote, historical candles (daily at minimum, intraday where available), FX rate (pair to pair), and a coverage descriptor (which exchanges, which asset types, which index quotes are supported, whether data is delayed).
- P4. Initial adapters: **Twelve Data** (default, since one key covers stocks, ETFs, and forex across many exchanges) and **Finnhub** (alternative, strongest for US). Others can be added later.
- P5. Each adapter declares its rate limits. The data layer must queue and throttle requests to stay within them, and must surface a clear message when a limit is hit rather than failing silently.
- P6. Free tiers usually deliver delayed prices. The UI must label data as delayed or real-time per provider, and show the timestamp of every price.
- P7. **[VERIFY]** Whether each provider's free tier includes Indian exchanges (NSE, BSE) and which other exchanges. The app must not advertise a market as supported unless the adapter's coverage descriptor says the user's tier supports it. Test with a real free key before finalizing the supported-markets list.
- P8. **[VERIFY]** Whether each provider permits direct browser calls (CORS). A provider that blocks browser requests cannot be used by the PWA and must be excluded or flagged.
- P9. **[VERIFY]** Each provider's terms regarding displaying data in an app. Display only, no redistribution.

### 3.1 Caching
- C1. Cache quotes, candles, and FX rates on-device with a per-type time-to-live based on the provider's rate limits and the market's open/closed state.
- C2. When the market is closed, do not refetch quotes more often than needed; the last close is the price.
- C3. Fetch only what is on screen or held in the portfolio. Never bulk-fetch.

---

## 4. Instruments and markets

- I1. An instrument is identified by the pair (symbol, exchange), never by symbol alone.
- I2. Instrument record fields: symbol, exchange, display name, native currency, asset type (stock, ETF, index), and provider-specific identifiers.
- I3. Supported asset types in v1: stocks and ETFs. Indices are handled as follows: tradeable ETF proxies (e.g. an S&P 500 ETF) are always available; real index quotes are shown as read-only reference data where the provider supports them. Real indices are not tradeable directly.
- I4. Target markets: US, India, and other international exchanges, limited to what the user's provider and tier actually cover (see P7).
- I5. Fractional shares: **not** supported in v1. Quantities are whole shares. (Rationale: simpler, matches most real-world Indian market behavior.)

---

## 5. Wallet and currency

### 5.1 Base currency
- W1. At setup the user chooses a **base currency** (e.g. INR, USD, EUR) and a **starting balance** in that currency. The starting balance is user-chosen with sensible presets.
- W2. The wallet is single-currency. All cash is held in the base currency.
- W3. The base currency can be changed later for **display only**. The ledger keeps its original recorded values, and display values are re-converted using live FX. No ledger rewriting.

### 5.2 Money precision
- W4. All money is stored as integers in minor units (e.g. paise, cents) or with a decimal library. Floating-point numbers must never be used for balances, prices multiplied by quantities, or P&L.
- W5. Define a single rounding rule (round half to even, or half up; pick one and apply it everywhere) and document it in code comments and tests.

### 5.3 Currency conversion
- F1. Every instrument has a native currency. All displayed prices, values, and totals are converted to the base currency using **live FX rates**.
- F2. FX rates come from the provider adapter (forex capability). Cache rates with a short TTL.
- F3. If an FX rate is unavailable or stale beyond a threshold, the UI must show the last known rate with a stale marker, and trading in instruments requiring that rate is blocked until a fresh rate is obtained.
- F4. **Amount paid:** When an order fills, record the exact base-currency amount debited or credited, the native price, the quantity, and the FX rate used. This recorded amount is the basis for P&L so that P&L always reconciles with the wallet balance.
- F5. Optional teaching feature: split P&L into a "price effect" (change in native price) and a "currency effect" (change in FX since purchase).
- F6. Under Realism Mode (on by default), apply a small configurable FX spread at conversion time and show it explicitly on the trade ticket.

---

## 6. Simulation engine

### 6.1 Entities
- **Account**: id, base currency, starting balance, creation date, settings (Realism Mode on/off, cost presets, spread and slippage settings, tax country preset).
- **Order**: id, instrument, side (buy/sell), type (market in M1; limit/stop in M3), quantity, status, created time, fill time, fill details.
- **Fill / Trade**: order id, instrument, side, quantity, native price, native currency, FX rate, base-currency amount, fees, timestamp.
- **Position**: instrument, quantity, average cost in base currency (derived from fills), realized P&L accumulated.
- **Snapshot**: date, cash, positions market value, total value, FX rates used.
- **Price/FX cache** and **Instrument** records as described above.

### 6.2 Order rules
- E1. Buy orders require sufficient cash (including any fees). Otherwise reject with a clear message.
- E2. Sell orders require sufficient held quantity. No shorting.
- E3. Market orders fill at the latest available price. If the market is open, that is the latest quote. If closed, the order is **queued** and fills at the next open price (see 6.4).
- E4. Fills are final and immutable. Corrections happen only through new offsetting trades, never edits.
- E5. Trading costs are applied at fill per Realism Mode (section 6.6) and included in the recorded base-currency amount.

### 6.3 Valuation and P&L
- V1. Total value = cash + sum over positions of (quantity × current native price × live FX to base).
- V2. Unrealized P&L per position = current market value in base currency minus the recorded base-currency cost of the position.
- V3. Realized P&L is booked on sells using **average-cost** accounting (one method, applied consistently; document it).
- V4. Portfolio P&L over time is computed from snapshots.
- V5. All totals must reconcile: starting balance + total realized P&L + total unrealized P&L − total fees = current total value. Include an internal consistency check that can be run in tests and in a debug view.

### 6.4 Serverless reconstruction (no background jobs)
Because nothing runs while the app is closed, state is reconstructed on app open:
- R1. **Snapshots:** On open, determine which daily snapshots are missing since the last one and backfill them using historical daily candles and historical FX for those dates.
- R2. **Queued market orders:** Fill them at the first available opening price after they were placed, using candle data for the instrument's exchange, in chronological order.
- R3. **Limit and stop orders (M3):** Evaluate against candle high/low data since the last open to determine whether and when the condition would have triggered, filling at the trigger price per documented rules, in chronological order.
- R4. If candle data needed for reconstruction is unavailable (rate limit, API error), leave the order queued and show a clear "waiting for data" state. Never guess a fill.
- R5. Reconstruction must be deterministic: running it twice on the same inputs produces the same result and never double-fills.

### 6.5 Market calendar
- M1. Maintain per-exchange trading hours, time zone, and holiday calendar. Source: a bundled static table for supported exchanges, updatable via app releases. **[VERIFY]** whether a provider endpoint can supply holidays instead.
- M2. The UI shows each instrument's market status (open, closed, pre/post) and the next open time in the user's local time.
- M3. Orders placed while closed show a clear "will fill at next open" notice.

### 6.6 Realism Mode

Purpose: make the simulation match real trading closely enough that a user who later trades with real money is not surprised by costs, rules, or taxes.

- RM1. Realism Mode is **on by default** and can be toggled in settings. When off, costs, spreads, and taxes are zero and results are labeled "idealized".
- RM2. **Trading costs.** Per-market cost presets covering brokerage, exchange and regulatory charges, transaction taxes, and other levies. All values are configuration data, not hardcoded; each preset records its source and date and is user-editable. Costs are shown itemized on the trade ticket and recorded on every fill. **[VERIFY]** current rates for each supported market at build time.
- RM3. **Spread and slippage.** Buys fill at the ask and sells at the bid when the provider supplies them; otherwise apply a configurable default spread per market. Apply a simple, documented slippage model that grows with order size relative to traded volume.
- RM4. **Order types.** Market, limit, stop, and stop-limit, with day and good-till-cancelled durations, each with a plain-language explanation. (Reconstruction rules in 6.4 apply.)
- RM5. **Settlement.** Proceeds from sales become usable after a market-specific settlement period (configurable). Show settled and unsettled cash separately. **[VERIFY]** settlement cycles per market.
- RM6. **Market rules.** Enforce lot sizes, tick sizes, price bands or circuit limits, and trading halts where data is available. Orders that break a rule are rejected with an explanation. **[VERIFY]** which of these the providers expose.
- RM7. **Corporate actions.** Handle cash dividends (credited on the payment date, converted at the live rate, with the converted amount recorded), splits, and bonus issues, adjusting positions and cost basis. If a provider does not expose an action, flag the affected positions rather than guess. **[VERIFY]** provider endpoints.
- RM8. **Tax estimation.** Track holding periods per purchase lot and estimate capital-gains tax using per-country configuration (short-term vs long-term treatment, rates, and any exemptions). Estimates appear in a report and are not deducted from the wallet unless the user enables that setting. **[VERIFY]** current rules and rates at build time, since they change.
- RM9. **Decision tools.** A trade journal (reason for entry, thesis, exit plan, reviewed later against the outcome), a position-size calculator (percent of wallet at risk), and concentration warnings.
- RM10. **Cost and return report.** Break down gross return versus costs, taxes, and currency effect.
- RM11. **Readiness checklist.** An educational, non-prescriptive page on what differs in real trading (liquidity, emotions under real losses, broker platforms, account opening and identity checks, taxes) and a suggestion to start small. It must never tell a user they are "ready" and must repeat the disclaimers in D1 and D2.
- RM12. **Known limits statement.** State in-app that data may be delayed, simulated fills are more optimistic than real markets, a simulation cannot reproduce the pressure of real losses, and all estimates may differ from reality.

---

## 7. Screens (mobile-first)

1. **Onboarding**: disclaimer, base currency, starting balance, provider choice, API key entry with a test-call to validate it, Realism Mode settings (on by default).
2. **Home / Portfolio**: total value, cash, day change, overall P&L, position list with per-position P&L, mini performance chart.
3. **Search**: instrument search across the provider's supported markets, with exchange and currency shown on each result.
4. **Instrument detail**: price, native currency and converted price, chart with range selector, market status, key stats the provider supplies, buy/sell buttons, glossary tooltips.
5. **Trade ticket**: side, quantity, estimated cost in native currency and base currency, FX rate used, itemized costs (RM2), spread/slippage estimate (RM3), position size as a percent of wallet (RM9), resulting cash after trade, confirm. Shows a queued-order notice when the market is closed.
6. **Orders and history**: open/queued orders, fills, filters.
7. **Performance**: portfolio value over time, comparison against a benchmark ETF, P&L breakdown (realized/unrealized, price/currency effect where enabled).
8. **Learn**: glossary and challenges (M4).
9. **Settings**: provider and key management, base currency (display), Realism Mode settings, export/import, reset account, disclaimer.

- U1. Reset account must require confirmation, and must offer an export first.
- U2. All price and value displays show their data timestamp or a freshness indicator.
- U3. Use locale-aware number and currency formatting (including lakh/crore grouping for INR).
- U4. Accessibility: touch targets, contrast, screen-reader labels, and color is never the only indicator of gain/loss.

---

## 8. Teaching layer (M4)

- T1. Glossary tooltips for core terms (bid/ask, market cap, P/E, volume, diversification, market order, limit order, stop order).
- T2. Guided challenges with automatic checking against portfolio state (e.g. hold positions across at least 3 sectors; place a first limit order).
- T3. Post-trade feedback highlighting concentration risk, trading costs, and FX effects, phrased as educational observations, not recommendations.
- T4. Benchmark comparison against an index ETF over the same period.
- T5. Content is static and bundled with the app, with no AI or network dependency.

---

## 9. Error handling and edge cases

- X1. API key invalid, expired, or rate-limited: clear message, guidance to fix, app remains usable with cached data.
- X2. Symbol delisted, renamed, or split: positions must continue to be valued from the last known price and flagged. **[VERIFY]** how each provider reports splits and adjusts historical candles; the engine must handle split adjustments for positions held across a split, or flag them for manual handling in v1.
- X3. Dividends and other corporate actions are handled per RM7. When a provider lacks the data, flag affected positions and state in the UI that total return may exclude dividends.
- X4. Data gaps or provider downtime: queue-and-wait behavior per R4; never fabricate prices.
- X5. Clock/timezone: store all timestamps in UTC; convert for display; handle device clock changes without corrupting reconstruction (use provider timestamps for fills).
- X6. Storage corruption or schema upgrade: versioned schema with migrations; on failure, offer export of raw data before any destructive action.

---

## 10. Security and privacy

- S1. No analytics or tracking by default. No data leaves the device except calls to the user's chosen data provider.
- S2. API keys are held in the most secure on-device storage available and never appear in URLs that get logged by the app; note that on web, keys sent as query parameters to providers are visible in the user's own network tools, which is acceptable because the key is theirs.
- S3. Warn users in onboarding that their API key lives in their device and not to use a key tied to a paid plan they would not want exposed on a shared device.

---

## 11. Testing requirements

- TST1. Unit tests for the simulation engine: order validation, fills, average-cost P&L, rounding, reconciliation identity (V5) across randomized trade sequences.
- TST2. Tests for FX: conversion correctness, recorded-rate behavior, stale-rate blocking, base-currency display change.
- TST3. Tests for reconstruction: determin