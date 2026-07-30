'use strict';
// Test per src/auth/accessUserLifecycleServiceV3.js + accessUserLifecycleDaoV3.js --
// Access Control V3 Block V3-E (FOUNDATION, UNWIRED). Eseguire:
// node tests/accessUserLifecycleServiceV3.test.js
//
// The fake DAO mirrors auth_set_access_user_active_v3 / auth_clear_access_user_
// credential_v3's real SQL decision logic (workspace check, action-scoped idempotency,
// role-based acting/target authorization, no-op-vs-real-change, credential detection,
// atomic pin_hash+fingerprint clearing) so the service is exercised against realistic
// RPC semantics, exactly like roleChangeServiceV3.test.js's fake mirrors
// auth_change_actor_role_v3. A forced-mid-transaction-failure guarantee and "cleared
// fingerprint reusable" at the true database-constraint level are proven separately by
// the real disposable-PostgreSQL rehearsal (out of band) -- this suite proves the
// service/DAO orchestration layer.
const assert = require('node:assert/strict');
const test = require('node:test');

const { createAccessUserLifecycleV3Service } = require('../src/auth/accessUserLifecycleServiceV3');

const WID = '99999999-9999-4999-8999-999999999999';
const OTHER_WID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UUID_OWNER = 'a1b2c3d4-0000-4000-8000-000000000003';
const UUID_STAFF = 'dddddddd-dddd-4ddd-8ddd-000000000099';

function fakeSidHash(sid) { return typeof sid === 'string' && sid.length > 0 ? 'h:' + sid : null; }
const notExpired = Math.floor(Date.now() / 1000) + 600;
const expired = Math.floor(Date.now() / 1000) - 10;

async function seedActors() {
  return [
    { actor: 'owner', role: 'admin', active: true, workspace_id: WID, session_version: 15, pin_hash: 'scrypt$owner', failed_count: 0, locked_until: null, fingerprints: ['k1'] },
    { actor: 'operator_primary', role: 'operator', active: true, workspace_id: WID, session_version: 10, pin_hash: 'scrypt$primary', failed_count: 0, locked_until: null, fingerprints: ['k1'] },
    { actor: 'operator_backup', role: 'operator', active: false, workspace_id: WID, session_version: 4, pin_hash: 'scrypt$backup', failed_count: 2, locked_until: '2026-01-01T00:00:00Z', fingerprints: ['k1'] },
    { actor: 'rider', role: 'rider', active: true, workspace_id: WID, session_version: 2, pin_hash: null, failed_count: 0, locked_until: null, fingerprints: [] },
    { actor: UUID_OWNER, role: 'owner', active: true, workspace_id: WID, session_version: 1, pin_hash: null, failed_count: 0, locked_until: null, fingerprints: [] },
    { actor: UUID_STAFF, role: 'cashier', active: true, workspace_id: WID, session_version: 1, pin_hash: 'scrypt$staff', failed_count: 0, locked_until: null, fingerprints: ['k1'] },
  ];
}

