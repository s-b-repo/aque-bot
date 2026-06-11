/* ═══════════════════════════════════════════════════════
   NEXUS·SMC Signal API Server
   ─────────────────────────────────────────────────────
   Standalone Express server that fetches market data,
   runs SMC analysis (shared engine — src/engine/smcEngine.js),
   and exposes signals as JSON for MetaTrader EA consumption.

   Run:  node server.js
   URL:  http://127.0.0.1:3001/api/signals

   Safety/auditing: signals carry STABLE time-anchored ids;
   the server is the AUTHORITATIVE dedup via a durable
   executed-set + an atomic claim/lease that closes the
   open-vs-report race (audit SRV-01/02, XSYS-01/02/10).
   ═══════════════════════════════════════════════════════ */

import express from 'express';
import cors from 'cors';
import compression from 'compression';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { detectSMC, buildSignalsForMarket } from './src/engine/smcEngine.js';
import { computeStats } from './src/engine/stats.js';
import * as auth from './serverlib/auth.js';
import { initConfig, saveConfig, publicConfig, executorConfig } from './serverlib/configStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// DATA_DIR lets the runtime state live on a mounted volume (Docker) instead of
// alongside the code. Defaults to the app directory for local runs.
const DATA_DIR = process.env.DATA_DIR || __dirname;
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* exists */ }
const LOG_FILE = path.join(DATA_DIR, 'trades_log.json');
const EXEC_FILE = path.join(DATA_DIR, 'executed_signals.json');
auth.initAuth(DATA_DIR);
initConfig(DATA_DIR);

/* ── Configuration ── */
const PORT = Number(process.env.PORT) || 3001;
const BIND = process.env.BIND_HOST || '127.0.0.1';           // loopback by default (audit SRV-07)
const API_TOKEN = process.env.NEXUS_API_TOKEN || '';          // optional shared secret for POSTs
const SERVER_MIN_CONF = Number(process.env.MIN_CONFIDENCE) || 60; // server-side floor (audit XSYS-07)
const REFRESH_BASE_MS = 5000;                                 // scheduler tick
const CLAIM_TTL_MS = 90_000;                                  // a claimed-but-unconfirmed signal is hidden this long
const EXEC_MAX_AGE_MS = 7 * 24 * 3600 * 1000;                 // prune executed ids after 7 days
const MAX_BODY_BYTES = 64 * 1024;

const app = express();
app.set('trust proxy', false);   // req.ip = real socket peer (no X-Forwarded-For spoofing)
app.use(compression());

/* ── CORS: restrict to localhost origins; allow non-browser clients (EA/curl) ── */
const ALLOWED_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);          // EA, curl, server-to-server
    if (ALLOWED_ORIGIN.test(origin)) return cb(null, true);
    return cb(new Error('CORS: origin not allowed'));
  },
}));

/* ── Log selected incoming requests ── */
app.use((req, res, next) => {
  if (req.url.includes('/api/heartbeat') || req.url.includes('/api/trades') || req.url.includes('/api/claim')) {
    console.log(`[HTTP] ${req.method} ${req.url}`);
  }
  next();
});

/* ── Bounded raw JSON body parser (strips MT NUL bytes, caps size) — audit SRV-06 ── */
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') { req.body = {}; return next(); }
  let data = '';
  let size = 0;
  let aborted = false;
  req.on('data', chunk => {
    if (aborted) return;
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      aborted = true;
      res.status(413).json({ error: 'payload too large' });
      req.destroy();
      return;
    }
    data += chunk.toString('utf8');
  });
  req.on('end', () => {
    if (aborted) return;
    req.rawBody = data;
    const cleaned = data.replace(/\0/g, '').trim();
    if (!cleaned) { req.body = {}; return next(); }
    try {
      req.body = JSON.parse(cleaned);
      next();
    } catch (err) {
      console.error('[BODY] Invalid JSON:', err.message, '| raw:', JSON.stringify(data).slice(0, 200));
      res.status(400).json({ error: 'invalid json body', details: err.message });
    }
  });
  req.on('error', () => { if (!aborted) { try { res.status(400).end(); } catch { /* noop */ } } });
});

