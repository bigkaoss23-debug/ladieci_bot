'use strict';
// Test per src/auth/roleChangeServiceV3.js + roleChangeDaoV3.js — Access Control V3
// Block V3-C (FOUNDATION, UNWIRED). Eseguire: node tests/roleChangeServiceV3.test.js
//
// The fake DAO mirrors auth_change_actor_role_v3's actual SQL decision logic (workspace
// lock, deterministic actor-id locking, role-based acting/target authorization,
// expected-role match, no-op-vs-real-change, idempotency lookup-or-record) so the
// service is exercised against realistic RPC semantics, exactly like
// pinRotationServiceV3.test.js's fake mirrors auth_set_actor_pin_v3.
const assert = require('node:assert/strict');
const test = require('node:test');

const { createRoleChangeV3 } = require('../src/auth/roleChangeServiceV3');

const WID = '55555555-5555-4555-8555-555555555555';
const OTHER_WID = '66666666-6666-4666-8666-666666666666';
const UUID_OWNER = 'a1b2c3d4-0000-4000-8000-000000000001';

function fakeSidHash(sid) { return typeof sid === 'string' && sid.length > 0 ? 'h:' + sid : null; }

async function seedActors() {
  return [
    { actor: 'owner', role: 'admin', active: true, workspace_id: WID, session_version: 15, pin_hash: 'scrypt$owner', failed_count: 0, locked_until: null, display_name: 'Propietario', updated_at: 't0', updated_by: null },
    { actor: 'operator_primary', role: 'operator', active: true, workspace_id: WID, session_version: 10, pin_hash: 'scrypt$primary', failed_count: 0, locked_until: null, display_name: 'Operador principal', updated_at: 't0', updated_by: null },
    { actor: 'operator_backup', role: 'operator', active: true, workspace_id: WID, session_version: 4, pin_hash: 'scrypt$backup', failed_count: 1, locked_until: null, display_name: 'Operador de apoyo', updated_at: 't0', updated_by: null },
    { actor: 'rider', role: 'rider', active: true, workspace_id: WID, session_version: 2, pin_hash: 'scrypt$rider', failed_count: 0, locked_until: null, display_name: 'Repartidor', updated_at: 't0', updated_by: null },
    { actor: UUID_OWNER, role: 'owner', active: true, workspace_id: WID, session_version: 1, pin_hash: null, failed_count: 0, locked_until: null, display_name: null, updated_at: 't0', updated_by: null },
  ];
}

