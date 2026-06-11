/* ═══════════════════════════════════════════════════════
   CCXT broker — real exchange execution (MIT, 100+ venues).
   • EXECUTOR_LIVE=false (default) → exchange testnet/sandbox.
   • EXECUTOR_LIVE=true            → REAL orders, REAL money.
   Shorting requires a margin/derivatives account: set
   EXCHANGE_TYPE=swap (or future). On spot, SELL-to-open is
   skipped (canShort=false) — the executor will not short.
   ═══════════════════════════════════════════════════════ */
import ccxt from 'ccxt';
import { config } from '../config.js';

export function createCcxtBroker() {
  const exType = (config.exchangeType || 'spot').toLowerCase();
  const opts = {
    apiKey: config.exchangeKey,
    secret: config.exchangeSecret,
    enableRateLimit: true,
    options: { defaultType: exType },
  };
  if (config.exchangePassword) opts.password = config.exchangePassword;

  const ExchangeClass = ccxt[config.exchangeId];
  if (!ExchangeClass) throw new Error(`Unknown EXCHANGE_ID '${config.exchangeId}'`);
  const ex = new ExchangeClass(opts);

  if (!config.live) {
    try { ex.setSandboxMode(true); }
    catch { console.warn(`[BROKER] ${config.exchangeId} has no sandbox; running PAPER-style without keys is safer than live`); }
  }

  let markets = {};

  return {
    name: `ccxt:${config.exchangeId}:${exType}${config.live ? ' ⚠LIVE' : ' (sandbox)'}`,
    canShort: exType !== 'spot',

    async init() {
      markets = await ex.loadMarkets();
      if (config.live) console.warn('[BROKER] ⚠⚠ LIVE MODE — orders will use REAL funds on', config.exchangeId);
      console.log(`[BROKER] CCXT ${this.name} — ${Object.keys(markets).length} markets`);
    },

    market(symbol) {
      const m = markets[symbol];
      if (!m) return null;
      return { minQty: m.limits?.amount?.min ?? 0, minNotional: m.limits?.cost?.min ?? 0 };
    },

    roundQty(symbol, qty) {
      try { return Number(ex.amountToPrecision(symbol, qty)); } catch { return qty; }
    },
    roundPrice(symbol, price) {
      try { return Number(ex.priceToPrecision(symbol, price)); } catch { return price; }
    },

    async getTicker(symbol) {
      const t = await ex.fetchTicker(symbol);
      const last = t.last ?? t.close ?? t.ask ?? t.bid;
      return { bid: t.bid ?? last, ask: t.ask ?? last, last };
    },

    async getCashBalance() {
      const b = await ex.fetchBalance();
      const q = config.quoteCurrency;
      return Number(b.free?.[q] ?? b[q]?.free ?? b.total?.[q] ?? 0);
    },
    applyRealized() { /* the exchange already reflects realized P&L */ },

    async marketOrder(symbol, side, qty) {
      const o = await ex.createOrder(symbol, 'market', side, qty);
      let fill = o.average ?? o.price;
      if (!fill) { const t = await this.getTicker(symbol); fill = t.last; }
      const fee = o.fee?.cost != null ? Number(o.fee.cost) : qty * fill * config.takerFee;
      return { fillPrice: Number(fill), qty: Number(o.filled ?? qty), fee, orderId: String(o.id ?? '') };
    },
  };
}