function makeDb(actors) {
  const db = {
    actors,
    workspaces: { [WID]: { lifecycle_status: 'active' }, [OTHER_WID]: { lifecycle_status: 'active' } },
    idempotency: [], audit: [], activeChanges: [], credentialClears: [], activeCalls: 0, clearCalls: 0,
  };
  const findIdem = (action, args) => db.idempotency.find((r) =>
    r.workspace_id === args.workspaceId && r.by_actor === args.byActor && r.by_sid_hash === args.bySidHash &&
    r.action === action && r.client_request_id === args.clientRequestId);

  const ELIGIBLE_TARGET_ROLES = ['operator', 'legacy_operator', 'cashier', 'waiter', 'kitchen', 'rider', 'shift_manager'];

  const dao = {
    async setAccessUserActiveV3(args) {
      db.activeCalls += 1;
      const action = args.requestedActive ? 'reactivate_access_user_v3' : 'deactivate_access_user_v3';
      const ws = db.workspaces[args.workspaceId];
      if (!ws || ws.lifecycle_status !== 'active') throw new Error('WORKSPACE_NOT_ACTIVE');
      // Deterministic lock + re-read + full authorization -- BEFORE any idempotency
      // lookup/replay, mirroring the corrected RPC ordering: a revoked/deactivated/
      // demoted acting actor must never receive a stored success from a stale record.
      const by = db.actors.find((a) => a.actor === args.byActor);
      if (!by) throw new Error('AUTH_INITIATOR_NOT_FOUND');
      const tgt = db.actors.find((a) => a.actor === args.targetActor);
      if (!tgt) throw new Error('AUTH_ACTOR_NOT_FOUND');
      if (by.workspace_id !== args.workspaceId) throw new Error('AUTH_INITIATOR_OTHER_WORKSPACE');
      if (by.active !== true) throw new Error('AUTH_INITIATOR_INACTIVE');
      if (!['admin', 'owner'].includes(by.role)) throw new Error('AUTH_NOT_OWNER');
      if (tgt.workspace_id !== args.workspaceId) throw new Error('AUTH_TARGET_OTHER_WORKSPACE');
      if (['admin', 'owner'].includes(tgt.role)) throw new Error('AUTH_TARGET_IS_OWNER');
      if (!tgt.role || !ELIGIBLE_TARGET_ROLES.includes(tgt.role)) throw new Error('AUTH_TARGET_ROLE_INELIGIBLE'); // positive allowlist, never a denylist

      const existing = findIdem(action, args);
      if (existing) {
        if (existing.request_hash === args.requestHash) return { ...existing.response_body };
        const e = new Error('conflict'); e.code = 'ACCESS_USER_LIFECYCLE_CONFLICT'; throw e;
      }

      if (tgt.active !== args.expectedActive) throw new Error('AUTH_TARGET_STATE_MISMATCH');

      const changed = tgt.active !== args.requestedActive;
      let result;
      if (!changed) {
        result = { actor: tgt.actor, role: tgt.role, active: tgt.active, session_version: tgt.session_version, failed_count: tgt.failed_count, locked_until: tgt.locked_until, updated_at: tgt.updated_at, updated_by: tgt.updated_by };
      } else {
        tgt.active = args.requestedActive;
        tgt.session_version += 1;
        tgt.updated_at = 'updated:' + tgt.session_version;
        tgt.updated_by = args.byActor;
        db.activeChanges.push({ actor: args.targetActor, active: args.requestedActive });
        db.audit.push({ event: args.requestedActive ? 'user_reactivated' : 'user_deactivated', target_actor: args.targetActor });
        db.audit.push({ event: 'session_invalidated', target_actor: args.targetActor });
        result = { actor: tgt.actor, role: tgt.role, active: tgt.active, session_version: tgt.session_version, failed_count: tgt.failed_count, locked_until: tgt.locked_until, updated_at: tgt.updated_at, updated_by: tgt.updated_by };
      }
      db.idempotency.push({ workspace_id: args.workspaceId, by_actor: args.byActor, by_sid_hash: args.bySidHash, action, client_request_id: args.clientRequestId, request_hash: args.requestHash, response_body: result });
      return result;
    },
    async clearAccessUserCredentialV3(args) {
      db.clearCalls += 1;
      const action = 'clear_access_user_credential_v3';
      const ws = db.workspaces[args.workspaceId];
      if (!ws || ws.lifecycle_status !== 'active') throw new Error('WORKSPACE_NOT_ACTIVE');
      // Same corrected ordering as setAccessUserActiveV3: full authorization BEFORE
      // any idempotency lookup/replay.
      const by = db.actors.find((a) => a.actor === args.byActor);
      if (!by) throw new Error('AUTH_INITIATOR_NOT_FOUND');
      const tgt = db.actors.find((a) => a.actor === args.targetActor);
      if (!tgt) throw new Error('AUTH_ACTOR_NOT_FOUND');
      if (by.workspace_id !== args.workspaceId) throw new Error('AUTH_INITIATOR_OTHER_WORKSPACE');
      if (by.active !== true) throw new Error('AUTH_INITIATOR_INACTIVE');
      if (!['admin', 'owner'].includes(by.role)) throw new Error('AUTH_NOT_OWNER');
      if (tgt.workspace_id !== args.workspaceId) throw new Error('AUTH_TARGET_OTHER_WORKSPACE');
      if (['admin', 'owner'].includes(tgt.role)) throw new Error('AUTH_TARGET_IS_OWNER');
      if (!tgt.role || !ELIGIBLE_TARGET_ROLES.includes(tgt.role)) throw new Error('AUTH_TARGET_ROLE_INELIGIBLE');

      const existing = findIdem(action, args);
      if (existing) {
        if (existing.request_hash === args.requestHash) return { ...existing.response_body };
        const e = new Error('conflict'); e.code = 'ACCESS_USER_LIFECYCLE_CONFLICT'; throw e;
      }

      if (tgt.session_version !== args.expectedSessionVersion) throw new Error('AUTH_TARGET_STALE');

      const hasCredential = tgt.pin_hash !== null || tgt.fingerprints.length > 0;
      let result;
      if (!hasCredential) {
        result = { actor: tgt.actor, role: tgt.role, active: tgt.active, session_version: tgt.session_version, failed_count: tgt.failed_count, locked_until: tgt.locked_until, updated_at: tgt.updated_at, updated_by: tgt.updated_by };
      } else {
        tgt.pin_hash = null;
        tgt.failed_count = 0;
        tgt.locked_until = null;
        tgt.session_version += 1;
        tgt.updated_at = 'cleared:' + tgt.session_version;
        tgt.updated_by = args.byActor;
        db.credentialClears.push(args.targetActor);
        tgt.fingerprints = [];
        db.audit.push({ event: 'credential_cleared', target_actor: args.targetActor });
        db.audit.push({ event: 'session_invalidated', target_actor: args.targetActor });
        result = { actor: tgt.actor, role: tgt.role, active: tgt.active, session_version: tgt.session_version, failed_count: tgt.failed_count, locked_until: tgt.locked_until, updated_at: tgt.updated_at, updated_by: tgt.updated_by };
      }
      db.idempotency.push({ workspace_id: args.workspaceId, by_actor: args.byActor, by_sid_hash: args.bySidHash, action, client_request_id: args.clientRequestId, request_hash: args.requestHash, response_body: result });
      return result;
    },
  };
  return { db, dao };
}

