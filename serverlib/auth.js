/* ═══════════════════════════════════════════════════════
   Authentication — single admin user, scrypt-hashed
   password, HMAC-signed session tokens, and a per-install
   master key used to encrypt exchange secrets at rest.
   No external deps (Node crypto only).
   ═══════════════════════════════════════════════════════ */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

let FILE = '';
let store = null;   // { username, salt, hash, sessionSecret, masterKey, createdAt }

const b64url = buf => Buffer.from(buf).toString('base64url');

export function initAuth(dataDir) {
  FILE = path.join(dataDir, 'auth.json');
  try {
    if (fs.existsSync(FILE)) store = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (err) {
    console.error('[AUTH] auth.json unreadable:', err.message);
    store = null;
  }
}

function save() {
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, FILE);
  try { fs.chmodSync(FILE, 0o600); } catch { /* best effort */ }
}

export function needsSetup() { return !store || !store.username; }

export function createUser(username, password) {
  if (!needsSetup()) throw new Error('already configured');
  if (!username || String(username).length < 3) throw new Error('username too short (min 3)');
  if (!password || String(password).length < 8) throw new Error('password too short (min 8)');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  store = {
    username: String(username),
    salt, hash,
    sessionSecret: crypto.randomBytes(32).toString('hex'),
    masterKey: crypto.randomBytes(32).toString('hex'),   // fallback when MASTER_KEY env unset
    masterSalt: crypto.randomBytes(16).toString('hex'),  // salt for MASTER_KEY derivation
    createdAt: Date.now(),
  };
  save();
}

export function verifyPassword(username, password) {
  if (needsSetup()) return false;
  if (String(username) !== store.username) return false;
  const hash = crypto.scryptSync(String(password), store.salt, 64);
  const stored = Buffer.from(store.hash, 'hex');
  return hash.length === stored.length && crypto.timingSafeEqual(hash, stored);
}

export function changePassword(oldPassword, newPassword) {
  if (!verifyPassword(store.username, oldPassword)) throw new Error('current password incorrect');
  if (!newPassword || String(newPassword).length < 8) throw new Error('password too short (min 8)');
  store.salt = crypto.randomBytes(16).toString('hex');
  store.hash = crypto.scryptSync(String(newPassword), store.salt, 64).toString('hex');
  store.sessionSecret = crypto.randomBytes(32).toString('hex'); // invalidate ALL existing sessions
  save();
}

/* ── Sessions: token = base64url(payload).base64url(hmac) ── */
export function issueSession(ttlMs = 7 * 24 * 3600 * 1000) {
  const payload = b64url(JSON.stringify({ u: store.username, exp: Date.now() + ttlMs }));
  const sig = b64url(crypto.createHmac('sha256', store.sessionSecret).update(payload).digest());
  return `${payload}.${sig}`;
}

export function verifySession(token) {
  if (!token || needsSetup()) return false;
  const [payload, sig] = String(token).split('.');
  if (!payload || !sig) return false;
  const expected = b64url(crypto.createHmac('sha256', store.sessionSecret).update(payload).digest());
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof exp === 'number' && exp > Date.now();
  } catch { return false; }
}

export function getUsername() { return store ? store.username : null; }

/* ── Secret encryption at rest (AES-256-GCM) ──
   If MASTER_KEY env is set, the AES key is DERIVED from it (scrypt) and is never
   written to disk — so the data volume alone cannot decrypt the secrets. Otherwise
   it falls back to the stored random key (convenient, but weaker: anyone who can
   read the data dir gets both key and ciphertext). ── */
function key() {
  if (process.env.MASTER_KEY && store.masterSalt) {
    return crypto.scryptSync(String(process.env.MASTER_KEY), store.masterSalt, 32);
  }
  return Buffer.from(store.masterKey, 'hex');
}

export function encryptSecret(plaintext) {
  if (!plaintext) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decryptSecret(blob) {
  if (!blob || typeof blob !== 'string' || !blob.startsWith('v1:')) return '';
  try {
    const [, ivB, tagB, dataB] = blob.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB, 'base64')), decipher.final()]).toString('utf8');
  } catch (err) {
    console.error('[AUTH] secret decrypt failed:', err.message);
    return '';
  }
}
