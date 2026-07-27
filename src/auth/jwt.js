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

// ── S2-7D6E4 — step-up PIN-management proof ─────────────────────────────────
// A SEPARATE, narrowly-scoped signed artifact — never a session token. Distinct `v`
// marker (STEP_UP_VERSION, not 2) so verifyToken() rejects it outright as a Bearer
// session, and verifyStepUpProof() below rejects any normal session token in turn:
// the two token kinds can never be substituted for each other.
const STEP_UP_TTL_SECONDS = 600; // hard cap, 10 minutes — never derived from caller input
const STEP_UP_PURPOSE = 'manage_pins';
const STEP_UP_VERSION = 'su1';

// hashBearerToken(token) -> sha256 hex digest, or null. Binds a step-up proof to the exact
// session (the literal current Bearer) that requested it. The raw token is never returned,
// logged, or persisted — only this one-way digest travels inside the signed proof.
function hashBearerToken(token) {
  if (typeof token !== 'string' || token.length === 0) return null;
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

// signStepUpProof({actor, role, sv, sessionHash}) -> proof string, or null.
function signStepUpProof({ actor, role, sv, sessionHash } = {}) {
  if (!isReady()) return null;
  if (!roleSubValid(role, actor)) return null;
  if (!Number.isInteger(sv) || sv < 1) return null;
  if (typeof sessionHash !== 'string' || sessionHash.length === 0) return null;
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + STEP_UP_TTL_SECONDS;
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    v: STEP_UP_VERSION, purpose: STEP_UP_PURPOSE,
    sub: actor, role, sv, sh: sessionHash, iat, exp,
  }));
  const sig = hmac(header + '.' + payload);
  return header + '.' + payload + '.' + sig;
}

// verifyStepUpProof(token, {sessionHash}) -> payload object or null. NEVER throws.
// `sessionHash` MUST be derived by the caller from the CURRENT request's own Bearer — this
// is what makes a proof minted in one session unusable from a different session, even for
// the same actor at the same session_version.
function verifyStepUpProof(token, { sessionHash } = {}) {
  try {
    if (!isReady() || typeof token !== 'string') return null;
    if (typeof sessionHash !== 'string' || sessionHash.length === 0) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [h, p, s] = parts;
    if (!b64urlDecodeStrict(h) || !b64urlDecodeStrict(p) || !b64urlDecodeStrict(s)) return null;

    const expected = hmac(h + '.' + p);
    const a = Buffer.from(s), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    const header = JSON.parse(Buffer.from(h, 'base64url').toString());
    if (header.alg !== 'HS256' || header.typ !== 'JWT') return null;

    const pl = JSON.parse(Buffer.from(p, 'base64url').toString());
    if (pl.v !== STEP_UP_VERSION) return null;
    if (pl.purpose !== STEP_UP_PURPOSE) return null;
    if (!roleSubValid(pl.role, pl.sub)) return null;
    if (!Number.isInteger(pl.sv) || pl.sv < 1) return null;
    if (typeof pl.sh !== 'string' || pl.sh.length === 0) return null;
    if (!Number.isInteger(pl.iat) || !Number.isInteger(pl.exp)) return null;
    if (pl.exp <= pl.iat) return null;
    if ((pl.exp - pl.iat) > STEP_UP_TTL_SECONDS + SKEW_SEC) return null;
    const now = Math.floor(Date.now() / 1000);
    if (pl.iat > now + SKEW_SEC) return null;
    if (now >= pl.exp + SKEW_SEC) return null;

    // session binding — timing-safe compare, same discipline as the signature check above.
    const shA = Buffer.from(String(pl.sh));
    const shB = Buffer.from(sessionHash);
    if (shA.length !== shB.length || !crypto.timingSafeEqual(shA, shB)) return null;

    return pl;
  } catch (_) {
    return null;
  }
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

module.exports = {
  signToken, verifyToken, expiresInFor, isReady, TTL_SECONDS, ROLE_SUB, SKEW_SEC,
  hashBearerToken, signStepUpProof, verifyStepUpProof, STEP_UP_TTL_SECONDS, STEP_UP_PURPOSE,
};
