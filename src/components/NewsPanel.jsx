/* ═══════════════════════════════════════════════════════
   News Panel Component
   ─────────────────────────────────────────────────────
   Scrollable financial news feed with sentiment badges.
   ═══════════════════════════════════════════════════════ */

import { COLORS } from '../config/marketConfig.js';

const SENTIMENT_CONFIG = {
  bullish: { emoji: '🟢', color: COLORS.bull, label: 'Bullish' },
  bearish: { emoji: '🔴', color: COLORS.bear, label: 'Bearish' },
  neutral: { emoji: '⚪', color: '#6b7084', label: 'Neutral' },
};

export default function NewsPanel({ news, loading, error }) {
  if (error) {
    return (
      <div className="news-panel">
        <div className="news-empty">
          <div className="news-error-icon">⚠️</div>
          <div>Failed to load news</div>
          <div className="news-error-detail">{error}</div>
        </div>
      </div>
    );
  }

  if (loading && news.length === 0) {
    return (
      <div className="news-panel">
        <div className="news-empty">
          <div className="news-loading-spinner" />
          <div>Loading market news...</div>
        </div>
      </div>
    );
  }

  if (news.length === 0) {
    return (
      <div className="news-panel">
        <div className="news-empty">
          <div>No news available</div>
          <div className="news-error-detail">
            Add your Finnhub API key in Settings
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="news-panel">
      {news.map(article => {
        const sentiment = SENTIMENT_CONFIG[article.sentiment];
        return (
          <a
            key={article.id}
            href={article.url}
            target="_blank"
            rel="noopener noreferrer"
            className={`news-article ${article.isNew ? 'new' : ''}`}
          >
            <div className="news-article-header">
              <span
                className="news-sentiment"
                style={{ color: sentiment.color }}
                title={sentiment.label}
              >
                {sentiment.emoji}
              </span>
              <span className="news-source">{article.source}</span>
              <span className="news-time">{article.timeAgo}</span>
            </div>
            <div className="news-headline">{article.headline}</div>
            {article.summary && (
              <div className="news-summary">
                {article.summary.slice(0, 120)}
                {article.summary.length > 120 ? '…' : ''}
              </div>
            )}
          </a>
        );
      })}
    </div>
  );
}
