# Aque Bot

Real-time **Smart Money Concepts** (SMC) signal engine with a live React dashboard, a
Node/Express signal API, a **universal CCXT trade executor** (Docker-deployable), a
**backtester**, and MetaTrader 4/5 Expert Advisors (legacy alternative).

```
 Market data (Binance WS/REST, Yahoo via API)
        │
        ▼
 ┌──────────────┐  signals (JSON)   ┌─────────────────────┐
 │  smcEngine   │ ────────────────▶ │  server.js (API)    │ ◀── trade/close reports
 │ (shared core)│   + trend filter  │  dedup + claim gate │
 └──────────────┘                   └─────────┬───────────┘
        │ same engine                         │ /api/signals, /api/claim
        ▼                  ┌──────────────────┼───────────────────┐
 ┌──────────────┐          ▼                  ▼                   ▼
 │  Dashboard   │   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
 │ React + stats│   │  Executor    │   │  Backtester  │   │ MT4/MT5 EA   │
 └──────────────┘   │ CCXT (paper/ │   │ (validate    │   │ (legacy)     │
                    │  live crypto)│   │  the edge)   │   │              │
                    └──────────────┘   └──────────────┘   └──────────────┘
```

The SMC detection, the higher-timeframe **trend filter**, and signal construction live in
**one** module (`src/engine/smcEngine.js`) shared by the dashboard, server, executor and
backtester — so what you chart, trade, and backtest all come from identical logic.

---

## Quick start — Docker (one command)

```bash
cp .env.example .env          # optional; sensible defaults work out of the box
docker compose up --build
```

- Dashboard + API → **http://localhost:3001**
- On first visit you'll create an **admin login** (first-time setup wizard); after that, sign in
  with your username/password.
- The executor starts in **paper mode** (simulated fills on live prices — no keys, no risk).

### Configure everything from the web UI

Click **⚙ Settings** in the dashboard header for a single, tabbed control panel — fully editable
**any time after first-time setup** (swap broker/exchange or paper↔live whenever you like):

- **Trading** — broker (paper / live exchange), exchange, market type, API key/secret, LIVE toggle
  (with a confirm step), symbol map, auto-trading on/off.
- **Risk** — sizing, kill-switches/caps, smart dynamic risk, confluence filters.
- **Data** — Finnhub API key, default timeframe, browser notifications.
- **Account** — change password, sign out.

Exchange secrets are encrypted at rest and never sent back to the browser. Risk/filter changes apply
live; broker/exchange/key changes take effect when the executor restarts. (Env vars in `.env` still
work as defaults / for headless setups.) A header **AUTO-TRADE** switch + **PAPER/TESTNET/LIVE** badge
make the bot's state obvious at a glance.

## Quick start — local (Node ≥ 20.12)

```bash
npm install
npm run api        # API + (if built) dashboard on http://127.0.0.1:3001
npm run dev        # Vite dashboard on http://localhost:5173 (dev)
npm run executor   # universal executor (paper by default)
```

## The universal executor (replaces MetaTrader)

`executor/` is a FOSS, Docker-deployable service that does what the EAs did — but in pure
Node via **CCXT** (MIT, 100+ exchanges), so there's nothing to compile. It polls
`/api/signals`, enforces the full ported risk model, executes, manages trades, and reports
realized P&L back to the dashboard.

It preserves every EA guard: confidence floor, symbol allow-list/mapping, price-divergence
and spread filters, entry proximity/anti-chase gates, SMC confluence requirements, the
**server claim/lease anti-duplicate flow**, risk-% sizing with a hard cap + notional cap +
refuse-if-min-exceeds-cap, **portfolio risk cap**, **daily-loss kill switch**, **max
consecutive losses** (whole-trade), equity/free-margin guards, and break-even / trailing /
partial-close management — all configurable via env (see `.env.example`).

### Going live (real crypto)

> ⚠ **Live trading spends real money.** Test on the exchange sandbox first.

In `.env`:

```bash
EXECUTOR_BROKER=ccxt
EXCHANGE_ID=binance         # any CCXT exchange
EXCHANGE_TYPE=swap          # 'spot' = long-only; 'swap'/'future' to short SELL signals
EXCHANGE_API_KEY=...        # your key
EXCHANGE_API_SECRET=...
EXECUTOR_LIVE=false         # ← keep false until you've tested on the sandbox, then set true
```

`EXECUTOR_LIVE=false` runs the exchange **testnet**; `true` sends real orders. Crypto pairs
(BTC, EUR/USDT) trade; Nasdaq stays data-only (no crypto equivalent). The kill-switches and
risk caps are active by default — review them before going live.

## Backtester — validate the edge

```bash
npm run backtest -- --symbol BTCUSDT --tf 5m --bars 1500
node backtest/run.js --symbol ETHUSDT --tf 15m --bars 3000 --risk 1 --requireTrend true
```

Replays the strategy bar-by-bar with the **same** detection and SL/TP/BE/trail/partial
management as the executor, then prints win rate, expectancy (money + R), profit factor,
Sharpe/Sortino, max drawdown, and **gross vs net** return (so you can see how sensitive the
edge is to fees). Full report + equity curve are written to `backtest/last-run.json`.

> Note: tight SMC stops make position notional ≫ risk, so fees matter a lot — prefer maker
> (limit) entries and a low fee tier. Backtests are an edge estimate, **not a guarantee.**

## Configuration

Everything is env-driven (`.env`; see `.env.example`). Highlights:

| Variable          | Used by   | Default               | Purpose |
|-------------------|-----------|-----------------------|---------|
| `VITE_API_URL`    | dashboard | `http://127.0.0.1:3001` | API endpoint the dashboard calls |
| `PORT` / `BIND_HOST` | server | `3001` / `127.0.0.1`  | Listen address (compose uses `0.0.0.0`) |
| `NEXUS_API_TOKEN` | server + clients | _(empty)_      | Shared secret for state-changing endpoints |
| `MIN_CONFIDENCE`  | server/exec | `60` / `80`         | Confidence floors |
| `EXECUTOR_BROKER` | executor  | `paper`               | `paper` or `ccxt` |
| `EXECUTOR_LIVE`   | executor  | `false`               | ccxt: real orders vs sandbox |
| `RISK_PERCENT` / `MAX_RISK_DOLLARS` | executor | `1` / `20` | Per-trade risk |

## Dashboard analytics

Win-rate, P&L, equity curve, profit factor, **expectancy (R)**, **Sharpe/Sortino**, and max
drawdown are computed by the shared `src/engine/stats.js` from **realized** P&L when trades
**close** — so the numbers reflect real outcomes, not floating account profit.

## MetaTrader EAs (legacy alternative)

`mt5/NEXUS_SMC_EA.mq5` and `mt4/NEXUS_SMC_EA.mq4` remain as an alternative executor for
broker/forex/index trading. They speak the same API. They must be **compiled in MetaEditor
(F7)** and require a running MetaTrader terminal — the Node executor is the supported,
compiler-free, container-native path. See the safety notes in each `.mq*` header.

## Project layout

```
server.js                 API: data, signals, dedup/claim, trade log, /api/stats, serves dist/
src/engine/smcEngine.js   SHARED SMC detection + trend filter + signal construction
src/engine/stats.js       SHARED performance statistics
src/TradingBot.jsx        Dashboard;  src/components, src/hooks, src/config
executor/                 Universal CCXT executor (config, brokers, risk, manage, report, state)
backtest/run.js           Bar-by-bar backtester
mt5/ , mt4/               MetaTrader Expert Advisors (legacy)
Dockerfile* docker-compose.yml   One-command full-stack deploy
```