/* ── Auth gate for state-mutating endpoints (no-op unless NEXUS_API_TOKEN set) ── */
function requireAuth(req, res, next) {
  if (!API_TOKEN) return next();
  if (req.headers['x-api-key'] === API_TOKEN) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

/* ── Machine gate for endpoints that return DECRYPTED secrets. Unlike requireAuth
   this NEVER falls open on a network interface: with no token it serves loopback
   only; off-box callers must present NEXUS_API_TOKEN. (audit SEC-01) ── */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);
function requireExecutorAuth(req, res, next) {
  if (API_TOKEN) {
    if (req.headers['x-api-key'] === API_TOKEN) return next();
    return res.status(401).json({ error: 'unauthorized' });
  }
  const ip = (req.ip || (req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
  if (LOOPBACK.has(ip) || ip === '127.0.0.1') return next();
  return res.status(401).json({ error: 'set NEXUS_API_TOKEN for non-loopback executor access' });
}

/* ── Dashboard user session gate (login required) ── */
function requireSession(req, res, next) {
  const token = req.headers['x-session-token'] ||
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (auth.verifySession(token)) return next();
  return res.status(401).json({ error: 'login required' });
}

/* ── Brute-force throttle for /api/login (per-IP AND per-account, pruned+capped) ── */
const FAIL_WINDOW_MS = 5 * 60_000;
const loginFails = new Map(); // key -> { count, until }
const fkey = (ip, user) => `${ip}|${String(user || '').slice(0, 64)}`;
function pruneLoginFails() {
  const now = Date.now();
  for (const [k, v] of loginFails) if (v.until <= now) loginFails.delete(k);
  if (loginFails.size > 5000) {                          // memory-exhaustion backstop
    let drop = loginFails.size - 5000;
    for (const k of loginFails.keys()) { if (drop-- <= 0) break; loginFails.delete(k); }
  }
}
function loginThrottled(ip, user) {
  pruneLoginFails();
  const now = Date.now();
  const byIp = loginFails.get(fkey(ip, '*'));
  const byUser = loginFails.get(fkey('*', user));
  return (byIp && byIp.until > now && byIp.count >= 10) ||   // 10/IP
         (byUser && byUser.until > now && byUser.count >= 5); // 5/account
}
function noteLoginFail(ip, user) {
  for (const k of [fkey(ip, '*'), fkey('*', user)]) {
    const f = loginFails.get(k) || { count: 0, until: 0 };
    f.count += 1; f.until = Date.now() + FAIL_WINDOW_MS;
    loginFails.set(k, f);
  }
}
function clearLoginFails(ip, user) { loginFails.delete(fkey(ip, '*')); loginFails.delete(fkey('*', user)); }

/* ── Market Config ── (pipSize required by the SL/TP engine) */
const MARKETS = {
  'BTCUSD':  { binance: 'BTCUSDT', dec: 0, pipSize: 1,      category: 'crypto', futures: false, minIntervalMs: 6000 },
  // Binance EUR/USDT spot pair (~1.16) — NOT a broker EURUSD forex feed.
  // The EA must map this to a broker symbol whose live price matches, and
  // rejects the trade on price divergence (audit SRV-02).
  'EURUSDT': { binance: 'EURUSDT', dec: 5, pipSize: 0.0001, category: 'crypto', futures: false, minIntervalMs: 6000 },
  'Nasdaq':  { yahoo: '^NDX',      dec: 2, pipSize: 0.01,   category: 'index',  futures: false, minIntervalMs: 30000 },
};

/* ── Data + signal stores ── */
let candleStore = {};                 // symbol -> candles[]
let symbolSignals = {};               // symbol -> signals[] (last good)
let signalStore = [];                 // merged, sorted
let lastUpdate = 0;
const sourceState = {};               // symbol -> { nextAt, fails, lastOk }
const issuedIds = new Map();          // id -> firstSeenMs (bounded)

/* ── Durable dedup state ── */
let executedIds = new Map();          // id -> executedAt (persisted)
const claims = new Map();             // id -> claimedAt (ephemeral lease)

/* ── Data fetching ── */
async function fetchBinanceKlines(symbol, interval = '5m', limit = 200, futures = false) {
  const base = futures
    ? 'https://fapi.binance.com/fapi/v1/klines'
    : 'https://api.binance.com/api/v3/klines';
  const url = `${base}?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (res.status === 429 || res.status === 418) {
      const retry = Number(res.headers.get('retry-after')) || 0;
      const e = new Error(`Binance rate-limited (${res.status})`);
      e.retryAfterMs = retry * 1000;
      throw e;
    }
    if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error('Binance: unexpected payload');
    return data.map(k => ({
      time: Math.floor(k[0] / 1000),
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchYahooCandles(symbol, interval = '5m') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${interval}&range=5d`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: controller.signal });
    if (res.status === 429) {
      const retry = Number(res.headers.get('retry-after')) || 0;
      const e = new Error('Yahoo rate-limited (429)');
      e.retryAfterMs = retry * 1000;
      throw e;
    }
    if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
    const data = await res.json();
    const result = data.chart?.result?.[0];
    if (!result) throw new Error('Yahoo: invalid response');
    const timestamps = result.timestamp || [];
    const quote = result.indicators?.quote?.[0] || {};
    const candles = [];
    for (let i = 0; i < timestamps.length; i++) {
      if (quote.open?.[i] != null && quote.high?.[i] != null && quote.low?.[i] != null && quote.close?.[i] != null) {
        candles.push({
          time: timestamps[i],
          open: parseFloat(quote.open[i]),
          high: parseFloat(quote.high[i]),
          low: parseFloat(quote.low[i]),
          close: parseFloat(quote.close[i]),
          volume: parseFloat(quote.volume?.[i] || 0),
        });
      }
    }
    return candles.slice(-200);
  } finally {
    clearTimeout(timeout);
  }
}

