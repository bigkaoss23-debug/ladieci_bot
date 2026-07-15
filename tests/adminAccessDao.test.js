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
const okBody = (over = {}) => Object.assign({
  actor: 'operator_primary', role: 'operator', active: true, session_version: 5,
  failed_count: 0, locked_until: null, updated_at: '2026-07-15T00:00:00Z', updated_by: 'owner',
  changed: true, event: 'pin_change',
}, over);

(async () => {
  // ── exact RPC name + param mapping ─────────────────────────────────────────
  reset({ ok: true, status: 200, body: okBody() });
  let r = await dao.adminSetActorPin({ byActor: 'owner', targetActor: 'operator_primary', expectedRole: 'operator', pinHash: 'scrypt$1$x', ipHash: 'abc', meta: { a: 1 }, confirm: null });
  assert('set_pin: calls exactly one fetch (no retry)', CALLS.length === 1);
  assert('set_pin: RPC path auth_admin_set_actor_pin (POST)', /rpc\/auth_admin_set_actor_pin$/.test(CALLS[0].url) && CALLS[0].method === 'POST');
  assert('set_pin: exact param mapping', JSON.stringify(CALLS[0].body) === JSON.stringify({
    p_by_actor: 'owner', p_target_actor: 'operator_primary', p_expected_role: 'operator',
    p_hash: 'scrypt$1$x', p_ip_hash: 'abc', p_meta: { a: 1 }, p_confirm: null }), JSON.stringify(CALLS[0].body));
  assert('set_pin: sanitized result whitelisted', r.actor === 'operator_primary' && r.changed === true && !('pin_hash' in r));

  reset({ ok: true, status: 200, body: okBody({ event: 'revoke' }) });
  await dao.adminRevokeActorSessions({ byActor: 'owner', targetActor: 'rider', expectedRole: 'rider', ipHash: 'abc', meta: {}, confirm: 'REVOKE_OWNER_SESSIONS' });
  assert('revoke: RPC path auth_admin_revoke_actor_sessions', /rpc\/auth_admin_revoke_actor_sessions$/.test(CALLS[0].url));
  assert('revoke: exact param mapping', JSON.stringify(CALLS[0].body) === JSON.stringify({
    p_by_actor: 'owner', p_target_actor: 'rider', p_expected_role: 'rider', p_ip_hash: 'abc', p_meta: {}, p_confirm: 'REVOKE_OWNER_SESSIONS' }));

  reset({ ok: true, status: 200, body: okBody({ event: 'actor_enabled' }) });
  await dao.adminSetActorActive({ byActor: 'owner', targetActor: 'rider', expectedRole: 'rider', active: true, ipHash: 'abc', meta: {} });
  assert('active: RPC path auth_admin_set_actor_active', /rpc\/auth_admin_set_actor_active$/.test(CALLS[0].url));
  assert('active: exact param mapping (p_active boolean)', JSON.stringify(CALLS[0].body) === JSON.stringify({
    p_by_actor: 'owner', p_target_actor: 'rider', p_expected_role: 'rider', p_active: true, p_ip_hash: 'abc', p_meta: {} }));

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

  // pin_hash in body is stripped, never returned
  reset({ ok: true, status: 200, body: okBody({ pin_hash: 'scrypt$LEAK', extra: 'x' }) });
  r = await dao.adminSetActorPin({ byActor: 'owner', targetActor: 'operator_primary', expectedRole: 'operator', pinHash: 'scrypt$1$x', ipHash: 'abc' });
  assert('pin_hash stripped from result', !('pin_hash' in r) && !('extra' in r) && JSON.stringify(r).indexOf('LEAK') === -1);

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
