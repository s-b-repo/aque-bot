import { useState, useEffect } from 'react';
import { getConfig, saveConfig, changePassword, logout, me } from '../config/authClient.js';
import { C, label, input } from './authStyles.js';

/* ═══════════════════════════════════════════════════════
   Unified Settings — everything configurable in one place,
   fully editable after first-time setup:
     Trading  · broker / exchange / keys / paper↔live  (swap anytime)
     Risk     · sizing, kill-switches, dynamic risk, filters
     Data     · Finnhub key, default timeframe, notifications
     Account  · change password, sign out
   ═══════════════════════════════════════════════════════ */

const overlay = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.62)', backdropFilter: 'blur(3px)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16,
};
const modal = {
  width: '100%', maxWidth: 720, height: 'min(640px, 92vh)', display: 'flex',
  background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, overflow: 'hidden', fontFamily: C.mono,
};
const rail = { width: 160, flexShrink: 0, background: '#12141c', borderRight: `1px solid ${C.border}`, padding: '14px 8px', display: 'flex', flexDirection: 'column', gap: 4 };
const tabBtn = (on) => ({
  textAlign: 'left', padding: '10px 12px', borderRadius: 8, cursor: 'pointer', border: 'none',
  background: on ? 'rgba(8,153,129,0.15)' : 'transparent', color: on ? C.accent : C.muted,
  fontFamily: C.mono, fontWeight: 600, fontSize: 13,
});
const body = { flex: 1, display: 'flex', flexDirection: 'column' };
const head = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 18px', borderBottom: `1px solid ${C.border}` };
const content = { flex: 1, overflowY: 'auto', padding: '6px 18px 18px' };
const foot = { display: 'flex', alignItems: 'center', gap: 10, padding: '12px 18px', borderTop: `1px solid ${C.border}` };
const section = { marginTop: 16, fontSize: 11, color: C.indigo, textTransform: 'uppercase', letterSpacing: 1, fontWeight: 700 };
const row = { display: 'flex', gap: 10 };
const half = { flex: 1, minWidth: 0 };
const toggle = (on) => ({ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 12, color: on ? C.accent : C.muted, cursor: 'pointer' });
const btn = (bg, disabled) => ({ padding: '10px 16px', borderRadius: 8, border: 'none', cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: C.mono, fontWeight: 700, fontSize: 13, color: '#fff', background: bg, opacity: disabled ? 0.6 : 1 });

const TABS = [
  { key: 'trading', label: '🔌 Trading' },
  { key: 'risk', label: '🎯 Risk' },
  { key: 'data', label: '📡 Data' },
  { key: 'account', label: '👤 Account' },
];
const TF = ['1m', '5m', '15m', '1h', '4h', '1d'];

