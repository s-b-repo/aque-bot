/* ═══════════════════════════════════════════════════════
   Binance WebSocket Stream Hook
   ─────────────────────────────────────────────────────
   Connects to Binance public WebSocket for real-time
   kline (candlestick) data. No API key required.
   ═══════════════════════════════════════════════════════ */

import { useEffect, useRef, useCallback } from 'react';

const BINANCE_WS_BASE = 'wss://stream.binance.com/ws';
const BINANCE_FUTURES_WS_BASE = 'wss://fstream.binance.com/ws';

/**
 * Hook to stream real-time kline data from Binance WebSocket.
 *
 * @param {string} symbol   — Binance WS symbol (e.g. 'btcusdt')
 * @param {string} interval — Kline interval (e.g. '5m')
 * @param {Function} onKline — Callback: ({ time, open, high, low, close, volume, isClosed }) => void
 * @param {boolean} enabled  — Whether to connect
 * @param {boolean} futures  — Use futures WebSocket endpoint
 */
export function useBinanceStream(symbol, interval, onKline, enabled = true, futures = false) {
  const wsRef = useRef(null);
  const reconnectTimer = useRef(null);
  const onKlineRef = useRef(onKline);
  const connectRef = useRef(null);

  // Keep callback ref fresh without reconnecting
  useEffect(() => {
    onKlineRef.current = onKline;
  }, [onKline]);

  const connect = useCallback(() => {
    if (!symbol || !interval || !enabled) return;

    const base = futures ? BINANCE_FUTURES_WS_BASE : BINANCE_WS_BASE;
    const url = `${base}/${symbol}@kline_${interval}`;

    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log(`[Binance WS] Connected: ${symbol}@kline_${interval}`);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.e !== 'kline') return;

          const k = msg.k;
          const candle = {
            time: Math.floor(k.t / 1000), // Unix seconds for lightweight-charts
            open: parseFloat(k.o),
            high: parseFloat(k.h),
            low: parseFloat(k.l),
            close: parseFloat(k.c),
            volume: parseFloat(k.v),
            isClosed: k.x, // true when the candle is finalized
          };

          onKlineRef.current?.(candle);
        } catch (err) {
          console.error('[Binance WS] Parse error:', err);
        }
      };

      ws.onerror = (err) => {
        console.error('[Binance WS] Error:', err);
      };

      ws.onclose = (event) => {
        console.log(`[Binance WS] Disconnected (code: ${event.code})`);
        wsRef.current = null;

        // Auto-reconnect after 3 seconds (unless intentionally closed). Reconnect
        // through a ref so the latest connect() is used and there is no
        // use-before-declaration self-reference.
        if (enabled && event.code !== 1000) {
          reconnectTimer.current = setTimeout(() => {
            console.log('[Binance WS] Reconnecting...');
            connectRef.current?.();
          }, 3000);
        }
      };
    } catch (err) {
      console.error('[Binance WS] Connection failed:', err);
      reconnectTimer.current = setTimeout(() => connectRef.current?.(), 5000);
    }
  }, [symbol, interval, enabled, futures]);

  useEffect(() => { connectRef.current = connect; }, [connect]);

  useEffect(() => {
    connect();

    return () => {
      clearTimeout(reconnectTimer.current);
      if (wsRef.current) {
        wsRef.current.close(1000); // Normal closure
        wsRef.current = null;
      }
    };
  }, [connect]);

  // Return connection state checker
  return {
    isConnected: () =>
      wsRef.current?.readyState === WebSocket.OPEN,
    disconnect: () => {
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close(1000);
    },
  };
}

/**
 * Fetch historical klines from Binance REST API.
 * Supports both spot and futures endpoints.
 * @param {string} symbol   — e.g. 'BTCUSDT' or 'XAUUSDT'
 * @param {string} interval — e.g. '5m'
 * @param {number} limit    — Number of candles (max 1000)
 * @param {boolean} futures — Use futures API (for XAUUSDT etc.)
 * @returns {Promise<Array>} Array of { time, open, high, low, close, volume }
 */
export async function fetchBinanceKlines(symbol, interval, limit = 200, futures = false) {
  const base = futures
    ? 'https://fapi.binance.com/fapi/v1/klines'
    : 'https://api.binance.com/api/v3/klines';
  const url = `${base}?symbol=${symbol}&interval=${interval}&limit=${limit}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Binance API error: ${response.status}`);
  }

  const data = await response.json();

  return data.map(k => ({
    time: Math.floor(k[0] / 1000),
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}
