'use strict';
// Test per src/auth/accessUserServiceV3.js + accessUserDaoV3.js -- Access Control V3
// Block V3-D (FOUNDATION, UNWIRED). Eseguire: node tests/accessUserServiceV3.test.js
//
// The fake DAO mirrors auth_create_access_user_v3 / auth_rename_access_user_v3's actual
// SQL decision logic (workspace lock, acting-owner authorization by ROLE, idempotency
// lookup-or-record, no-op-vs-real-change for rename) so the service is exercised against
// realistic RPC semantics, exactly like roleChangeServiceV3.test.js's fake mirrors
// auth_change_actor_role_v3.
const assert = require('node:assert/strict');
const test = require('node:test');

const { createAccessUserV3Service } = require('../src/auth/accessUserServiceV3');

const WID = '77777777-7777-4777-8777-777777777777';
const OTHER_WID = '88888888-8888-4888-8888-888888888888';
const UUID_OWNER = 'a1b2c3d4-0000-4000-8000-000000000002';

function fakeSidHash(sid) { return typeof sid === 'string' && sid.length > 0 ? 'h:' + sid : null; }
let uuidCounter = 0;
function fakeUuid() { uuidCounter += 1; return `dddddddd-dddd-4ddd-8ddd-${String(uuidCounter).padStart(12, '0')}`; }

async function seedActors() {
  return [
    { actor: 'owner', role: 'admin', active: true, workspace_id: WID, session_version: 15, pin_hash: 'scrypt$owner', display_name: 'Propietario', created_at: 't0', updated_at: 't0', updated_by: null },
    { actor: 'operator_primary', role: 'operator', active: true, workspace_id: WID, session_version: 10, pin_hash: 'scrypt$primary', display_name: 'Operador principal', created_at: 't0', updated_at: 't0', updated_by: null },
    { actor: 'rider', role: 'rider', active: true, workspace_id: WID, session_version: 2, pin_hash: 'scrypt$rider', display_name: 'Repartidor', created_at: 't0', updated_at: 't0', updated_by: null },
    { actor: UUID_OWNER, role: 'owner', active: true, workspace_id: WID, session_version: 1, pin_hash: null, display_name: 'UUID Owner', created_at: 't0', updated_at: 't0', updated_by: null },
  ];
}

