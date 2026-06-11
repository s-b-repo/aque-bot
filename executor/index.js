/* ═══════════════════════════════════════════════════════
   NEXUS·SMC Universal Executor
   ─────────────────────────────────────────────────────
   FOSS, Docker-deployable replacement for the MT4/MT5 EAs.
   Consumes /api/signals, applies the full ported risk model
   (sizing, kill-switches, claim/dedup, entry gates), executes
   through a CCXT broker (paper by default), manages trades
   (break-even / trailing / partial / SL / TP) and reports
   realized P&L back to the dashboard.
   ═══════════════════════════════════════════════════════ */
import { config } from './config.js';
import { createBroker } from './brokers/index.js';
import { loadState, getState, saveState, isExecuted, markExecuted, nextCloseSeq } from './state.js';
import * as risk from './risk.js';
import * as report from './report.js';
import { toExchangeSymbol, isTradeable } from './symbols.js';
import { fetchRemoteConfig, applyRemote } from './remoteConfig.js';

let broker;                  // created in main(), after remote config is applied
let halted = false;
let liveStats = null;        // bot's realized performance (refreshed periodically)
let pollBusy = false, manageBusy = false;
const tickerCache = new Map();           // exSymbol -> { t, at }
let warnedNoShort = false;

const dir = side => (side === 'buy' ? 1 : -1);
const todayKey = () => { const d = new Date(); return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate(); };

async function getTicker(exSymbol) {
  const c = tickerCache.get(exSymbol);
  if (c && Date.now() - c.at < 1200) return c.t;       // micro-cache to cut API calls
  const t = await broker.getTicker(exSymbol);
  tickerCache.set(exSymbol, { t, at: Date.now() });
  return t;
}

/* ── Account snapshot: realized cash balance + floating P&L = equity ── */
async function snapshotAccount() {
  const balance = await broker.getCashBalance();
  const st = getState();
  let floating = 0;
  for (const t of st.openTrades) {
    try {
      const tk = await getTicker(t.exSymbol);
      const px = t.side === 'buy' ? tk.bid : tk.ask;
      floating += (px - t.entry) * t.qty * dir(t.side);
    } catch { /* price unavailable this tick */ }
  }
  return { balance, equity: balance + floating, floating };
}

/* ── Sticky daily state ── */
function checkDayRollover(equity) {
  const st = getState();
  const key = todayKey();
  if (st.day.key !== key) {
    st.day = { key, startEquity: equity, tradesToday: 0, consec: st.day.key === 0 ? (st.day.consec || 0) : 0, halt: false };
    halted = false;
    saveState({ immediate: true });
    console.log(`[DAY] new session ${key} — start equity $${equity.toFixed(2)}`);
  }
}
function tripHalt(reason) {
  if (halted) return;
  halted = true;
  getState().day.halt = true;
  saveState({ immediate: true });
  console.error(`[HALT] ⛔ ${reason} — no new trades until next day or state reset.`);
}

function inSession() {
  if (!config.sessionFilterEnabled) return true;
  const h = new Date().getUTCHours();
  return (h >= config.londonOpenHour && h < config.londonCloseHour) ||
         (h >= config.newYorkOpenHour && h < config.newYorkCloseHour);
}

/* ── Open-trade management: BE, trailing, partial, SL/TP ── */
async function manageOpenTrades(account) {
  const st = getState();
  for (let i = st.openTrades.length - 1; i >= 0; i--) {
    const t = st.openTrades[i];
    let tk;
    try { tk = await getTicker(t.exSymbol); } catch { continue; }
    const px = t.side === 'buy' ? tk.bid : tk.ask;      // exit-side price
    const profit = (px - t.entry) * dir(t.side);
    const r = t.initialSlDist > 0 ? profit / t.initialSlDist : 0;

    // STOP / TARGET hit → full close
    const stopHit = t.side === 'buy' ? px <= t.sl : px >= t.sl;
    const tpHit = t.side === 'buy' ? px >= t.tp : px <= t.tp;
    if (stopHit || tpHit) { await closeTrade(i, t.qty, true, stopHit ? 'SL' : 'TP', account); continue; }

    // BREAK-EVEN
    if (config.useBreakEven && !t.beDone && r >= config.breakEvenTriggerR) {
      const off = t.initialSlDist * config.breakEvenOffsetFrac;
      const be = broker.roundPrice(t.exSymbol, t.entry + off * dir(t.side));
      const improves = t.side === 'buy' ? be > t.sl : be < t.sl;
      if (improves) { t.sl = be; t.beDone = true; saveState(); console.log(`[MANAGE] BE ${t.signalSymbol} @ ${be} (${r.toFixed(2)}R)`); }
    }

    // PARTIAL CLOSE at TP1
    if (config.usePartialClose && !t.partialDone && r >= config.partialCloseR &&
        (!config.partialRequiresBE || t.beDone)) {
      const m = broker.market(t.exSymbol) || { minQty: 0 };
      let closeQty = broker.roundQty(t.exSymbol, t.qty * (config.partialClosePct / 100));
      const remaining = broker.roundQty(t.exSymbol, t.qty - closeQty);
      if (remaining > 0 && m.minQty && remaining < m.minQty) closeQty = t.qty;     // remainder too small → close all
      if (closeQty >= (m.minQty || 0) && closeQty > 0) {
        const wasFull = closeQty >= t.qty;
        await closeTrade(i, closeQty, wasFull, 'PARTIAL', account);
        if (!wasFull && st.openTrades[i]) { st.openTrades[i].partialDone = true; saveState(); }
        continue;
      }
    }

    // TRAILING STOP (% of price, only improving)
    if (config.useTrailingStop && r >= config.trailStartR) {
      const trail = px * (config.trailDistancePct / 100);
      const newSL = broker.roundPrice(t.exSymbol, t.side === 'buy' ? px - trail : px + trail);
      const improves = t.side === 'buy' ? newSL > t.sl : newSL < t.sl;
      const beyondEntry = t.side === 'buy' ? newSL > t.entry : newSL < t.entry;
      if (improves && beyondEntry) { t.sl = newSL; saveState(); }
    }
  }
}

