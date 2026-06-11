/* ═══════════════════════════════════════════════════════
   Error Boundary
   ─────────────────────────────────────────────────────
   Catches render/runtime errors in the dashboard tree so a
   single component fault doesn't white-screen the whole app.
   ═══════════════════════════════════════════════════════ */

import { Component } from 'react';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error('[Dashboard] Uncaught error:', error, info);
  }

  handleReload = () => {
    this.setState({ hasError: false, error: null });
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 14,
        background: '#0f1117', color: '#e1e4ea',
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace", padding: 40, textAlign: 'center',
      }}>
        <div style={{ fontSize: 40 }}>⚠</div>
        <div style={{ fontSize: 18, fontWeight: 700, color: '#F23645' }}>Dashboard error</div>
        <div style={{ fontSize: 12, color: '#6b7084', maxWidth: 520, lineHeight: 1.6 }}>
          The interface hit an unexpected error and stopped to avoid showing stale
          data. Your API server and EA are unaffected — they run independently.
        </div>
        {this.state.error?.message && (
          <pre style={{
            fontSize: 11, color: '#9ca3af', background: '#1a1d27',
            padding: '10px 14px', borderRadius: 8, maxWidth: 560, overflow: 'auto',
          }}>{String(this.state.error.message)}</pre>
        )}
        <button
          onClick={this.handleReload}
          style={{
            marginTop: 6, padding: '8px 18px', borderRadius: 8, cursor: 'pointer',
            background: '#089981', color: '#fff', border: 'none', fontWeight: 600,
          }}
        >
          Reload dashboard
        </button>
      </div>
    );
  }
}
