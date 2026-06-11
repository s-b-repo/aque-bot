/* ═══════════════════════════════════════════════════════
   Executor configuration — env-driven, with the SAME
   defaults as the MetaTrader EAs (ported rule-for-rule).
   Crypto trades 24/7, so the session filter defaults OFF.
   ═══════════════════════════════════════════════════════ */

const num = (v, d) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const bool = (v, d) => (v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));
const str = (v, d) => (v == null || v === '' ? d : String(v));

const e = process.env;

export const config = {
  // ── Connection to the signal API ──
  apiUrl: str(e.API_URL, 'http://127.0.0.1:3001'),
  apiKey: str(e.NEXUS_API_TOKEN, ''),            // must match the server token if set
  pollSeconds: num(e.POLL_SECONDS, 3),
  manageSeconds: num(e.MANAGE_SECONDS, 2),       // how often open trades are managed
  useServerClaim: bool(e.USE_SERVER_CLAIM, true),

  // ── Broker ──
  broker: str(e.EXECUTOR_BROKER, 'paper').toLowerCase(),  // 'paper' | 'ccxt'
  live: bool(e.EXECUTOR_LIVE, false),            // ccxt: send REAL orders (else sandbox/testnet)
  exchangeId: str(e.EXCHANGE_ID, 'binance'),
  exchangeType: str(e.EXCHANGE_TYPE, 'spot').toLowerCase(),   // spot | swap | future
  exchangeKey: str(e.EXCHANGE_API_KEY, ''),
  exchangeSecret: str(e.EXCHANGE_API_SECRET, ''),
  exchangePassword: str(e.EXCHANGE_API_PASSWORD, ''),  // some exchanges require it
  quoteCurrency: str(e.QUOTE_CURRENCY, 'USDT'),
  paperStartBalance: num(e.PAPER_START_BALANCE, 10000),
  takerFee: num(e.TAKER_FEE, 0.0007),            // round-turn fee model for paper fills

  // ── Risk management (EA parity) ──
  riskPercent: num(e.RISK_PERCENT, 1.0),
  maxRiskPercentHard: num(e.MAX_RISK_PERCENT_HARD, 5.0),
  maxDailyLossPercent: num(e.MAX_DAILY_LOSS_PERCENT, 5.0),
  maxRiskDollars: num(e.MAX_RISK_DOLLARS, 20.0),         // 0 = disabled
  maxPositionPct: num(e.MAX_POSITION_PCT, 25.0),         // cap a single position's notional (% of equity)
  maxPortfolioRiskPct: num(e.MAX_PORTFOLIO_RISK_PCT, 3.0),
  maxOpenTrades: num(e.MAX_OPEN_TRADES, 3),
  maxTradesPerSymbol: num(e.MAX_TRADES_PER_SYMBOL, 1),
  maxTradesPerDay: num(e.MAX_TRADES_PER_DAY, 10),        // 0 = unlimited
  maxConsecutiveLosses: num(e.MAX_CONSECUTIVE_LOSSES, 4),// 0 = off
  equityGuardPct: num(e.EQUITY_GUARD_PCT, 0.85),
  minFreeMarginPct: num(e.MIN_FREE_MARGIN_PCT, 0.15),

  // ── Entry filters (EA parity) ──
  minConfidence: num(e.MIN_CONFIDENCE, 80),
  maxSpreadToSLRatio: num(e.MAX_SPREAD_TO_SL_RATIO, 0.20),
  maxEntryDeviation: num(e.MAX_ENTRY_DEVIATION, 15.0),   // % of SL distance
  maxPriceDivergencePct: num(e.MAX_PRICE_DIVERGENCE_PCT, 1.0),
  requireOBProximity: bool(e.REQUIRE_OB_PROXIMITY, true),
  obProximityPct: num(e.OB_PROXIMITY_PCT, 0.3),          // fraction of SL distance
  requireFVG: bool(e.REQUIRE_FVG, false),
  requireLiquiditySweep: bool(e.REQUIRE_LIQUIDITY_SWEEP, false),
  requireTrend: bool(e.REQUIRE_TREND, false),            // only with-trend setups
  dynamicRisk: bool(e.DYNAMIC_RISK, true),               // adaptive position sizing (see risk.js)

  sessionFilterEnabled: bool(e.SESSION_FILTER_ENABLED, false), // crypto is 24/7
  londonOpenHour: num(e.LONDON_OPEN_HOUR, 7),
  londonCloseHour: num(e.LONDON_CLOSE_HOUR, 16),
  newYorkOpenHour: num(e.NEW_YORK_OPEN_HOUR, 13),
  newYorkCloseHour: num(e.NEW_YORK_CLOSE_HOUR, 21),

  // ── Trade management (EA parity; trail expressed as % of price for crypto) ──
  useBreakEven: bool(e.USE_BREAK_EVEN, true),
  breakEvenTriggerR: num(e.BREAK_EVEN_TRIGGER_R, 1.0),
  breakEvenOffsetFrac: num(e.BREAK_EVEN_OFFSET_FRAC, 0.05), // of initial SL distance
  useTrailingStop: bool(e.USE_TRAILING_STOP, true),
  trailStartR: num(e.TRAIL_START_R, 1.5),
  trailDistancePct: num(e.TRAIL_DISTANCE_PCT, 0.5),         // % of price kept behind
  usePartialClose: bool(e.USE_PARTIAL_CLOSE, true),
  partialCloseR: num(e.PARTIAL_CLOSE_R, 1.0),
  partialClosePct: num(e.PARTIAL_CLOSE_PCT, 50.0),
  partialRequiresBE: bool(e.PARTIAL_REQUIRES_BE, true),

  // ── Identity / symbols ──
  magic: num(e.MAGIC, 20260515),
  // Signal symbol -> exchange symbol. Data-only markets (Nasdaq) are simply omitted.
  symbolMap: str(e.SYMBOL_MAP, 'BTCUSD=BTC/USDT,EURUSDT=EUR/USDT'),
  tradeEnabled: bool(e.TRADE_ENABLED, true),

  stateFile: str(e.EXECUTOR_STATE_FILE, 'executor_state.json'),
};

export function validateConfig() {
  const errs = [];
  if (config.riskPercent > config.maxRiskPercentHard)
    errs.push(`RISK_PERCENT ${config.riskPercent}% exceeds hard ceiling ${config.maxRiskPercentHard}%`);
  if (config.riskPercent <= 0) errs.push('RISK_PERCENT must be > 0');
  if (!['paper', 'ccxt'].includes(config.broker)) errs.push(`Unknown EXECUTOR_BROKER '${config.broker}'`);
  if (config.broker === 'ccxt' && config.live && (!config.exchangeKey || !config.exchangeSecret))
    errs.push('EXECUTOR_LIVE=true requires EXCHANGE_API_KEY and EXCHANGE_API_SECRET');
  return errs;
}
