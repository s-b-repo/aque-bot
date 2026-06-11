/* ═══════════════════════════════════════════════════════
   Dashboard auth + config client. Stores the session token
   in localStorage and attaches it to protected calls.
   ═══════════════════════════════════════════════════════ */

export const API_BASE = (import.meta.env && import.meta.env.VITE_API_URL) || 'http://127.0.0.1:3001';
const TOKEN_KEY = 'nexus_session';

export function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } }
export function setToken(t) {
  try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
}
export function logout() { setToken(''); }

async function req(path, { method = 'GET', body, auth = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) headers['X-Session-Token'] = getToken();
  const res = await fetch(API_BASE + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* non-json */ }
  if (!res.ok) {
    const err = new Error((json && json.error) || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

export const getSetupStatus = () => req('/api/setup/status');
export const me = () => req('/api/auth/me', { auth: true });
export const login = (username, password) =>
  req('/api/login', { method: 'POST', body: { username, password } });
export const setup = (username, password, config) =>
  req('/api/setup', { method: 'POST', body: { username, password, config } });
export const getConfig = () => req('/api/config', { auth: true });
export const saveConfig = (patch) => req('/api/config', { method: 'POST', body: patch, auth: true });
export const changePassword = async (oldPassword, newPassword) => {
  const r = await req('/api/auth/change-password', { method: 'POST', body: { oldPassword, newPassword }, auth: true });
  if (r && r.token) setToken(r.token);   // session secret rotated → adopt the fresh token
  return r;
};
