'use strict';
// Access Control V2 — Block B7A5: staging-gated integration of the accepted B3 login
// boundary into the real Express application. DISABLED BY DEFAULT.
//
// Wires ONE login route (POST /api/auth/v2/login) when AUTH_V2_LOGIN_HTTP_ENABLED === 'true'
// (exact). Absent / empty / any other value → disabled, ZERO middleware side effect. No
// host / branch / NODE_ENV / Supabase-URL fallback, no production default, and NO coupling
// to the financial flag (AUTH_V2_FINANCIAL_HTTP_ENABLED). The two flags are independent.
//
// The login route is UNAUTHENTICATED (it issues the JWT): it neither requires nor accepts a
// Bearer token or the legacy X-Api-Key, and is mounted BEFORE the legacy /api proxy so it
// never falls through to it. All accepted B3 protections (single scrypt derivation per
// attempt, decoy hash, DB lock + IP limiter, anti-enumeration normalization, generic
// error envelopes) come from the accepted handler — this module does NOT re-implement PIN
// verification, query PIN hashes, or reconstruct JWT claims.

const express = require('express');
const { createLoginHandler, createUniversalLoginHandler } = require('./login');
const { extractClientIp } = require('./financialHttpHandlers'); // reuse the accepted server-owned IP boundary
const { integrateFinancialRoutes } = require('./financialHttpIntegration'); // combined harness only

const LOGIN_HTTP_FLAG = 'AUTH_V2_LOGIN_HTTP_ENABLED';
const FLAG_ENABLED_VALUE = 'true';                 // the ONLY accepted true value (exact)
const LOGIN_PATH = '/api/auth/v2/login';

// Enabled ONLY by an exact-match staging env var. Fail-closed otherwise; never derives
// enablement from host/branch/NODE_ENV/Supabase URL or the financial flag.
function isLoginHttpEnabled(env) {
  const e = env || {};
  return e[LOGIN_HTTP_FLAG] === FLAG_ENABLED_VALUE;
}

// Build the accepted B3 login handler wired to the real deps. Lazy: a DISABLED app never
// constructs it, and tests inject a fake handler instead. Reuses the exact accepted DAO,
// JWT, PIN policy, scrypt verifier, IP hashing + limiter and audit boundaries — no second
// PIN verifier, no PIN-hash query from this layer.
let _decoyHashPromise = null;
function buildDefaultLoginHandlers() {
  const dao = require('./dao');
  const jwt = require('./jwt');
  const pinPolicy = require('./pinPolicy');
  const { verifyPin, hashPin } = require('./scrypt');
  const { ipHash, createIpLimiter } = require('./ipSecurity');
  const audit = require('./audit');
  // One process-lifetime decoy hash (constant, non-secret). Universal login uses it for
  // every absent/inactive canonical slot, preserving a fixed four-comparison shape.
  if (!_decoyHashPromise) _decoyHashPromise = hashPin('decoy-not-a-real-pin-000000');
  const deps = {
    dao, jwt, pinPolicy, verifyPin,
    decoyHashPromise: _decoyHashPromise,
    ipHash, ipLimiter: createIpLimiter(), audit,
  };
  return { universal: createUniversalLoginHandler(deps), compatibility: createLoginHandler(deps) };
}

function bodyOf(req) {
  return req && req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
}