/* ── Per-symbol refresh with backoff; retains last-good data on failure (audit SRV-08) ── */
async function refreshSymbol(symbol, cfg, nowMs) {
  const st = sourceState[symbol] || (sourceState[symbol] = { nextAt: 0, fails: 0, lastOk: 0 });
  if (nowMs < st.nextAt) return;
  const minInterval = cfg.minIntervalMs || 6000;
  try {
    let candles = [];
    if (cfg.binance) candles = await fetchBinanceKlines(cfg.binance, '5m', 200, !!cfg.futures);
    else if (cfg.yahoo) candles = await fetchYahooCandles(cfg.yahoo, '5m');

    if (!candles || candles.length === 0) throw new Error('empty candle set');

    candleStore[symbol] = candles;
    const smc = detectSMC(candles);
    const sigs = buildSignalsForMarket(candles, smc, { symbol, dec: cfg.dec, pipSize: cfg.pipSize })
      .filter(s => s.confidence >= SERVER_MIN_CONF);
    symbolSignals[symbol] = sigs;
    sigs.forEach(s => { if (!issuedIds.has(s.id)) issuedIds.set(s.id, nowMs); });
    st.fails = 0;
    st.lastOk = nowMs;
    st.nextAt = nowMs + minInterval;
  } catch (err) {
    st.fails += 1;
    const backoff = err.retryAfterMs || Math.min(minInterval * Math.pow(2, st.fails), 300000);
    st.nextAt = nowMs + backoff;
    // Keep prior candleStore[symbol] / symbolSignals[symbol] — do NOT wipe.
    console.error(`[API] ${symbol} fetch failed (#${st.fails}); retry in ${Math.round(backoff / 1000)}s:`, err.message);
  }
}

function rebuildSignalStore() {
  const merged = [];
  for (const s of Object.keys(MARKETS)) {
    if (symbolSignals[s]) merged.push(...symbolSignals[s]);
  }
  signalStore = merged.sort((a, b) => b.confidence - a.confidence);
}

let refreshing = false;
async function refreshTick() {
  if (refreshing) return;                       // prevent overlap (audit SRV-05)
  refreshing = true;
  try {
    const nowMs = Date.now();
    await Promise.allSettled(Object.entries(MARKETS).map(([s, c]) => refreshSymbol(s, c, nowMs)));
    rebuildSignalStore();
    pruneIssued();
    lastUpdate = Date.now();
    console.log(`[API] Refreshed: ${signalStore.length} signals across ${Object.keys(candleStore).length} markets`);
  } catch (err) {
    console.error('[API] refresh error:', err.message);
  } finally {
    refreshing = false;
  }
}
function scheduleRefresh() {
  setTimeout(async function tick() {
    await refreshTick();
    setTimeout(tick, REFRESH_BASE_MS);
  }, REFRESH_BASE_MS);
}