/* ── Close (part of) a trade, compute realized P&L, report it ── */
async function closeTrade(idx, qty, isFull, why, account) {
  const st = getState();
  const t = st.openTrades[idx];
  if (!t) return;
  const closeSide = t.side === 'buy' ? 'sell' : 'buy';
  let fill;
  try {
    const o = await broker.marketOrder(t.exSymbol, closeSide, qty);
    fill = o;
  } catch (err) {
    console.error(`[CLOSE] order failed for ${t.signalSymbol}: ${err.message}`);
    return;
  }
  const portion = qty / t.origQty;
  const openFeePortion = (t.openFee || 0) * portion;
  const realized = (fill.fillPrice - t.entry) * qty * dir(t.side) - openFeePortion - (fill.fee || 0);
  broker.applyRealized(realized);

  const dealId = `${t.ticket}-${nextCloseSeq()}`;
  const fully = isFull || broker.roundQty(t.exSymbol, t.qty - qty) <= 0;

  if (fully) {
    st.openTrades.splice(idx, 1);
    // whole-trade outcome drives the consecutive-loss kill switch
    const wholeNet = realized + (t.realizedSoFar || 0);
    if (wholeNet < 0) st.day.consec = (st.day.consec || 0) + 1;
    else if (wholeNet > 0) st.day.consec = 0;
    if (risk.consecLossHalt(st.day.consec)) tripHalt(`max consecutive losses (${st.day.consec})`);
  } else {
    t.qty = broker.roundQty(t.exSymbol, t.qty - qty);
    t.riskMoney = t.qty * t.initialSlDist;
    t.realizedSoFar = (t.realizedSoFar || 0) + realized;
  }
  saveState({ immediate: true });

  const acct = account || await snapshotAccount();
  console.log(`[CLOSE] ${why} ${t.signalSymbol} ${qty} @ ${fill.fillPrice} → realized $${realized.toFixed(2)}${fully ? ' (full)' : ' (partial)'}`);
  await report.reportClose({
    ticket: t.ticket, dealId, signalId: t.signalId, symbol: t.signalSymbol, side: t.side,
    realizedPnl: Number(realized.toFixed(2)), closed: fully, account: acct, openTrades: st.openTrades.length,
  });
}

/* ── Signal intake + entry gates ── */
function countOpenBySymbol(sym) { return getState().openTrades.filter(t => t.signalSymbol === sym).length; }

