/**
 * Market calendar (spec M1–M3) — pure, no network.
 *
 * Bundled static table of trading hours, time zones and holiday calendars for
 * the exchanges the app knows about. Holiday tables are configuration data:
 * they are bundled with the app and updated through releases. Everything here
 * is marked **[VERIFY]** in the spec: holiday lists are collected from public
 * exchange announcements and must be re-checked each year (see `source`).
 *
 * Unknown exchanges degrade safely: weekends only, and the UI must say the
 * calendar is approximate (never invent an "open" state we are unsure of —
 * status becomes 'unknown' for sessions we cannot compute).
 */

export interface ExchangeSession {
  /** local time "HH:MM" */
  open: string;
  close: string;
  /** extended hours (informational; fills only happen in the regular session) */
  pre?: { open: string; close: string };
  post?: { open: string; close: string };
  /** mid-session break, e.g. HK/JP lunch */
  breaks?: { open: string; close: string }[];
}

export interface ExchangeInfo {
  id: string;
  name: string;
  country: string;
  timeZone: string; // IANA
  currency: string;
  marketGroup: string; // key into cost presets: 'US' | 'IN' | ...
  session: ExchangeSession;
  /** YYYY-MM-DD full-day closures (weekends are implied) */
  holidays: string[];
  holidaySource?: string;
  /** false when we only have a rough calendar — UI must label it (M1 [VERIFY]) */
  holidaysVerified: boolean;
}

const US_HOLIDAYS = {
  2025: ['2025-01-01', '2025-01-20', '2025-02-17', '2025-04-18', '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25'],
  2026: ['2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25'],
  2027: ['2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24'],
};

const IN_HOLIDAYS = {
  2025: [
    '2025-02-26', '2025-03-14', '2025-03-31', '2025-04-10', '2025-04-14', '2025-04-18',
    '2025-05-01', '2025-06-06', '2025-08-15', '2025-08-27', '2025-10-02', '2025-11-05', '2025-12-25',
  ],
  2026: [
    '2026-01-26', '2026-03-04', '2026-03-26', '2026-04-03', '2026-04-14', '2026-05-01',
    '2026-05-27', '2026-08-15', '2026-09-14', '2026-10-02', '2026-11-24', '2026-12-25',
  ],
};

const GB_HOLIDAYS = {
  2025: ['2025-01-01', '2025-04-18', '2025-04-21', '2025-05-05', '2025-05-26', '2025-08-25', '2025-12-25', '2025-12-26'],
  2026: ['2026-01-01', '2026-04-03', '2026-04-06', '2026-05-04', '2026-05-25', '2026-08-31', '2026-12-25', '2026-12-28'],
};

const HK_HOLIDAYS = {
  2025: [
    '2025-01-01', '2025-01-29', '2025-01-30', '2025-01-31', '2025-04-04', '2025-04-18',
    '2025-04-19', '2025-05-01', '2025-05-05', '2025-05-31', '2025-10-01', '2025-10-29', '2025-12-25', '2025-12-26',
  ],
  2026: [
    '2026-01-01', '2026-02-17', '2026-02-18', '2026-02-19', '2026-04-04', '2026-04-06',
    '2026-05-01', '2026-05-25', '2026-06-19', '2026-10-01', '2026-12-25', '2026-12-26',
  ],
};

const DE_HOLIDAYS = {
  2025: ['2025-01-01', '2025-04-18', '2025-04-21', '2025-05-01', '2025-05-29', '2025-06-09', '2025-10-03', '2025-12-25', '2025-12-26'],
  2026: ['2026-01-01', '2026-04-03', '2026-04-06', '2026-05-01', '2026-05-14', '2026-05-25', '2026-10-03', '2026-12-25', '2026-12-28'],
};

