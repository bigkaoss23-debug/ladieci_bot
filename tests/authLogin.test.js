// Test per src/auth/login.js — B3. Eseguire: node tests/authLogin.test.js
// Dipendenze fake iniettate. Valori SINTETICI. Nessun PIN reale, nessun hash reale.
const { createLoginHandler } = require('../src/auth/login');
const pinPolicy = require('../src/auth/pinPolicy');
const { createIpLimiter } = require('../src/auth/ipSecurity');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  → ' + d : '')); } };

// verifyPin fake: a "real" hash is 'HASH:<pin>'; decoy is 'DECOY'. Counts calls.
function makeVerify() {
  const state = { calls: 0 };
  const fn = async (pin, stored) => { state.calls++; return stored === 'HASH:' + pin; };
  return { fn, state };
}

function makeDeps(over = {}) {
  const rec = { record: [], reset: [], setPin: 0, locked: null, resetRet: { active: true, session_version: 7 }, recRet: { failed_count: 1, locked: false }, row: null, lockState: { locked: false } };
  Object.assign(rec, over.rec || {});
  const verify = over.verify || makeVerify();
  const auditCalls = [];
  const deps = {
    dao: {
      getLockState: async (actor) => { if (rec.lockThrow) throw new Error('NOT_FOUND'); return { ...rec.lockState, locked_until: rec.lockState.locked_until || null, retryAfterSec: rec.lockState.retryAfterSec || 0 }; },
      getActorForVerify_SENSITIVE: async (actor) => rec.row,
      recordFailedAttempt: async (actor) => { rec.record.push(actor); return rec.recRet; },
      resetFailedAttempts: async (actor) => { rec.reset.push(actor); return rec.resetRet; },
      setActorPinHash: async () => { rec.setPin++; return {}; },
    },
    jwt: {
      isReady: () => (over.jwtReady === undefined ? true : over.jwtReady),
      signToken: (a) => { deps._signArgs = a; return over.signNull ? null : 'TOKEN'; },
      expiresInFor: (r) => ({ admin: '4h', operator: '10h', rider: '12h' }[r]),
    },
    pinPolicy,
    verifyPin: verify.fn,
    decoyHashPromise: Promise.resolve('DECOY'),
    ipHash: over.ipHash || ((ip) => (ip ? 'iphash-fixed' : null)),
    ipLimiter: over.ipLimiter !== undefined ? over.ipLimiter : { check: () => ({ blocked: false, retryAfterSec: 0 }), recordFailure: () => {}, reset: () => {} },
    audit: over.audit || { writeAuthAuditBestEffort: async (r) => { auditCalls.push(r); return { ok: true }; } },
  };
  return { deps, rec, verify, auditCalls };
}

