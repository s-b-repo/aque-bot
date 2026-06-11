/* ═══════════════════════════════════════════════════════
   Remote config — pulls the executor's settings from the
   server (configured via the dashboard GUI) and merges them
   over the env defaults. Risk/filter params update LIVE;
   broker/exchange/keys changes require an executor restart
   (logged when detected).
   ═══════════════════════════════════════════════════════ */
import { config } from './config.js';
import { setSymbolMap } from './symbols.js';

const LIVE_TUNABLE = [
  'riskPercent', 'maxRiskDollars', 'maxOpenTrades', 'maxTradesPerDay',
  'maxDailyLossPercent', 'maxConsecutiveLosses', 'maxPortfolioRiskPct',
  'minConfidence', 'requireTrend', 'requireFVG', 'requireLiquiditySweep',
  'dynamicRisk', 'tradeEnabled',
];
const RESTART_FIELDS = [
  'broker', 'live', 'exchangeId', 'exchangeType', 'quoteCurrency',
  'exchangeKey', 'exchangeSecret', 'exchangePassword',
];

export async function fetchRemoteConfig() {
  try {
    const headers = config.apiKey ? { 'X-API-Key': config.apiKey } : {};
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(config.apiUrl + '/api/executor-config', { headers, signal: ctrl.signal });
    clearTimeout(to);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

/**
 * Merge a remote config object onto `config`.
 * @returns {string[]} restart-required fields that changed (only checked when !startup)
 */
// Coerce a remote value to match the type of the existing config default.
function coerce(k, v) {
  if (typeof config[k] === 'number') { const n = Number(v); return Number.isFinite(n) ? n : undefined; }
  if (typeof config[k] === 'boolean') return (v === true || v === 'true' || v === 1 || v === '1');
  return v;
}

export function applyRemote(remote, { startup = false } = {}) {
  if (!remote || typeof remote !== 'object') return [];
  for (const k of LIVE_TUNABLE) {
    if (remote[k] === undefined || remote[k] === null) continue;
    const c = coerce(k, remote[k]);
    if (c !== undefined) config[k] = c;                 // skip non-finite numerics (keep prior)
  }
  if (remote.symbolMap) { config.symbolMap = remote.symbolMap; setSymbolMap(remote.symbolMap); }

  const changed = [];
  for (const k of RESTART_FIELDS) {
    const v = remote[k];
    if (v === undefined || v === null || v === '') continue;     // blank secret → keep existing
    if (startup) config[k] = v;
    else if (String(v) !== String(config[k])) changed.push(k);
  }
  return changed;
}