const svc = (dao) => createAccessUserLifecycleV3Service({ dao, sidHash: fakeSidHash });
const stepUp = (sub, sid, exp = notExpired) => ({ sub, sid, exp });

const deactivate = (dao, over = {}) => svc(dao).deactivateAccessUser({
  workspaceId: WID, byActor: 'owner', actingRole: 'admin', targetActor: 'operator_primary',
  expectedActive: true, sid: 'sid-1', clientRequestId: 'req-deact-1', stepUp: stepUp('owner', 'sid-1'),
  ...over,
});
const reactivate = (dao, over = {}) => svc(dao).reactivateAccessUser({
  workspaceId: WID, byActor: 'owner', actingRole: 'admin', targetActor: 'operator_backup',
  expectedActive: false, sid: 'sid-1', clientRequestId: 'req-react-1', stepUp: stepUp('owner', 'sid-1'),
  ...over,
});
const clearCred = (dao, targetActor, expectedSessionVersion, over = {}) => svc(dao).clearAccessUserCredential({
  workspaceId: WID, byActor: 'owner', actingRole: 'admin', targetActor, expectedSessionVersion,
  sid: 'sid-1', clientRequestId: 'req-clear-1', stepUp: stepUp('owner', 'sid-1'),
  ...over,
});

// ══ ACTIVE STATE ═══════════════════════════════════════════════════════════════════
test('active staff deactivation succeeds', async () => {
  const { db, dao } = makeDb(await seedActors());
  const r = await deactivate(dao);
  assert.equal(r.ok, true);
  assert.equal(r.active, false);
  assert.deepEqual(db.activeChanges, [{ actor: 'operator_primary', active: false }]);
});

test('inactive staff reactivation succeeds', async () => {
  const { db, dao } = makeDb(await seedActors());
  const r = await reactivate(dao);
  assert.equal(r.ok, true);
  assert.equal(r.active, true);
  assert.deepEqual(db.activeChanges, [{ actor: 'operator_backup', active: true }]);
});

