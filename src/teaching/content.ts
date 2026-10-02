/**
 * Static teaching content (spec §8, D1–D5, RM11–RM12).
 * Bundled with the app — no AI, no network (T5).
 */

/* ------------------------------------------------------------- disclaimers (D1–D5) */

export const DISCLAIMER_FULL = `Stocker is an educational simulation.

• It is NOT financial, investment, tax or legal advice.
• It is a simulator only: NOT a broker, exchange or advisor. It is NOT approved,
  endorsed, licensed or regulated by any financial regulator or government
  agency. It places no real orders and uses no real money.
• All costs, taxes and rules shown are estimates based on configurable data and
  may differ from real-world outcomes.
• Market data belongs to its provider and is used per their terms. Data may be
  delayed.
• Nothing here is "official", "certified" or "approved", and this app has no
  affiliation with any regulator or government body.

Virtual money only. Past simulated performance does not predict real returns.`;

export const DISCLAIMER_SHORT =
  'Educational simulation — not financial advice. Not a broker, exchange or advisor; not regulated by any agency. Virtual money only.';

export const DISCLOSURE_DATA_LABEL =
  'Estimates based on configurable data — may differ from real-world outcomes.';

/* ------------------------------------------------------- known limits (RM12) */

export const KNOWN_LIMITS: { title: string; body: string }[] = [
  { title: 'Data may be delayed', body: 'Free data tiers usually deliver delayed prices (often 15 minutes). Every price shows its timestamp so you can see exactly how old it is.' },
  { title: 'Simulated fills are optimistic', body: 'Real markets have order-book depth, partial fills and fast moves. This simulator fills instantly at the candle price — real fills are often worse.' },
  { title: 'No real losses, no real pressure', body: 'A simulation cannot reproduce the stress of risking real money. Emotional discipline is the part no simulator can teach.' },
  { title: 'All estimates may differ from reality', body: 'Costs, taxes, settlement cycles and market rules change and vary by broker and jurisdiction. Treat every number here as an estimate (D5).' },
];

/* ------------------------------------------------- readiness checklist (RM11) */

export const READINESS_CHECKLIST: { area: string; points: string[] }[] = [
  {
    area: 'Liquidity and spreads',
    points: [
      'Large orders move prices; small-cap stocks can be hard to exit at the shown price.',
      'Spreads widen at open, close and during news — your fill may be worse than the simulator\'s.',
    ],
  },
  {
    area: 'Emotions under real losses',
    points: [
      'Losing virtual money is easy; losing money you need is not. Real losses change how you think.',
      'Have a plan for drawdowns before you risk anything real.',
    ],
  },
  {
    area: 'Broker platforms',
    points: [
      'Real brokers have order types, margin rules, fees and UI quirks this simulator does not fully model.',
      'Compare at least two brokers: fees, settlement, support and data quality.',
    ],
  },
  {
    area: 'Account opening and identity checks',
    points: [
      'Real accounts need identity verification (KYC), tax identifiers and bank links.',
      'Eligibility, minimum deposits and restrictions vary by country.',
    ],
  },
  {
    area: 'Taxes',
    points: [
      'Tax rules change and differ by residence, holding period and instrument.',
      'Keep records — real tax reporting is on you, not on this app.',
    ],
  },
];

export const READINESS_FOOTER = [
  'If you ever move to real markets, start small — an amount you can afford to lose — and treat it as tuition.',
  'This app never tells you that you are "ready". Only you, with advice from a licensed professional, can decide that.',
  'Reminder: this is an educational simulation. It is not financial, investment, tax or legal advice. It is NOT a broker, exchange or advisor, and it is NOT approved, endorsed, licensed or regulated by any financial regulator or government agency. No real orders. No real money.',
];

/* -------------------------------------------------- glossary (T1) */

export interface GlossaryEntry {
  id: string;
  term: string;
  short: string;
  body: string;
}

