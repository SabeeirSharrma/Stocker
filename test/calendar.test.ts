/** Calendar tests: M1 trading days/holidays, M2 status, M3 expiry, RM5 settlement. */
import { describe, it, expect } from 'vitest';
import {
  exchangeInfo,
  marketGroupForExchange,
  isTradingDay,
  marketStatus,
  dayOrderExpiryUtc,
  addTradingDays,
  nextOpenAfter,
  dateKeyOf,
} from '../src/calendar/calendar';

const NASDAQ = exchangeInfo('NASDAQ');
const NSE = exchangeInfo('NSE');

describe('exchange table (M1)', () => {
  it('known exchanges resolve with sessions, currency and holidays', () => {
    expect(NASDAQ.timeZone).toBe('America/New_York');
    expect(NASDAQ.currency).toBe('USD');
    expect(NASDAQ.holidays.length).toBeGreaterThan(25); // 2025–2027
    expect(NASDAQ.holidaysVerified).toBe(true);
    expect(NSE.marketGroup).toBe('IN');
  });

  it('unknown exchanges degrade to a safe default (weekends only, INTL costs)', () => {
    const ex = exchangeInfo('BOGUS_EXCHANGE');
    expect(ex.id).toBe('BOGUS_EXCHANGE');
    expect(ex.holidays).toEqual([]);
    expect(ex.marketGroup).toBe('INTL');
    expect(ex.holidaysVerified).toBe(false); // UI must label it approximate
  });

  it('maps exchanges to cost-preset market groups', () => {
    expect(marketGroupForExchange('NASDAQ')).toBe('US');
    expect(marketGroupForExchange('NSE')).toBe('IN');
    expect(marketGroupForExchange('LSE')).toBe('GB');
    expect(marketGroupForExchange('whatever')).toBe('INTL');
  });
});

describe('trading days (M1)', () => {
  it('weekends are not trading days', () => {
    expect(isTradingDay('2025-06-07', NASDAQ)).toBe(false); // Saturday
    expect(isTradingDay('2025-06-08', NASDAQ)).toBe(false); // Sunday
    expect(isTradingDay('2025-06-06', NASDAQ)).toBe(true); // Friday
  });

  it('bundled holidays close the right exchanges only', () => {
    expect(isTradingDay('2025-07-04', NASDAQ)).toBe(false); // Independence Day
    expect(isTradingDay('2025-07-04', NSE)).toBe(true); // not an Indian holiday
    expect(isTradingDay('2025-08-15', NSE)).toBe(false); // Independence Day (IN)
    expect(isTradingDay('2025-08-15', NASDAQ)).toBe(true);
  });
});

describe('market status (M2)', () => {
  it('is open mid-session on a trading day', () => {
    const st = marketStatus(new Date('2025-06-04T15:00:00.000Z'), 'NASDAQ');
    expect(st.status).toBe('open');
    expect(st.isOpenNow).toBe(true);
    expect(st.sessionDate).toBe('2025-06-04');
    expect(st.nextOpenUtc).toBe('2025-06-04T13:30:00.000Z');
    expect(st.nextCloseUtc).toBe('2025-06-04T20:00:00.000Z');
  });

  it('reports pre- and post-market sessions', () => {
    expect(marketStatus(new Date('2025-06-04T13:00:00.000Z'), 'NASDAQ').status).toBe('pre'); // 09:00 ET
    expect(marketStatus(new Date('2025-06-04T21:00:00.000Z'), 'NASDAQ').status).toBe('post'); // 17:00 ET
  });

  it('is closed on weekends with the next session as sessionDate', () => {
    const st = marketStatus(new Date('2025-06-07T15:00:00.000Z'), 'NASDAQ');
    expect(st.status).toBe('closed');
    expect(st.sessionDate).toBe('2025-06-09'); // Monday
    expect(st.nextOpenUtc).toBe('2025-06-09T13:30:00.000Z');
  });

  it('is closed on holidays and skips to the next session', () => {
    const st = marketStatus(new Date('2025-07-04T15:00:00.000Z'), 'NASDAQ');
    expect(st.status).toBe('closed');
    expect(st.sessionDate).toBe('2025-07-07'); // Friday holiday → Monday
  });

  it('respects exchange time zones (NSE opens 09:15 IST = 03:45 UTC)', () => {
    expect(marketStatus(new Date('2025-06-04T04:00:00.000Z'), 'NSE').status).toBe('open');
    expect(marketStatus(new Date('2025-06-04T03:00:00.000Z'), 'NSE').status).not.toBe('open');
  });

  it('treats mid-session breaks as not-open (HKEX lunch)', () => {
    const st = marketStatus(new Date('2025-06-04T04:30:00.000Z'), 'HKEX'); // 12:30 HKT
    expect(st.isOpenNow).toBe(false);
  });
});

describe('day-order expiry (M3/RM4)', () => {
  it('placed during the session → expires at that session close', () => {
    const exp = dayOrderExpiryUtc(new Date('2025-06-04T15:00:00.000Z'), 'NASDAQ');
    expect(exp.toISOString()).toBe('2025-06-04T20:00:00.000Z');
  });

  it('placed while closed → expires at the close of the next session', () => {
    const exp = dayOrderExpiryUtc(new Date('2025-06-07T15:00:00.000Z'), 'NASDAQ'); // Saturday
    expect(exp.toISOString()).toBe('2025-06-09T20:00:00.000Z');
  });
});

describe('settlement arithmetic (RM5)', () => {
  it('T+1 from a Wednesday lands on Thursday close', () => {
    const t = addTradingDays(new Date('2025-06-04T15:00:00.000Z'), 1, 'NASDAQ');
    expect(t.toISOString()).toBe('2025-06-05T20:00:00.000Z');
  });

  it('skips weekends', () => {
    const t = addTradingDays(new Date('2025-06-06T15:00:00.000Z'), 1, 'NASDAQ'); // Friday → Monday
    expect(t.toISOString()).toBe('2025-06-09T20:00:00.000Z');
  });

  it('skips holidays', () => {
    const t = addTradingDays(new Date('2025-07-03T15:00:00.000Z'), 1, 'NASDAQ'); // Thu → Mon (Fri=July 4)
    expect(t.toISOString()).toBe('2025-07-07T20:00:00.000Z');
  });

  it('T+2 settles two sessions later', () => {
    const t = addTradingDays(new Date('2025-06-04T15:00:00.000Z'), 2, 'LSE'); // GB preset is T+2
    expect(t.toISOString()).toBe('2025-06-06T15:30:00.000Z'); // LSE closes 16:30 BST = 15:30 UTC
  });
});

describe('next open', () => {
  it('same day when before the open', () => {
    const t = nextOpenAfter(new Date('2025-06-04T12:00:00.000Z'), 'NASDAQ');
    expect(t.toISOString()).toBe('2025-06-04T13:30:00.000Z');
  });

  it('next trading day when after the close / weekend', () => {
    const sat = nextOpenAfter(new Date('2025-06-07T15:00:00.000Z'), 'NASDAQ');
    expect(sat.toISOString()).toBe('2025-06-09T13:30:00.000Z');
  });
});

describe('date keys across zones (X5)', () => {
  it('uses the exchange-local date', () => {
    expect(dateKeyOf(new Date('2025-06-04T02:00:00.000Z'), 'America/New_York')).toBe('2025-06-03');
    expect(dateKeyOf(new Date('2025-06-04T02:00:00.000Z'), 'Asia/Kolkata')).toBe('2025-06-04');
    expect(dateKeyOf(new Date('2025-06-04T02:00:00.000Z'), 'UTC')).toBe('2025-06-04');
  });
});
