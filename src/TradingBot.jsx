/* ═══════════════════════════════════════════════════════
   NEXUS·SMC — Real-Time Trading Dashboard
   ─────────────────────────────────────────────────────
   Main dashboard component that orchestrates:
   - Live market data (Binance WS + Finnhub)
   - TradingView-quality charts (lightweight-charts)
   - SMC pattern detection on real candles
   - Financial news & economic calendar
   - Signal generation with confluence scoring
   ═══════════════════════════════════════════════════════ */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';

// Config
import {
  MARKETS, COLORS, TIMEFRAMES, DATA_SOURCE,
  getMarketConfig, getTimeframe,
} from './config/marketConfig.js';

// Engines
import { detectSMC, getMarketBias } from './engine/smcEngine.js';
import { buildSignals } from './engine/signalEngine.js';

// Hooks
import { useBinanceStream, fetchBinanceKlines } from './hooks/useBinanceStream.js';
import { useFinnhubStream, fetchFinnhubCandles } from './hooks/useFinnhubStream.js';
import { useMarketNews, useEconomicCalendar } from './hooks/useMarketNews.js';

// Components
import TVChart from './components/TVChart.jsx';
import SignalCard from './components/SignalCard.jsx';
import NewsPanel from './components/NewsPanel.jsx';
import EconomicCalendar from './components/EconomicCalendar.jsx';
import TradesPanel from './components/TradesPanel.jsx';
import SettingsPanel from './components/SettingsPanel.jsx';
import BotSettings from './components/BotSettings.jsx';
import AutoTradeToggle from './components/AutoTradeToggle.jsx';
import { loadSettings, saveSettings } from './config/settingsStore.js';
import AnalyticsPanel from './components/AnalyticsPanel.jsx';
import ToastNotifier from './components/ToastNotifier.jsx';
import { useToasts, useNotificationPermission } from './hooks/useToasts.js';

/* ── API base URL — configurable for deployment (falls back to localhost) ── */
const API_BASE = (import.meta.env && import.meta.env.VITE_API_URL) || 'http://127.0.0.1:3001';

/* ── Format a price using the market's configured decimal precision ── */
const fmtPrice = (v, cfg) =>
  typeof v === 'number' ? v.toFixed(Number.isFinite(cfg?.dec) ? cfg.dec : 2) : v;

/* ═══════════════════════════════════════════
   Main Dashboard
   ═══════════════════════════════════════════ */
