/* ═══════════════════════════════════════════════════════
   Executor configuration store (set via the dashboard GUI).
   Exchange key/secret/password are encrypted at rest with
   the install master key (serverlib/auth.js). The dashboard
   only ever sees masked booleans; the executor fetches the
   decrypted config over a machine-token-gated endpoint.
   ═══════════════════════════════════════════════════════ */
import fs from 'fs';
import path from 'path';
import { encryptSecret, decryptSecret } from './auth.js';

let FILE = '';
let cfg = null;

const SECRET_FIELDS = ['exchangeKey', 'exchangeSecret', 'exchangePassword'];
const NUM_FIELDS = ['riskPercent', 'maxRiskDollars', 'maxOpenTrades', 'maxTradesPerDay',
  'maxDailyLossPercent', 'maxConsecutiveLosses', 'maxPortfolioRiskPct', 'minConfidence'];
const BOOL_FIELDS = ['live', 'requireTrend', 'requireFVG', 'requireLiquiditySweep', 'dynamicRisk', 'tradeEnabled'];
const MASK = '********';

// Coerce + clamp numerics so a cleared GUI field or a bad API client can't inject
// NaN / 0 into the risk math or gates (audit CFG-01).
function clampNum(k, n) {
  if (k === 'minConfidence') return Math.max(1, Math.min(99, n));
  if (k === 'maxOpenTrades') return Math.max(1, Math.round(n));
  if (k === 'riskPercent') return Math.max(0.01, n);
  if (k === 'maxTradesPerDay' || k === 'maxConsecutiveLosses') return Math.max(0, Math.round(n)); // 0 = unlimited/off
  return Math.max(0, n);
}

const defaults = () => ({
  broker: 'paper',
  live: false,
  exchangeId: 'binance',
  exchangeType: 'spot',
  quoteCurrency: 'USDT',
  exchangeKey: '', exchangeSecret: '', exchangePassword: '',   // stored encrypted (blob) or ''
  riskPercent: 1, maxRiskDollars: 20, maxOpenTrades: 3, maxTradesPerDay: 10,
  maxDailyLossPercent: 5, maxConsecutiveLosses: 4, maxPortfolioRiskPct: 3,
  minConfidence: 80, requireTrend: false, requireFVG: false, requireLiquiditySweep: false,
  dynamicRisk: true, tradeEnabled: true,
  symbolMap: 'BTCUSD=BTC/USDT,EURUSDT=EUR/USDT',
  updatedAt: 0,
});

export function initConfig(dataDir) {
  FILE = path.join(dataDir, 'config.json');
  try {
    if (fs.existsSync(FILE)) cfg = { ...defaults(), ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
  } catch (err) { console.error('[CONFIG] config.json unreadable:', err.message); }
  if (!cfg) cfg = defaults();
}

function save() {
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, FILE);
  try { fs.chmodSync(FILE, 0o600); } catch { /* best effort */ }
}

/** Merge a patch from the GUI. Secret fields: blank/masked = keep existing; new value = encrypt. */
export function saveConfig(patch = {}) {
  const next = { ...cfg };
  for (const [k, v] of Object.entries(patch)) {
    if (SECRET_FIELDS.includes(k)) {
      if (v == null || v === '' || v === MASK) continue;        // unchanged
      next[k] = encryptSecret(String(v));                       // store encrypted blob
    } else if (NUM_FIELDS.includes(k)) {
      const n = Number(v);
      if (v !== '' && Number.isFinite(n)) next[k] = clampNum(k, n);  // else keep prior (skip)
    } else if (BOOL_FIELDS.includes(k)) {
      next[k] = (v === true || v === 'true' || v === 1 || v === '1');
    } else if (k in defaults()) {
      next[k] = v;
    }
  }
  next.updatedAt = Date.now();
  cfg = next;
  save();
  return publicConfig();
}

/** Dashboard-safe view: secrets replaced by has* booleans, never plaintext. */
export function publicConfig() {
  const out = { ...cfg };
  for (const f of SECRET_FIELDS) {
    out[`has${f[0].toUpperCase()}${f.slice(1)}`] = !!cfg[f];
    delete out[f];
  }
  return out;
}

/** Executor-facing view: secrets DECRYPTED. Only served over the machine-token gate. */
export function executorConfig() {
  const out = { ...cfg };
  for (const f of SECRET_FIELDS) out[f] = decryptSecret(cfg[f]);
  return out;
}

export function rawConfig() { return cfg; }
