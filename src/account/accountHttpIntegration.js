'use strict';
// S2-7C — staging-gated integration of the ACCOUNT boundary (Supabase Auth) into Express.
// DISABLED BY DEFAULT. Mounts GET /api/account/me only when ACCOUNT_HTTP_ENABLED === 'true'
// (exact). Absent/empty/any other value → strict no-op, zero middleware side effect.
//
// Mounted BEFORE the legacy /api X-Api-Key proxy so the account route enters its Supabase
// Bearer chain first and never requires/accepts the legacy key or the Auth V2 PIN JWT.
// This module authorizes ONLY with a verified Supabase access token; it never touches
// auth_actors, PIN JWTs, or operational tables.

const express = require('express');
const { createSupabaseTokenVerifier, createHttpJwksProvider, AccountTokenError } = require('./supabaseToken');
const { createAccountService } = require('./accountService');

const FLAG = 'ACCOUNT_HTTP_ENABLED';
const ENABLED = 'true';
const ME_PATH = '/api/account/me';

function isEnabled(env) { return (env || {})[FLAG] === ENABLED; }

function bearerOf(req) {
  const h = req && req.headers && (req.headers.authorization || req.headers.Authorization);
  if (typeof h !== 'string') return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

// Build default deps against the real Supabase project (JWKS verification + service_role reads).
function buildDefaults(env) {
  const base = String(env.SUPABASE_URL || '').replace(/\/+$/, '');
  const issuer = `${base}/auth/v1`;
  const jwksProvider = createHttpJwksProvider({ jwksUrl: `${base}/auth/v1/.well-known/jwks.json` });
  const verify = createSupabaseTokenVerifier({ jwksProvider, issuer });

  // Reads via the service-role PostgREST helper, ALWAYS scoped to the verified user id.
  const { sbSelect } = require('../utils/supabase');
  const enc = encodeURIComponent;
  const service = createAccountService({
    selectProfile: (uid) => sbSelect('user_profiles', `id=eq.${enc(uid)}&select=id,display_name`),
    selectMemberships: (uid) => sbSelect(
      'workspace_memberships',
      `user_id=eq.${enc(uid)}&status=eq.active&select=workspace_id,role,status,workspaces(slug,display_name,lifecycle_status,commercial_status)`
    ),
  });
  return { verify, service };
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
  const getAccountMe = deps.getAccountMe || ((c) => get().service(c));
  const logger = deps.logger || console;

  const router = express.Router();
  router.get('/account/me', async (req, res) => {
    const token = bearerOf(req);
    if (!token) return res.status(401).json({ error: 'account_auth_required' });
    let claims;
    try { claims = await verify(token); }
    catch (e) {
      if (e instanceof AccountTokenError) return res.status(401).json({ error: 'account_auth_invalid' });
      logger.error && logger.error('account verify error');
      return res.status(401).json({ error: 'account_auth_invalid' });
    }
    try {
      const body = await getAccountMe(claims);
      return res.status(200).json(body);
    } catch (e) {
      logger.error && logger.error('account/me read error');
      return res.status(500).json({ error: 'account_read_failed' });
    }
  });

  app.use('/api', router);
  return Object.freeze({ enabled: true, path: ME_PATH, routes: Object.freeze([ME_PATH]) });
}

module.exports = { integrateAccountRoutes, isAccountHttpEnabled: isEnabled, ME_PATH };
