'use strict';
// S2-7C — Supabase ACCOUNT access-token verification (separate from Auth V2 / PIN JWT).
//
// Verifies a Supabase GoTrue access token canonically: ES256 signature against the
// project JWKS (asymmetric — the backend never holds a signing secret), issuer,
// audience, and expiry. Returns the verified claims or throws a generic error. This
// module NEVER logs, NEVER reconstructs claims from the request body, and NEVER accepts
// a caller-declared user_id / email / workspace as truth. It is NOT the Auth V2 PIN JWT
// verifier and must never be used to authorize PIN/operational actions.

const crypto = require('crypto');

const AUD = 'authenticated';                 // Supabase user access-token audience
const CLOCK_SKEW_SEC = 60;

class AccountTokenError extends Error {
  constructor(code) { super(code); this.name = 'AccountTokenError'; this.code = code; }
}

function b64urlToBuf(s) { return Buffer.from(s, 'base64url'); }
function b64urlJson(s) { return JSON.parse(b64urlToBuf(s).toString('utf8')); }

// Convert a JWKS EC key (kty=EC, crv=P-256) into a node public key.
function publicKeyFromJwk(jwk) {
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256') throw new AccountTokenError('UNSUPPORTED_KEY');
  return crypto.createPublicKey({ key: jwk, format: 'jwk' });
}

// deps: { jwksProvider: async () => ({keys:[...]}), issuer: string, now?: ()=>Date }
function createSupabaseTokenVerifier(deps) {
  const jwksProvider = deps.jwksProvider;
  const issuer = deps.issuer;                // exact expected iss, e.g. `${SUPABASE_URL}/auth/v1`
  const now = deps.now || (() => new Date());
  if (typeof jwksProvider !== 'function' || !issuer) {
    throw new Error('createSupabaseTokenVerifier: jwksProvider and issuer required');
  }

  return async function verifyAccountToken(bearer) {
    // 1) shape
    if (typeof bearer !== 'string' || bearer.length === 0) throw new AccountTokenError('MISSING_TOKEN');
    const parts = bearer.split('.');
    if (parts.length !== 3) throw new AccountTokenError('MALFORMED_TOKEN');
    const [h64, p64, s64] = parts;

    let header, payload;
    try { header = b64urlJson(h64); payload = b64urlJson(p64); }
    catch (_) { throw new AccountTokenError('MALFORMED_TOKEN'); }

    // 2) algorithm — ES256 only (asymmetric). Reject HS*/none to avoid confusion attacks.
    if (header.alg !== 'ES256' || header.typ && header.typ !== 'JWT') throw new AccountTokenError('BAD_ALG');
    if (!header.kid) throw new AccountTokenError('NO_KID');

    // 3) resolve the signing key from JWKS by kid
    let jwks;
    try { jwks = await jwksProvider(); } catch (_) { throw new AccountTokenError('JWKS_UNAVAILABLE'); }
    const jwk = (jwks && Array.isArray(jwks.keys) ? jwks.keys : []).find(k => k.kid === header.kid);
    if (!jwk) throw new AccountTokenError('UNKNOWN_KID');

    // 4) signature (ES256 = raw R||S, i.e. ieee-p1363)
    let pub;
    try { pub = publicKeyFromJwk(jwk); } catch (_) { throw new AccountTokenError('UNSUPPORTED_KEY'); }
    const signingInput = Buffer.from(`${h64}.${p64}`);
    const sig = b64urlToBuf(s64);
    let ok = false;
    try { ok = crypto.verify('sha256', signingInput, { key: pub, dsaEncoding: 'ieee-p1363' }, sig); }
    catch (_) { ok = false; }
    if (!ok) throw new AccountTokenError('BAD_SIGNATURE');

    // 5) issuer (exact)
    if (payload.iss !== issuer) throw new AccountTokenError('BAD_ISSUER');

    // 6) audience (string or array must contain 'authenticated')
    const aud = payload.aud;
    const audOk = aud === AUD || (Array.isArray(aud) && aud.includes(AUD));
    if (!audOk) throw new AccountTokenError('BAD_AUDIENCE');

    // 7) expiry / not-before with small skew
    const nowSec = Math.floor(now().getTime() / 1000);
    if (!Number.isFinite(payload.exp) || nowSec > payload.exp + CLOCK_SKEW_SEC) throw new AccountTokenError('EXPIRED');
    if (Number.isFinite(payload.nbf) && nowSec + CLOCK_SKEW_SEC < payload.nbf) throw new AccountTokenError('NOT_YET_VALID');

    // 8) subject
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) throw new AccountTokenError('NO_SUBJECT');

    return Object.freeze({
      sub: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : null,
      emailVerified: emailVerifiedFrom(payload),
      role: typeof payload.role === 'string' ? payload.role : null,
      sessionId: typeof payload.session_id === 'string' ? payload.session_id : null,
    });
  };
}

// Supabase sets email_confirmed_at at signup-confirmation; the access token exposes it as
// user_metadata / top-level depending on version. Treat email as verified only on an
// explicit truthy signal, never by default.
function emailVerifiedFrom(payload) {
  if (payload.email_verified === true) return true;
  const amd = payload.user_metadata || payload.app_metadata || {};
  if (amd && (amd.email_verified === true)) return true;
  return false;
}

// Cached JWKS fetcher for the live app (TTL cache; refetch on unknown kid handled by caller
// via a short TTL). Never logs; returns the parsed JWKS object.
function createHttpJwksProvider({ jwksUrl, ttlMs = 10 * 60 * 1000, fetchImpl = globalThis.fetch }) {
  let cache = null, at = 0;
  return async function jwksProvider() {
    const t = Date.now();
    if (cache && (t - at) < ttlMs) return cache;
    const res = await fetchImpl(jwksUrl, { method: 'GET' });
    if (!res || !res.ok) throw new Error('jwks_fetch_failed');
    const body = await res.json();
    cache = body; at = t;
    return body;
  };
}

module.exports = { createSupabaseTokenVerifier, createHttpJwksProvider, AccountTokenError, AUD, CLOCK_SKEW_SEC };
