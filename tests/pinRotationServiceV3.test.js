'use strict';
// Test per src/auth/pinRotationServiceV3.js + pinRotationDaoV3.js — Access Control V3
// Block V3-B (FOUNDATION, UNWIRED). Eseguire: node tests/pinRotationServiceV3.test.js
//
// Same fake-DB shape as tests/canonicalPinRotation.test.js (workspace-serialised commit
// chain, snapshot-staleness check) plus the two things v3 adds: fingerprint capture on
// every write, and the Node-side PIN_RESERVED (collision with 'owner' specifically) vs
// PIN_DUPLICATE (collision with any other actor) distinction — decided entirely in
// pinRotationServiceV3.js BEFORE the DAO is ever called, so the fake DAO here needs no
// special RESERVED/DUPLICATE logic of its own, exactly like the real SQL function.
//
// Real pinPolicy + real scrypt + the real (pure) pinFingerprint module — only the
// network-facing DAO is faked.
const assert = require('node:assert/strict');
const test = require('node:test');

const pinPolicy = require('../src/auth/pinPolicy');
const { hashPin, verifyPin } = require('../src/auth/scrypt');
const { deriveFingerprint, deriveForAcceptedKeys } = require('../src/auth/pinFingerprint');
const { createPinRotationV3 } = require('../src/auth/pinRotationServiceV3');

const WID = '22222222-2222-4222-8222-222222222222';
const UID = '11111111-1111-4111-8111-111111111111';
const ipHash = () => 'a'.repeat(32);

function key(id) { return Object.freeze({ id, secret: require('crypto').randomBytes(32) }); }
const K_CURRENT_ONLY = Object.freeze({ current: key('k2'), previous: null });
const K_DUAL = Object.freeze({ current: key('k2'), previous: key('k1') });

async function seedActors() {
  return [
    { actor: 'operator_backup', role: 'operator', active: true, workspace_id: WID, session_version: 4, pin_hash: await hashPin('573914') },
    { actor: 'operator_primary', role: 'operator', active: true, workspace_id: WID, session_version: 10, pin_hash: await hashPin('482913') },
    { actor: 'owner', role: 'admin', active: true, workspace_id: WID, session_version: 14, pin_hash: await hashPin('903421756') },
    { actor: 'rider', role: 'rider', active: true, workspace_id: WID, session_version: 2, pin_hash: await hashPin('619472') },
  ];
}

function makeDb(actors) {
  const db = { actors, writes: [], fingerprints: [], chain: Promise.resolve(), stale: 0 };
  const dao = {
    async listActorsWithWorkspaceForVerify_SENSITIVE() {
      return db.actors.map((a) => ({ ...a }));
    },
    setActorPinV3(args) {
      const run = db.chain.then(async () => {
        const {
          targetActor, expectedRole, pinHash, seen, callerKind, byActor,
          keyIdCurrent, fingerprintCurrent, keyIdPrevious, fingerprintPrevious,
        } = args;
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
        if (!keyIdCurrent || !fingerprintCurrent) throw new Error('AUTH_FINGERPRINT_KEY_ID_INVALID');
        if ((keyIdPrevious === null) !== (fingerprintPrevious === null)) throw new Error('AUTH_FINGERPRINT_PREVIOUS_INCOMPLETE');

        const event = tgt.pin_hash == null ? 'pin_set' : 'pin_change';
        tgt.pin_hash = pinHash;
        tgt.session_version += 1;
        tgt.failed_count = 0; tgt.locked_until = null;
        tgt.updated_by = callerKind === 'operational_admin' ? byActor : null;
        db.writes.push(targetActor);
        db.fingerprints.push({ actor: targetActor, keyIdCurrent, fingerprintCurrent, keyIdPrevious, fingerprintPrevious });
        return {
          actor: tgt.actor, role: tgt.role, active: tgt.active,
          session_version: tgt.session_version, failed_count: 0, locked_until: null,
          updated_at: 'now', updated_by: tgt.updated_by, changed: true, event,
          onboarding_completed: callerKind === 'account_owner' && targetActor === 'owner',
        };
      });
      db.chain = run.catch(() => {});
      return run;
    },
  };
  return { db, dao };
}

const rot = (dao, fingerprintKeyConfig) => createPinRotationV3({
  dao, hashPin, verifyPin, pinPolicy, ipHash,
  fingerprintKeyConfig: fingerprintKeyConfig === undefined ? K_CURRENT_ONLY : fingerprintKeyConfig, deriveForAcceptedKeys,
});
const asOwner = (dao, pin, fkc) => rot(dao, fkc).rotate({
  targetActor: 'owner', newPin: pin, trustedClientIp: '1.2.3.4',
  callerKind: 'account_owner', userId: UID, workspaceId: WID,
});
const asAdmin = (dao, target, pin, fkc, confirm = null) => rot(dao, fkc).rotate({
  targetActor: target, newPin: pin, trustedClientIp: '1.2.3.4',
  callerKind: 'operational_admin', byActor: 'owner', confirm,
});

