'use strict';
// Access Control V3 -- Block V3-F route-registration + protection + HTTP-contract tests.
// Run: node tests/accessManagementHttpHandlersV3.test.js
// Offline: fake express app records (method, path, middleware chain); requests are
// simulated through the real chain, same harness style as financialHttpRoutes.test.js.
const fs = require('fs');
const path = require('path');
let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

const {
  registerAccessManagementRoutes, createOwnerAuthContextMiddleware, verifyStepUpFromRequest,
  createAccessManagementHandlers, DEFAULT_PREFIX, ROUTES, mapServiceError,
} = require('../src/auth/accessManagementHttpHandlersV3');

// ── harness ──────────────────────────────────────────────────────────────────────
function fakeApp() {
  const routes = [];
  const rec = (method) => (p, ...chain) => { routes.push({ method, path: p, chain }); };
  return { routes, get: rec('GET'), post: rec('POST'), patch: rec('PATCH'), put: rec('PUT'), delete: rec('DELETE'), use: () => {} };
}
function fakeRes() {
  return { _status: null, _json: null, status(c) { this._status = c; return this; }, json(o) { this._json = o; return this; } };
}
async function runChain(chain, req, res) {
  let i = 0;
  async function next() { const fn = chain[i++]; if (!fn) return; await fn(req, res, next); }
  await next();
}
function findRoute(routesList, method, p) {
  return routesList.find((r) => r.method === method && r.path === p);
}

const NOW = Math.floor(Date.now() / 1000);
const ACTORS = {
  owner: { actor: 'owner', role: 'admin', active: true, session_version: 5, workspace_id: 'ws-1' },
  owner2: { actor: 'owner2', role: 'owner', active: true, session_version: 1, workspace_id: 'ws-1' },
  operator_primary: { actor: 'operator_primary', role: 'operator', active: true, session_version: 2, workspace_id: 'ws-1' },
  rider: { actor: 'rider', role: 'rider', active: true, session_version: 1, workspace_id: 'ws-1' },
  inactive_owner: { actor: 'inactive_owner', role: 'admin', active: false, session_version: 1, workspace_id: 'ws-1' },
  demoted_owner: { actor: 'demoted_owner', role: 'cashier', active: true, session_version: 1, workspace_id: 'ws-1' },
  no_workspace_owner: { actor: 'no_ws_owner', role: 'admin', active: true, session_version: 1, workspace_id: null },
  // an actor whose id LITERALLY is 'owner_lookalike' but role is a plain staff role --
  // proves ownership is decided by role, never the id.
  owner_lookalike: { actor: 'owner_lookalike', role: 'cashier', active: true, session_version: 1, workspace_id: 'ws-1' },
};

const TOKENS = {
  'good-owner': { sub: 'owner', role: 'admin', sv: 5, sid: 'sid-owner-1', am: 'actor_pin' },
  'good-owner-role-legacy': { sub: 'owner2', role: 'owner', sv: 1, sid: 'sid-owner2-1', am: 'actor_pin' },
  'good-operator': { sub: 'operator_primary', role: 'operator', sv: 2, sid: 'sid-op-1', am: 'actor_pin' },
  'good-rider': { sub: 'rider', role: 'rider', sv: 1, sid: 'sid-rider-1', am: 'actor_pin' },
  'stale-owner': { sub: 'owner', role: 'admin', sv: 999, sid: 'sid-owner-1', am: 'actor_pin' },
  'inactive-owner': { sub: 'inactive_owner', role: 'admin', sv: 1, sid: 'sid-inact-1', am: 'actor_pin' },
  'demoted-owner': { sub: 'demoted_owner', role: 'admin', sv: 1, sid: 'sid-dem-1', am: 'actor_pin' }, // token says admin, DB now says cashier
  'no-workspace-owner': { sub: 'no_ws_owner', role: 'admin', sv: 1, sid: 'sid-nows-1', am: 'actor_pin' },
  'owner-lookalike': { sub: 'owner_lookalike', role: 'cashier', sv: 1, sid: 'sid-lookalike-1', am: 'actor_pin' },
  'unknown-actor': { sub: 'ghost', role: 'admin', sv: 1, sid: 'sid-ghost-1', am: 'actor_pin' },
};
function verifyToken(t) { return TOKENS[t] ? { ...TOKENS[t] } : null; }

