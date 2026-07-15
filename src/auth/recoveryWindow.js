'use strict';
// Access Control V2 — Block B5: recovery/bootstrap WINDOW DESCRIPTOR + secret +
// API-key validation. Pure node:crypto. No DB, no HTTP, no Express, no wiring.
// NEVER logs, NEVER prints, NEVER returns a plaintext secret/PIN. The window
// descriptor carries only the secret DIGEST, never the plaintext. Env and clock
// are injected for full offline testing.

const crypto = require('crypto');

// Canonical operational actors (mirrors B0 auth_actors CHECK).
const CANONICAL_ACTORS = Object.freeze(new Set(['owner', 'operator_primary', 'operator_backup', 'rider']));

const MAX_LIFETIME_MS = 15 * 60 * 1000; // hard 15-minute ceiling

const HEADERS = Object.freeze({
  apiKey: 'x-api-key',
  bootstrap: 'x-auth-bootstrap-secret',
  recovery: 'x-auth-recovery-secret',
});

// Exact env variable names per window kind.
const ENV_VARS = Object.freeze({
  bootstrap: {
    id: 'AUTH_BOOTSTRAP_WINDOW_ID',
    actor: 'AUTH_BOOTSTRAP_WINDOW_ACTOR',
    expiresAt: 'AUTH_BOOTSTRAP_WINDOW_EXPIRES_AT',
    secret: 'AUTH_BOOTSTRAP_WINDOW_SECRET_B64URL',
  },
  recovery: {
    id: 'AUTH_RECOVERY_WINDOW_ID',
    actor: 'AUTH_RECOVERY_WINDOW_ACTOR',
    expiresAt: 'AUTH_RECOVERY_WINDOW_EXPIRES_AT',
    secret: 'AUTH_RECOVERY_WINDOW_SECRET_B64URL',
  },
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// ISO-8601 with an explicit timezone (Z or ±hh:mm) — no naive/local timestamps.
const ISO_TZ_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

// Strict canonical base64url → Buffer, or null. Rejects padding, +,/, non-canonical.
function b64urlDecodeStrict(s) {
  if (typeof s !== 'string' || s.length === 0) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  const buf = Buffer.from(s, 'base64url');
  if (buf.length === 0 || buf.toString('base64url') !== s) return null;
  return buf;
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Constant-time string compare (length-safe: hash both to a fixed 32 bytes first).
function constantTimeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Constant-time compare of two equal-form hex digests.
function constantTimeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  if (!/^[0-9a-f]+$/.test(a) || !/^[0-9a-f]+$/.test(b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

// Parse a window secret string → { ok, digest } (≥32 random bytes, canonical b64url).
function parseWindowSecret(secretStr) {
  const buf = b64urlDecodeStrict(secretStr);
  if (!buf || buf.length < 32) return { ok: false };
  return { ok: true, digest: sha256Hex(buf) };
}

// Load + validate the environment descriptor for a window kind. Fail-closed:
// returns { ok:false } for any missing/partial/malformed/expired/over-lifetime
// descriptor. Never returns the plaintext secret — only its digest.
function loadWindowDescriptor({ purpose, env = process.env, now = Date.now } = {}) {
  if (purpose !== 'bootstrap' && purpose !== 'recovery') return { ok: false };
  const names = ENV_VARS[purpose];
  const id = env[names.id];
  const actor = env[names.actor];
  const expiresAt = env[names.expiresAt];
  const secret = env[names.secret];

  // all four required — no partial descriptor
  if (![id, actor, expiresAt, secret].every((v) => typeof v === 'string' && v.length > 0)) return { ok: false };

  if (!UUID_RE.test(id)) return { ok: false };
  if (!CANONICAL_ACTORS.has(actor)) return { ok: false };
  if (!ISO_TZ_RE.test(expiresAt)) return { ok: false };

  const expMs = Date.parse(expiresAt);
  if (!Number.isFinite(expMs)) return { ok: false };
  const nowMs = now();
  if (expMs <= nowMs) return { ok: false };                 // already expired
  if (expMs - nowMs > MAX_LIFETIME_MS) return { ok: false }; // over the 15-minute ceiling

  const sec = parseWindowSecret(secret);
  if (!sec.ok) return { ok: false };

  return {
    ok: true,
    descriptor: Object.freeze({
      windowId: id,
      purpose,
      actor,
      expiresAt,       // ISO string (absolute, tz-qualified)
      expiresAtMs: expMs,
      secretDigest: sec.digest, // sha256 hex; plaintext discarded
    }),
  };
}

// Validate the backend-direct X-Api-Key against the existing DASHBOARD_API_KEY
// env (constant-time; fail-closed when unconfigured). Does not reveal which
// credential was wrong.
function validateApiKey(presented, env = process.env) {
  const configured = env.DASHBOARD_API_KEY;
  if (typeof configured !== 'string' || configured.length === 0) return false; // fail closed
  if (typeof presented !== 'string' || presented.length === 0) return false;
  return constantTimeEqualStr(presented, configured);
}

// Return a single header value or null. Rejects arrays (ambiguous duplicates)
// and non-strings/empties.
function singleHeaderValue(v) {
  if (Array.isArray(v)) return null;              // duplicated/ambiguous
  if (typeof v !== 'string' || v.length === 0) return null;
  return v;
}

// Validate the presented dedicated secret header against the descriptor digest.
// The header name is purpose-specific, so a bootstrap secret cannot open a
// recovery window (and vice-versa) even before the digest check.
function verifyPresentedSecret(presentedSecret, descriptor) {
  if (!descriptor || typeof descriptor.secretDigest !== 'string') return false;
  const parsed = parseWindowSecret(presentedSecret);
  if (!parsed.ok) return false;
  return constantTimeEqualHex(parsed.digest, descriptor.secretDigest);
}

module.exports = {
  CANONICAL_ACTORS, MAX_LIFETIME_MS, HEADERS, ENV_VARS,
  b64urlDecodeStrict, sha256Hex, constantTimeEqualStr, constantTimeEqualHex,
  parseWindowSecret, loadWindowDescriptor, validateApiKey, singleHeaderValue, verifyPresentedSecret,
};
