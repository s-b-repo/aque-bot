/* ═══════════════════════════════════════════════════════
   Signal Card Component
   ─────────────────────────────────────────────────────
   Displays a single trading signal with confluence tags,
   entry/SL/TP, confidence bar, and R:R ratio.
   ═══════════════════════════════════════════════════════ */

import { COLORS } from '../config/marketConfig.js';
import { getConfidenceColor } from '../engine/signalEngine.js';

export default function SignalCard({ sig }) {
  const isBuy = sig.type === 'BUY';
  const accentCol = isBuy ? COLORS.bull : COLORS.bear;
  const barCol = getConfidenceColor(sig.conf);

  return (
    <div className="signal-card" style={{ borderLeftColor: accentCol }}>
      {/* Header row */}
      <div className="signal-header">
        <div className="signal-header-left">
          <span
            className="signal-badge"
            style={{
              background: isBuy ? COLORS.bullAlpha : COLORS.bearAlpha,
              color: accentCol,
            }}
          >
            {sig.type}
          </span>
          <span className="signal-market">{sig.market}</span>
        </div>
        <span
          className={`signal-status ${sig.status === 'ACTIVE' ? 'active' : ''}`}
        >
          {sig.status}
        </span>
      </div>

      {/* Reason & confluence tags */}
      <div className="signal-reason">{sig.reason}</div>
      {sig.confluence && sig.confluence.length > 1 && (
        <div className="signal-confluence">
          {sig.confluence.map(tag => (
            <span key={tag} className="confluence-tag">
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Entry / SL / TP grid */}
      <div className="signal-levels">
        {[
          ['ENTRY', sig.entry, 'var(--color-text-primary)'],
          ['SL', sig.sl, COLORS.bear],
          ['TP', sig.tp, COLORS.bull],
        ].map(([lbl, val, col]) => (
          <div key={lbl}>
            <div className="signal-level-label">{lbl}</div>
            <div className="signal-level-value" style={{ color: col }}>
              {val}
            </div>
          </div>
        ))}
      </div>

      {/* Confidence & R:R */}
      <div className="signal-footer">
        <div className="signal-confidence">
          <span className="conf-label">Conf</span>
          <div className="conf-bar-track">
            <div
              className="conf-bar-fill"
              style={{ width: `${sig.conf}%`, background: barCol }}
            />
          </div>
          <span className="conf-value">{sig.conf}%</span>
        </div>
        <span className="signal-rr">{sig.rr}</span>
      </div>

      <div className="signal-time">{sig.time}</div>
    </div>
  );
}
