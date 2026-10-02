/**
 * Post-trade feedback (T3) and portfolio observations (RM9).
 * Educational observations only — never recommendations.
 */

import { formatMinor, formatPercent } from '../engine/money';
import type { Fill, Position } from '../engine/types';
import type { Valuation } from '../engine/engine';

export interface Feedback {
  id: string;
  title: string;
  body: string;
}

export function postTradeFeedback(fill: Fill, valuation: Valuation, position: Position | undefined, baseCurrency: string): Feedback[] {
  const out: Feedback[] = [];
  const row = valuation.rows.find((r) => r.instrument.symbol === fill.instrument.symbol && r.instrument.exchange === fill.instrument.exchange);
  const totalValue = valuation.totalValueMinor;

  // concentration (RM9)
  if (row && totalValue > 0) {
    const pct = row.valueBaseMinor / totalValue;
    if (fill.side === 'buy' && pct > 0.25) {
      out.push({
        id: 'concentration',
        title: 'Concentration',
        body: `${fill.instrument.symbol} now makes up ${formatPercent(pct)} of your wallet. Concentrated positions swing harder — one company's bad day becomes your bad day. (Observation, not advice.)`,
      });
    }
    if (valuation.rows.filter((r) => r.qty > 0).length === 1 && fill.side === 'buy') {
      out.push({
        id: 'single_position',
        title: 'Single position',
        body: 'Your whole portfolio is one instrument right now. Diversification spreads risk across different assets so no single outcome dominates (see Learn → diversification).',
      });
    }
  }

  // costs (RM2 / RM10)
  if (fill.feesMinor > 0) {
    const costPct = fill.baseGrossMinor > 0 ? fill.feesMinor / fill.baseGrossMinor : 0;
    out.push({
      id: 'costs',
      title: 'Trading costs paid',
      body: `This trade cost ${formatMinor(fill.feesMinor, baseCurrency)} in fees (${formatPercent(costPct)} of the trade). Fees are charged on every fill in Realism Mode — they quietly reduce long-term returns.`,
    });
  } else if (!fill.realism) {
    out.push({
      id: 'idealized',
      title: 'Idealized mode',
      body: 'Realism Mode is off, so no costs or spreads were applied. Real trading always has costs — switch Realism Mode on in Settings for honest numbers (RM1).',
    });
  }

  // FX effect (F5)
  if (!fill.realism || fill.nativeCurrency !== baseCurrency) {
    out.push({
      id: 'fx',
      title: 'Currency effect',
      body:
        fill.nativeCurrency === baseCurrency
          ? `This instrument trades in your base currency (${baseCurrency}), so FX does not affect it.`
          : `Bought at FX ${fill.fxRate} (${fill.nativeCurrency}→${baseCurrency}). Your P&L in ${baseCurrency} can move from exchange-rate changes even if the price is flat — compare “price effect” vs “currency effect” in Performance.`,
    });
  }

  // settlement (RM5)
  if (fill.side === 'sell' && fill.availableAtUtc) {
    out.push({
      id: 'settlement',
      title: 'Settlement',
      body: `Sale proceeds of ${formatMinor(fill.baseCreditedMinor, baseCurrency)} become spendable after settlement (RM5) — shown separately as pending until then.`,
    });
  }

  // spread/slippage explanation (RM3)
  if (fill.spreadBpsApplied > 0 || fill.slippageBpsApplied > 0) {
    out.push({
      id: 'spread',
      title: 'Spread & slippage applied',
      body: `Execution price adjusted by ${fill.spreadBpsApplied + fill.slippageBpsApplied} bps (spread ${fill.spreadBpsApplied} bps + slippage ${fill.slippageBpsApplied} bps) — buys pay more, sells receive less, as in real markets (RM3).`,
    });
  }

  void position;
  return out;
}

/** Concentration warnings for the whole portfolio (RM9). */
export function concentrationWarnings(valuation: Valuation, threshold = 0.25): string[] {
  const out: string[] = [];
  const total = valuation.totalValueMinor;
  if (total <= 0) return out;
  for (const r of valuation.rows) {
    if (r.qty <= 0) continue;
    const pct = r.valueBaseMinor / total;
    if (pct > threshold) {
      out.push(`${r.instrument.symbol} is ${formatPercent(pct)} of your portfolio — above the ${formatPercent(threshold)} observation threshold. Diversification spreads risk (T1).`);
    }
  }
  return out;
}