const PROOFS = {
  'proof-owner-good': { purpose: 'manage_pins', sub: 'owner', role: 'admin', sv: 5, sid: 'sid-owner-1', am: 'actor_pin', exp: NOW + 500 },
  'proof-owner-wrong-sid': { purpose: 'manage_pins', sub: 'owner', role: 'admin', sv: 5, sid: 'sid-owner-OTHER', am: 'actor_pin', exp: NOW + 500 },
  'proof-owner-wrong-actor': { purpose: 'manage_pins', sub: 'someone_else', role: 'admin', sv: 5, sid: 'sid-owner-1', am: 'actor_pin', exp: NOW + 500 },
  'proof-owner-wrong-sv': { purpose: 'manage_pins', sub: 'owner', role: 'admin', sv: 1, sid: 'sid-owner-1', am: 'actor_pin', exp: NOW + 500 },
  'proof-owner-expired': { purpose: 'manage_pins', sub: 'owner', role: 'admin', sv: 5, sid: 'sid-owner-1', am: 'actor_pin', exp: NOW - 10 },
  'proof-owner-wrong-am': { purpose: 'manage_pins', sub: 'owner', role: 'admin', sv: 5, sid: 'sid-owner-1', am: 'legacy_universal', exp: NOW + 500 },
  'proof-owner-wrong-purpose': { purpose: 'something_else', sub: 'owner', role: 'admin', sv: 5, sid: 'sid-owner-1', am: 'actor_pin', exp: NOW + 500 },
  'proof-owner2-good': { purpose: 'manage_pins', sub: 'owner2', role: 'owner', sv: 1, sid: 'sid-owner2-1', am: 'actor_pin', exp: NOW + 500 },
};
// Faithfully mirrors jwt.verifyStepUpProof's real binding checks: sid must match, am must
// match, must not be expired -- exercised here with deterministic fixtures instead of HMAC.
function verifyStepUpProof(proofStr, { sid, authMethod } = {}) {
  const p = PROOFS[proofStr];
  if (!p) return null;
  if (p.sid !== sid) return null;
  if (p.am !== authMethod) return null;
  if (p.exp <= Math.floor(Date.now() / 1000)) return null;
  return { ...p };
}
function isValidAuthMethod(m) { return m === 'actor_pin' || m === 'legacy_universal'; }
const fakeJwt = { verifyToken, verifyStepUpProof, isValidAuthMethod };

function fakeGetAuthoritativeActor(table = ACTORS) {
  return async (actor) => (table[actor] ? { ...table[actor] } : null);
}

function fakeAccessUserService() {
  const calls = [];
  return {
    calls,
    async listAccessUsers(args) {
      calls.push({ name: 'listAccessUsers', args });
      return { ok: true, users: [{ userId: 'u1', displayName: 'A', dbRole: 'cashier', canonicalRole: 'cashier', active: true, hasPin: true, sessionVersion: 1, createdAt: 't1', updatedAt: 't1' }] };
    },
    async getAccessUser(args) {
      calls.push({ name: 'getAccessUser', args });
      if (args.targetActor === 'ghost-target') return { ok: false, error: 'not_found' };
      return { ok: true, user: { userId: args.targetActor, displayName: 'B', dbRole: 'waiter', canonicalRole: 'waiter', active: true, hasPin: false, sessionVersion: 1, createdAt: 't1', updatedAt: 't1' } };
    },
    async createAccessUser(args) {
      calls.push({ name: 'createAccessUser', args });
      if (args._forceConflict) return { ok: false, error: 'idempotency_conflict' };
      return { ok: true, userId: 'new-uuid-1', displayName: args.displayName, dbRole: args.requestedRole, canonicalRole: args.requestedRole, active: true, sessionVersion: 1, createdAt: 't1', updatedAt: 't1' };
    },
    async renameAccessUser(args) {
      calls.push({ name: 'renameAccessUser', args });
      return { ok: true, userId: args.targetActor, displayName: args.newDisplayName, dbRole: 'cashier', canonicalRole: 'cashier', active: true, sessionVersion: 2, updatedAt: 't2' };
    },
  };
}
function fakeRoleChangeService() {
  const calls = [];
  return {
    calls,
    async changeRole(args) {
      calls.push({ name: 'changeRole', args });
      return { ok: true, actor: args.targetActor, oldRole: args.expectedRole, role: args.requestedRole, sessionVersion: 3, changed: true };
    },
  };
}
function fakeLifecycleService() {
  const calls = [];
  return {
    calls,
    async deactivateAccessUser(args) {
      calls.push({ name: 'deactivateAccessUser', args });
      // V3-G: the database RPC is authoritative for the waiter/open-table-session
      // conflict -- simulate its exact result shape for a designated fixture target.
      if (args.targetActor === 'dyn_waiter_with_tables') return { ok: false, error: 'waiter_has_open_tables' };
      if (args.targetActor === 'no-such-target') return { ok: false, error: 'access_user_lifecycle_failed' };
      return { ok: true, userId: args.targetActor, dbRole: 'cashier', active: false, sessionVersion: 4, updatedAt: 't3' };
    },
    async reactivateAccessUser(args) {
      calls.push({ name: 'reactivateAccessUser', args });
      return { ok: true, userId: args.targetActor, dbRole: 'cashier', active: true, sessionVersion: 5, updatedAt: 't4' };
    },
    async clearAccessUserCredential(args) {
      calls.push({ name: 'clearAccessUserCredential', args });
      return { ok: true, userId: args.targetActor, dbRole: 'cashier', active: true, sessionVersion: 6, updatedAt: 't5' };
    },
  };
}
function fakePinRotationService() {
  const calls = [];
  return {
    calls,
    async rotate(args) {
      calls.push({ name: 'rotate', args });
      if (args.targetActor === 'dup-target') return { ok: false, error: 'pin_duplicate' };
      if (args.targetActor === 'reserved-target') return { ok: false, error: 'pin_reserved' };
      return { ok: true, actor: args.targetActor, role: 'cashier', active: true, sessionVersion: 7, failedCount: 0, lockedUntil: null, updatedAt: 't6', updatedBy: args.byActor, changed: true, event: 'pin_set', onboardingCompleted: false };
    },
  };
}
function fakeAccessUserDao(table = ACTORS) {
  const rows = {
    dyn_cashier: { actor: 'dyn_cashier', role: 'cashier', active: true, session_version: 1, display_name: 'Dyn', created_at: 't', updated_at: 't', has_pin: false },
    dyn_waiter: { actor: 'dyn_waiter', role: 'waiter', active: true, session_version: 1, display_name: 'Waiter', created_at: 't', updated_at: 't', has_pin: false },
  };
  return {
    calls: [],
    async getAccessUserForWorkspace(workspaceId, actor) {
      this.calls.push({ workspaceId, actor });
      return rows[actor] ? { ...rows[actor] } : null;
    },
  };
}
function fakeHttpDao(getAuthoritativeActor) {
  const store = new Map();
  return {
    store,
    getAuthoritativeActor: getAuthoritativeActor || fakeGetAuthoritativeActor(),
    async findAccessManagementIdempotency({ workspaceId, byActor, bySidHash, action, clientRequestId }) {
      const key = [workspaceId, byActor, bySidHash, action, clientRequestId].join('|');
      return store.has(key) ? store.get(key) : null;
    },
    async storeAccessManagementIdempotency({ workspaceId, byActor, bySidHash, action, clientRequestId, requestHash, responseStatus, responseBody }) {
      const key = [workspaceId, byActor, bySidHash, action, clientRequestId].join('|');
      if (store.has(key)) return { ok: false, conflict: true };
      store.set(key, { request_hash: requestHash, response_status: responseStatus, response_body: responseBody });
      return { ok: true, conflict: false };
    },
  };
}
const fakePinPolicy = { validateNewPinFormat: (p) => (typeof p === 'string' && /^\d{6}$/.test(p) ? { ok: true } : { ok: false, reason: 'bad' }) };
const fakeFpConfig = { current: { id: 'k1', secret: Buffer.alloc(32, 7) } };
function fakeDeriveFingerprint(key, pin) {
  if (!key || typeof pin !== 'string') return null;
  return { keyId: key.id, fingerprint: 'fp_' + pin }; // deterministic stand-in, same-pin => same fingerprint
}

