/* ═══════════════════════════════════════════════════════
   Risk engine — position sizing + guards, ported rule-for-
   rule from the MetaTrader EAs (risk % → $ cap → notional
   cap → exchange min/step → refuse-if-min-exceeds-cap;
   portfolio cap; daily-loss / equity / consec-loss switches).
   ═══════════════════════════════════════════════════════ */
import { config } from './config.js';

/** Money to risk on one trade (base risk × optional dynamic multiplier). */
export function dollarRisk(balance, mult = 1) {
  let r = balance * (config.riskPercent / 100) * mult;
  if (config.maxRiskDollars > 0) r = Math.min(r, config.maxRiskDollars);
  return r;
}

const KELLY_MIN_SAMPLE = 15;   // trades before the realized edge is trusted for sizing

/**
 * Statistical edge factor from the bot's REALIZED performance (updates as trades
 * close). Uses the half-Kelly fraction of the actual win-rate/payoff:
 *   • too few trades            → 1.0 (neutral, fall back to the heuristic factors)
 *   • realized losing edge      → 0.5 (halve risk until it recovers)
 *   • proven positive edge      → scale up toward 1.3 with half-Kelly
 *   • unproven edge (t<1.96)    → capped at 1.0 (don't size up on noise)
 */
export function kellyMultiplier(stats) {
  if (!stats || !stats.hasData || (stats.count || 0) < KELLY_MIN_SAMPLE) return 1;
  // Realized losing edge → halve. Works even when R-multiples are unknown (e.g. all
  // standalone closes carry no risk basis) by falling back to money P&L.
  const losing = (stats.expectancyR != null && stats.expectancyR <= 0) ||
                 (stats.expectancyR == null && (stats.totalPnl || 0) < 0);
  if (losing) return 0.5;
  const hk = Math.max(0, stats.halfKelly || 0);          // 0 .. 0.5
  // A PROVEN (statistically significant) positive edge is never sized below the
  // warmup neutral; it scales UP toward 1.3 with half-Kelly. A positive-but-unproven
  // edge stays cautious (≤ neutral) so we don't size up on noise.
  if (stats.edgeSignificant) return Math.min(1.3, 1.0 + hk * 1.5);
  return Math.max(0.7, Math.min(1.0, 0.8 + hk * 1.5));
}

/**
 * Dynamic, "smart" risk multiplier in [0.25, 1.3]:
 *   • scales UP with signal confidence (above the floor)
 *   • scales DOWN after consecutive losses (de-risk a losing streak)
 *   • scales DOWN inside an equity drawdown (protect capital)
 *   • scales by the REALIZED statistical edge (fractional Kelly, realtime)
 * Returns 1 when DYNAMIC_RISK is off.
 */
export function riskMultiplier({ confidence, equity, peakEquity, consec, stats }) {
  if (!config.dynamicRisk) return 1;
  let f = 1;
  const c = Math.max(0, Math.min(1, (confidence - config.minConfidence) / Math.max(1, 100 - config.minConfidence)));
  f *= 0.6 + 0.5 * c;                                   // 0.6 .. 1.1 by confidence
  if (consec > 0) f *= Math.max(0.4, 1 - 0.2 * consec); // streak de-risk
  if (peakEquity > 0 && equity < peakEquity) {
    const dd = (peakEquity - equity) / peakEquity;
    f *= Math.max(0.4, 1 - 1.5 * dd);                   // drawdown de-risk
  }
  f *= kellyMultiplier(stats);                           // realized-edge (Kelly) adjustment
  return Math.max(0.25, Math.min(1.3, f));
}

/** Sum of money-at-risk across currently open managed trades. */
export function openRisk(openTrades) {
  return openTrades.reduce((s, t) => s + (Number.isFinite(t.riskMoney) ? t.riskMoney : 0), 0);
}

/**
 * Compute order quantity for a signal.
 * @returns {{ qty:number, riskMoney:number, notional:number } | { qty:0, reason:string }}
 */
export function sizePosition({ broker, symbol, entry, sl, balance, equity, openTrades, riskMult = 1 }) {
  const slDist = Math.abs(entry - sl);
  if (!(slDist > 0)) return { qty: 0, reason: 'zero SL distance' };

  const riskAmt = dollarRisk(balance, riskMult);
  let qty = riskAmt / slDist;

  // Cap a single position's notional to a fraction of equity.
  const maxNotional = equity * (config.maxPositionPct / 100);
  if (qty * entry > maxNotional) qty = maxNotional / entry;

  // Exchange constraints.
  const m = broker.market(symbol) || { minQty: 0, minNotional: 0 };
  qty = broker.roundQty(symbol, qty);
  if (m.minQty && qty < m.minQty) qty = m.minQty;
  if (m.minNotional && qty * entry < m.minNotional) qty = broker.roundQty(symbol, (m.minNotional / entry) * 1.001);
  if (!(qty > 0)) return { qty: 0, reason: 'rounded to zero' };

  // Refuse if even the minimum tradeable size risks more than the cap (+5% tol).
  const riskMoney = qty * slDist;
  if (riskMoney > riskAmt * 1.05 && m.minQty && qty <= broker.roundQty(symbol, m.minQty)) {
    return { qty: 0, reason: `min size risks $${riskMoney.toFixed(2)} > cap $${riskAmt.toFixed(2)}` };
  }

  // Portfolio (combined open) risk cap.
  if (config.maxPortfolioRiskPct > 0 && balance > 0) {
    const cap = balance * (config.maxPortfolioRiskPct / 100);
    if (openRisk(openTrades) + riskMoney > cap) {
      return { qty: 0, reason: `portfolio risk cap ($${(openRisk(openTrades) + riskMoney).toFixed(2)} > $${cap.toFixed(2)})` };
    }
  }

  return { qty, riskMoney, notional: qty * entry };
}

/* ── Kill-switches & guards (pure predicates) ── */

export function dailyLossBreached(dayStartEquity, equity) {
  if (!(dayStartEquity > 0)) return false;
  const maxLoss = dayStartEquity * (config.maxDailyLossPercent / 100);
  return (dayStartEquity - equity) >= maxLoss;
}

export function equityGuardOk(balance, equity) {
  if (!(balance > 0)) return true;
  return equity >= balance * config.equityGuardPct;
}

export function freeMarginOk(balance, freeCash) {
  const minFree = Math.max(balance * config.minFreeMarginPct, 50);
  return freeCash >= minFree;
}

export function consecLossHalt(consec) {
  return config.maxConsecutiveLosses > 0 && consec >= config.maxConsecutiveLosses;
}