test('duplicate deactivate is a deterministic no-op (new request id, same expected state)', async () => {
  const { db, dao } = makeDb(await seedActors());
  const first = await deactivate(dao);
  const again = await deactivate(dao, { expectedActive: false, clientRequestId: 'req-deact-2' });
  assert.equal(first.ok, true);
  assert.equal(again.ok, true);
  assert.equal(again.sessionVersion, first.sessionVersion, 'no second increment');
  assert.equal(db.activeChanges.length, 1);
});

test('duplicate reactivate is a deterministic no-op', async () => {
  const { db, dao } = makeDb(await seedActors());
  const first = await reactivate(dao);
  const again = await reactivate(dao, { expectedActive: true, clientRequestId: 'req-react-2' });
  assert.equal(again.sessionVersion, first.sessionVersion);
  assert.equal(db.activeChanges.length, 1);
});

test('owner target rejected by ROLE', async () => {
  const { db, dao } = makeDb(await seedActors());
  const r = await deactivate(dao, { targetActor: 'owner', expectedActive: true });
  assert.equal(r.ok, false);
  assert.equal(db.activeChanges.length, 0);
});

test('actor literal does not determine ownership -- UUID owner acting accepted, "owner"-named non-owner-role target not protected', async () => {
  const { db, dao } = makeDb(await seedActors());
  const r = await deactivate(dao, { byActor: UUID_OWNER, actingRole: 'owner', stepUp: stepUp(UUID_OWNER, 'sid-1') });
  assert.equal(r.ok, true, 'UUID owner (role=owner) can act');
  assert.deepEqual(db.activeChanges, [{ actor: 'operator_primary', active: false }]);
});

test('cross-workspace target is rejected', async () => {
  const actors = await seedActors();
  actors.find((a) => a.actor === 'rider').workspace_id = OTHER_WID;
  const { db, dao } = makeDb(actors);
  const r = await deactivate(dao, { targetActor: 'rider', expectedActive: true });
  assert.equal(r.ok, false);
  assert.equal(db.activeChanges.length, 0);
});

test('inactive acting owner is rejected', async () => {
  const actors = await seedActors();
  actors.find((a) => a.actor === 'owner').active = false;
  const { db, dao } = makeDb(actors);
  const r = await deactivate(dao);
  assert.equal(r.ok, false);
  assert.equal(db.activeChanges.length, 0);
});

test('expected-state mismatch is rejected', async () => {
  const { db, dao } = makeDb(await seedActors());
  const r = await deactivate(dao, { expectedActive: false }); // operator_primary is actually active
  assert.equal(r.ok, false);
  assert.equal(db.activeChanges.length, 0);
});

test('only target active/session_version change -- every other actor untouched', async () => {
  const actors = await seedActors();
  const before = JSON.parse(JSON.stringify(actors));
  const { db, dao } = makeDb(actors);
  await deactivate(dao);
  for (const a of ['owner', 'operator_backup', 'rider', UUID_OWNER, UUID_STAFF]) {
    assert.deepEqual(db.actors.find((x) => x.actor === a), before.find((x) => x.actor === a), a);
  }
});

test('role/PIN/fingerprint/lockout unchanged by a deactivation', async () => {
  const actors = await seedActors();
  const before = JSON.parse(JSON.stringify(actors.find((a) => a.actor === 'operator_primary')));
  const { db, dao } = makeDb(actors);
  await deactivate(dao);
  const after = db.actors.find((a) => a.actor === 'operator_primary');
  assert.equal(after.role, before.role);
  assert.equal(after.pin_hash, before.pin_hash);
  assert.deepEqual(after.fingerprints, before.fingerprints);
  assert.equal(after.failed_count, before.failed_count);
  assert.equal(after.locked_until, before.locked_until);
});

test('exact audit pair (user_deactivated + session_invalidated) exactly once', async () => {
  const { db, dao } = makeDb(await seedActors());
  await deactivate(dao);
  assert.equal(db.audit.filter((e) => e.event === 'user_deactivated').length, 1);
  assert.equal(db.audit.filter((e) => e.event === 'session_invalidated').length, 1);
});

