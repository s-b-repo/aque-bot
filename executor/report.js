/* ═══════════════════════════════════════════════════════
   Reporting + claim — speaks the SAME /api contract as the
   EAs: /api/claim (anti-duplicate lease), /api/trades (open
   + event:'close' with dealId idempotency), /api/heartbeat.
   Retries once, then queues for resend (bounded).
   ═══════════════════════════════════════════════════════ */
import { config } from './config.js';

const headers = () => {
  const h = { 'Content-Type': 'application/json' };
  if (config.apiKey) h['X-API-Key'] = config.apiKey;
  return h;
};

async function postJson(pathname, body, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(config.apiUrl + pathname, {
      method: 'POST', headers: headers(), body: JSON.stringify(body), signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* non-json */ }
    return { ok: res.ok, status: res.status, json };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  } finally {
    clearTimeout(to);
  }
}

/** Lease a signal before trading. Returns true to proceed, false to defer/skip. */
export async function claim(signalId) {
  if (!config.useServerClaim) return true;
  const r = await postJson('/api/claim', { signalId, magic: config.magic });
  if (r.status === 401 || r.status === 403) {
    console.error('[CLAIM] ⛔ auth failed — NEXUS_API_TOKEN/apiKey mismatch. No trades until fixed.');
    return false;
  }
  if (r.status !== 200) {
    console.warn(`[CLAIM] ⚠ HTTP ${r.status} — deferring (server is the dup gate)`);
    return false;                       // defer rather than risk a duplicate
  }
  if (r.json && r.json.ok === true) return true;
  console.log(`[CLAIM] ⛔ ${signalId} not granted (${r.json && r.json.reason})`);
  return false;
}

/** Pull the bot's realized performance stats (drives the Kelly risk factor). */
export async function fetchStats() {
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(config.apiUrl + '/api/stats', { signal: ctrl.signal });
    clearTimeout(to);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

const queue = [];
function enqueue(body) { if (queue.length < 200) queue.push(body); }

export async function flushQueue() {
  while (queue.length) {
    const r = await postJson('/api/trades', queue[0]);
    if (r.ok) queue.shift();
    else break;                          // still offline — retry next tick
  }
}

async function sendTrade(body) {
  let r = await postJson('/api/trades', body);
  if (!r.ok) r = await postJson('/api/trades', body);   // one retry
  if (!r.ok) { enqueue(body); console.warn('[REPORT] ⚠ queued (server unreachable)'); }
  return r.ok;
}

export function reportOpen(t, account) {
  return sendTrade({
    ticket: t.ticket,
    symbol: t.signalSymbol,
    type: t.side === 'buy' ? 'BUY' : 'SELL',
    lots: t.qty,
    price: t.entry,
    sl: t.sl,
    tp: t.tp,
    confidence: t.confidence,
    signalId: t.signalId,
    riskPct: config.riskPercent,
    riskAmount: t.riskMoney,            // ACTUAL $ risked (after dynamic mult + caps) → correct R-multiples
    balance: account.balance,
    equity: account.equity,
    profit: account.floating,           // account floating P&L at open
  });
}

export function reportClose({ ticket, dealId, signalId, symbol, side, realizedPnl, closed, account, openTrades }) {
  return sendTrade({
    event: 'close',
    ticket,
    dealId,
    signalId,
    symbol,
    type: side === 'buy' ? 'BUY' : 'SELL',
    profit: realizedPnl,                // REALIZED P&L
    closed,
    openTrades,
    balance: account.balance,
    equity: account.equity,
    profitAcct: account.floating,       // account floating P&L (kept separate)
  });
}

export function heartbeat(account, { halted, session, openTrades, dailyLossPct }) {
  return postJson('/api/heartbeat', {
    balance: account.balance,
    equity: account.equity,
    profit: account.floating,
    openTrades,
    dailyLossPct,
    halted,
    session,
    status: 'CONNECTED',
  });
}
