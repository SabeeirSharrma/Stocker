/**
 * Provider registry (P1/P4). Keys always come from the caller — the app
 * bundle contains no keys (P1). `yfinance` needs no key at all.
 */

import { createFinnhub } from './finnhub';
import { createTwelveData } from './twelvedata';
import { createYfinance } from './yfinance';
import type { ProviderAdapter, ProviderId } from './provider';

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  blurb: string;
  /** false = no API key needed (yfinance); the UI hides the key field */
  requiresKey: boolean;
  /** shown to keyless providers instead of key help */
  keylessNote?: string;
}

export const PROVIDER_LIST: ProviderInfo[] = [
  {
    id: 'twelvedata',
    name: 'Twelve Data (default)',
    requiresKey: true,
    blurb: 'One key for stocks, ETFs and forex across many exchanges — US, India and international. Basic plan (free): 8 credits/min · 800/day · real-time US, forex and crypto.',
  },
  {
    id: 'finnhub',
    name: 'Finnhub',
    requiresKey: true,
    blurb: 'Strongest for US markets: quotes, dividends and splits. Free tier 60 requests/min. Limited non-US coverage.',
  },
  {
    id: 'yfinance',
    name: 'Yahoo Finance (no API key)',
    requiresKey: false,
    keylessNote: 'Data comes straight from Yahoo’s public endpoints — no sign-up, nothing stored. It is blocked in some plain browser tabs, and works natively in the Android app.',
    blurb: 'No API key or sign-up. Wide US and international coverage including dividends and splits. Works in the Android app; some browsers block it (CORS).',
  },
];

export function makeAdapter(id: ProviderId, getKey: () => string | null): ProviderAdapter {
  switch (id) {
    case 'finnhub':
      return createFinnhub({ getKey });
    case 'yfinance':
      return createYfinance();
    case 'twelvedata':
    default:
      return createTwelveData({ getKey });
  }
}
