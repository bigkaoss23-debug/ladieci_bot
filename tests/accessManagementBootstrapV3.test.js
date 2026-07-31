'use strict';
// Access Control V3 -- Block V3-H: real-Express bootstrap-level tests for the runtime
// gate (flag off/on), route mounting, and the auth boundary, using REAL jwt.js (a real
// HS256 secret set below, before requiring anything) driving createAccessManagementIntegrationApp
// with fake V3-B/C/D/E services (no DB). Run: node tests/accessManagementBootstrapV3.test.js
//
// Mirrors the in-memory HTTP-injection technique already established in
// tests/financialHttpIntegration.test.js -- a real Express app, real body-parser, real
// http.ServerResponse, no network port, no DB.

const crypto = require('crypto');
process.env.AUTH_JWT_SECRET_B64URL = crypto.randomBytes(32).toString('base64url');

const http = require('http');
const { Socket } = require('net');
let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

const { createAccessManagementIntegrationApp, ACCESS_MANAGEMENT_HTTP_FLAG } = require('../src/auth/accessManagementHttpIntegrationV3');
const { ROUTES } = require('../src/auth/accessManagementHttpHandlersV3');
const jwtMod = require('../src/auth/jwt');

function inject(app, { method = 'GET', url = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve) => {
    const req = new http.IncomingMessage(new Socket());
    req.method = method; req.url = url; req.headers = {};
    for (const k of Object.keys(headers)) req.headers[k.toLowerCase()] = headers[k];
    if (body != null && req.headers['content-length'] === undefined) req.headers['content-length'] = String(Buffer.byteLength(body));
    const res = new http.ServerResponse(req);
    const chunks = [];
    res.write = (c) => { if (c) chunks.push(Buffer.from(c)); return true; };
    res.end = (c) => { if (c) chunks.push(Buffer.from(c)); const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch (_) { /* non-json */ } resolve({ status: res.statusCode, text, json }); };
    app(req, res);
    if (body != null) req.push(Buffer.from(body));
    req.push(null);
  });
}

const WS = 'ws-1';
const ACTORS = { owner: { actor: 'owner', role: 'admin', active: true, session_version: 5, workspace_id: WS } };
function fakeGetAuthoritativeActor(overrides = {}) {
  const table = { ...ACTORS, ...overrides };
  return async (actor) => (table[actor] ? { ...table[actor] } : null);
}
function fakeHttpDao(getAuthoritativeActor) {
  const store = new Map();
  return {
    getAuthoritativeActor: getAuthoritativeActor || fakeGetAuthoritativeActor(),
    async findAccessManagementIdempotency() { return null; },
    async storeAccessManagementIdempotency() { return { ok: true, conflict: false }; },
  };
}
function fakeAccessUserService() {
  const calls = [];
  return { calls, async listAccessUsers(a) { calls.push(a); return { ok: true, users: [] }; }, async getAccessUser(a) { calls.push(a); return { ok: true, user: { userId: a.targetActor, displayName: 'X', dbRole: 'cashier', canonicalRole: 'cashier', active: true, hasPin: false, sessionVersion: 1, createdAt: 't', updatedAt: 't' } }; }, async createAccessUser(a) { calls.push(a); return { ok: true, userId: 'u', displayName: 'X', dbRole: 'cashier', canonicalRole: 'cashier', active: true, sessionVersion: 1, createdAt: 't', updatedAt: 't' }; }, async renameAccessUser(a) { calls.push(a); return { ok: true, userId: a.targetActor, displayName: 'Y', dbRole: 'cashier', canonicalRole: 'cashier', active: true, sessionVersion: 2, updatedAt: 't' }; } };
}
function fakeRoleChangeService() { const calls = []; return { calls, async changeRole(a) { calls.push(a); return { ok: true, actor: a.targetActor, oldRole: a.expectedRole, role: a.requestedRole, sessionVersion: 2, changed: true }; } }; }
function fakeLifecycleService() {
  const calls = [];
  return {
    calls,
    async deactivateAccessUser(a) { calls.push(a); return { ok: true, userId: a.targetActor, dbRole: 'cashier', active: false, sessionVersion: 2, updatedAt: 't' }; },
    async reactivateAccessUser(a) { calls.push(a); return { ok: true, userId: a.targetActor, dbRole: 'cashier', active: true, sessionVersion: 2, updatedAt: 't' }; },
    async clearAccessUserCredential(a) { calls.push(a); return { ok: true, userId: a.targetActor, dbRole: 'cashier', active: true, sessionVersion: 2, updatedAt: 't' }; },
  };
}
function fakePinRotationService() { const calls = []; return { calls, async rotate(a) { calls.push(a); return { ok: true, actor: a.targetActor, role: 'cashier', active: true, sessionVersion: 2, failedCount: 0, lockedUntil: null, updatedAt: 't', updatedBy: a.byActor, changed: true, event: 'pin_set', onboardingCompleted: false }; } }; }
function fakeAccessUserDao() { return { calls: [], async getAccessUserForWorkspace() { return null; } }; }
const fakePinPolicy = { validateNewPinFormat: (p) => (typeof p === 'string' && /^\d{6}$/.test(p) ? { ok: true } : { ok: false }) };
const fakeFpConfig = { current: { id: 'k1', secret: Buffer.alloc(32, 7) } };
function fakeDeriveFingerprint(key, pin) { return key && typeof pin === 'string' ? { keyId: key.id, fingerprint: 'fp_' + pin } : null; }