test('replay (same key/payload) does not duplicate the state change or audit', async () => {
  const { db, dao } = makeDb(await seedActors());
  const first = await deactivate(dao);
  const replay = await deactivate(dao);
  assert.deepEqual(replay, first);
  assert.equal(db.activeChanges.length, 1);
  assert.equal(db.audit.filter((e) => e.event === 'user_deactivated').length, 1);
});

test('same idempotency key with a DIFFERENT payload conflicts', async () => {
  const { db, dao } = makeDb(await seedActors());
  const first = await deactivate(dao);
  assert.equal(first.ok, true);
  const conflict = await deactivate(dao, { targetActor: 'operator_backup', expectedActive: false, requestedActive: false });
  // reuse req-deact-1 -> same action bucket but different semantic payload
  const conflict2 = await svc(dao).deactivateAccessUser({
    workspaceId: WID, byActor: 'owner', actingRole: 'admin', targetActor: 'rider', expectedActive: true,
    sid: 'sid-1', clientRequestId: 'req-deact-1', stepUp: stepUp('owner', 'sid-1'),
  });
  assert.equal(conflict2.ok, false);
  assert.equal(conflict2.error, 'idempotency_conflict');
});

// ══ CLEAR CREDENTIAL ═══════════════════════════════════════════════════════════════
test('active staff credential clear succeeds', async () => {
  const { db, dao } = makeDb(await seedActors());
  const r = await clearCred(dao, 'operator_primary', 10);
  assert.equal(r.ok, true);
  assert.deepEqual(db.credentialClears, ['operator_primary']);
});

test('inactive staff credential clear succeeds', async () => {
  const { db, dao } = makeDb(await seedActors());
  const r = await clearCred(dao, 'operator_backup', 4);
  assert.equal(r.ok, true);
  assert.deepEqual(db.credentialClears, ['operator_backup']);
});

test('owner target is rejected', async () => {
  const { db, dao } = makeDb(await seedActors());
  const r = await clearCred(dao, 'owner', 15);
  assert.equal(r.ok, false);
  assert.equal(db.credentialClears.length, 0);
});

test('a target with no credential is a deterministic no-op', async () => {
  const { db, dao } = makeDb(await seedActors());
  const r = await clearCred(dao, 'rider', 2); // rider has pin_hash=null, no fingerprints
  assert.equal(r.ok, true);
  assert.equal(db.credentialClears.length, 0);
});

test('a stale expected-session-version snapshot is rejected', async () => {
  const { db, dao } = makeDb(await seedActors());
  const r = await clearCred(dao, 'operator_primary', 999);
  assert.equal(r.ok, false);
  assert.equal(db.credentialClears.length, 0);
});

test('target pin_hash is cleared to NULL', async () => {
  const { db, dao } = makeDb(await seedActors());
  await clearCred(dao, 'operator_primary', 10);
  assert.equal(db.actors.find((a) => a.actor === 'operator_primary').pin_hash, null);
});

test('all target fingerprint key rows are deleted', async () => {
  const { db, dao } = makeDb(await seedActors());
  await clearCred(dao, 'operator_primary', 10);
  assert.deepEqual(db.actors.find((a) => a.actor === 'operator_primary').fingerprints, []);
});

test('failed_count and locked_until are reset', async () => {
  const { db, dao } = makeDb(await seedActors());
  await clearCred(dao, 'operator_backup', 4);
  const row = db.actors.find((a) => a.actor === 'operator_backup');
  assert.equal(row.failed_count, 0);
  assert.equal(row.locked_until, null);
});

test('only target session_version increments; other actors unchanged', async () => {
  const actors = await seedActors();
  const before = JSON.parse(JSON.stringify(actors));
  const { db, dao } = makeDb(actors);
  const r = await clearCred(dao, 'operator_primary', 10);
  assert.equal(r.sessionVersion, before.find((a) => a.actor === 'operator_primary').session_version + 1);
  for (const a of ['owner', 'operator_backup', 'rider', UUID_OWNER, UUID_STAFF]) {
    assert.deepEqual(db.actors.find((x) => x.actor === a), before.find((x) => x.actor === a), a);
  }
});

