import { useState } from 'react';
import { setup, setToken } from '../config/authClient.js';
import { C, shell, card, brand, sub, label, input, button, errorBox, note } from './authStyles.js';

const row = { display: 'flex', gap: 10 };
const half = { flex: 1 };

export default function SetupWizard({ onDone }) {
  const [f, setF] = useState({
    username: 'admin', password: '', confirm: '',
    broker: 'paper', exchangeId: 'binance', exchangeType: 'spot',
    exchangeKey: '', exchangeSecret: '', live: false,
    riskPercent: 1, dynamicRisk: true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    if (f.password.length < 8) return setError('Password must be at least 8 characters.');
    if (f.password !== f.confirm) return setError('Passwords do not match.');
    setBusy(true); setError('');
    try {
      const config = {
        broker: f.broker, exchangeId: f.exchangeId, exchangeType: f.exchangeType,
        exchangeKey: f.exchangeKey, exchangeSecret: f.exchangeSecret,
        live: f.broker === 'ccxt' ? f.live : false,
        riskPercent: Number(f.riskPercent) || 1, dynamicRisk: f.dynamicRisk,
      };
      const { token } = await setup(f.username.trim(), f.password, config);
      setToken(token);
      onDone();
    } catch (err) {
      setError(err.message || 'Setup failed');
    } finally { setBusy(false); }
  };

  return (
    <div style={shell}>
      <form style={{ ...card, maxWidth: 520 }} onSubmit={submit}>
        <div style={brand}>NEXUS<span style={{ color: C.accent }}>·SMC</span></div>
        <div style={sub}>First-time setup — create your admin account</div>

        <label style={label}>Admin username</label>
        <input style={input} value={f.username} autoFocus onChange={e => set('username', e.target.value)} />
        <div style={row}>
          <div style={half}>
            <label style={label}>Password</label>
            <input style={input} type="password" value={f.password} onChange={e => set('password', e.target.value)} placeholder="min 8 chars" />
          </div>
          <div style={half}>
            <label style={label}>Confirm</label>
            <input style={input} type="password" value={f.confirm} onChange={e => set('confirm', e.target.value)} />
          </div>
        </div>

        <div style={{ borderTop: `1px solid ${C.border}`, margin: '22px 0 4px' }} />
        <div style={{ ...label, marginTop: 16 }}>Trading mode</div>
        <div style={{ display: 'flex', gap: 8 }}>
          {['paper', 'ccxt'].map(b => (
            <button key={b} type="button" onClick={() => set('broker', b)}
              style={{ flex: 1, padding: '10px', borderRadius: 8, cursor: 'pointer', fontFamily: C.mono, fontWeight: 600,
                border: `1px solid ${f.broker === b ? C.accent : C.border}`,
                background: f.broker === b ? 'rgba(8,153,129,0.15)' : C.card2, color: f.broker === b ? C.accent : C.muted }}>
              {b === 'paper' ? '📝 Paper (safe)' : '🔌 Live exchange (CCXT)'}
            </button>
          ))}
        </div>

        {f.broker === 'ccxt' && (
          <>
            <div style={row}>
              <div style={half}>
                <label style={label}>Exchange</label>
                <input style={input} value={f.exchangeId} onChange={e => set('exchangeId', e.target.value)} placeholder="binance" />
              </div>
              <div style={half}>
                <label style={label}>Market type</label>
                <select style={input} value={f.exchangeType} onChange={e => set('exchangeType', e.target.value)}>
                  <option value="spot">spot (long only)</option>
                  <option value="swap">swap (long + short)</option>
                  <option value="future">future</option>
                </select>
              </div>
            </div>
            <label style={label}>API key</label>
            <input style={input} value={f.exchangeKey} onChange={e => set('exchangeKey', e.target.value)} autoComplete="off" />
            <label style={label}>API secret</label>
            <input style={input} type="password" value={f.exchangeSecret} onChange={e => set('exchangeSecret', e.target.value)} autoComplete="off" />
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, color: f.live ? C.danger : C.muted, fontSize: 12, cursor: 'pointer' }}>
              <input type="checkbox" checked={f.live} onChange={e => set('live', e.target.checked)} />
              Enable LIVE trading (real money). Leave OFF to use the exchange sandbox/testnet first.
            </label>
          </>
        )}

        <div style={row}>
          <div style={half}>
            <label style={label}>Risk % / trade</label>
            <input style={input} type="number" step="0.1" min="0.1" max="5" value={f.riskPercent} onChange={e => set('riskPercent', e.target.value)} />
          </div>
          <div style={{ ...half, display: 'flex', alignItems: 'flex-end' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: C.muted, fontSize: 12, cursor: 'pointer', paddingBottom: 11 }}>
              <input type="checkbox" checked={f.dynamicRisk} onChange={e => set('dynamicRisk', e.target.checked)} />
              Smart dynamic risk
            </label>
          </div>
        </div>

        {error && <div style={errorBox}>{error}</div>}
        <button style={button(busy)} disabled={busy} type="submit">{busy ? 'Creating…' : 'Create account & start'}</button>
        <div style={note}>You can change exchange keys and all risk settings later in Bot Settings. Defaults are conservative; paper mode trades nothing real.</div>
      </form>
    </div>
  );
}
