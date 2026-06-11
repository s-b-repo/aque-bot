import { useState, useEffect } from 'react';
import { getConfig, saveConfig } from '../config/authClient.js';

/* Auto-trading ON/OFF switch + live/paper mode indicator. Writes config.tradeEnabled,
   which the executor honors live (stops opening NEW trades when off; open trades are
   still managed). */
export default function AutoTradeToggle() {
  const [cfg, setCfg] = useState(null);     // null = loading
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    getConfig().then(c => { if (alive) setCfg(c); }).catch(() => { if (alive) setCfg({ tradeEnabled: false }); });
    return () => { alive = false; };
  }, []);

  const on = cfg ? !!cfg.tradeEnabled : null;
  const mode = !cfg ? '' : cfg.broker === 'ccxt' ? (cfg.live ? 'LIVE' : 'TESTNET') : 'PAPER';
  const modeColor = mode === 'LIVE' ? '#F23645' : mode === 'TESTNET' ? '#BA7517' : '#6b7084';

  const toggle = async () => {
    if (on === null || busy) return;
    setBusy(true);
    try { const c = await saveConfig({ tradeEnabled: !on }); setCfg(c); }
    catch { /* keep current state on failure */ }
    finally { setBusy(false); }
  };

  const active = on === true;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <button
        onClick={toggle}
        disabled={on === null || busy}
        title="Auto-trading bot — start / stop opening new trades"
        style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '7px 13px', borderRadius: 8,
          cursor: on === null ? 'wait' : 'pointer',
          border: `1px solid ${active ? '#089981' : '#3a3f52'}`,
          background: active ? 'rgba(8,153,129,0.15)' : 'rgba(255,255,255,0.03)',
          color: active ? '#089981' : '#6b7084',
          fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, fontSize: 12, letterSpacing: 0.5,
          transition: 'all .15s',
        }}
      >
        <span style={{
          width: 8, height: 8, borderRadius: '50%',
          background: active ? '#089981' : '#555',
          boxShadow: active ? '0 0 8px #089981' : 'none',
        }} />
        AUTO-TRADE {on === null ? '…' : active ? 'ON' : 'OFF'}
      </button>
      {mode && (
        <span title="Trading mode" style={{
          fontFamily: "'JetBrains Mono', monospace", fontSize: 10, fontWeight: 700, letterSpacing: 0.5,
          color: modeColor, border: `1px solid ${modeColor}`, borderRadius: 6, padding: '3px 6px',
        }}>{mode}</span>
      )}
    </div>
  );
}