function pruneIssued() {
  if (issuedIds.size <= 2000) return;
  const cutoff = Date.now() - EXEC_MAX_AGE_MS;
  for (const [id, ts] of issuedIds) if (ts < cutoff) issuedIds.delete(id);
}

/* ── Durable dedup helpers ── */
function isExecuted(id) { return executedIds.has(id); }
function isClaimed(id) {
  const at = claims.get(id);
  if (at == null) return false;
  if (Date.now() - at > CLAIM_TTL_MS) { claims.delete(id); return false; }
  return true;
}
function markExecuted(id, { immediate = false } = {}) {
  if (!id) return;
  executedIds.set(id, Date.now());
  claims.delete(id);
  saveExecuted({ immediate });
}

/* ── Persistence (atomic) ── */
function atomicWrite(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

let execDirty = false;
let execTimer = null;
function flushExecuted() {
  if (execTimer) { clearTimeout(execTimer); execTimer = null; }
  if (!execDirty) return;
  execDirty = false;
  // prune old entries before persisting
  const cutoff = Date.now() - EXEC_MAX_AGE_MS;
  for (const [id, ts] of executedIds) if (ts < cutoff) executedIds.delete(id);
  try {
    atomicWrite(EXEC_FILE, { executed: Object.fromEntries(executedIds) });
  } catch (err) {
    console.error('[STORAGE] save executed_signals failed:', err.message);
  }
}
// Debounced by default; pass { immediate:true } on the trade-report path so a
// crash within the debounce window cannot resurrect an executed signal (audit SRV-09b).
function saveExecuted({ immediate = false } = {}) {
  execDirty = true;
  if (immediate) { flushExecuted(); return; }
  if (execTimer) return;
  execTimer = setTimeout(flushExecuted, 1500);
}
function loadExecuted() {
  try {
    if (fs.existsSync(EXEC_FILE)) {
      const data = JSON.parse(fs.readFileSync(EXEC_FILE, 'utf8'));
      executedIds = new Map(Object.entries(data.executed || {}).map(([k, v]) => [k, Number(v)]));
      console.log(`[STORAGE] Loaded ${executedIds.size} executed signal ids`);
    }
  } catch (err) {
    console.error('[STORAGE] executed_signals.json unreadable; backing up and starting empty:', err.message);
    try { fs.renameSync(EXEC_FILE, `${EXEC_FILE}.corrupt-${Date.now()}`); } catch { /* noop */ }
    executedIds = new Map();
  }
}

/* ── Trade tracking (from EA) ── */
let tradeStore = [];
let accountInfo = { balance: 0, equity: 0, profit: 0, openTrades: 0 };

function loadTradeStore() {
  try {
    if (fs.existsSync(LOG_FILE)) {
      const data = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
      if (Array.isArray(data.trades)) tradeStore = data.trades;
      if (data.account) accountInfo = data.account;
      console.log(`[STORAGE] Loaded ${tradeStore.length} trades from trades_log.json`);
    }
  } catch (err) {
    console.error('[STORAGE] trades_log.json unreadable; backing up:', err.message);
    try { fs.renameSync(LOG_FILE, `${LOG_FILE}.corrupt-${Date.now()}`); } catch { /* noop */ }
  }
}

let tradeDirty = false;
let tradeTimer = null;
function saveTradeStore({ immediate = false } = {}) {
  const flush = () => {
    tradeTimer = null;
    if (!tradeDirty) return;
    tradeDirty = false;
    try { atomicWrite(LOG_FILE, { trades: tradeStore, account: accountInfo }); }
    catch (err) { console.error('[STORAGE] save trades_log failed:', err.message); }
  };
  tradeDirty = true;
  if (immediate) { if (tradeTimer) { clearTimeout(tradeTimer); } flush(); return; }
  if (tradeTimer) return;                          // debounce heartbeat-driven writes (audit SRV-09)
  tradeTimer = setTimeout(flush, 5000);
}

/* ── validation helpers ── */
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function applyAccountFields(data) {
  const b = num(data.balance); if (b != null) accountInfo.balance = b;
  const e = num(data.equity); if (e != null) accountInfo.equity = e;
  const p = num(data.profit); if (p != null) accountInfo.profit = p;
  const o = num(data.openTrades); if (o != null) accountInfo.openTrades = Math.trunc(o);
}

/* ═══════════════════════ API ROUTES ═══════════════════════ */

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), lastUpdate, markets: Object.keys(candleStore) });
});

