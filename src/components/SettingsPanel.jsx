/* ═══════════════════════════════════════════════════════
   Settings Panel Component
   ─────────────────────────────────────────────────────
   Modal for API key configuration, stored in localStorage.
   ═══════════════════════════════════════════════════════ */

import { useState } from 'react';
import { saveSettings } from '../config/settingsStore.js';

// The parent mounts this only while open, so initializing the draft from the
// `settings` prop here is correct without a prop→state sync effect.
export default function SettingsPanel({ onClose, settings, onSave }) {
  const [local, setLocal] = useState(settings);

  const handleSave = () => {
    onSave(local);
    saveSettings(local);
    onClose();
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-modal" onClick={e => e.stopPropagation()}>
        <div className="settings-header">
          <h3>⚙ Settings</h3>
          <button className="settings-close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="settings-body">
          {/* API Key */}
          <div className="settings-group">
            <label className="settings-label">
              Finnhub API Key
              <span className="settings-hint">
                Get a free key at{' '}
                <a
                  href="https://finnhub.io"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  finnhub.io
                </a>
              </span>
            </label>
            <input
              type="password"
              className="settings-input"
              placeholder="Enter your Finnhub API key..."
              value={local.finnhubApiKey}
              onChange={e =>
                setLocal(prev => ({ ...prev, finnhubApiKey: e.target.value }))
              }
            />
            <div className="settings-input-note">
              {local.finnhubApiKey
                ? '✅ Key configured'
                : '⚠️ Required for forex data, news, and economic calendar'}
            </div>
          </div>

          {/* Notifications */}
          <div className="settings-group">
            <label className="settings-label">Browser Notifications</label>
            <div className="settings-toggle-row">
              <span>Alert on high-confidence signals</span>
              <button
                className={`settings-toggle ${local.notifications ? 'on' : ''}`}
                onClick={() =>
                  setLocal(prev => ({
                    ...prev,
                    notifications: !prev.notifications,
                  }))
                }
              >
                <div className="settings-toggle-knob" />
              </button>
            </div>
          </div>

          {/* Default timeframe */}
          <div className="settings-group">
            <label className="settings-label">Default Timeframe</label>
            <div className="settings-tf-options">
              {['1m', '5m', '15m', '1h', '4h', '1d'].map(tf => (
                <button
                  key={tf}
                  className={`settings-tf-btn ${
                    local.defaultTimeframe === tf ? 'active' : ''
                  }`}
                  onClick={() =>
                    setLocal(prev => ({ ...prev, defaultTimeframe: tf }))
                  }
                >
                  {tf.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          {/* Connection Status */}
          <div className="settings-group">
            <label className="settings-label">Data Sources</label>
            <div className="settings-sources">
              <div className="settings-source">
                <span className="source-dot connected" />
                <span>Binance (Crypto/Gold)</span>
                <span className="source-status">Free — No key needed</span>
              </div>
              <div className="settings-source">
                <span
                  className={`source-dot ${
                    local.finnhubApiKey ? 'connected' : 'disconnected'
                  }`}
                />
                <span>Finnhub (Forex/News)</span>
                <span className="source-status">
                  {local.finnhubApiKey ? 'Configured' : 'Key required'}
                </span>
              </div>
            </div>
          </div>
        </div>

        <div className="settings-footer">
          <button className="settings-cancel-btn" onClick={onClose}>
            Cancel
          </button>
          <button className="settings-save-btn" onClick={handleSave}>
            Save Settings
          </button>
        </div>
      </div>
    </div>
  );
}
