'use strict';
// B5 unit tests. Run: node tests/bootstrapRecovery.test.js
// No DB, no network. Uses a FakeDao that mirrors the SQL semantics of
// auth_register_recovery_window / auth_consume_recovery_window so the Node
// service + descriptor/secret/api-key logic are proven offline. Real
// recoveryWindow, real pinPolicy; hashPin is faked for speed with one real
// scrypt integration case. NO real operational PIN appears — only synthetic.
const crypto = require('crypto');
const rw = require('../src/auth/recoveryWindow');
const pinPolicy = require('../src/auth/pinPolicy');
const scrypt = require('../src/auth/scrypt');
const { createBootstrapRecoveryService, GENERIC_FAIL } = require('../src/auth/bootstrapRecovery');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

const UUID = '11111111-2222-4333-8444-555555555555';
const UUID2 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const API_KEY = 'test-api-key-value-xyz';
const STRONG9 = '135724680';       // 9 digits, admin-valid, not weak
const STRONG12 = '135724680246';   // 12 digits, admin-valid
const secretB64 = () => crypto.randomBytes(32).toString('base64url');
const digestOf = (b64) => crypto.createHash('sha256').update(Buffer.from(b64, 'base64url')).digest('hex');
const fakeHash = async () => 'scrypt$1$32768$8$1$' + crypto.randomBytes(16).toString('base64url') + '$' + crypto.randomBytes(32).toString('base64url');

// ISO expiry N minutes from a fixed base clock.
const BASE = Date.parse('2026-07-14T20:00:00.000Z');
const isoIn = (ms) => new Date(BASE + ms).toISOString();
const fixedNow = () => BASE;

function makeEnv(purpose, { id = UUID, actor = 'owner', expiresAt = isoIn(10 * 60 * 1000), secret, apiKey = API_KEY } = {}) {
  const P = purpose.toUpperCase();
  const env = { DASHBOARD_API_KEY: apiKey };
  env[`AUTH_${P}_WINDOW_ID`] = id;
  env[`AUTH_${P}_WINDOW_ACTOR`] = actor;
  env[`AUTH_${P}_WINDOW_EXPIRES_AT`] = expiresAt;
  env[`AUTH_${P}_WINDOW_SECRET_B64URL`] = secret;
  return env;
}

// FakeDao mirrors the SQL RPC semantics exactly (register + atomic consume).
function makeFakeDao({ actors, now = fixedNow, failConsume = false } = {}) {
  const windows = new Map();
  return {
    windows, actors,
    async registerRecoveryWindow({ windowId, purpose, actor, secretDigest, expiresAt }) {
      const expMs = Date.parse(expiresAt);
      if (!(expMs > now())) throw new Error('AUTH_WINDOW_EXPIRED');
      if (expMs - now() > 15 * 60 * 1000) throw new Error('AUTH_WINDOW_LIFETIME_EXCEEDED');
      const ex = windows.get(windowId);
      if (!ex) {
        windows.set(windowId, { windowId, purpose, actor, secretDigest, expMs, consumed: false });
        return { registered: true, existed: false, consumed: false };
      }
      if (ex.purpose !== purpose || ex.actor !== actor || ex.secretDigest !== secretDigest || ex.expMs !== expMs) {
        throw new Error('AUTH_WINDOW_DESCRIPTOR_MISMATCH');
      }
      return { registered: true, existed: true, consumed: ex.consumed };
    },
    async consumeRecoveryWindow({ windowId, purpose, actor, secretDigest, newHash }) {
      if (failConsume) throw new Error('AUTH_DB_ERROR');
      const w = windows.get(windowId);
      if (!w) throw new Error('AUTH_WINDOW_INVALID');
      if (w.purpose !== purpose || w.actor !== actor || w.secretDigest !== secretDigest) throw new Error('AUTH_WINDOW_INVALID');
      if (w.consumed) throw new Error('AUTH_WINDOW_CONSUMED');
      if (w.expMs <= now()) throw new Error('AUTH_WINDOW_EXPIRED');
      const a = actors[actor];
      if (!a) throw new Error('AUTH_ACTOR_NOT_FOUND');
      if (a.role !== 'admin') throw new Error('AUTH_ACTOR_NOT_ADMIN');
      if (purpose === 'bootstrap' && a.pin_hash != null) throw new Error('AUTH_PIN_STATE_CONFLICT');
      if (purpose === 'recovery' && a.pin_hash == null) throw new Error('AUTH_PIN_STATE_CONFLICT');
      a.pin_hash = newHash; a.failed_count = 0; a.locked_until = null; a.active = true;
      a.session_version = (a.session_version || 1) + 1;
      w.consumed = true;
      return { actor, purpose, session_version: a.session_version, consumed: true };
    },
  };
}

