'use strict';
// B7A3 session-freshness middleware tests. Run: node tests/financialSessionFreshness.test.js
// Offline: injected fake verifyToken + fake getActor (NO real DB/JWT). Proves a
// cryptographically valid but STALE / revoked / inactive / role-mismatched token can
// never reach the financial handler: freshness is validated against DB-authoritative
// actor state before the trusted context is attached. Reuses the accepted classification
// (401 identity / 403 forbidden) via the central mapper.
let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

const { createAuthContextMiddleware } = require('../src/auth/financialHttpHandlers');

function fakeRes() { return { _status: null, _json: null, status(c) { this._status = c; return this; }, json(o) { this._json = o; return this; } }; }
// valid signed claims for owner/admin at session_version 5
const claims = (over = {}) => Object.assign({ role: 'admin', sub: 'owner', sv: 5 }, over);
const verify = (map) => (t) => (map[t] || null);
const row = (over = {}) => Object.assign({ actor: 'owner', role: 'admin', active: true, session_version: 5 }, over);

async function run(mw, token) {
  const req = { headers: token ? { authorization: 'Bearer ' + token } : {}, body: { actor: 'rider', role: 'rider', sv: 999 } };
  const res = fakeRes();
  let nexted = 0;
  await mw(req, res, () => { nexted++; });
  return { req, res, nexted };
}

(async () => {
  // 1) valid JWT + matching active DB actor/session → reaches handler
  let calls = 0;
  let getActor = async (sub) => { calls++; return sub === 'owner' ? row() : null; };
  let mw = createAuthContextMiddleware({ verifyToken: verify({ good: claims() }), getActor });
  let r = await run(mw, 'good');
  assert('valid + fresh → next called, context attached', r.nexted === 1 && r.req.authContext && r.req.authContext.sub === 'owner' && r.res._status === null);
  assert('trusted context uses DB-authoritative role + sv', r.req.authContext.role === 'admin' && r.req.authContext.sv === 5);
  assert('freshness DAO called exactly once', calls === 1);

  // 2) stale sv (token sv < current DB session_version) → rejected before service, 401
  getActor = async () => row({ session_version: 6 }); // session bumped
  mw = createAuthContextMiddleware({ verifyToken: verify({ stale: claims({ sv: 5 }) }), getActor });
  r = await run(mw, 'stale');
  assert('stale sv → 401, no next, no context', r.res._status === 401 && r.res._json.code === 'FINANCIAL_UNAUTHENTICATED' && r.nexted === 0 && !r.req.authContext);

  // 3) session increment invalidates a previously-valid token (same token, sv now +1)
  let ver = 5;
  getActor = async () => row({ session_version: ver });
  mw = createAuthContextMiddleware({ verifyToken: verify({ tok: claims({ sv: 5 }) }), getActor });
  r = await run(mw, 'tok');
  assert('before revoke: token valid → next', r.nexted === 1);
  ver = 6; // admin revoked sessions / changed PIN → session_version bumped
  r = await run(mw, 'tok');
  assert('after session increment: SAME token → 401, no next', r.res._status === 401 && r.nexted === 0);

  // 4) actor inactive → 403 (accepted forbidden classification), no next
  getActor = async () => row({ active: false });
  mw = createAuthContextMiddleware({ verifyToken: verify({ good: claims() }), getActor });
  r = await run(mw, 'good');
  assert('inactive actor → 403, no next', r.res._status === 403 && r.res._json.code === 'AUTH_INITIATOR_INACTIVE' && r.nexted === 0);

  // 5) actor missing → 401
  getActor = async () => null;
  mw = createAuthContextMiddleware({ verifyToken: verify({ good: claims() }), getActor });
  r = await run(mw, 'good');
  assert('actor missing → 401, no next', r.res._status === 401 && r.res._json.code === 'FINANCIAL_UNAUTHENTICATED' && r.nexted === 0);

  // 6) DB role no longer matches token role → 403
  getActor = async () => row({ role: 'operator' }); // demoted in DB
  mw = createAuthContextMiddleware({ verifyToken: verify({ good: claims({ role: 'admin' }) }), getActor });
  r = await run(mw, 'good');
  assert('DB role ≠ token role → 403, no next', r.res._status === 403 && r.res._json.code === 'AUTH_FORBIDDEN_ROLE' && r.nexted === 0);

  // 7) body-supplied sv cannot override token or DB (body sv=999 ignored)
  getActor = async () => row({ session_version: 5 });
  mw = createAuthContextMiddleware({ verifyToken: verify({ good: claims({ sv: 5 }) }), getActor });
  r = await run(mw, 'good');
  assert('body sv=999 ignored; context sv from DB (5)', r.nexted === 1 && r.req.authContext.sv === 5);

  // 8) body actor/role cannot substitute for authentication (no token → 401)
  r = await run(mw, null);
  assert('no token but hostile body → 401, no context', r.res._status === 401 && r.nexted === 0 && !r.req.authContext);

  // 9) freshness DAO called exactly once per request (no retry)
  calls = 0;
  getActor = async () => { calls++; return row(); };
  mw = createAuthContextMiddleware({ verifyToken: verify({ good: claims() }), getActor });
  await run(mw, 'good');
  assert('exactly one freshness read (no retry)', calls === 1);

  // 10) ambiguous DB/freshness-authority failure → sanitized 500 (NOT invalid credentials), no next
  getActor = async () => { throw new Error('db.internal:5432 connection reset pwd=secret'); };
  mw = createAuthContextMiddleware({ verifyToken: verify({ good: claims() }), getActor });
  r = await run(mw, 'good');
  assert('ambiguous DB failure → sanitized 500, no next', r.res._status === 500 && r.res._json.code === 'FINANCIAL_INTERNAL_ERROR' && r.nexted === 0);
  assert('ambiguous failure NOT reported as invalid credentials (not 401/UNAUTHENTICATED)', r.res._json.code !== 'FINANCIAL_UNAUTHENTICATED');
  assert('DB failure detail never leaked to client', !/db\.internal|5432|secret/.test(JSON.stringify(r.res._json)));

  // 11) no JWT/PIN/session value or DB detail exposed in any rejection envelope
  const bodies = [];
  for (const [tok, ga] of [
    ['stale', async () => row({ session_version: 9 })],
    ['good', async () => row({ active: false })],
    ['good', async () => { throw new Error('leak host'); }],
  ]) {
    const m2 = createAuthContextMiddleware({ verifyToken: verify({ stale: claims({ sv: 5 }), good: claims() }), getActor: ga });
    const rr = await run(m2, tok);
    bodies.push(rr.res._json);
  }
  assert('rejection envelopes are {ok,code} only', bodies.every((b) => JSON.stringify(Object.keys(b).sort()) === JSON.stringify(['code', 'ok'])));
  assert('no session_version / pin / token / claims leaked', !/session_version|pin|"sv"|"iat"|"exp"|Bearer|leak host/i.test(JSON.stringify(bodies)));

  // 12) no automatic retry even on failure (getActor invoked once on the reject path)
  calls = 0;
  getActor = async () => { calls++; return row({ active: false }); };
  mw = createAuthContextMiddleware({ verifyToken: verify({ good: claims() }), getActor });
  await run(mw, 'good');
  assert('reject path also reads DB exactly once (no retry)', calls === 1);

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})();