export default function Settings({ onClose, settings, onSaveSettings, initialTab = 'trading' }) {
  const [tab, setTab] = useState(initialTab);

  // server (executor) config
  const [cfg, setCfg] = useState(null);
  const [cfgErr, setCfgErr] = useState('');
  const [cfgSaved, setCfgSaved] = useState(false);
  const [cfgBusy, setCfgBusy] = useState(false);
  const [confirmLive, setConfirmLive] = useState(false);
  const setC = (k, v) => { setCfg(p => ({ ...p, [k]: v })); setCfgSaved(false); };

  // dashboard (localStorage) settings
  const [local, setLocal] = useState(settings);
  const setL = (k, v) => setLocal(p => ({ ...p, [k]: v }));

  // account
  const [username, setUsername] = useState('');
  const [pw, setPw] = useState({ oldPassword: '', newPassword: '', confirm: '', msg: '', ok: false });

  useEffect(() => { getConfig().then(setCfg).catch(e => setCfgErr(e.message)); }, []);
  useEffect(() => { me().then(r => setUsername(r.username)).catch(() => {}); }, []);
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const saveServer = async () => {
    setCfgBusy(true); setCfgErr('');
    try {
      const patch = { ...cfg };
      for (const f of ['exchangeKey', 'exchangeSecret', 'exchangePassword']) {
        if (!patch[f]) delete patch[f];
        delete patch[`has${f[0].toUpperCase()}${f.slice(1)}`];
      }
      setCfg(await saveConfig(patch)); setCfgSaved(true); setConfirmLive(false);
    } catch (e) { setCfgErr(e.message); }
    finally { setCfgBusy(false); }
  };

  const saveData = () => { onSaveSettings(local); setCfgSaved(true); };

  const doChangePw = async () => {
    if (pw.newPassword !== pw.confirm) return setPw(p => ({ ...p, msg: 'Passwords do not match', ok: false }));
    try { await changePassword(pw.oldPassword, pw.newPassword); setPw({ oldPassword: '', newPassword: '', confirm: '', msg: 'Password updated', ok: true }); }
    catch (e) { setPw(p => ({ ...p, msg: e.message, ok: false })); }
  };

  const secretPH = (has) => (has ? '•••••••• set (blank = keep)' : 'not set');
  const mode = !cfg ? '' : cfg.broker === 'ccxt' ? (cfg.live ? 'LIVE' : 'TESTNET') : 'PAPER';

  return (
    <div style={overlay} onClick={onClose}>
      <div style={modal} onClick={e => e.stopPropagation()}>
        <div style={rail}>
          <div style={{ color: C.text, fontWeight: 800, padding: '4px 12px 12px', fontSize: 15 }}>
            Aque<span style={{ color: C.accent }}> Bot</span>
          </div>
          {TABS.map(t => (
            <button key={t.key} style={tabBtn(tab === t.key)} onClick={() => setTab(t.key)}>{t.label}</button>
          ))}
          {mode && (
            <div style={{ marginTop: 'auto', padding: '8px 12px', fontSize: 10, color: C.muted }}>
              Mode: <span style={{ color: mode === 'LIVE' ? C.danger : mode === 'TESTNET' ? '#BA7517' : C.muted, fontWeight: 700 }}>{mode}</span>
            </div>
          )}
        </div>

        <div style={body}>
          <div style={head}>
            <div style={{ fontWeight: 700, color: C.text }}>⚙ Settings</div>
            <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.muted, fontSize: 18, cursor: 'pointer' }}>✕</button>
          </div>

          <div style={content}>
            {!cfg && tab !== 'data' && tab !== 'account' && <div style={{ color: C.muted, padding: 20 }}>{cfgErr || 'Loading…'}</div>}

            {/* ───────── TRADING ───────── */}
            {tab === 'trading' && cfg && (
              <>
                <div style={section}>Trading mode — switch anytime</div>
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  {['paper', 'ccxt'].map(b => (
                    <button key={b} type="button" onClick={() => setC('broker', b)}
                      style={{ flex: 1, padding: '12px', borderRadius: 8, cursor: 'pointer', fontFamily: C.mono, fontWeight: 600,
                        border: `1px solid ${cfg.broker === b ? C.accent : C.border}`,
                        background: cfg.broker === b ? 'rgba(8,153,129,0.15)' : C.card2, color: cfg.broker === b ? C.accent : C.muted }}>
                      {b === 'paper' ? '📝 Paper (simulated)' : '🔌 Live exchange (CCXT)'}
                    </button>
                  ))}
                </div>

                {cfg.broker === 'ccxt' && (
                  <>
                    <div style={row}>
                      <div style={half}><label style={label}>Exchange</label><input style={input} value={cfg.exchangeId || ''} onChange={e => setC('exchangeId', e.target.value)} placeholder="binance" /></div>
                      <div style={half}><label style={label}>Market type</label>
                        <select style={input} value={cfg.exchangeType || 'spot'} onChange={e => setC('exchangeType', e.target.value)}>
                          <option value="spot">spot (long only)</option><option value="swap">swap (long+short)</option><option value="future">future</option>
                        </select>
                      </div>
                    </div>
                    <label style={label}>API key</label>
                    <input style={input} autoComplete="off" placeholder={secretPH(cfg.hasExchangeKey)} value={cfg.exchangeKey || ''} onChange={e => setC('exchangeKey', e.target.value)} />
                    <label style={label}>API secret</label>
                    <input style={input} type="password" autoComplete="off" placeholder={secretPH(cfg.hasExchangeSecret)} value={cfg.exchangeSecret || ''} onChange={e => setC('exchangeSecret', e.target.value)} />

                    {!cfg.live && !confirmLive && (
                      <label style={toggle(false)}>
                        <input type="checkbox" checked={false} onChange={() => setConfirmLive(true)} />
                        Enable LIVE trading (currently sandbox/testnet)
                      </label>
                    )}
                    {confirmLive && (
                      <div style={{ marginTop: 12, padding: 12, border: `1px solid ${C.danger}`, borderRadius: 8, background: 'rgba(242,54,69,0.08)' }}>
                        <div style={{ color: '#ff9aa6', fontSize: 12, lineHeight: 1.5 }}>⚠ LIVE mode places REAL orders with REAL money on {cfg.exchangeId}. Make sure you tested on the sandbox first.</div>
                        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                          <button style={btn(C.danger)} onClick={() => { setC('live', true); setConfirmLive(false); }}>Yes, enable LIVE</button>
                          <button style={{ ...btn('transparent'), color: C.muted, border: `1px solid ${C.border}` }} onClick={() => setConfirmLive(false)}>Cancel</button>
                        </div>
                      </div>
                    )}
                    {cfg.live && (
                      <label style={toggle(true)}>
                        <input type="checkbox" checked onChange={() => setC('live', false)} />
                        <span style={{ color: C.danger }}>LIVE trading ON — real money. Uncheck for sandbox.</span>
                      </label>
                    )}
                    <div style={{ color: C.muted, fontSize: 11, marginTop: 12, lineHeight: 1.6 }}>
                      Exchange / key / mode changes take effect when the executor restarts
                      (<code>docker compose restart executor</code>, or restart <code>npm run executor</code>). Risk &amp; filter changes apply live.
                    </div>
                  </>
                )}

                <div style={section}>Symbol map</div>
                <input style={input} value={cfg.symbolMap || ''} onChange={e => setC('symbolMap', e.target.value)} placeholder="BTCUSD=BTC/USDT,EURUSDT=EUR/USDT" />
                <label style={toggle(cfg.tradeEnabled)}><input type="checkbox" checked={!!cfg.tradeEnabled} onChange={e => setC('tradeEnabled', e.target.checked)} /> Auto-trading enabled</label>
              </>
            )}

            {/* ───────── RISK ───────── */}
            {tab === 'risk' && cfg && (
              <>
                <div style={section}>Position sizing</div>
                <div style={row}>
                  <div style={half}><label style={label}>Risk % / trade</label><input style={input} type="number" step="0.1" value={cfg.riskPercent} onChange={e => setC('riskPercent', Number(e.target.value))} /></div>
                  <div style={half}><label style={label}>Max $ / trade</label><input style={input} type="number" value={cfg.maxRiskDollars} onChange={e => setC('maxRiskDollars', Number(e.target.value))} /></div>
                </div>
                <label style={toggle(cfg.dynamicRisk)}><input type="checkbox" checked={!!cfg.dynamicRisk} onChange={e => setC('dynamicRisk', e.target.checked)} /> Smart dynamic risk (confidence + realized-edge Kelly, de-risk on losses/drawdown)</label>

                <div style={section}>Kill switches &amp; caps</div>
                <div style={row}>
                  <div style={half}><label style={label}>Max open trades</label><input style={input} type="number" value={cfg.maxOpenTrades} onChange={e => setC('maxOpenTrades', Number(e.target.value))} /></div>
                  <div style={half}><label style={label}>Max trades / day</label><input style={input} type="number" value={cfg.maxTradesPerDay} onChange={e => setC('maxTradesPerDay', Number(e.target.value))} /></div>
                </div>
                <div style={row}>
                  <div style={half}><label style={label}>Daily loss % halt</label><input style={input} type="number" value={cfg.maxDailyLossPercent} onChange={e => setC('maxDailyLossPercent', Number(e.target.value))} /></div>
                  <div style={half}><label style={label}>Max consec. losses</label><input style={input} type="number" value={cfg.maxConsecutiveLosses} onChange={e => setC('maxConsecutiveLosses', Number(e.target.value))} /></div>
                </div>
                <div style={row}>
                  <div style={half}><label style={label}>Portfolio risk % cap</label><input style={input} type="number" value={cfg.maxPortfolioRiskPct} onChange={e => setC('maxPortfolioRiskPct', Number(e.target.value))} /></div>
                  <div style={half}><label style={label}>Min confidence %</label><input style={input} type="number" value={cfg.minConfidence} onChange={e => setC('minConfidence', Number(e.target.value))} /></div>
                </div>

                <div style={section}>Confluence filters</div>
                <label style={toggle(cfg.requireTrend)}><input type="checkbox" checked={!!cfg.requireTrend} onChange={e => setC('requireTrend', e.target.checked)} /> Require higher-timeframe trend alignment</label>
                <label style={toggle(cfg.requireFVG)}><input type="checkbox" checked={!!cfg.requireFVG} onChange={e => setC('requireFVG', e.target.checked)} /> Require Fair Value Gap</label>
                <label style={toggle(cfg.requireLiquiditySweep)}><input type="checkbox" checked={!!cfg.requireLiquiditySweep} onChange={e => setC('requireLiquiditySweep', e.target.checked)} /> Require liquidity sweep</label>
              </>
            )}

            {/* ───────── DATA ───────── */}
            {tab === 'data' && (
              <>
                <div style={section}>Finnhub API key</div>
                <input style={input} type="password" placeholder="for news, calendar & live forex/index ticks" value={local.finnhubApiKey || ''} onChange={e => setL('finnhubApiKey', e.target.value)} />
                <div style={{ fontSize: 11, color: C.muted, marginTop: 6 }}>Free key at <a href="https://finnhub.io" target="_blank" rel="noopener noreferrer" style={{ color: C.accent }}>finnhub.io</a>. Crypto data needs no key.</div>

                <div style={section}>Default timeframe</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {TF.map(t => (
                    <button key={t} onClick={() => setL('defaultTimeframe', t)}
                      style={{ padding: '8px 12px', borderRadius: 8, cursor: 'pointer', fontFamily: C.mono, fontWeight: 600,
                        border: `1px solid ${local.defaultTimeframe === t ? C.accent : C.border}`,
                        background: local.defaultTimeframe === t ? 'rgba(8,153,129,0.15)' : C.card2, color: local.defaultTimeframe === t ? C.accent : C.muted }}>
                      {t.toUpperCase()}
                    </button>
                  ))}
                </div>
                <label style={toggle(local.notifications)}><input type="checkbox" checked={!!local.notifications} onChange={e => setL('notifications', e.target.checked)} /> Browser notifications on new signals</label>
              </>
            )}

            {/* ───────── ACCOUNT ───────── */}
            {tab === 'account' && (
              <>
                <div style={section}>Account</div>
                <div style={{ color: C.text, fontSize: 13, marginTop: 8 }}>Signed in as <b style={{ color: C.accent }}>{username || '…'}</b></div>
                <div style={section}>Change password</div>
                <label style={label}>Current password</label>
                <input style={input} type="password" value={pw.oldPassword} onChange={e => setPw(p => ({ ...p, oldPassword: e.target.value }))} />
                <div style={row}>
                  <div style={half}><label style={label}>New password</label><input style={input} type="password" value={pw.newPassword} onChange={e => setPw(p => ({ ...p, newPassword: e.target.value }))} /></div>
                  <div style={half}><label style={label}>Confirm</label><input style={input} type="password" value={pw.confirm} onChange={e => setPw(p => ({ ...p, confirm: e.target.value }))} /></div>
                </div>
                {pw.msg && <div style={{ color: pw.ok ? C.accent : '#ff9aa6', fontSize: 12, marginTop: 8 }}>{pw.msg}</div>}
                <button style={{ ...btn(C.accent), marginTop: 12 }} onClick={doChangePw}>Update password</button>
                <div style={{ borderTop: `1px solid ${C.border}`, margin: '20px 0 0' }} />
                <button style={{ ...btn(C.danger), marginTop: 16 }} onClick={() => { logout(); window.location.reload(); }}>Sign out</button>
              </>
            )}
          </div>

          <div style={foot}>
            {cfgErr && <span style={{ color: '#ff9aa6', fontSize: 12 }}>{cfgErr}</span>}
            {cfgSaved && <span style={{ color: C.accent, fontSize: 12 }}>✓ Saved</span>}
            <div style={{ flex: 1 }} />
            {(tab === 'trading' || tab === 'risk') && <button style={btn(cfgBusy ? '#114b41' : C.accent, cfgBusy || !cfg)} disabled={cfgBusy || !cfg} onClick={saveServer}>{cfgBusy ? 'Saving…' : 'Save'}</button>}
            {tab === 'data' && <button style={btn(C.accent)} onClick={saveData}>Save</button>}
            <button style={{ ...btn('transparent'), color: C.muted, border: `1px solid ${C.border}` }} onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    </div>
  );
}
