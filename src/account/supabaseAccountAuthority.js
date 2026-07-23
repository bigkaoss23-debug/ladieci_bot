'use strict';
// S2-7C1B — canonical server-side account-session validation against Supabase Auth (GoTrue).
//
// The local ES256/JWKS verifier (supabaseToken.js) proves a token is cryptographically
// authentic and unexpired — a cheap pre-filter. It CANNOT prove the presented token is still
// an accepted session, nor that the account is still usable. This module closes that gap by
// asking Supabase Auth about the EXACT token the client presented:
//
//   GET {SUPABASE_URL}/auth/v1/user
//     apikey:        <anon key>            ← public gateway key, NOT the service-role key
//     Authorization: Bearer <access token> ← the client's own token, verified by GoTrue
//
// GoTrue itself accepts or rejects that token and returns the canonical user. The returned
// identity — not the JWT claims and not an admin lookup by `sub` — is the authority.
//
// Contract:
//   • never logs; never returns a secret;
//   • uses the ANON key only as the gateway apikey; the service-role key is NOT used for the
//     normal bearer check (it would make the request an admin lookup rather than a validation
//     of the presented session);
//   • the subject in the local claims must equal the id GoTrue returns;
//   • email must be confirmed and the account usable (not deleted / not banned);
//   • fail closed: timeout / Auth error / mismatch → throw; no permissive fallback.

const DEFAULT_TIMEOUT_MS = 4000;

// Rejections that mean "this presented token must not be honoured" → 401.
const REJECT_CODES = new Set([
  'SESSION_REJECTED',    // GoTrue did not accept the token (revoked/invalid/deleted/banned)
  'SUBJECT_MISMATCH',    // local sub != GoTrue user.id
  'USER_DELETED',
  'USER_DISABLED',
  'EMAIL_NOT_CONFIRMED',
]);
// Availability failures → 503 (controlled, fail-closed, never a pass).
const UNAVAILABLE_CODE = 'AUTH_BACKEND_UNAVAILABLE';

class AccountAuthorityError extends Error {
  constructor(code) { super(code); this.name = 'AccountAuthorityError'; this.code = code; }
  get isReject() { return REJECT_CODES.has(this.code); }
  get isUnavailable() { return this.code === UNAVAILABLE_CODE; }
}

function isFutureInstant(value, now) {
  if (!value) return false;
  const t = Date.parse(value);
  return Number.isFinite(t) && t > now.getTime();
}

// deps: { getUserByToken: async (accessToken) => goTrueUserRecord, now?: ()=>Date }
//   getUserByToken resolves to the GoTrue user for a token GoTrue accepts, and throws an
//   AccountAuthorityError('SESSION_REJECTED') when GoTrue refuses it or
//   AccountAuthorityError('AUTH_BACKEND_UNAVAILABLE') on transport/timeout/backend failure.
function createAccountAuthority(deps) {
  const getUserByToken = deps && deps.getUserByToken;
  const now = (deps && deps.now) || (() => new Date());
  if (typeof getUserByToken !== 'function') {
    throw new Error('createAccountAuthority: getUserByToken required');
  }

  // claims: verified local claims (pre-filter). accessToken: the raw presented bearer.
  return async function assertAccountSession(claims, accessToken) {
    const sub = claims && claims.sub;
    if (typeof sub !== 'string' || sub.length === 0) throw new AccountAuthorityError('SESSION_REJECTED');
    if (typeof accessToken !== 'string' || accessToken.length === 0) throw new AccountAuthorityError('SESSION_REJECTED');

    let user;
    try {
      user = await getUserByToken(accessToken);
    } catch (e) {
      if (e instanceof AccountAuthorityError) throw e;      // already classified (reject/unavailable)
      throw new AccountAuthorityError(UNAVAILABLE_CODE);      // anything else → fail closed
    }

    if (!user || typeof user !== 'object' || !user.id) throw new AccountAuthorityError('SESSION_REJECTED');
    // The presented token's subject must match the identity GoTrue returns for it.
    if (String(user.id) !== String(sub)) throw new AccountAuthorityError('SUBJECT_MISMATCH');
    // Defence in depth (GoTrue also 401/403s these, surfacing as SESSION_REJECTED upstream).
    if (user.deleted_at) throw new AccountAuthorityError('USER_DELETED');
    if (isFutureInstant(user.banned_until, now())) throw new AccountAuthorityError('USER_DISABLED');
    const emailConfirmed = Boolean(user.email_confirmed_at || user.confirmed_at);
    if (!emailConfirmed) throw new AccountAuthorityError('EMAIL_NOT_CONFIRMED');

    return Object.freeze({
      id: String(user.id),
      email: typeof user.email === 'string' ? user.email : null,
      emailConfirmed: true,
    });
  };
}

// HTTP validator: sends the CLIENT'S token to GoTrue's /auth/v1/user.
//   • 200      → parsed user record
//   • 401/403  → AccountAuthorityError('SESSION_REJECTED')  (GoTrue refused the token)
//   • other / network / timeout → AccountAuthorityError('AUTH_BACKEND_UNAVAILABLE')
// anonKey is the public gateway apikey. If anonKey/url are absent the boundary is
// fail-closed (every call reports unavailability) — never a silent authorize.
function createSupabaseUserTokenValidator(opts) {
  const base = String((opts && opts.supabaseUrl) || '').replace(/\/+$/, '');
  const anonKey = (opts && opts.anonKey) || '';
  const fetchImpl = (opts && opts.fetchImpl) || globalThis.fetch;
  const timeoutMs = (opts && opts.timeoutMs) || DEFAULT_TIMEOUT_MS;
  if (!base || !anonKey) {
    return async function unconfiguredGetUser() { throw new AccountAuthorityError(UNAVAILABLE_CODE); };
  }

  return async function getUserByToken(accessToken) {
    const url = `${base}/auth/v1/user`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'GET',
        headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}` },
        signal: controller.signal,
      });
    } catch (_) {
      throw new AccountAuthorityError(UNAVAILABLE_CODE);      // network / abort / timeout
    } finally {
      clearTimeout(timer);
    }
    if (res && (res.status === 401 || res.status === 403)) throw new AccountAuthorityError('SESSION_REJECTED');
    if (!res || !res.ok) throw new AccountAuthorityError(UNAVAILABLE_CODE);
    try { return await res.json(); }
    catch (_) { throw new AccountAuthorityError(UNAVAILABLE_CODE); }
  };
}

module.exports = {
  createAccountAuthority,
  createSupabaseUserTokenValidator,
  AccountAuthorityError,
  REJECT_CODES,
  UNAVAILABLE_CODE,
  DEFAULT_TIMEOUT_MS,
};
