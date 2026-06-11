/* ═══════════════════════════════════════════════════════
   Market Configuration — Data source mappings for each
   tradable market. Binance (crypto/gold), Finnhub (forex)
   ═══════════════════════════════════════════════════════ */

export const DATA_SOURCE = {
  BINANCE: 'binance',
  FINNHUB: 'finnhub',
  YAHOO: 'yahoo',
};

export const TIMEFRAMES = [
  { label: '1m',  value: '1m',  binance: '1m',  finnhub: '1',    seconds: 60 },
  { label: '5m',  value: '5m',  binance: '5m',  finnhub: '5',    seconds: 300 },
  { label: '15m', value: '15m', binance: '15m', finnhub: '15',   seconds: 900 },
  { label: '1H',  value: '1h',  binance: '1h',  finnhub: '60',   seconds: 3600 },
  { label: '4H',  value: '4h',  binance: '4h',  finnhub: '240',  seconds: 14400 },
  { label: '1D',  value: '1d',  binance: '1d',  finnhub: 'D',    seconds: 86400 },
];

export const DEFAULT_TIMEFRAME = '5m';

export const MARKETS = {
  'BTC/USD': {
    displayName: 'BTC/USD',
    source: DATA_SOURCE.BINANCE,
    binanceSymbol: 'BTCUSDT',
    binanceWs: 'btcusdt',
    futures: false,
    dec: 0,
    pipSize: 1,
    category: 'crypto',
    icon: '₿',
  },
  'EUR/USDT': {
    displayName: 'EUR/USDT',
    source: DATA_SOURCE.BINANCE,
    binanceSymbol: 'EURUSDT',
    binanceWs: 'eurusdt',
    futures: false,
    dec: 5,
    pipSize: 0.0001,
    // NOTE: this is the Binance EUR/USDT spot pair (a crypto-quoted price),
    // NOT a broker EURUSD forex feed. Do not trade it on a EURUSD forex
    // symbol — the price geometry differs (audit SRV-02). The EA must map
    // EURUSDT to a broker symbol whose live price matches this feed, and the
    // EA rejects the trade if broker price diverges from the signal price.
    category: 'crypto',
    icon: '€',
  },
  'Nasdaq': {
    displayName: 'Nasdaq',
    source: DATA_SOURCE.YAHOO,
    // Yahoo (via the API server) supplies candle HISTORY; when a Finnhub key is
    // configured, the live WebSocket overlays real-time ticks on top of it.
    finnhubSymbol: '^NDX',
    dec: 2,
    pipSize: 0.01,
    category: 'index',
    icon: '📈',
  },
};

/* ── Color Palette ── */
export const COLORS = {
  bull:       '#089981',   // TradingView teal
  bear:       '#F23645',   // TradingView red
  bullAlpha:  'rgba(8,153,129,0.15)',
  bearAlpha:  'rgba(242,54,69,0.15)',
  fvg:        '#BA7517',
  fvgAlpha:   'rgba(186,117,23,0.10)',
  struct:     '#7F77DD',
  bos:        '#089981',
  choch:      '#7F77DD',
  volume:     'rgba(8,153,129,0.35)',
  volumeBear: 'rgba(242,54,69,0.35)',
  grid:       'rgba(42,46,63,0.6)',
  crosshair:  '#758696',
};

/* ── Helpers ── */
export function getMarketConfig(market) {
  return MARKETS[market] || null;
}

export function getTimeframe(value) {
  return TIMEFRAMES.find(tf => tf.value === value) || TIMEFRAMES[1]; // default 5m
}

export function getBinanceMarkets() {
  return Object.entries(MARKETS)
    .filter(([, cfg]) => cfg.source === DATA_SOURCE.BINANCE && cfg.binanceSymbol)
    .map(([key, cfg]) => ({ key, ...cfg }));
}

export function getFinnhubMarkets() {
  return Object.entries(MARKETS)
    .filter(([, cfg]) => cfg.source === DATA_SOURCE.FINNHUB)
    .map(([key, cfg]) => ({ key, ...cfg }));
}
