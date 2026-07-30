'use strict';
// Access Control V3 -- Block V3-E: regression proof that introducing the lifecycle
// foundation does not weaken the ALREADY-ACCEPTED inactive-credential-reservation
// invariants V3-B (duplicate-PIN semantic check) and fingerprintKeyRetirement.js (key
// retirement readiness) established. V3-E touches neither file; this suite exercises
// the REAL modules directly to prove the invariant still holds, rather than asking a
// reader to go find the pre-existing V3-B/V3-A test files themselves. Eseguire:
// node tests/v3eLifecycleRegression.test.js

const assert = require('node:assert/strict');
const test = require('node:test');

const { createPinRotationV3 } = require('../src/auth/pinRotationServiceV3');
const { canRetireKey, actorsBlockingRetirement } = require('../src/auth/fingerprintKeyRetirement');
const pinPolicy = require('../src/auth/pinPolicy');
const { hashPin, verifyPin } = require('../src/auth/scrypt');
const { deriveForAcceptedKeys } = require('../src/auth/pinFingerprint');

const WID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ipHash = () => 'a'.repeat(32);
function key(id) { return Object.freeze({ id, secret: require('crypto').randomBytes(32) }); }
const K = Object.freeze({ current: key('k1'), previous: null });

test('an actor DEACTIVATED (still PIN-configured) still reserves its PIN in the V3-B duplicate check', async () => {
  const deactivatedPin = await hashPin('482915');
  const actors = [
    { actor: 'operator_backup', role: 'operator', active: false, workspace_id: WID, session_version: 4, pin_hash: deactivatedPin },
    { actor: 'operator_primary', role: 'operator', active: true, workspace_id: WID, session_version: 10, pin_hash: await hashPin('573914') },
    { actor: 'owner', role: 'admin', active: true, workspace_id: WID, session_version: 14, pin_hash: await hashPin('903421756') },
    { actor: 'rider', role: 'rider', active: true, workspace_id: WID, session_version: 2, pin_hash: null },
  ];
  const dao = {
    async listWorkspaceActorsForVerify_SENSITIVE(wid) { return actors.filter((a) => a.workspace_id === wid).map((a) => ({ ...a })); },
    async setActorPinV3() { throw new Error('must not be called — this test expects a duplicate/reserved rejection before any write'); },
  };
  const svc = createPinRotationV3({ dao, hashPin, verifyPin, pinPolicy, ipHash, fingerprintKeyConfig: K, deriveForAcceptedKeys });
  const r = await svc.rotate({
    targetActor: 'rider', newPin: '482915', trustedClientIp: '1.2.3.4', // the DEACTIVATED actor's own PIN
    callerKind: 'operational_admin', byActor: 'owner', workspaceId: WID,
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'pin_duplicate', 'deactivation (V3-E) must not release the reservation V3-B still enforces');
});

test('an actor with its credential CLEARED (V3-E clearAccessUserCredential\'s effect: pin_hash=NULL) no longer reserves that PIN', async () => {
  const clearedActors = [
    { actor: 'operator_backup', role: 'operator', active: false, workspace_id: WID, session_version: 4, pin_hash: null }, // credential cleared
    { actor: 'operator_primary', role: 'operator', active: true, workspace_id: WID, session_version: 10, pin_hash: await hashPin('573914') },
    { actor: 'owner', role: 'admin', active: true, workspace_id: WID, session_version: 14, pin_hash: await hashPin('903421756') },
    { actor: 'rider', role: 'rider', active: true, workspace_id: WID, session_version: 2, pin_hash: null },
  ];
  const dao = {
    async listWorkspaceActorsForVerify_SENSITIVE(wid) { return clearedActors.filter((a) => a.workspace_id === wid).map((a) => ({ ...a })); },
    async setActorPinV3(args) {
      const tgt = clearedActors.find((a) => a.actor === args.targetActor);
      tgt.pin_hash = args.pinHash; tgt.session_version += 1;
      return { actor: tgt.actor, role: tgt.role, active: tgt.active, session_version: tgt.session_version, failed_count: 0, locked_until: null, updated_at: 'now', updated_by: null, changed: true, event: 'pin_set', onboarding_completed: false };
    },
  };
  const svc = createPinRotationV3({ dao, hashPin, verifyPin, pinPolicy, ipHash, fingerprintKeyConfig: K, deriveForAcceptedKeys });
  const r = await svc.rotate({
    targetActor: 'rider', newPin: '482915', trustedClientIp: '1.2.3.4', // the CLEARED actor's former PIN -- now free
    callerKind: 'operational_admin', byActor: 'owner', workspaceId: WID,
  });
  assert.equal(r.ok, true, 'a cleared credential must release the PIN for reuse');
});

test('key retirement readiness still requires an INACTIVE configured actor to hold a fingerprint under the key (deactivation alone never lowers the bar)', () => {
  const actorsIncludingInactive = [
    { actor: 'operator_primary', active: true, pinConfigured: true, fingerprintKeyIds: ['k1'] },
    { actor: 'operator_backup', active: false, pinConfigured: true, fingerprintKeyIds: [] }, // deactivated, PIN-configured, no k1 fingerprint yet
  ];
  assert.equal(canRetireKey({ actors: actorsIncludingInactive, keyId: 'k1' }), false,
    'an inactive but still PIN-configured actor without the fingerprint must still block retirement');
  assert.deepEqual([...actorsBlockingRetirement({ actors: actorsIncludingInactive, keyId: 'k1' })], ['operator_backup']);
});

test('key retirement readiness EXCLUDES an actor once V3-E clearAccessUserCredential\'s effect (pinConfigured: false) applies', () => {
  const actorsAfterClear = [
    { actor: 'operator_primary', active: true, pinConfigured: true, fingerprintKeyIds: ['k1'] },
    { actor: 'operator_backup', active: false, pinConfigured: false, fingerprintKeyIds: [] }, // credential cleared -- leaves the population
  ];
  assert.equal(canRetireKey({ actors: actorsAfterClear, keyId: 'k1' }), true,
    'a cleared (unconfigured) actor must no longer block key retirement');
  assert.deepEqual([...actorsBlockingRetirement({ actors: actorsAfterClear, keyId: 'k1' })], []);
});

console.log('\n=== node:test suite complete (see summary above) ===');
