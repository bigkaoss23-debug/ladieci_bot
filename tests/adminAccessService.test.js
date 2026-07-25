'use strict';
// B6B service unit tests. Run: node tests/adminAccessService.test.js
// Fully offline: DAO, hashPin, ipHash and logger are INJECTED. No DB, no fetch.
// Covers set-PIN, revoke, active, unlock: authoritative-role-from-DAO policy,
// exact owner self-confirmations, self-disable, strict boolean, hash-once/
// after-validation, plaintext never reaching DAO, IP fail-closed, metadata safety,
// generic failure shape, changed passthrough, and no sensitive logging.
const { createAdminAccessService, ADMIN_FAIL } = require('../src/auth/adminAccessService');
const pinPolicy = require('../src/auth/pinPolicy'); // REUSE the canonical B3 policy

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };
const deepFind = (o, needle) => o == null ? false : typeof o === 'string' ? o.includes(needle)
  : typeof o === 'object' ? Object.values(o).some((v) => deepFind(v, needle)) : false;

// ── injectable fakes ─────────────────────────────────────────────────────────
function okResult(over = {}) {
  return Object.assign({ actor: 'operator_primary', role: 'operator', active: true, session_version: 7,
    failed_count: 0, locked_until: null, updated_at: 't', updated_by: 'owner', changed: true, event: 'pin_change' }, over);
}
function makeDao(roleByActor, over = {}) {
  const calls = { setPin: [], revoke: [], active: [], unlock: [], getActor: [] };
  const rec = (k, ret) => async (args) => { calls[k].push(args); if (typeof ret === 'function') return ret(args); return ret; };
  const dao = {
    getActorSafe: async (a) => { calls.getActor.push(a); const role = roleByActor[a]; return role ? { actor: a, role, active: true } : null; },
    adminSetActorPin: rec('setPin', over.setPin || okResult()),
    adminRevokeActorSessions: rec('revoke', over.revoke || okResult({ event: 'revoke' })),
    adminSetActorActive: rec('active', over.active || okResult({ event: 'actor_enabled' })),
    adminUnlockActor: rec('unlock', over.unlock || okResult({ event: 'actor_unlocked' })),
  };
  return { dao, calls };
}
function makeLogger() { const rec = []; const f = (...a) => rec.push(a); return { rec, info: f, warn: f, error: f, debug: f, log: f }; }
let hashCalls; const hashPin = async (pin) => { hashCalls.push(pin); return 'scrypt$1$32768$8$1$c2FsdA$ZGln'; };
const ipOK = (ip) => (ip ? 'a'.repeat(32) : null);           // hash for any truthy ip, else null (disabled)
const svc = (deps) => createAdminAccessService({
  listActorsForVerify: async () => [],
  verifyPin: async () => false,
  ...deps,
});

