/* ═══════════════════════════════════════════════════════
   Finnhub Data Hook
   ─────────────────────────────────────────────────────
   Live WebSocket trade stream + REST candle history.
   Requires a free API key from finnhub.io.
   ═══════════════════════════════════════════════════════ */

import { useEffect, useRef, useCallback } from 'react';

const FINNHUB_WS_BASE = 'wss://ws.finnhub.io';

/**
 * Stream real-time trades from Finnhub for the given symbols, invoking
 * onTrade({ symbol, price, volume, time }) for each.
 * @param {string[]} symbols  Finnhub symbols (e.g. ['^NDX','OANDA:EUR_USD'])
 * @param {Function} onTrade
 * @param {string}   apiKey
 * @param {boolean}  enabled
 */
export function useFinnhubStream(symbols, onTrade, apiKey, enabled = true) {
  const wsRef = useRef(null);
  const reconnectTimer = useRef(null);
  const onTradeRef = useRef(onTrade);
  const connectRef = useRef(null);
  // Stable primitive key for the symbol list — a valid effect/callback dependency
  // (the array prop's identity changes every render; this string doesn't).
  const symbolsKey = (symbols || []).join(',');

  useEffect(() => { onTradeRef.current = onTrade; }, [onTrade]);

  const connect = useCallback(() => {
    const list = symbolsKey ? symbolsKey.split(',') : [];
    if (!apiKey || !enabled || list.length === 0) return;

    const url = `${FINNHUB_WS_BASE}?token=${apiKey}`;
    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('[Finnhub WS] Connected');
        list.forEach(symbol => ws.send(JSON.stringify({ type: 'subscribe', symbol })));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type !== 'trade' || !msg.data) return;
          msg.data.forEach(trade => {
            onTradeRef.current?.({
              symbol: trade.s, price: trade.p, volume: trade.v || 0, time: Math.floor(trade.t / 1000),
            });
          });
        } catch (err) { console.error('[Finnhub WS] Parse error:', err); }
      };

      ws.onerror = (err) => { console.error('[Finnhub WS] Error:', err); };

      ws.onclose = (event) => {
        console.log(`[Finnhub WS] Disconnected (code: ${event.code})`);
        wsRef.current = null;
        if (enabled && event.code !== 1000) {
          reconnectTimer.current = setTimeout(() => {
            console.log('[Finnhub WS] Reconnecting...');
            connectRef.current?.();
          }, 5000);
        }
      };
    } catch (err) {
      console.error('[Finnhub WS] Connection failed:', err);
      reconnectTimer.current = setTimeout(() => connectRef.current?.(), 8000);
    }
  }, [symbolsKey, apiKey, enabled]);

  useEffect(() => { connectRef.current = connect; }, [connect]);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimer.current);
      if (wsRef.current) {
        (symbolsKey ? symbolsKey.split(',') : []).forEach(symbol => {
          try { wsRef.current.send(JSON.stringify({ type: 'unsubscribe', symbol })); } catch { /* socket closing */ }
        });
        wsRef.current.close(1000);
        wsRef.current = null;
      }
    };
  }, [connect, symbolsKey]);

  return { isConnected: () => wsRef.current?.readyState === WebSocket.OPEN };
}

/**
 * Fetch forex candle history from Finnhub REST API.
 * @param {string} symbol   — e.g. 'OANDA:EUR_USD'
 * @param {string} resolution — '1', '5', '15', '60', 'D'
 * @param {number} count     — Approximate number of candles
 * @param {string} apiKey
 * @returns {Promise<Array>} Array of { time, open, high, low, close, volume }
 */
export async function fetchFinnhubCandles(symbol, resolution, count, apiKey) {
  const to = Math.floor(Date.now() / 1000);
  // Calculate from based on resolution and count
  const resolutionSeconds = {
    '1': 60, '5': 300, '15': 900, '60': 3600, '240': 14400, 'D': 86400,
  };
  const secPerCandle = resolutionSeconds[resolution] || 300;
  const from = to - secPerCandle * count;

  const url = `https://finnhub.io/api/v1/forex/candle?symbol=${encodeURIComponent(symbol)}&resolution=${resolution}&from=${from}&to=${to}&token=${apiKey}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Finnhub API error: ${response.status}`);
  }

  const data = await response.json();

  if (data.s !== 'ok' || !data.t) {
    console.warn(`[Finnhub] No data for ${symbol}:`, data.s);
    return [];
  }

  return data.t.map((t, i) => ({
    time: t,
    open: data.o[i],
    high: data.h[i],
    low: data.l[i],
    close: data.c[i],
    volume: data.v?.[i] || 0,
  }));
}

/**
 * Fetch stock/index candle history from Finnhub REST API.
 */
export async function fetchFinnhubStockCandles(symbol, resolution, count, apiKey) {
  const to = Math.floor(Date.now() / 1000);
  const resolutionSeconds = {
    '1': 60, '5': 300, '15': 900, '60': 3600, '240': 14400, 'D': 86400,
  };
  const secPerCandle = resolutionSeconds[resolution] || 300;
  const from = to - secPerCandle * count;

  const url = `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=${resolution}&from=${from}&to=${to}&token=${apiKey}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Finnhub API error: ${response.status}`);
  }

  const data = await response.json();

  if (data.s !== 'ok' || !data.t) {
    return [];
  }

  return data.t.map((t, i) => ({
    time: t,
    open: data.o[i],
    high: data.h[i],
    low: data.l[i],
    close: data.c[i],
    volume: data.v?.[i] || 0,
  }));
}