(async () => {
  // ── shape / actor mapping ────────────────────────────────────────────────
  { const { deps } = makeDeps(); const login = createLoginHandler(deps);
    assert('invalid role → 400', (await login({ role: 'x', pin: '135724' })).status === 400);
    assert('missing pin → 400', (await login({ role: 'rider', pin: '' })).status === 400);
    assert('operator without actor → 400', (await login({ role: 'operator', pin: '135724' })).status === 400);
    assert('operator invalid actor → 400', (await login({ role: 'operator', pin: '135724', actor: 'ghost' })).status === 400);
  }

  // ── success paths (admin/owner, rider, operator primary/backup) ──────────
  for (const [role, actor, pin] of [['admin', 'owner', '135724680'], ['rider', 'rider', '135724'], ['operator', 'operator_primary', '246813'], ['operator', 'operator_backup', '864213']]) {
    const { deps, rec, verify } = makeDeps({ rec: { row: { active: true, pin_hash: 'HASH:' + pin }, resetRet: { active: true, session_version: 5 } } });
    const login = createLoginHandler(deps);
    const r = await login({ role, pin, actor, trustedClientIp: '1.2.3.4' });
    assert(`success ${role}/${actor} → 200`, r.status === 200 && r.body.token === 'TOKEN' && r.body.actor === actor && r.body.tokenVersion === 2);
    assert(`success ${role} signs sub+sv`, deps._signArgs.sub === actor && deps._signArgs.sv === 5 && deps._signArgs.role === role);
    assert(`success ${role} one derivation`, verify.state.calls === 1);
    assert(`success ${role} reset called`, rec.reset.length === 1 && rec.reset[0] === actor);
  }

  // ── PIN policy failure → 401, NO DB touch ────────────────────────────────
  { const { deps, rec, verify } = makeDeps(); const login = createLoginHandler(deps);
    const r = await login({ role: 'operator', pin: '123456', actor: 'operator_primary' });
    assert('weak pin → 401', r.status === 401);
    assert('weak pin no DB / no derivation', verify.state.calls === 0 && rec.record.length === 0 && rec.reset.length === 0);
  }

  // ── JWT not ready → 503 ──────────────────────────────────────────────────
  { const { deps } = makeDeps({ jwtReady: false }); const login = createLoginHandler(deps);
    assert('jwt not ready → 503', (await login({ role: 'rider', pin: '135724', actor: 'rider' })).status === 503);
  }

  // ── wrong PIN → one increment on the selected actor only ─────────────────
  { const { deps, rec, verify } = makeDeps({ rec: { row: { active: true, pin_hash: 'HASH:135724' }, recRet: { failed_count: 1, locked: false } } });
    const login = createLoginHandler(deps);
    const r = await login({ role: 'operator', pin: '246809', actor: 'operator_primary' });
    assert('wrong pin → 401', r.status === 401);
    assert('wrong pin one increment on primary only', rec.record.length === 1 && rec.record[0] === 'operator_primary');
    assert('wrong pin one derivation', verify.state.calls === 1);
  }

  // ── lock pre-check → no scrypt, no increment, 429 ────────────────────────
  { const { deps, rec, verify } = makeDeps({ rec: { lockState: { locked: true, retryAfterSec: 200 } } });
    const login = createLoginHandler(deps);
    const r = await login({ role: 'operator', pin: '135724', actor: 'operator_primary' });
    assert('locked pre-check → 429', r.status === 429 && r.body.retryAfterSec === 200);
    assert('locked pre-check no scrypt/increment', verify.state.calls === 0 && rec.record.length === 0);
  }

  // ── lock triggered by RPC → 429 ──────────────────────────────────────────
  { const { deps } = makeDeps({ rec: { row: { active: true, pin_hash: 'HASH:135724' }, recRet: { failed_count: 5, locked: true, retry_after_sec: 60 } } });
    const login = createLoginHandler(deps);
    const r = await login({ role: 'operator', pin: '000001', actor: 'operator_primary' });
    assert('rpc lock → 429', r.status === 429 && r.body.retryAfterSec === 60);
  }

  // ── actor absent / inactive / no-pin → indistinguishable from wrong pin ──
  for (const [label, row] of [['absent', null], ['inactive', { active: false, pin_hash: 'HASH:135724' }], ['no-pin', { active: true, pin_hash: null }]]) {
    const { deps, rec, verify } = makeDeps({ rec: { row } });
    const login = createLoginHandler(deps);
    const r = await login({ role: 'operator', pin: '135724', actor: 'operator_primary' });
    assert(`${label} → 401 generic`, r.status === 401 && r.body.error === 'credenciales incorrectas');
    assert(`${label} exactly one derivation (decoy)`, verify.state.calls === 1);
  }

  // ── disabled between verify and reset → no token ─────────────────────────
  { const { deps } = makeDeps({ rec: { row: { active: true, pin_hash: 'HASH:135724' }, resetRet: { active: false, session_version: 9 } } });
    const login = createLoginHandler(deps);
    const r = await login({ role: 'operator', pin: '135724', actor: 'operator_primary' });
    assert('disabled mid-flow → 401, no token', r.status === 401 && !r.body.token);
  }

  // ── audit failure does not block login ───────────────────────────────────
  { const { deps } = makeDeps({ rec: { row: { active: true, pin_hash: 'HASH:135724' } }, audit: { writeAuthAuditBestEffort: async () => { throw new Error('audit down'); } } });
    const login = createLoginHandler(deps);
    const r = await login({ role: 'operator', pin: '135724', actor: 'operator_primary' });
    assert('audit failure → login still 200', r.status === 200 && r.body.token === 'TOKEN');
  }

  // ── setActorPinHash NEVER called (no rehash) ─────────────────────────────
  { const { deps, rec } = makeDeps({ rec: { row: { active: true, pin_hash: 'HASH:135724' } } });
    const login = createLoginHandler(deps);
    await login({ role: 'operator', pin: '135724', actor: 'operator_primary' });
    assert('no rehash (setActorPinHash not called)', rec.setPin === 0);
  }

  // ── IP limiter: 20 fails → blocked; ipHash null → no block ───────────────
  { const limiter = createIpLimiter({ maxFails: 20, windowMs: 600000, blockMs: 300000 });
    const { deps } = makeDeps({ rec: { row: { active: true, pin_hash: 'HASH:135724' } }, ipLimiter: limiter });
    const login = createLoginHandler(deps);
    let blockedAt = 0;
    for (let i = 1; i <= 22; i++) { const r = await login({ role: 'operator', pin: '246809', actor: 'operator_primary', trustedClientIp: '9.9.9.9' }); if (r.status === 429 && !blockedAt) blockedAt = i; }
    assert('IP limiter blocks after 20 fails', blockedAt === 21, `blockedAt=${blockedAt}`);
  }
  { const limiter = createIpLimiter({ maxFails: 2 });
    const { deps } = makeDeps({ rec: { row: { active: true, pin_hash: 'HASH:135724' } }, ipLimiter: limiter, ipHash: () => null });
    const login = createLoginHandler(deps);
    for (let i = 0; i < 5; i++) await login({ role: 'operator', pin: '246809', actor: 'operator_primary', trustedClientIp: null });
    const r = await login({ role: 'operator', pin: '246809', actor: 'operator_primary', trustedClientIp: null });
    assert('ipHash null → limiter never blocks', r.status === 401);
  }

  // ── generic bodies: no actor/pin/hash/failed_count leaked ────────────────
  { const { deps } = makeDeps({ rec: { row: { active: true, pin_hash: 'HASH:secret' }, recRet: { failed_count: 3, locked: false } } });
    const login = createLoginHandler(deps);
    const r = await login({ role: 'operator', pin: '246809', actor: 'operator_primary' });
    const s = JSON.stringify(r.body);
    assert('no leak in error body', !/HASH|secret|failed_count|operator_primary|pin_hash/.test(s), s);
  }

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log('  FATAL  ' + (e && e.message)); process.exit(1); });
