/* ═══════════════════════════════════════════════════════
   SMC (Smart Money Concept) Detection + Signal Engine
   ─────────────────────────────────────────────────────
   SINGLE SOURCE OF TRUTH. Imported by BOTH the React
   dashboard (via signalEngine.js) AND the Node API server
   (server.js). Do not fork this logic — see audit SMC-03.

   Detects: Order Blocks, Fair Value Gaps, market structure
   (BOS / CHoCH with trend context), Liquidity Sweeps,
   Premium/Discount (dealing-range equilibrium).

   Signals are built with:
     • STABLE, time-anchored ids (audit SRV-01 / XSYS-01)
     • instrument-aware, ATR-buffered stops (audit SMC-05)
     • REAL risk:reward computed from the actual prices,
       not hardcoded labels (audit SRV-03)
   ═══════════════════════════════════════════════════════ */

/* ── Tunables (kept in one place, documented) ── */
export const ENGINE = {
  swingLookback: 2,        // bars each side for a swing pivot
  obBodyMin: 0.002,        // min OB candle body (fraction of price)
  obImpulseMin: 0.004,     // min follow-through move to qualify an OB
  fvgMin: 0,               // min FVG size (fraction); 0 = any gap
  eqTolerance: 0.0005,     // equal-high/low tolerance (0.05%)
  sweepLookbackBars: 30,   // how far back a swept level may be
  atrPeriod: 14,
  atrBufferMult: 0.25,     // SL buffer = atrBufferMult * ATR (floored)
  rrOB: 2.5,               // target R:R for order-block setups
  rrOBwithFVG: 3.0,
  rrSweep: 3.0,
  maxSignalsPerBuild: 12,  // dashboard cap
  trendFast: 50,           // fast EMA period for the higher-timeframe-style trend filter
  trendSlow: 200,          // slow EMA period
  trendAlignBonus: 8,      // confidence added when a setup aligns with the EMA trend
  counterTrendPenalty: 6,  // confidence removed when a setup fights a non-neutral trend
};

/* ── Drop candles with non-finite or non-positive OHLC so a single corrupt bar
   from a flaky feed can't propagate NaN/Infinity through every detector. ── */
function sanitizeCandles(candles) {
  if (!Array.isArray(candles)) return [];
  return candles.filter(c =>
    c &&
    Number.isFinite(c.open) && Number.isFinite(c.high) &&
    Number.isFinite(c.low) && Number.isFinite(c.close) &&
    c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0,
  );
}

/* ── Average True Range (Wilder-ish simple mean) ── */
export function computeATR(candles, period = ENGINE.atrPeriod) {
  if (!candles || candles.length < 2) return 0;
  const n = Math.min(period, candles.length - 1);
  let sum = 0;
  for (let i = candles.length - n; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low - prev.close),
    );
    sum += tr;
  }
  return n > 0 ? sum / n : 0;
}

