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

// S2-7D4C — auth_method: HOW a session authenticated. A CLOSED enum, SERVER-DERIVED only
// (never read from the request body), carried as the `am` claim. It exists so a step-up can
// reconfirm the SAME credential the session logged in with — the compatibility login (explicit
// role/actor) is `actor_pin`; the universal {pin}-only login is `legacy_universal`. The two
// differ in the PIN FORMAT gate applied before the hash check (see pinPolicy.js), which is
// exactly why a 6–8 digit owner PIN can log in universally yet be rejected by an admin-format
// step-up. verifyOwnPin selects its validator from this claim; the step-up proof is bound to it.
const AUTH_METHOD_ACTOR_PIN = 'actor_pin';
const AUTH_METHOD_LEGACY_UNIVERSAL = 'legacy_universal';
const AUTH_METHODS = Object.freeze(new Set([AUTH_METHOD_ACTOR_PIN, AUTH_METHOD_LEGACY_UNIVERSAL]));
function isValidAuthMethod(m) { return typeof m === 'string' && AUTH_METHODS.has(m); }

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
//
// Binding: earlier drafts bound the proof to a hash of the raw Bearer. That degenerates
// exactly when the underlying session token itself is not unique — which, before the sid
// fix above, was provably true for two logins of the same actor within the same clock
// second. The proof now binds to the per-login `sid` instead: cryptographically random,
// minted once by signToken, never accepted from any caller. A token with no sid (a
// pre-existing session signed before this change) cannot mint or use a step-up proof at
// all — there is deliberately no weaker fallback for PIN management.
const STEP_UP_TTL_SECONDS = 600; // hard cap, 10 minutes — never derived from caller input
const STEP_UP_PURPOSE = 'manage_pins';
const STEP_UP_VERSION = 'su1';

function validSid(sid) {
  return typeof sid === 'string' && sid.length > 0 && sid.length <= 64;
}

// signStepUpProof({actor, role, sv, sid, authMethod}) -> proof string, or null.
// `sid` MUST be the CURRENT session's own sid (from req.authCtx.sid) — missing/invalid
// refuses to mint a proof at all, by design. `authMethod` MUST be the CURRENT session's
// server-derived auth method (req.authCtx.authMethod): the proof is bound to it so a proof
// minted from a legacy_universal session can never be replayed by an actor_pin session (or
// vice-versa), even for the same actor/sid/session_version.
function signStepUpProof({ actor, role, sv, sid, authMethod } = {}) {
  if (!isReady()) return null;
  if (!roleSubValid(role, actor)) return null;
  if (!Number.isInteger(sv) || sv < 1) return null;
  if (!validSid(sid)) return null;
  if (!isValidAuthMethod(authMethod)) return null;
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + STEP_UP_TTL_SECONDS;
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    v: STEP_UP_VERSION, purpose: STEP_UP_PURPOSE,
    sub: actor, role, sv, sid, am: authMethod, iat, exp,
  }));
  const sig = hmac(header + '.' + payload);
  return header + '.' + payload + '.' + sig;
}

// verifyStepUpProof(token, {sid, authMethod}) -> payload object or null. NEVER throws.
// `sid` MUST be the CURRENT request's own session id — this is what makes a proof minted in
// one session unusable from a different session, even for the same actor at the same
// session_version, and what makes a sid-less (legacy) session unable to use a proof at all.
// `authMethod` MUST be the CURRENT session's server-derived auth method — a proof whose `am`
// does not match it is rejected, so an actor_pin session can never consume a legacy_universal
// proof (or vice-versa). A missing/invalid expected authMethod refuses outright.
function verifyStepUpProof(token, { sid, authMethod } = {}) {
  try {
    if (!isReady() || typeof token !== 'string') return null;
    if (!validSid(sid)) return null;
    if (!isValidAuthMethod(authMethod)) return null;
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
    if (!validSid(pl.sid)) return null;
    if (!isValidAuthMethod(pl.am)) return null;
    if (!Number.isInteger(pl.iat) || !Number.isInteger(pl.exp)) return null;
    if (pl.exp <= pl.iat) return null;
    if ((pl.exp - pl.iat) > STEP_UP_TTL_SECONDS + SKEW_SEC) return null;
    const now = Math.floor(Date.now() / 1000);
    if (pl.iat > now + SKEW_SEC) return null;
    if (now >= pl.exp + SKEW_SEC) return null;

    // session binding — timing-safe compare, same discipline as the signature check above.
    const sidA = Buffer.from(pl.sid), sidB = Buffer.from(sid);
    if (sidA.length !== sidB.length || !crypto.timingSafeEqual(sidA, sidB)) return null;

    // auth-method binding — the proof must have been minted under the SAME method the current
    // session authenticated with. A plain enum compare (not a secret): no timing concern.
    if (pl.am !== authMethod) return null;

    return pl;
  } catch (_) {
    return null;
  }
}

// S2-7D6E4 — per-login session id. {role,sub,iat,exp,sv} alone is NOT unique: two logins
// for the same actor at the same session_version within the same clock second produce a
// BYTE-IDENTICAL payload (iat/exp are both deterministic), and HMAC is deterministic, so the
// two tokens were literally the same string — verified empirically with frozen time. `sid` is
// generated HERE, by the backend, from a real entropy source, every time a token is minted; a
// caller cannot supply or influence it. It is the only thing that actually distinguishes two
// otherwise-identical logins.
function newSid() {
  return crypto.randomBytes(16).toString('base64url');
}

// signToken({role, sub, sv, authMethod}) → token string, or null on invalid input / not ready.
// `authMethod` is REQUIRED and must be a valid closed-enum value (server-derived, never from a
// caller): every token minted after S2-7D4C records how the session authenticated.
function signToken({ role, sub, sv, authMethod } = {}) {
  if (!isReady()) return null;
  if (!roleSubValid(role, sub)) return null;
  if (!Number.isInteger(sv) || sv < 1) return null;
  if (!isValidAuthMethod(authMethod)) return null;
  const ttl = TTL_SECONDS[role];
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + ttl;
  const sid = newSid();
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ role, sub, iat, exp, sv, sid, am: authMethod, v: 2 }));
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
    // S2-7D6E4 — sid is OPTIONAL here for backward compatibility: a token signed before this
    // change carries no sid and must keep authorizing ordinary (non-PIN-management) actions.
    // If present it must be a plausible opaque id; a present-but-malformed sid is treated as
    // tampering, not as "absent" — the whole token is rejected, not silently downgraded.
    if (pl.sid !== undefined) {
      if (typeof pl.sid !== 'string' || pl.sid.length === 0 || pl.sid.length > 64) return null;
    }
    // S2-7D4C — auth_method (`am`). A token minted after this change always carries a valid
    // enum value; a token signed before it carries none. Present-but-invalid = tampering →
    // reject the whole token (no silent downgrade). Absent = legacy: still authorizes ordinary
    // actions, but the step-up path refuses it (pinStepUp.js) with REAUTH_REQUIRED.
    if (pl.am !== undefined && !isValidAuthMethod(pl.am)) return null;
    return pl;
  } catch (_) {
    return null;
  }
}

module.exports = {
  signToken, verifyToken, expiresInFor, isReady, TTL_SECONDS, ROLE_SUB, SKEW_SEC,
  signStepUpProof, verifyStepUpProof, STEP_UP_TTL_SECONDS, STEP_UP_PURPOSE,
  AUTH_METHOD_ACTOR_PIN, AUTH_METHOD_LEGACY_UNIVERSAL, AUTH_METHODS, isValidAuthMethod,
};
