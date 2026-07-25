'use strict';
// S2-7C / S2-7D — staging-gated ACCOUNT boundary (Supabase Auth) mounted into Express.
// DISABLED BY DEFAULT. Mounts routes only when ACCOUNT_HTTP_ENABLED === 'true' (exact);
// absent/empty/any other value → strict no-op, zero middleware side effect.
//
// Routes (all Supabase-Bearer authenticated; NEVER the legacy X-Api-Key or the Auth V2
// PIN JWT; NEVER trusting a body-supplied user id / email / role):
//   GET  /api/account/me                                (S2-7C) profile + memberships
//   POST /api/account/workspaces/bootstrap              (S2-7D) idempotent owner claim (guarded)
//   POST /api/account/workspaces/:workspaceId/admin-pin (S2-7D) create/rotate owner PIN
//
// Every route authorizes ONLY with a verified Supabase access token (local JWKS pre-filter
// THEN a canonical GoTrue /auth/v1/user check). It never touches auth_actors/PIN JWTs
// except through the S2-7D account RPCs, which re-verify ownership under row lock.

const express = require('express');
const { createSupabaseTokenVerifier, createHttpJwksProvider, AccountTokenError } = require('./supabaseToken');
const { createAccountService } = require('./accountService');
const {
  createAccountAuthority,
  createSupabaseUserTokenValidator,
  AccountAuthorityError,
} = require('./supabaseAccountAuthority');
const { createWorkspaceOwnerService } = require('./workspaceOwnerService');
const workspaceOwnerDao = require('./workspaceOwnerDao');

const FLAG = 'ACCOUNT_HTTP_ENABLED';
const ENABLED = 'true';
const BOOTSTRAP_FLAG = 'ACCOUNT_OWNER_BOOTSTRAP_ENABLED';
const BOOTSTRAP_USER_ENV = 'LA_DIECI_OWNER_BOOTSTRAP_USER_ID';
const ME_PATH = '/api/account/me';
const BOOTSTRAP_PATH = '/api/account/workspaces/bootstrap';
const ADMIN_PIN_PATH = '/api/account/workspaces/:workspaceId/admin-pin';

function isEnabled(env) { return (env || {})[FLAG] === ENABLED; }
function isBootstrapEnabled(env) { return (env || {})[BOOTSTRAP_FLAG] === ENABLED; }

