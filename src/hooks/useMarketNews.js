/* ═══════════════════════════════════════════════════════
   Market News Hook
   ─────────────────────────────────────────────────────
   Polls Finnhub for financial news and economic calendar
   events. Includes basic sentiment tagging.
   ═══════════════════════════════════════════════════════ */

import { useState, useEffect, useRef, useCallback } from 'react';

const FINNHUB_BASE = 'https://finnhub.io/api/v1';

// Simple keyword-based sentiment analysis
const BULLISH_WORDS = [
  'surge', 'rally', 'gain', 'jump', 'rise', 'soar', 'bull', 'high',
  'record', 'up', 'growth', 'profit', 'positive', 'beat', 'outperform',
  'boost', 'strong', 'recovery', 'breakout', 'upgrade', 'buy',
];

const BEARISH_WORDS = [
  'crash', 'plunge', 'drop', 'fall', 'decline', 'bear', 'low',
  'loss', 'down', 'recession', 'selloff', 'sell-off', 'negative',
  'miss', 'warn', 'cut', 'weak', 'fear', 'risk', 'downgrade',
];

function analyzeSentiment(headline) {
  const lower = headline.toLowerCase();
  let score = 0;

  BULLISH_WORDS.forEach(w => {
    if (lower.includes(w)) score++;
  });
  BEARISH_WORDS.forEach(w => {
    if (lower.includes(w)) score--;
  });

  if (score > 0) return 'bullish';
  if (score < 0) return 'bearish';
  return 'neutral';
}

function timeAgo(timestamp) {
  const seconds = Math.floor(Date.now() / 1000 - timestamp);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/**
 * Hook to fetch and auto-refresh financial news.
 * @param {string} apiKey    — Finnhub API key
 * @param {string} category  — 'general', 'forex', 'crypto', 'merger'
 * @param {number} pollIntervalMs — How often to refresh (default: 60s)
 * @param {boolean} enabled
 */
export function useMarketNews(apiKey, category = 'general', pollIntervalMs = 60000, enabled = true) {
  const [news, setNews] = useState([]);
  const [hasFetched, setHasFetched] = useState(false);
  const [error, setError] = useState(null);
  const seenIds = useRef(new Set());

  const fetchNews = useCallback(async () => {
    if (!apiKey || !enabled) return;
    try {
      const url = `${FINNHUB_BASE}/news?category=${category}&token=${apiKey}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();

      const articles = data
        .slice(0, 30)
        .map(article => {
          const id = article.id || `${article.datetime}-${article.headline?.slice(0, 20)}`;
          return {
            id,
            headline: article.headline,
            summary: article.summary,
            source: article.source,
            url: article.url,
            image: article.image,
            category: article.category,
            datetime: article.datetime,
            timeAgo: timeAgo(article.datetime),
            sentiment: analyzeSentiment(article.headline || ''),
            isNew: !seenIds.current.has(id),
          };
        });

      // Track seen articles (bounded — collapse to the current batch when large)
      articles.forEach(a => seenIds.current.add(a.id));
      if (seenIds.current.size > 500) {
        seenIds.current = new Set(articles.map(a => a.id));
      }

      setNews(articles);
      setError(null);
    } catch (err) {
      console.error('[News] Fetch error:', err);
      setError(err.message);
    }
    setHasFetched(true);
  }, [apiKey, category, enabled]);

  useEffect(() => {
    const kickoff = setTimeout(fetchNews, 0);     // schedule (don't call synchronously in the effect)
    const id = setInterval(fetchNews, pollIntervalMs);
    return () => { clearTimeout(kickoff); clearInterval(id); };
  }, [fetchNews, pollIntervalMs]);

  // Derived: we are "loading" until the first fetch resolves (avoids a synchronous
  // setState in the effect, which the older setLoading(true) caused).
  const loading = !!apiKey && !!enabled && !hasFetched && !error;
  return { news, loading, error, refresh: fetchNews };
}

/**
 * Hook to fetch economic calendar events.
 * @param {string} apiKey
 * @param {boolean} enabled
 */
export function useEconomicCalendar(apiKey, enabled = true) {
  const [events, setEvents] = useState([]);
  const [hasFetched, setHasFetched] = useState(false);

  const fetchCalendar = useCallback(async () => {
    if (!apiKey || !enabled) return;
    try {
      // Get events for the current week
      const now = new Date();
      const from = now.toISOString().split('T')[0];
      const toDate = new Date(now.getTime() + 7 * 86400000);
      const to = toDate.toISOString().split('T')[0];

      const url = `${FINNHUB_BASE}/calendar/economic?from=${from}&to=${to}&token=${apiKey}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();

      const calEvents = (data.economicCalendar || [])
        .filter(e => e.impact && e.impact !== 'low')
        .map(e => ({
          id: `${e.time}-${e.event}`,
          event: e.event,
          country: e.country,
          time: e.time,
          impact: e.impact, // 'high', 'medium', 'low'
          actual: e.actual,
          estimate: e.estimate,
          prev: e.prev,
          unit: e.unit,
          isUpcoming: new Date(e.time) > now,
        }))
        .sort((a, b) => new Date(a.time) - new Date(b.time));

      setEvents(calEvents);
    } catch (err) {
      console.error('[Calendar] Fetch error:', err);
    }
    setHasFetched(true);
  }, [apiKey, enabled]);

  useEffect(() => {
    const kickoff = setTimeout(fetchCalendar, 0); // schedule (don't call synchronously in the effect)
    const id = setInterval(fetchCalendar, 300000);
    return () => { clearTimeout(kickoff); clearInterval(id); };
  }, [fetchCalendar]);

  const loading = !!apiKey && !!enabled && !hasFetched;
  return { events, loading, refresh: fetchCalendar };
}