function makeDb(actors) {
  const db = {
    actors,
    workspaces: { [WID]: { lifecycle_status: 'active' }, [OTHER_WID]: { lifecycle_status: 'active' } },
    idempotency: [], audit: [], created: [], renamed: [], createCalls: 0, renameCalls: 0,
  };
  const findIdem = (action, args) => db.idempotency.find((r) =>
    r.workspace_id === args.workspaceId && r.by_actor === args.byActor && r.by_sid_hash === args.bySidHash &&
    r.action === action && r.client_request_id === args.clientRequestId);

  const dao = {
    async createAccessUserV3(args) {
      db.createCalls += 1;
      const existing = findIdem('create_access_user_v3', args);
      if (existing) {
        if (existing.request_hash === args.requestHash) return { ...existing.response_body };
        const e = new Error('conflict'); e.code = 'ACCESS_USER_CONFLICT'; throw e;
      }
      const ws = db.workspaces[args.workspaceId];
      if (!ws || ws.lifecycle_status !== 'active') throw new Error('WORKSPACE_NOT_ACTIVE');
      const by = db.actors.find((a) => a.actor === args.byActor);
      if (!by) throw new Error('AUTH_INITIATOR_NOT_FOUND');
      if (by.workspace_id !== args.workspaceId) throw new Error('AUTH_INITIATOR_OTHER_WORKSPACE');
      if (by.active !== true) throw new Error('AUTH_INITIATOR_INACTIVE');
      if (!['admin', 'owner'].includes(by.role)) throw new Error('AUTH_NOT_OWNER');

      const newActor = fakeUuid();
      const row = {
        actor: newActor, role: args.requestedRole, workspace_id: args.workspaceId, pin_hash: null,
        session_version: 1, active: true, failed_count: 0, locked_until: null,
        display_name: args.displayName, created_at: 'created:' + newActor, created_by: args.byActor,
        updated_at: 'created:' + newActor, updated_by: null,
      };
      db.actors.push(row);
      db.created.push(newActor);
      db.audit.push({ event: 'user_created', target_actor: newActor, by_actor: args.byActor });
      const result = {
        actor: row.actor, display_name: row.display_name, role: row.role, active: row.active,
        session_version: row.session_version, created_at: row.created_at, updated_at: row.updated_at,
      };
      db.idempotency.push({ workspace_id: args.workspaceId, by_actor: args.byActor, by_sid_hash: args.bySidHash, action: 'create_access_user_v3', client_request_id: args.clientRequestId, request_hash: args.requestHash, response_body: result });
      return result;
    },
    async renameAccessUserV3(args) {
      db.renameCalls += 1;
      const existing = findIdem('rename_access_user_v3', args);
      if (existing) {
        if (existing.request_hash === args.requestHash) return { ...existing.response_body };
        const e = new Error('conflict'); e.code = 'ACCESS_USER_CONFLICT'; throw e;
      }
      const ws = db.workspaces[args.workspaceId];
      if (!ws || ws.lifecycle_status !== 'active') throw new Error('WORKSPACE_NOT_ACTIVE');
      const by = db.actors.find((a) => a.actor === args.byActor);
      if (!by) throw new Error('AUTH_INITIATOR_NOT_FOUND');
      const tgt = db.actors.find((a) => a.actor === args.targetActor);
      if (!tgt) throw new Error('AUTH_ACTOR_NOT_FOUND');
      if (by.workspace_id !== args.workspaceId) throw new Error('AUTH_INITIATOR_OTHER_WORKSPACE');
      if (by.active !== true) throw new Error('AUTH_INITIATOR_INACTIVE');
      if (!['admin', 'owner'].includes(by.role)) throw new Error('AUTH_NOT_OWNER');
      if (tgt.workspace_id !== args.workspaceId) throw new Error('AUTH_TARGET_OTHER_WORKSPACE');

      const oldName = tgt.display_name;
      const changed = oldName !== args.newDisplayName;
      let result;
      if (!changed) {
        result = { actor: tgt.actor, display_name: tgt.display_name, role: tgt.role, active: tgt.active, session_version: tgt.session_version, updated_at: tgt.updated_at, updated_by: tgt.updated_by };
      } else {
        tgt.display_name = args.newDisplayName;
        tgt.updated_at = 'renamed:' + tgt.actor + ':' + Math.random();
        tgt.updated_by = args.byActor;
        db.renamed.push(args.targetActor);
        db.audit.push({ event: 'user_renamed', target_actor: args.targetActor, by_actor: args.byActor });
        result = { actor: tgt.actor, display_name: tgt.display_name, role: tgt.role, active: tgt.active, session_version: tgt.session_version, updated_at: tgt.updated_at, updated_by: tgt.updated_by };
      }
      db.idempotency.push({ workspace_id: args.workspaceId, by_actor: args.byActor, by_sid_hash: args.bySidHash, action: 'rename_access_user_v3', client_request_id: args.clientRequestId, request_hash: args.requestHash, response_body: result });
      return result;
    },
    async listAccessUsersForWorkspace(workspaceId) {
      return db.actors.filter((a) => a.workspace_id === workspaceId).map((a) => {
        const { pin_hash, ...safe } = a;
        return { ...safe, has_pin: pin_hash != null };
      });
    },
    async getAccessUserForWorkspace(workspaceId, actor) {
      const row = db.actors.find((a) => a.workspace_id === workspaceId && a.actor === actor);
      if (!row) return null;
      const { pin_hash, ...safe } = row;
      return { ...safe, has_pin: pin_hash != null };
    },
  };
  return { db, dao };
}

