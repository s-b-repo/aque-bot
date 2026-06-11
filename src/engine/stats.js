/* ═══════════════════════════════════════════════════════
   Performance Statistics — shared by dashboard, backtester
   and (optionally) the API server. Pure, dependency-free
   functions over an array of CLOSED trades.

   A closed trade is any object with:
     status === 'CLOSED'  (filtered by closedTrades)
     realizedPnl : number  (money P&L of the whole trade)
   and optionally:
     riskAmount  : number  (money risked at entry — enables R stats)
     riskPct, balance      (fallback to derive riskAmount)
   ═══════════════════════════════════════════════════════ */

/** Keep only realized (closed) trades. */
export function closedTrades(trades) {
  if (!Array.isArray(trades)) return [];
  return trades.filter(t => t && t.status === 'CLOSED' && Number.isFinite(t.realizedPnl));
}

/** Money risked on a trade, if we can determine it (for R-multiples). */
export function tradeRiskAmount(t) {
  if (Number.isFinite(t.riskAmount) && t.riskAmount > 0) return t.riskAmount;
  if (Number.isFinite(t.riskPct) && Number.isFinite(t.balance) && t.riskPct > 0 && t.balance > 0) {
    return t.balance * (t.riskPct / 100);
  }
  return null;
}

/** R-multiple of a trade (realized P&L ÷ money risked), or null if unknown. */
export function tradeR(t) {
  const risk = tradeRiskAmount(t);
  return risk && risk > 0 ? t.realizedPnl / risk : null;
}

function mean(a) {
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
}
function stdDev(a, m = mean(a)) {
  if (a.length < 2) return 0;
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}
function maxConsecutive(series, predicate) {
  let best = 0, run = 0;
  for (const v of series) {
    if (predicate(v)) { run++; if (run > best) best = run; }
    else run = 0;
  }
  return best;
}

/**
 * Compute the full performance report from a trade list.
 * @param {Array}  trades
 * @param {Object} opts  { startBalance }
 */