function svc({ env, dao, now = fixedNow, hashPin = fakeHash }) {
  return createBootstrapRecoveryService({ env, now, dao, hashPin, ipHash: () => 'iphash', pinPolicy });
}
const hdr = (purpose, secret, apiKey = API_KEY) => {
  const h = { 'x-api-key': apiKey };
  h[purpose === 'bootstrap' ? 'x-auth-bootstrap-secret' : 'x-auth-recovery-secret'] = secret;
  return h;
};

// ── Descriptor parsing ───────────────────────────────────────────────────────
function sectionDescriptors() {
  const s = secretB64();
  assert('desc: valid bootstrap ok', rw.loadWindowDescriptor({ purpose: 'bootstrap', env: makeEnv('bootstrap', { secret: s }), now: fixedNow }).ok);
  assert('desc: valid recovery ok', rw.loadWindowDescriptor({ purpose: 'recovery', env: makeEnv('recovery', { secret: s }), now: fixedNow }).ok);
  const e = makeEnv('bootstrap', { secret: s }); delete e.AUTH_BOOTSTRAP_WINDOW_ACTOR;
  assert('desc: missing var fails', rw.loadWindowDescriptor({ purpose: 'bootstrap', env: e, now: fixedNow }).ok === false);
  const e2 = makeEnv('bootstrap', { secret: s }); delete e2.AUTH_BOOTSTRAP_WINDOW_SECRET_B64URL; delete e2.AUTH_BOOTSTRAP_WINDOW_EXPIRES_AT;
  assert('desc: partial descriptor fails', rw.loadWindowDescriptor({ purpose: 'bootstrap', env: e2, now: fixedNow }).ok === false);
  assert('desc: malformed UUID fails', rw.loadWindowDescriptor({ purpose: 'bootstrap', env: makeEnv('bootstrap', { id: 'not-a-uuid', secret: s }), now: fixedNow }).ok === false);
  assert('desc: malformed expiry (no tz) fails', rw.loadWindowDescriptor({ purpose: 'bootstrap', env: makeEnv('bootstrap', { expiresAt: '2026-07-14 20:10:00', secret: s }), now: fixedNow }).ok === false);
  assert('desc: expired expiry fails', rw.loadWindowDescriptor({ purpose: 'bootstrap', env: makeEnv('bootstrap', { expiresAt: isoIn(-1000), secret: s }), now: fixedNow }).ok === false);
  assert('desc: exactly 15 min accepted', rw.loadWindowDescriptor({ purpose: 'bootstrap', env: makeEnv('bootstrap', { expiresAt: isoIn(15 * 60 * 1000), secret: s }), now: fixedNow }).ok);
  assert('desc: over 15 min rejected', rw.loadWindowDescriptor({ purpose: 'bootstrap', env: makeEnv('bootstrap', { expiresAt: isoIn(15 * 60 * 1000 + 1000), secret: s }), now: fixedNow }).ok === false);
  assert('desc: malformed base64url secret fails', rw.loadWindowDescriptor({ purpose: 'bootstrap', env: makeEnv('bootstrap', { secret: 'not+valid/b64==' }), now: fixedNow }).ok === false);
  assert('desc: short secret (<32B) fails', rw.loadWindowDescriptor({ purpose: 'bootstrap', env: makeEnv('bootstrap', { secret: crypto.randomBytes(16).toString('base64url') }), now: fixedNow }).ok === false);
  assert('desc: invalid actor rejected', rw.loadWindowDescriptor({ purpose: 'bootstrap', env: makeEnv('bootstrap', { actor: 'intruder', secret: s }), now: fixedNow }).ok === false);
  // bootstrap/recovery separation: recovery env does not satisfy bootstrap load
  assert('desc: bootstrap/recovery env separation', rw.loadWindowDescriptor({ purpose: 'bootstrap', env: makeEnv('recovery', { secret: s }), now: fixedNow }).ok === false);
}

