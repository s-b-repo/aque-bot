/* ═══════════════════════════════════════════════════════
   Settings persistence (localStorage)
   ─────────────────────────────────────────────────────
   Kept separate from the SettingsPanel component so the
   panel file only exports a component (Fast Refresh safe).
   ═══════════════════════════════════════════════════════ */

const STORAGE_KEY = 'nexus_smc_settings';

export const DEFAULT_SETTINGS = {
  finnhubApiKey: '',
  notifications: true,
  defaultTimeframe: '5m',
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch { /* corrupt/unavailable storage — fall back to defaults */ }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch { /* storage unavailable (private mode/quota) — ignore */ }
}