export default function TradingBot() {
  // ── State ──
  const [market, setMarket] = useState('BTC/USD');
  const [timeframe, setTimeframe] = useState(() => loadSettings().defaultTimeframe || '5m');
  const [running, setRunning] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [botSettingsOpen, setBotSettingsOpen] = useState(false);
  const [settings, setSettings] = useState(loadSettings);
  const [rightTab, setRightTab] = useState('trades'); // 'trades' | 'signals' | 'news' | 'calendar' | 'analytics'

  // Market data stores
  const [candleMap, setCandleMap] = useState({});
  const [smcMap, setSmcMap] = useState({});
  const [signals, setSignals] = useState([]);
  const [connectionStatus, setConnectionStatus] = useState({});
  const [accountInfo, setAccountInfo] = useState({ balance: 0, equity: 0, profit: 0 });
  const [trades, setTrades] = useState([]);
  const [bridgeOnline, setBridgeOnline] = useState(false);

  // Toasts & Notifications
  const { toasts, addToast, dismiss } = useToasts();
  useNotificationPermission();
  const prevSignalIdsRef = useRef(new Set());

  const candleMapRef = useRef(candleMap);
  useEffect(() => { candleMapRef.current = candleMap; }, [candleMap]);
  const smcMapRef = useRef(smcMap);
  useEffect(() => { smcMapRef.current = smcMap; }, [smcMap]);
  const smcSigRef = useRef({}); // market -> last candle signature SMC was computed for

  // ── Performance tracking — from CLOSED trades' REALIZED P&L only ──
  // (Open-trade reports carry the account's floating profit, not the trade's
  //  outcome, so counting them would make every stat meaningless.)
  const closedTrades = useMemo(
    () => trades.filter(t => t.status === 'CLOSED'),
    [trades]
  );
  const wins = useMemo(
    () => closedTrades.filter(t => (t.realizedPnl || 0) > 0).length,
    [closedTrades]
  );
  const losses = useMemo(
    () => closedTrades.filter(t => (t.realizedPnl || 0) < 0).length,
    [closedTrades]
  );
  const pnl = useMemo(
    () => closedTrades.reduce((a, t) => a + (t.realizedPnl || 0), 0),
    [closedTrades]
  );

  // ── Derived ──
  const marketConfig = getMarketConfig(market);
  const tfConfig = getTimeframe(timeframe);
  const curCandles = candleMap[market] || [];
  const curSMC = smcMap[market] || { obs: [], fvgs: [], structs: [], sweeps: [] };
  const lastCandle = curCandles[curCandles.length - 1];
  const prevCandle = curCandles[curCandles.length - 2];
  const priceChange = lastCandle && prevCandle
    ? ((lastCandle.close - prevCandle.close) / prevCandle.close * 100)
    : 0;
  // Denominator = all closed trades (incl. break-even) so this matches AnalyticsPanel.
  const totalTrades = closedTrades.length;
  const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : '0.0';
  const marketBias = getMarketBias(curSMC.structs);

  const allOBs = useMemo(() =>
    Object.values(smcMap).reduce((s, sm) => s + (sm?.obs?.length || 0), 0),
    [smcMap]
  );
  const allFVGs = useMemo(() =>
    Object.values(smcMap).reduce((s, sm) => s + (sm?.fvgs?.length || 0), 0),
    [smcMap]
  );

  // ── Load historical data on mount / market / timeframe change ──
  useEffect(() => {
    async function loadHistory() {
      const tf = getTimeframe(timeframe);
      const promises = Object.entries(MARKETS).map(async ([key, cfg]) => {
        try {
          let candles = [];

          if (cfg.source === DATA_SOURCE.BINANCE && cfg.binanceSymbol) {
            candles = await fetchBinanceKlines(
              cfg.binanceSymbol,
              tf.binance,
              200,
              !!cfg.futures
            );
          } else if (cfg.source === DATA_SOURCE.FINNHUB && settings.finnhubApiKey) {
            candles = await fetchFinnhubCandles(
              cfg.finnhubSymbol,
              tf.finnhub,
              200,
              settings.finnhubApiKey
            );
          } else if (cfg.source === DATA_SOURCE.YAHOO) {
            const res = await fetch(`${API_BASE}/api/candles`);
            if (res.ok) {
              const data = await res.json();
              candles = data[key] || [];
            }
          }

          if (candles.length > 0) {
            setCandleMap(prev => ({ ...prev, [key]: candles }));
            const smc = detectSMC(candles);
            setSmcMap(prev => ({ ...prev, [key]: smc }));
            setConnectionStatus(prev => ({ ...prev, [key]: 'connected' }));
          }
        } catch (err) {
          console.error(`[History] Failed for ${key}:`, err);
          setConnectionStatus(prev => ({ ...prev, [key]: 'error' }));
        }
      });

      await Promise.allSettled(promises);
    }

    loadHistory();
  }, [timeframe, settings.finnhubApiKey]);

  // ── Binance WebSocket callback ──
  const handleBinanceKline = useCallback((marketKey) => (candle) => {
    if (!running) return;

    setCandleMap(prev => {
      const arr = [...(prev[marketKey] || [])];
      if (arr.length === 0) return prev;

      const lastIdx = arr.length - 1;

      if (candle.isClosed) {
        // Finalize current candle and start new one
        arr[lastIdx] = { ...arr[lastIdx], ...candle };
        arr.push({
          time: candle.time + getTimeframe(timeframe).seconds,
          open: candle.close,
          high: candle.close,
          low: candle.close,
          close: candle.close,
          volume: 0,
        });

        // Keep max 250 candles
        if (arr.length > 250) arr.shift();
        // SMC recomputation happens in a dedicated effect when a candle closes.
      } else {
        // Update current candle
        const existing = arr[lastIdx];
        if (candle.time >= existing.time) {
          arr[lastIdx] = {
            ...existing,
            high: Math.max(existing.high, candle.high),
            low: Math.min(existing.low, candle.low),
            close: candle.close,
            volume: candle.volume,
          };
        }
      }

      return { ...prev, [marketKey]: arr };
    });
  }, [running, timeframe]);

  // ── Connect Binance streams for all crypto markets ──
  // We connect to the active market's Binance stream
  const activeBinance = marketConfig?.source === DATA_SOURCE.BINANCE ? marketConfig : null;
  useBinanceStream(
    activeBinance?.binanceWs,
    tfConfig.binance,
    handleBinanceKline(market),
    running && !!activeBinance,
    !!activeBinance?.futures
  );

  // Also stream BTC in background for header price
  useBinanceStream(
    market !== 'BTC/USD' ? 'btcusdt' : null,
    tfConfig.binance,
    handleBinanceKline('BTC/USD'),
    running && market !== 'BTC/USD'
  );

  // ── Finnhub WebSocket: live-tick overlay for any market declaring a finnhubSymbol ──
  const finnhubSymbols = useMemo(
    () => Object.values(MARKETS).filter(c => c.finnhubSymbol).map(c => c.finnhubSymbol),
    []
  );
  const finnhubToMarket = useMemo(() => {
    const m = {};
    Object.entries(MARKETS).forEach(([key, cfg]) => { if (cfg.finnhubSymbol) m[cfg.finnhubSymbol] = key; });
    return m;
  }, []);
  const handleFinnhubTrade = useCallback((trade) => {
    if (!running || !(trade.price > 0)) return;
    const key = finnhubToMarket[trade.symbol];
    if (!key) return;
    setCandleMap(prev => {
      const arr = prev[key];
      if (!arr || arr.length === 0) return prev;
      const last = arr[arr.length - 1];
      const updated = {
        ...last,
        close: trade.price,
        high: Math.max(last.high, trade.price),
        low: Math.min(last.low, trade.price),
      };
      return { ...prev, [key]: [...arr.slice(0, -1), updated] };
    });
  }, [running, finnhubToMarket]);

  useFinnhubStream(
    finnhubSymbols,
    handleFinnhubTrade,
    settings.finnhubApiKey,
    running && finnhubSymbols.length > 0 && !!settings.finnhubApiKey
  );

  // ── Recompute SMC when a candle actually closes ──
  // Keyed on each market's candle count + last-candle time so detectSMC only re-runs
  // when a new candle is finalized (not on every intra-candle price tick).
  const candleCloseKey = useMemo(
    () =>
      Object.entries(candleMap)
        .map(([key, arr]) => `${key}:${arr.length}:${arr[arr.length - 1]?.time ?? 0}`)
        .join('|'),
    [candleMap]
  );
  useEffect(() => {
    setSmcMap(prev => {
      const next = { ...prev };
      let changed = false;
      Object.entries(candleMapRef.current).forEach(([key, arr]) => {
        if (!arr || arr.length === 0) return;
        // Only recompute the market whose candle actually changed — recomputing all
        // markets on every close and returning a fresh object churns every chart.
        const sig = `${arr.length}:${arr[arr.length - 1]?.time ?? 0}`;
        if (smcSigRef.current[key] === sig && next[key]) return;
        smcSigRef.current[key] = sig;
        next[key] = detectSMC(arr);
        changed = true;
      });
      return changed ? next : prev;
    });
  }, [candleCloseKey]);

  // ── Rebuild signals periodically + fire toasts on new signals ──
  const notificationsEnabled = settings.notifications;
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      const sigs = buildSignals(candleMapRef.current, smcMapRef.current, MARKETS);
      setSignals(sigs);

      // Determine brand-new signals against the previous batch (ids are stable per setup)
      const prevIds = prevSignalIdsRef.current;
      const newSigs = sigs.filter(sig => !prevIds.has(sig.id));

      // Fire toast for brand-new signals (only when notifications are enabled)
      if (notificationsEnabled) {
        newSigs.forEach(sig => {
          addToast({
            type: sig.type === 'BUY' ? 'buy' : 'sell',
            title: `${sig.type} Signal — ${sig.market || sig.symbol}`,
            message: `${sig.reason} | ${(sig.conf !== undefined ? sig.conf : sig.confidence)}% confidence`,
            signal: sig,
          });
        });
      }

      // Prune ref to only ids present in the current batch (prevents unbounded growth)
      prevSignalIdsRef.current = new Set(sigs.map(s => s.id));
    }, 5000);
    return () => clearInterval(id);
  }, [running, addToast, notificationsEnabled]);

  // Poll Account Info + Trade History
  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    async function fetchAccount() {
      try {
        const res = await fetch(`${API_BASE}/api/trades`);
        if (!res.ok) throw new Error('API offline');
        const data = await res.json();
        if (cancelled) return;
        setAccountInfo(data.account || { balance: 0, equity: 0, profit: 0 });
        setTrades(data.trades || []);
        setBridgeOnline(true);
      } catch (err) {
        console.error('Account poll error:', err);
        if (!cancelled) setBridgeOnline(false);
      }
    }
    fetchAccount();
    const interval = setInterval(fetchAccount, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [running]);

  // Poll Yahoo candles from Node API
  useEffect(() => {
    if (!running) return;
    const yahooMarkets = Object.entries(MARKETS).filter(([, cfg]) => cfg.source === DATA_SOURCE.YAHOO);
    if (yahooMarkets.length === 0) return;

    const id = setInterval(async () => {
      try {
        const res = await fetch(`${API_BASE}/api/candles`);
        if (res.ok) {
          const data = await res.json();
          yahooMarkets.forEach(([key]) => {
            const candles = data[key];
            if (candles && candles.length > 0) {
              setCandleMap(prev => ({ ...prev, [key]: candles }));
              const smc = detectSMC(candles);
              setSmcMap(prev => ({ ...prev, [key]: smc }));
              setConnectionStatus(prev => ({ ...prev, [key]: 'connected' }));
            } else {
              setConnectionStatus(prev => ({ ...prev, [key]: 'error' }));
            }
          });
        }
      } catch (err) {
        console.error('[Yahoo Poll] Failed:', err);
      }
    }, 5000);
    return () => clearInterval(id);
  }, [running]);

  // ── News & Calendar ──
  const { news, loading: newsLoading, error: newsError } = useMarketNews(
    settings.finnhubApiKey,
    'general',
    60000,
    !!settings.finnhubApiKey
  );
  const { events: calendarEvents, loading: calLoading } = useEconomicCalendar(
    settings.finnhubApiKey,
    !!settings.finnhubApiKey
  );

  // ── Handle settings save ──
  const handleSettingsSave = useCallback((newSettings) => {
    setSettings(newSettings);
    saveSettings(newSettings);
  }, []);

  /* ═══════════════════════════════════════════
     RENDER
     ═══════════════════════════════════════════ */
  return (
    <div className="dashboard">
      {/* ── Header ── */}
      <header className="dash-header">
        <div className="dash-header-left">
          <div className="dash-brand">
            <div className="dash-brand-name">
              NEXUS<span className="accent">·SMC</span>
            </div>
            <div className="dash-brand-sub">Smart Money Concept Engine v3.0</div>
          </div>
          <div className="dash-status">
            <span className={`status-dot ${running ? 'live' : 'paused'}`} />
            <span className={`status-text ${running ? 'live' : 'paused'}`}>
              {running ? 'LIVE' : 'PAUSED'}
            </span>
          </div>
          <div className="dash-bias" data-bias={marketBias}>
            {marketBias === 'bullish' ? '▲' : marketBias === 'bearish' ? '▼' : '◆'}{' '}
            {marketBias.toUpperCase()}
          </div>
        </div>

        <div className="dash-header-right">
          <AutoTradeToggle />
          <div className="dash-pnl">
            <div className="dash-pnl-label">BOT OPEN P&L</div>
            <div className={`dash-pnl-value ${accountInfo.profit >= 0 ? 'up' : 'down'}`}>
              {accountInfo.profit >= 0 ? '+' : ''}R {accountInfo.profit.toFixed(2)}
            </div>
          </div>
          <button
            className={`dash-toggle-btn ${running ? 'stop' : 'start'}`}
            onClick={() => setRunning(r => !r)}
          >
            {running ? '■ Stop' : '▶ Start'}
          </button>
          <button
            className="dash-settings-btn"
            onClick={() => setBotSettingsOpen(true)}
            title="Bot Settings — exchange, risk, live trading"
          >
            🤖
          </button>
          <button
            className="dash-settings-btn"
            onClick={() => setSettingsOpen(true)}
            title="Dashboard Settings"
          >
            ⚙
          </button>
        </div>
      </header>

      {/* ── Stats Bar ── */}
      <div className="stats-bar">
        {[
          { label: 'Win Rate', val: winRate + '%', col: COLORS.bull },
          { label: 'Total Trades', val: totalTrades, col: 'var(--color-text-primary)' },
          { label: 'Active Signals', val: signals.filter(s => s.status === 'ACTIVE').length, col: COLORS.fvg },
          { label: 'Order Blocks', val: allOBs, col: COLORS.bull },
          { label: 'Fair Value Gaps', val: allFVGs, col: COLORS.fvg },
        ].map((s, i) => (
          <div key={i} className="stat-cell">
            <div className="stat-label">{s.label}</div>
            <div className="stat-value" style={{ color: s.col }}>{s.val}</div>
          </div>
        ))}
      </div>

      {/* ── Market Tabs ── */}
      <div className="market-tabs">
        {Object.entries(MARKETS).map(([key, cfg]) => {
          const arr = candleMap[key] || [];
          const l = arr[arr.length - 1];
          const p = arr[arr.length - 2];
          const chg = l && p ? ((l.close - p.close) / p.close * 100) : 0;
          const status = connectionStatus[key];

          return (
            <button
              key={key}
              className={`mkt-tab ${key === market ? 'active' : ''}`}
              onClick={() => setMarket(key)}
            >
              <div className="mkt-tab-name">
                <span className={`mkt-dot ${status === 'connected' ? 'on' : status === 'error' ? 'err' : ''}`} />
                {key}
              </div>
              {l && (
                <div className={`mkt-tab-price ${chg >= 0 ? 'up' : 'down'}`}>
                  {fmtPrice(l.close, cfg)}{' '}
                  <span className="mkt-tab-chg">
                    {chg >= 0 ? '+' : ''}{chg.toFixed(2)}%
                  </span>
                </div>
              )}
            </button>
          );
        })}
      </div>

      {/* ── Main Content ── */}
      <div className="main-area">
        {/* Chart Column */}
        <div className="chart-column">
          {/* Chart Header */}
          <div className="chart-header">
            <div className="chart-header-left">
              <span className="chart-symbol">{market}</span>
              {lastCandle && (
                <>
                  <span className={`chart-price ${priceChange >= 0 ? 'up' : 'down'}`}>
                    {fmtPrice(lastCandle.close, marketConfig)}
                  </span>
                  <span className={`chart-change ${priceChange >= 0 ? 'up' : 'down'}`}>
                    {priceChange >= 0 ? '+' : ''}{priceChange.toFixed(3)}%
                  </span>
                </>
              )}
              {/* Timeframe selector */}
              <div className="tf-selector">
                {TIMEFRAMES.map(tf => (
                  <button
                    key={tf.value}
                    className={`tf-btn ${timeframe === tf.value ? 'active' : ''}`}
                    onClick={() => setTimeframe(tf.value)}
                  >
                    {tf.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="chart-legend">
              {[
                [COLORS.bull, 'Bull OB'],
                [COLORS.bear, 'Bear OB'],
                [COLORS.fvg, 'FVG'],
                [COLORS.bos, 'BOS'],
                [COLORS.choch, 'CHoCH'],
              ].map(([col, lbl]) => (
                <span key={lbl} className="legend-item">
                  <span className="legend-swatch" style={{ background: col }} />
                  {lbl}
                </span>
              ))}
            </div>
          </div>

          {/* Chart */}
          <div className="chart-area">
            {curCandles.length > 0 ? (
              <TVChart
                key={market}
                candles={curCandles}
                smc={curSMC}
                market={market}
                marketConfig={marketConfig}
                signals={signals}
              />
            ) : (
              <div className="chart-loading">
                <div className="news-loading-spinner" />
                <div>Loading {market} data...</div>
              </div>
            )}
          </div>

          {/* SMC Summary Strip */}
          <div className="smc-strip">
            {[
              { label: 'Order Blocks', val: curSMC.obs?.length || 0, col: COLORS.bull },
              { label: 'Fair Value Gaps', val: curSMC.fvgs?.length || 0, col: COLORS.fvg },
              { label: 'Structures', val: curSMC.structs?.length || 0, col: COLORS.struct },
              { label: 'Sweeps', val: curSMC.sweeps?.length || 0, col: '#FFD700' },
            ].map((item, i) => (
              <div key={i} className="smc-strip-cell">
                <span className="smc-strip-label">{item.label}</span>
                <span className="smc-strip-value" style={{ color: item.col }}>
                  {item.val}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Right Panel */}
        <div className="right-panel">
          {/* Tab headers */}
          <div className="right-tabs">
            {[
              { key: 'trades',    label: '💰 Trades',    count: 0 },
              { key: 'analytics', label: '📊 Analytics',  count: 0 },
              { key: 'signals',   label: '📡 Signals',    count: signals.length },
              { key: 'news',      label: 'News',          count: news.length },
              { key: 'calendar',  label: 'Calendar',      count: calendarEvents.length },
            ].map(tab => (
              <button
                key={tab.key}
                className={`right-tab ${rightTab === tab.key ? 'active' : ''}`}
                onClick={() => setRightTab(tab.key)}
              >
                {tab.label}
                {tab.count > 0 && (
                  <span className="right-tab-count">{tab.count}</span>
                )}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="right-content">
            {rightTab === 'trades' && (
              <TradesPanel trades={trades} account={accountInfo} connected={bridgeOnline} />
            )}

            {rightTab === 'analytics' && (
              <AnalyticsPanel trades={trades} account={accountInfo} />
            )}

            {rightTab === 'signals' && (
              <>
                {signals.length === 0 ? (
                  <div className="panel-empty">
                    <div className="panel-empty-icon">📡</div>
                    <div>Scanning for SMC setups…</div>
                    <div className="panel-empty-sub">
                      Signals appear when patterns form near current price
                    </div>
                  </div>
                ) : (
                  signals.map(sig => <SignalCard key={sig.id} sig={sig} />)
                )}
              </>
            )}

            {rightTab === 'news' && (
              <NewsPanel news={news} loading={newsLoading} error={newsError} />
            )}

            {rightTab === 'calendar' && (
              <EconomicCalendar events={calendarEvents} loading={calLoading} />
            )}
          </div>

          {/* Bot Stats Footer */}
          <div className="bot-stats">
            <div className="bot-stats-title">BOT STATS</div>
            {[
              ['Wins', wins, COLORS.bull],
              ['Losses', losses, COLORS.bear],
              ['Win Rate', winRate + '%', COLORS.bull],
              ['Net P&L', `${pnl >= 0 ? '+' : ''}R ${pnl.toFixed(2)}`, pnl >= 0 ? COLORS.bull : COLORS.bear],
            ].map(([lbl, val, col]) => (
              <div key={lbl} className="bot-stat-row">
                <span>{lbl}</span>
                <span style={{ color: col, fontWeight: 500 }}>{val}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Settings Modal — mounted only while open so its draft initializes cleanly */}
      {settingsOpen && (
        <SettingsPanel
          onClose={() => setSettingsOpen(false)}
          settings={settings}
          onSave={handleSettingsSave}
        />
      )}

      {/* Bot Settings (exchange / risk / live trading) */}
      {botSettingsOpen && <BotSettings onClose={() => setBotSettingsOpen(false)} />}

      {/* Toast Notifications */}
      <ToastNotifier toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