async function processSignals(signals, account) {
  const st = getState();
  for (const s of signals) {
    if (st.openTrades.length >= config.maxOpenTrades) break;
    if (config.maxTradesPerDay > 0 && st.day.tradesToday >= config.maxTradesPerDay) break;

    const signalId = s.id, sym = s.symbol;
    const side = s.type === 'BUY' ? 'buy' : s.type === 'SELL' ? 'sell' : null;
    if (!signalId || !sym || !side) continue;
    if (!isTradeable(sym)) continue;                          // data-only market (e.g. Nasdaq)
    if (!(s.confidence >= config.minConfidence)) continue;
    if (s.status !== 'ACTIVE') continue;
    const entry = +s.entry, sl = +s.sl, tp = +s.tp;
    if (!(entry > 0 && sl > 0 && tp > 0)) continue;
    if (side === 'buy' && !(sl < entry && tp > entry)) continue;
    if (side === 'sell' && !(sl > entry && tp < entry)) continue;
    if (isExecuted(signalId)) continue;

    const exSymbol = toExchangeSymbol(sym);
    if (side === 'sell' && !broker.canShort) {
      if (!warnedNoShort) { console.warn('[GATE] broker cannot short (spot) — SELL signals skipped. Set EXCHANGE_TYPE=swap to enable.'); warnedNoShort = true; }
      continue;
    }

    // per-symbol cap
    if (countOpenBySymbol(sym) >= config.maxTradesPerSymbol) continue;

    let tk;
    try { tk = await getTicker(exSymbol); } catch { continue; }
    const price = side === 'buy' ? tk.ask : tk.bid;
    const slDist = Math.abs(entry - sl);

    // price divergence (wrong-instrument guard)
    if (config.maxPriceDivergencePct > 0 && Math.abs(price - entry) / entry * 100 > config.maxPriceDivergencePct) {
      console.log(`[GATE] ${sym} price divergence — skip`); continue;
    }
    // spread vs SL distance
    const spread = tk.ask - tk.bid;
    if (config.maxSpreadToSLRatio > 0 && slDist > 0 && spread > slDist * config.maxSpreadToSLRatio) continue;
    // entry proximity / anti-chase
    const delta = Math.abs(price - entry);
    if (config.maxEntryDeviation > 0 && delta > slDist * (config.maxEntryDeviation / 100)) continue;
    if (config.requireOBProximity && delta > slDist * config.obProximityPct) continue;
    // SMC confluence requirements
    if (config.requireFVG && !s.hasFVG) continue;
    if (config.requireLiquiditySweep && !s.hasLiquiditySweep) continue;
    if (config.requireTrend && !s.hasTrend) continue;
    // directional sanity vs the ACTUAL price we'd fill at
    if (side === 'buy' && !(sl < price && tp > price)) continue;
    if (side === 'sell' && !(sl > price && tp < price)) continue;

    // Size FIRST. A refusal here (portfolio cap, min-notional, momentary price blip)
    // is often TRANSIENT, so we must NOT have consumed the claim or marked the signal
    // executed yet — otherwise it would be dropped forever. It simply retries next poll.
    const mult = risk.riskMultiplier({
      confidence: s.confidence, equity: account.equity,
      peakEquity: st.peakEquity || account.equity, consec: st.day.consec || 0,
      stats: liveStats,
    });
    const sized = risk.sizePosition({ broker, symbol: exSymbol, entry: price, sl, balance: account.balance, equity: account.equity, openTrades: st.openTrades, riskMult: mult });
    if (!sized.qty) { console.log(`[SIZE] ${sym} refused (retryable): ${sized.reason}`); continue; }
    if (config.dynamicRisk) console.log(`[RISK] ${sym} dynamic ×${mult.toFixed(2)} (conf ${s.confidence}, consec ${st.day.consec || 0})`);

    // anti-duplicate: claim → optimistic mark → execute (mark stays on a post-claim
    // order failure to avoid double-sending a possibly-placed order).
    if (!(await report.claim(signalId))) continue;
    markExecuted(signalId);

    let order;
    try { order = await broker.marketOrder(exSymbol, side, sized.qty); }
    catch (err) { console.error(`[OPEN] order failed ${sym}: ${err.message}`); continue; }

    const fillEntry = order.fillPrice;
    const initialSlDist = Math.abs(fillEntry - sl);
    const trade = {
      ticket: `EX${config.magic}-${signalId}`,
      signalId, signalSymbol: sym, exSymbol, side,
      qty: order.qty, origQty: order.qty,
      entry: fillEntry, sl, tp,
      initialSlDist, riskMoney: order.qty * initialSlDist,
      confidence: s.confidence, openFee: order.fee || 0,
      beDone: false, partialDone: false, realizedSoFar: 0, openedAt: Date.now(),
    };
    st.openTrades.push(trade);
    st.day.tradesToday += 1;
    saveState({ immediate: true });

    console.log(`[OPEN] ✓ ${side.toUpperCase()} ${sym} ${order.qty} @ ${fillEntry} | SL ${sl} TP ${tp} | risk $${trade.riskMoney.toFixed(2)} | conf ${s.confidence}%`);
    const acct = await snapshotAccount();
    await report.reportOpen(trade, acct);
  }
}