export function computeStats(trades, { startBalance = 10000 } = {}) {
  const closed = closedTrades(trades);
  const n = closed.length;
  if (n === 0) {
    return { count: 0, hasData: false };
  }

  const pnls = closed.map(t => t.realizedPnl);
  const wins = closed.filter(t => t.realizedPnl > 0);
  const losses = closed.filter(t => t.realizedPnl < 0);
  const breakEven = n - wins.length - losses.length;

  const grossProfit = wins.reduce((s, t) => s + t.realizedPnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.realizedPnl, 0));
  const totalPnl = grossProfit - grossLoss;

  const winRate = (wins.length / n) * 100;
  const avgWin = wins.length ? grossProfit / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;       // positive number
  const payoffRatio = avgLoss > 0 ? avgWin / avgLoss : (avgWin > 0 ? Infinity : 0);
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0);

  // Expectancy (money per trade) and, when risk is known, in R.
  const expectancy = totalPnl / n;
  const rValues = closed.map(tradeR).filter(r => r != null);
  const expectancyR = rValues.length ? mean(rValues) : null;

  // Equity curve + max drawdown (money and %) + ulcer index (downside roughness).
  const equity = [];
  let acc = startBalance;
  for (const p of pnls) { acc += p; equity.push(acc); }
  let peak = startBalance, maxDD = 0, maxDDPct = 0, ddSqSum = 0;
  for (const e of equity) {
    if (e > peak) peak = e;
    const dd = peak - e;
    if (dd > maxDD) { maxDD = dd; maxDDPct = peak > 0 ? (dd / peak) * 100 : 0; }
    const ddp = peak > 0 ? (dd / peak) * 100 : 0;
    ddSqSum += ddp * ddp;
  }
  const ulcerIndex = equity.length ? Math.sqrt(ddSqSum / equity.length) : 0;

  // Risk-adjusted ratios over the per-trade P&L series (per-trade, unscaled).
  const m = mean(pnls);
  const sd = stdDev(pnls, m);
  const sharpe = sd > 0 ? m / sd : 0;
  // Downside deviation: sum over losers, but divide by the TOTAL count n (winners
  // contribute 0 to the numerator yet still count in the denominator).
  const downside = pnls.filter(p => p < 0);
  const dStd = n ? Math.sqrt(downside.reduce((s, p) => s + p * p, 0) / n) : 0;
  const sortino = dStd > 0 ? m / dStd : 0;

  // Statistical significance of the edge: t = mean / (std/√n). |t| ≥ ~2 ⇒ the
  // average trade is unlikely to be zero by chance (≈95% confidence).
  const tStat = sd > 0 ? (m / sd) * Math.sqrt(n) : 0;
  const edgeSignificant = Math.abs(tStat) >= 1.96;

  // Kelly fraction f* = p − (1−p)/b  (p = win prob, b = payoff). Suggest HALF-Kelly.
  const decided = wins.length + losses.length;
  const p = decided > 0 ? wins.length / decided : 0;
  const b = avgLoss > 0 ? avgWin / avgLoss : (avgWin > 0 ? Infinity : 0);
  let kellyFraction = Number.isFinite(b) ? p - (1 - p) / b : p;
  kellyFraction = Math.max(0, Math.min(1, kellyFraction));
  const halfKelly = kellyFraction / 2;

  // Capital-efficiency ratios (time-free).
  const totalReturnPct = startBalance > 0 ? (totalPnl / startBalance) * 100 : 0;
  const recoveryFactor = maxDD > 0 ? totalPnl / maxDD : (totalPnl > 0 ? Infinity : 0);
  const mar = maxDDPct > 0 ? totalReturnPct / maxDDPct : (totalReturnPct > 0 ? Infinity : 0);

  // R-multiple histogram (buckets of 0.5R) when R is available.
  let rHistogram = null;
  if (rValues.length) {
    rHistogram = {};
    for (const r of rValues) {
      const bucket = Math.floor(r * 2) / 2; // 0.5R buckets
      const key = bucket.toFixed(1);
      rHistogram[key] = (rHistogram[key] || 0) + 1;
    }
  }

  return {
    hasData: true,
    count: n,
    wins: wins.length,
    losses: losses.length,
    breakEven,
    winRate,
    totalPnl,
    grossProfit,
    grossLoss,
    profitFactor,
    expectancy,
    expectancyR,
    avgWin,
    avgLoss,
    payoffRatio,
    bestTrade: Math.max(...pnls),
    worstTrade: Math.min(...pnls),
    maxConsecWins: maxConsecutive(pnls, x => x > 0),
    maxConsecLosses: maxConsecutive(pnls, x => x < 0),
    sharpe,
    sortino,
    tStat,
    edgeSignificant,
    kellyFraction,
    halfKelly,
    recoveryFactor,
    mar,
    ulcerIndex,
    totalReturnPct,
    maxDrawdown: maxDD,
    maxDrawdownPct: maxDDPct,
    startBalance,
    endBalance: equity[equity.length - 1],
    equity,
    rValues,
    rHistogram,
  };
}

/** Compact one-line-per-metric formatting helper for CLI / logs. */
export function formatStats(s) {
  if (!s || !s.hasData) return 'No closed trades.';
  const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : (x === Infinity ? '∞' : '—'));
  return [
    `Trades:        ${s.count}  (W ${s.wins} / L ${s.losses} / BE ${s.breakEven})`,
    `Win rate:      ${f(s.winRate, 1)}%`,
    `Net P&L:       ${f(s.totalPnl)}   (end balance ${f(s.endBalance)})`,
    `Profit factor: ${f(s.profitFactor)}`,
    `Expectancy:    ${f(s.expectancy)} / trade${s.expectancyR != null ? `  (${f(s.expectancyR)}R)` : ''}`,
    `Payoff (W/L):  ${f(s.payoffRatio)}   avgWin ${f(s.avgWin)} / avgLoss ${f(s.avgLoss)}`,
    `Max drawdown:  ${f(s.maxDrawdown)}  (${f(s.maxDrawdownPct, 1)}%)   Ulcer: ${f(s.ulcerIndex, 1)}`,
    `Sharpe:        ${f(s.sharpe)}    Sortino: ${f(s.sortino)}   (per trade)`,
    `Recovery / MAR:${f(s.recoveryFactor)} / ${f(s.mar)}`,
    `Kelly (half):  ${f(s.kellyFraction * 100, 1)}% (${f(s.halfKelly * 100, 1)}%)`,
    `Edge t-stat:   ${f(s.tStat)}  → ${s.edgeSignificant ? 'SIGNIFICANT (≈95%)' : 'not significant (needs more trades)'}`,
    `Best / Worst:  ${f(s.bestTrade)} / ${f(s.worstTrade)}`,
    `Max streak:    ${s.maxConsecWins}W / ${s.maxConsecLosses}L`,
  ].join('\n');
}