(async () => {
  // ══ SET PIN — delegation to THE canonical rotation (S2-7D2) ═══════════════
  // The six-digit policy, the workspace-scoped uniqueness check, the snapshot and the
  // atomic RPC now live in src/auth/pinRotationService.js and are covered end to end by
  // tests/canonicalPinRotation.test.js. What must hold HERE is the delegation contract and
  // the B6 surface rules this service still owns: canonical actors, metadata safety, the
  // exact owner self-confirmation phrase, and one opaque failure shape.
  {
    const mkRot = (result) => { const calls = []; return { calls, rotation: { async rotate(a) { calls.push(a); return result; } } }; };
    const okRot = () => ({ ok: true, actor: 'operator_primary', role: 'operator', active: true,
      sessionVersion: 7, failedCount: 0, lockedUntil: null, updatedAt: 't', updatedBy: 'owner',
      changed: true, event: 'pin_change' });

    {
      const { dao } = makeDao({ operator_primary: 'operator' });
      const { calls, rotation } = mkRot(okRot());
      const s = svc({ dao, hashPin, pinPolicy, ipHash: ipOK, rotation });
      const r = await s.setActorPin({ byActor: 'owner', targetActor: 'operator_primary', newPin: '835274', trustedClientIp: '1.2.3.4' });
      assert('set_pin: delegates to the canonical rotation with the operational caller kind',
        r.ok === true && calls.length === 1 && calls[0].callerKind === 'operational_admin');
      assert('set_pin: target and initiator forwarded verbatim',
        calls[0].targetActor === 'operator_primary' && calls[0].byActor === 'owner');
      assert('set_pin: raw IP is forwarded for server-side hashing, never the PIN hash',
        calls[0].trustedClientIp === '1.2.3.4' && !('pinHash' in calls[0]));
      assert('set_pin: sanitized success shape preserved', r.session_version === 7 && r.event === 'pin_change' && !('pin_hash' in r));
    }

    {
      const { dao } = makeDao({ rider: 'rider' });
      const { calls, rotation } = mkRot({ ok: false, error: 'pin_duplicate' });
      const s = svc({ dao, hashPin, pinPolicy, ipHash: ipOK, rotation });
      const r = await s.setActorPin({ byActor: 'owner', targetActor: 'rider', newPin: '835274', trustedClientIp: '1.2.3.4' });
      assert('set_pin: a duplicate stays opaque on this surface (single generic failure)', r === ADMIN_FAIL);
      assert('set_pin: the duplicate attempt still reached the canonical rotation', calls.length === 1);
    }

    {
      const { dao } = makeDao({ rider: 'rider' });
      const { rotation } = mkRot({ ok: false, error: 'rotation_failed' });
      const s = svc({ dao, hashPin, pinPolicy, ipHash: ipOK, rotation });
      const r = await s.setActorPin({ byActor: 'owner', targetActor: 'rider', newPin: '835274', trustedClientIp: '1.2.3.4' });
      assert('set_pin: any rotation failure collapses to the generic shape', r === ADMIN_FAIL);
    }

    {
      const { dao } = makeDao({ owner: 'admin' });
      const { calls, rotation } = mkRot(okRot());
      const s = svc({ dao, hashPin, pinPolicy, ipHash: ipOK, rotation });
      let r = await s.setActorPin({ byActor: 'owner', targetActor: 'owner', newPin: '835274', trustedClientIp: '1.2.3.4' });
      assert('set_pin: owner self missing phrase rejected', r === ADMIN_FAIL && calls.length === 0);
      r = await s.setActorPin({ byActor: 'owner', targetActor: 'owner', newPin: '835274', confirmation: 'change_owner_pin', trustedClientIp: '1.2.3.4' });
      assert('set_pin: owner self lowercase phrase rejected', r === ADMIN_FAIL && calls.length === 0);
      r = await s.setActorPin({ byActor: 'owner', targetActor: 'owner', newPin: '835274', confirmation: ' CHANGE_OWNER_PIN ', trustedClientIp: '1.2.3.4' });
      assert('set_pin: owner self whitespace phrase rejected', r === ADMIN_FAIL && calls.length === 0);
      r = await s.setActorPin({ byActor: 'owner', targetActor: 'owner', newPin: '835274', confirmation: 'CHANGE_OWNER_PIN', trustedClientIp: '1.2.3.4' });
      assert('set_pin: owner self exact phrase accepted and forwarded to the rotation',
        r.ok === true && calls.length === 1 && calls[0].confirm === 'CHANGE_OWNER_PIN');
    }

    {
      const { dao } = makeDao({ operator_primary: 'operator' });
      const { calls, rotation } = mkRot(okRot());
      const s = svc({ dao, hashPin, pinPolicy, ipHash: ipOK, rotation });
      let r = await s.setActorPin({ byActor: 'ghost', targetActor: 'operator_primary', newPin: '835274', trustedClientIp: '1.2.3.4' });
      assert('set_pin: non-canonical initiator rejected before delegating', r === ADMIN_FAIL && calls.length === 0);
      r = await s.setActorPin({ byActor: 'owner', targetActor: 'ghost', newPin: '835274', trustedClientIp: '1.2.3.4' });
      assert('set_pin: non-canonical target rejected before delegating', r === ADMIN_FAIL && calls.length === 0);
      r = await s.setActorPin({ byActor: 'owner', targetActor: 'operator_primary', newPin: '835274', metadata: { pin: 'x' }, trustedClientIp: '1.2.3.4' });
      assert('set_pin: sensitive metadata rejected before delegating', r === ADMIN_FAIL && calls.length === 0);
      r = await s.setActorPin({ byActor: 'owner', targetActor: 'operator_primary', newPin: '835274', metadata: { note: 'ok' }, trustedClientIp: '1.2.3.4' });
      assert('set_pin: clean metadata accepted', r.ok === true);
    }

    {
      const { dao } = makeDao({ operator_primary: 'operator' });
      const logger = makeLogger();
      const { rotation } = mkRot(okRot());
      const s = svc({ dao, hashPin, pinPolicy, ipHash: ipOK, rotation, logger });
      await s.setActorPin({ byActor: 'owner', targetActor: 'operator_primary', newPin: '835274', trustedClientIp: '1.2.3.4' });
      assert('set_pin: nothing sensitive is logged', !deepFind(logger.rec, '835274') && !deepFind(logger.rec, '1.2.3.4'));
    }
  }


  // ══ REVOKE ═══════════════════════════════════════════════════════════════════
  {
    const { dao, calls } = makeDao({ owner: 'admin', operator_primary: 'operator' });
    const s = svc({ dao, hashPin, pinPolicy, ipHash: ipOK });
    let r = await s.revokeActorSessions({ byActor: 'owner', targetActor: 'owner', confirmation: 'revoke_owner_sessions', trustedClientIp: '1.2.3.4' });
    assert('revoke: owner self wrong-case phrase rejected', r === ADMIN_FAIL && calls.revoke.length === 0);
    r = await s.revokeActorSessions({ byActor: 'owner', targetActor: 'owner', confirmation: 'REVOKE_OWNER_SESSIONS', trustedClientIp: '1.2.3.4' });
    assert('revoke: owner self exact phrase accepted', r.ok === true && calls.revoke[calls.revoke.length - 1].confirm === 'REVOKE_OWNER_SESSIONS');
    r = await s.revokeActorSessions({ byActor: 'owner', targetActor: 'operator_primary', trustedClientIp: '1.2.3.4' });
    assert('revoke: other target needs no phrase (one DAO call, confirm=null)', r.ok === true && calls.revoke[calls.revoke.length - 1].confirm === null);
    assert('revoke: exactly one DAO call per request (no retry)', calls.revoke.length === 2);
    r = await s.revokeActorSessions({ byActor: 'owner', targetActor: 'operator_primary', trustedClientIp: undefined });
    assert('revoke: missing IP hash blocks DAO', r === ADMIN_FAIL);
    r = await s.revokeActorSessions({ byActor: 'owner', targetActor: 'operator_primary', trustedClientIp: '1.2.3.4', metadata: { token: 'x' } });
    assert('revoke: sensitive metadata rejected', r === ADMIN_FAIL);
    assert('revoke: raw IP never reaches DAO', calls.revoke.every((c) => !deepFind(c, '1.2.3.4') && c.ipHash === 'a'.repeat(32)));
  }

  // ══ SET ACTIVE — REMOVED (S2-7D2 writer cutover) ══════════════════════════
  // auth_admin_set_actor_active is fail-closed: no runtime route exposed activation, and
  // reactivating an actor whose stored PIN already belongs to an active actor would create
  // an ACTIVE duplicate with no rotation. The service method was removed with its DAO.
  assert('setActorActive service method removed (S2-7D2)',
    typeof svc({ dao: makeDao({}).dao, hashPin, pinPolicy, ipHash: ipOK }).setActorActive === 'undefined');

  // ══ UNLOCK ═══════════════════════════════════════════════════════════════════
  {
    const { dao, calls } = makeDao({ rider: 'rider' }, { unlock: okResult({ changed: false, event: null, session_version: 7 }) });
    const s = svc({ dao, hashPin, pinPolicy, ipHash: ipOK });
    let r = await s.unlockActor({ byActor: 'owner', targetActor: 'rider', trustedClientIp: '1.2.3.4' });
    assert('unlock: changed=false preserved', r.ok === true && r.changed === false);
    assert('unlock: session_version passthrough (no local manipulation)', r.session_version === 7);
    assert('unlock: exactly one DAO call, no retry', calls.unlock.length === 1);
    r = await s.unlockActor({ byActor: 'owner', targetActor: 'rider', trustedClientIp: undefined });
    assert('unlock: missing IP hash blocks DAO', r === ADMIN_FAIL);
    r = await s.unlockActor({ byActor: 'owner', targetActor: 'rider', trustedClientIp: '1.2.3.4', metadata: { secret: 'x' } });
    assert('unlock: sensitive metadata rejected', r === ADMIN_FAIL);
  }

  // ── initiator identifier validation (non-canonical rejected pre-DAO) ─────────
  {
    const { dao, calls } = makeDao({ rider: 'rider' });
    const s = svc({ dao, hashPin, pinPolicy, ipHash: ipOK });
    for (const bad of [null, '', ' owner', 'OWNER', 'admin', 'unknown']) {
      const r = await s.unlockActor({ byActor: bad, targetActor: 'rider', trustedClientIp: '1.2.3.4' });
      assert(`identifier: non-canonical byActor rejected (${JSON.stringify(bad)})`, r === ADMIN_FAIL);
    }
    assert('identifier: no DAO calls for bad initiator', calls.unlock.length === 0 && calls.getActor.length === 0);
  }

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})();
