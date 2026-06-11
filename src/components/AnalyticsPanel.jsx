/* ═══════════════════════════════════════════════════════
   Analytics Panel — P&L Performance Dashboard
   ─────────────────────────────────────────────────────
   Renders equity curve, win/loss stats, drawdown,
   and per-symbol breakdown from MT5 trade history.
   ═══════════════════════════════════════════════════════ */

import { useMemo } from 'react';
import { computeStats, closedTrades } from '../engine/stats.js';

/* ── Mini sparkline using SVG ── */
function Sparkline({ data, color = '#089981', height = 60 }) {
  if (!data || data.length < 2) {
    return (
      <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#333', fontSize: 11 }}>
        No equity data yet
      </div>
    );
  }

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const w = 320;
  const h = height;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - ((v - min) / range) * (h - 8) - 4;
    return `${x},${y}`;
  });

  const polyline = pts.join(' ');
  // Fill area below line
  const area = `0,${h} ${polyline} ${w},${h}`;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none">
      <defs>
        <linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <polygon points={area} fill="url(#spark-fill)" />
      <polyline
        points={polyline}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {/* Last point dot */}
      {pts.length > 0 && (() => {
        const last = pts[pts.length - 1].split(',');
        return (
          <circle cx={last[0]} cy={last[1]} r="3" fill={color} />
        );
      })()}
    </svg>
  );
}

/* ── Win/Loss Bar ── */
function WinLossBar({ wins, losses }) {
  const total = wins + losses;
  const winPct = total > 0 ? (wins / total) * 100 : 0;
  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#6b7084', marginBottom: 4 }}>
        <span style={{ color: '#089981' }}>Wins: {wins}</span>
        <span style={{ color: '#F23645' }}>Losses: {losses}</span>
      </div>
      <div style={{ background: '#1a1d27', borderRadius: 4, height: 8, overflow: 'hidden' }}>
        <div style={{ display: 'flex', height: '100%' }}>
          <div style={{ width: `${winPct}%`, background: '#089981', transition: 'width 0.5s ease' }} />
          <div style={{ flex: 1, background: '#F23645' }} />
        </div>
      </div>
    </div>
  );
}

/* ── Stat Card ── */
function StatCard({ label, value, sub, color = '#e1e4ea' }) {
  return (
    <div className="analytics-stat-card">
      <div className="analytics-stat-label">{label}</div>
      <div className="analytics-stat-value" style={{ color }}>{value}</div>
      {sub && <div className="analytics-stat-sub">{sub}</div>}
    </div>
  );
}

