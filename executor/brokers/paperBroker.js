/* ═══════════════════════════════════════════════════════
   Paper broker — DEFAULT. Zero keys, zero risk. Uses the
   exchange's PUBLIC ccxt endpoints for real live prices and
   simulates fills against a virtual margin-style balance
   (long AND short allowed). Realized P&L is applied by the
   executor via applyRealized().
   ═══════════════════════════════════════════════════════ */
import ccxt from 'ccxt';
import { config } from '../config.js';

export function createPaperBroker() {
  const ex = new ccxt[config.exchangeId]({ enableRateLimit: true });
  let cash = config.paperStartBalance;
  let markets = {};

  return {
    name: `paper:${config.exchangeId}`,
    canShort: true,

    async init() {
      markets = await ex.loadMarkets();
      console.log(`[BROKER] PAPER on ${config.exchangeId} — ${Object.keys(markets).length} markets, start balance $${cash}`);
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

    async getCashBalance() { return cash; },
    applyRealized(amount) { cash += amount; },

    async marketOrder(symbol, side, qty) {
      const t = await this.getTicker(symbol);
      const px = side === 'buy' ? t.ask : t.bid;     // cross the spread, realistic fill
      const fee = qty * px * config.takerFee;
      cash -= fee;
      return { fillPrice: px, qty, fee, orderId: `paper-${Date.now()}` };
    },
  };
}
