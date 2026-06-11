/* ═══════════════════════════════════════════════════════
   Toast Notifier — In-App Signal Alerts
   ─────────────────────────────────────────────────────
   Floating toast container (top-right). Auto-dismisses.
   Hooks (useToasts / useNotificationPermission) live in
   ../hooks/useToasts.js.
   ═══════════════════════════════════════════════════════ */

import { useState } from 'react';

/* ── Toast Component ── */
function Toast({ toast, onDismiss }) {
  const [leaving, setLeaving] = useState(false);

  const handleClose = () => {
    setLeaving(true);
    setTimeout(() => onDismiss(toast.id), 300);
  };

  const borderColor =
    toast.type === 'buy'  ? 'var(--neon-bull)' :
    toast.type === 'sell' ? 'var(--neon-bear)' :
    '#818cf8';

  const icon =
    toast.type === 'buy'  ? '▲' :
    toast.type === 'sell' ? '▼' :
    '📡';

  return (
    <div
      className={`toast-item ${leaving ? 'toast-leaving' : 'toast-entering'}`}
      style={{ borderLeft: `3px solid ${borderColor}` }}
    >
      <div className="toast-header">
        <div className="toast-title">
          <span style={{ color: borderColor, marginRight: 5 }}>{icon}</span>
          {toast.title}
        </div>
        <button className="toast-close" onClick={handleClose}>✕</button>
      </div>
      <div className="toast-message">{toast.message}</div>
      {toast.signal && (
        <div className="toast-signal-details">
          <span>Entry: {toast.signal.entry}</span>
          <span>SL: {toast.signal.sl}</span>
          <span>TP: {toast.signal.tp}</span>
          <span style={{ color: borderColor }}>{toast.signal.rr}</span>
        </div>
      )}
      {/* Progress bar */}
      <div className="toast-progress">
        <div
          className="toast-progress-bar"
          style={{ background: borderColor }}
        />
      </div>
    </div>
  );
}

/* ── Toast Container ── */
export default function ToastNotifier({ toasts, onDismiss }) {
  if (toasts.length === 0) return null;

  return (
    <div className="toast-container">
      {toasts.map(toast => (
        <Toast key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