// ── policy (unchanged from v2) ─────────────────────────────────────────────────
test('every new rotation requires exactly six digits', async () => {
  const { db, dao } = makeDb(await seedActors());
  for (const bad of ['48291', '4829156', '903421756', '48291a', '123456']) {
    assert.equal((await asOwner(dao, bad)).ok, false, `owner ${bad}`);
  }
  assert.equal(db.writes.length, 0);
});

// ── fingerprint write: CURRENT-only key config ─────────────────────────────────
test('CURRENT-only key config: writes exactly one fingerprint, no previous', async () => {
  const { db, dao } = makeDb(await seedActors());
  const r = await asOwner(dao, '482915', K_CURRENT_ONLY);
  assert.equal(r.ok, true);
  assert.equal(db.fingerprints.length, 1);
  const fp = db.fingerprints[0];
  assert.equal(fp.keyIdCurrent, 'k2');
  assert.equal(fp.keyIdPrevious, null);
  assert.equal(fp.fingerprintPrevious, null);
  assert.equal(fp.fingerprintCurrent, deriveFingerprint(K_CURRENT_ONLY.current, '482915').fingerprint);
});

// ── fingerprint write: CURRENT + PREVIOUS (graceful rotation window) ──────────
test('dual-key config: writes both fingerprints, current and previous, correctly keyed', async () => {
  const { db, dao } = makeDb(await seedActors());
  const r = await asOwner(dao, '482915', K_DUAL);
  assert.equal(r.ok, true);
  const fp = db.fingerprints[0];
  assert.equal(fp.keyIdCurrent, 'k2');
  assert.equal(fp.keyIdPrevious, 'k1');
  assert.equal(fp.fingerprintCurrent, deriveFingerprint(K_DUAL.current, '482915').fingerprint);
  assert.equal(fp.fingerprintPrevious, deriveFingerprint(K_DUAL.previous, '482915').fingerprint);
  assert.notEqual(fp.fingerprintCurrent, fp.fingerprintPrevious);
});

test('fingerprints are written ONLY for the target actor, never for others', async () => {
  const { db, dao } = makeDb(await seedActors());
  await asAdmin(dao, 'rider', '482915', K_DUAL);
  assert.equal(db.fingerprints.length, 1);
  assert.equal(db.fingerprints[0].actor, 'rider');
});

// ── PIN_RESERVED vs PIN_DUPLICATE ──────────────────────────────────────────────
test('a candidate colliding with the OWNER actor specifically is PIN_RESERVED, not PIN_DUPLICATE', async () => {
  const actors = await seedActors();
  actors.find((a) => a.actor === 'owner').pin_hash = await hashPin('482915'); // a valid NEW-style 6-digit owner PIN
  const { db, dao } = makeDb(actors);
  const r = await asAdmin(dao, 'rider', '482915', K_CURRENT_ONLY); // owner's PIN
  assert.equal(r.ok, false);
  assert.equal(r.error, 'pin_reserved');
  assert.equal(db.writes.length, 0);
  assert.equal(db.fingerprints.length, 0);
});

test('a candidate colliding with any OTHER actor is PIN_DUPLICATE', async () => {
  for (const [victim, pin] of [['operator_primary', '482913'], ['operator_backup', '573914'], ['rider', '619472']]) {
    const { db, dao } = makeDb(await seedActors());
    const r = await asOwner(dao, pin, K_CURRENT_ONLY);
    assert.equal(r.ok, false, victim);
    assert.equal(r.error, 'pin_duplicate', victim);
    assert.equal(db.writes.length, 0);
  }
});

test('the target is excluded from its own duplicate/reserved check', async () => {
  const actors = await seedActors();
  actors.find((a) => a.actor === 'rider').pin_hash = await hashPin('482915');
  const { db, dao } = makeDb(actors);
  const r = await asAdmin(dao, 'rider', '482915', K_CURRENT_ONLY);
  assert.equal(r.ok, true);
  assert.deepEqual(db.writes, ['rider']);
});

test('an admin cannot give operator_primary the PIN the owner already holds (PIN_RESERVED)', async () => {
  const actors = await seedActors();
  actors.find((a) => a.actor === 'owner').pin_hash = await hashPin('482915');
  const { db, dao } = makeDb(actors);
  const r = await asAdmin(dao, 'operator_primary', '482915', K_CURRENT_ONLY);
  assert.equal(r.error, 'pin_reserved');
  assert.equal(db.writes.length, 0);
});