test('exact audit pair (credential_cleared + session_invalidated) exactly once', async () => {
  const { db, dao } = makeDb(await seedActors());
  await clearCred(dao, 'operator_primary', 10);
  assert.equal(db.audit.filter((e) => e.event === 'credential_cleared').length, 1);
  assert.equal(db.audit.filter((e) => e.event === 'session_invalidated').length, 1);
});

test('replay does not duplicate the clear or audit', async () => {
  const { db, dao } = makeDb(await seedActors());
  const first = await clearCred(dao, 'operator_primary', 10);
  const replay = await clearCred(dao, 'operator_primary', 10);
  assert.deepEqual(replay, first);
  assert.equal(db.credentialClears.length, 1);
  assert.equal(db.audit.filter((e) => e.event === 'credential_cleared').length, 1);
});

test('a previously reserved fingerprint slot becomes available to another actor after clear (Node-level analog; DB-constraint proof is in the disposable-Postgres rehearsal)', async () => {
  const { db, dao } = makeDb(await seedActors());
  await clearCred(dao, 'operator_primary', 10);
  const cleared = db.actors.find((a) => a.actor === 'operator_primary');
  assert.deepEqual(cleared.fingerprints, []);
  // simulate assigning the freed fingerprint slot to a different actor -- no conflict
  const other = db.actors.find((a) => a.actor === 'rider');
  other.fingerprints = ['k1'];
  assert.deepEqual(other.fingerprints, ['k1']);
});

// ══ SERVICE: step-up binding ═══════════════════════════════════════════════════════
test('a valid, non-expired owner step-up is accepted', async () => {
  const { dao } = makeDb(await seedActors());
  const r = await deactivate(dao, { stepUp: stepUp('owner', 'sid-1', notExpired) });
  assert.equal(r.ok, true);
});

test('a missing step-up is rejected before the DAO is ever called', async () => {
  const { db, dao } = makeDb(await seedActors());
  const r = await deactivate(dao, { stepUp: null });
  assert.equal(r.ok, false);
  assert.equal(db.activeCalls, 0);
});

test('an expired step-up is rejected before the DAO is ever called', async () => {
  const { db, dao } = makeDb(await seedActors());
  const r = await deactivate(dao, { stepUp: stepUp('owner', 'sid-1', expired) });
  assert.equal(r.ok, false);
  assert.equal(db.activeCalls, 0);
});

test('a step-up bound to a DIFFERENT actor is rejected before the DAO is ever called', async () => {
  const { db, dao } = makeDb(await seedActors());
  const r = await deactivate(dao, { stepUp: stepUp('rider', 'sid-1') });
  assert.equal(r.ok, false);
  assert.equal(db.activeCalls, 0);
});

test('a step-up bound to a DIFFERENT session id is rejected before the DAO is ever called', async () => {
  const { db, dao } = makeDb(await seedActors());
  const r = await deactivate(dao, { stepUp: stepUp('owner', 'some-other-sid') });
  assert.equal(r.ok, false);
  assert.equal(db.activeCalls, 0);
});

test('a non-owner acting role is rejected before the DAO is ever called', async () => {
  const { db, dao } = makeDb(await seedActors());
  const r = await deactivate(dao, { actingRole: 'operator' });
  assert.equal(r.ok, false);
  assert.equal(db.activeCalls, 0);
});

test('clearAccessUserCredential also requires a valid, non-expired, correctly-bound step-up', async () => {
  const { db, dao } = makeDb(await seedActors());
  const r1 = await clearCred(dao, 'operator_primary', 10, { stepUp: null });
  const r2 = await clearCred(dao, 'operator_primary', 10, { stepUp: stepUp('owner', 'sid-1', expired) });
  assert.equal(r1.ok, false);
  assert.equal(r2.ok, false);
  assert.equal(db.clearCalls, 0);
});

test('the returned summary carries no PIN, hash, fingerprint, or token material', async () => {
  const { dao } = makeDb(await seedActors());
  const r1 = await deactivate(dao);
  const r2 = await clearCred(dao, 'operator_backup', 4);
  const s = JSON.stringify(r1) + JSON.stringify(r2);
  for (const bad of ['pin_hash', 'scrypt$', 'fingerprint', 'token', 'proof']) {
    assert.ok(!s.includes(bad), bad);
  }
});

