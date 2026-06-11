/* ═══════════════════════════════════════════════════════
   Signal Engine — compatibility shim.
   ─────────────────────────────────────────────────────
   Signal construction now lives in smcEngine.js so the
   dashboard and the Node API server share ONE implementation
   (audit SMC-03). This file keeps the historical import path
   (`buildSignals`) working and houses UI-only helpers.
   ═══════════════════════════════════════════════════════ */

import { COLORS } from '../config/marketConfig.js';

export { buildSignals, buildSignalsForMarket, getMarketBias } from './smcEngine.js';

/**
 * Get confidence color for a signal (dashboard only).
 */
export function getConfidenceColor(conf) {
  if (conf >= 80) return COLORS.bull;
  if (conf >= 65) return COLORS.fvg;
  return COLORS.bear;
}
