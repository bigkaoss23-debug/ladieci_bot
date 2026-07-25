'use strict';
// S2-7D — workspaceOwnerService unit tests. Offline: real pinPolicy (admin 9–12 digits)
// and real scrypt hashPin, mocked DAO + ipHash. Proves the account-owner orchestration
// fails closed, never leaks plaintext, and delegates atomic authority to the DAO/RPC.
// Run: node tests/workspaceOwnerService.test.js
const assert = require('node:assert/strict');
const test = require('node:test');

const { createWorkspaceOwnerService } = require('../src/account/workspaceOwnerService');
const pinPolicy = require('../src/auth/pinPolicy');
const { hashPin, verifyPin } = require('../src/auth/scrypt');

const UID = '11111111-1111-4111-8111-111111111111';
const WID = '22222222-2222-4222-8222-222222222222';
const GOOD_ADMIN_PIN = '482915'; // S2-7D2: exactly 6 digits, non-trivial

function makeDao(overrides = {}) {
  const calls = { claim: [], setPin: [] };
  const dao = {
    async claimWorkspace(a) { calls.claim.push(a); return overrides.claim || { workspaceId: WID, membershipId: 'm', created: true, onboardingCompleted: false }; },
    async setOwnerPinV2(a) { calls.setPin.push(a); return overrides.setPin || { actor: 'owner', role: 'admin', active: true, sessionVersion: 2, event: 'pin_set', changed: true }; },
    async listWorkspaceActorsForVerify_SENSITIVE() { return overrides.actors || []; },
  };
  return { dao, calls };
}
const ipHash = () => 'a'.repeat(32);
const svc = (dao) => createWorkspaceOwnerService({ dao, hashPin, verifyPin, pinPolicy, ipHash });

test('claim: fresh workspace (onboarding NOT completed) → adminPinRequired true even though legacy actor already has a PIN', async () => {
  const { dao } = makeDao();
  const r = await svc(dao).claimWorkspace({ userId: UID });
  assert.equal(r.ok, true); assert.equal(r.workspaceId, WID);
  assert.equal(r.created, true); assert.equal(r.adminPinRequired, true);
});

test('claim: onboarding already completed → adminPinRequired false (repeat claim, no re-onboarding)', async () => {
  const { dao } = makeDao({ claim: { workspaceId: WID, created: false, onboardingCompleted: true } });
  const r = await svc(dao).claimWorkspace({ userId: UID });
  assert.equal(r.adminPinRequired, false);
});

test('claim: non-uuid userId rejected (no dao call)', async () => {
  const { dao, calls } = makeDao();
  const r = await svc(dao).claimWorkspace({ userId: 'not-a-uuid' });
  assert.equal(r.ok, false); assert.equal(calls.claim.length, 0);
});

test('claim: dao throw → generic fail', async () => {
  const dao = { async claimWorkspace() { throw new Error('boom'); } };
  const r = await svc(dao).claimWorkspace({ userId: UID });
  assert.equal(r.ok, false);
});

test('setOwnerPin: valid admin PIN → hashed, dao receives scrypt hash (never plaintext)', async () => {
  const { dao, calls } = makeDao();
  const r = await svc(dao).setOwnerPin({ userId: UID, workspaceId: WID, newPin: GOOD_ADMIN_PIN, trustedClientIp: '1.2.3.4' });
  assert.equal(r.ok, true); assert.equal(r.event, 'pin_set'); assert.equal(r.sessionVersion, 2);
  assert.equal(calls.setPin.length, 1);
  const passed = calls.setPin[0];
  assert.equal(passed.pinHash.slice(0, 7), 'scrypt$');
  assert.ok(!JSON.stringify(passed).includes(GOOD_ADMIN_PIN), 'plaintext PIN must not reach the DAO');
});

test('setOwnerPin: 5-digit PIN rejected before hashing', async () => {
  const { dao, calls } = makeDao();
  const r = await svc(dao).setOwnerPin({ userId: UID, workspaceId: WID, newPin: '48291', trustedClientIp: '1.2.3.4' });
  assert.equal(r.ok, false); assert.equal(calls.setPin.length, 0);
});

test('setOwnerPin: sequential/weak PIN rejected', async () => {
  const { dao } = makeDao();
  const r = await svc(dao).setOwnerPin({ userId: UID, workspaceId: WID, newPin: '123456', trustedClientIp: '1.2.3.4' });
  assert.equal(r.ok, false);
});

test('setOwnerPin: non-uuid workspace rejected', async () => {
  const { dao, calls } = makeDao();
  const r = await svc(dao).setOwnerPin({ userId: UID, workspaceId: 'x', newPin: GOOD_ADMIN_PIN, trustedClientIp: '1.2.3.4' });
  assert.equal(r.ok, false); assert.equal(calls.setPin.length, 0);
});

test('setOwnerPin: ipHash unavailable → fail closed (no dao call)', async () => {
  const { dao, calls } = makeDao();
  const s = createWorkspaceOwnerService({ dao, hashPin, verifyPin, pinPolicy, ipHash: () => null });
  const r = await s.setOwnerPin({ userId: UID, workspaceId: WID, newPin: GOOD_ADMIN_PIN, trustedClientIp: '1.2.3.4' });
  assert.equal(r.ok, false); assert.equal(calls.setPin.length, 0);
});

test('setOwnerPin: dao malformed result → fail closed', async () => {
  const dao = { async setOwnerPinV2() { return { actor: 'operator_primary', sessionVersion: 2 }; },
                async listWorkspaceActorsForVerify_SENSITIVE() { return []; } };
  const s = createWorkspaceOwnerService({ dao, hashPin, verifyPin, pinPolicy, ipHash });
  const r = await s.setOwnerPin({ userId: UID, workspaceId: WID, newPin: GOOD_ADMIN_PIN, trustedClientIp: '1.2.3.4' });
  assert.equal(r.ok, false);
});

test('setOwnerPin: result never contains a pin hash field surfaced to caller', async () => {
  const { dao } = makeDao();
  const r = await svc(dao).setOwnerPin({ userId: UID, workspaceId: WID, newPin: GOOD_ADMIN_PIN, trustedClientIp: '1.2.3.4' });
  assert.ok(!('pinHash' in r) && !('pin_hash' in r));
});
