# Changelog

All notable changes to NEXUS·SMC are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); this project uses date-based releases.

## [1.0.0] — 2026-06-11

First production-hardened release: every known correctness bug fixed, a universal
Docker-deployable executor replacing the MetaTrader-only execution path, validated trading
math, and full deployment scaffolding.

### Added
- **Dashboard login + first-time setup**: a setup wizard creates the admin account (and optional
  initial exchange config) on first run; subsequent visits require username/password. Passwords are
  scrypt-hashed, sessions are HMAC-signed tokens, with login brute-force throttling.
- **GUI exchange & bot configuration** (🤖 Bot Settings): set the broker (paper/live), exchange,
  market type, API key/secret, risk parameters, dynamic-risk and confluence filters from the web UI.
  Exchange secrets are **encrypted at rest** (AES-256-GCM) and never returned to the browser; the
  executor pulls its live config from the server and risk/filter changes apply without a restart.
- **Smart dynamic risk**: position size scales up with signal confidence and scales down after
  consecutive losses or inside an equity drawdown (high-water-mark tracked), all toggleable.
- **Live Finnhub WebSocket** wired into the dashboard: real-time tick overlay for any market that
  declares a `finnhubSymbol` (on top of its candle-history source) when a Finnhub key is set.
- **Universal CCXT executor** (`executor/`) — a FOSS, Docker-deployable service that replaces
  the MT4/MT5 EAs with pure Node (no compiler, no MetaTrader). Pluggable broker adapter:
  - `paper` broker (default) — simulated fills on live prices, zero keys, zero risk.
  - `ccxt` broker — real execution on 100+ exchanges; exchange sandbox by default, real
    orders behind an explicit `EXECUTOR_LIVE=true` + keys.
  - Ports every EA rule: entry gates, risk-% sizing (hard $ cap, notional cap,
    refuse-if-min-exceeds-cap), portfolio risk cap, daily-loss kill switch, whole-trade
    consecutive-loss halt, equity/free-margin guards, break-even / trailing / partial close,
    the server claim/lease anti-duplicate flow, and idempotent realized-P&L reporting.
- **Backtester** (`backtest/run.js`) — replays the strategy bar-by-bar over historical
  Binance klines with the same management logic, modelling maker/taker fees + slippage, and
  reports win rate, expectancy (money + R), profit factor, Sharpe/Sortino, max drawdown, and
  **gross vs net** return. Writes a full report + equity curve to `backtest/last-run.json`.
- **Shared statistics engine** (`src/engine/stats.js`) — win rate, expectancy, profit factor,
  payoff, Sharpe, Sortino, max drawdown (money + %), R-multiple distribution, equity curve,
  consecutive-streak counts. Used by the dashboard, backtester, and the new `/api/stats`.
- **Higher-timeframe trend filter** in the SMC engine (`computeEMA`, `computeTrend`): EMA-50
  vs EMA-200 bias that rewards with-trend setups and penalises counter-trend ones; surfaced
  as a `HTF Bull/Bear` confluence tag, a `hasTrend` flag, and `htfBias` on each signal.
- **Docker deployment**: `Dockerfile` (API + built dashboard), `Dockerfile.executor`,
  `docker-compose.yml` (one-command full stack with healthcheck + persistent state volume),
  `.dockerignore`. `npm run docker:up`.
- **Error boundary** for the dashboard so a single component fault can't white-screen the app.
- `/api/stats` endpoint; `compression` + static `dist/` serving on the API server.
- Prod scaffolding: real `README.md`, `CHANGELOG.md`, `.env.example` (server + executor +
  exchange), `engines.node >=20.12`, npm scripts (`executor`, `backtest`, `docker:*`).

### Changed
- **Realized P&L analytics**: the dashboard's win rate / equity curve / profit factor are now
  computed from **closed trades' realized P&L** (reported when a trade closes), not the
  account's floating profit captured at trade-open — the old basis made every stat meaningless.
- EA execution layer repositioned as a **legacy alternative**; the Node executor is primary.
- Trade reporting contract extended with a `close` event carrying realized per-deal P&L, a
  unique `dealId`, and `profitAcct` (account floating P&L kept separate from realized P&L).
- Signal scoring now folds in the trend filter; `AnalyticsPanel` shows expectancy/Sharpe/Sortino.
- Server state files (`trades_log.json`, `executed_signals.json`) honor `DATA_DIR` for volumes.

### Fixed
*Round 1 — core correctness*
- **Duplicate trades** (observed in `trades_log.json`: one signal on two tickets seconds apart):
  EAs now **defer** when the server claim gate is unreachable instead of trading on local-only
  dedup; the server no longer marks *unknown* signal IDs as executed (closing a dedup-poisoning
  hole that contradicted its own comment); executed IDs persist immediately on the trade path.
- **Realized-P&L close reporting** added to both EAs (MT5 `OnTradeTransaction`, MT4 history scan).
- React: TVChart `createSeriesMarkers` leak (now create-once + `setMarkers`); signal-rebuild
  churn (ref-based, fewer re-renders); bounded news `seenIds`; corrupt-candle sanitization in
  the SMC engine; conditional Settings-panel mount; WebSocket reconnect self-reference.
- MT4 consecutive-loss tracker now counts in true close-time order.
- Toolchain: restored `node_modules/.bin` exec bits (build/lint were silently using a stale
  global toolchain); ESLint flat-config split for Node vs browser; lint now passes (0 errors).

*Round 2 — regressions caught by adversarial review of Round 1*
- **Close reports are now idempotent**: a lost HTTP response + EA/executor retry no longer
  doubles realized P&L (each close carries a unique `dealId`; the server counts it once).
- MT5 full-vs-partial close detection no longer relies on the racy live-position pool — it is
  derived from realized volume in deal history; the consecutive-loss kill switch fires only on
  **whole-trade** closure using net P&L (not on individual partial fills).
- MT4 partial closes are no longer mislabeled as full closes or double-reported (remainder
  detected via the shared signal id; reconciled by the server's `dealId` + signal-id fallback).
- MT4 loss-streak counting is broker-history-order independent.
- Dashboard win-rate denominator now matches the Analytics panel (break-even trades included).
- SMC recompute no longer churns every chart on each candle close (per-market signature guard).
- EAs raise a rate-limited alert on a persistent claim **auth** failure (401/403) instead of
  silently halting all trading.

### Security
- State-changing endpoints (`/api/claim`, `/api/trades`, `/api/heartbeat`) gated by an optional
  `NEXUS_API_TOKEN`; server binds loopback by default; CORS restricted to localhost origins;
  bounded request body; atomic state writes. Live-trading is opt-in and paper is the default.