const svc = (dao) => createAccessUserV3Service({ dao, sidHash: fakeSidHash });
const create = (dao, over = {}) => svc(dao).createAccessUser({
  workspaceId: WID, byActor: 'owner', displayName: 'Ana Torres', requestedRole: 'cashier',
  sid: 'sid-1', clientRequestId: 'req-1', stepUp: { sub: 'owner', sid: 'sid-1' },
  ...over,
});
const rename = (dao, targetActor, newDisplayName, over = {}) => svc(dao).renameAccessUser({
  workspaceId: WID, byActor: 'owner', targetActor, newDisplayName,
  sid: 'sid-1', clientRequestId: 'req-rename-1', stepUp: { sub: 'owner', sid: 'sid-1' },
  ...over,
});

// ── CREATE ───────────────────────────────────────────────────────────────────────
test('acting admin (legacy owner, role=admin) can create a cashier', async () => {
  const { db, dao } = makeDb(await seedActors());
  const r = await create(dao);
  assert.equal(r.ok, true);
  assert.equal(r.dbRole, 'cashier');
  assert.equal(r.canonicalRole, 'cashier');
  assert.equal(db.created.length, 1);
});

test('acting owner (UUID actor, role=owner) can create a user -- role decides, not the actor id', async () => {
  const { db, dao } = makeDb(await seedActors());
  const r = await create(dao, { byActor: UUID_OWNER, stepUp: { sub: UUID_OWNER, sid: 'sid-1' } });
  assert.equal(r.ok, true);
  assert.equal(db.created.length, 1);
});

test('a non-owner acting actor is rejected', async () => {
  const { db, dao } = makeDb(await seedActors());
  const r = await create(dao, { byActor: 'rider', stepUp: { sub: 'rider', sid: 'sid-1' } });
  assert.equal(r.ok, false);
  assert.equal(db.created.length, 0);
});

test('an inactive owner is rejected', async () => {
  const actors = await seedActors();
  actors.find((a) => a.actor === 'owner').active = false;
  const { db, dao } = makeDb(actors);
  const r = await create(dao);
  assert.equal(r.ok, false);
  assert.equal(db.created.length, 0);
});

test('cross-workspace acting context is rejected', async () => {
  const { db, dao } = makeDb(await seedActors());
  const r = await create(dao, { workspaceId: OTHER_WID });
  assert.equal(r.ok, false);
  assert.equal(db.created.length, 0);
});

test('exactly the 5 assignable roles are accepted, everything else rejected before the DAO is called', async () => {
  const { db, dao } = makeDb(await seedActors());
  for (const role of ['cashier', 'waiter', 'kitchen', 'rider', 'shift_manager']) {
    const r = await create(dao, { requestedRole: role, clientRequestId: 'req-' + role });
    assert.equal(r.ok, true, role);
  }
  assert.equal(db.created.length, 5);
  for (const bad of ['admin', 'operator', 'owner', 'legacy_operator', 'superuser']) {
    const r = await create(dao, { requestedRole: bad, clientRequestId: 'req-bad-' + bad });
    assert.equal(r.ok, false, bad);
  }
  assert.equal(db.createCalls, 5, 'the DAO is never invoked for a non-assignable role');
});

test('creation defaults are exact: active=true, session_version=1, pin_hash NULL (has_pin false), no fingerprint concept touched', async () => {
  const { db, dao } = makeDb(await seedActors());
  const r = await create(dao);
  assert.equal(r.ok, true);
  assert.equal(r.active, true);
  assert.equal(r.sessionVersion, 1);
  const stored = db.actors.find((a) => a.actor === r.userId);
  assert.equal(stored.pin_hash, null);
  assert.equal(stored.failed_count, 0);
  assert.equal(stored.locked_until, null);
});

test('user_created audit inserted exactly once', async () => {
  const { db, dao } = makeDb(await seedActors());
  await create(dao);
  assert.equal(db.audit.filter((e) => e.event === 'user_created').length, 1);
});