// Mount the single login route + a login-scoped parser-error sanitizer. Returns
// { enabled, path, routes }. Disabled → strict no-op. deps: { env?, loginHandler?, logger? }.
function integrateLoginRoute(app, deps = {}) {
  if (!app || typeof app.post !== 'function' || typeof app.use !== 'function') {
    throw new Error('integrateLoginRoute: express app required');
  }
  const env = deps.env || process.env;
  if (!isLoginHttpEnabled(env)) {
    return Object.freeze({ enabled: false, path: LOGIN_PATH, routes: Object.freeze([]) });
  }
  let defaults = null;
  const getDefaults = () => {
    if (!defaults) defaults = buildDefaultLoginHandlers();
    return defaults;
  };
  const universalHandler = typeof deps.universalLoginHandler === 'function'
    ? deps.universalLoginHandler
    : (request) => getDefaults().universal(request);
  const compatibilityHandler = typeof deps.loginHandler === 'function'
    ? deps.loginHandler
    : (request) => getDefaults().compatibility(request);
  const logger = deps.logger || null;

  async function loginRoute(req, res) {
    const b = bodyOf(req);
    let result;
    try {
      // `{pin}` is the universal contract. The explicit role/actor shape is retained only
      // as a temporary rollback/test compatibility path and is not used by the frontend.
      // Session/claims/active/lockout are never accepted from the caller. IP comes from
      // server-owned request context, never the body.
      const trustedClientIp = extractClientIp(req);
      result = (b.role === undefined && b.actor === undefined)
        ? await universalHandler({ pin: b.pin, trustedClientIp })
        : await compatibilityHandler({ role: b.role, pin: b.pin, actor: b.actor, trustedClientIp });
    } catch (_) {
      if (logger && logger.info) { try { logger.info({ op: 'login', status: 500 }); } catch (_e) { /* never throw */ } }
      return res.status(500).json({ error: 'error interno' }); // fail-closed, sanitized
    }
    if (!result || typeof result.status !== 'number') {
      return res.status(500).json({ error: 'error interno' });
    }
    if (logger && logger.info) { try { logger.info({ op: 'login', status: result.status }); } catch (_e) { /* never throw */ } }
    return res.status(result.status).json(result.body); // accepted B3 envelope (never logged)
  }

  app.post(LOGIN_PATH, loginRoute);

  // login-scoped sanitizing JSON parser error handler (login path ONLY; every other path's
  // parser error is passed through unchanged, so legacy behaviour is not altered).
  app.use(function loginScopedJsonError(err, req, res, next) {
    const p = req && typeof req.path === 'string' ? req.path : '';
    if (err && p === LOGIN_PATH) {
      const tooLarge = err.status === 413 || err.statusCode === 413 || err.type === 'entity.too.large';
      if (tooLarge) return res.status(413).json({ error: 'cuerpo demasiado grande' });
      return res.status(400).json({ error: 'solicitud inválida' });
    }
    return next(err);
  });

  return Object.freeze({ enabled: true, path: LOGIN_PATH, routes: Object.freeze([{ method: 'POST', path: LOGIN_PATH }]) });
}

// In-memory real-stack harness mounting BOTH gated integrations (login + financial) around
// the same middleware chain the real app uses, WITHOUT listening. Used by tests to prove
// flag independence, coexistence, parser/CORS and legacy /api behaviour.
function createAuthV2IntegrationApp(deps = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {                             // CORS mirror of index.js (V3-H.2)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  });
  const loginIntegration = integrateLoginRoute(app, deps.login || { env: deps.env });
  const financialIntegration = integrateFinancialRoutes(app, deps.financial || { env: deps.env });
  const dashboardApiKey = deps.dashboardApiKey !== undefined ? deps.dashboardApiKey : (deps.env || process.env).DASHBOARD_API_KEY;
  app.use('/api', (req, res, next) => {
    if (!dashboardApiKey) return next();
    const key = req.headers['x-api-key'] || req.query._k;
    if (key !== dashboardApiKey) return res.status(401).json({ error: 'unauthorized' });
    return next();
  });
  app.all('/api', (req, res) => res.status(200).json({ legacy: true, path: req.path }));
  app.all('/api/*', (req, res) => res.status(200).json({ legacy: true, path: req.path }));
  app.get('/health', (_req, res) => res.status(200).json({ ok: true }));
  return { app, loginIntegration, financialIntegration };
}

module.exports = {
  LOGIN_HTTP_FLAG,
  FLAG_ENABLED_VALUE,
  LOGIN_PATH,
  isLoginHttpEnabled,
  integrateLoginRoute,
  createAuthV2IntegrationApp,
};