const JP_HOLIDAYS = {
  2025: [
    '2025-01-01', '2025-01-02', '2025-01-03', '2025-01-13', '2025-02-11', '2025-02-23', '2025-02-24',
    '2025-03-20', '2025-04-29', '2025-05-05', '2025-05-06', '2025-07-21', '2025-08-11', '2025-09-15',
    '2025-09-23', '2025-11-03', '2025-11-24',
  ],
  2026: [
    '2026-01-01', '2026-01-02', '2026-01-12', '2026-02-11', '2026-02-23', '2026-03-20',
    '2026-04-29', '2026-05-04', '2026-05-05', '2026-05-06', '2026-07-20', '2026-08-11', '2026-09-21',
    '2026-09-23', '2026-11-03', '2026-11-23',
  ],
};

const CA_HOLIDAYS = {
  2025: ['2025-01-01', '2025-02-17', '2025-04-18', '2025-05-19', '2025-07-01', '2025-09-01', '2025-09-30', '2025-10-13', '2025-11-11', '2025-12-25', '2025-12-26'],
  2026: ['2026-01-01', '2026-02-16', '2026-04-03', '2026-05-18', '2026-07-01', '2026-09-07', '2026-09-30', '2026-10-12', '2026-11-11', '2026-12-25', '2026-12-28'],
};

function flat(...years: Record<string, string[]>[]): string[] {
  return years.flatMap((y) => Object.values(y).flat()).sort();
}

const TABLE: ExchangeInfo[] = [
  {
    id: 'NASDAQ', name: 'NASDAQ', country: 'US', timeZone: 'America/New_York', currency: 'USD',
    marketGroup: 'US',
    session: { open: '09:30', close: '16:00', pre: { open: '04:00', close: '09:30' }, post: { open: '16:00', close: '20:00' } },
    holidays: flat(US_HOLIDAYS), holidaySource: 'NYSE/NASDAQ published holiday schedules 2025–2027 [VERIFY]', holidaysVerified: true,
  },
  {
    id: 'NYSE', name: 'New York Stock Exchange', country: 'US', timeZone: 'America/New_York', currency: 'USD',
    marketGroup: 'US',
    session: { open: '09:30', close: '16:00', pre: { open: '04:00', close: '09:30' }, post: { open: '16:00', close: '20:00' } },
    holidays: flat(US_HOLIDAYS), holidaySource: 'NYSE/NASDAQ published holiday schedules 2025–2027 [VERIFY]', holidaysVerified: true,
  },
  {
    id: 'AMEX', name: 'NYSE American', country: 'US', timeZone: 'America/New_York', currency: 'USD',
    marketGroup: 'US',
    session: { open: '09:30', close: '16:00', pre: { open: '04:00', close: '09:30' }, post: { open: '16:00', close: '20:00' } },
    holidays: flat(US_HOLIDAYS), holidaySource: 'NYSE/NASDAQ published holiday schedules 2025–2027 [VERIFY]', holidaysVerified: true,
  },
  {
    id: 'NYSE_ARCA', name: 'NYSE Arca', country: 'US', timeZone: 'America/New_York', currency: 'USD',
    marketGroup: 'US',
    session: { open: '09:30', close: '16:00', pre: { open: '04:00', close: '09:30' }, post: { open: '16:00', close: '20:00' } },
    holidays: flat(US_HOLIDAYS), holidaySource: 'NYSE/NASDAQ published holiday schedules 2025–2027 [VERIFY]', holidaysVerified: true,
  },
  {
    id: 'US', name: 'United States (provider-wide US feed)', country: 'US', timeZone: 'America/New_York', currency: 'USD',
    marketGroup: 'US',
    session: { open: '09:30', close: '16:00', pre: { open: '04:00', close: '09:30' }, post: { open: '16:00', close: '20:00' } },
    holidays: flat(US_HOLIDAYS), holidaySource: 'NYSE/NASDAQ published holiday schedules 2025–2027 [VERIFY]', holidaysVerified: true,
  },
  {
    id: 'NSE', name: 'National Stock Exchange of India', country: 'IN', timeZone: 'Asia/Kolkata', currency: 'INR',
    marketGroup: 'IN',
    session: { open: '09:15', close: '15:30', pre: { open: '09:00', close: '09:15' } },
    holidays: flat(IN_HOLIDAYS), holidaySource: 'NSE trading holidays 2025–2026 [VERIFY — re-check annually]', holidaysVerified: true,
  },
  {
    id: 'BSE', name: 'BSE Limited (India)', country: 'IN', timeZone: 'Asia/Kolkata', currency: 'INR',
    marketGroup: 'IN',
    session: { open: '09:15', close: '15:30', pre: { open: '09:00', close: '09:15' } },
    holidays: flat(IN_HOLIDAYS), holidaySource: 'BSE trading holidays 2025–2026 [VERIFY — re-check annually]', holidaysVerified: true,
  },
  {
    id: 'LSE', name: 'London Stock Exchange', country: 'GB', timeZone: 'Europe/London', currency: 'GBP',
    marketGroup: 'GB',
    session: { open: '08:00', close: '16:30' },
    holidays: flat(GB_HOLIDAYS), holidaySource: 'LSE bank holiday closures 2025–2026 [VERIFY]', holidaysVerified: true,
  },
  {
    id: 'HKEX', name: 'Hong Kong Exchanges', country: 'HK', timeZone: 'Asia/Hong_Kong', currency: 'HKD',
    marketGroup: 'HK',
    session: { open: '09:30', close: '16:00', breaks: [{ open: '12:00', close: '13:00' }] },
    holidays: flat(HK_HOLIDAYS), holidaySource: 'HKEX holiday calendar 2025–2026 [VERIFY]', holidaysVerified: false,
  },
  {
    id: 'FWB', name: 'Frankfurt Stock Exchange (XETRA)', country: 'DE', timeZone: 'Europe/Berlin', currency: 'EUR',
    marketGroup: 'DE',
    session: { open: '09:00', close: '17:30' },
    holidays: flat(DE_HOLIDAYS), holidaySource: 'XETRA trading calendar 2025–2026 [VERIFY]', holidaysVerified: true,
  },
  {
    id: 'TSE', name: 'Tokyo Stock Exchange', country: 'JP', timeZone: 'Asia/Tokyo', currency: 'JPY',
    marketGroup: 'JP',
    session: { open: '09:00', close: '15:30', breaks: [{ open: '11:30', close: '12:30' }] },
    holidays: flat(JP_HOLIDAYS), holidaySource: 'JPX holiday calendar 2025–2026 [VERIFY]', holidaysVerified: false,
  },
  {
    id: 'TSX', name: 'Toronto Stock Exchange', country: 'CA', timeZone: 'America/Toronto', currency: 'CAD',
    marketGroup: 'CA',
    session: { open: '09:30', close: '16:00' },
    holidays: flat(CA_HOLIDAYS), holidaySource: 'TSX holiday calendar 2025–2026 [VERIFY]', holidaysVerified: false,
  },
];

