/**
 * Provider registry (P1/P4). Keys always come from the caller — the app
 * bundle contains no keys (P1).
 */

import { createFinnhub } from './finnhub';
import { createTwelveData } from './twelvedata';
import type { ProviderAdapter, ProviderId } from './provider';

export const PROVIDER_LIST: { id: ProviderId; name: string; blurb: string }[] = [
  {
    id: 'twelvedata',
    name: 'Twelve Data (default)',
    blurb: 'One key for stocks, ETFs and forex across many exchanges — US, India and international. Free tier is delayed, 8 requests/min.',
  },
  {
    id: 'finnhub',
    name: 'Finnhub',
    blurb: 'Strongest for US markets: quotes, dividends and splits. Free tier 60 requests/min. Limited non-US coverage.',
  },
];

export function makeAdapter(id: ProviderId, getKey: () => string | null): ProviderAdapter {
  return id === 'finnhub' ? createFinnhub({ getKey }) : createTwelveData({ getKey });
}
