/** Shared UI primitives: store hook, money/P&L display, freshness (U2),
 *  accessibility helpers (U4), SVG chart, nav chrome. Static content only (T5). */

import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { AppStore } from '../state/store';
import { formatMinor, formatNumber, formatPercent, toMajorString, CURRENCIES } from '../engine/money';
import { glossaryById } from '../teaching/content';
import type { Instrument } from '../engine/types';

/* ------------------------------------------------------------------- store */

export function useStore(store: AppStore): AppStore {
  useSyncExternalStore(
    useCallback((l: () => void) => store.subscribe(l), [store]),
    () => store.state,
    () => store.state,
  );
  return store;
}

/** Force a re-render on an interval (for quote timestamps / clocks). */
export function useForceUpdate(ms: number): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((v) => v + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

/* ------------------------------------------------------------------ money */

export interface MoneyProps {
  minor: number;
  currency: string;
  locale?: string;
  signed?: boolean;
  className?: string;
  withSymbol?: boolean;
}

/** Locale-aware money (U3). `signed` always prefixes + for positives (U4). */
export function Money({ minor, currency, locale, signed, className, withSymbol }: MoneyProps) {
  const body = formatMinor(minor, currency, { locale, withSymbol });
  const text = signed && minor > 0 ? `+${body}` : body;
  return <span className={`mono ${className ?? ''}`}>{text}</span>;
}

/** Sign + color: color is never the only indicator (U4). */
export function Pnl({ minor, currency, locale, className = '' }: { minor: number; currency: string; locale?: string; className?: string }) {
  const tone = minor > 0 ? 'up' : minor < 0 ? 'down' : 'flat';
  const sign = minor > 0 ? '▲ ' : minor < 0 ? '▼ ' : '';
  return (
    <span className={`mono ${tone} ${className}`}>
      {sign}
      <Money minor={minor} currency={currency} locale={locale} signed />
    </span>
  );
}

export function Percent({ value, className = '' }: { value: number; className?: string }) {
  const tone = value > 0 ? 'up' : value < 0 ? 'down' : 'flat';
  const sign = value > 0 ? '+' : '';
  return <span className={`mono ${tone} ${className}`}>{sign}{formatPercent(value)}</span>;
}

/* ------------------------------------------------------------- freshness (U2) */

export function Freshness({ atUtc, stale, delayed, provider }: { atUtc?: string | null; stale?: boolean; delayed?: boolean; provider?: string }) {
  if (!atUtc) return null;
  const t = new Date(atUtc);
  const when = isNaN(t.getTime()) ? '' : t.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return (
    <span className="tiny dim row" style={{ gap: 6, flexWrap: 'wrap' }} aria-label={`Data as of ${t.toLocaleString()}${stale ? ', stale' : ''}${delayed ? ', delayed' : ''}`}>
      <span>as of {when}</span>
      {stale && <span className="badge stale" title="Showing the last data we could fetch — not live">⚠ stale</span>}
      {delayed && <span className="badge warn">delayed</span>}
      {provider && <span className="badge">{provider}</span>}
    </span>
  );
}

export function SimulatedBadge() {
  return <span className="badge sim" title="Educational simulation — no real orders, no real money">Simulated</span>;
}

/* ------------------------------------------------------------- glossary (T1) */

/**
 * Glossary sheet state. A tiny module-level store so any `<Term>` anywhere can
 * open the shared explanation sheet without threading context through every
 * screen (T1 + U4: tapping a term must open its definition on touch devices,
 * where `title` tooltips never appear).
 */
type GlossaryListener = (id: string | null) => void;
let glossaryOpenId: string | null = null;
const glossaryListeners = new Set<GlossaryListener>();

function emitGlossary(): void {
  for (const l of glossaryListeners) l(glossaryOpenId);
}

/** Open the shared glossary sheet for a term id. */
export function openGlossary(id: string): void {
  glossaryOpenId = id;
  emitGlossary();
}

function closeGlossary(): void {
  glossaryOpenId = null;
  emitGlossary();
}

/** Close the shared glossary sheet (also bound to backdrop click / Esc). */
export { closeGlossary };

function subscribeGlossary(l: GlossaryListener): () => void {
  glossaryListeners.add(l);
  return () => glossaryListeners.delete(l);
}

/** Glossary term; tapping it opens a short explanation (T1). */
export function Term({ id, children }: { id: string; children?: ReactNode }) {
  const g = glossaryById(id);
  if (!g) return <>{children ?? id}</>;
  return (
    <button type="button" className="tooltip-term" onClick={() => openGlossary(id)} aria-haspopup="dialog">
      {children ?? g.term}
    </button>
  );
}

/** Shared bottom sheet that shows the currently opened glossary term. */
export function GlossarySheet() {
  const [openId, setOpenId] = useState<string | null>(glossaryOpenId);
  useEffect(() => subscribeGlossary(setOpenId), []);
  useEffect(() => {
    if (openId == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeGlossary();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openId]);

  const g = openId ? glossaryById(openId) : null;
  if (!g) return null;
  return (
    <div className="sheet-backdrop" role="dialog" aria-modal="true" aria-label={g.term} onClick={closeGlossary}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="row between">
          <h2>{g.term}</h2>
          <button className="btn ghost" style={{ minHeight: 36 }} onClick={closeGlossary} aria-label="Close definition">
            ✕
          </button>
        </div>
        <p className="small"><strong>{g.short}</strong></p>
        <p className="small dim" style={{ margin: 0 }}>{g.body}</p>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------- nav */

export type Tab = 'home' | 'search' | 'orders' | 'perf' | 'learn' | 'settings';

export function BottomNav({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void }) {
  const items: { id: Tab; label: string; ico: string }[] = [
    { id: 'home', label: 'Portfolio', ico: '◧' },
    { id: 'search', label: 'Search', ico: '⌕' },
    { id: 'orders', label: 'Orders', ico: '≣' },
    { id: 'perf', label: 'Stats', ico: '◔' },
    { id: 'learn', label: 'Learn', ico: '✦' },
    { id: 'settings', label: 'Settings', ico: '⚙' },
  ];
  return (
    <nav className="bottomnav" aria-label="Main">
      {items.map((it) => (
        <button key={it.id} aria-current={tab === it.id ? 'page' : undefined} onClick={() => onTab(it.id)}>
          <span className="ico" aria-hidden="true">{it.ico}</span>
          <span>{it.label}</span>
        </button>
      ))}
    </nav>
  );
}

export function TopBar({ title, onBack, right }: { title: string; onBack?: () => void; right?: ReactNode }) {
  return (
    <header className="topbar">
      {onBack && (
        <button className="back" onClick={onBack} aria-label="Back">‹</button>
      )}
      <h1>{title}</h1>
      {right}
    </header>
  );
}

/* ------------------------------------------------------------------ chart */

export interface SeriesPoint {
  x: string; // date key or label
  y: number; // minor units (or any number)
}

/**
 * Dependency-free SVG line chart with an optional benchmark series (T4).
 * Values are plotted as-is; the caller formats the axis labels.
 */
export function LineChart({
  series,
  benchmark,
  height = 140,
  ariaLabel,
  formatY,
}: {
  series: SeriesPoint[];
  benchmark?: SeriesPoint[];
  height?: number;
  ariaLabel: string;
  formatY?: (v: number) => string;
}) {
  const width = 600;
  const padL = 8;
  const padR = 8;
  const padT = 10;
  const padB = 18;

  if (series.length < 2) {
    return <div className="empty small">Not enough history yet — values appear as sessions pass.</div>;
  }

  const all = [...series, ...(benchmark ?? [])].map((p) => p.y);
  let min = Math.min(...all);
  let max = Math.max(...all);
  if (min === max) { min -= 1; max += 1; }
  const px = (i: number, n: number) => padL + (i * (width - padL - padR)) / Math.max(1, n - 1);
  const py = (v: number) => padT + (1 - (v - min) / (max - min)) * (height - padT - padB);

  const path = (pts: SeriesPoint[]) => pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${px(i, pts.length).toFixed(1)},${py(p.y).toFixed(1)}`).join(' ');
  const areaPath = `${path(series)} L${px(series.length - 1, series.length).toFixed(1)},${height - padB} L${padL},${height - padB} Z`;

  const first = series[0];
  const last = series[series.length - 1];
  const minLabel = formatY ? formatY(min) : String(Math.round(min));
  const maxLabel = formatY ? formatY(max) : String(Math.round(max));

  return (
    <div>
      <svg className="chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel} preserveAspectRatio="none">
        <defs>
          <linearGradient id="grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#4f8cff" stopOpacity="0.5" />
            <stop offset="100%" stopColor="#4f8cff" stopOpacity="0" />
          </linearGradient>
        </defs>
        <line className="grid" x1={padL} x2={width - padR} y1={padT} y2={padT} />
        <line className="grid" x1={padL} x2={width - padR} y1={height - padB} y2={height - padB} />
        <path className="area" d={areaPath} />
        <path className="line" d={path(series)} />
        {benchmark && benchmark.length > 1 && <path className="line bench" d={path(benchmark)} />}
        <text x={padL} y={height - 5} fontSize="10" fill="#9aa7c4">{first.x}</text>
        <text x={width - padR} y={height - 5} fontSize="10" fill="#9aa7c4" textAnchor="end">{last.x}</text>
      </svg>
      <div className="row between tiny dim" style={{ padding: '2px 8px' }}>
        <span>{maxLabel}</span>
        <span>{minLabel}</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ inputs */

export function Segmented<T extends string>({ value, onChange, options, label }: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  label: string;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ----------------------------------------------------------------- helpers */

export function shortName(inst: Instrument): string {
  return inst.name && inst.name.length > 28 ? `${inst.name.slice(0, 26)}…` : inst.name;
}

export function marketStatusLabel(isOpen: boolean, sessionDate: string): string {
  return isOpen ? `Open · session ${sessionDate}` : `Closed · next session ${sessionDate}`;
}

/** Convert a major-unit numeric input string to integer minor units (null = invalid). */
export function parseMajorToMinor(text: string, currency: string): number | null {
  const exp = CURRENCIES[currency]?.exponent ?? 2;
  const s = text.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [int, fracRaw = ''] = s.split('.');
  const frac = (fracRaw + '0'.repeat(exp)).slice(0, exp);
  const extra = fracRaw.slice(exp);
  let minor = Number(int) * 10 ** exp + Number(frac || '0');
  if (extra) {
    // round half-even on the extra digits (W5)
    const rest = extra.replace(/0+$/, '');
    const v = Number(`0.${rest}`);
    if (v > 0.5) minor += 1;
    else if (v === 0.5) minor = minor % 2 === 0 ? minor : minor + 1;
  }
  return Number.isSafeInteger(minor) ? minor : null;
}

export function majorText(minor: number, currency: string): string {
  return toMajorString(minor, CURRENCIES[currency]?.exponent ?? 2);
}

export function num(n: number, maxFrac = 0): string {
  return formatNumber(n, undefined, maxFrac);
}

/** Auto-refresh a callback on an interval while mounted. */
export function useInterval(fn: () => void, ms: number | null): void {
  useEffect(() => {
    if (ms == null) return;
    const t = setInterval(fn, ms);
    return () => clearInterval(t);
  }, [fn, ms]);
}