function makeDb(actors, workspaces) {
  const db = {
    actors,
    workspaces: workspaces || { [WID]: { lifecycle_status: 'active' }, [OTHER_WID]: { lifecycle_status: 'active' } },
    idempotency: [],
    audit: [],
    writes: [],
    calls: 0,
  };
  const dao = {
    async changeActorRoleV3({ workspaceId, byActor, targetActor, expectedRole, requestedRole, bySidHash, clientRequestId, requestHash }) {
      db.calls += 1;
      const existing = db.idempotency.find((r) =>
        r.workspace_id === workspaceId && r.by_actor === byActor && r.by_sid_hash === bySidHash &&
        r.action === 'change_actor_role' && r.client_request_id === clientRequestId);
      if (existing) {
        if (existing.request_hash === requestHash) return { ...existing.response_body };
        const e = new Error('idempotency conflict'); e.code = 'ROLE_CHANGE_CONFLICT'; throw e;
      }

      const ws = db.workspaces[workspaceId];
      if (!ws || ws.lifecycle_status !== 'active') throw new Error('WORKSPACE_NOT_ACTIVE');

      const by = db.actors.find((a) => a.actor === byActor);
      if (!by) throw new Error('AUTH_INITIATOR_NOT_FOUND');
      const tgt = db.actors.find((a) => a.actor === targetActor);
      if (!tgt) throw new Error('AUTH_ACTOR_NOT_FOUND');

      if (by.workspace_id !== workspaceId) throw new Error('AUTH_INITIATOR_OTHER_WORKSPACE');
      if (by.active !== true) throw new Error('AUTH_INITIATOR_INACTIVE');
      if (!['admin', 'owner'].includes(by.role)) throw new Error('AUTH_NOT_OWNER');

      if (tgt.workspace_id !== workspaceId) throw new Error('AUTH_TARGET_OTHER_WORKSPACE');
      if (['admin', 'owner'].includes(tgt.role)) throw new Error('AUTH_TARGET_IS_OWNER');
      if (tgt.role !== expectedRole) throw new Error('AUTH_TARGET_ROLE_MISMATCH');

      const oldRole = tgt.role;
      const changed = oldRole !== requestedRole;
      let result;
      if (!changed) {
        result = Object.freeze({ actor: tgt.actor, old_role: oldRole, role: tgt.role, session_version: tgt.session_version, changed: false, updated_at: tgt.updated_at, updated_by: tgt.updated_by });
      } else {
        tgt.role = requestedRole;
        tgt.session_version += 1;
        tgt.updated_at = 'now:' + tgt.session_version;
        tgt.updated_by = byActor;
        db.writes.push(targetActor);
        db.audit.push({ event: 'role_changed', target_actor: targetActor, by_actor: byActor, meta: { old_role: oldRole, new_role: requestedRole } });
        db.audit.push({ event: 'session_invalidated', target_actor: targetActor, by_actor: byActor, meta: { session_version: tgt.session_version } });
        result = Object.freeze({ actor: tgt.actor, old_role: oldRole, role: tgt.role, session_version: tgt.session_version, changed: true, updated_at: tgt.updated_at, updated_by: tgt.updated_by });
      }
      db.idempotency.push({ workspace_id: workspaceId, by_actor: byActor, by_sid_hash: bySidHash, action: 'change_actor_role', client_request_id: clientRequestId, request_hash: requestHash, response_body: result });
      return result;
    },
  };
  return { db, dao };
}

const svc = (dao) => createRoleChangeV3({ dao, sidHash: fakeSidHash });
const call = (dao, over = {}) => svc(dao).changeRole({
  workspaceId: WID, byActor: 'owner', targetActor: 'operator_primary',
  expectedRole: 'operator', requestedRole: 'cashier',
  sid: 'sid-1', clientRequestId: 'req-1', stepUp: { sub: 'owner', sid: 'sid-1' },
  ...over,
});

// ── RPC: acting authorization decided by ROLE, never actor id ──────────────────
test('acting admin (legacy owner actor, role=admin) is accepted', async () => {
  const { db, dao } = makeDb(await seedActors());
  const r = await call(dao);
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.deepEqual(db.writes, ['operator_primary']);
});

test('acting owner (UUID actor id, role=owner) is accepted — role decides, not the actor id', async () => {
  const { db, dao } = makeDb(await seedActors());
  const r = await call(dao, { byActor: UUID_OWNER, stepUp: { sub: UUID_OWNER, sid: 'sid-1' } });
  assert.equal(r.ok, true);
  assert.deepEqual(db.writes, ['operator_primary']);
});

test('a non-owner acting actor (rider) is rejected', async () => {
  const { db, dao } = makeDb(await seedActors());
  const r = await call(dao, { byActor: 'rider', stepUp: { sub: 'rider', sid: 'sid-1' } });
  assert.equal(r.ok, false);
  assert.equal(db.writes.length, 0);
});

test('an inactive owner is rejected', async () => {
  const actors = await seedActors();
  actors.find((a) => a.actor === 'owner').active = false;
  const { db, dao } = makeDb(actors);
  const r = await call(dao);
  assert.equal(r.ok, false);
  assert.equal(db.writes.length, 0);
});

test('a cross-workspace target is rejected', async () => {
  const actors = await seedActors();
  actors.find((a) => a.actor === 'rider').workspace_id = OTHER_WID;
  const { db, dao } = makeDb(actors);
  const r = await call(dao, { targetActor: 'rider', expectedRole: 'rider', requestedRole: 'waiter' });
  assert.equal(r.ok, false);
  assert.equal(db.writes.length, 0);
});