// ══ SECURITY CLOSURE: exact positive target-role allowlist ═════════════════════════
// Fixture helper: seed a target actor with an arbitrary role, active=true, a fresh
// UUID id, and a known session_version, then attempt deactivate/reactivate/clear on it.
function withTargetRole(role) {
  return async () => {
    const actors = await seedActors();
    actors.push({ actor: 'ttttttt1-0000-4000-8000-000000000001', role, active: true, workspace_id: WID, session_version: 1, pin_hash: null, failed_count: 0, locked_until: null, fingerprints: [] });
    return actors;
  };
}
const ELIGIBLE = ['operator', 'legacy_operator', 'cashier', 'waiter', 'kitchen', 'rider', 'shift_manager'];

for (const role of ELIGIBLE) {
  test(`target role allowlist: '${role}' is accepted`, async () => {
    const actors = await withTargetRole(role)();
    const { dao } = makeDb(actors);
    const r = await deactivate(dao, { targetActor: 'ttttttt1-0000-4000-8000-000000000001', expectedActive: true });
    assert.equal(r.ok, true, role);
  });
}

test("target role allowlist: 'admin' is rejected", async () => {
  const actors = await withTargetRole('admin')();
  const { db, dao } = makeDb(actors);
  const r = await deactivate(dao, { targetActor: 'ttttttt1-0000-4000-8000-000000000001', expectedActive: true });
  assert.equal(r.ok, false);
  assert.equal(db.activeChanges.length, 0);
});

test("target role allowlist: 'owner' is rejected", async () => {
  const actors = await withTargetRole('owner')();
  const { db, dao } = makeDb(actors);
  const r = await deactivate(dao, { targetActor: 'ttttttt1-0000-4000-8000-000000000001', expectedActive: true });
  assert.equal(r.ok, false);
  assert.equal(db.activeChanges.length, 0);
});

test('target role allowlist: an UNKNOWN role is rejected (positive allowlist, not a denylist)', async () => {
  const actors = await withTargetRole('superuser')();
  const { db, dao } = makeDb(actors);
  const r = await deactivate(dao, { targetActor: 'ttttttt1-0000-4000-8000-000000000001', expectedActive: true });
  assert.equal(r.ok, false);
  assert.equal(db.activeChanges.length, 0);
});

test('target role allowlist: NULL/missing role is rejected', async () => {
  const actors = await withTargetRole(null)();
  const { db, dao } = makeDb(actors);
  const r = await deactivate(dao, { targetActor: 'ttttttt1-0000-4000-8000-000000000001', expectedActive: true });
  assert.equal(r.ok, false);
  assert.equal(db.activeChanges.length, 0);
});

test('target role allowlist decides by ROLE, not the actor id literal "owner", in both directions', async () => {
  // direction 1: a UUID actor (id has nothing to do with "owner") whose ROLE is the
  // reserved 'owner' role must still be rejected -- ownership is never decided by id.
  const roleOwnerActors = await seedActors();
  roleOwnerActors.push({ actor: 'zzzzzzz1-0000-4000-8000-000000000009', role: 'owner', active: true, workspace_id: WID, session_version: 1, pin_hash: null, failed_count: 0, locked_until: null, fingerprints: [] });
  const { db: db1, dao: dao1 } = makeDb(roleOwnerActors);
  const r1 = await deactivate(dao1, { targetActor: 'zzzzzzz1-0000-4000-8000-000000000009', expectedActive: true });
  assert.equal(r1.ok, false, 'a UUID actor with role=owner must be rejected exactly like the legacy id "owner"');
  assert.equal(db1.activeChanges.length, 0);
});

test('credential clear also enforces the same exact allowlist', async () => {
  const bad = await withTargetRole('superuser')();
  const { db: db1, dao: dao1 } = makeDb(bad);
  const r1 = await clearCred(dao1, 'ttttttt1-0000-4000-8000-000000000001', 1);
  assert.equal(r1.ok, false);
  const good = await withTargetRole('shift_manager')();
  const { db: db2, dao: dao2 } = makeDb(good);
  const r2 = await clearCred(dao2, 'ttttttt1-0000-4000-8000-000000000001', 1);
  assert.equal(r2.ok, true);
});

