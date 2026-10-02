/**
 * Guided challenges with automatic checking against portfolio state (T2).
 * Pure predicates over AppState — evaluated after every state change and the
 * completion timestamp is stored in `challengeProgress`.
 */

import { instrumentId, type AppState } from '../engine/types';

export interface Challenge {
  id: string;
  title: string;
  description: string;
  hint: string;
  check: (state: AppState) => boolean;
}

export const CHALLENGES: Challenge[] = [
  {
    id: 'first_trade',
    title: 'Make your first trade',
    description: 'Buy any instrument to start your simulated portfolio.',
    hint: 'Search for a company or ETF, open it, and use the Buy button on the trade ticket.',
    check: (s) => s.fills.some((f) => f.side === 'buy'),
  },
  {
    id: 'first_limit_order',
    title: 'Place a limit order',
    description: 'Use a limit order instead of a market order — decide your own price.',
    hint: 'On the trade ticket choose “Limit”, set a price, and confirm. It may queue until the price is reached.',
    check: (s) => s.orders.some((o) => o.type === 'limit' || o.type === 'stop_limit'),
  },
  {
    id: 'diversify',
    title: 'Hold across 3 sectors (or 3 exchanges)',
    description: 'Spread risk: positions in at least 3 different sectors — or, when sector data is unavailable, on 3 different exchanges.',
    hint: 'Search instruments from different industries or markets and buy a small number of shares in each.',
    check: (s) => {
      const held = s.positions.filter((p) => p.qty > 0);
      const sectors = new Set(held.map((p) => p.instrument.sector).filter((x): x is string => !!x && x.length > 0));
      if (sectors.size >= 3) return true;
      if (held.some((p) => !p.instrument.sector)) {
        const exchanges = new Set(held.map((p) => p.instrument.exchange));
        return exchanges.size >= 3;
      }
      return false;
    },
  },
  {
    id: 'cross_currency',
    title: 'Trade across currencies',
    description: 'Hold at least one instrument priced in a currency other than your base currency.',
    hint: 'If your base is USD, try an Indian or European stock — watch how FX affects value.',
    check: (s) => {
      const base = s.account?.baseCurrency;
      if (!base) return false;
      return s.positions.some((p) => p.qty > 0 && p.instrument.currency !== base);
    },
  },
  {
    id: 'close_a_position',
    title: 'Close a position',
    description: 'Sell everything you hold in one instrument and see realized P&L booked.',
    hint: 'Open a position you hold and use Sell on the trade ticket.',
    check: (s) => s.positions.some((p) => p.qty === 0 && s.fills.some((f) => instrumentId(f.instrument) === instrumentId(p.instrument))),
  },
  {
    id: 'write_journal',
    title: 'Write a trade journal entry',
    description: 'Record why you entered, your thesis and an exit plan before the outcome is known.',
    hint: 'Open Learn → Journal (or the instrument screen) and save an entry.',
    check: (s) => s.journal.length >= 1,
  },
  {
    id: 'export_backup',
    title: 'Back up your account',
    description: 'Export your account to a JSON file — the only backup mechanism (there is no server).',
    hint: 'Settings → Export & import → Export JSON.',
    check: (s) => !!s.meta.exportedAtUtc,
  },
  {
    id: 'place_sell_stop',
    title: 'Protect a position with a stop order',
    description: 'Place a stop (stop-loss) sell order for a holding.',
    hint: 'On the trade ticket choose “Stop” and set the trigger price below the current price.',
    check: (s) => s.orders.some((o) => o.type === 'stop' || o.type === 'stop_limit'),
  },
];

export function evaluateChallenges(state: AppState): { progress: Record<string, string>; newlyCompleted: Challenge[] } {
  const progress = { ...state.challengeProgress };
  const newlyCompleted: Challenge[] = [];
  const now = new Date().toISOString();
  for (const c of CHALLENGES) {
    if (progress[c.id]) continue;
    let done = false;
    try {
      done = c.check(state);
    } catch {
      done = false; // a broken predicate never crashes the app
    }
    if (done) {
      progress[c.id] = now;
      newlyCompleted.push(c);
    }
  }
  return { progress, newlyCompleted };
}
