// Test per src/auth/dao.js + src/auth/audit.js — Access Control V2 Block B2.
// Eseguire: node tests/authDao.test.js
// OFFLINE: global.fetch è stubbato → nessuna rete, nessun DB. Valori SINTETICI.
// Nessun PIN/hash reale; gli hash sintetici NON vengono stampati.

process.env.SUPABASE_URL = 'http://mock.local';
process.env.SUPABASE_KEY = 'mock-service-role';

// ── programmable fetch mock ──────────────────────────────────────────────────
let calls = [];
let responder = null; // (url, opts) => { ok?, status?, bodyObj? }
global.fetch = async (url, opts = {}) => {
  calls.push({ url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : undefined });
  const r = responder ? responder(url, opts) : { ok: true, status: 200, bodyObj: null };
  return {
    ok: r.ok !== false,
    status: r.status || 200,
    text: async () => (r.bodyObj === undefined ? '' : JSON.stringify(r.bodyObj)),
  };
};
const reset = (fn) => { calls = []; responder = fn || null; };

const dao = require('../src/auth/dao');
const audit = require('../src/auth/audit');

let pass = 0, fail = 0;
const assert = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  → ' + detail : '')); }
};
async function throwsCode(fn, code) {
  try { await fn(); return false; } catch (e) { return e && e.code === code; }
}

