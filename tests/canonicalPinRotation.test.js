'use strict';
// S2-7D2 — the CANONICAL rotation protocol and the uniqueness invariant.
// Real pinPolicy + real scrypt. The fake DB models the SQL contract that matters:
//   * a per-workspace serialisation point (the workspace row lock);
//   * the snapshot of every OTHER actor re-validated under that lock;
//   * AUTH_ROTATION_STALE (no write) on any drift.
// Concurrency is exercised by interleaving two rotations that both read first and only then
// commit — the shape that broke the earlier owner-only design.
// Run: node tests/canonicalPinRotation.test.js
const assert = require('node:assert/strict');
const test = require('node:test');

const pinPolicy = require('../src/auth/pinPolicy');
const { hashPin, verifyPin } = require('../src/auth/scrypt');
const { createPinRotation } = require('../src/auth/pinRotationService');

const WID = '22222222-2222-4222-8222-222222222222';
const UID = '11111111-1111-4111-8111-111111111111';
const ipHash = () => 'a'.repeat(32);

async function seedActors() {
  return [
    { actor: 'operator_backup', role: 'operator', active: true, workspace_id: WID, session_version: 4, pin_hash: await hashPin('573914') },
    { actor: 'operator_primary', role: 'operator', active: true, workspace_id: WID, session_version: 10, pin_hash: await hashPin('482913') },
    { actor: 'owner', role: 'admin', active: true, workspace_id: WID, session_version: 14, pin_hash: await hashPin('903421756') },
    { actor: 'rider', role: 'rider', active: true, workspace_id: WID, session_version: 2, pin_hash: await hashPin('619472') },
  ];
}

// Fake DB with the SQL invariants. `commit()` is serialised per workspace, mirroring the
// workspace row lock that every rotation takes before validating its snapshot.
function makeDb(actors) {
  const db = {
    actors, writes: [], onboardingAt: null,
    audit: [], stale: 0,
    chain: Promise.resolve(),           // the per-workspace serialisation point
  };
  const dao = {
    async listActorsWithWorkspaceForVerify_SENSITIVE() {
      return db.actors.map((a) => ({ ...a }));
    },
    setActorPinV2(args) {
      // queue behind any in-flight rotation for this workspace (the FOR UPDATE lock)
      const run = db.chain.then(async () => {
        const { targetActor, expectedRole, pinHash, seen, callerKind, byActor } = args;
        const tgt = db.actors.find((a) => a.actor === targetActor);
        if (!tgt) throw new Error('AUTH_ACTOR_NOT_FOUND');
        if (tgt.role !== expectedRole) throw new Error('AUTH_TARGET_ROLE_MISMATCH');

        const others = db.actors.filter((a) => a.workspace_id === tgt.workspace_id && a.actor !== targetActor);
        if (!Array.isArray(seen) || seen.length !== others.length) { db.stale++; throw new Error('AUTH_ROTATION_STALE'); }
        for (const cur of others) {
          const s = seen.find((x) => x.actor === cur.actor);
          if (!s || s.active !== cur.active || (s.pin_hash ?? null) !== (cur.pin_hash ?? null)) {
            db.stale++; throw new Error('AUTH_ROTATION_STALE');
          }
        }
        const event = tgt.pin_hash == null ? 'pin_set' : 'pin_change';
        tgt.pin_hash = pinHash;
        tgt.session_version += 1;
        tgt.failed_count = 0; tgt.locked_until = null;
        tgt.updated_by = callerKind === 'operational_admin' ? byActor : null;
        db.writes.push(targetActor);
        db.audit.push({ event, target: targetActor, by: tgt.updated_by });
        if (callerKind === 'account_owner' && targetActor === 'owner') {
          db.onboardingAt = db.onboardingAt || 'now';
        }
        return {
          actor: tgt.actor, role: tgt.role, active: tgt.active,
          session_version: tgt.session_version, failed_count: 0, locked_until: null,
          updated_at: 'now', updated_by: tgt.updated_by, changed: true, event,
          onboarding_completed: callerKind === 'account_owner' && targetActor === 'owner',
        };
      });
      db.chain = run.catch(() => {});   // keep the chain alive after a rejection
      return run;
    },
  };
  return { db, dao };
}

