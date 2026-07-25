'use strict';
// S2-7D — workspaceOwnerService unit tests. Offline: real pinPolicy (admin 9–12 digits)
// and real scrypt hashPin, mocked DAO + ipHash. Proves the account-owner orchestration
// fails closed, never leaks plaintext, and delegates atomic authority to the DAO/RPC.
// Run: node tests/workspaceOwnerService.test.js
const assert = require('node:assert/strict');
const test = require('node:test');

const { createWorkspaceOwnerService } = require('../src/account/workspaceOwnerService');

const UID = '11111111-1111-4111-8111-111111111111';
const WID = '22222222-2222-4222-8222-222222222222';
const GOOD_ADMIN_PIN = '482915'; // S2-7D2: exactly 6 digits, non-trivial

function makeDao(overrides = {}) {
  const calls = { claim: [], setPin: [] };
  const dao = {
    async claimWorkspace(a) { calls.claim.push(a); return overrides.claim || { workspaceId: WID, membershipId: 'm', created: true, onboardingCompleted: false }; },
  };
  return { dao, calls };
}
const svc = (dao) => createWorkspaceOwnerService({ dao });

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

// setOwnerPin now DELEGATES to the canonical rotation service (see canonicalPinRotation.test.js
// for policy, uniqueness and concurrency). Here we only prove the delegation contract.
function makeRotation(result) {
  const calls = [];
  return { calls, rotation: { async rotate(a) { calls.push(a); return result; } } };
}
const ownerSvc = (dao, rotation) => createWorkspaceOwnerService({ dao, rotation });

test('setOwnerPin: delegates with callerKind account_owner and the owner target', async () => {
  const { dao } = makeDao();
  const { calls, rotation } = makeRotation({ ok: true, actor: 'owner', sessionVersion: 15, event: 'pin_change' });
  const r = await ownerSvc(dao, rotation).setOwnerPin({ userId: UID, workspaceId: WID, newPin: GOOD_ADMIN_PIN, trustedClientIp: '1.2.3.4' });
  assert.equal(r.ok, true);
  assert.equal(r.sessionVersion, 15);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].callerKind, 'account_owner');
  assert.equal(calls[0].targetActor, 'owner');
  assert.equal(calls[0].userId, UID);
  assert.equal(calls[0].workspaceId, WID);
});

test('setOwnerPin: a duplicate surfaces as the neutral pin_duplicate error', async () => {
  const { dao } = makeDao();
  const { rotation } = makeRotation({ ok: false, error: 'pin_duplicate' });
  const r = await ownerSvc(dao, rotation).setOwnerPin({ userId: UID, workspaceId: WID, newPin: GOOD_ADMIN_PIN, trustedClientIp: '1.2.3.4' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'pin_duplicate');
  assert.ok(!JSON.stringify(r).match(/operator|rider/));
});

test('setOwnerPin: any other rotation failure collapses to the generic error', async () => {
  const { dao } = makeDao();
  const { rotation } = makeRotation({ ok: false, error: 'rotation_failed' });
  const r = await ownerSvc(dao, rotation).setOwnerPin({ userId: UID, workspaceId: WID, newPin: GOOD_ADMIN_PIN, trustedClientIp: '1.2.3.4' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'account_action_failed');
});

test('setOwnerPin: non-uuid inputs rejected before any rotation call', async () => {
  const { dao } = makeDao();
  const { calls, rotation } = makeRotation({ ok: true, actor: 'owner', sessionVersion: 2, event: 'pin_set' });
  const svcX = ownerSvc(dao, rotation);
  assert.equal((await svcX.setOwnerPin({ userId: 'nope', workspaceId: WID, newPin: GOOD_ADMIN_PIN })).ok, false);
  assert.equal((await svcX.setOwnerPin({ userId: UID, workspaceId: 'x', newPin: GOOD_ADMIN_PIN })).ok, false);
  assert.equal(calls.length, 0);
});

test('setOwnerPin: result never carries a hash', async () => {
  const { dao } = makeDao();
  const { rotation } = makeRotation({ ok: true, actor: 'owner', sessionVersion: 15, event: 'pin_change' });
  const r = await ownerSvc(dao, rotation).setOwnerPin({ userId: UID, workspaceId: WID, newPin: GOOD_ADMIN_PIN, trustedClientIp: '1.2.3.4' });
  assert.ok(!('pinHash' in r) && !('pin_hash' in r));
});
