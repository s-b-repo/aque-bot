/* ═══════════════════════════════════════════════════════
   Trades Panel — Live Trade History from MT5 EA
   ─────────────────────────────────────────────────────
   Polls /api/trades to show executed trades and P&L.
   ═══════════════════════════════════════════════════════ */

export default function TradesPanel({ trades = [], account = { balance: 0, equity: 0, profit: 0, openTrades: 0 }, connected = false }) {
  const profitColor = account.profit >= 0 ? 'var(--neon-bull)' : 'var(--neon-bear)';

  return (
    <div className="trades-panel">
      {/* Connection Status */}
      <div className="trades-connection" style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '8px 12px', borderBottom: '1px solid var(--border)',
        fontSize: 11, color: connected ? 'var(--neon-bull)' : '#666',
      }}>
        <span style={{
          width: 7, height: 7, borderRadius: '50%',
          background: connected ? 'var(--neon-bull)' : '#555',
          boxShadow: connected ? '0 0 6px var(--neon-bull)' : 'none',
        }} />
        {connected ? 'Trading bot connected' : 'Waiting for trading bot…'}
      </div>

      {/* Account Summary */}
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr',
        gap: 8, padding: '10px 12px',
        borderBottom: '1px solid var(--border)',
      }}>
        <div className="trades-stat">
          <span style={{ color: '#6b7084', fontSize: 9, textTransform: 'uppercase' }}>Balance</span>
          <span style={{ color: '#e1e4ea', fontSize: 14, fontWeight: 600 }}>
            R {account.balance?.toFixed(2) || '0.00'}
          </span>
        </div>
        <div className="trades-stat">
          <span style={{ color: '#6b7084', fontSize: 9, textTransform: 'uppercase' }}>Equity</span>
          <span style={{ color: '#e1e4ea', fontSize: 14, fontWeight: 600 }}>
            R {account.equity?.toFixed(2) || '0.00'}
          </span>
        </div>
        <div className="trades-stat">
          <span style={{ color: '#6b7084', fontSize: 9, textTransform: 'uppercase' }}>Open P&L</span>
          <span style={{ color: profitColor, fontSize: 14, fontWeight: 700 }}>
            {account.profit >= 0 ? '+' : ''}R {account.profit?.toFixed(2) || '0.00'}
          </span>
        </div>
        <div className="trades-stat">
          <span style={{ color: '#6b7084', fontSize: 9, textTransform: 'uppercase' }}>Open Trades</span>
          <span style={{ color: '#e1e4ea', fontSize: 14, fontWeight: 600 }}>
            {account.openTrades || 0}
          </span>
        </div>
      </div>

      {/* Trade History */}
      <div style={{ padding: '8px 12px' }}>
        <div style={{ color: '#6b7084', fontSize: 10, textTransform: 'uppercase', marginBottom: 8, letterSpacing: 1 }}>
          Trade History ({trades.length})
        </div>

        {trades.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 30, color: '#444' }}>
            <div style={{ fontSize: 28, marginBottom: 8 }}>📊</div>
            <div style={{ fontSize: 12, color: '#6b7084' }}>No trades yet</div>
            <div style={{ fontSize: 10, color: '#444', marginTop: 4 }}>
              Trades will appear here when the bot executes signals
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 400, overflow: 'auto' }}>
            {[...trades].reverse().map((trade, i) => {
              const isClosed = trade.status === 'CLOSED';
              const realized = typeof trade.realizedPnl === 'number' ? trade.realizedPnl : null;
              const realizedCol = (realized || 0) >= 0 ? 'var(--neon-bull)' : 'var(--neon-bear)';
              return (
              <div key={trade.ticket || `${trade.symbol}-${trade.timestamp}-${i}`} style={{
                background: 'rgba(15,17,23,0.6)',
                border: `1px solid ${trade.type === 'BUY' ? 'rgba(0,200,120,0.15)' : 'rgba(255,59,105,0.15)'}`,
                borderRadius: 8, padding: '10px 12px',
                borderLeft: `3px solid ${trade.type === 'BUY' ? 'var(--neon-bull)' : 'var(--neon-bear)'}`,
              }}>
                {/* Header */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{
                      background: trade.type === 'BUY' ? 'rgba(0,200,120,0.15)' : 'rgba(255,59,105,0.15)',
                      color: trade.type === 'BUY' ? 'var(--neon-bull)' : 'var(--neon-bear)',
                      padding: '2px 8px', borderRadius: 4,
                      fontSize: 10, fontWeight: 700,
                    }}>
                      {trade.type === 'BUY' ? '▲' : '▼'} {trade.type}
                    </span>
                    <span style={{ color: '#e1e4ea', fontSize: 12, fontWeight: 600 }}>{trade.symbol}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {realized !== null && isClosed && (
                      <span style={{ color: realizedCol, fontSize: 11, fontWeight: 700 }}>
                        {realized >= 0 ? '+' : ''}R {realized.toFixed(2)}
                      </span>
                    )}
                    <span style={{
                      background: isClosed ? 'rgba(107,112,132,0.18)' : 'rgba(99,102,241,0.15)',
                      color: isClosed ? '#9ca3af' : '#818cf8', padding: '2px 6px',
                      borderRadius: 4, fontSize: 9, fontWeight: 600,
                    }}>
                      {isClosed ? 'CLOSED' : `${trade.confidence ?? '—'}% conf`}
                    </span>
                  </div>
                </div>

                {/* Details */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4, fontSize: 10 }}>
                  <div>
                    <span style={{ color: '#555' }}>Entry </span>
                    <span style={{ color: '#9ca3af' }}>{trade.price}</span>
                  </div>
                  <div>
                    <span style={{ color: '#555' }}>Lots </span>
                    <span style={{ color: '#9ca3af' }}>{trade.lots}</span>
                  </div>
                  <div>
                    <span style={{ color: '#555' }}>Ticket </span>
                    <span style={{ color: '#9ca3af' }}>#{trade.ticket}</span>
                  </div>
                  <div>
                    <span style={{ color: 'var(--neon-bear)' }}>SL </span>
                    <span style={{ color: '#9ca3af' }}>{trade.sl}</span>
                  </div>
                  <div>
                    <span style={{ color: 'var(--neon-bull)' }}>TP </span>
                    <span style={{ color: '#9ca3af' }}>{trade.tp}</span>
                  </div>
                  <div>
                    <span style={{ color: '#555' }}>{trade.closeTimeStr || trade.timeStr}</span>
                  </div>
                </div>
              </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
