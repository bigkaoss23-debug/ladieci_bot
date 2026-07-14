'use strict';
// Access Control V2 — Block B3: strict HS256 JWT v2. node:crypto only.
// Secret comes from AUTH_JWT_SECRET_B64URL (base64url canonical, no padding,
// ≥32 real bytes). Fail-closed: missing/invalid secret → not ready → sign/verify
// return null. Never logs, never prints the secret.

const crypto = require('crypto');

const SKEW_SEC = 30;
const TTL_SECONDS = Object.freeze({ admin: 4 * 3600, operator: 10 * 3600, rider: 12 * 3600 });
// Allowed role→sub pairs (exact).
const ROLE_SUB = Object.freeze({
  admin: new Set(['owner']),
  operator: new Set(['operator_primary', 'operator_backup']),
  rider: new Set(['rider']),
});

// Strict base64url: alphabet-only, canonical round-trip. Returns Buffer or null.
function b64urlDecodeStrict(s) {
  if (typeof s !== 'string' || s.length === 0) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  const buf = Buffer.from(s, 'base64url');
  if (buf.length === 0) return null;
  if (buf.toString('base64url') !== s) return null; // canonical
  return buf;
}
function b64url(buf) { return Buffer.from(buf).toString('base64url'); }

// Load + validate the signing secret at module init (fail-closed).
function loadSecret() {
  const raw = process.env.AUTH_JWT_SECRET_B64URL;
  const buf = b64urlDecodeStrict(raw || '');
  if (!buf || buf.length < 32) return null;
  return buf;
}
const SECRET = loadSecret();
function isReady() { return SECRET !== null; }

function roleSubValid(role, sub) {
  return !!(ROLE_SUB[role] && ROLE_SUB[role].has(sub));
}
function expiresInFor(role) {
  const s = TTL_SECONDS[role];
  return s ? `${s / 3600}h` : null;
}

function hmac(data) {
  return crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
}

// signToken({role, sub, sv}) → token string, or null on invalid input / not ready.
function signToken({ role, sub, sv } = {}) {
  if (!isReady()) return null;
  if (!roleSubValid(role, sub)) return null;
  if (!Number.isInteger(sv) || sv < 1) return null;
  const ttl = TTL_SECONDS[role];
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + ttl;
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ role, sub, iat, exp, sv, v: 2 }));
  const sig = hmac(header + '.' + payload);
  return header + '.' + payload + '.' + sig;
}

// verifyToken(token) → payload object or null. NEVER throws.
function verifyToken(token) {
  try {
    if (!isReady() || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [h, p, s] = parts;
    if (!b64urlDecodeStrict(h) || !b64urlDecodeStrict(p) || !b64urlDecodeStrict(s)) return null;

    // signature (timing-safe, equal length guaranteed by same hmac output)
    const expected = hmac(h + '.' + p);
    const a = Buffer.from(s), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    const header = JSON.parse(Buffer.from(h, 'base64url').toString());
    if (header.alg !== 'HS256' || header.typ !== 'JWT') return null;

    const pl = JSON.parse(Buffer.from(p, 'base64url').toString());
    if (pl.v !== 2) return null;
    if (!roleSubValid(pl.role, pl.sub)) return null;
    if (!Number.isInteger(pl.sv) || pl.sv < 1) return null;
    if (!Number.isInteger(pl.iat) || !Number.isInteger(pl.exp)) return null;
    if (pl.exp <= pl.iat) return null;
    const ttl = TTL_SECONDS[pl.role];
    if ((pl.exp - pl.iat) > ttl + SKEW_SEC) return null;          // TTL not above role TTL
    const now = Math.floor(Date.now() / 1000);
    if (pl.iat > now + SKEW_SEC) return null;                     // iat not in the future
    if (now >= pl.exp + SKEW_SEC) return null;                    // expired (with skew)
    return pl;
  } catch (_) {
    return null;
  }
}

module.exports = { signToken, verifyToken, expiresInFor, isReady, TTL_SECONDS, ROLE_SUB, SKEW_SEC };
