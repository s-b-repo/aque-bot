/* ═══════════════════════════════════════════════════════
   Backtester — replays the SMC strategy over historical
   Binance klines, bar by bar, using the SAME detection,
   signal construction and SL/TP/BE/trail/partial management
   as the live executor, then reports validated performance
   stats. This is how we judge the algorithm honestly.

   Usage:
     node backtest/run.js --symbol BTCUSDT --tf 5m --bars 1500
     node backtest/run.js --symbol ETHUSDT --tf 15m --bars 2000 --risk 1 --balance 10000
   ═══════════════════════════════════════════════════════ */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { detectSMC, buildSignalsForMarket } from '../src/engine/smcEngine.js';
import { computeStats, formatStats } from '../src/engine/stats.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ── CLI args ── */
function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { a[argv[i].slice(2)] = argv[i + 1]; i++; }
  }
  return a;
}
const args = parseArgs(process.argv);
const SYMBOL = (args.symbol || 'BTCUSDT').toUpperCase();
const TF = args.tf || '5m';
const BARS = Math.min(Number(args.bars) || 1500, 20000);
const WINDOW = Number(args.window) || 250;       // bars fed to the engine each step (≈ live)
const cfg = {
  balance: Number(args.balance) || 10000,
  riskPct: Number(args.risk) || 1.0,
  minConf: Number(args.minConf) || 75,
  requireTrend: /^(1|true|yes)$/i.test(String(args.requireTrend || '')),
  // Entries/TPs/partials rest as LIMIT orders at SMC levels → maker fee.
  // Stop-loss exits are stop-market → taker fee + slippage.
  makerFee: args.maker != null ? Number(args.maker) : 0.0002,
  takerFee: args.taker != null ? Number(args.taker) : 0.0005,
  slippagePct: args.slippage != null ? Number(args.slippage) : 0.02, // % adverse fill on stops
  useBE: true, beTriggerR: 1.0, beOffsetFrac: 0.05,
  useTrail: true, trailStartR: 1.5, trailDistancePct: 0.5,
  usePartial: true, partialCloseR: 1.0, partialClosePct: 50, partialRequiresBE: true,
  dec: SYMBOL.includes('BTC') ? 2 : 5,
  pipSize: SYMBOL.includes('BTC') ? 0.01 : 0.0001,
};

/* ── Fetch historical klines (paginated) ── */
async function fetchKlines(symbol, interval, total) {
  const out = [];
  let endTime = Date.now();
  while (out.length < total) {
    const limit = Math.min(1000, total - out.length);
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}&endTime=${endTime}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance klines HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) break;
    const chunk = data.map(k => ({
      time: Math.floor(k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
    }));
    out.unshift(...chunk);
    endTime = data[0][0] - 1;
    if (data.length < limit) break;
  }
  const seen = new Set(); const uniq = [];
  for (const c of out) { if (!seen.has(c.time)) { seen.add(c.time); uniq.push(c); } }
  uniq.sort((a, b) => a.time - b.time);
  return uniq.slice(-total);
}

/* ── Simulate one trade forward, bar by bar (existing stops first, then tighten) ── */
function simulateTrade(side, entry, sl0, tp, candles, startIdx, riskAmt) {
  const d = side === 'buy' ? 1 : -1;
  const slDist0 = Math.abs(entry - sl0);
  if (!(slDist0 > 0)) return null;
  const qty = riskAmt / slDist0;
  let sl = sl0, beDone = false, partialDone = false, realized = 0, gross = 0, remQty = qty;
  realized -= entry * qty * cfg.makerFee;                 // entry (limit) maker fee

  for (let j = startIdx; j < candles.length; j++) {
    const c = candles[j];
    const hitSL = side === 'buy' ? c.low <= sl : c.high >= sl;
    const hitTP = side === 'buy' ? c.high >= tp : c.low <= tp;
    if (hitSL) {
      const fill = sl - d * sl * (cfg.slippagePct / 100);  // adverse slippage on stops
      gross += (sl - entry) * remQty * d;
      realized += (fill - entry) * remQty * d - fill * remQty * cfg.takerFee;
      return { realized, gross, exitIdx: j, reason: 'SL' };
    }
    if (hitTP) {
      gross += (tp - entry) * remQty * d;
      realized += (tp - entry) * remQty * d - tp * remQty * cfg.makerFee;
      return { realized, gross, exitIdx: j, reason: 'TP' };
    }

    if (cfg.usePartial && !partialDone && (!cfg.partialRequiresBE || beDone)) {
      const lvl = entry + d * cfg.partialCloseR * slDist0;
      const reached = side === 'buy' ? c.high >= lvl : c.low <= lvl;
      if (reached) {
        const closeQty = remQty * (cfg.partialClosePct / 100);
        gross += (lvl - entry) * closeQty * d;
        realized += (lvl - entry) * closeQty * d - lvl * closeQty * cfg.makerFee;
        remQty -= closeQty; partialDone = true;
      }
    }
    if (cfg.useBE && !beDone) {
      const lvl = entry + d * cfg.beTriggerR * slDist0;
      const reached = side === 'buy' ? c.high >= lvl : c.low <= lvl;
      if (reached) { sl = entry + d * slDist0 * cfg.beOffsetFrac; beDone = true; }
    }
    if (cfg.useTrail) {
      const ext = side === 'buy' ? c.high : c.low;
      const Rnow = (ext - entry) * d / slDist0;
      if (Rnow >= cfg.trailStartR) {
        const newSL = side === 'buy' ? ext - ext * cfg.trailDistancePct / 100 : ext + ext * cfg.trailDistancePct / 100;
        const improves = side === 'buy' ? newSL > sl : newSL < sl;
        const beyond = side === 'buy' ? newSL > entry : newSL < entry;
        if (improves && beyond) sl = newSL;
      }
    }
  }
  const last = candles[candles.length - 1].close;
  gross += (last - entry) * remQty * d;
  realized += (last - entry) * remQty * d - last * remQty * cfg.takerFee;
  return { realized, gross, exitIdx: candles.length - 1, reason: 'EOD' };
}

