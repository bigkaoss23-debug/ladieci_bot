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
  // ══ SET PIN ════════════════════════════════════════════════════════════════
  {
    const { dao, calls } = makeDao({ operator_primary: 'operator' });
    const checked = [];
    const s = svc({
      dao, hashPin, pinPolicy, ipHash: ipOK,
      listActorsForVerify: async () => [
        { actor: 'owner', active: true, pin_hash: 'OWNER_HASH' },
        { actor: 'operator_backup', active: false, pin_hash: 'INACTIVE_HASH' },
        { actor: 'rider', active: true, pin_hash: 'RIDER_HASH' },
      ],
      verifyPin: async (_pin, hash) => { checked.push(hash); return hash === 'RIDER_HASH'; },
    });
    hashCalls = [];
    const r = await s.setActorPin({ byActor: 'owner', targetActor: 'operator_primary', newPin: '835274', trustedClientIp: '1.2.3.4' });
    assert('set_pin: duplicate PIN among active actors fails closed', r === ADMIN_FAIL && calls.setPin.length === 0);
    assert('set_pin: duplicate check ignores inactive actors and runs all active comparisons',
      checked.join(',') === 'OWNER_HASH,RIDER_HASH');
    assert('set_pin: duplicate PIN is never hashed or sent to mutation RPC', hashCalls.length === 0);
  }
  {
    const { dao, calls } = makeDao({ operator_primary: 'operator', owner: 'admin', rider: 'rider' });
    const s = svc({ dao, hashPin, pinPolicy, ipHash: ipOK });

    // admin target 8 digits rejected; 9 & 12 accepted
    hashCalls = [];
    let r = await s.setActorPin({ byActor: 'owner', targetActor: 'owner', newPin: '12345678', confirmation: 'CHANGE_OWNER_PIN', trustedClientIp: '1.2.3.4' });
    assert('set_pin: admin 8 digits rejected', r === ADMIN_FAIL && calls.setPin.length === 0);
    assert('set_pin: rejected PIN not hashed (policy before hash)', hashCalls.length === 0);
    r = await s.setActorPin({ byActor: 'owner', targetActor: 'owner', newPin: '918273645', confirmation: 'CHANGE_OWNER_PIN', trustedClientIp: '1.2.3.4' });
    assert('set_pin: admin 9 digits accepted', r.ok === true && calls.setPin.length === 1);
    r = await s.setActorPin({ byActor: 'owner', targetActor: 'owner', newPin: '817263540918', confirmation: 'CHANGE_OWNER_PIN', trustedClientIp: '1.2.3.4' });
    assert('set_pin: admin 12 digits accepted', r.ok === true && calls.setPin.length === 2);
  }
  {
    const { dao, calls } = makeDao({ operator_primary: 'operator', rider: 'rider' });
    const s = svc({ dao, hashPin, pinPolicy, ipHash: ipOK });
    hashCalls = [];
    let r = await s.setActorPin({ byActor: 'owner', targetActor: 'operator_primary', newPin: '835274', trustedClientIp: '1.2.3.4' });
    assert('set_pin: operator 6 digits accepted', r.ok === true);
    r = await s.setActorPin({ byActor: 'owner', targetActor: 'rider', newPin: '82640517', trustedClientIp: '1.2.3.4' });
    assert('set_pin: rider 8 digits accepted', r.ok === true);
    // role policy from DAO not caller: DAO says operator (max 8); a 9-digit admin-length pin must FAIL for operator
    r = await s.setActorPin({ byActor: 'owner', targetActor: 'operator_primary', newPin: '918273645', trustedClientIp: '1.2.3.4' });
    assert('set_pin: policy comes from DAO role (9-digit rejected for operator)', r === ADMIN_FAIL);
    // hash exactly once on a valid input
    hashCalls = [];
    await s.setActorPin({ byActor: 'owner', targetActor: 'rider', newPin: '82640517', trustedClientIp: '1.2.3.4' });
    assert('set_pin: hashPin called exactly once on valid input', hashCalls.length === 1);
    // only scrypt hash reaches DAO; plaintext PIN never reaches DAO
    const lastArgs = calls.setPin[calls.setPin.length - 1];
    assert('set_pin: DAO received scrypt hash (expectedRole from DB)', lastArgs.pinHash.slice(0, 7) === 'scrypt$' && lastArgs.expectedRole === 'rider');
    assert('set_pin: plaintext PIN never reaches DAO', !deepFind(lastArgs, '82640517'));
    assert('set_pin: raw IP never reaches DAO', !deepFind(lastArgs, '1.2.3.4') && lastArgs.ipHash === 'a'.repeat(32));
  }
  {
    // unsupported target role denied (DAO returns a role not in the supported set)
    const { dao, calls } = makeDao({ machine: 'service' });
    const s = svc({ dao, hashPin, pinPolicy, ipHash: ipOK });
    const r = await s.setActorPin({ byActor: 'owner', targetActor: 'rider', newPin: '835274', trustedClientIp: '1.2.3.4' });
    assert('set_pin: unresolved/unsupported role denied', r === ADMIN_FAIL && calls.setPin.length === 0);
  }
  {
    // weak / sequential / repeated rejected (operator target)
    const { dao } = makeDao({ operator_primary: 'operator' });
    const s = svc({ dao, hashPin, pinPolicy, ipHash: ipOK });
    for (const weak of ['123456', '000000', '121212']) {
      const r = await s.setActorPin({ byActor: 'owner', targetActor: 'operator_primary', newPin: weak, trustedClientIp: '1.2.3.4' });
      assert(`set_pin: weak PIN rejected (${weak})`, r === ADMIN_FAIL);
    }
  }
  {
    // owner self-change confirmation exactness
    const { dao, calls } = makeDao({ owner: 'admin', operator_primary: 'operator' });
    const s = svc({ dao, hashPin, pinPolicy, ipHash: ipOK });
    hashCalls = [];
    let r = await s.setActorPin({ byActor: 'owner', targetActor: 'owner', newPin: '918273645', confirmation: 'change_owner_pin', trustedClientIp: '1.2.3.4' });
    assert('set_pin: owner self lowercase phrase rejected', r === ADMIN_FAIL && calls.setPin.length === 0 && hashCalls.length === 0);
    r = await s.setActorPin({ byActor: 'owner', targetActor: 'owner', newPin: '918273645', confirmation: ' CHANGE_OWNER_PIN ', trustedClientIp: '1.2.3.4' });
    assert('set_pin: owner self whitespace phrase rejected', r === ADMIN_FAIL && calls.setPin.length === 0);
    r = await s.setActorPin({ byActor: 'owner', targetActor: 'owner', newPin: '918273645', confirmation: undefined, trustedClientIp: '1.2.3.4' });
    assert('set_pin: owner self missing phrase rejected', r === ADMIN_FAIL);
    r = await s.setActorPin({ byActor: 'owner', targetActor: 'owner', newPin: '918273645', confirmation: 'CHANGE_OWNER_PIN', trustedClientIp: '1.2.3.4' });
    assert('set_pin: owner self exact phrase accepted, passed to DAO', r.ok === true && calls.setPin[calls.setPin.length - 1].confirm === 'CHANGE_OWNER_PIN');
    // another actor does not require the phrase (confirm null)
    r = await s.setActorPin({ byActor: 'owner', targetActor: 'operator_primary', newPin: '835274', trustedClientIp: '1.2.3.4' });
    assert('set_pin: other target needs no phrase (confirm=null)', r.ok === true && calls.setPin[calls.setPin.length - 1].confirm === null);
  }
  {
    // missing/failed IP hash prevents DAO call + no hashing
    const { dao, calls } = makeDao({ operator_primary: 'operator' });
    const s = svc({ dao, hashPin, pinPolicy, ipHash: ipOK });
    hashCalls = [];
    const r = await s.setActorPin({ byActor: 'owner', targetActor: 'operator_primary', newPin: '835274', trustedClientIp: undefined });
    assert('set_pin: missing IP hash → generic, no DAO, no hash', r === ADMIN_FAIL && calls.setPin.length === 0 && hashCalls.length === 0);
  }
  {
    // metadata safety
    const { dao, calls } = makeDao({ operator_primary: 'operator' });
    const s = svc({ dao, hashPin, pinPolicy, ipHash: ipOK });
    for (const bad of [{ pin: '1' }, { pin_hash: 'x' }, { raw_ip: '1.2.3.4' }, { confirmation: 'X' }, { a: { token: 'x' } }, ['array']]) {
      const r = await s.setActorPin({ byActor: 'owner', targetActor: 'operator_primary', newPin: '835274', trustedClientIp: '1.2.3.4', metadata: bad });
      assert('set_pin: sensitive/invalid metadata rejected', r === ADMIN_FAIL);
    }
    assert('set_pin: no DAO call on bad metadata', calls.setPin.length === 0);
    // safe metadata cloned (caller not mutated) and passed
    const meta = { note: 'ok' };
    const r = await s.setActorPin({ byActor: 'owner', targetActor: 'operator_primary', newPin: '835274', trustedClientIp: '1.2.3.4', metadata: meta });
    assert('set_pin: safe metadata passed as a clone', r.ok === true && calls.setPin[0].meta.note === 'ok' && calls.setPin[0].meta !== meta);
  }
  {
    // generic DAO failure + sanitized success (no PIN/hash/confirmation/raw IP) + no logging
    const logger = makeLogger();
    const { dao } = makeDao({ operator_primary: 'operator' }, { setPin: () => { throw new Error('boom AUTH_NOT_ADMIN'); } });
    const s = svc({ dao, hashPin, pinPolicy, ipHash: ipOK, logger });
    let r = await s.setActorPin({ byActor: 'owner', targetActor: 'operator_primary', newPin: '835274', trustedClientIp: '1.2.3.4' });
    assert('set_pin: DAO throw → generic failure shape', r === ADMIN_FAIL);
    const { dao: dao2, calls } = makeDao({ operator_primary: 'operator' });
    const s2 = svc({ dao: dao2, hashPin, pinPolicy, ipHash: ipOK, logger });
    r = await s2.setActorPin({ byActor: 'owner', targetActor: 'operator_primary', newPin: '835274', trustedClientIp: '1.2.3.4' });
    assert('set_pin: success result has no PIN/hash/confirmation/raw IP',
      r.ok === true && !deepFind(r, '835274') && !deepFind(r, 'scrypt$') && !deepFind(r, '1.2.3.4') && !('pin_hash' in r));
    assert('set_pin: logger emitted nothing sensitive (nothing at all)', logger.rec.length === 0);
    void calls;
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

  // ══ SET ACTIVE ═══════════════════════════════════════════════════════════════
  {
    const { dao, calls } = makeDao({ rider: 'rider', operator_primary: 'operator', owner: 'admin' });
    const s = svc({ dao, hashPin, pinPolicy, ipHash: ipOK });
    let r = await s.setActorActive({ byActor: 'owner', targetActor: 'rider', active: true, trustedClientIp: '1.2.3.4' });
    assert('active: boolean true accepted', r.ok === true && calls.active[calls.active.length - 1].active === true);
    r = await s.setActorActive({ byActor: 'owner', targetActor: 'rider', active: false, trustedClientIp: '1.2.3.4' });
    assert('active: boolean false accepted (non-self)', r.ok === true);
    const before = calls.active.length;
    for (const bad of ['false', 0, 1, null, undefined]) {
      r = await s.setActorActive({ byActor: 'owner', targetActor: 'rider', active: bad, trustedClientIp: '1.2.3.4' });
      assert(`active: non-boolean rejected (${JSON.stringify(bad)})`, r === ADMIN_FAIL);
    }
    assert('active: no DAO call for non-boolean', calls.active.length === before);
    // self-disable rejected before DAO; enabling self allowed
    r = await s.setActorActive({ byActor: 'owner', targetActor: 'owner', active: false, trustedClientIp: '1.2.3.4' });
    assert('active: self-disable rejected before DAO', r === ADMIN_FAIL && calls.active.length === before);
    r = await s.setActorActive({ byActor: 'owner', targetActor: 'owner', active: true, trustedClientIp: '1.2.3.4' });
    assert('active: enabling self is NOT blocked by Node', r.ok === true);
  }
  {
    // changed=false preserved
    const { dao } = makeDao({ rider: 'rider' }, { active: okResult({ changed: false, event: null }) });
    const s = svc({ dao, hashPin, pinPolicy, ipHash: ipOK });
    const r = await s.setActorActive({ byActor: 'owner', targetActor: 'rider', active: true, trustedClientIp: '1.2.3.4' });
    assert('active: changed=false preserved', r.ok === true && r.changed === false && r.event === null);
  }

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