// ── missing/invalid dependencies fail closed ───────────────────────────────────
test('a null fingerprintKeyConfig fails closed with no DAO call', async () => {
  const { db, dao } = makeDb(await seedActors());
  const r = await asOwner(dao, '482915', null);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'rotation_failed');
  assert.equal(db.writes.length, 0);
});

test('a missing deriveForAcceptedKeys dependency fails closed', async () => {
  const { db, dao } = makeDb(await seedActors());
  const rotNoDerive = createPinRotationV3({ dao, hashPin, verifyPin, pinPolicy, ipHash, fingerprintKeyConfig: K_CURRENT_ONLY });
  const r = await rotNoDerive.rotate({
    targetActor: 'owner', newPin: '482915', trustedClientIp: '1.2.3.4',
    callerKind: 'account_owner', userId: UID, workspaceId: WID,
  });
  assert.equal(r.ok, false);
  assert.equal(db.writes.length, 0);
});

// ── session_version / secrecy invariants preserved from v2 ────────────────────
test('a valid PIN rotates only the requested actor and bumps its session_version once', async () => {
  const { db, dao } = makeDb(await seedActors());
  const before = JSON.parse(JSON.stringify(db.actors));
  const r = await asOwner(dao, '482915', K_CURRENT_ONLY);
  assert.equal(r.ok, true);
  assert.equal(r.sessionVersion, 15);
  assert.deepEqual(db.writes, ['owner']);
  for (const a of ['operator_primary', 'operator_backup', 'rider']) {
    assert.deepEqual(db.actors.find((x) => x.actor === a), before.find((x) => x.actor === a));
  }
});

test('plaintext PIN never reaches the DAO payload or the returned result', async () => {
  const PIN = '482915';
  const { dao } = makeDb(await seedActors());
  const payloads = [];
  const wrapped = { ...dao, setActorPinV3: (a) => { payloads.push(JSON.stringify(a)); return dao.setActorPinV3(a); } };
  const r = await asOwner(wrapped, PIN, K_DUAL);
  assert.equal(r.ok, true);
  assert.ok(!payloads.join('').includes(PIN));
  assert.ok(!JSON.stringify(r).includes(PIN));
});

// ── account-path scoping, preserved from v2 ────────────────────────────────────
test('the account path may target ONLY the owner actor', async () => {
  const { db, dao } = makeDb(await seedActors());
  const r = await rot(dao, K_CURRENT_ONLY).rotate({
    targetActor: 'rider', newPin: '482915', trustedClientIp: '1.2.3.4',
    callerKind: 'account_owner', userId: UID, workspaceId: WID,
  });
  assert.equal(r.ok, false);
  assert.equal(db.writes.length, 0);
});

test('a workspace mismatch on the account path fails closed', async () => {
  const { db, dao } = makeDb(await seedActors());
  const r = await rot(dao, K_CURRENT_ONLY).rotate({
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
  assert.equal((await asOwner(dao, '482915', K_CURRENT_ONLY)).ok, false);
  assert.equal(db.writes.length, 0);
});

// ── concurrency: the uniqueness invariant across different targets ────────────
test('owner and rider rotating to the SAME candidate cannot both succeed', async () => {
  const { db, dao } = makeDb(await seedActors());
  const [ra, rb] = await Promise.all([
    asOwner(dao, '482915', K_CURRENT_ONLY),
    asAdmin(dao, 'rider', '482915', K_CURRENT_ONLY),
  ]);
  const ok = [ra, rb].filter((r) => r.ok === true);
  assert.equal(ok.length, 1, 'exactly one rotation may commit');
  assert.equal(db.writes.length, 1);
  assert.equal(db.fingerprints.length, 1);
});

// ── role vocabulary is NOT hardcoded to admin/operator/rider ───────────────────
test('a non-legacy expected role (e.g. a future V3 code) is accepted by the service layer', async () => {
  const actors = await seedActors();
  const shiftMgr = { actor: 'usr_shift1', role: 'shift_manager', active: true, workspace_id: WID, session_version: 1, pin_hash: null };
  actors.push(shiftMgr);
  const { db, dao } = makeDb(actors);
  const r = await rot(dao, K_CURRENT_ONLY).rotate({
    targetActor: 'usr_shift1', newPin: '482915', trustedClientIp: '1.2.3.4',
    callerKind: 'operational_admin', byActor: 'owner',
  });
  assert.equal(r.ok, true);
  assert.equal(r.role, 'shift_manager');
});

console.log('\n=== node:test suite complete (see summary above) ===');