app.get('/api/candles', (req, res) => res.json(candleStore));

// All actionable signals for the EA — excludes executed AND active claims.
app.get('/api/signals', (req, res) => {
  const minConf = parseInt(req.query.min_confidence, 10) || 0;
  const symbol = req.query.symbol || null;
  const status = req.query.status || null;

  let filtered = signalStore.filter(s => !isExecuted(s.id) && !isClaimed(s.id));
  if (minConf > 0) filtered = filtered.filter(s => s.confidence >= minConf);
  if (symbol) filtered = filtered.filter(s => s.symbol === symbol.toUpperCase());
  if (status) filtered = filtered.filter(s => s.status === status.toUpperCase());

  res.json({ count: filtered.length, lastUpdate, signals: filtered });
});

// Atomic lease: the EA claims a signal immediately before sending the order.
// Only the first caller within CLAIM_TTL gets ok:true — closes the duplicate
// race even before a fill is reported (audit XSYS-02, MT5-01).
app.post('/api/claim', requireAuth, (req, res) => {
  const id = (req.body && req.body.signalId) ? String(req.body.signalId) : '';
  if (!id) return res.status(400).json({ ok: false, reason: 'missing signalId' });
  if (isExecuted(id)) return res.json({ ok: false, reason: 'already executed' });
  if (isClaimed(id)) return res.json({ ok: false, reason: 'already claimed' });
  claims.set(id, Date.now());
  console.log(`[CLAIM] ✓ ${id} leased to ${req.body.magic || 'EA'}`);
  res.json({ ok: true, ttlMs: CLAIM_TTL_MS });
});

app.get('/api/status', (req, res) => {
  res.json({
    connected: Object.keys(candleStore).length > 0,
    markets: Object.keys(candleStore),
    signalCount: signalStore.length,
    executedCount: executedIds.size,
    lastUpdate,
  });
});

app.get('/api/prices', (req, res) => {
  const prices = {};
  for (const [symbol, candles] of Object.entries(candleStore)) {
    if (candles.length > 0) {
      const last = candles[candles.length - 1];
      prices[symbol] = { price: last.close, time: last.time };
    }
  }
  res.json(prices);
});