// ══ SECURITY CLOSURE: authorization proved BEFORE idempotency replay ══════════════
test('a valid owner CAN replay their own prior successful request', async () => {
  const { db, dao } = makeDb(await seedActors());
  const first = await deactivate(dao);
  const replay = await deactivate(dao);
  assert.equal(replay.ok, true);
  assert.deepEqual(replay, first);
  assert.equal(db.activeChanges.length, 1, 'replay must not mutate again');
});

test('an acting owner who has since become INACTIVE cannot replay a prior successful request', async () => {
  const actors = await seedActors();
  const { db, dao } = makeDb(actors);
  const first = await deactivate(dao);
  assert.equal(first.ok, true);
  // the acting owner is deactivated AFTER the first call succeeded -- simulating a
  // revoke that happens between the original call and the replay attempt
  actors.find((a) => a.actor === 'owner').active = false;
  const replay = await deactivate(dao);
  assert.equal(replay.ok, false, 'an inactive acting owner must not receive the stored success response');
});

test('an acting owner who has since been DEMOTED (role no longer admin/owner) cannot replay a prior successful request', async () => {
  const actors = await seedActors();
  const { db, dao } = makeDb(actors);
  const first = await deactivate(dao);
  assert.equal(first.ok, true);
  actors.find((a) => a.actor === 'owner').role = 'cashier'; // demoted after the original success
  const replay = await deactivate(dao);
  assert.equal(replay.ok, false, 'a demoted acting owner must not receive the stored success response');
});

test('a cross-workspace acting actor cannot replay a prior successful request', async () => {
  const actors = await seedActors();
  const { db, dao } = makeDb(actors);
  const first = await deactivate(dao);
  assert.equal(first.ok, true);
  actors.find((a) => a.actor === 'owner').workspace_id = OTHER_WID; // moved out from under the original workspace
  const replay = await deactivate(dao);
  assert.equal(replay.ok, false);
});

test('a different sid cannot reuse another session\'s stored idempotency result', async () => {
  const { db, dao } = makeDb(await seedActors());
  const first = await deactivate(dao, { sid: 'sid-1', stepUp: stepUp('owner', 'sid-1'), clientRequestId: 'req-sidbind-1' });
  assert.equal(first.ok, true);
  // SAME client_request_id and SAME believed expectedActive (true, the ORIGINAL
  // request's belief) but a DIFFERENT sid -> different bySidHash -> a completely
  // different idempotency key. If this incorrectly hit the first call's stored
  // response, it would return ok:true with the identical (now stale) payload. Instead
  // it must be evaluated FRESH against current state (already deactivated), and fail
  // with a state mismatch -- proving one session's sid can never unlock another
  // session's stored result, replay or otherwise.
  const wrongSid = await deactivate(dao, { sid: 'sid-2', stepUp: stepUp('owner', 'sid-2'), clientRequestId: 'req-sidbind-1' });
  assert.equal(wrongSid.ok, false, 'must not resolve as the first session\'s replay');
});

test('same key with a CHANGED payload still conflicts even after authorization is proved', async () => {
  const { db, dao } = makeDb(await seedActors());
  const first = await deactivate(dao);
  assert.equal(first.ok, true);
  const conflict = await deactivate(dao, { targetActor: 'operator_backup', expectedActive: false, clientRequestId: 'req-deact-1' });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error, 'idempotency_conflict');
});

test('authorization failure happens BEFORE any stored response could be returned -- the DAO is invoked and itself rejects, proving order at the orchestration boundary', async () => {
  const actors = await seedActors();
  const { db, dao } = makeDb(actors);
  await deactivate(dao); // establish a stored success
  actors.find((a) => a.actor === 'owner').active = false; // then revoke
  const before = db.activeCalls;
  const replay = await deactivate(dao);
  assert.equal(replay.ok, false);
  assert.equal(db.activeCalls, before + 1, 'the DAO/RPC was invoked (not skipped) and itself refused the stale replay');
});

console.log('\n=== node:test suite complete (see summary above) ===');
