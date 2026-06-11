/* ═══════════════════════════════════════════════════════
   Durable executor state — atomic JSON file (no DB needed).
   Holds the sticky daily kill-switch state, the executed-id
   dedup set, and the open-trade registry — so a restart
   resumes safely instead of re-firing or losing positions.
   ═══════════════════════════════════════════════════════ */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.isAbsolute(config.stateFile)
  ? config.stateFile
  : path.join(__dirname, '..', config.stateFile);

const EXEC_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

const empty = () => ({
  day: { key: 0, startEquity: 0, tradesToday: 0, consec: 0, halt: false },
  peakEquity: 0,       // high-water mark for drawdown-aware dynamic risk
  executed: {},        // signalId -> ts
  openTrades: [],      // active managed trades
  closeSeq: 0,         // monotonic id source for close dealIds
});

let state = empty();

export function loadState() {
  try {
    if (fs.existsSync(FILE)) {
      const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      state = { ...empty(), ...data };
      if (!state.day) state.day = empty().day;
      if (!state.executed) state.executed = {};
      if (!Array.isArray(state.openTrades)) state.openTrades = [];
      // prune stale executed ids
      const cutoff = Date.now() - EXEC_MAX_AGE_MS;
      for (const [id, ts] of Object.entries(state.executed)) if (ts < cutoff) delete state.executed[id];
      console.log(`[STATE] loaded — ${state.openTrades.length} open, ${Object.keys(state.executed).length} executed ids`);
    }
  } catch (err) {
    console.error('[STATE] unreadable; backing up and starting fresh:', err.message);
    try { fs.renameSync(FILE, `${FILE}.corrupt-${Date.now()}`); } catch { /* noop */ }
    state = empty();
  }
  return state;
}

let writeTimer = null;
function flush() {
  writeTimer = null;
  try {
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, FILE);
  } catch (err) {
    console.error('[STATE] save failed:', err.message);
  }
}
export function saveState({ immediate = false } = {}) {
  if (immediate) { if (writeTimer) clearTimeout(writeTimer); flush(); return; }
  if (writeTimer) return;
  writeTimer = setTimeout(flush, 1000);
}

export function getState() { return state; }

export function isExecuted(id) { return !!state.executed[id]; }
export function markExecuted(id) {
  if (!id) return;
  state.executed[id] = Date.now();
  saveState({ immediate: true });
}

export function nextCloseSeq() {
  state.closeSeq = (state.closeSeq || 0) + 1;
  return state.closeSeq;
}
