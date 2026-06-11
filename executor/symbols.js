/* Signal symbol ↔ exchange symbol mapping (e.g. BTCUSD ↔ BTC/USDT). */
import { config } from './config.js';

function parseMap(spec) {
  const fwd = new Map(), rev = new Map();
  for (const pair of String(spec).split(',')) {
    const [k, v] = pair.split('=').map(s => (s || '').trim());
    if (k && v) { fwd.set(k, v); rev.set(v, k); }
  }
  return { fwd, rev };
}

let fwd = new Map(), rev = new Map();

/** (Re)build the symbol map — called on boot and when the GUI changes it. */
export function setSymbolMap(spec) {
  const p = parseMap(spec);
  fwd = p.fwd; rev = p.rev;
}
setSymbolMap(config.symbolMap);

/** Signal symbol (BTCUSD) → exchange symbol (BTC/USDT), or null if untradeable here. */
export function toExchangeSymbol(signalSymbol) {
  return fwd.get(signalSymbol) || null;
}

/** Exchange symbol (BTC/USDT) → signal symbol (BTCUSD). */
export function toSignalSymbol(exchangeSymbol) {
  return rev.get(exchangeSymbol) || exchangeSymbol;
}

export function isTradeable(signalSymbol) {
  return fwd.has(signalSymbol);
}
