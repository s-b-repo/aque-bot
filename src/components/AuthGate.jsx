import { useState, useEffect } from 'react';
import { getSetupStatus, me, getToken, setToken } from '../config/authClient.js';
import SetupWizard from './SetupWizard.jsx';
import LoginPage from './LoginPage.jsx';
import { C, shell } from './authStyles.js';

function Splash({ children }) {
  return (
    <div style={{ ...shell, flexDirection: 'column', gap: 14, color: C.muted }}>
      <div style={{ fontSize: 22, fontWeight: 800, color: C.text }}>NEXUS<span style={{ color: C.accent }}>·SMC</span></div>
      <div style={{ fontSize: 13 }}>{children}</div>
    </div>
  );
}

export default function AuthGate({ children }) {
  const [phase, setPhase] = useState('loading'); // loading | setup | login | ready
  const [error, setError] = useState('');

  // Resolve auth state once on mount. All setState happens AFTER an await, so
  // nothing is set synchronously inside the effect body.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await getSetupStatus();
        if (cancelled) return;
        if (s.needsSetup) { setPhase('setup'); return; }
        if (getToken()) {
          try { await me(); if (!cancelled) setPhase('ready'); return; }
          catch (e) {
            if (e.status === 401 || e.status === 403) setToken('');  // genuinely expired → login
            else throw e;            // transient (network/5xx) → keep token, show "unreachable"
          }
        }
        if (!cancelled) setPhase('login');
      } catch {
        if (cancelled) return;
        setError('Cannot reach the API server. Make sure it is running, then retry.');
        setPhase('login');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (phase === 'loading') return <Splash>Connecting…</Splash>;
  if (phase === 'setup') return <SetupWizard onDone={() => setPhase('ready')} />;
  if (phase === 'login') return <LoginPage onDone={() => setPhase('ready')} serverError={error} />;
  return children;
}
