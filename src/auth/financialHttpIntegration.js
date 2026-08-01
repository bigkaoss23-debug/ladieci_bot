'use strict';
// Access Control V2 — Block B7A4: staging-gated integration of the B7A3 financial HTTP
// boundary into the real Express application. DISABLED BY DEFAULT.
//
// The four financial routes are mounted ONLY when the environment feature flag
// AUTH_V2_FINANCIAL_HTTP_ENABLED === 'true' (exact). Absent / empty / any other value →
// disabled, with ZERO middleware side effect (no routes, no error handler registered).
// There is NO hostname / branch / NODE_ENV / Supabase-URL fallback and NO automatic
// production enablement.
//
// When enabled, integrateFinancialRoutes(app, deps) registers — BEFORE the legacy
// `/api` X-Api-Key proxy — exactly the four static POST routes behind the B7A3 JWT +
// DB-session-freshness middleware, plus a financial-scoped sanitizing JSON error handler
// (financial paths only; all other parser errors pass through unchanged). The financial
// routes use Bearer JWT, never the legacy X-Api-Key.

const express = require('express');
const {
  registerFinancialRoutes, financialJsonErrorHandler, DEFAULT_PREFIX, JSON_BODY_LIMIT,
} = require('./financialHttpHandlers');

const FINANCIAL_HTTP_FLAG = 'AUTH_V2_FINANCIAL_HTTP_ENABLED';
const FLAG_ENABLED_VALUE = 'true'; // the ONLY accepted true value (exact match)

// Enabled ONLY by an exact-match staging env var. Fail-closed on absent/empty/any other
// value; never derives enablement from host/branch/NODE_ENV/Supabase URL.
function isFinancialHttpEnabled(env) {
  const e = env || {};
  return e[FINANCIAL_HTTP_FLAG] === FLAG_ENABLED_VALUE;
}

// Build the default real financial service (real DAO + B3 ip hashing). Required lazily
// so a DISABLED app never constructs it and tests can inject a fake service instead.
function buildDefaultService() {
  const { createFinancialDao } = require('./financialDao');
  const { createFinancialService } = require('./financialService');
  const { ipHash } = require('./ipSecurity');
  return createFinancialService({ dao: createFinancialDao(), ipHash });
}

// Mount the financial boundary onto an existing Express app. Returns { enabled, prefix,
// routes }. When disabled this is a strict no-op (returns enabled:false, mounts nothing).
// deps: { env?, service?, verifyToken?, getActor?, sessionAuthority?, logger? }.
function integrateFinancialRoutes(app, deps = {}) {
  if (!app || typeof app.post !== 'function' || typeof app.use !== 'function') {
    throw new Error('integrateFinancialRoutes: express app required');
  }
  const env = deps.env || process.env;
  if (!isFinancialHttpEnabled(env)) {
    return Object.freeze({ enabled: false, prefix: DEFAULT_PREFIX, routes: Object.freeze([]) });
  }
  const service = deps.service || buildDefaultService();
  const reg = registerFinancialRoutes(app, {
    service,
    verifyToken: deps.verifyToken,       // default (jwt.verifyToken) resolved downstream
    getActor: deps.getActor,             // default (dao.getActor) resolved downstream
    sessionAuthority: deps.sessionAuthority,
    logger: deps.logger,
  });
  // Financial-scoped sanitizing JSON error handler: catches parser (malformed/oversize)
  // errors for the financial paths ONLY and converts them to {ok:false,code} with no
  // stack/raw body; every other path's parser error is passed through unchanged so the
  // legacy application behaviour is not altered. Registered AFTER the routes so it sits
  // after the global parser in the stack and actually receives its next(err).
  app.use(function financialScopedJsonError(err, req, res, next) {
    const p = req && typeof req.path === 'string' ? req.path : '';
    if (err && p.startsWith(DEFAULT_PREFIX + '/')) {
      return financialJsonErrorHandler(err, req, res, next);
    }
    return next(err);
  });
  return Object.freeze({ enabled: true, prefix: reg.prefix, routes: reg.routes });
}

// In-memory real-stack harness: assembles the SAME middleware chain the real app uses
// around the financial boundary (global express.json → CORS/OPTIONS mirror → gated
// financial integration → legacy /api X-Api-Key guard mirror → legacy /api echo →
// health), WITHOUT listening on a port. Used by integration tests to exercise the real
// parser + CORS + mount order with injected financial deps.
function createFinancialIntegrationApp(deps = {}) {
  const app = express();
  app.use(express.json());                                  // identical global parser (default 100kb)
  app.use((req, res, next) => {                             // CORS mirror of index.js (V3-H.2)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  });
  const integration = integrateFinancialRoutes(app, deps); // gated; BEFORE the legacy /api guard
  const dashboardApiKey = deps.dashboardApiKey !== undefined
    ? deps.dashboardApiKey
    : (deps.env || process.env).DASHBOARD_API_KEY;
  app.use('/api', (req, res, next) => {                     // legacy X-Api-Key guard mirror
    if (!dashboardApiKey) return next();
    const key = req.headers['x-api-key'] || req.query._k;
    if (key !== dashboardApiKey) return res.status(401).json({ error: 'unauthorized' });
    return next();
  });
  // legacy /api echo (stand-in for the real legacy handlers) — marks "reached legacy".
  app.all('/api', (req, res) => res.status(200).json({ legacy: true, path: req.path }));
  app.all('/api/*', (req, res) => res.status(200).json({ legacy: true, path: req.path }));
  app.get('/health', (_req, res) => res.status(200).json({ ok: true }));
  return { app, integration };
}

module.exports = {
  FINANCIAL_HTTP_FLAG,
  FLAG_ENABLED_VALUE,
  JSON_BODY_LIMIT,
  isFinancialHttpEnabled,
  integrateFinancialRoutes,
  createFinancialIntegrationApp,
};