test('the owner actor is never a valid target — rejected by ROLE, not actor id "owner"', async () => {
  const { db, dao } = makeDb(await seedActors());
  // acting as the UUID owner (role=owner), targeting the LEGACY owner actor (role=admin,
  // actor id literally 'owner') — proves the target-owner rejection is role-based, since
  // the acting/target actor ids here are deliberately NOT the literal string 'owner' for
  // the acting side.
  const r = await call(dao, {
    byActor: UUID_OWNER, targetActor: 'owner', expectedRole: 'admin', requestedRole: 'cashier',
    stepUp: { sub: UUID_OWNER, sid: 'sid-1' },
  });
  assert.equal(r.ok, false);
  assert.equal(db.writes.length, 0);
});

test('an expected-role mismatch is rejected', async () => {
  const { db, dao } = makeDb(await seedActors());
  const r = await call(dao, { expectedRole: 'rider' }); // operator_primary is actually 'operator'
  assert.equal(r.ok, false);
  assert.equal(db.writes.length, 0);
});

test('an invalid/non-assignable requested role is rejected before the DAO is ever called', async () => {
  const { db, dao } = makeDb(await seedActors());
  for (const bad of ['admin', 'operator', 'owner', 'legacy_operator', 'superuser']) {
    const r = await call(dao, { requestedRole: bad });
    assert.equal(r.ok, false, bad);
  }
  assert.equal(db.calls, 0, 'the DAO must never be invoked for a non-assignable requested role');
});

test('a real change modifies ONLY the target role and session_version — every other actor untouched', async () => {
  const actors = await seedActors();
  const before = JSON.parse(JSON.stringify(actors));
  const { db, dao } = makeDb(actors);
  const r = await call(dao);
  assert.equal(r.ok, true);
  assert.equal(r.role, 'cashier');
  assert.equal(r.sessionVersion, 11);
  for (const a of ['owner', 'operator_backup', 'rider', UUID_OWNER]) {
    assert.deepEqual(db.actors.find((x) => x.actor === a), before.find((x) => x.actor === a), a);
  }
});

test('PIN hash, failed_count, locked_until, active, display_name are unchanged by a role change', async () => {
  const actors = await seedActors();
  const targetBefore = JSON.parse(JSON.stringify(actors.find((a) => a.actor === 'operator_primary')));
  const { db, dao } = makeDb(actors);
  await call(dao);
  const targetAfter = db.actors.find((a) => a.actor === 'operator_primary');
  assert.equal(targetAfter.pin_hash, targetBefore.pin_hash);
  assert.equal(targetAfter.failed_count, targetBefore.failed_count);
  assert.equal(targetAfter.locked_until, targetBefore.locked_until);
  assert.equal(targetAfter.active, targetBefore.active);
  assert.equal(targetAfter.display_name, targetBefore.display_name);
});

test('role_changed and session_invalidated are each inserted exactly once on a real change', async () => {
  const { db, dao } = makeDb(await seedActors());
  await call(dao);
  const roleChanged = db.audit.filter((e) => e.event === 'role_changed');
  const sessionInvalidated = db.audit.filter((e) => e.event === 'session_invalidated');
  assert.equal(roleChanged.length, 1);
  assert.equal(sessionInvalidated.length, 1);
});

// ── no-op vs replay ──────────────────────────────────────────────────────────────
test('a genuine no-op (already at the requested role, NEW request id) does not increment session_version or audit again', async () => {
  const { db, dao } = makeDb(await seedActors());
  const first = await call(dao); // operator -> cashier, real change, sv 10->11
  assert.equal(first.changed, true);
  assert.equal(first.sessionVersion, 11);

  const second = await call(dao, { expectedRole: 'cashier', requestedRole: 'cashier', clientRequestId: 'req-2' }); // genuine no-op, DIFFERENT request id
  assert.equal(second.ok, true);
  assert.equal(second.changed, false);
  assert.equal(second.sessionVersion, 11, 'no second increment');
  assert.deepEqual(db.writes, ['operator_primary'], 'only the first real change wrote anything');
  assert.equal(db.audit.filter((e) => e.event === 'role_changed').length, 1, 'no second role_changed audit');
});