// ── Header / authentication ──────────────────────────────────────────────────
async function sectionAuth() {
  const s = secretB64();
  const env = makeEnv('bootstrap', { secret: s });
  const okActors = () => ({ owner: { role: 'admin', pin_hash: null, session_version: 3 } });

  let r = await svc({ env, dao: makeFakeDao({ actors: okActors() }) }).execute({ purpose: 'bootstrap', headers: hdr('bootstrap', s), newPin: STRONG9 });
  assert('auth: correct api key + secret → success', r.ok === true && r.actor === 'owner' && r.purpose === 'bootstrap');

  r = await svc({ env, dao: makeFakeDao({ actors: okActors() }) }).execute({ purpose: 'bootstrap', headers: { 'x-auth-bootstrap-secret': s }, newPin: STRONG9 });
  assert('auth: missing api key → fail', r.ok === false);
  r = await svc({ env, dao: makeFakeDao({ actors: okActors() }) }).execute({ purpose: 'bootstrap', headers: hdr('bootstrap', s, 'WRONG'), newPin: STRONG9 });
  assert('auth: wrong api key → fail', r.ok === false);
  r = await svc({ env, dao: makeFakeDao({ actors: okActors() }) }).execute({ purpose: 'bootstrap', headers: { 'x-api-key': API_KEY }, newPin: STRONG9 });
  assert('auth: missing dedicated secret → fail', r.ok === false);
  r = await svc({ env, dao: makeFakeDao({ actors: okActors() }) }).execute({ purpose: 'bootstrap', headers: hdr('bootstrap', secretB64()), newPin: STRONG9 });
  assert('auth: wrong dedicated secret → fail', r.ok === false);
  // Bearer cannot substitute for X-Api-Key
  r = await svc({ env, dao: makeFakeDao({ actors: okActors() }) }).execute({ purpose: 'bootstrap', headers: { authorization: 'Bearer xyz', 'x-auth-bootstrap-secret': s }, newPin: STRONG9 });
  assert('auth: Bearer cannot substitute api key → fail', r.ok === false);
  // secret in body/query ignored (only headers honored)
  r = await svc({ env, dao: makeFakeDao({ actors: okActors() }) }).execute({ purpose: 'bootstrap', headers: { 'x-api-key': API_KEY }, bootstrapSecret: s, query: { secret: s }, newPin: STRONG9 });
  assert('auth: body/query secret ignored → fail', r.ok === false);
  // duplicated ambiguous header (array) rejected
  r = await svc({ env, dao: makeFakeDao({ actors: okActors() }) }).execute({ purpose: 'bootstrap', headers: { 'x-api-key': API_KEY, 'x-auth-bootstrap-secret': [s, s] }, newPin: STRONG9 });
  assert('auth: duplicated secret header → fail', r.ok === false);
  // missing server configuration (no DASHBOARD_API_KEY) fails closed
  const envNoKey = makeEnv('bootstrap', { secret: s }); delete envNoKey.DASHBOARD_API_KEY;
  r = await svc({ env: envNoKey, dao: makeFakeDao({ actors: okActors() }) }).execute({ purpose: 'bootstrap', headers: hdr('bootstrap', s), newPin: STRONG9 });
  assert('auth: missing server api-key config → fail closed', r.ok === false);

  // bootstrap secret cannot open recovery, and vice-versa
  const sBoot = secretB64(); const sRec = secretB64();
  const envBoth = { ...makeEnv('bootstrap', { secret: sBoot }), ...makeEnv('recovery', { id: UUID2, secret: sRec }) };
  const recActors = () => ({ owner: { role: 'admin', pin_hash: 'scrypt$1$x', session_version: 3 } });
  r = await svc({ env: envBoth, dao: makeFakeDao({ actors: recActors() }) }).execute({ purpose: 'recovery', headers: { 'x-api-key': API_KEY, 'x-auth-recovery-secret': sBoot }, newPin: STRONG9 });
  assert('auth: bootstrap secret cannot open recovery → fail', r.ok === false);
  r = await svc({ env: envBoth, dao: makeFakeDao({ actors: okActors() }) }).execute({ purpose: 'bootstrap', headers: { 'x-api-key': API_KEY, 'x-auth-bootstrap-secret': sRec }, newPin: STRONG9 });
  assert('auth: recovery secret cannot open bootstrap → fail', r.ok === false);
  // wrong header NAME (recovery purpose, bootstrap header) → fail
  r = await svc({ env: envBoth, dao: makeFakeDao({ actors: recActors() }) }).execute({ purpose: 'recovery', headers: { 'x-api-key': API_KEY, 'x-auth-bootstrap-secret': sRec }, newPin: STRONG9 });
  assert('auth: recovery needs recovery header name → fail', r.ok === false);
}