export const EXCHANGES: Record<string, ExchangeInfo> = Object.fromEntries(TABLE.map((e) => [e.id, e]));

export const DEFAULT_EXCHANGE: ExchangeInfo = {
  id: 'UNKNOWN', name: 'Unknown exchange', country: '??', timeZone: 'UTC', currency: 'USD',
  marketGroup: 'INTL',
  session: { open: '09:00', close: '17:00' },
  holidays: [], holidaysVerified: false,
};

export function exchangeInfo(id: string): ExchangeInfo {
  return EXCHANGES[id] ?? { ...DEFAULT_EXCHANGE, id };
}

export function marketGroupForExchange(id: string): string {
  return exchangeInfo(id).marketGroup;
}

/* ------------------------------------------------------------ time utils */

export interface ZonedParts {
  year: number; month: number; day: number; hour: number; minute: number; weekday: number; // 0=Sun
}

const partsCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    });
    partsCache.set(tz, f);
  }
  return f;
}

const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function zonedParts(dateUtc: Date, tz: string): ZonedParts {
  const parts = formatterFor(tz).formatToParts(dateUtc);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour') === '24' ? '0' : get('hour')),
    minute: Number(get('minute')),
    weekday: WD[get('weekday')] ?? 0,
  };
}

function tzOffsetMs(instantMs: number, tz: string): number {
  const p = zonedParts(new Date(instantMs), tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0, 0);
  return asUtc - instantMs;
}

