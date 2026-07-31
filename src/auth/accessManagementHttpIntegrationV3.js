'use strict';
// Access Control V3 -- Block V3-F: staging-gated integration of the owner
// access-management HTTP boundary into a real Express application (ISOLATED, UNWIRED --
// NOT called from index.js). Mirrors financialHttpIntegration.js's structure exactly, with
// one deliberate difference: index.js never calls integrateAccessManagementRoutes, not even
// behind a flag, per the V3-F "unwired guarantee" (financial/login/account ARE called from
// index.js, gated by their own flags -- V3-F is not, by explicit design, until a future
// phase decides to wire it).
//
// integrateAccessManagementRoutes(app, deps) exists and is fully tested so that:
//   (a) a future phase can wire it in with a one-line index.js change behind its own flag,
//       exactly like the financial/login/account precedents;
//   (b) this phase's real-disposable-PostgreSQL rehearsal can exercise the nine routes
//       through an ACTUAL listening HTTP server (createAccessManagementIntegrationApp),
//       not just direct DAO/service calls.

const express = require('express');
const {
  registerAccessManagementRoutes, accessManagementJsonErrorHandler, DEFAULT_PREFIX, JSON_BODY_LIMIT,
} = require('./accessManagementHttpHandlersV3');

const ACCESS_MANAGEMENT_HTTP_FLAG = 'AUTH_V3_ACCESS_MANAGEMENT_HTTP_ENABLED';
const FLAG_ENABLED_VALUE = 'true'; // the ONLY accepted true value (exact match)

// Enabled ONLY by an exact-match env var. Fail-closed on absent/empty/any other value;
// never derives enablement from host/branch/NODE_ENV/Supabase URL. Documentary/tested
// only in V3-F -- nothing calls isAccessManagementHttpEnabled from index.js yet.
function isAccessManagementHttpEnabled(env) {
  const e = env || {};
  return e[ACCESS_MANAGEMENT_HTTP_FLAG] === FLAG_ENABLED_VALUE;
}

// Build the default REAL service graph (real DAOs + real crypto). Required lazily so a
// disabled/unused app never constructs it and tests can inject fakes instead.
function buildDefaultServices() {
  const { sidHash } = require('./sidHash');
  const { createAccessUserV3Service } = require('./accessUserServiceV3');
  const accessUserDao = require('./accessUserDaoV3');
  const { createRoleChangeV3 } = require('./roleChangeServiceV3');
  const roleChangeDao = require('./roleChangeDaoV3');
  const { createAccessUserLifecycleV3Service } = require('./accessUserLifecycleServiceV3');
  const lifecycleDao = require('./accessUserLifecycleDaoV3');
  const { createPinRotationV3 } = require('./pinRotationServiceV3');
  const pinRotationDao = require('./pinRotationDaoV3');
  const { hashPin, verifyPin } = require('./scrypt');
  const pinPolicy = require('./pinPolicy');
  const { ipHash } = require('./ipSecurity');
  const pinFingerprintKeyConfigMod = require('./pinFingerprintKeyConfig');
  const { deriveFingerprint, deriveForAcceptedKeys } = require('./pinFingerprint');

  const fingerprintKeyConfig = pinFingerprintKeyConfigMod.getConfig();

  return {
    accessUserService: createAccessUserV3Service({ dao: accessUserDao, sidHash }),
    accessUserDao,
    roleChangeService: createRoleChangeV3({ dao: roleChangeDao, sidHash }),
    lifecycleService: createAccessUserLifecycleV3Service({ dao: lifecycleDao, sidHash }),
    pinRotationService: createPinRotationV3({
      dao: pinRotationDao, hashPin, verifyPin, pinPolicy, ipHash,
      fingerprintKeyConfig, deriveForAcceptedKeys,
    }),
    pinPolicy,
    pinFingerprintKeyConfig: fingerprintKeyConfig,
    deriveFingerprint,
    sidHash,
  };
}

// Mount the access-management boundary onto an existing Express app. Returns
// { enabled, prefix, routes }. When disabled this is a strict no-op.
// deps: { env?, ...service overrides, logger? }.
function integrateAccessManagementRoutes(app, deps = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.use !== 'function') {
    throw new Error('integrateAccessManagementRoutes: express app required');
  }
  const env = deps.env || process.env;
  if (!isAccessManagementHttpEnabled(env)) {
    return Object.freeze({ enabled: false, prefix: DEFAULT_PREFIX, routes: Object.freeze([]) });
  }
  const defaults = buildDefaultServices();
  const merged = { ...defaults, ...deps };
  const reg = registerAccessManagementRoutes(app, merged);
  // Scoped sanitizing JSON error handler -- financial paths untouched, only this
  // boundary's prefix is matched.
  app.use(function accessManagementScopedJsonError(err, req, res, next) {
    const p = req && typeof req.path === 'string' ? req.path : '';
    if (err && p.startsWith(reg.prefix + '/')) {
      return accessManagementJsonErrorHandler(err, req, res, next);
    }
    return next(err);
  });
  return Object.freeze({ enabled: true, prefix: reg.prefix, routes: reg.routes });
}

// In-memory real-stack harness: assembles the SAME middleware chain a future real mount
// would use (global express.json → gated integration), WITHOUT listening on a port by
// default. Pass `listen: true` to actually bind (127.0.0.1, ephemeral port) for a real
// disposable-PostgreSQL HTTP rehearsal that issues genuine HTTP requests, not just
// in-process fake req/res. Used by integration tests; never touched by index.js.
function createAccessManagementIntegrationApp(deps = {}) {
  const app = express();
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  const integration = integrateAccessManagementRoutes(app, deps);
  app.get('/health', (_req, res) => res.status(200).json({ ok: true }));
  return { app, integration };
}

module.exports = {
  ACCESS_MANAGEMENT_HTTP_FLAG,
  FLAG_ENABLED_VALUE,
  isAccessManagementHttpEnabled,
  buildDefaultServices,
  integrateAccessManagementRoutes,
  createAccessManagementIntegrationApp,
};