function bearerOf(req) {
  const h = req && req.headers && (req.headers.authorization || req.headers.Authorization);
  if (typeof h !== 'string') return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function bodyOf(req) {
  return req && req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
}

// Build default deps against the real Supabase project (JWKS verify + GoTrue canonical
// check + service_role reads/RPCs).
function buildDefaults(env) {
  const base = String(env.SUPABASE_URL || '').replace(/\/+$/, '');
  const issuer = `${base}/auth/v1`;
  const jwksProvider = createHttpJwksProvider({ jwksUrl: `${base}/auth/v1/.well-known/jwks.json` });
  const verify = createSupabaseTokenVerifier({ jwksProvider, issuer });

  const authority = createAccountAuthority({
    getUserByToken: createSupabaseUserTokenValidator({ supabaseUrl: env.SUPABASE_URL, anonKey: env.SUPABASE_ANON_KEY }),
  });

  // NB: use sbRest (NOT sbSelect). sbSelect hard-codes `select=*&` in front of the caller's
  // query, so an explicit `select=` becomes a SECOND select parameter and PostgREST keeps
  // only the first — silently dropping the embedded `workspaces(...)` resource. That made
  // every workspace field (and therefore adminPinSetupRequired) null. sbRest sets the query
  // verbatim, exactly once.
  const { sbRest } = require('../auth/audit');
  const enc = encodeURIComponent;
  const rows = async (resource, query) => {
    const r = await sbRest('GET', resource, { query });
    return r.ok && Array.isArray(r.body) ? r.body : [];
  };
  const service = createAccountService({
    selectProfile: (uid) => rows('user_profiles', `id=eq.${enc(uid)}&select=id,display_name`),
    selectMemberships: (uid) => rows(
      'workspace_memberships',
      `user_id=eq.${enc(uid)}&status=eq.active&select=workspace_id,role,status,workspaces(slug,display_name,lifecycle_status,commercial_status,owner_pin_onboarding_completed_at)`
    ),
  });

  const { hashPin } = require('../auth/scrypt');
  const pinPolicy = require('../auth/pinPolicy');
  const { ipHash } = require('../auth/ipSecurity');
  const ownerService = createWorkspaceOwnerService({
    dao: workspaceOwnerDao,
    hashPin,
    pinPolicy,
    ipHash,
    slug: env.LA_DIECI_WORKSPACE_SLUG || 'la-dieci',
    displayName: env.LA_DIECI_WORKSPACE_NAME || 'La Dieci',
  });

  return { verify, authority, service, ownerService };
}

// Server-owned client IP (never from the body). Reuses the accepted financial boundary.
function trustedClientIp(req) {
  try {
    const { extractClientIp } = require('../auth/financialHttpHandlers');
    return extractClientIp(req);
  } catch (_) { return (req && typeof req.ip === 'string' && req.ip) || null; }
}

function integrateAccountRoutes(app, deps = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.use !== 'function') {
    throw new Error('integrateAccountRoutes: express app required');
  }
  const env = deps.env || process.env;
  if (!isEnabled(env)) return Object.freeze({ enabled: false, path: ME_PATH, routes: Object.freeze([]) });

  let d = null;
  const get = () => (d || (d = buildDefaults(env)));
  const verify = deps.verify || ((t) => get().verify(t));
  const assertAccountSession = deps.assertAccountSession || ((c, t) => get().authority(c, t));
  const getAccountMe = deps.getAccountMe || ((c) => get().service(c));
  const claimWorkspace = (deps.ownerService && deps.ownerService.claimWorkspace)
    || ((a) => get().ownerService.claimWorkspace(a));
  const setOwnerPin = (deps.ownerService && deps.ownerService.setOwnerPin)
    || ((a) => get().ownerService.setOwnerPin(a));
  const logger = deps.logger || console;

  // Shared account-auth middleware: local JWKS pre-filter → canonical GoTrue check.
  // On success returns { claims, emailConfirmed }; on failure it has already responded
  // (401/503) and returns null. Never leaks which stage failed beyond 401/503.
  async function authenticate(req, res) {
    const token = bearerOf(req);
    if (!token) { res.status(401).json({ error: 'account_auth_required' }); return null; }

    let claims;
    try { claims = await verify(token); }
    catch (e) {
      if (!(e instanceof AccountTokenError)) { logger.error && logger.error('account verify error'); }
      res.status(401).json({ error: 'account_auth_invalid' }); return null;
    }

    let canonical;
    try { canonical = await assertAccountSession(claims, token); }
    catch (e) {
      if (e instanceof AccountAuthorityError) {
        if (e.isUnavailable) { res.status(503).json({ error: 'account_auth_unavailable' }); return null; }
        res.status(401).json({ error: 'account_auth_invalid' }); return null;
      }
      logger.error && logger.error('account authority error');
      res.status(503).json({ error: 'account_auth_unavailable' }); return null;
    }
    return Object.freeze({ claims, emailConfirmed: canonical.emailConfirmed === true });
  }

  const router = express.Router();

  // GET /account/me
  router.get('/account/me', async (req, res) => {
    const acc = await authenticate(req, res);
    if (!acc) return undefined;
    try {
      const body = await getAccountMe(Object.freeze({ ...acc.claims, emailVerified: acc.emailConfirmed }));
      return res.status(200).json(body);
    } catch (e) {
      logger.error && logger.error('account/me read error');
      return res.status(500).json({ error: 'account_read_failed' });
    }
  });

  // POST /account/workspaces/bootstrap — guarded idempotent owner claim.
  // Fails closed: requires ACCOUNT_OWNER_BOOTSTRAP_ENABLED === 'true' AND the verified
  // account id to equal LA_DIECI_OWNER_BOOTSTRAP_USER_ID (staging env only; never
  // hardcoded). Any account may reach the route but only the configured owner can claim;
  // everyone else gets a neutral 403.
  router.post('/account/workspaces/bootstrap', async (req, res) => {
    const acc = await authenticate(req, res);
    if (!acc) return undefined;
    if (acc.emailConfirmed !== true) return res.status(403).json({ error: 'email_not_verified' });
    if (!isBootstrapEnabled(env)) return res.status(404).json({ error: 'not_found' });

    const allow = env[BOOTSTRAP_USER_ENV];
    const uid = acc.claims && acc.claims.sub;
    if (typeof allow !== 'string' || allow.length === 0 || uid !== allow) {
      return res.status(403).json({ error: 'account_not_authorized' });
    }

    try {
      const result = await claimWorkspace({ userId: uid });
      if (!result || result.ok !== true) return res.status(409).json({ error: 'account_action_failed' });
      return res.status(200).json({
        ok: true,
        workspaceId: result.workspaceId,
        created: result.created === true,
        adminPinRequired: result.adminPinRequired === true,
      });
    } catch (e) {
      logger.error && logger.error('account bootstrap error');
      return res.status(500).json({ error: 'account_action_failed' });
    }
  });

  // POST /account/workspaces/:workspaceId/admin-pin — create/rotate the owner PIN.
  // Authorization is ownership of :workspaceId, re-verified in SQL under row lock. No
  // bootstrap flag, no allowlist, no role/email/user-id from the body.
  router.post('/account/workspaces/:workspaceId/admin-pin', async (req, res) => {
    const acc = await authenticate(req, res);
    if (!acc) return undefined;
    if (acc.emailConfirmed !== true) return res.status(403).json({ error: 'email_not_verified' });

    const uid = acc.claims && acc.claims.sub;
    const workspaceId = req.params && req.params.workspaceId;
    const body = bodyOf(req);
    const newPin = typeof body.pin === 'string' ? body.pin : null;

    try {
      const result = await setOwnerPin({
        userId: uid, workspaceId, newPin, trustedClientIp: trustedClientIp(req),
      });
      // Single generic failure — never reveals policy vs ownership vs actor existence.
      if (!result || result.ok !== true) return res.status(400).json({ error: 'admin_pin_rejected' });
      return res.status(200).json({ ok: true, event: result.event, sessionVersion: result.sessionVersion });
    } catch (e) {
      logger.error && logger.error('account admin-pin error');
      return res.status(500).json({ error: 'admin_pin_rejected' });
    }
  });

  app.use('/api', router);
  const routes = isBootstrapEnabled(env)
    ? [ME_PATH, BOOTSTRAP_PATH, ADMIN_PIN_PATH]
    : [ME_PATH, ADMIN_PIN_PATH];
  return Object.freeze({ enabled: true, path: ME_PATH, routes: Object.freeze(routes) });
}

module.exports = {
  integrateAccountRoutes, isAccountHttpEnabled: isEnabled, isBootstrapEnabled,
  ME_PATH, BOOTSTRAP_PATH, ADMIN_PIN_PATH,
};