// EA reports an executed trade (+ account snapshot)
app.post('/api/trades', requireAuth, (req, res) => {
  const data = req.body || {};

  // ── CLOSE report: realized per-deal P&L when a position (partially) closes ──
  // The EA sends { event:'close', ticket:<positionId>, signalId, dealId, profit:<realized>,
  // closed:<bool> }. We attach realized P&L to the matching open record so the
  // dashboard's win/loss/equity stats reflect ACTUAL outcomes, not floating P&L.
  if (data.event === 'close') {
    const ticket = (data.ticket !== undefined && data.ticket !== null) ? String(data.ticket) : '';
    const sigId = data.signalId ? String(data.signalId) : '';
    const dealId = (data.dealId !== undefined && data.dealId !== null && String(data.dealId).length > 0)
      ? String(data.dealId) : '';
    const pnl = num(data.profit);
    const fullyClosed = (data.closed === true || data.closed === 'true');

    // In a close report `profit` is the REALIZED deal P&L, so read account floating
    // profit from `profitAcct` instead of clobbering it.
    const applyCloseAccount = () => {
      const b = num(data.balance); if (b != null) accountInfo.balance = b;
      const e = num(data.equity); if (e != null) accountInfo.equity = e;
      const pa = num(data.profitAcct); if (pa != null) accountInfo.profit = pa;
      const o = num(data.openTrades); if (o != null) accountInfo.openTrades = Math.trunc(o);
    };

    // IDEMPOTENCY: the EA retries/re-queues the identical close body on a lost
    // response. Each close carries a unique dealId; if we've already counted it,
    // refresh the account snapshot but do NOT accumulate realizedPnl again
    // (otherwise a retried close doubles the P&L — audit SRV-CLOSE-01).
    if (dealId) {
      for (let i = tradeStore.length - 1; i >= 0; i--) {
        const t = tradeStore[i];
        if (t.closeDeals && t.closeDeals.includes(dealId)) {
          applyCloseAccount();
          saveTradeStore({ immediate: true });
          return res.json({ status: 'ok', deduped: true, tradeCount: tradeStore.length });
        }
      }
    }

    let matched = null;
    for (let i = tradeStore.length - 1; i >= 0; i--) {
      const t = tradeStore[i];
      if (t.standaloneClose) continue;
      if (ticket && String(t.ticket) === ticket) { matched = t; break; }
    }
    if (!matched && sigId) {
      for (let i = tradeStore.length - 1; i >= 0; i--) {
        const t = tradeStore[i];
        if (!t.standaloneClose && t.signalId === sigId && t.status !== 'CLOSED') { matched = t; break; }
      }
    }

    if (matched) {
      matched.realizedPnl = (num(matched.realizedPnl) || 0) + (pnl != null ? pnl : 0);
      if (dealId) (matched.closeDeals || (matched.closeDeals = [])).push(dealId);
      if (fullyClosed) {
        matched.status = 'CLOSED';
        matched.closedAt = Date.now();
        matched.closeTimeStr = new Date().toLocaleTimeString();
      }
    } else {
      // No matching open record (e.g. server restarted after the open) — keep a
      // standalone realized-P&L record so analytics still count the outcome.
      tradeStore.push({
        ticket,
        signalId: sigId,
        symbol: typeof data.symbol === 'string' ? data.symbol.slice(0, 20) : '',
        type: data.type === 'SELL' ? 'SELL' : (data.type === 'BUY' ? 'BUY' : ''),
        realizedPnl: pnl != null ? pnl : 0,
        status: fullyClosed ? 'CLOSED' : 'OPEN',
        standaloneClose: true,
        closeDeals: dealId ? [dealId] : [],
        closedAt: fullyClosed ? Date.now() : null,
        timestamp: Date.now(),
        timeStr: new Date().toLocaleTimeString(),
        closeTimeStr: new Date().toLocaleTimeString(),
      });
      if (tradeStore.length > 100) tradeStore = tradeStore.slice(-100);
    }

    applyCloseAccount();
    saveTradeStore({ immediate: true });
    console.log(`[TRADE] ⊗ CLOSE ${matched ? matched.symbol : (data.symbol || '')} realized ${pnl} (sig ${sigId || 'n/a'}${fullyClosed ? ', full' : ', partial'})`);
    return res.json({ status: 'ok', tradeCount: tradeStore.length });
  }

  if (data.ticket !== undefined && data.ticket !== null && String(data.ticket).length > 0) {
    const sigId = data.signalId ? String(data.signalId) : '';
    const trade = {
      ticket: String(data.ticket),
      symbol: typeof data.symbol === 'string' ? data.symbol.slice(0, 20) : '',
      type: data.type === 'SELL' ? 'SELL' : (data.type === 'BUY' ? 'BUY' : ''),
      lots: num(data.lots),
      price: num(data.price),
      sl: num(data.sl),
      tp: num(data.tp),
      confidence: num(data.confidence),
      signalId: sigId,
      riskPct: num(data.riskPct),
      riskAmount: num(data.riskAmount),   // actual $ risked → accurate realized R-multiples
      balance: num(data.balance),
      equity: num(data.equity),
      profit: num(data.profit),       // account snapshot at open (NOT this trade's outcome)
      realizedPnl: 0,                 // filled in by the matching 'close' report
      status: 'OPEN',
      timestamp: Date.now(),
      timeStr: new Date().toLocaleTimeString(),
    };
    tradeStore.push(trade);
    if (tradeStore.length > 100) tradeStore = tradeStore.slice(-100);

    // Authoritative, durable dedup: only mark ids this server actually issued or
    // leased. An injected report with an unknown id is recorded but must NOT
    // poison the executed-set, or it could block a future legitimate signal
    // sharing that id (audit SRV-07). Persist immediately on this critical path.
    if (sigId) {
      if (issuedIds.has(sigId) || isClaimed(sigId) || isExecuted(sigId)) {
        markExecuted(sigId, { immediate: true });
      } else {
        console.warn(`[TRADE] reported unknown signalId ${sigId} (recorded, NOT dedup-marked)`);
      }
    }
    applyAccountFields(data);
    saveTradeStore({ immediate: true });
    console.log(`[TRADE] ✓ ${trade.type} ${trade.symbol} @ ${trade.price} (sig ${sigId || 'n/a'})`);
    return res.json({ status: 'ok', tradeCount: tradeStore.length });
  }

  // account-only update
  applyAccountFields(data);
  saveTradeStore();
  res.json({ status: 'ok', tradeCount: tradeStore.length });
});

