/* ═══════════════════════════════════════════════════════
   Toast + browser-notification hooks
   ─────────────────────────────────────────────────────
   Separated from the ToastNotifier component so that file
   only exports a component (Fast Refresh safe).
   ═══════════════════════════════════════════════════════ */

import { useState, useEffect, useCallback, useRef } from 'react';

/* ── Request browser notification permission on mount ── */
export function useNotificationPermission() {
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }, []);
}

/* ── Fire a browser notification (if granted) ── */
export function fireBrowserNotification(title, body, icon = '📡') {
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(`${icon} ${title}`, {
      body,
      icon: '/favicon.svg',
      tag: title, // prevents duplicate stacking
    });
  }
}

/* ── Toast hook — use this in the parent component ── */
export function useToasts() {
  const [toasts, setToasts] = useState([]);
  const idRef = useRef(0);

  const addToast = useCallback(({ type = 'info', title, message, signal }) => {
    const id = ++idRef.current;
    setToasts(prev => [...prev, { id, type, title, message, signal }]);

    // Auto-dismiss after 6 seconds
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 6000);

    // Also fire a browser notification
    fireBrowserNotification(title, message, type === 'buy' ? '▲' : type === 'sell' ? '▼' : '📡');
  }, []);

  const dismiss = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  return { toasts, addToast, dismiss };
}
