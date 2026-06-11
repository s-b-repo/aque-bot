import { useState } from 'react';
import { login, setToken } from '../config/authClient.js';
import { C, BRAND, shell, card, brand, sub, label, input, button, errorBox } from './authStyles.js';

export default function LoginPage({ onDone, serverError }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(serverError || '');

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const { token } = await login(username.trim(), password);
      setToken(token);
      onDone();
    } catch (err) {
      setError(err.message || 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={shell}>
      <form style={card} onSubmit={submit}>
        <div style={brand}>{BRAND.lead}<span style={{ color: C.accent }}>{BRAND.accent}</span></div>
        <div style={sub}>Sign in to your trading console</div>

        <label style={label}>Username</label>
        <input style={input} value={username} autoFocus autoComplete="username"
          onChange={e => setUsername(e.target.value)} placeholder="admin" />

        <label style={label}>Password</label>
        <input style={input} type="password" value={password} autoComplete="current-password"
          onChange={e => setPassword(e.target.value)} placeholder="••••••••" />

        {error && <div style={errorBox}>{error}</div>}

        <button style={button(busy || !username || !password)} disabled={busy || !username || !password} type="submit">
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