// EA heartbeat (account snapshot only)
app.post('/api/heartbeat', requireAuth, (req, res) => {
  applyAccountFields(req.body || {});
  saveTradeStore();
  res.json({ status: 'ok' });
});

// Dashboard fetches trade history + account
app.get('/api/trades', (req, res) => {
  res.json({ trades: tradeStore, account: accountInfo, totalTrades: tradeStore.length });
});

// Performance stats computed from CLOSED trades' realized P&L (shared engine).
app.get('/api/stats', (req, res) => {
  res.json(computeStats(tradeStore, { startBalance: accountInfo.balance || 10000 }));
});

/* ═══════════════════ SETUP / AUTH / CONFIG ═══════════════════ */
app.get('/api/setup/status', (req, res) =>
  res.json({ needsSetup: auth.needsSetup(), username: auth.getUsername() }));

app.post('/api/setup', (req, res) => {
  if (!auth.needsSetup()) return res.status(409).json({ error: 'already configured' });
  const { username, password, config } = req.body || {};
  try {
    auth.createUser(username, password);
    if (config && typeof config === 'object') saveConfig(config);
    console.log(`[AUTH] admin '${auth.getUsername()}' created (first-time setup)`);
    return res.json({ token: auth.issueSession(), username: auth.getUsername() });
  } catch (err) { return res.status(400).json({ error: err.message }); }
});

app.post('/api/login', (req, res) => {
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
  const { username, password } = req.body || {};
  if (loginThrottled(ip, username)) return res.status(429).json({ error: 'too many attempts — wait a few minutes' });
  if (auth.verifyPassword(username, password)) {
    clearLoginFails(ip, username);
    return res.json({ token: auth.issueSession(), username: auth.getUsername() });
  }
  noteLoginFail(ip, username);
  return res.status(401).json({ error: 'invalid credentials' });
});

app.get('/api/auth/me', requireSession, (req, res) => res.json({ username: auth.getUsername() }));

app.post('/api/auth/change-password', requireSession, (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  try {
    auth.changePassword(oldPassword, newPassword);     // rotates sessionSecret (kills old tokens)
    return res.json({ ok: true, token: auth.issueSession() }); // hand the caller a fresh one
  } catch (err) { return res.status(400).json({ error: err.message }); }
});

// Executor settings edited from the dashboard (secrets masked on read).
app.get('/api/config', requireSession, (req, res) => res.json(publicConfig()));
app.post('/api/config', requireSession, (req, res) => {
  try { return res.json(saveConfig(req.body || {})); }
  catch (err) { return res.status(400).json({ error: err.message }); }
});

// The executor pulls its live config here (DECRYPTED secrets — never falls open).
app.get('/api/executor-config', requireExecutorAuth, (req, res) => res.json(executorConfig()));

/* ── Serve the built dashboard (single-container deploy). No-op in dev. ── */
const DIST_DIR = path.join(__dirname, 'dist');
if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
    res.sendFile(path.join(DIST_DIR, 'index.html'), err => { if (err) next(); });
  });
  console.log('[HTTP] serving built dashboard from dist/');
}

/* ── Boot ── */
loadExecuted();
loadTradeStore();

app.listen(PORT, BIND, async () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   NEXUS·SMC Signal API Server               ║');
  console.log(`║   Running on http://${BIND}:${PORT}`);
  console.log(`║   Auth: ${API_TOKEN ? 'ENABLED (X-API-Key)' : 'local-only (no token)'}`);
  console.log(`║   Dashboard login: ${auth.needsSetup() ? 'NEEDS FIRST-TIME SETUP' : 'configured'}`);
  console.log('║   Endpoints: /api/signals /api/claim /api/trades ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');
  if (BIND !== '127.0.0.1' && BIND !== 'localhost' && !API_TOKEN) {
    console.warn('[SECURITY] ⚠ Bound to a non-loopback address with NO NEXUS_API_TOKEN —');
    console.warn('[SECURITY]   /api/executor-config could expose decrypted exchange secrets. Set NEXUS_API_TOKEN.');
  }
  await refreshTick();
  scheduleRefresh();
});