function buildFakeDeps(overrides = {}) {
  const accessUserService = fakeAccessUserService();
  const roleChangeService = overrides.roleChangeService || fakeRoleChangeService();
  const lifecycleService = fakeLifecycleService();
  const pinRotationService = fakePinRotationService();
  const accessUserDao = fakeAccessUserDao();
  const accessManagementHttpDao = fakeHttpDao(overrides.getAuthoritativeActor);
  return {
    accessUserService, roleChangeService, lifecycleService, pinRotationService, accessUserDao,
    accessManagementHttpDao, pinPolicy: fakePinPolicy, pinFingerprintKeyConfig: fakeFpConfig,
    deriveFingerprint: fakeDeriveFingerprint, sidHash: (sid) => (sid ? 'sidhash_' + sid : null),
    logger: { info() {}, error() {} },
    // jwt intentionally NOT overridden -- real ./jwt.js, real HS256 verification.
  };
}

function ownerAuth() {
  const token = jwtMod.signToken({ role: 'admin', sub: 'owner', sv: 5, authMethod: 'actor_pin' });
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  const stepUpProof = jwtMod.signStepUpProof({ actor: 'owner', role: 'admin', sv: 5, sid: payload.sid, authMethod: 'actor_pin' });
  return { token, stepUpProof };
}