(async () => {
  // 1 — safe reads never expose pin_hash
  reset(() => ({ bodyObj: [{ actor: 'owner', role: 'admin', active: true, session_version: 1, failed_count: 0, locked_until: null, updated_at: 't', updated_by: null }] }));
  const a = await dao.getActor('owner');
  assert('getActor returns row without pin_hash key', a && !('pin_hash' in a) && a.actor === 'owner');
  assert('getActor query projects SAFE_COLS (no pin_hash requested)', calls[0].url.includes('select=actor%2Crole') || calls[0].url.includes('select=actor,role'), calls[0].url);

  reset(() => ({ bodyObj: [
    { actor: 'owner', role: 'admin', active: true, session_version: 1, failed_count: 0, locked_until: null, updated_at: 't', updated_by: null, pin_hash: 'scrypt$1$X' },
    { actor: 'rider', role: 'rider', active: true, session_version: 1, failed_count: 0, locked_until: null, updated_at: 't', updated_by: null, pin_hash: null },
  ] }));
  const list = await dao.listActorsSafe();
  assert('listActorsSafe drops pin_hash, exposes has_pin', list.every(r => !('pin_hash' in r) && typeof r.has_pin === 'boolean'));
  assert('listActorsSafe has_pin correct', list.find(r => r.actor === 'owner').has_pin === true && list.find(r => r.actor === 'rider').has_pin === false);

  // 2 — sensitive read clearly separated (returns pin_hash)
  reset(() => ({ bodyObj: [{ actor: 'owner', role: 'admin', active: true, session_version: 1, pin_hash: 'scrypt$1$X', failed_count: 0, locked_until: null }] }));
  const s = await dao.getActorForVerify_SENSITIVE('owner');
  assert('sensitive read includes pin_hash', s && 'pin_hash' in s);
  assert('sensitive read name is clearly marked', typeof dao.getActorForVerify_SENSITIVE === 'function');

  reset(() => ({ bodyObj: [{ actor: 'owner', role: 'admin', active: true, pin_hash: 'scrypt$1$X' }] }));
  const universalRows = await dao.listActorsForVerify_SENSITIVE();
  assert('universal sensitive read returns canonical rows', universalRows.length === 1 && universalRows[0].actor === 'owner');
  assert('universal sensitive query is fixed to four canonical actors', /actor=(?:in\.|in%2E)\((?:owner|owner%2Coperator_primary)/.test(calls[0].url) && /order=actor(?:\.|%2E)asc/.test(calls[0].url), calls[0].url);

  // 3 — meta sanitization: accept clean incl. auth_method; reject sensitive forms/limits
  assert('accepts clean meta', (() => { try { audit.sanitizeMeta({ info: 'x', n: 2, nested: { a: 1 } }); return true; } catch (_) { return false; } })());
  assert('accepts innocuous key auth_method', (() => { try { audit.sanitizeMeta({ auth_method: 'pin_flow', authMethod: 'x' }); return true; } catch (_) { return false; } })());
  const sensForms = ['pin', 'PIN', 'password', 'token', 'access_token', 'accessToken', 'access-token', 'refresh_token', 'jwt', 'secret', 'recovery_secret', 'Authorization', 'api_key', 'apiKey', 'api-key', 'apikey', 'bearer', 'cookie'];
  let sensAllRejected = true;
  for (const k of sensForms) {
    try { audit.sanitizeMeta({ [k]: 'v' }); sensAllRejected = false; } catch (e) { if (e.code !== 'VALIDATION') sensAllRejected = false; }
    try { audit.sanitizeMeta({ outer: { [k]: 'v' } }); sensAllRejected = false; } catch (e) { if (e.code !== 'VALIDATION') sensAllRejected = false; } // nested
  }
  assert('sensitive keys rejected (top-level + nested, all forms)', sensAllRejected);
  // limits
  let deep = 'x'; let node = { l1: { l2: { l3: { l4: { l5: 1 } } } } };
  assert('depth > 4 rejected', await throwsCodeSync(() => audit.sanitizeMeta(node), 'VALIDATION'));
  const many = {}; for (let i = 0; i < 40; i++) many['k' + i] = i;
  assert('keys > 32 rejected', await throwsCodeSync(() => audit.sanitizeMeta(many), 'VALIDATION'));
  assert('size > 2KB rejected', await throwsCodeSync(() => audit.sanitizeMeta({ big: 'A'.repeat(3000) }), 'VALIDATION'));
  assert('non-JSON value rejected', await throwsCodeSync(() => audit.sanitizeMeta({ fn: () => 1 }), 'VALIDATION'));
  assert('non-object meta rejected', await throwsCodeSync(() => audit.sanitizeMeta('nope'), 'VALIDATION'));

  // 4 — DB errors normalized (no SQL/hash leak); markers mapped
  reset(() => ({ ok: false, status: 400, bodyObj: { code: 'P0002', message: 'AUTH_ACTOR_NOT_FOUND', details: 'SELECT * FROM public.auth_actors WHERE ...', hint: null } }));
  const nf = await captureErr(() => dao.recordFailedAttempt('ghost'));
  assert('NOT_FOUND mapped from marker', nf && nf.code === 'NOT_FOUND');
  assert('error message has no SQL/details', nf && !/SELECT|FROM|auth_actors WHERE/.test(nf.message));
  reset(() => ({ ok: false, status: 400, bodyObj: { message: 'AUTH_META_SENSITIVE_KEY' } }));
  const ve = await captureErr(() => dao.incrementSessionVersion({ actor: 'owner', byActor: 'owner', meta: {} }));
  assert('VALIDATION mapped from AUTH_META marker', ve && ve.code === 'VALIDATION');
  reset(() => ({ ok: false, status: 500, bodyObj: { message: 'some internal pg error at line 42' } }));
  const de = await captureErr(() => dao.recordFailedAttempt('owner'));
  assert('generic DB error → DB_ERROR (no leak)', de && de.code === 'DB_ERROR' && !/line 42/.test(de.message));

  // 5 — zero console output from modules
  const cm = ['log', 'warn', 'error', 'info', 'debug', 'trace']; const orig = {}; let cc = 0;
  for (const m of cm) { orig[m] = console[m]; console[m] = () => { cc++; }; }
  reset(() => ({ bodyObj: { failed_count: 1, locked: false } }));
  await dao.recordFailedAttempt('owner');
  reset(() => ({ bodyObj: [] }));
  await audit.listAuthAudit({ limit: 5 });
  try { audit.sanitizeMeta({ pin: 1 }); } catch (_) {}
  for (const m of cm) console[m] = orig[m];
  assert('modules emit ZERO console output', cc === 0, `calls=${cc}`);

  // 6 — pagination cursor (ts,id)
  reset(() => ({ bodyObj: [] }));
  await audit.listAuthAudit({ limit: 10, before: { ts: '2026-07-13T10:00:00Z', id: 100 } });
  const purl = decodeURIComponent(calls[0].url);
  assert('pagination order ts.desc,id.desc', purl.includes('order=ts.desc,id.desc'));
  assert('pagination composite cursor (ts,id)', purl.includes('or=(ts.lt.') && purl.includes('and(ts.eq.') && purl.includes('id.lt.100'));
  assert('pagination limit applied', purl.includes('limit=10'));

  // 7 — append-only: no update/delete exported on audit; no audit-delete on dao
  const auditKeys = Object.keys(audit);
  assert('audit exposes no update/delete', !auditKeys.some(k => /update|delete/i.test(k)));
  const daoKeys = Object.keys(dao);
  assert('dao exposes no audit delete/update', !daoKeys.some(k => /audit/i.test(k) && /update|delete/i.test(k)));

  // 8 — exact RPC args
  reset(() => ({ bodyObj: { session_version: 2, event: 'pin_set' } }));
  await dao.setActorPinHash({ actor: 'owner', pinHash: 'scrypt$1$H', byActor: 'owner', meta: { x: 1 } });
  assert('setActorPinHash → rpc/auth_set_pin_hash', calls[0].url.endsWith('/rpc/auth_set_pin_hash') && calls[0].method === 'POST');
  assert('setActorPinHash exact args', JSON.stringify(calls[0].body) === JSON.stringify({ p_actor: 'owner', p_hash: 'scrypt$1$H', p_by: 'owner', p_meta: { x: 1 } }));
  reset(() => ({ bodyObj: {} }));
  await dao.recordFailedAttempt('rider');
  assert('recordFailedAttempt exact args', calls[0].url.endsWith('/rpc/auth_record_failed_attempt') && JSON.stringify(calls[0].body) === JSON.stringify({ p_actor: 'rider' }));
  reset(() => ({ bodyObj: {} }));
  await dao.resetFailedAttempts('rider');
  assert('resetFailedAttempts exact args', calls[0].url.endsWith('/rpc/auth_reset_failed_attempts') && JSON.stringify(calls[0].body) === JSON.stringify({ p_actor: 'rider' }));
  reset(() => ({ bodyObj: {} }));
  await dao.incrementSessionVersion({ actor: 'owner', byActor: 'owner', meta: {} });
  assert('incrementSessionVersion exact args', calls[0].url.endsWith('/rpc/auth_bump_session_version') && JSON.stringify(calls[0].body) === JSON.stringify({ p_actor: 'owner', p_by: 'owner', p_meta: {} }));
  reset(() => ({ bodyObj: {} }));
  await dao.setActorActive({ actor: 'operator_backup', active: false, byActor: 'owner', meta: {} });
  assert('setActorActive exact args', calls[0].url.endsWith('/rpc/auth_set_active') && JSON.stringify(calls[0].body) === JSON.stringify({ p_actor: 'operator_backup', p_active: false, p_by: 'owner', p_meta: {} }));

  // 8b — sanitize BEFORE rpc: sensitive meta throws and never calls fetch
  reset(() => ({ bodyObj: {} }));
  const preErr = await captureErr(() => dao.setActorPinHash({ actor: 'owner', pinHash: 'H', byActor: 'owner', meta: { secret: 'x' } }));
  assert('sensitive meta rejected BEFORE rpc (no fetch)', preErr && preErr.code === 'VALIDATION' && calls.length === 0);

  // 9 — audit mandatory (throws) vs best-effort (swallow + counter)
  reset(() => ({ ok: false, status: 500, bodyObj: { message: 'fail' } }));
  const wErr = await captureErr(() => audit.writeAuthAudit({ event: 'login_ok', byActor: 'owner' }));
  assert('writeAuthAudit throws on DB failure (mandatory-capable)', wErr && wErr.code === 'DB_ERROR');
  const before = audit.getAuditWriteErrorCount();
  reset(() => ({ ok: false, status: 500, bodyObj: { message: 'fail' } }));
  const be = await audit.writeAuthAuditBestEffort({ event: 'login_fail', targetActor: 'owner' });
  assert('best-effort returns {ok:false} on failure', be && be.ok === false);
  assert('best-effort increments diagnostic counter', audit.getAuditWriteErrorCount() === before + 1);
  const evErr = await captureErr(() => audit.writeAuthAudit({ event: 'not_an_event' }));
  assert('invalid event rejected (VALIDATION)', evErr && evErr.code === 'VALIDATION');
  // 9b — dedicated actor-state events are allowed
  assert('ALLOWED_EVENTS includes actor_disabled/actor_enabled',
    audit.ALLOWED_EVENTS.includes('actor_disabled') && audit.ALLOWED_EVENTS.includes('actor_enabled'));
  reset(() => ({ ok: true, status: 201, bodyObj: null }));
  const ad = await audit.writeAuthAudit({ event: 'actor_disabled', targetActor: 'rider', byActor: 'owner' });
  const ae = await audit.writeAuthAudit({ event: 'actor_enabled', targetActor: 'rider', byActor: 'owner' });
  assert('writeAuthAudit accepts actor_disabled/actor_enabled', ad.ok === true && ae.ok === true);

  // 10 — getLockState computes lock/retry
  reset(() => ({ bodyObj: [{ actor: 'owner', role: 'admin', active: true, session_version: 1, failed_count: 5, locked_until: new Date(Date.now() + 60000).toISOString(), updated_at: 't', updated_by: null }] }));
  const ls = await dao.getLockState('owner');
  assert('getLockState locked=true + retryAfterSec>0', ls.locked === true && ls.retryAfterSec > 0 && ls.retryAfterSec <= 60);
  reset(() => ({ bodyObj: [{ actor: 'owner', role: 'admin', active: true, session_version: 1, failed_count: 0, locked_until: null, updated_at: 't', updated_by: null }] }));
  const ls2 = await dao.getLockState('owner');
  assert('getLockState unlocked → locked=false, retry=0', ls2.locked === false && ls2.retryAfterSec === 0);

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log('  FATAL  ' + (e && e.message)); process.exit(1); });

// helpers
async function captureErr(fn) { try { await fn(); return null; } catch (e) { return e; } }
async function throwsCodeSync(fn, code) { try { fn(); return false; } catch (e) { return e && e.code === code; } }
