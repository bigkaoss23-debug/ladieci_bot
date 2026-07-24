'use strict';
// S2-7D — /api/account/me admin-PIN-setup derivation. Proves adminPinSetupRequired comes
// from the workspace onboarding MARKER (owner_pin_onboarding_completed_at), NOT the actor
// pin_hash. Run: node tests/accountServiceOnboarding.test.js
const assert = require('node:assert/strict');
const test = require('node:test');
const { createAccountService } = require('../src/account/accountService');

const UID = 'u-1';
const claims = { sub: UID, email: 'o@x.io', emailVerified: true };

function svc(membershipRows) {
  return createAccountService({
    selectProfile: async () => [{ id: UID, display_name: null }],
    selectMemberships: async () => membershipRows,
  });
}
const ownerRow = (onboardingAt, lifecycle = 'active') => ({
  workspace_id: 'ws1', role: 'workspace_owner', status: 'active',
  workspaces: { slug: 'la-dieci', display_name: 'La Dieci', lifecycle_status: lifecycle, commercial_status: 'trial',
    owner_pin_onboarding_completed_at: onboardingAt },
});

test('owner + onboarding NULL → adminPinSetupRequired true (legacy actor PIN is irrelevant)', async () => {
  const me = await svc([ownerRow(null)])(claims);
  assert.equal(me.adminPinSetupRequired, true);
  assert.equal(me.memberships[0].adminPinRequired, true);
});

test('owner + onboarding COMPLETED → adminPinSetupRequired false', async () => {
  const me = await svc([ownerRow('2026-07-24T10:00:00Z')])(claims);
  assert.equal(me.adminPinSetupRequired, false);
  assert.equal(me.memberships[0].adminPinRequired, false);
});

test('owner but workspace not active → not required (adminPinRequired null)', async () => {
  const me = await svc([ownerRow(null, 'provisioning')])(claims);
  assert.equal(me.adminPinSetupRequired, false);
  assert.equal(me.memberships[0].adminPinRequired, null);
});

test('non-owner (admin) membership → adminPinRequired null, never required', async () => {
  const row = { workspace_id: 'ws1', role: 'workspace_admin', status: 'active',
    workspaces: { slug: 'la-dieci', display_name: 'La Dieci', lifecycle_status: 'active', commercial_status: 'trial',
      owner_pin_onboarding_completed_at: null } };
  const me = await svc([row])(claims);
  assert.equal(me.adminPinSetupRequired, false);
  assert.equal(me.memberships[0].adminPinRequired, null);
});

test('no memberships → false + empty arrays', async () => {
  const me = await svc([])(claims);
  assert.equal(me.adminPinSetupRequired, false);
  assert.deepEqual(me.workspaces, []);
});

test('payload never contains pin_hash or actor internals', async () => {
  const me = await svc([ownerRow(null)])(claims);
  assert.ok(!JSON.stringify(me).includes('pin_hash'));
});