const rot = (dao) => createPinRotation({ dao, hashPin, verifyPin, pinPolicy, ipHash });
const asOwner = (dao, pin) => rot(dao).rotate({
  targetActor: 'owner', newPin: pin, trustedClientIp: '1.2.3.4',
  callerKind: 'account_owner', userId: UID, workspaceId: WID,
});
const asAdmin = (dao, target, pin, confirm = null) => rot(dao).rotate({
  targetActor: target, newPin: pin, trustedClientIp: '1.2.3.4',
  callerKind: 'operational_admin', byActor: 'owner', confirm,
});

// ── policy ─────────────────────────────────────────────────────────────────
test('every new rotation requires exactly six digits (both caller kinds)', async () => {
  const { db, dao } = makeDb(await seedActors());
  for (const bad of ['48291', '4829156', '903421756', '48291a', '123456']) {
    assert.equal((await asOwner(dao, bad)).ok, false, `owner ${bad}`);
    assert.equal((await asAdmin(dao, 'rider', bad)).ok, false, `rider ${bad}`);
  }
  assert.equal(db.writes.length, 0, 'no write for any rejected PIN');
});

test('a valid six-digit PIN rotates only the requested actor', async () => {
  const { db, dao } = makeDb(await seedActors());
  const before = JSON.parse(JSON.stringify(db.actors));
  const r = await asOwner(dao, '482915');
  assert.equal(r.ok, true);
  assert.equal(r.sessionVersion, 15);
  assert.deepEqual(db.writes, ['owner']);
  for (const a of ['operator_primary', 'operator_backup', 'rider']) {
    assert.deepEqual(db.actors.find((x) => x.actor === a), before.find((x) => x.actor === a));
  }
});

// ── uniqueness across BOTH paths ───────────────────────────────────────────
test('owner cannot take a PIN already held by an active operator or rider', async () => {
  for (const [victim, pin] of [['operator_primary', '482913'], ['operator_backup', '573914'], ['rider', '619472']]) {
    const { db, dao } = makeDb(await seedActors());
    const r = await asOwner(dao, pin);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'pin_duplicate', victim);
    assert.equal(db.writes.length, 0);
  }
});

test('an admin cannot give the rider a PIN the owner already holds', async () => {
  const actors = await seedActors();
  actors.find((a) => a.actor === 'owner').pin_hash = await hashPin('482915');
  const { db, dao } = makeDb(actors);
  const r = await asAdmin(dao, 'rider', '482915');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'pin_duplicate');
  assert.equal(db.writes.length, 0);
});

test('the target is excluded from its own duplicate check', async () => {
  const actors = await seedActors();
  actors.find((a) => a.actor === 'rider').pin_hash = await hashPin('482915');
  const { db, dao } = makeDb(actors);
  assert.equal((await asAdmin(dao, 'rider', '482915')).ok, true);
  assert.deepEqual(db.writes, ['rider']);
});

test('an inactive actor does not reserve a PIN', async () => {
  const actors = await seedActors();
  const rider = actors.find((a) => a.actor === 'rider');
  rider.active = false;
  const { dao } = makeDb(actors);
  assert.equal((await asOwner(dao, '619472')).ok, true);
});

// ── concurrency: the invariant across DIFFERENT targets ────────────────────
test('owner and rider rotating to the SAME candidate cannot both succeed', async () => {
  const { db, dao } = makeDb(await seedActors());
  // both read the same pre-state, then both try to commit
  const a = asOwner(dao, '482915');
  const b = asAdmin(dao, 'rider', '482915');
  const [ra, rb] = await Promise.all([a, b]);
  const ok = [ra, rb].filter((r) => r.ok === true);
  assert.equal(ok.length, 1, 'exactly one rotation may commit');
  assert.equal(db.writes.length, 1);
  // and the loser wrote nothing at all
  const loser = ra.ok ? rb : ra;
  assert.equal(loser.ok, false);
});

test('owner and operator_primary rotating to the SAME candidate cannot both succeed', async () => {
  const { db, dao } = makeDb(await seedActors());
  const [ra, rb] = await Promise.all([
    asOwner(dao, '482915'),
    asAdmin(dao, 'operator_primary', '482915'),
  ]);
  assert.equal([ra, rb].filter((r) => r.ok === true).length, 1);
  assert.equal(db.writes.length, 1);
});