// ── PIN handling ─────────────────────────────────────────────────────────────
async function sectionPin() {
  const s = secretB64();
  const env = makeEnv('bootstrap', { secret: s });
  const A = () => ({ owner: { role: 'admin', pin_hash: null, session_version: 1 } });
  const run = (pin, hashPin) => svc({ env, dao: makeFakeDao({ actors: A() }), hashPin }).execute({ purpose: 'bootstrap', headers: hdr('bootstrap', s), newPin: pin });

  assert('pin: 9-digit admin ok', (await run(STRONG9)).ok === true);
  assert('pin: 12-digit admin ok', (await run(STRONG12)).ok === true);
  assert('pin: 8-digit rejected', (await run('13572468')).ok === false);
  assert('pin: 13-digit rejected', (await run('1357246802468')).ok === false);
  assert('pin: sequential rejected', (await run('123456789')).ok === false);
  assert('pin: all-same rejected', (await run('111111111')).ok === false);
  assert('pin: non-string rejected', (await run(135724680)).ok === false);

  // Real scrypt integration + plaintext never surfaces
  const dao = makeFakeDao({ actors: A() });
  const r = await svc({ env, dao, hashPin: scrypt.hashPin }).execute({ purpose: 'bootstrap', headers: hdr('bootstrap', s), newPin: STRONG9 });
  assert('pin: real scrypt integration → success', r.ok === true);
  const stored = dao.actors.owner.pin_hash;
  assert('pin: stored hash is scrypt format, not plaintext', typeof stored === 'string' && stored.startsWith('scrypt$') && !stored.includes(STRONG9));
  const blob = JSON.stringify(r);
  assert('pin: result contains no plaintext PIN', !blob.includes(STRONG9));
  assert('pin: result has no secret/hash/pin keys', !/secret|hash|pin/i.test(Object.keys(r).join(',')));
}

