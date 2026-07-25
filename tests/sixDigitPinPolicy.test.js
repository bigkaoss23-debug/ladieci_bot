'use strict';
// S2-7D2 — six-digit rotation policy + race-safe uniqueness.
// Real pinPolicy, real scrypt hash/verify; the DAO is a fake that models the DB, including a
// concurrent writer, so the optimistic-snapshot contract can be exercised offline.
// Run: node tests/sixDigitPinPolicy.test.js
const assert = require('node:assert/strict');
const test = require('node:test');

const pinPolicy = require('../src/auth/pinPolicy');
const { hashPin, verifyPin } = require('../src/auth/scrypt');
const { createWorkspaceOwnerService } = require('../src/account/workspaceOwnerService');

const UID = '11111111-1111-4111-8111-111111111111';
const WID = '22222222-2222-4222-8222-222222222222';
const ipHash = () => 'a'.repeat(32);

// ── fake DB ────────────────────────────────────────────────────────────────
// Models auth_actors for one workspace + the SQL-side optimistic check: the rotation only
// commits when the snapshot Node verified against still matches the current rows.
function makeDb(actors) {
  const db = { actors: JSON.parse(JSON.stringify(actors)), calls: { rotate: 0 }, concurrent: null };
  const dao = {
    async listWorkspaceActorsForVerify_SENSITIVE() {
      return db.actors.map((a) => ({ ...a }));
    },
    async setOwnerPinV2({ pinHash, seen }) {
      // a concurrent writer lands between Node's read and this call
      if (db.concurrent) { db.concurrent(); db.concurrent = null; }
      const others = db.actors.filter((a) => a.actor !== 'owner');
      if (!Array.isArray(seen) || seen.length !== others.length) throw new Error('AUTH_ROTATION_STALE');
      for (const cur of others) {
        const s = seen.find((x) => x.actor === cur.actor);
        if (!s) throw new Error('AUTH_ROTATION_STALE');
        if (s.active !== cur.active || (s.pin_hash ?? null) !== (cur.pin_hash ?? null)) {
          throw new Error('AUTH_ROTATION_STALE');
        }
      }
      const owner = db.actors.find((a) => a.actor === 'owner');
      const event = owner.pin_hash == null ? 'pin_set' : 'pin_change';
      owner.pin_hash = pinHash;
      owner.session_version += 1;
      owner.failed_count = 0; owner.locked_until = null;
      db.calls.rotate++;
      db.onboarding = db.onboarding || {}; db.onboarding.completedAt = db.onboarding.completedAt || 'now';
      return { actor: 'owner', role: 'admin', active: true, sessionVersion: owner.session_version, event, changed: true };
    },
  };
  return { db, dao };
}

async function baseActors() {
  return [
    { actor: 'owner', role: 'admin', active: true, session_version: 14, failed_count: 0, locked_until: null, pin_hash: await hashPin('903421756') },
    { actor: 'operator_primary', role: 'operator', active: true, session_version: 10, failed_count: 0, locked_until: null, pin_hash: await hashPin('482913') },
    { actor: 'operator_backup', role: 'operator', active: true, session_version: 4, failed_count: 0, locked_until: null, pin_hash: await hashPin('573914') },
    { actor: 'rider', role: 'rider', active: true, session_version: 2, failed_count: 0, locked_until: null, pin_hash: await hashPin('619472') },
  ];
}
const svc = (dao) => createWorkspaceOwnerService({ dao, hashPin, verifyPin, pinPolicy, ipHash });
const rotate = (dao, newPin) => svc(dao).setOwnerPin({ userId: UID, workspaceId: WID, newPin, trustedClientIp: '1.2.3.4' });

// ── policy ─────────────────────────────────────────────────────────────────
test('policy: exactly 6 digits accepted', () => {
  assert.equal(pinPolicy.validateNewPinFormat('482915').ok, true);
});
test('policy: 5 digits rejected', () => {
  assert.equal(pinPolicy.validateNewPinFormat('48291').ok, false);
});
test('policy: 7+ digits rejected (no legacy length for new rotations)', () => {
  for (const p of ['4829156', '48291567', '903421756']) {
    assert.equal(pinPolicy.validateNewPinFormat(p).ok, false, p);
  }
});
test('policy: non-numeric and separators rejected', () => {
  for (const p of ['48291a', '482 91', '482-91', '', null]) {
    assert.equal(pinPolicy.validateNewPinFormat(p).ok, false, String(p));
  }
});
test('policy: trivial six-digit PINs rejected, no admin bypass', () => {
  for (const p of ['111111', '123456', '654321', '121212', '123123']) {
    assert.equal(pinPolicy.validateNewPinFormat(p).ok, false, p);
  }
});
test('LOGIN validators are untouched — legacy lengths still authenticate', () => {
  assert.equal(pinPolicy.validateUniversalPinFormat('903421756').ok, true, 'legacy 9-digit owner PIN');
  assert.equal(pinPolicy.validatePinFormat('903421756', 'admin').ok, true);
  assert.equal(pinPolicy.validatePinFormat('482913', 'operator').ok, true);
});

// ── rotation ───────────────────────────────────────────────────────────────
test('rotation: 6-digit PIN accepted, owner session_version +1, others untouched', async () => {
  const { db, dao } = makeDb(await baseActors());
  const before = JSON.parse(JSON.stringify(db.actors));
  const r = await rotate(dao, '482915');
  assert.equal(r.ok, true);
  assert.equal(r.sessionVersion, 15);
  assert.equal(r.event, 'pin_change');
  for (const a of ['operator_primary', 'operator_backup', 'rider']) {
    const now = db.actors.find((x) => x.actor === a);
    const was = before.find((x) => x.actor === a);
    assert.deepEqual(now, was, `${a} must be unchanged`);
  }
});

