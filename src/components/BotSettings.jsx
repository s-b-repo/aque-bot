import { useState, useEffect } from 'react';
import { getConfig, saveConfig, changePassword, logout } from '../config/authClient.js';
import { C, label, input } from './authStyles.js';

const overlay = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(3px)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16,
};
const modal = {
  width: '100%', maxWidth: 560, maxHeight: '90vh', overflowY: 'auto', background: C.card,
  border: `1px solid ${C.border}`, borderRadius: 14, fontFamily: C.mono,
};
const head = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', borderBottom: `1px solid ${C.border}` };
const body = { padding: '8px 20px 20px' };
const section = { marginTop: 18, fontSize: 11, color: C.indigo, textTransform: 'uppercase', letterSpacing: 1, fontWeight: 700 };
const row = { display: 'flex', gap: 10 };
const half = { flex: 1 };
const toggle = (on) => ({ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 12, color: on ? C.accent : C.muted, cursor: 'pointer' });
const btn = (bg) => ({ padding: '10px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontFamily: C.mono, fontWeight: 700, fontSize: 13, color: '#fff', background: bg });

export default function BotSettings({ onClose }) {
  const [cfg, setCfg] = useState(null);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pw, setPw] = useState({ open: false, oldPassword: '', newPassword: '', msg: '' });
  const set = (k, v) => { setCfg(p => ({ ...p, [k]: v })); setSaved(false); };

  useEffect(() => { getConfig().then(setCfg).catch(e => setErr(e.message)); }, []);

  const save = async () => {
    setBusy(true); setErr('');
    try {
      const patch = { ...cfg };
      // only send secrets if the user typed a new value
      for (const f of ['exchangeKey', 'exchangeSecret', 'exchangePassword']) {
        if (!patch[f]) delete patch[f];
        delete patch[`has${f[0].toUpperCase()}${f.slice(1)}`];
      }
      const fresh = await saveConfig(patch);
      setCfg(fresh); setSaved(true);
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const doChangePw = async () => {
    try { await changePassword(pw.oldPassword, pw.newPassword); setPw({ open: false, oldPassword: '', newPassword: '', msg: '' }); }
    catch (e) { setPw(p => ({ ...p, msg: e.message })); }
  };

  if (!cfg) {
    return <div style={overlay} onClick={onClose}><div style={{ ...modal, padding: 30, color: C.muted }} onClick={e => e.stopPropagation()}>{err || 'Loading…'}</div></div>;
  }

  const secretPlaceholder = (has) => (has ? '•••••••• configured (leave blank to keep)' : 'not set');

  return (
    <div style={overlay} onClick={onClose}>
      <div style={modal} onClick={e => e.stopPropagation()}>
        <div style={head}>
          <div style={{ fontWeight: 800, color: C.text }}>⚙ Bot Settings</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.muted, fontSize: 18, cursor: 'pointer' }}>✕</button>
        </div>
        <div style={body}>
          <div style={section}>Trading mode</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            {['paper', 'ccxt'].map(b => (
              <button key={b} type="button" onClick={() => set('broker', b)}
                style={{ flex: 1, padding: '10px', borderRadius: 8, cursor: 'pointer', fontFamily: C.mono, fontWeight: 600,
                  border: `1px solid ${cfg.broker === b ? C.accent : C.border}`,
                  background: cfg.broker === b ? 'rgba(8,153,129,0.15)' : C.card2, color: cfg.broker === b ? C.accent : C.muted }}>
                {b === 'paper' ? '📝 Paper (safe)' : '🔌 Live exchange'}
              </button>
            ))}
          </div>

          {cfg.broker === 'ccxt' && (
            <>
              <div style={row}>
                <div style={half}><label style={label}>Exchange</label><input style={input} value={cfg.exchangeId || ''} onChange={e => set('exchangeId', e.target.value)} /></div>
                <div style={half}><label style={label}>Market type</label>
                  <select style={input} value={cfg.exchangeType || 'spot'} onChange={e => set('exchangeType', e.target.value)}>
                    <option value="spot">spot (long only)</option><option value="swap">swap (long+short)</option><option value="future">future</option>
                  </select>
                </div>
              </div>
              <label style={label}>API key</label>
              <input style={input} autoComplete="off" placeholder={secretPlaceholder(cfg.hasExchangeKey)} value={cfg.exchangeKey || ''} onChange={e => set('exchangeKey', e.target.value)} />
              <label style={label}>API secret</label>
              <input style={input} type="password" autoComplete="off" placeholder={secretPlaceholder(cfg.hasExchangeSecret)} value={cfg.exchangeSecret || ''} onChange={e => set('exchangeSecret', e.target.value)} />
              <label style={toggle(cfg.live)}>
                <input type="checkbox" checked={!!cfg.live} onChange={e => set('live', e.target.checked)} />
                <span style={{ color: cfg.live ? C.danger : C.muted }}>LIVE trading (real money). Off = exchange sandbox/testnet.</span>
              </label>
            </>
          )}

          <div style={section}>Risk</div>
          <div style={row}>
            <div style={half}><label style={label}>Risk % / trade</label><input style={input} type="number" step="0.1" value={cfg.riskPercent} onChange={e => set('riskPercent', Number(e.target.value))} /></div>
            <div style={half}><label style={label}>Max $ / trade</label><input style={input} type="number" value={cfg.maxRiskDollars} onChange={e => set('maxRiskDollars', Number(e.target.value))} /></div>
          </div>
          <div style={row}>
            <div style={half}><label style={label}>Max open trades</label><input style={input} type="number" value={cfg.maxOpenTrades} onChange={e => set('maxOpenTrades', Number(e.target.value))} /></div>
            <div style={half}><label style={label}>Daily loss % halt</label><input style={input} type="number" value={cfg.maxDailyLossPercent} onChange={e => set('maxDailyLossPercent', Number(e.target.value))} /></div>
          </div>
          <div style={row}>
            <div style={half}><label style={label}>Max consec. losses</label><input style={input} type="number" value={cfg.maxConsecutiveLosses} onChange={e => set('maxConsecutiveLosses', Number(e.target.value))} /></div>
            <div style={half}><label style={label}>Min confidence %</label><input style={input} type="number" value={cfg.minConfidence} onChange={e => set('minConfidence', Number(e.target.value))} /></div>
          </div>
          <label style={toggle(cfg.dynamicRisk)}><input type="checkbox" checked={!!cfg.dynamicRisk} onChange={e => set('dynamicRisk', e.target.checked)} /> Smart dynamic risk (scale by confidence, de-risk losses/drawdown)</label>
          <label style={toggle(cfg.tradeEnabled)}><input type="checkbox" checked={!!cfg.tradeEnabled} onChange={e => set('tradeEnabled', e.target.checked)} /> Trading enabled</label>

          <div style={section}>Confluence filters</div>
          <label style={toggle(cfg.requireTrend)}><input type="checkbox" checked={!!cfg.requireTrend} onChange={e => set('requireTrend', e.target.checked)} /> Require higher-timeframe trend alignment</label>
          <label style={toggle(cfg.requireFVG)}><input type="checkbox" checked={!!cfg.requireFVG} onChange={e => set('requireFVG', e.target.checked)} /> Require Fair Value Gap</label>
          <label style={toggle(cfg.requireLiquiditySweep)}><input type="checkbox" checked={!!cfg.requireLiquiditySweep} onChange={e => set('requireLiquiditySweep', e.target.checked)} /> Require liquidity sweep</label>

          <div style={{ color: C.muted, fontSize: 11, marginTop: 14, lineHeight: 1.6 }}>
            Risk &amp; filter changes apply live. Broker / exchange / key changes apply when the executor restarts.
          </div>

          {err && <div style={{ color: '#ff9aa6', fontSize: 12, marginTop: 12 }}>{err}</div>}

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 20 }}>
            <button style={btn(busy ? '#114b41' : C.accent)} disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save settings'}</button>
            {saved && <span style={{ color: C.accent, fontSize: 12 }}>✓ Saved</span>}
            <div style={{ flex: 1 }} />
            <button style={{ ...btn('transparent'), color: C.muted, border: `1px solid ${C.border}` }} onClick={() => setPw(p => ({ ...p, open: !p.open }))}>Password</button>
            <button style={btn(C.danger)} onClick={() => { logout(); window.location.reload(); }}>Log out</button>
          </div>

          {pw.open && (
            <div style={{ marginTop: 14, padding: 14, background: C.card2, borderRadius: 8, border: `1px solid ${C.border}` }}>
              <label style={label}>Current password</label>
              <input style={input} type="password" value={pw.oldPassword} onChange={e => setPw(p => ({ ...p, oldPassword: e.target.value }))} />
              <label style={label}>New password (min 8)</label>
              <input style={input} type="password" value={pw.newPassword} onChange={e => setPw(p => ({ ...p, newPassword: e.target.value }))} />
              {pw.msg && <div style={{ color: '#ff9aa6', fontSize: 12, marginTop: 8 }}>{pw.msg}</div>}
              <button style={{ ...btn(C.accent), marginTop: 12 }} onClick={doChangePw}>Update password</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
