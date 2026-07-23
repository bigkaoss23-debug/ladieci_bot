'use strict';
// S2-7C1 — canonical server-side account-session validation against Supabase Auth (GoTrue).
//
// The local ES256/JWKS verifier (supabaseToken.js) proves a token is cryptographically
// authentic and unexpired. It CANNOT prove the user still exists, is still enabled, or that
// the email is really confirmed — a Supabase access token is a stateless JWT that stays
// signature-valid until `exp` even after the underlying user is deleted, banned, or logged
// out. This module adds the missing canonical check: it asks Supabase Auth itself (GoTrue
// admin API, service-role) for the CURRENT state of the subject and fails closed on anything
// that is no longer a valid, confirmed, enabled account.
//
// Contract:
//   • never logs; never returns the service-role key or any secret;
//   • never trusts client-declared identity — the subject is taken ONLY from verified claims;
//   • no permissive fallback: if Supabase Auth is unreachable/times out, it throws
//     AUTH_BACKEND_UNAVAILABLE (→ 503), it does NOT wave the request through;
//   • deleted / banned / missing / email-unconfirmed → a rejection code (→ 401).

const DEFAULT_TIMEOUT_MS = 4000;

// Rejections that mean "this token must not be honoured" → 401.
const REJECT_CODES = new Set([
  'USER_NOT_FOUND',
  'USER_DELETED',
  'USER_DISABLED',
  'EMAIL_NOT_CONFIRMED',
  'SESSION_REJECTED',
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

// deps: { adminGetUser: async (userId) => userRecord|null, now?: ()=>Date }
//   adminGetUser resolves to the GoTrue user record (or null when the user does not exist),
//   and throws for transport/timeout/backend failures (→ AUTH_BACKEND_UNAVAILABLE).
function createAccountAuthority(deps) {
  const adminGetUser = deps && deps.adminGetUser;
  const now = (deps && deps.now) || (() => new Date());
  if (typeof adminGetUser !== 'function') {
    throw new Error('createAccountAuthority: adminGetUser required');
  }

  // claims: verified claims from supabaseToken.js (never client-declared).
  return async function assertAccountSession(claims) {
    const userId = claims && claims.sub;
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new AccountAuthorityError('SESSION_REJECTED');
    }

    let user;
    try {
      user = await adminGetUser(userId);
    } catch (_) {
      // Any transport/timeout/5xx/misconfiguration is treated as unavailability, NOT as a
      // pass. The route maps this to 503 so a degraded Auth backend can never authorize.
      throw new AccountAuthorityError(UNAVAILABLE_CODE);
    }

    if (!user || typeof user !== 'object' || !user.id) {
      throw new AccountAuthorityError('USER_NOT_FOUND');
    }
    // Defence in depth: the record must be the same subject the token claims.
    if (String(user.id) !== String(userId)) {
      throw new AccountAuthorityError('SESSION_REJECTED');
    }
    if (user.deleted_at) {
      throw new AccountAuthorityError('USER_DELETED');
    }
    // Supabase marks a ban with banned_until in the future (a past value = ban expired).
    if (isFutureInstant(user.banned_until, now())) {
      throw new AccountAuthorityError('USER_DISABLED');
    }
    // Canonical email-confirmation truth comes from Auth, not the token claim.
    const emailConfirmed = Boolean(user.email_confirmed_at || user.confirmed_at);
    if (!emailConfirmed) {
      throw new AccountAuthorityError('EMAIL_NOT_CONFIRMED');
    }

    return Object.freeze({
      id: String(user.id),
      email: typeof user.email === 'string' ? user.email : null,
      emailConfirmed: true,
    });
  };
}

// HTTP admin provider: GET {supabaseUrl}/auth/v1/admin/users/{id} as service-role.
//   • 200 → parsed user record
//   • 404 → null (user genuinely absent)
//   • anything else / network / timeout → throw (caller maps to AUTH_BACKEND_UNAVAILABLE)
// The service-role key is used only as request headers and is never returned or logged.
function createSupabaseAdminUserProvider(opts) {
  const base = String((opts && opts.supabaseUrl) || '').replace(/\/+$/, '');
  const serviceKey = (opts && opts.serviceKey) || '';
  const fetchImpl = (opts && opts.fetchImpl) || globalThis.fetch;
  const timeoutMs = (opts && opts.timeoutMs) || DEFAULT_TIMEOUT_MS;
  if (!base || !serviceKey) {
    // Fail closed at construction-adjacent call time: an enabled-but-misconfigured boundary
    // must never silently authorize. The returned provider always signals unavailability.
    return async function unconfiguredAdminGetUser() { throw new Error('admin_provider_unconfigured'); };
  }

  return async function adminGetUser(userId) {
    const url = `${base}/auth/v1/admin/users/${encodeURIComponent(userId)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'GET',
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (res && res.status === 404) return null;
    if (!res || !res.ok) throw new Error('admin_get_user_failed');
    return res.json();
  };
}

module.exports = {
  createAccountAuthority,
  createSupabaseAdminUserProvider,
  AccountAuthorityError,
  REJECT_CODES,
  UNAVAILABLE_CODE,
  DEFAULT_TIMEOUT_MS,
};
