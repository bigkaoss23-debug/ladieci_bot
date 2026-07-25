'use strict';
// B6B DAO unit tests. Run: node tests/adminAccessDao.test.js
// Offline: global fetch is stubbed (NO real DB). Proves exact RPC name + exact
// B6A parameter mapping, sanitized/whitelisted returns, malformed-response and
// PostgREST-error → single generic error (no body/oracle leak), no direct table
// write, and NO automatic retry (one fetch per action).
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://stub.local';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'stub-key';

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

// ── fetch stub ───────────────────────────────────────────────────────────────
let CALLS = [];
let NEXT = { ok: true, status: 200, body: {} };
global.fetch = async (url, opts = {}) => {
  CALLS.push({ url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : undefined });
  return { ok: NEXT.ok, status: NEXT.status, text: async () => (NEXT.body === undefined ? '' : JSON.stringify(NEXT.body)) };
};
const reset = (next) => { CALLS = []; NEXT = next; };

const dao = require('../src/auth/adminAccessDao');

// S2-7D2 cutover: the legacy PIN wrapper was REMOVED from this DAO — PIN rotation now goes
// exclusively through src/auth/pinRotationDao.js → auth_set_actor_pin_v2.
assert('adminSetActorPin wrapper removed (S2-7D2)', typeof dao.adminSetActorPin === 'undefined');
const okBody = (over = {}) => Object.assign({
  actor: 'operator_primary', role: 'operator', active: true, session_version: 5,
  failed_count: 0, locked_until: null, updated_at: '2026-07-15T00:00:00Z', updated_by: 'owner',
  changed: true, event: 'pin_change',
}, over);

(async () => {
  // ── exact RPC name + param mapping ─────────────────────────────────────────
  // S2-7D2: the set_pin assertions moved out with the wrapper. PIN-rotation RPC naming,
  // param mapping and result sanitization are covered by pinRotationDao via
  // tests/canonicalPinRotation.test.js and tests/pinRotationCutover.static.test.js.

  reset({ ok: true, status: 200, body: okBody({ event: 'revoke' }) });
  await dao.adminRevokeActorSessions({ byActor: 'owner', targetActor: 'rider', expectedRole: 'rider', ipHash: 'abc', meta: {}, confirm: 'REVOKE_OWNER_SESSIONS' });
  assert('revoke: RPC path auth_admin_revoke_actor_sessions', /rpc\/auth_admin_revoke_actor_sessions$/.test(CALLS[0].url));
  assert('revoke: exact param mapping', JSON.stringify(CALLS[0].body) === JSON.stringify({
    p_by_actor: 'owner', p_target_actor: 'rider', p_expected_role: 'rider', p_ip_hash: 'abc', p_meta: {}, p_confirm: 'REVOKE_OWNER_SESSIONS' }));

  // S2-7D2: the actor-activation assertions left with the wrapper (auth_admin_set_actor_active
  // is fail-closed by the writer cutover).

  reset({ ok: true, status: 200, body: okBody({ event: 'actor_unlocked' }) });
  await dao.adminUnlockActor({ byActor: 'owner', targetActor: 'rider', expectedRole: 'rider', ipHash: 'abc', meta: {} });
  assert('unlock: RPC path auth_admin_unlock_actor', /rpc\/auth_admin_unlock_actor$/.test(CALLS[0].url));
  assert('unlock: exact param mapping', JSON.stringify(CALLS[0].body) === JSON.stringify({
    p_by_actor: 'owner', p_target_actor: 'rider', p_expected_role: 'rider', p_ip_hash: 'abc', p_meta: {} }));

  // ── never a frozen B2 RPC ──────────────────────────────────────────────────
  const B2 = ['auth_set_pin_hash', 'auth_bump_session_version', 'auth_set_active', 'auth_reset_failed_attempts'];
  assert('DAO source calls no frozen B2 RPC', (() => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src/auth/adminAccessDao.js'), 'utf8');
    return B2.every((n) => !src.includes(n));
  })());

  // ── malformed response rejected → generic ──────────────────────────────────
  reset({ ok: true, status: 200, body: { actor: 'rider' /* missing session_version/changed */ } });
  let err = null; try { await dao.adminUnlockActor({ byActor: 'owner', targetActor: 'rider', expectedRole: 'rider', ipHash: 'abc' }); } catch (e) { err = e; }
  assert('malformed RPC body rejected fail-closed', err && err.code === 'ADMIN_ACTION_FAILED');

  reset({ ok: true, status: 200, body: [1, 2, 3] });
  err = null; try { await dao.adminUnlockActor({ byActor: 'owner', targetActor: 'rider', expectedRole: 'rider', ipHash: 'abc' }); } catch (e) { err = e; }
  assert('array RPC body rejected fail-closed', err && err.code === 'ADMIN_ACTION_FAILED');

  // pin_hash in body is stripped, never returned (exercised through a surviving RPC now that
  // the set_pin wrapper is gone — the sanitizer is shared by all of them)
  reset({ ok: true, status: 200, body: okBody({ pin_hash: 'scrypt$LEAK', extra: 'x' }) });
  const sanitized = await dao.adminUnlockActor({ byActor: 'owner', targetActor: 'rider', expectedRole: 'rider', ipHash: 'abc' });
  assert('pin_hash stripped from result', !('pin_hash' in sanitized) && !('extra' in sanitized) && JSON.stringify(sanitized).indexOf('LEAK') === -1);

  // ── PostgREST error → generic, no body/oracle leak ─────────────────────────
  reset({ ok: false, status: 400, body: { code: 'P0001', message: 'AUTH_NOT_ADMIN', details: 'owner disabled secret detail', hint: 'x' } });
  err = null; try { await dao.adminRevokeActorSessions({ byActor: 'operator_primary', targetActor: 'owner', expectedRole: 'admin', ipHash: 'abc' }); } catch (e) { err = e; }
  assert('PostgREST error → generic ADMIN_ACTION_FAILED', err && err.code === 'ADMIN_ACTION_FAILED');
  assert('generic error carries no PostgREST body/marker', err && !/AUTH_NOT_ADMIN|secret detail|P0001/.test(String(err.message)));
  assert('single fetch on error path (no retry)', CALLS.length === 1);

  // ── no direct table write: source uses only rpc/ POST + a GET read ──────────
  assert('DAO never PATCH/PUT/DELETE (no direct table write)', (() => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src/auth/adminAccessDao.js'), 'utf8');
    return !/'PATCH'|'PUT'|'DELETE'/.test(src);
  })());

  // ── getActorSafe read never returns pin_hash ───────────────────────────────
  reset({ ok: true, status: 200, body: [{ actor: 'rider', role: 'rider', active: true, session_version: 1, failed_count: 0, locked_until: null, updated_at: 't', updated_by: null }] });
  const row = await dao.getActorSafe('rider');
  assert('getActorSafe: GET auth_actors with safe cols only', /auth_actors\?/.test(CALLS[0].url) && CALLS[0].method === 'GET' && /select=actor,role,active/.test(decodeURIComponent(CALLS[0].url)) && !/pin_hash/.test(CALLS[0].url));
  assert('getActorSafe: returns row without pin_hash', row && row.role === 'rider' && !('pin_hash' in row));

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})();