test('replay (same sid/request/payload) returns the SAME originally-created actor, no second row', async () => {
  const { db, dao } = makeDb(await seedActors());
  const first = await create(dao);
  const replay = await create(dao);
  assert.equal(replay.userId, first.userId);
  assert.equal(db.created.length, 1, 'no second actor created');
});

test('same idempotency key with a DIFFERENT payload conflicts', async () => {
  const { db, dao } = makeDb(await seedActors());
  const first = await create(dao);
  assert.equal(first.ok, true);
  const conflict = await create(dao, { displayName: 'Otro Nombre' }); // same req-1, different display name
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error, 'idempotency_conflict');
  assert.equal(db.created.length, 1);
});

test('two independent requests may create users with the SAME display name', async () => {
  const { db, dao } = makeDb(await seedActors());
  const a = await create(dao, { clientRequestId: 'req-a' });
  const b = await create(dao, { clientRequestId: 'req-b' });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.notEqual(a.userId, b.userId);
  assert.equal(db.created.length, 2);
});

test('missing step-up is rejected before the DAO is ever called', async () => {
  const { db, dao } = makeDb(await seedActors());
  const r = await create(dao, { stepUp: null });
  assert.equal(r.ok, false);
  assert.equal(db.createCalls, 0);
});

test('step-up bound to a different actor/sid is rejected before the DAO is ever called', async () => {
  const { db, dao } = makeDb(await seedActors());
  const r1 = await create(dao, { stepUp: { sub: 'rider', sid: 'sid-1' } });
  const r2 = await create(dao, { stepUp: { sub: 'owner', sid: 'wrong-sid' } });
  assert.equal(r1.ok, false);
  assert.equal(r2.ok, false);
  assert.equal(db.createCalls, 0);
});

// ── RENAME ───────────────────────────────────────────────────────────────────────
test('owner can rename a target user', async () => {
  const { db, dao } = makeDb(await seedActors());
  const r = await rename(dao, 'operator_primary', 'Ana Nueva');
  assert.equal(r.ok, true);
  assert.equal(r.displayName, 'Ana Nueva');
  assert.deepEqual(db.renamed, ['operator_primary']);
});

test('owner can rename themselves (self-rename explicitly allowed)', async () => {
  const { db, dao } = makeDb(await seedActors());
  const r = await rename(dao, 'owner', 'Propietario Nuevo');
  assert.equal(r.ok, true);
  assert.deepEqual(db.renamed, ['owner']);
});

test('cross-workspace target is rejected', async () => {
  const actors = await seedActors();
  actors.find((a) => a.actor === 'rider').workspace_id = OTHER_WID;
  const { db, dao } = makeDb(actors);
  const r = await rename(dao, 'rider', 'Nuevo Nombre');
  assert.equal(r.ok, false);
  assert.equal(db.renamed.length, 0);
});

test('an invalid new display name is rejected before the DAO is called', async () => {
  const { db, dao } = makeDb(await seedActors());
  for (const bad of ['', '   ', 'x'.repeat(200)]) {
    const r = await rename(dao, 'operator_primary', bad, { clientRequestId: 'req-bad-' + bad.length });
    assert.equal(r.ok, false);
  }
  assert.equal(db.renameCalls, 0);
});

test('rename never changes role/session_version/active/pin', async () => {
  const actors = await seedActors();
  const { db, dao } = makeDb(actors);
  const before = JSON.parse(JSON.stringify(actors.find((a) => a.actor === 'operator_primary')));
  const r = await rename(dao, 'operator_primary', 'Nombre Nuevo');
  assert.equal(r.ok, true);
  const after = db.actors.find((a) => a.actor === 'operator_primary');
  assert.equal(after.role, before.role);
  assert.equal(after.session_version, before.session_version);
  assert.equal(after.active, before.active);
  assert.equal(after.pin_hash, before.pin_hash);
});