/* ── Exponential Moving Average (full series) ── */
export function computeEMA(values, period) {
  if (!values || values.length === 0) return [];
  const k = 2 / (period + 1);
  const out = new Array(values.length);
  let ema = values[0];
  for (let i = 0; i < values.length; i++) {
    ema = i === 0 ? values[0] : values[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

/**
 * Higher-timeframe-style TREND filter (audit ALGO-01): a long EMA on the working
 * timeframe approximates the prevailing higher-TF direction. Used to bias signal
 * confidence toward trend-aligned setups and away from counter-trend ones.
 * @returns {{ bias:'bull'|'bear'|'neutral', emaFast:number|null, emaSlow:number|null, slope:number }}
 */
export function computeTrend(candles, fast = ENGINE.trendFast, slow = ENGINE.trendSlow) {
  if (!candles || candles.length < 10) {
    return { bias: 'neutral', emaFast: null, emaSlow: null, slope: 0 };
  }
  const closes = candles.map(c => c.close);
  const efSeries = computeEMA(closes, Math.min(fast, closes.length));
  const esSeries = computeEMA(closes, Math.min(slow, closes.length));
  const ef = efSeries[efSeries.length - 1];
  const es = esSeries[esSeries.length - 1];
  const price = closes[closes.length - 1];
  const lb = Math.min(10, efSeries.length - 1);
  const slope = lb > 0 && es ? (ef - efSeries[efSeries.length - 1 - lb]) / es : 0;
  let bias = 'neutral';
  if (ef > es && price >= es) bias = 'bull';
  else if (ef < es && price <= es) bias = 'bear';
  return { bias, emaFast: ef, emaSlow: es, slope };
}

/**
 * Main SMC detection — runs all pattern detectors on a candle array.
 * @param {Array} candles — Array of { time, open, high, low, close, volume }
 * @returns {{ obs, fvgs, structs, sweeps, eqhs, eqls, zones, atr }}
 */
export function detectSMC(rawCandles) {
  const candles = sanitizeCandles(rawCandles);
  const obs = [];
  const fvgs = [];
  const structs = [];
  const sweeps = [];
  const eqhs = [];
  const eqls = [];
  const shs = [];
  const sls = [];

  if (!candles || candles.length < 5) {
    return { obs, fvgs, structs, sweeps, eqhs, eqls, zones: null, atr: 0 };
  }

  const L = ENGINE.swingLookback;

  // ── Swing Highs & Lows (L-bar lookback/forward) ──
  for (let i = L; i < candles.length - L; i++) {
    const c = candles[i];
    let isSwingHigh = true;
    let isSwingLow = true;
    for (let j = i - L; j <= i + L; j++) {
      if (j === i) continue;
      if (candles[j].high >= c.high) isSwingHigh = false;
      if (candles[j].low <= c.low) isSwingLow = false;
    }
    if (isSwingHigh) shs.push({ i, p: c.high, time: c.time });
    if (isSwingLow) sls.push({ i, p: c.low, time: c.time });
  }

  // ── Equal Highs / Lows (Liquidity Pools) ──
  for (let i = 1; i < shs.length; i++) {
    const diff = Math.abs(shs[i].p - shs[i - 1].p) / shs[i - 1].p;
    if (diff < ENGINE.eqTolerance) {
      eqhs.push({ time: shs[i].time, p: Math.max(shs[i].p, shs[i - 1].p) });
    }
  }
  for (let i = 1; i < sls.length; i++) {
    const diff = Math.abs(sls[i].p - sls[i - 1].p) / sls[i - 1].p;
    if (diff < ENGINE.eqTolerance) {
      eqls.push({ time: sls[i].time, p: Math.min(sls[i].p, sls[i - 1].p) });
    }
  }

  // ── Market Structure: single chronological, trend-aware pass ──
  // (audit SMC-02: the old per-side pairwise loop produced noise with no
  //  trend context.) We walk candles in time order and confirm a break only
  //  on a CLOSE beyond the most recent confirmed swing. The first break that
  //  flips the prevailing trend is a CHoCH; continuations are BOS.
  {
    let si = 0; // pointer into shs
    let li = 0; // pointer into sls
    let lastSH = null; // most recent confirmed swing-high level before candle i
    let lastSL = null;
    let trend = 'none'; // 'bull' | 'bear' | 'none'
    let brokenSH = null; // avoid re-emitting the same level
    let brokenSL = null;

    for (let i = 0; i < candles.length; i++) {
      // promote any swing pivots that have now fully formed (occurred at <= i-L)
      while (si < shs.length && shs[si].i <= i - L) { lastSH = shs[si]; si++; }
      while (li < sls.length && sls[li].i <= i - L) { lastSL = sls[li]; li++; }

      const close = candles[i].close;

      if (lastSH && close > lastSH.p && brokenSH !== lastSH.p) {
        const type = trend === 'bear' ? 'CHoCH' : 'BOS';
        structs.push({ type, dir: 'bull', i, p: lastSH.p, time: candles[i].time });
        trend = 'bull';
        brokenSH = lastSH.p;
      }
      if (lastSL && close < lastSL.p && brokenSL !== lastSL.p) {
        const type = trend === 'bull' ? 'CHoCH' : 'BOS';
        structs.push({ type, dir: 'bear', i, p: lastSL.p, time: candles[i].time });
        trend = 'bear';
        brokenSL = lastSL.p;
      }
    }
  }

  // ── Order Blocks (last opposite candle before a displacement leg) ──
  // mitigated  = price returned to TOUCH the zone after the impulse leg
  // invalidated = a later candle CLOSED through the far side (zone broken)
  for (let i = L; i < candles.length - 3; i++) {
    const c = candles[i];
    const body = Math.abs(c.close - c.open) / c.open;
    if (body < ENGINE.obBodyMin) continue;

    const net = candles.slice(i + 1, i + 4);
    if (net.length < 3) continue;
    const move = (net[2].close - net[0].open) / net[0].open;

    if (c.close < c.open && move > ENGINE.obImpulseMin) {
      obs.push({ type: 'bull', i, high: c.high, low: c.low, time: c.time, mitigated: false, invalidated: false });
    }
    if (c.close > c.open && move < -ENGINE.obImpulseMin) {
      obs.push({ type: 'bear', i, high: c.high, low: c.low, time: c.time, mitigated: false, invalidated: false });
    }
  }

  // OB mitigation / invalidation — scan AFTER the 3-bar impulse leg (audit SMC-01)
  for (const ob of obs) {
    for (let j = ob.i + 4; j < candles.length; j++) {
      const cj = candles[j];
      // touched the zone?
      const touches = cj.low <= ob.high && cj.high >= ob.low;
      if (touches) ob.mitigated = true;
      // closed through the far side => zone broken / invalid
      if (ob.type === 'bull' && cj.close < ob.low) { ob.invalidated = true; break; }
      if (ob.type === 'bear' && cj.close > ob.high) { ob.invalidated = true; break; }
    }
  }

  // ── Fair Value Gaps (3-candle imbalance) with mitigation ──
  for (let i = 1; i < candles.length - 1; i++) {
    const prev = candles[i - 1];
    const next = candles[i + 1];
    if (prev.high < next.low) {
      const size = (next.low - prev.high) / prev.high;
      if (size >= ENGINE.fvgMin) {
        fvgs.push({ type: 'bull', i, top: next.low, bot: prev.high, time: candles[i].time, mitigated: false });
      }
    }
    if (prev.low > next.high) {
      const size = (prev.low - next.high) / next.high;
      if (size >= ENGINE.fvgMin) {
        fvgs.push({ type: 'bear', i, top: prev.low, bot: next.high, time: candles[i].time, mitigated: false });
      }
    }
  }
  for (const fvg of fvgs) {
    for (let j = fvg.i + 2; j < candles.length; j++) {
      if (fvg.type === 'bull' && candles[j].low <= fvg.bot) { fvg.mitigated = true; break; }
      if (fvg.type === 'bear' && candles[j].high >= fvg.top) { fvg.mitigated = true; break; }
    }
  }

  // ── Liquidity Sweeps (stop-runs that reverse) ──
  // Record the sweep candle's wick extreme so stops can sit beyond it.
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    for (const sh of shs) {
      if (sh.i >= i - 1 || sh.i < i - ENGINE.sweepLookbackBars) continue;
      if (c.high > sh.p && c.close < sh.p && prev.close < sh.p) {
        sweeps.push({ type: 'bearish_sweep', i, level: sh.p, wick: c.high, time: c.time });
        break;
      }
    }
    for (const sl of sls) {
      if (sl.i >= i - 1 || sl.i < i - ENGINE.sweepLookbackBars) continue;
      if (c.low < sl.p && c.close > sl.p && prev.close > sl.p) {
        sweeps.push({ type: 'bullish_sweep', i, level: sl.p, wick: c.low, time: c.time });
        break;
      }
    }
  }

  // ── Premium / Discount — current DEALING RANGE, not the whole window ──
  // (audit SMC-06: a 200-bar min/max equilibrium is stale.) Use the most
  // recent confirmed swing high & low to define the active range.
  let zones = null;
  if (shs.length && sls.length) {
    const recentSH = shs[shs.length - 1].p;
    const recentSL = sls[sls.length - 1].p;
    const rangeHigh = Math.max(recentSH, recentSL);
    const rangeLow = Math.min(recentSH, recentSL);
    const equilibrium = (rangeHigh + rangeLow) / 2;
    zones = {
      premium: { top: rangeHigh, bot: equilibrium },
      discount: { top: equilibrium, bot: rangeLow },
      equilibrium, rangeHigh, rangeLow,
    };
  }

  // keep valid OBs/FVGs (drop only invalidated/zone-broken ones)
  const validOBs = obs.filter(ob => !ob.invalidated);
  const validFVGs = fvgs.filter(fvg => !fvg.mitigated);

  return { obs: validOBs, fvgs: validFVGs, structs, sweeps, eqhs, eqls, zones, atr: computeATR(candles), trend: computeTrend(candles) };
}

/**
 * Determine the current market bias based on recent structure.
 */
export function getMarketBias(structs) {
  if (!structs || structs.length === 0) return 'neutral';
  const recent = structs.slice(-5);
  let bullCount = 0;
  let bearCount = 0;
  for (const s of recent) {
    if (s.type === 'BOS' && s.dir === 'bull') bullCount += 2;
    if (s.type === 'BOS' && s.dir === 'bear') bearCount += 2;
    if (s.type === 'CHoCH' && s.dir === 'bull') bullCount += 1;
    if (s.type === 'CHoCH' && s.dir === 'bear') bearCount += 1;
  }
  if (bullCount > bearCount + 2) return 'bullish';
  if (bearCount > bullCount + 2) return 'bearish';
  return 'neutral';
}

/* ── helpers ── */
function round(v, dec) {
  return parseFloat(Number(v).toFixed(dec));
}
function clampConf(v) {
  return Math.max(1, Math.min(96, Math.round(v)));
}
// real risk:reward from the actual (rounded) numbers
function realRR(type, entry, sl, tp) {
  const risk = type === 'BUY' ? entry - sl : sl - entry;
  const reward = type === 'BUY' ? tp - entry : entry - tp;
  if (risk <= 0) return 0;
  return reward / risk;
}

/**
 * Build canonical trade signals for a SINGLE market.
 * @param {Array}  candles
 * @param {Object} smc      detectSMC() output
 * @param {Object} cfg      { symbol, dec, pipSize }
 * @returns {Array} canonical signals
 *
 * Each signal carries both server (`symbol`,`confidence`) and dashboard
 * (`market`,`conf`) field aliases so one builder serves both consumers.
 */
export function buildSignalsForMarket(candles, smc, cfg) {
  const signals = [];
  if (!candles || candles.length < 10 || !smc) return signals;

  const symbol = cfg.symbol;
  const dec = Number.isFinite(cfg.dec) ? cfg.dec : 2;
  const pipSize = cfg.pipSize || Math.pow(10, -dec);
  const last = candles[candles.length - 1];
  const price = last.close;
  if (!Number.isFinite(price) || price <= 0) return signals;
  const zones = smc.zones;
  const atr = smc.atr || computeATR(candles);
  // SL buffer is instrument-aware: a fraction of ATR, floored at a few pips
  const buffer = Math.max(atr * ENGINE.atrBufferMult, pipSize * 5);
  const now = Date.now();
  const trend = smc.trend || computeTrend(candles);

  const mkSignal = (kind, anchorTime, type, refs, extra) => {
    const { entryRaw, slRaw, tpRaw } = refs;
    const entry = round(entryRaw, dec);
    const sl = round(slRaw, dec);
    const tp = round(tpRaw, dec);
    // directional sanity — never emit a wrong-sided stop (audit MT5-03)
    if (type === 'BUY' && !(sl < entry && tp > entry)) return null;
    if (type === 'SELL' && !(sl > entry && tp < entry)) return null;
    const rr = realRR(type, entry, sl, tp);
    if (rr <= 0) return null;
    const dist = Math.abs(price - entry) / entry;
    return {
      // STABLE, time-anchored id — survives the rolling candle window
      id: `${kind}-${symbol}-${anchorTime}`,
      type,
      symbol,
      market: symbol,
      reason: extra.reason,
      confluence: extra.confluence,
      confidence: extra.conf,
      conf: extra.conf,
      entry, sl, tp,
      rr: `1:${rr.toFixed(1)}`,
      rrValue: parseFloat(rr.toFixed(2)),
      status: dist < 0.003 ? 'ACTIVE' : 'PENDING',
      price,
      timestamp: now,
      time: anchorTime ? new Date(anchorTime * 1000).toLocaleTimeString() : new Date().toLocaleTimeString(),
      hasFVG: !!extra.hasFVG,
      hasLiquiditySweep: !!extra.hasLiquiditySweep,
      hasBOS: !!extra.hasBOS,
      hasCHoCH: !!extra.hasCHoCH,
      hasTrend: !!extra.hasTrend,
      htfBias: extra.htfBias || 'neutral',
    };
  };

  // ── Order Block signals ──
  smc.obs.slice(-6).forEach(ob => {
    const bull = ob.type === 'bull';
    const mid = (ob.high + ob.low) / 2;
    const distanceFromPrice = Math.abs(price - mid) / mid;
    if (distanceFromPrice > 0.02) return; // only when price is near the zone

    let conf = 55;
    if (distanceFromPrice < 0.005) conf += 15;
    else if (distanceFromPrice < 0.01) conf += 8;
    if (!ob.mitigated) conf += 6; // fresh OB

    const overlappingFVG = smc.fvgs.find(f => f.type === ob.type && Math.abs(f.i - ob.i) < 5);
    if (overlappingFVG) conf += 12;

    const alignedStruct = smc.structs.find(s => s.dir === (bull ? 'bull' : 'bear') && Math.abs(s.i - ob.i) < 12);
    if (alignedStruct) conf += alignedStruct.type === 'BOS' ? 10 : 6;

    const nearbySweep = smc.sweeps.find(sw =>
      Math.abs(sw.i - ob.i) < 8 &&
      ((bull && sw.type === 'bullish_sweep') || (!bull && sw.type === 'bearish_sweep')));
    if (nearbySweep) conf += 8;

    // premium/discount — only credit when price is meaningfully inside the zone
    let inDiscount = false, inPremium = false;
    if (zones) {
      const span = zones.rangeHigh - zones.rangeLow;
      if (span > 0) {
        inDiscount = price <= zones.equilibrium - span * 0.05;
        inPremium = price >= zones.equilibrium + span * 0.05;
        if (bull && inDiscount) conf += 8;
        if (!bull && inPremium) conf += 8;
      }
    }

    // STRICT FILTER: skip naked OBs with no confluence
    if (!overlappingFVG && !nearbySweep && !alignedStruct) return;

    // Higher-timeframe trend alignment (reward with-trend, penalise counter-trend)
    let trendAligned = false;
    if (trend.bias !== 'neutral') {
      if ((bull && trend.bias === 'bull') || (!bull && trend.bias === 'bear')) {
        conf += ENGINE.trendAlignBonus; trendAligned = true;
      } else {
        conf -= ENGINE.counterTrendPenalty;
      }
    }

    conf = clampConf(conf);

    const target = overlappingFVG ? ENGINE.rrOBwithFVG : ENGINE.rrOB;
    // entry at proximal edge; stop beyond far edge + ATR buffer; tp = entry + R*risk
    let refs;
    if (bull) {
      const entryRaw = ob.high;
      const slRaw = ob.low - buffer;
      const risk = entryRaw - slRaw;
      refs = { entryRaw, slRaw, tpRaw: entryRaw + target * risk };
    } else {
      const entryRaw = ob.low;
      const slRaw = ob.high + buffer;
      const risk = slRaw - entryRaw;
      refs = { entryRaw, slRaw, tpRaw: entryRaw - target * risk };
    }

    const sig = mkSignal('OB', ob.time, bull ? 'BUY' : 'SELL', refs, {
      reason: 'Order Block',
      confluence: [
        'Order Block',
        !ob.mitigated && 'Fresh',
        overlappingFVG && 'FVG Overlap',
        alignedStruct && (alignedStruct.type === 'BOS' ? 'BOS' : 'CHoCH'),
        nearbySweep && 'Liquidity Sweep',
        bull && inDiscount ? 'Discount' : (!bull && inPremium ? 'Premium' : ''),
        trendAligned && (bull ? 'HTF Bull' : 'HTF Bear'),
      ].filter(Boolean),
      conf,
      hasFVG: !!overlappingFVG,
      hasLiquiditySweep: !!nearbySweep,
      hasBOS: !!(alignedStruct && alignedStruct.type === 'BOS'),
      hasCHoCH: !!(alignedStruct && alignedStruct.type === 'CHoCH'),
      hasTrend: trendAligned,
      htfBias: trend.bias,
    });
    if (sig) signals.push(sig);
  });

  // ── Liquidity Sweep signals ──
  smc.sweeps.slice(-3).forEach(sweep => {
    const bull = sweep.type === 'bullish_sweep';
    const distanceFromPrice = Math.abs(price - sweep.level) / sweep.level;
    if (distanceFromPrice > 0.01) return;

    let conf = 62;
    const nearbyOB = smc.obs.find(ob => ob.type === (bull ? 'bull' : 'bear') && Math.abs(ob.i - sweep.i) < 5);
    if (nearbyOB) conf += 14;

    let inDiscount = false, inPremium = false;
    if (zones) {
      const span = zones.rangeHigh - zones.rangeLow;
      if (span > 0) {
        inDiscount = sweep.level <= zones.equilibrium;
        inPremium = sweep.level >= zones.equilibrium;
        if (bull && inDiscount) conf += 8;
        if (!bull && inPremium) conf += 8;
      }
    }

    // Higher-timeframe trend alignment
    let trendAligned = false;
    if (trend.bias !== 'neutral') {
      if ((bull && trend.bias === 'bull') || (!bull && trend.bias === 'bear')) {
        conf += ENGINE.trendAlignBonus; trendAligned = true;
      } else {
        conf -= ENGINE.counterTrendPenalty;
      }
    }
    conf = clampConf(conf);

    const target = ENGINE.rrSweep;
    const wick = sweep.wick != null ? sweep.wick : sweep.level;
    let refs;
    if (bull) {
      const entryRaw = sweep.level;
      const slRaw = Math.min(wick, sweep.level) - buffer;
      const risk = entryRaw - slRaw;
      refs = { entryRaw, slRaw, tpRaw: entryRaw + target * risk };
    } else {
      const entryRaw = sweep.level;
      const slRaw = Math.max(wick, sweep.level) + buffer;
      const risk = slRaw - entryRaw;
      refs = { entryRaw, slRaw, tpRaw: entryRaw - target * risk };
    }

    const sig = mkSignal('SWP', sweep.time, bull ? 'BUY' : 'SELL', refs, {
      reason: 'Liquidity Sweep',
      confluence: [
        'Liquidity Sweep',
        nearbyOB && 'Order Block',
        bull && inDiscount ? 'Discount' : (!bull && inPremium ? 'Premium' : ''),
        trendAligned && (bull ? 'HTF Bull' : 'HTF Bear'),
      ].filter(Boolean),
      conf,
      hasFVG: false,
      hasLiquiditySweep: true,
      hasBOS: false,
      hasCHoCH: false,
      hasTrend: trendAligned,
      htfBias: trend.bias,
    });
    if (sig) signals.push(sig);
  });

  return signals.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Build signals across ALL markets (dashboard entry point).
 * @param {Object} candleMap     { [marketKey]: candles[] }
 * @param {Object} smcMap        { [marketKey]: smcResult }
 * @param {Object} marketsConfig MARKETS config object
 * @returns {Array} top signals (highest confidence first)
 */
export function buildSignals(candleMap, smcMap, marketsConfig) {
  const out = [];
  Object.keys(marketsConfig).forEach(market => {
    const candles = candleMap[market];
    const smc = smcMap[market];
    if (!candles || !smc) return;
    const cfg = marketsConfig[market];
    const sigs = buildSignalsForMarket(candles, smc, {
      symbol: market,
      dec: cfg.dec,
      pipSize: cfg.pipSize,
    });
    out.push(...sigs);
  });
  return out.sort((a, b) => b.confidence - a.confidence).slice(0, ENGINE.maxSignalsPerBuild);
}