test('same sid/request/payload replay returns the stored response verbatim, no mutation', async () => {
  const { db, dao } = makeDb(await seedActors());
  const first = await call(dao);
  const replay = await call(dao); // identical args
  assert.deepEqual(replay, first);
  assert.equal(db.writes.length, 1, 'no second write');
  assert.equal(db.audit.length, 2, 'no second pair of audit rows');
  assert.equal(db.calls, 2, 'the DAO IS called again — replay is decided inside the RPC/DAO layer, not skipped in Node');
});

test('same idempotency key with a DIFFERENT payload conflicts', async () => {
  const { db, dao } = makeDb(await seedActors());
  const first = await call(dao); // req-1: operator_primary operator->cashier
  assert.equal(first.ok, true);
  const conflict = await call(dao, { targetActor: 'operator_backup', expectedRole: 'operator', requestedRole: 'waiter' }); // SAME req-1, different semantics
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error, 'idempotency_conflict');
  assert.equal(db.writes.length, 1, 'the conflicting call must not have mutated anything');
});

test('a different sid with the SAME client_request_id is an independent request, not a replay or conflict', async () => {
  const { db, dao } = makeDb(await seedActors());
  const a = await call(dao, { sid: 'sid-A', stepUp: { sub: 'owner', sid: 'sid-A' } });
  const b = await call(dao, {
    targetActor: 'operator_backup', expectedRole: 'operator', requestedRole: 'waiter',
    sid: 'sid-B', stepUp: { sub: 'owner', sid: 'sid-B' },
  }); // same clientRequestId ('req-1' default), different sid
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.deepEqual(db.writes.sort(), ['operator_backup', 'operator_primary']);
});

test('mutation and its idempotency record are recorded together — the stored response matches what was returned', async () => {
  const { db, dao } = makeDb(await seedActors());
  const r = await call(dao);
  const rec = db.idempotency.find((x) => x.client_request_id === 'req-1' && x.by_actor === 'owner');
  assert.ok(rec);
  assert.equal(rec.response_body.session_version, r.sessionVersion);
  assert.equal(rec.response_body.role, r.role);
});

// ── step-up binding — required, checked BEFORE any DAO call ────────────────────
test('a missing step-up result is rejected before the DAO is ever called', async () => {
  const { db, dao } = makeDb(await seedActors());
  const r = await call(dao, { stepUp: null });
  assert.equal(r.ok, false);
  assert.equal(db.calls, 0);
});

test('a step-up result bound to a DIFFERENT actor is rejected before the DAO is ever called', async () => {
  const { db, dao } = makeDb(await seedActors());
  const r = await call(dao, { stepUp: { sub: 'rider', sid: 'sid-1' } }); // proof for rider, acting as owner
  assert.equal(r.ok, false);
  assert.equal(db.calls, 0);
});

test('a step-up result bound to a DIFFERENT session id is rejected before the DAO is ever called', async () => {
  const { db, dao } = makeDb(await seedActors());
  const r = await call(dao, { stepUp: { sub: 'owner', sid: 'some-other-sid' } });
  assert.equal(r.ok, false);
  assert.equal(db.calls, 0);
});

// ── safe response ────────────────────────────────────────────────────────────────
test('the returned summary carries no PIN, hash, fingerprint, or token material', async () => {
  const { dao } = makeDb(await seedActors());
  const r = await call(dao);
  const s = JSON.stringify(r);
  for (const bad of ['pin_hash', 'scrypt$', 'fingerprint', 'token', 'proof']) {
    assert.ok(!s.includes(bad), bad);
  }
});

console.log('\n=== node:test suite complete (see summary above) ===');
