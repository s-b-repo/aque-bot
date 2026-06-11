/* Shared inline styles + brand for the auth/setup/settings screens (dark theme). */
export const BRAND = { lead: 'Aque', accent: ' Bot', full: 'Aque Bot' };
export const C = {
  bg: '#0f1117', card: '#161922', card2: '#1a1d27', border: '#2a2e3f',
  text: '#e1e4ea', muted: '#6b7084', accent: '#089981', danger: '#F23645', indigo: '#818cf8',
  mono: "'JetBrains Mono', 'Fira Code', monospace",
};

export const shell = {
  minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: `radial-gradient(1200px 600px at 50% -10%, #14202a, ${C.bg})`,
  fontFamily: C.mono, padding: 20,
};
export const card = {
  width: '100%', maxWidth: 420, background: C.card, border: `1px solid ${C.border}`,
  borderRadius: 14, padding: 28, boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
};
export const brand = { textAlign: 'center', marginBottom: 6, fontSize: 22, fontWeight: 800, color: C.text, letterSpacing: 0.5 };
export const sub = { textAlign: 'center', color: C.muted, fontSize: 12, marginBottom: 22 };
export const label = { display: 'block', fontSize: 11, color: C.muted, textTransform: 'uppercase', letterSpacing: 1, margin: '14px 0 6px' };
export const input = {
  width: '100%', boxSizing: 'border-box', background: C.card2, border: `1px solid ${C.border}`,
  borderRadius: 8, padding: '11px 12px', color: C.text, fontFamily: C.mono, fontSize: 13, outline: 'none',
};
export const button = (disabled) => ({
  width: '100%', marginTop: 20, padding: '12px', borderRadius: 8, border: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
  background: disabled ? '#114b41' : C.accent, color: '#fff', fontWeight: 700, fontSize: 14, fontFamily: C.mono,
  opacity: disabled ? 0.7 : 1, transition: 'background .15s',
});
export const errorBox = { background: 'rgba(242,54,69,0.12)', border: `1px solid ${C.danger}`, color: '#ff9aa6', borderRadius: 8, padding: '9px 12px', fontSize: 12, marginTop: 16 };
export const note = { color: C.muted, fontSize: 11, lineHeight: 1.6, marginTop: 14 };