test('two different-target rotations sharing one snapshot → exactly one stale rejection', async () => {
  const { db, dao } = makeDb(await seedActors());
  const [ra, rb] = await Promise.all([
    asAdmin(dao, 'operator_primary', '482915'),
    asAdmin(dao, 'operator_backup', '571936'),   // different PIN: only the snapshot clashes
  ]);
  assert.equal([ra, rb].filter((r) => r.ok === true).length, 1, 'one commits');
  assert.equal(db.stale, 1, 'the other is rejected as stale');
  assert.equal(db.writes.length, 1, 'the stale one wrote nothing');
});

test('a failed rotation changes no hash, session version, lock state, marker or audit', async () => {
  const { db, dao } = makeDb(await seedActors());
  const before = JSON.parse(JSON.stringify(db.actors));
  const r = await asOwner(dao, '619472');       // rider's PIN → duplicate
  assert.equal(r.ok, false);
  assert.deepEqual(db.actors, before);
  assert.equal(db.onboardingAt, null);
  assert.equal(db.audit.length, 0);
});

// ── onboarding marker ──────────────────────────────────────────────────────
test('onboarding completes only for owner via the account path', async () => {
  const { db, dao } = makeDb(await seedActors());
  const r = await asOwner(dao, '482915');
  assert.equal(r.ok, true);
  assert.equal(r.onboardingCompleted, true);
  assert.equal(db.onboardingAt, 'now');
});

test('the operational-admin path never completes onboarding, even targeting owner', async () => {
  const { db, dao } = makeDb(await seedActors());
  const r = await asAdmin(dao, 'owner', '482915', 'CHANGE_OWNER_PIN');
  assert.equal(r.ok, true);
  assert.equal(r.onboardingCompleted, false);
  assert.equal(db.onboardingAt, null);
});

test('the account path may target ONLY the owner actor', async () => {
  const { db, dao } = makeDb(await seedActors());
  const r = await rot(dao).rotate({
    targetActor: 'rider', newPin: '482915', trustedClientIp: '1.2.3.4',
    callerKind: 'account_owner', userId: UID, workspaceId: WID,
  });
  assert.equal(r.ok, false);
  assert.equal(db.writes.length, 0);
});

test('a workspace mismatch on the account path fails closed', async () => {
  const { db, dao } = makeDb(await seedActors());
  const r = await rot(dao).rotate({
    targetActor: 'owner', newPin: '482915', trustedClientIp: '1.2.3.4',
    callerKind: 'account_owner', userId: UID, workspaceId: '33333333-3333-4333-8333-333333333333',
  });
  assert.equal(r.ok, false);
  assert.equal(db.writes.length, 0);
});

test('an unassigned actor (no workspace) fails closed', async () => {
  const actors = await seedActors();
  actors.find((a) => a.actor === 'owner').workspace_id = null;
  const { db, dao } = makeDb(actors);
  assert.equal((await asOwner(dao, '482915')).ok, false);
  assert.equal(db.writes.length, 0);
});

// ── secrecy ────────────────────────────────────────────────────────────────
test('plaintext never reaches the RPC payload or the returned result', async () => {
  const PIN = '482915';
  const { dao } = makeDb(await seedActors());
  const payloads = [];
  const wrapped = { ...dao, setActorPinV2: (a) => { payloads.push(JSON.stringify(a)); return dao.setActorPinV2(a); } };
  const r = await asOwner(wrapped, PIN);
  assert.equal(r.ok, true);
  assert.ok(!payloads.join('').includes(PIN));
  assert.ok(!JSON.stringify(r).includes(PIN));
});

test('the snapshot carries only actor/active/pin_hash and excludes the target', async () => {
  let seen = null;
  const { dao } = makeDb(await seedActors());
  const wrapped = { ...dao, setActorPinV2: (a) => { seen = a.seen; return dao.setActorPinV2(a); } };
  await asAdmin(wrapped, 'rider', '482915');
  assert.equal(seen.length, 3);
  assert.ok(!seen.some((s) => s.actor === 'rider'));
  for (const s of seen) assert.deepEqual(Object.keys(s).sort(), ['active', 'actor', 'pin_hash']);
});

// ── login untouched ────────────────────────────────────────────────────────
test('legacy-length PINs still authenticate until individually rotated', () => {
  assert.equal(pinPolicy.validateUniversalPinFormat('903421756').ok, true);
  assert.equal(pinPolicy.validatePinFormat('903421756', 'admin').ok, true);
  assert.equal(pinPolicy.validatePinFormat('4829137', 'operator').ok, true);
  // but they can no longer be SET
  assert.equal(pinPolicy.validateNewPinFormat('903421756').ok, false);
});