test('a no-op rename (identical normalized name, NEW request id) does not audit again', async () => {
  const { db, dao } = makeDb(await seedActors());
  const first = await rename(dao, 'operator_primary', 'Ana Torres');
  assert.equal(first.ok, true);
  const noop = await rename(dao, 'operator_primary', 'Ana Torres', { clientRequestId: 'req-rename-2' });
  assert.equal(noop.ok, true);
  assert.deepEqual(db.renamed, ['operator_primary'], 'only the first real rename wrote anything');
  assert.equal(db.audit.filter((e) => e.event === 'user_renamed').length, 1);
});

test('a real rename audits user_renamed exactly once', async () => {
  const { db, dao } = makeDb(await seedActors());
  await rename(dao, 'operator_primary', 'Nombre Nuevo');
  assert.equal(db.audit.filter((e) => e.event === 'user_renamed').length, 1);
});

test('replay (same key/payload) does not duplicate a rename', async () => {
  const { db, dao } = makeDb(await seedActors());
  const first = await rename(dao, 'operator_primary', 'Nombre Nuevo');
  const replay = await rename(dao, 'operator_primary', 'Nombre Nuevo');
  assert.deepEqual(replay, first);
  assert.deepEqual(db.renamed, ['operator_primary']);
  assert.equal(db.audit.filter((e) => e.event === 'user_renamed').length, 1);
});

test('rename missing step-up is rejected before the DAO is called', async () => {
  const { db, dao } = makeDb(await seedActors());
  const r = await rename(dao, 'operator_primary', 'Nombre Nuevo', { stepUp: null });
  assert.equal(r.ok, false);
  assert.equal(db.renameCalls, 0);
});

// ── READ ─────────────────────────────────────────────────────────────────────────
test('listAccessUsers requires owner authorization, verified via a real DAO lookup', async () => {
  const { dao } = makeDb(await seedActors());
  const asOwner = await svc(dao).listAccessUsers({ workspaceId: WID, byActor: 'owner' });
  assert.equal(asOwner.ok, true);
  assert.equal(asOwner.users.length, 4);
  const asRider = await svc(dao).listAccessUsers({ workspaceId: WID, byActor: 'rider' });
  assert.equal(asRider.ok, false);
});

test('list/get projections never leak pin_hash, and expose has_pin/canonical role safely', async () => {
  const { dao } = makeDb(await seedActors());
  const r = await svc(dao).listAccessUsers({ workspaceId: WID, byActor: 'owner' });
  assert.equal(r.ok, true);
  const s = JSON.stringify(r.users);
  assert.ok(!s.includes('scrypt$'));
  assert.ok(!s.includes('pin_hash'));
  const ownerRow = r.users.find((u) => u.userId === 'owner');
  assert.equal(ownerRow.hasPin, true);
  assert.equal(ownerRow.canonicalRole, 'owner'); // admin -> owner canonical mapping
  const uuidOwnerRow = r.users.find((u) => u.userId === UUID_OWNER);
  assert.equal(uuidOwnerRow.hasPin, false);
});

test('getAccessUser returns a safe single-user projection, not_found for a missing/foreign actor', async () => {
  const { dao } = makeDb(await seedActors());
  const found = await svc(dao).getAccessUser({ workspaceId: WID, byActor: 'owner', targetActor: 'rider' });
  assert.equal(found.ok, true);
  assert.equal(found.user.userId, 'rider');
  const missing = await svc(dao).getAccessUser({ workspaceId: WID, byActor: 'owner', targetActor: 'no-such-actor' });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'not_found');
});

test('read access requires owner authorization but no step-up context at all', async () => {
  const { dao } = makeDb(await seedActors());
  const r = await svc(dao).listAccessUsers({ workspaceId: WID, byActor: 'owner' }); // no sid/stepUp passed anywhere
  assert.equal(r.ok, true);
});

console.log('\n=== node:test suite complete (see summary above) ===');
