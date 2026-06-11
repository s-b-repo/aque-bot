/* ═══════════════════════════════════════════════════════
   Economic Calendar Component
   ─────────────────────────────────────────────────────
   Shows upcoming high-impact economic events with
   impact level indicators and countdown.
   ═══════════════════════════════════════════════════════ */

import { COLORS } from '../config/marketConfig.js';

const IMPACT_CONFIG = {
  high:   { emoji: '🔴', color: COLORS.bear, label: 'High Impact' },
  medium: { emoji: '🟡', color: COLORS.fvg, label: 'Medium Impact' },
  low:    { emoji: '🟢', color: COLORS.bull, label: 'Low Impact' },
};

function formatEventTime(timeStr) {
  try {
    const d = new Date(timeStr);
    return d.toLocaleString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return timeStr;
  }
}

function getCountdown(timeStr) {
  try {
    const diff = new Date(timeStr) - new Date();
    if (diff <= 0) return 'Now';
    const hours = Math.floor(diff / 3600000);
    const mins = Math.floor((diff % 3600000) / 60000);
    if (hours > 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
  } catch {
    return '';
  }
}

export default function EconomicCalendar({ events, loading }) {
  if (loading && events.length === 0) {
    return (
      <div className="calendar-panel">
        <div className="news-empty">
          <div className="news-loading-spinner" />
          <div>Loading economic calendar...</div>
        </div>
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="calendar-panel">
        <div className="news-empty">
          <div>No upcoming events</div>
          <div className="news-error-detail">
            Add your Finnhub API key in Settings
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="calendar-panel">
      {events.map(ev => {
        const impact = IMPACT_CONFIG[ev.impact] || IMPACT_CONFIG.low;
        return (
          <div
            key={ev.id}
            className={`calendar-event ${ev.isUpcoming ? '' : 'past'}`}
          >
            <div className="calendar-event-header">
              <div className="calendar-event-left">
                <span
                  className="calendar-impact"
                  title={impact.label}
                >
                  {impact.emoji}
                </span>
                <span className="calendar-country">{ev.country}</span>
              </div>
              {ev.isUpcoming && (
                <span className="calendar-countdown">
                  ⏱ {getCountdown(ev.time)}
                </span>
              )}
            </div>

            <div className="calendar-event-name">{ev.event}</div>

            <div className="calendar-event-time">
              {formatEventTime(ev.time)}
            </div>

            <div className="calendar-event-data">
              {ev.estimate !== null && ev.estimate !== undefined && (
                <span>
                  <span className="calendar-data-label">Est:</span>{' '}
                  {ev.estimate}{ev.unit || ''}
                </span>
              )}
              {ev.prev !== null && ev.prev !== undefined && (
                <span>
                  <span className="calendar-data-label">Prev:</span>{' '}
                  {ev.prev}{ev.unit || ''}
                </span>
              )}
              {ev.actual !== null && ev.actual !== undefined && (
                <span className="calendar-actual">
                  <span className="calendar-data-label">Act:</span>{' '}
                  {ev.actual}{ev.unit || ''}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