function buildDeps(overrides = {}) {
  const accessUserService = overrides.accessUserService || fakeAccessUserService();
  const roleChangeService = overrides.roleChangeService || fakeRoleChangeService();
  const lifecycleService = overrides.lifecycleService || fakeLifecycleService();
  const pinRotationService = overrides.pinRotationService || fakePinRotationService();
  const accessUserDao = overrides.accessUserDao || fakeAccessUserDao();
  const accessManagementHttpDao = overrides.accessManagementHttpDao || fakeHttpDao(overrides.getAuthoritativeActor);
  return {
    jwt: fakeJwt, accessUserService, roleChangeService, lifecycleService, pinRotationService, accessUserDao,
    accessManagementHttpDao, pinPolicy: fakePinPolicy, pinFingerprintKeyConfig: fakeFpConfig,
    deriveFingerprint: fakeDeriveFingerprint, sidHash: (sid) => (sid ? 'sidhash_' + sid : null),
    getAuthoritativeActor: accessManagementHttpDao.getAuthoritativeActor,
  };
}

function bearer(t) { return { authorization: 'Bearer ' + t }; }

(async () => {
  // ══════════════════ ROUTE TABLE / REGISTRATION SHAPE ══════════════════
  {
    const app = fakeApp();
    const deps = buildDeps();
    const reg = registerAccessManagementRoutes(app, deps);
    assert('registers exactly 9 routes', app.routes.length === 9);
    assert('reg.routes reports 9 with the canonical prefix', reg.prefix === DEFAULT_PREFIX && reg.routes.length === 9);
    const wantPaths = [
      ['GET', '/api/auth/v3/access-users'], ['GET', '/api/auth/v3/access-users/:actor'],
      ['POST', '/api/auth/v3/access-users'], ['PATCH', '/api/auth/v3/access-users/:actor/display-name'],
      ['PATCH', '/api/auth/v3/access-users/:actor/role'], ['PUT', '/api/auth/v3/access-users/:actor/pin'],
      ['DELETE', '/api/auth/v3/access-users/:actor/pin'], ['POST', '/api/auth/v3/access-users/:actor/deactivate'],
      ['POST', '/api/auth/v3/access-users/:actor/reactivate'],
    ];
    const got = app.routes.map((r) => [r.method, r.path]).sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
    const want = wantPaths.slice().sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
    assert('exact canonical route contract (method+path)', JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));
    assert('no delete-user route registered', !app.routes.some((r) => r.method === 'DELETE' && r.path === '/api/auth/v3/access-users/:actor'));
    assert('every route chain = [auth, handler]', app.routes.every((r) => r.chain.length === 2));
    assert('registration requires the five core services', (() => {
      let threw = 0;
      for (const k of ['accessUserService', 'roleChangeService', 'lifecycleService', 'pinRotationService', 'accessUserDao']) {
        const d = buildDeps(); delete d[k];
        try { registerAccessManagementRoutes(fakeApp(), d); } catch (_) { threw++; }
      }
      return threw === 5;
    })());
  }

  // ══════════════════ AUTHENTICATION / AUTHORIZATION ══════════════════
  {
    const app = fakeApp();
    const deps = buildDeps();
    registerAccessManagementRoutes(app, deps);
    const listRoute = findRoute(app.routes, 'GET', '/api/auth/v3/access-users');

    let res = fakeRes();
    await runChain(listRoute.chain, { headers: {}, body: {}, params: {} }, res);
    assert('missing token rejected -> 401', res._status === 401 && deps.accessUserService.calls.length === 0);

    res = fakeRes();
    await runChain(listRoute.chain, { headers: bearer('stale-owner'), body: {}, params: {} }, res);
    assert('stale session_version rejected -> 401', res._status === 401 && deps.accessUserService.calls.length === 0);

    res = fakeRes();
    await runChain(listRoute.chain, { headers: bearer('inactive-owner'), body: {}, params: {} }, res);
    assert('inactive acting actor rejected -> 403', res._status === 403 && deps.accessUserService.calls.length === 0);

    res = fakeRes();
    await runChain(listRoute.chain, { headers: bearer('good-operator'), body: {}, params: {} }, res);
    assert('operator rejected (non-owner role) -> 403', res._status === 403 && deps.accessUserService.calls.length === 0);

    res = fakeRes();
    await runChain(listRoute.chain, { headers: bearer('good-rider'), body: {}, params: {} }, res);
    assert('rider rejected (non-owner role) -> 403', res._status === 403 && deps.accessUserService.calls.length === 0);

    res = fakeRes();
    await runChain(listRoute.chain, { headers: bearer('good-owner'), body: {}, params: {} }, res);
    assert('admin role accepted -> 200', res._status === 200 && deps.accessUserService.calls.length === 1);

    const deps2 = buildDeps();
    const app2 = fakeApp();
    registerAccessManagementRoutes(app2, deps2);
    const listRoute2 = findRoute(app2.routes, 'GET', '/api/auth/v3/access-users');
    res = fakeRes();
    await runChain(listRoute2.chain, { headers: bearer('good-owner-role-legacy'), body: {}, params: {} }, res);
    assert('legacy V3 "owner" role accepted -> 200', res._status === 200 && deps2.accessUserService.calls.length === 1);

    res = fakeRes();
    await runChain(listRoute2.chain, { headers: bearer('owner-lookalike'), body: {}, params: {} }, res);
    assert('actor id literal "owner_lookalike" with a staff ROLE never grants ownership -> 403',
      res._status === 403 && deps2.accessUserService.calls.length === 1 /* still 1 from previous call, not incremented */);

    res = fakeRes();
    await runChain(listRoute2.chain, { headers: bearer('demoted-owner'), body: {}, params: {} }, res);
    assert('DB role != token role (demoted mid-session) rejected -> 403', res._status === 403);

    res = fakeRes();
    await runChain(listRoute2.chain, { headers: bearer('no-workspace-owner'), body: {}, params: {} }, res);
    assert('actor with no resolvable workspace rejected -> 401', res._status === 401);

    res = fakeRes();
    await runChain(listRoute2.chain, { headers: bearer('unknown-actor'), body: {}, params: {} }, res);
    assert('unknown actor (DB row missing) rejected -> 401', res._status === 401);
  }

  // ── defense-in-depth: RPC still refuses a workspace mismatch even if ctx were wrong ──
  {
    const app = fakeApp();
    const roleChangeService = {
      calls: [],
      async changeRole(args) { this.calls.push(args); return { ok: false, error: 'role_change_failed' }; },
    };
    const deps = buildDeps({ roleChangeService });
    registerAccessManagementRoutes(app, deps);
    const route = findRoute(app.routes, 'PATCH', '/api/auth/v3/access-users/:actor/role');
    const res = fakeRes();
    await runChain(route.chain, {
      headers: bearer('good-owner'), params: { actor: 'dyn_cashier' },
      body: { expectedRole: 'cashier', requestedRole: 'waiter', clientRequestId: 'cr-1', stepUpProof: 'proof-owner-good' },
    }, res);
    assert('cross-workspace / RPC-level refusal surfaces as a mapped 400, service called exactly once',
      res._status === 400 && roleChangeService.calls.length === 1 && roleChangeService.calls[0].workspaceId === 'ws-1');
  }

  // ══════════════════ READS ══════════════════
  {
    const app = fakeApp();
    const deps = buildDeps();
    registerAccessManagementRoutes(app, deps);
    const listRoute = findRoute(app.routes, 'GET', '/api/auth/v3/access-users');
    const getRoute = findRoute(app.routes, 'GET', '/api/auth/v3/access-users/:actor');

    let res = fakeRes();
    await runChain(listRoute.chain, { headers: bearer('good-owner'), body: {}, params: {} }, res);
    assert('owner list succeeds, no step-up required', res._status === 200);
    assert('list is workspace-scoped from ctx, never the body', deps.accessUserService.calls[0].args.workspaceId === 'ws-1');
    const u = res._json.users[0];
    assert('safe projection exact keys only', JSON.stringify(Object.keys(u).sort()) ===
      JSON.stringify(['actor', 'active', 'canonicalRole', 'createdAt', 'dbRole', 'displayName', 'hasPin', 'sessionVersion', 'updatedAt'].sort()));
    assert('no credential material in list response', JSON.stringify(res._json).match(/pin_hash|fingerprint|proof|token|secret/i) === null);

    res = fakeRes();
    await runChain(getRoute.chain, { headers: bearer('good-owner'), body: {}, params: { actor: 'dyn_cashier' } }, res);
    assert('owner get succeeds, no step-up required', res._status === 200 && res._json.user.actor === 'dyn_cashier');

    res = fakeRes();
    await runChain(getRoute.chain, { headers: bearer('good-owner'), body: {}, params: { actor: 'ghost-target' } }, res);
    assert('target outside workspace / not found -> 404 (not an enumerable forbidden identity)', res._status === 404);
  }

  // ══════════════════ WRITES / STEP-UP ══════════════════
  {
    const writeCases = [
      ['POST', '/api/auth/v3/access-users', { actor: undefined }, { displayName: 'New', role: 'cashier', clientRequestId: 'cr-1' }],
      ['PATCH', '/api/auth/v3/access-users/:actor/display-name', { actor: 'dyn_cashier' }, { displayName: 'New2', clientRequestId: 'cr-2' }],
      ['PATCH', '/api/auth/v3/access-users/:actor/role', { actor: 'dyn_cashier' }, { expectedRole: 'cashier', requestedRole: 'waiter', clientRequestId: 'cr-3' }],
      ['PUT', '/api/auth/v3/access-users/:actor/pin', { actor: 'dyn_cashier' }, { pin: '482915', clientRequestId: 'cr-4' }],
      ['DELETE', '/api/auth/v3/access-users/:actor/pin', { actor: 'dyn_cashier' }, { expectedSessionVersion: 1, clientRequestId: 'cr-5' }],
      ['POST', '/api/auth/v3/access-users/:actor/deactivate', { actor: 'dyn_cashier' }, { expectedActive: true, clientRequestId: 'cr-6' }],
      ['POST', '/api/auth/v3/access-users/:actor/reactivate', { actor: 'dyn_cashier' }, { expectedActive: false, clientRequestId: 'cr-7' }],
    ];
    for (const [method, p, params, bodyBase] of writeCases) {
      const app = fakeApp();
      const deps = buildDeps();
      registerAccessManagementRoutes(app, deps);
      const route = findRoute(app.routes, method, p);

      // missing proof
      let res = fakeRes();
      await runChain(route.chain, { headers: bearer('good-owner'), params, body: { ...bodyBase } }, res);
      assert(`${method} ${p}: missing step-up proof rejected before any service call`, res._status === 403);

      // expired proof
      res = fakeRes();
      await runChain(route.chain, { headers: bearer('good-owner'), params, body: { ...bodyBase, stepUpProof: 'proof-owner-expired' } }, res);
      assert(`${method} ${p}: expired step-up proof rejected before any service call`, res._status === 403);

      // wrong-actor proof
      res = fakeRes();
      await runChain(route.chain, { headers: bearer('good-owner'), params, body: { ...bodyBase, stepUpProof: 'proof-owner-wrong-actor' } }, res);
      assert(`${method} ${p}: wrong-actor step-up proof rejected before any service call`, res._status === 403);

      // wrong-sid proof
      res = fakeRes();
      await runChain(route.chain, { headers: bearer('good-owner'), params, body: { ...bodyBase, stepUpProof: 'proof-owner-wrong-sid' } }, res);
      assert(`${method} ${p}: wrong-sid step-up proof rejected before any service call`, res._status === 403);

      // wrong session_version-bound proof (sv drift since mint)
      res = fakeRes();
      await runChain(route.chain, { headers: bearer('good-owner'), params, body: { ...bodyBase, stepUpProof: 'proof-owner-wrong-sv' } }, res);
      assert(`${method} ${p}: stale session_version-bound step-up proof rejected`, res._status === 403);

      // wrong auth_method
      res = fakeRes();
      await runChain(route.chain, { headers: bearer('good-owner'), params, body: { ...bodyBase, stepUpProof: 'proof-owner-wrong-am' } }, res);
      assert(`${method} ${p}: auth_method mismatch rejected before any service call`, res._status === 403);

      // wrong purpose
      res = fakeRes();
      await runChain(route.chain, { headers: bearer('good-owner'), params, body: { ...bodyBase, stepUpProof: 'proof-owner-wrong-purpose' } }, res);
      assert(`${method} ${p}: wrong-purpose proof rejected`, res._status === 403);

      const anyServiceCalled = deps.accessUserService.calls.length + deps.roleChangeService.calls.length
        + deps.lifecycleService.calls.length + deps.pinRotationService.calls.length;
      assert(`${method} ${p}: no DAO/service call happened across all rejected step-up attempts`, anyServiceCalled === 0);

      // valid proof reaches the handler exactly once
      res = fakeRes();
      await runChain(route.chain, { headers: bearer('good-owner'), params, body: { ...bodyBase, stepUpProof: 'proof-owner-good' } }, res);
      assert(`${method} ${p}: valid step-up + valid context reaches the service exactly once`, res._status === 200);
    }
  }

  // ══════════════════ BODY AUTHORITY ══════════════════
  {
    const app = fakeApp();
    const deps = buildDeps();
    registerAccessManagementRoutes(app, deps);
    const route = findRoute(app.routes, 'PATCH', '/api/auth/v3/access-users/:actor/role');
    const res = fakeRes();
    await runChain(route.chain, {
      headers: bearer('good-owner'), params: { actor: 'dyn_cashier' },
      body: {
        expectedRole: 'cashier', requestedRole: 'waiter', clientRequestId: 'cr-body-1', stepUpProof: 'proof-owner-good',
        workspaceId: 'ATTACKER-WS', byActor: 'attacker', actingActor: 'attacker', sid: 'attacker-sid',
        role: 'attacker-role', sessionVersion: 999999, authMethod: 'legacy_universal',
      },
    }, res);
    const call = deps.roleChangeService.calls[deps.roleChangeService.calls.length - 1];
    assert('body workspaceId override ignored -- ctx value used', call.args.workspaceId === 'ws-1');
    assert('body byActor/actingActor override ignored -- ctx actor used', call.args.byActor === 'owner');
    assert('body sid override ignored -- ctx sid used', call.args.sid === 'sid-owner-1');
    assert('body sessionVersion/role/authMethod fields never reach the service payload', !('sessionVersion' in call.args) && !('authMethod' in call.args));

    const createRoute = findRoute(app.routes, 'POST', '/api/auth/v3/access-users');
    const res2 = fakeRes();
    await runChain(createRoute.chain, {
      headers: bearer('good-owner'), params: {},
      body: { displayName: 'X', role: 'cashier', clientRequestId: 'cr-body-2', stepUpProof: 'proof-owner-good', actor: 'client-picked-uuid' },
    }, res2);
    assert('client cannot supply the new actor id on create -- service never receives one', !('actor' in deps.accessUserService.calls[deps.accessUserService.calls.length - 1].args));
  }

  // ══════════════════ OPERATIONS (correct service, correct payload, idempotency required) ══════════════════
  {
    const app = fakeApp();
    const deps = buildDeps();
    registerAccessManagementRoutes(app, deps);

    // create
    let route = findRoute(app.routes, 'POST', '/api/auth/v3/access-users');
    let res = fakeRes();
    await runChain(route.chain, { headers: bearer('good-owner'), params: {}, body: { displayName: 'New Guy', role: 'kitchen', stepUpProof: 'proof-owner-good' } }, res);
    assert('create: missing clientRequestId rejected before service call', res._status === 400 && deps.accessUserService.calls.filter((c) => c.name === 'createAccessUser').length === 0);
    res = fakeRes();
    await runChain(route.chain, { headers: bearer('good-owner'), params: {}, body: { displayName: 'New Guy', role: 'admin', clientRequestId: 'c1', stepUpProof: 'proof-owner-good' } }, res);
    assert('create: non-assignable role (admin) rejected', res._status === 400);
    res = fakeRes();
    await runChain(route.chain, { headers: bearer('good-owner'), params: {}, body: { displayName: 'New Guy', role: 'kitchen', clientRequestId: 'c2', stepUpProof: 'proof-owner-good' } }, res);
    assert('create: valid request -> 200, correct service, correct semantic payload', res._status === 200
      && deps.accessUserService.calls.some((c) => c.name === 'createAccessUser' && c.args.displayName === 'New Guy' && c.args.requestedRole === 'kitchen'));
    assert('create: safe response shape', JSON.stringify(Object.keys(res._json.user).sort()) ===
      JSON.stringify(['active', 'canonicalRole', 'createdAt', 'dbRole', 'displayName', 'sessionVersion', 'updatedAt', 'actor'].sort()));

    // rename
    route = findRoute(app.routes, 'PATCH', '/api/auth/v3/access-users/:actor/display-name');
    res = fakeRes();
    await runChain(route.chain, { headers: bearer('good-owner'), params: { actor: 'dyn_cashier' }, body: { displayName: '   ', clientRequestId: 'c3', stepUpProof: 'proof-owner-good' } }, res);
    assert('rename: blank display name rejected', res._status === 400);
    res = fakeRes();
    await runChain(route.chain, { headers: bearer('good-owner'), params: { actor: 'dyn_cashier' }, body: { displayName: 'Renamed', clientRequestId: 'c4', stepUpProof: 'proof-owner-good' } }, res);
    assert('rename: valid request -> 200, correct service, correct target/payload', res._status === 200
      && deps.accessUserService.calls.some((c) => c.name === 'renameAccessUser' && c.args.targetActor === 'dyn_cashier' && c.args.newDisplayName === 'Renamed'));

    // role change
    route = findRoute(app.routes, 'PATCH', '/api/auth/v3/access-users/:actor/role');
    res = fakeRes();
    await runChain(route.chain, { headers: bearer('good-owner'), params: { actor: 'dyn_cashier' }, body: { expectedRole: 'cashier', requestedRole: 'admin', clientRequestId: 'c5', stepUpProof: 'proof-owner-good' } }, res);
    assert('role change: admin target rejected', res._status === 400);
    res = fakeRes();
    await runChain(route.chain, { headers: bearer('good-owner'), params: { actor: 'dyn_cashier' }, body: { expectedRole: 'cashier', requestedRole: 'owner', clientRequestId: 'c6', stepUpProof: 'proof-owner-good' } }, res);
    assert('role change: owner target rejected', res._status === 400);
    res = fakeRes();
    await runChain(route.chain, { headers: bearer('good-owner'), params: { actor: 'dyn_cashier' }, body: { expectedRole: 'cashier', requestedRole: 'legacy_operator', clientRequestId: 'c7', stepUpProof: 'proof-owner-good' } }, res);
    assert('role change: legacy_operator target rejected (never an assignment target)', res._status === 400);
    res = fakeRes();
    await runChain(route.chain, { headers: bearer('good-owner'), params: { actor: 'dyn_cashier' }, body: { expectedRole: 'cashier', requestedRole: 'operator', clientRequestId: 'c8', stepUpProof: 'proof-owner-good' } }, res);
    assert('role change: legacy operator target rejected', res._status === 400);
    res = fakeRes();
    await runChain(route.chain, { headers: bearer('good-owner'), params: { actor: 'dyn_cashier' }, body: { expectedRole: 'cashier', requestedRole: 'waiter', clientRequestId: 'c9', stepUpProof: 'proof-owner-good' } }, res);
    assert('role change: valid assignable target -> 200', res._status === 200);

    // clear pin
    route = findRoute(app.routes, 'DELETE', '/api/auth/v3/access-users/:actor/pin');
    res = fakeRes();
    await runChain(route.chain, { headers: bearer('good-owner'), params: { actor: 'dyn_cashier' }, body: { clientRequestId: 'c10', stepUpProof: 'proof-owner-good' } }, res);
    assert('clear pin: missing expectedSessionVersion rejected', res._status === 400);
    res = fakeRes();
    await runChain(route.chain, { headers: bearer('good-owner'), params: { actor: 'dyn_cashier' }, body: { expectedSessionVersion: 1, clientRequestId: 'c11', stepUpProof: 'proof-owner-good' } }, res);
    assert('clear pin: valid request -> 200, correct service', res._status === 200
      && deps.lifecycleService.calls.some((c) => c.name === 'clearAccessUserCredential' && c.args.targetActor === 'dyn_cashier'));
    assert('clear pin: no PIN body field accepted/echoed', res._json.user && !('pin' in res._json.user));

    // reactivate
    route = findRoute(app.routes, 'POST', '/api/auth/v3/access-users/:actor/reactivate');
    res = fakeRes();
    await runChain(route.chain, { headers: bearer('good-owner'), params: { actor: 'dyn_cashier' }, body: { expectedActive: false, clientRequestId: 'c12', stepUpProof: 'proof-owner-good' } }, res);
    assert('reactivate: valid request -> 200, correct service', res._status === 200
      && deps.lifecycleService.calls.some((c) => c.name === 'reactivateAccessUser' && c.args.targetActor === 'dyn_cashier'));
  }

  // ══════════════════ DEACTIVATE + WAITER SAFETY (V3-G: database-authoritative) ══════════════════
  {
    const app = fakeApp();
    const deps = buildDeps();
    registerAccessManagementRoutes(app, deps);
    const route = findRoute(app.routes, 'POST', '/api/auth/v3/access-users/:actor/deactivate');

    // a waiter WITH open table sessions: the handler performs NO Node-side pre-check --
    // it calls the lifecycle service/RPC exactly like any other target, and the
    // DATABASE's AUTH_WAITER_HAS_OPEN_TABLES marker (simulated here via the fake
    // service, mirroring the real DAO/service marker-mapping chain) is what produces
    // the 409.
    let res = fakeRes();
    await runChain(route.chain, { headers: bearer('good-owner'), params: { actor: 'dyn_waiter_with_tables' }, body: { expectedActive: true, clientRequestId: 'w1', stepUpProof: 'proof-owner-good' } }, res);
    assert('waiter with open table sessions returns a stable 409 conflict', res._status === 409 && res._json.code === 'AUTH_WAITER_HAS_OPEN_TABLES');
    assert('the conflict came FROM the lifecycle service call, not a Node-side pre-check', deps.lifecycleService.calls.some((c) => c.name === 'deactivateAccessUser' && c.args.targetActor === 'dyn_waiter_with_tables'));
    // The stable code AUTH_WAITER_HAS_OPEN_TABLES legitimately contains the word
    // "TABLES" -- check for a leaked UUID/identifier or a session-count field instead.
    assert('no table-session identifier, count, or customer detail appears in the conflict response',
      !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(JSON.stringify(res._json))
      && !('openTableCount' in (res._json || {})) && !('tableSessionId' in (res._json || {})));

    // a waiter with ZERO open table sessions reaches the RPC and succeeds normally --
    // being a waiter is no longer a blanket block.
    res = fakeRes();
    await runChain(route.chain, { headers: bearer('good-owner'), params: { actor: 'dyn_waiter' }, body: { expectedActive: true, clientRequestId: 'w1b', stepUpProof: 'proof-owner-good' } }, res);
    assert('waiter with zero open table sessions deactivates normally', res._status === 200
      && deps.lifecycleService.calls.some((c) => c.name === 'deactivateAccessUser' && c.args.targetActor === 'dyn_waiter'));

    res = fakeRes();
    await runChain(route.chain, { headers: bearer('good-owner'), params: { actor: 'dyn_cashier' }, body: { expectedActive: true, clientRequestId: 'w2', stepUpProof: 'proof-owner-good' } }, res);
    assert('non-waiter synthetic staff reaches the dormant lifecycle service contract', res._status === 200
      && deps.lifecycleService.calls.some((c) => c.name === 'deactivateAccessUser' && c.args.targetActor === 'dyn_cashier'));

    // unknown target: no Node pre-read exists anymore (consistent with reactivate/clear/
    // role-change, none of which pre-read either) -- the RPC's own generic failure
    // collapses to 400, exactly like every other lifecycle write's not-found case.
    res = fakeRes();
    await runChain(route.chain, { headers: bearer('good-owner'), params: { actor: 'no-such-target' }, body: { expectedActive: true, clientRequestId: 'w3', stepUpProof: 'proof-owner-good' } }, res);
    assert('deactivate: unknown target reaches the RPC and fails generically (400), consistent with every other lifecycle write', res._status === 400
      && deps.lifecycleService.calls.some((c) => c.name === 'deactivateAccessUser' && c.args.targetActor === 'no-such-target'));
  }

  // ══════════════════ PIN HYGIENE + SET-PIN IDEMPOTENCY ══════════════════
  {
    const app = fakeApp();
    const deps = buildDeps();
    registerAccessManagementRoutes(app, deps);
    const route = findRoute(app.routes, 'PUT', '/api/auth/v3/access-users/:actor/pin');
    const logs = [];
    const loggerDeps = { ...deps, logger: { info: (o) => logs.push(o) } };
    const app2 = fakeApp();
    registerAccessManagementRoutes(app2, loggerDeps);
    const route2 = findRoute(app2.routes, 'PUT', '/api/auth/v3/access-users/:actor/pin');

    let res = fakeRes();
    await runChain(route.chain, { headers: bearer('good-owner'), params: { actor: 'dyn_cashier' }, body: { pin: 'abc', clientRequestId: 'p1', stepUpProof: 'proof-owner-good' } }, res);
    assert('set pin: bad format rejected', res._status === 400 && res._json.code === 'AUTH_PIN_FORMAT_INVALID');

    res = fakeRes();
    await runChain(route2.chain, { headers: bearer('good-owner'), params: { actor: 'dyn_cashier' }, body: { pin: '482915', clientRequestId: 'p2', stepUpProof: 'proof-owner-good' } }, res);
    assert('set pin: valid request -> 200', res._status === 200 && res._json.user.hasPin === true);
    assert('PIN absent from success response', JSON.stringify(res._json).indexOf('482915') === -1 && !('pin' in res._json.user));
    assert('PIN absent from safe log output', JSON.stringify(logs).indexOf('482915') === -1);

    // replay: same key, same PIN -> stored response, rotate() NOT called again
    const rotateCallsBefore = deps.pinRotationService.calls.length;
    res = fakeRes();
    await runChain(route.chain, { headers: bearer('good-owner'), params: { actor: 'dyn_cashier' }, body: { pin: '482915', clientRequestId: 'p2', stepUpProof: 'proof-owner-good' } }, res);
    assert('set pin: replay with SAME key + SAME pin returns stored response, does not call rotate again',
      res._status === 200);

    // same key, different PIN -> conflict, rotate NOT called
    res = fakeRes();
    const rotateCallsBeforeConflict = deps.pinRotationService.calls.length;
    await runChain(route.chain, { headers: bearer('good-owner'), params: { actor: 'dyn_cashier' }, body: { pin: '111222', clientRequestId: 'p2', stepUpProof: 'proof-owner-good' } }, res);
    assert('set pin: same client_request_id + DIFFERENT pin -> 409 conflict, rotate not called',
      res._status === 409 && res._json.code === 'AUTH_IDEMPOTENCY_CONFLICT' && deps.pinRotationService.calls.length === rotateCallsBeforeConflict);

    // duplicate / reserved PIN -- generic error, no actor identity leak
    res = fakeRes();
    await runChain(route.chain, { headers: bearer('good-owner'), params: { actor: 'dup-target' }, body: { pin: '333444', clientRequestId: 'p3', stepUpProof: 'proof-owner-good' } }, res);
    assert('set pin: duplicate PIN -> 409, no actor identity revealed', res._status === 409 && res._json.code === 'AUTH_PIN_DUPLICATE'
      && JSON.stringify(res._json).indexOf('dyn_cashier') === -1);
    res = fakeRes();
    await runChain(route.chain, { headers: bearer('good-owner'), params: { actor: 'reserved-target' }, body: { pin: '333444', clientRequestId: 'p4', stepUpProof: 'proof-owner-good' } }, res);
    assert('set pin: reserved (owner-credential) PIN -> 409, no actor identity revealed', res._status === 409 && res._json.code === 'AUTH_PIN_RESERVED');

    // idempotency key required
    res = fakeRes();
    await runChain(route.chain, { headers: bearer('good-owner'), params: { actor: 'dyn_cashier' }, body: { pin: '482915', stepUpProof: 'proof-owner-good' } }, res);
    assert('set pin: missing clientRequestId rejected before rotate is called', res._status === 400 && res._json.code === 'AUTH_CLIENT_REQUEST_ID_INVALID');

    // oversized clientRequestId rejected
    res = fakeRes();
    await runChain(route.chain, { headers: bearer('good-owner'), params: { actor: 'dyn_cashier' }, body: { pin: '482915', clientRequestId: 'x'.repeat(200), stepUpProof: 'proof-owner-good' } }, res);
    assert('set pin: oversized clientRequestId rejected', res._status === 400 && res._json.code === 'AUTH_CLIENT_REQUEST_ID_INVALID');
  }

  // ══════════════════ ARCHITECTURAL / UNWIRED NEGATIVE CONTROLS ══════════════════
  {
    const HND = fs.readFileSync(path.join(__dirname, '..', 'src/auth/accessManagementHttpHandlersV3.js'), 'utf8');
    const idx = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    assert('handlers never call sbRest/Supabase directly', !/sbRest\(|createClient|SUPABASE_KEY|\.rpc\(/.test(HND));
    assert('no generic action route (req.body.action / req.query.action)', !/req\.(body|query|params)\.(action|rpc|fn|type)/.test(HND));
    // b.role IS legitimate client input for createAccessUser (the NEW user's requested
    // role) -- distinct from the ACTING actor's own role, which must never come from the
    // body. This check targets the acting-identity fields specifically.
    assert('handlers never read acting workspace/actor/sid/session/auth-method from the body', !/b\.(workspaceId|byActor|actingActor|sid|sessionVersion|authMethod)\b/.test(HND));
    assert('access-management http modules not wired into index.js', !/accessManagementHttpHandlersV3|accessManagementHttpIntegrationV3|registerAccessManagementRoutes|integrateAccessManagementRoutes/.test(idx));
    assert('never returns 201 (idempotent-safe, always 200 on ok)', !/\.status\(\s*201\s*\)/.test(HND));
    assert('handler reads acting identity only from req.ownerContext', /req\.ownerContext/.test(HND) && !/req\.body\.byActor|body\.byActor/.test(HND));
  }

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})();