/* ── Replay ── */
async function main() {
  console.log(`\n⟳ Backtest ${SYMBOL} ${TF} — ${BARS} bars, risk ${cfg.riskPct}% of $${cfg.balance}, minConf ${cfg.minConf}\n`);
  const candles = await fetchKlines(SYMBOL, TF, BARS);
  if (candles.length < WINDOW + 10) { console.error('Not enough data.'); process.exit(1); }
  console.log(`Fetched ${candles.length} candles  (${new Date(candles[0].time * 1000).toISOString().slice(0, 10)} → ${new Date(candles[candles.length - 1].time * 1000).toISOString().slice(0, 10)})`);

  const market = { symbol: SYMBOL, dec: cfg.dec, pipSize: cfg.pipSize };
  let balance = cfg.balance;
  let grossTotal = 0;
  const trades = [];
  const seen = new Set();
  let nextFreeIdx = WINDOW;     // no overlapping trades (single position)

  for (let i = WINDOW; i < candles.length - 1; i++) {
    if (i < nextFreeIdx) continue;
    const window = candles.slice(i - WINDOW + 1, i + 1);
    const smc = detectSMC(window);
    const sigs = buildSignalsForMarket(window, smc, market);
    const sig = sigs.find(s =>
      s.status === 'ACTIVE' && s.confidence >= cfg.minConf &&
      (!cfg.requireTrend || s.hasTrend) && !seen.has(s.id));
    if (!sig) continue;
    seen.add(sig.id);

    const side = sig.type === 'BUY' ? 'buy' : 'sell';
    const riskAmt = balance * (cfg.riskPct / 100);
    const sim = simulateTrade(side, sig.entry, sig.sl, sig.tp, candles, i + 1, riskAmt);
    if (!sim) continue;

    balance += sim.realized;
    grossTotal += sim.gross;
    trades.push({
      status: 'CLOSED', symbol: SYMBOL, type: sig.type,
      realizedPnl: sim.realized, riskAmount: riskAmt,
      entry: sig.entry, sl: sig.sl, tp: sig.tp, confidence: sig.confidence,
      enteredAt: candles[i].time, exitReason: sim.reason,
    });
    nextFreeIdx = sim.exitIdx + 1;     // wait until this trade is done before the next
  }

  const stats = computeStats(trades, { startBalance: cfg.balance });
  console.log('\n══════════════════ RESULTS ══════════════════');
  console.log(formatStats(stats));
  if (stats.hasData) {
    const exits = trades.reduce((m, t) => { m[t.exitReason] = (m[t.exitReason] || 0) + 1; return m; }, {});
    console.log(`Exits:         ${Object.entries(exits).map(([k, v]) => `${k} ${v}`).join('  ')}`);
    console.log(`Net return:    ${((stats.endBalance / cfg.balance - 1) * 100).toFixed(1)}%  over ${trades.length} trades`);
    console.log(`Gross return:  ${((grossTotal) / cfg.balance * 100).toFixed(1)}%  (pre-fee/slippage — the raw signal edge)`);
  }
  console.log('═════════════════════════════════════════════');
  console.log(`Cost model: maker ${(cfg.makerFee * 100).toFixed(3)}% (entry/TP/partial), taker ${(cfg.takerFee * 100).toFixed(3)}% + ${cfg.slippagePct}% slip (stops).`);
  console.log('Note: tight SMC stops mean notional ≫ risk, so fees matter a lot — prefer maker (limit) entries and a low fee tier.');
  console.log('Caveat: bar-resolution backtest on recent data — an edge estimate, NOT a guarantee.\n');

  const outFile = path.join(__dirname, 'last-run.json');
  fs.writeFileSync(outFile, JSON.stringify({
    symbol: SYMBOL, tf: TF, bars: candles.length, config: cfg, stats, trades,
  }, null, 2));
  console.log(`Full report + equity curve → ${path.relative(process.cwd(), outFile)}\n`);
}

main().catch(err => { console.error('Backtest failed:', err.message); process.exit(1); });