(async () => {
  assert('AUTH_JWT_SECRET_B64URL accepted by the real jwt module', jwtMod.isReady() === true);
  assert('canonical flag name matches', ACCESS_MANAGEMENT_HTTP_FLAG === 'AUTH_V3_ACCESS_MANAGEMENT_HTTP_ENABLED');

  // ═══════════ FLAG OFF (default) ═══════════
  {
    const { app, integration } = createAccessManagementIntegrationApp({ env: {}, ...buildFakeDeps() });
    assert('flag off: integration reports enabled=false', integration.enabled === false);
    const health = await inject(app, { method: 'GET', url: '/health' });
    assert('flag off: health still succeeds', health.status === 200 && health.json.ok === true);
    const r = await inject(app, { method: 'GET', url: '/api/auth/v3/access-users' });
    assert('flag off: GET /api/auth/v3/access-users -> route absent (Express default 404, not the V3 401 shape)',
      r.status === 404 && !(r.json && r.json.code));
    const r2 = await inject(app, { method: 'GET', url: '/api/auth/v3/access-users/owner' });
    assert('flag off: GET /api/auth/v3/access-users/:actor -> route absent', r2.status === 404);
    const r3 = await inject(app, { method: 'PATCH', url: '/api/auth/v3/access-users/owner/role', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert('flag off: PATCH .../role -> route absent (no writer reachable)', r3.status === 404);
  }
  for (const nearMiss of ['1', 'TRUE', 'True', 'yes', ' true', 'true ', 'false']) {
    const { integration } = createAccessManagementIntegrationApp({ env: { AUTH_V3_ACCESS_MANAGEMENT_HTTP_ENABLED: nearMiss }, ...buildFakeDeps() });
    assert(`flag "${nearMiss}" -> disabled (route absent)`, integration.enabled === false);
  }

  // ═══════════ FLAG ON ═══════════
  {
    const deps = buildFakeDeps();
    const { app, integration } = createAccessManagementIntegrationApp({ env: { AUTH_V3_ACCESS_MANAGEMENT_HTTP_ENABLED: 'true' }, ...deps });
    assert('flag on: integration reports enabled=true', integration.enabled === true);
    assert('flag on: all 9 routes registered exactly once', integration.routes.length === 9 && new Set(integration.routes.map((r) => r.method + ' ' + r.path)).size === 9);
    for (const r of ROUTES) {
      const fullPath = integration.prefix + r.path;
      assert(`flag on: route table includes ${r.method.toUpperCase()} ${fullPath}`, integration.routes.some((x) => x.method.toUpperCase() === r.method.toUpperCase() && x.path === fullPath));
    }

    const health = await inject(app, { method: 'GET', url: '/health' });
    assert('flag on: health still succeeds', health.status === 200);

    // missing auth
    const noAuth = await inject(app, { method: 'GET', url: '/api/auth/v3/access-users' });
    assert('flag on: GET without auth -> canonical 401 AUTH_UNAUTHENTICATED (V3 shape, not Express 404)', noAuth.status === 401 && noAuth.json && noAuth.json.code === 'AUTH_UNAUTHENTICATED');

    // malformed token
    const malformed = await inject(app, { method: 'GET', url: '/api/auth/v3/access-users', headers: { authorization: 'Bearer not-a-real-token' } });
    assert('flag on: malformed bearer token -> 401, safely rejected', malformed.status === 401 && malformed.json && malformed.json.code === 'AUTH_UNAUTHENTICATED');

    // owner-only read enforced (non-owner role rejected)
    const nonOwnerToken = jwtMod.signToken({ role: 'rider', sub: 'rider', sv: 1, authMethod: 'actor_pin' });
    const depsNonOwner = buildFakeDeps({ getAuthoritativeActor: fakeGetAuthoritativeActor({ rider: { actor: 'rider', role: 'rider', active: true, session_version: 1, workspace_id: WS } }) });
    const { app: appNonOwner } = createAccessManagementIntegrationApp({ env: { AUTH_V3_ACCESS_MANAGEMENT_HTTP_ENABLED: 'true' }, ...depsNonOwner });
    const nonOwnerRes = await inject(appNonOwner, { method: 'GET', url: '/api/auth/v3/access-users', headers: { authorization: 'Bearer ' + nonOwnerToken } });
    assert('flag on: non-owner role rejected on a read route (AUTH_FORBIDDEN_ROLE, 403)', nonOwnerRes.status === 403 && nonOwnerRes.json.code === 'AUTH_FORBIDDEN_ROLE');

    // owner read succeeds
    const auth = ownerAuth();
    const ownerListRes = await inject(app, { method: 'GET', url: '/api/auth/v3/access-users', headers: { authorization: 'Bearer ' + auth.token } });
    assert('flag on: owner GET list succeeds (200, real service invoked)', ownerListRes.status === 200 && ownerListRes.json.ok === true && deps.accessUserService.calls.length === 1);

    // write without step-up rejected before any writer is called
    const noStepUpRes = await inject(app, {
      method: 'PATCH', url: '/api/auth/v3/access-users/dyn_cashier/role',
      headers: { authorization: 'Bearer ' + auth.token, 'content-type': 'application/json' },
      body: JSON.stringify({ clientRequestId: 'c1', expectedRole: 'waiter', requestedRole: 'cashier' }),
    });
    assert('flag on: write WITHOUT step-up rejected (403 AUTH_STEP_UP_REQUIRED)', noStepUpRes.status === 403 && noStepUpRes.json.code === 'AUTH_STEP_UP_REQUIRED');
    assert('flag on: no writer was called for the rejected step-up-less write', deps.roleChangeService.calls.length === 0);

    // waiter-open-table conflict mapping remains 409
    const depsConflict = buildFakeDeps({ roleChangeService: { calls: [], async changeRole() { return { ok: false, error: 'waiter_has_open_tables' }; } } });
    const { app: appConflict } = createAccessManagementIntegrationApp({ env: { AUTH_V3_ACCESS_MANAGEMENT_HTTP_ENABLED: 'true' }, ...depsConflict });
    const conflictRes = await inject(appConflict, {
      method: 'PATCH', url: '/api/auth/v3/access-users/dyn_waiter/role',
      headers: { authorization: 'Bearer ' + auth.token, 'content-type': 'application/json' },
      body: JSON.stringify({ clientRequestId: 'c2', expectedRole: 'waiter', requestedRole: 'cashier', stepUpProof: auth.stepUpProof }),
    });
    assert('flag on: waiter-open-table conflict maps to HTTP 409 AUTH_WAITER_HAS_OPEN_TABLES', conflictRes.status === 409 && conflictRes.json.code === 'AUTH_WAITER_HAS_OPEN_TABLES');

    // no secret in any captured response
    const allBodies = [noAuth.text, malformed.text, nonOwnerRes.text, ownerListRes.text, noStepUpRes.text, conflictRes.text].join('\n');
    assert('flag on: no token/secret/pin/proof value ever appears in a response body', !allBodies.includes(auth.token) && !allBodies.includes(auth.stepUpProof) && !/pin_hash|fingerprint/i.test(allBodies));
  }

  // ═══════════ ROUTE ORDER ═══════════
  {
    const deps = buildFakeDeps();
    const { app } = createAccessManagementIntegrationApp({ env: { AUTH_V3_ACCESS_MANAGEMENT_HTTP_ENABLED: 'true' }, ...deps });
    const unrelated = await inject(app, { method: 'GET', url: '/health' });
    assert('route order: unrelated /health route is unaffected', unrelated.status === 200);
    const notFound = await inject(app, { method: 'GET', url: '/api/auth/v3/does-not-exist' });
    assert('route order: a non-matching V3 sub-path still 404s normally (no catch-all interception)', notFound.status === 404);
  }

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})();