/* ── Loops ── */
async function manageTick() {
  if (manageBusy) return; manageBusy = true;
  try {
    const account = await snapshotAccount();
    checkDayRollover(account.equity);
    const st = getState();
    if (account.equity > (st.peakEquity || 0)) { st.peakEquity = account.equity; saveState(); }   // drawdown high-water mark
    await manageOpenTrades(account);
    await report.flushQueue();
    const dlPct = getState().day.startEquity > 0 ? (getState().day.startEquity - account.equity) / getState().day.startEquity * 100 : 0;
    await report.heartbeat(account, { halted, session: inSession() ? 'ACTIVE' : 'CLOSED', openTrades: getState().openTrades.length, dailyLossPct: Number(dlPct.toFixed(2)) });
  } catch (err) { console.error('[MANAGE] error:', err.message); }
  finally { manageBusy = false; }
}

async function pollTick() {
  if (pollBusy) return; pollBusy = true;
  try {
    const account = await snapshotAccount();
    checkDayRollover(account.equity);
    const st = getState();
    if (!config.tradeEnabled || halted || st.day.halt) { halted = halted || st.day.halt; return; }
    if (risk.dailyLossBreached(st.day.startEquity, account.equity)) { tripHalt('daily loss limit'); return; }
    if (!risk.equityGuardOk(account.balance, account.equity)) { console.log('[GUARD] equity guard'); return; }
    // free cash (account.balance is the broker's FREE balance) vs a fraction of equity
    if (!risk.freeMarginOk(account.equity, account.balance)) { console.log('[GUARD] free-margin guard'); return; }
    if (config.maxTradesPerDay > 0 && st.day.tradesToday >= config.maxTradesPerDay) return;
    if (st.openTrades.length >= config.maxOpenTrades) return;
    if (!inSession()) return;

    const url = `${config.apiUrl}/api/signals?min_confidence=${config.minConfidence}&status=ACTIVE`;
    const res = await fetch(url);
    if (!res.ok) { console.warn('[POLL] signals HTTP', res.status); return; }
    const data = await res.json();
    if (Array.isArray(data.signals) && data.signals.length) await processSignals(data.signals, account);
  } catch (err) { console.error('[POLL] error:', err.message); }
  finally { pollBusy = false; }
}

/* ── Resilient config resolution (GUI-driven values may be incomplete) ── */
function resolveConfig() {
  if (config.riskPercent > config.maxRiskPercentHard) {
    console.warn(`[CONFIG] clamping risk ${config.riskPercent}% → ${config.maxRiskPercentHard}%`);
    config.riskPercent = config.maxRiskPercentHard;
  }
  if (!['paper', 'ccxt'].includes(config.broker)) {
    console.warn(`[CONFIG] unknown broker '${config.broker}' → paper`); config.broker = 'paper';
  }
  if (config.broker === 'ccxt' && config.live && (!config.exchangeKey || !config.exchangeSecret)) {
    console.warn('[CONFIG] LIVE requested but exchange keys missing → forcing sandbox'); config.live = false;
  }
}

async function refreshRemote() {
  const remote = await fetchRemoteConfig();
  if (remote) {
    const changed = applyRemote(remote, { startup: false });
    if (config.riskPercent > config.maxRiskPercentHard) config.riskPercent = config.maxRiskPercentHard;
    if (changed.length) console.warn(`[CONFIG] GUI changed ${changed.join(', ')} — RESTART the executor to apply (broker/exchange/keys).`);
  }
  // Refresh realized-performance stats so the Kelly risk factor tracks reality.
  const s = await report.fetchStats();
  if (s) liveStats = s;
}

/* ── Boot ── */
async function main() {
  loadState();
  applyRemote(await fetchRemoteConfig(), { startup: true });   // pull GUI settings (best-effort)
  resolveConfig();

  broker = createBroker();
  await broker.init();
  const acct = await snapshotAccount();
  const st = getState();
  if (!st.peakEquity) { st.peakEquity = acct.equity; saveState(); }
  checkDayRollover(acct.equity);
  halted = st.day.halt;
  liveStats = await report.fetchStats();

  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   NEXUS·SMC Universal Executor                ║');
  console.log(`║   Broker:  ${broker.name}`);
  console.log(`║   Risk:    ${config.riskPercent}% | max $${config.maxRiskDollars} | dynamic ${config.dynamicRisk ? 'ON' : 'OFF'} | daily-loss ${config.maxDailyLossPercent}%`);
  console.log(`║   Equity:  $${acct.equity.toFixed(2)} | open ${st.openTrades.length} | halt ${halted}`);
  console.log(`║   API:     ${config.apiUrl}  | claim ${config.useServerClaim ? 'ON' : 'OFF'}`);
  console.log('╚══════════════════════════════════════════════╝');

  setInterval(manageTick, config.manageSeconds * 1000);
  setInterval(pollTick, config.pollSeconds * 1000);
  setInterval(refreshRemote, 30_000);
  await manageTick();
  await pollTick();
}

main().catch(err => { console.error('[FATAL]', err); process.exit(1); });