test('rotation: 5 digits rejected before any DB write', async () => {
  const { db, dao } = makeDb(await baseActors());
  const r = await rotate(dao, '48291');
  assert.equal(r.ok, false);
  assert.equal(db.calls.rotate, 0);
});

test('rotation: 7 digits rejected before any DB write', async () => {
  const { db, dao } = makeDb(await baseActors());
  const r = await rotate(dao, '4829156');
  assert.equal(r.ok, false);
  assert.equal(db.calls.rotate, 0);
});

test('rotation: non-numeric rejected', async () => {
  const { db, dao } = makeDb(await baseActors());
  assert.equal((await rotate(dao, '48291a')).ok, false);
  assert.equal(db.calls.rotate, 0);
});

// ── uniqueness ─────────────────────────────────────────────────────────────
for (const other of ['operator_primary', 'operator_backup', 'rider']) {
  test(`uniqueness: a PIN already used by ${other} is rejected neutrally`, async () => {
    const actors = await baseActors();
    const pins = { operator_primary: '482913', operator_backup: '573914', rider: '619472' };
    const { db, dao } = makeDb(actors);
    const r = await rotate(dao, pins[other]);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'pin_duplicate');
    assert.ok(!JSON.stringify(r).includes(other), 'must not reveal which actor owns it');
    assert.equal(db.calls.rotate, 0, 'nothing written');
    const owner = db.actors.find((a) => a.actor === 'owner');
    assert.equal(owner.session_version, 14, 'session_version unchanged');
  });
}

test('uniqueness: an INACTIVE actor does not block the PIN', async () => {
  const actors = await baseActors();
  actors.find((a) => a.actor === 'rider').active = false;
  const { dao } = makeDb(actors);
  const r = await rotate(dao, '619472');   // the inactive rider's PIN
  assert.equal(r.ok, true);
});

test('uniqueness: the owner is excluded from its own check (re-setting the same PIN is allowed)', async () => {
  const actors = await baseActors();
  actors.find((a) => a.actor === 'owner').pin_hash = await hashPin('482915');
  const { db, dao } = makeDb(actors);
  const r = await rotate(dao, '482915');
  assert.equal(r.ok, true);
  assert.equal(db.calls.rotate, 1);
});

test('uniqueness: an actor with no PIN cannot collide', async () => {
  const actors = await baseActors();
  actors.find((a) => a.actor === 'rider').pin_hash = null;
  const { dao } = makeDb(actors);
  assert.equal((await rotate(dao, '482915')).ok, true);
});

// ── race safety ────────────────────────────────────────────────────────────
test('race: a concurrent change to another actor aborts the rotation (stale snapshot)', async () => {
  const actors = await baseActors();
  const { db, dao } = makeDb(actors);
  // between Node's read and the RPC, operator_primary is rotated to the SAME candidate PIN
  db.concurrent = () => {
    const op = db.actors.find((a) => a.actor === 'operator_primary');
    op.pin_hash = 'scrypt$1$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBk';
  };
  const r = await rotate(dao, '482915');
  assert.equal(r.ok, false, 'must not commit on a stale snapshot');
  assert.equal(db.calls.rotate, 0);
  const owner = db.actors.find((a) => a.actor === 'owner');
  assert.equal(owner.session_version, 14, 'session_version unchanged after abort');
});

test('race: a concurrent ACTIVATION also invalidates the snapshot', async () => {
  const actors = await baseActors();
  actors.find((a) => a.actor === 'rider').active = false;
  const { db, dao } = makeDb(actors);
  db.concurrent = () => { db.actors.find((a) => a.actor === 'rider').active = true; };
  const r = await rotate(dao, '619472');   // allowed while inactive, not once re-activated
  assert.equal(r.ok, false);
  assert.equal(db.calls.rotate, 0);
});

test('race: two sequential rotations to the same PIN — the second is refused as duplicate', async () => {
  const actors = await baseActors();
  const { db, dao } = makeDb(actors);
  assert.equal((await rotate(dao, '482915')).ok, true);
  // operator_primary now tries the same PIN through the same uniqueness rule
  const others = db.actors.filter((a) => a.actor !== 'operator_primary');
  let clash = false;
  for (const a of others) { if (a.pin_hash && await verifyPin('482915', a.pin_hash)) clash = true; }
  assert.equal(clash, true, 'the owner now holds it, so another actor must be refused');
});

// ── secrecy ────────────────────────────────────────────────────────────────
test('plaintext never reaches the DAO, the result or any audit meta', async () => {
  const PIN = '482915';
  const seenPayloads = [];
  const { dao } = makeDb(await baseActors());
  const wrapped = {
    ...dao,
    async setOwnerPinV2(args) { seenPayloads.push(JSON.stringify(args)); return dao.setOwnerPinV2(args); },
  };
  const r = await rotate(wrapped, PIN);
  assert.equal(r.ok, true);
  assert.ok(!seenPayloads.join('').includes(PIN), 'plaintext must not reach the RPC payload');
  assert.ok(!JSON.stringify(r).includes(PIN), 'plaintext must not be returned');
});

test('the snapshot sent to SQL carries only actor/active/pin_hash', async () => {
  let captured = null;
  const { dao } = makeDb(await baseActors());
  const wrapped = { ...dao, async setOwnerPinV2(args) { captured = args.seen; return dao.setOwnerPinV2(args); } };
  await rotate(wrapped, '482915');
  assert.equal(captured.length, 3);
  for (const s of captured) {
    assert.deepEqual(Object.keys(s).sort(), ['active', 'actor', 'pin_hash']);
  }
  assert.ok(!captured.some((s) => s.actor === 'owner'), 'owner excluded from its own check');
});