/* ── Main Export ── */
export default function AnalyticsPanel({ trades = [], account = {} }) {
  const stats = useMemo(() => {
    // Core metrics from the shared stats engine (closed-trade realized P&L only).
    const s = computeStats(trades, { startBalance: account.balance || 10000 });
    if (!s.hasData) return null;
    // Per-symbol breakdown (display-specific, not in the shared library).
    const bySymbol = {};
    closedTrades(trades).forEach(t => {
      const sym = t.symbol || 'Unknown';
      if (!bySymbol[sym]) bySymbol[sym] = { count: 0, pnl: 0 };
      bySymbol[sym].count++;
      bySymbol[sym].pnl += t.realizedPnl;
    });
    return { ...s, bySymbol };
  }, [trades, account.balance]);

  const fmt = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : (x === Infinity ? '∞' : '—'));
  const pf = stats && fmt(stats.profitFactor);

  const pnlColor = (stats?.totalPnl || 0) >= 0 ? '#089981' : '#F23645';

  return (
    <div className="analytics-panel">
      {/* Header */}
      <div className="analytics-header">
        <div style={{ fontWeight: 700, fontSize: 13, color: '#e1e4ea' }}>📊 Performance Analytics</div>
        <div style={{ fontSize: 10, color: '#6b7084' }}>{trades.length} trades recorded</div>
      </div>

      {!stats ? (
        <div className="analytics-empty">
          <div style={{ fontSize: 36, marginBottom: 10 }}>📉</div>
          <div style={{ color: '#e1e4ea', fontWeight: 600, marginBottom: 4 }}>No Closed Trades Yet</div>
          <div style={{ color: '#6b7084', fontSize: 11, textAlign: 'center', lineHeight: 1.5 }}>
            Performance is computed from realized P&amp;L when trades close.<br />
            Open trades appear in the Trades tab; stats build here as they close.
          </div>
        </div>
      ) : (
        <>
          {/* Equity Curve */}
          <div className="analytics-section">
            <div className="analytics-section-title">Equity Curve</div>
            <div style={{ padding: '8px 0' }}>
              <Sparkline data={stats.equity} color={pnlColor} height={70} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#6b7084', marginTop: 2 }}>
              <span>Start: R {(account.balance || 10000).toFixed(2)}</span>
              <span style={{ color: pnlColor, fontWeight: 700 }}>
                Total P&L: {stats.totalPnl >= 0 ? '+' : ''}R {stats.totalPnl.toFixed(2)}
              </span>
            </div>
          </div>

          {/* Win/Loss Bar */}
          <div className="analytics-section">
            <div className="analytics-section-title">Win / Loss Ratio</div>
            <WinLossBar wins={stats.wins} losses={stats.losses} />
          </div>

          {/* Stat Grid */}
          <div className="analytics-section">
            <div className="analytics-section-title">Key Metrics</div>
            <div className="analytics-stats-grid">
              <StatCard label="Win Rate" value={`${stats.winRate.toFixed(1)}%`} color={stats.winRate >= 50 ? '#089981' : '#F23645'} />
              <StatCard label="Profit Factor" value={pf} color="#BA7517" />
              <StatCard label="Expectancy" value={`R ${stats.expectancy.toFixed(2)}`} sub={stats.expectancyR != null ? `${stats.expectancyR.toFixed(2)}R / trade` : ''} color={stats.expectancy >= 0 ? '#089981' : '#F23645'} />
              <StatCard label="Sharpe" value={stats.sharpe.toFixed(2)} color="#818cf8" />
              <StatCard label="Sortino" value={stats.sortino.toFixed(2)} color="#818cf8" />
              <StatCard label="Avg Win" value={`R ${stats.avgWin.toFixed(2)}`} color="#089981" />
              <StatCard label="Avg Loss" value={`-R ${stats.avgLoss.toFixed(2)}`} color="#F23645" />
              <StatCard label="Best Trade" value={`+R ${stats.bestTrade.toFixed(2)}`} color="#089981" />
              <StatCard label="Worst Trade" value={`R ${stats.worstTrade.toFixed(2)}`} color="#F23645" />
              <StatCard label="Max Drawdown" value={`R ${stats.maxDrawdown.toFixed(2)}`} sub={`${stats.maxDrawdownPct.toFixed(1)}%`} color="#BA7517" />
              <StatCard label="Total Trades" value={stats.count} color="#818cf8" />
              <StatCard label="Max Streak" value={`${stats.maxConsecWins}W / ${stats.maxConsecLosses}L`} color="#9ca3af" />
              <StatCard label="Recovery Factor" value={fmt(stats.recoveryFactor)} color="#089981" />
              <StatCard label="MAR" value={fmt(stats.mar)} color="#BA7517" />
              <StatCard label="Ulcer Index" value={fmt(stats.ulcerIndex, 1)} color="#F23645" />
              <StatCard label="Kelly (½)" value={`${fmt(stats.halfKelly * 100, 1)}%`} sub="optimal risk" color="#818cf8" />
              <StatCard label="Edge t-stat" value={fmt(stats.tStat)} sub={stats.edgeSignificant ? '✓ significant' : 'unproven'} color={stats.edgeSignificant ? '#089981' : '#6b7084'} />
            </div>
          </div>

          {/* Symbol Breakdown */}
          <div className="analytics-section">
            <div className="analytics-section-title">Per-Symbol Breakdown</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {Object.entries(stats.bySymbol)
                .sort((a, b) => Math.abs(b[1].pnl) - Math.abs(a[1].pnl))
                .map(([sym, data]) => (
                  <div key={sym} className="analytics-symbol-row">
                    <span style={{ color: '#e1e4ea', fontWeight: 600, fontSize: 11 }}>{sym}</span>
                    <span style={{ color: '#6b7084', fontSize: 10 }}>{data.count} trades</span>
                    <span style={{
                      color: data.pnl >= 0 ? '#089981' : '#F23645',
                      fontWeight: 700, fontSize: 12,
                    }}>
                      {data.pnl >= 0 ? '+' : ''}R {data.pnl.toFixed(2)}
                    </span>
                  </div>
                ))
              }
            </div>
          </div>
        </>
      )}
    </div>
  );
}