// ── Flow behavior + replay/restart ───────────────────────────────────────────
async function sectionFlow() {
  const s = secretB64();
  const envB = makeEnv('bootstrap', { secret: s });
  const envR = makeEnv('recovery', { secret: s });

  // bootstrap rejects actor with existing PIN
  let r = await svc({ env: envB, dao: makeFakeDao({ actors: { owner: { role: 'admin', pin_hash: 'scrypt$1$x', session_version: 2 } } }) }).execute({ purpose: 'bootstrap', headers: hdr('bootstrap', s), newPin: STRONG9 });
  assert('flow: bootstrap rejects actor with existing PIN', r.ok === false);
  // recovery rejects actor without PIN
  r = await svc({ env: envR, dao: makeFakeDao({ actors: { owner: { role: 'admin', pin_hash: null, session_version: 2 } } }) }).execute({ purpose: 'recovery', headers: hdr('recovery', s), newPin: STRONG9 });
  assert('flow: recovery rejects actor without PIN', r.ok === false);
  // non-admin target denied
  const envRider = makeEnv('bootstrap', { actor: 'rider', secret: s });
  r = await svc({ env: envRider, dao: makeFakeDao({ actors: { rider: { role: 'rider', pin_hash: null, session_version: 1 } } }) }).execute({ purpose: 'bootstrap', headers: hdr('bootstrap', s), newPin: STRONG9 });
  assert('flow: non-admin target denied', r.ok === false);
  // session_version increments + lock/failed reset + active true on success
  const daoOk = makeFakeDao({ actors: { owner: { role: 'admin', pin_hash: null, session_version: 5, active: false, failed_count: 4, locked_until: 'x' } } });
  r = await svc({ env: envB, dao: daoOk }).execute({ purpose: 'bootstrap', headers: hdr('bootstrap', s), newPin: STRONG9 });
  assert('flow: success resets lock/failed, activates, bumps sv',
    r.ok === true && daoOk.actors.owner.session_version === 6 && daoOk.actors.owner.active === true && daoOk.actors.owner.failed_count === 0 && daoOk.actors.owner.locked_until === null);
  // replay denied: second execute on same (now consumed) window fails
  const dao2 = makeFakeDao({ actors: { owner: { role: 'admin', pin_hash: null, session_version: 1 } } });
  const s2 = svc({ env: envB, dao: dao2 });
  const first = await s2.execute({ purpose: 'bootstrap', headers: hdr('bootstrap', s), newPin: STRONG9 });
  const second = await s2.execute({ purpose: 'bootstrap', headers: hdr('bootstrap', s), newPin: STRONG12 });
  assert('flow: replay denied (one-shot)', first.ok === true && second.ok === false);
  assert('flow: replay did not mutate actor twice (sv==2)', dao2.actors.owner.session_version === 2);
  // restart with same env descriptor does not reopen a consumed window
  const dao3 = makeFakeDao({ actors: { owner: { role: 'admin', pin_hash: 'scrypt$1$x', session_version: 9 } } });
  dao3.windows.set(UUID, { windowId: UUID, purpose: 'bootstrap', actor: 'owner', secretDigest: digestOf(s), expMs: BASE + 10 * 60 * 1000, consumed: true });
  r = await svc({ env: envB, dao: dao3 }).execute({ purpose: 'bootstrap', headers: hdr('bootstrap', s), newPin: STRONG9 });
  assert('flow: restart does not reopen consumed window', r.ok === false && dao3.actors.owner.session_version === 9);
  // concurrent consumption: at most one success
  const dao4 = makeFakeDao({ actors: { owner: { role: 'admin', pin_hash: null, session_version: 1 } } });
  const s4 = svc({ env: envB, dao: dao4 });
  const both = await Promise.all([
    s4.execute({ purpose: 'bootstrap', headers: hdr('bootstrap', s), newPin: STRONG9 }),
    s4.execute({ purpose: 'bootstrap', headers: hdr('bootstrap', s), newPin: STRONG12 }),
  ]);
  assert('flow: concurrent → at most one success', both.filter((x) => x.ok).length === 1);
  // DAO consume failure → generic
  r = await svc({ env: envB, dao: makeFakeDao({ actors: { owner: { role: 'admin', pin_hash: null, session_version: 1 } }, failConsume: true }) }).execute({ purpose: 'bootstrap', headers: hdr('bootstrap', s), newPin: STRONG9 });
  assert('flow: DAO failure → generic fail', r.ok === false && r.error === 'auth_failed');
  // request cannot override env-selected actor
  const dao5 = makeFakeDao({ actors: { owner: { role: 'admin', pin_hash: null, session_version: 1 }, operator_primary: { role: 'operator', pin_hash: null, session_version: 1 } } });
  r = await svc({ env: envB, dao: dao5 }).execute({ purpose: 'bootstrap', headers: hdr('bootstrap', s), newPin: STRONG9, actor: 'operator_primary' });
  assert('flow: request actor override ignored (env actor used)', r.ok === true && r.actor === 'owner' && dao5.actors.operator_primary.pin_hash === null);
  // no JWT anywhere in the success path
  assert('flow: GENERIC_FAIL shape stable', GENERIC_FAIL.ok === false && GENERIC_FAIL.error === 'auth_failed');
}

(async function main() {
  sectionDescriptors();
  await sectionAuth();
  await sectionPin();
  await sectionFlow();
  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})();