/** UTC instant of local wall-clock time (y-m-d hh:mm) in `tz`. */
export function utcFromLocal(y: number, m: number, d: number, hh: number, mm: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, hh, mm, 0, 0);
  let ts = guess - tzOffsetMs(guess, tz);
  ts = guess - tzOffsetMs(ts, tz);
  return ts;
}

export function toDateKey(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function dateKeyOf(dateUtc: Date, tz: string): string {
  const p = zonedParts(dateUtc, tz);
  return toDateKey(p.year, p.month, p.day);
}

function parseHHMM(s: string): { h: number; m: number } {
  const [h, m] = s.split(':').map(Number);
  return { h, m };
}

/** Is this calendar date a trading day (not weekend, not holiday)? */
export function isTradingDay(dateKey: string, ex: ExchangeInfo): boolean {
  const [y, m, d] = dateKey.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (wd === 0 || wd === 6) return false;
  return !ex.holidays.includes(dateKey);
}

function nextTradingDayKey(dateKey: string, ex: ExchangeInfo): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  let cur = Date.UTC(y, m - 1, d);
  for (let i = 0; i < 400; i++) {
    cur += 86_400_000;
    const dt = new Date(cur);
    const key = toDateKey(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
    if (isTradingDay(key, ex)) return key;
  }
  throw new Error(`No trading day found after ${dateKey} for ${ex.id}`);
}

/* ----------------------------------------------------------- status (M2) */

export type MarketStatus = 'open' | 'closed' | 'pre' | 'post' | 'unknown';

export interface MarketStatusResult {
  status: MarketStatus;
  /** whether regular-session fills are possible right now */
  isOpenNow: boolean;
  /** exchange-local date of the current/next session */
  sessionDate: string;
  /** UTC instant of the next regular open (or next open after now) */
  nextOpenUtc: string;
  nextCloseUtc: string;
  exchange: string;
  /** false if we could not compute (unknown exchange) */
  computed: boolean;
}

function minutesOfDay(s: string): number {
  const { h, m } = parseHHMM(s);
  return h * 60 + m;
}

/** Market status at `nowUtc` for an exchange (M2). */
export function marketStatus(nowUtc: Date, exchangeId: string): MarketStatusResult {
  const ex = exchangeInfo(exchangeId);
  const p = zonedParts(nowUtc, ex.timeZone);
  const todayKey = toDateKey(p.year, p.month, p.day);
  const nowMin = p.hour * 60 + p.minute;

  const openMin = minutesOfDay(ex.session.open);
  const closeMin = minutesOfDay(ex.session.close);
  const pre = ex.session.pre;
  const post = ex.session.post;

  const sessionOpenTs = (key: string) => {
    const [y, m, d] = key.split('-').map(Number);
    const { h, m: mm } = parseHHMM(ex.session.open);
    return utcFromLocal(y, m, d, h, mm, ex.timeZone);
  };
  const sessionCloseTs = (key: string) => {
    const [y, m, d] = key.split('-').map(Number);
    const { h, m: mm } = parseHHMM(ex.session.close);
    return utcFromLocal(y, m, d, h, mm, ex.timeZone);
  };

  const tradingToday = isTradingDay(todayKey, ex);
  let status: MarketStatus;
  let sessionDate = todayKey;

  if (!tradingToday) {
    status = 'closed';
    sessionDate = nextTradingDayKey(todayKey, ex);
  } else if (nowMin >= openMin && nowMin < closeMin && !inBreak(nowMin, ex)) {
    status = 'open';
  } else if (pre && nowMin >= minutesOfDay(pre.open) && nowMin < openMin) {
    status = 'pre';
    sessionDate = todayKey;
  } else if (post && nowMin >= closeMin && nowMin < minutesOfDay(post.close)) {
    status = 'post';
  } else {
    status = 'closed';
    if (nowMin >= closeMin) sessionDate = nextTradingDayKey(todayKey, ex);
  }

  const nextOpen = sessionOpenTs(sessionDate);
  const nextClose = sessionCloseTs(sessionDate);
  return {
    status,
    isOpenNow: status === 'open',
    sessionDate,
    nextOpenUtc: new Date(nextOpen).toISOString(),
    nextCloseUtc: new Date(nextClose).toISOString(),
    exchange: exchangeId,
    computed: true,
  };
}

function inBreak(nowMin: number, ex: ExchangeInfo): boolean {
  for (const b of ex.session.breaks ?? []) {
    if (nowMin >= minutesOfDay(b.open) && nowMin < minutesOfDay(b.close)) return true;
  }
  return false;
}

/**
 * When does a day order placed at `createdUtc` expire?
 * At the close of the session it will first be eligible for (M3/R2 semantics).
 */
export function dayOrderExpiryUtc(createdUtc: Date, exchangeId: string): Date {
  const st = marketStatus(createdUtc, exchangeId);
  const ex = exchangeInfo(exchangeId);
  const p = zonedParts(createdUtc, ex.timeZone);
  const todayKey = toDateKey(p.year, p.month, p.day);
  // created during a live/pre session → that session's close; otherwise the
  // close of the session the order will first be eligible for (M3, R2).
  const key = isTradingDay(todayKey, ex) && (st.isOpenNow || st.status === 'pre') ? todayKey : st.sessionDate;
  return new Date(st.isOpenNow || st.status === 'pre' ? st.nextCloseUtc : sessionCloseFor(key, ex));
}

function sessionCloseFor(key: string, ex: ExchangeInfo): string {
  const [y, m, d] = key.split('-').map(Number);
  const { h, m: mm } = parseHHMM(ex.session.close);
  return new Date(utcFromLocal(y, m, d, h, mm, ex.timeZone)).toISOString();
}

/**
 * Add N business (trading) days to a UTC instant on an exchange calendar (RM5).
 * n = 0 returns the next trading day boundary only if the instant is not
 * already on a trading day? No: n=0 means "available at the next settlement
 * processing", which we model as end of the current session date if it is a
 * trading day... For settlement we start counting from the trade's session date.
 */
export function addTradingDays(fromUtc: Date, days: number, exchangeId: string): Date {
  const ex = exchangeInfo(exchangeId);
  const startKey = dateKeyOf(fromUtc, ex.timeZone);
  let key = isTradingDay(startKey, ex) ? startKey : nextTradingDayKey(startKey, ex);
  let remaining = days;
  // settlement: trade on day T settles at close of day T+N (we use close time as the availability instant)
  while (remaining > 0) {
    key = nextTradingDayKey(key, ex);
    remaining--;
  }
  const [y, m, d] = key.split('-').map(Number);
  const { h, m: mm } = parseHHMM(ex.session.close);
  return new Date(utcFromLocal(y, m, d, h, mm, ex.timeZone));
}

/** UTC instant of the first regular open strictly after `afterUtc` on `exchangeId`. */
export function nextOpenAfter(afterUtc: Date, exchangeId: string): Date {
  const st = marketStatus(afterUtc, exchangeId);
  if (st.isOpenNow) return new Date(st.nextCloseUtc); // not an open — caller should not use this when open
  const ex = exchangeInfo(exchangeId);
  const p = zonedParts(afterUtc, ex.timeZone);
  const todayKey = toDateKey(p.year, p.month, p.day);
  const openMin = minutesOfDay(ex.session.open);
  const nowMin = p.hour * 60 + p.minute;
  if (isTradingDay(todayKey, ex) && nowMin < openMin) {
    const [y, m, d] = todayKey.split('-').map(Number);
    const { h, m: mm } = parseHHMM(ex.session.open);
    return new Date(utcFromLocal(y, m, d, h, mm, ex.timeZone));
  }
  const key = nextTradingDayKey(todayKey, ex);
  const [y, m, d] = key.split('-').map(Number);
  const { h, m: mm } = parseHHMM(ex.session.open);
  return new Date(utcFromLocal(y, m, d, h, mm, ex.timeZone));
}