export const GLOSSARY: GlossaryEntry[] = [
  { id: 'bid_ask', term: 'Bid / Ask', short: 'Highest buyer price / lowest seller price', body: 'The bid is what buyers offer; the ask is what sellers want. Buys fill at the ask, sells at the bid — the gap is the spread, a cost you always pay.' },
  { id: 'market_cap', term: 'Market cap', short: 'Share price × total shares', body: 'The market\'s total valuation of a company. Large caps are usually steadier; small caps usually move more.' },
  { id: 'pe', term: 'P/E ratio', short: 'Price relative to earnings', body: 'Price per share ÷ earnings per share. A rough gauge of how much you pay for each unit of profit. Not a prediction.' },
  { id: 'volume', term: 'Volume', short: 'Shares traded in a period', body: 'Higher volume usually means easier entry/exit (liquidity). Thin volume means bigger spreads and sharper moves.' },
  { id: 'diversification', term: 'Diversification', short: 'Spreading risk across holdings', body: 'Holding different assets so one bad outcome does not sink the whole portfolio. It limits losses — and limits jackpots.' },
  { id: 'market_order', term: 'Market order', short: 'Buy/sell now at the best available price', body: 'Executes immediately when the market is open; while closed it queues for the next open. Fast, but the price is not guaranteed.' },
  { id: 'limit_order', term: 'Limit order', short: 'Buy/sell at a price you set (or better)', body: 'Only fills at your price or better. Safer than a market order — but it may never fill.' },
  { id: 'stop_order', term: 'Stop order', short: 'Triggers a market order at a price', body: 'Becomes a market order once the stop price is hit. Commonly used to limit a loss ("stop loss"). Gaps can fill far from the stop.' },
  { id: 'spread', term: 'Spread', short: 'Difference between bid and ask', body: 'An implicit cost: you buy at the ask and sell at the bid. In Realism Mode the simulator applies the real spread when available, or a default per market.' },
  { id: 'slippage', term: 'Slippage', short: 'Price moving against you while trading', body: 'Large orders relative to daily volume push the price. The simulator models this as basis points per share of daily volume used.' },
  { id: 'settlement', term: 'Settlement (T+1)', short: 'When sale proceeds become usable', body: 'After you sell, proceeds become spendable after the market\'s settlement cycle (typically 1 business day now). Until then the app shows them as pending.' },
  { id: 'fx', term: 'FX rate', short: 'Exchange rate between currencies', body: 'Foreign instruments are converted to your base currency at live rates. Exchange rates move — part of your P&L can come from currency, not price.' },
  { id: 'realized', term: 'Realized P&L', short: 'Profit/loss locked in by selling', body: 'Booked when you close (part of) a position, using average-cost accounting in this app.' },
  { id: 'unrealized', term: 'Unrealized P&L', short: 'Open profit/loss on paper', body: 'What your holdings would earn if sold at today\'s price. It becomes real only when you sell.' },
  { id: 'average_cost', term: 'Average cost', short: 'Average price paid per share', body: 'All buys blend into one average. When you sell, realized P&L uses this average — one method, applied consistently everywhere in the app.' },
  { id: 'tick', term: 'Tick size', short: 'Minimum price increment', body: 'Exchanges define the smallest price step (e.g. ₹0.05, $0.01). Orders off-tick are rejected.' },
  { id: 'price_band', term: 'Price band / circuit limit', short: 'Exchange limit on price moves', body: 'Exchanges throttle or halt instruments that move too far too fast. The simulator enforces an estimated band where configured.' },
  { id: 'gtc', term: 'Day vs GTC', short: 'Order duration', body: 'A day order expires at the session close; good-till-cancelled stays until filled or you cancel it.' },
  { id: 'dividend', term: 'Dividend', short: 'Cash paid to shareholders', body: 'On the payment date the simulator credits cash at the live FX rate — when the provider exposes dividends; otherwise positions are flagged.' },
  { id: 'split', term: 'Stock split', short: 'More shares at a proportionally lower price', body: 'Your quantity changes but the value stays the same. The simulator adjusts quantity and cost basis when the provider reports the split.' },
  { id: 'benchmark', term: 'Benchmark', short: 'A yardstick index/ETF', body: 'Comparing against an index ETF (like an S&P 500 fund) shows whether your choices beat simply holding the market.' },
  { id: 'concentration', term: 'Concentration', short: 'Too much in one position', body: 'When one position dominates your wallet, a single bad outcome dominates your portfolio. The app warns above 25% as an observation, not advice.' },
];

export function glossaryById(id: string): GlossaryEntry | undefined {
  return GLOSSARY.find((g) => g.id === id);
}
