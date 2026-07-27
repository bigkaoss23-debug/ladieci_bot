'use strict';
// S2-7D6E4 — step-up PIN confirmation. Run: node tests/pinStepUp.test.js
//
// Part A exercises the REAL src/auth/jwt.js (real HMAC secret, real signing/verification) —
// this is the security-critical half: an attacker who cannot forge a valid signature must
// also be unable to forge purpose/version/session-binding, since a wrong-shaped-but-somehow-
// signed token is exactly the threat model this proof exists to close. To prove that
// independently of the signature check, this file knows the SAME test-only secret it hands
// to jwt.js and replicates jwt.js's private wire format locally (crafted() below) — it does
// NOT reach into jwt.js's private SECRET, it recomputes an identical HMAC with a secret only
// this test controls.
//
// Part B exercises createPinStepUpVerifier with injected fakes (dao/jwt/pinPolicy/verifyPin),
// same house style as tests/authLogin.test.js, proving the lockout-safe sequence.
//
// Part C is a static check on index.js: the verifyOwnPin dispatcher branch must source
// actor/role/sv EXCLUSIVELY from req.authCtx, never from req.body.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

// ── fixed test secret, known to THIS file only ────────────────────────────────
const TEST_SECRET_B64URL = crypto.randomBytes(32).toString('base64url');
process.env.AUTH_JWT_SECRET_B64URL = TEST_SECRET_B64URL;
delete require.cache[require.resolve('../src/auth/jwt')];
const jwt = require('../src/auth/jwt');
const SECRET_BUF = Buffer.from(TEST_SECRET_B64URL, 'base64url');

function b64url(buf) { return Buffer.from(buf).toString('base64url'); }
function hmacWithTestSecret(data) {
  return crypto.createHmac('sha256', SECRET_BUF).update(data).digest('base64url');
}
// Hand-craft a token in jwt.js's exact wire format, signed with the SAME secret jwt.js
// itself is using (because this test set the env var before requiring jwt.js). This is
// NOT reading jwt.js's private SECRET — it is an independent HMAC over a secret this test
// controls, used to prove the verifier rejects a correctly-signed-but-wrong-shaped payload.
function crafted(payloadObj) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify(payloadObj));
  const sig = hmacWithTestSecret(header + '.' + payload);
  return header + '.' + payload + '.' + sig;
}

(async () => {
  // ══ A. Real jwt.js — signStepUpProof / verifyStepUpProof / hashBearerToken ═══════

  assert('A: jwt module is ready with a valid test secret', jwt.isReady());

  const shA = jwt.hashBearerToken('bearer-session-A');
  const shB = jwt.hashBearerToken('bearer-session-B');
  assert('A: hashBearerToken is deterministic', jwt.hashBearerToken('bearer-session-A') === shA);
  assert('A: different bearers hash differently', shA !== shB);
  assert('A: hashBearerToken never returns the input verbatim', shA !== 'bearer-session-A');
  assert('A: hashBearerToken(null/empty) -> null', jwt.hashBearerToken(null) === null && jwt.hashBearerToken('') === null);

  {
    const proof = jwt.signStepUpProof({ actor: 'owner', role: 'admin', sv: 5, sessionHash: shA });
    assert('A: a fresh proof verifies with ITS OWN session hash', jwt.verifyStepUpProof(proof, { sessionHash: shA }) !== null);
    const verified = jwt.verifyStepUpProof(proof, { sessionHash: shA });
    assert('A: verified payload carries actor/role/sv/purpose',
      verified.sub === 'owner' && verified.role === 'admin' && verified.sv === 5 && verified.purpose === 'manage_pins');
  }

  {
    // THE core guardrail: same actor, same session_version, DIFFERENT session (bearer).
    const proofFromA = jwt.signStepUpProof({ actor: 'owner', role: 'admin', sv: 5, sessionHash: shA });
    assert('A: a proof minted for session A is REJECTED when checked against session B',
      jwt.verifyStepUpProof(proofFromA, { sessionHash: shB }) === null);
    assert('A: that SAME proof still verifies against its OWN session A',
      jwt.verifyStepUpProof(proofFromA, { sessionHash: shA }) !== null);
  }

  {
    const proof = jwt.signStepUpProof({ actor: 'owner', role: 'admin', sv: 5, sessionHash: shA });
    assert('A: missing sessionHash argument -> rejected (never optional)', jwt.verifyStepUpProof(proof, {}) === null);
    assert('A: no options object at all -> rejected', jwt.verifyStepUpProof(proof) === null);
  }

  {
    // Expiry: force signStepUpProof to compute iat/exp as if minted 700s ago. TTL is 600s
    // and SKEW_SEC is 30s (exp+skew = iat+630), so 700s ago clears that tolerance cleanly.
    const realNow = Date.now;
    Date.now = () => realNow() - 700 * 1000;
    const staleProof = jwt.signStepUpProof({ actor: 'owner', role: 'admin', sv: 5, sessionHash: shA });
    Date.now = realNow;
    assert('A: a proof past its 10-minute TTL is rejected', jwt.verifyStepUpProof(staleProof, { sessionHash: shA }) === null);
  }

  {
    // Tampered signature: flip one character of the signature segment.
    const proof = jwt.signStepUpProof({ actor: 'owner', role: 'admin', sv: 5, sessionHash: shA });
    const [h, p, s] = proof.split('.');
    const flipped = s[0] === 'A' ? 'B' + s.slice(1) : 'A' + s.slice(1);
    assert('A: a tampered signature is rejected', jwt.verifyStepUpProof(`${h}.${p}.${flipped}`, { sessionHash: shA }) === null);
  }

  {
    // Cross-use: a REAL session token must never work as a step-up proof, and vice versa —
    // the distinct `v` marker is what makes the two kinds of token non-interchangeable.
    const sessionToken = jwt.signToken({ role: 'admin', sub: 'owner', sv: 5 });
    assert('A: a normal session token is rejected as a step-up proof', jwt.verifyStepUpProof(sessionToken, { sessionHash: shA }) === null);
    const stepUpProof = jwt.signStepUpProof({ actor: 'owner', role: 'admin', sv: 5, sessionHash: shA });
    assert('A: a step-up proof is rejected as a normal session token', jwt.verifyToken(stepUpProof) === null);
  }

  {
    // Hand-crafted, CORRECTLY signed, but wrong purpose / wrong role-sub pairing / non-
    // integer sv / TTL exceeding the 10-minute cap. Each must be rejected on its own merit,
    // not merely because the signature happens to be invalid (it is NOT invalid here).
    const iat = Math.floor(Date.now() / 1000);
    const wrongPurpose = crafted({ v: 'su1', purpose: 'delete_everything', sub: 'owner', role: 'admin', sv: 5, sh: shA, iat, exp: iat + 600 });
    assert('A: correctly-signed but WRONG PURPOSE rejected', jwt.verifyStepUpProof(wrongPurpose, { sessionHash: shA }) === null);

    const wrongRoleSub = crafted({ v: 'su1', purpose: 'manage_pins', sub: 'rider', role: 'admin', sv: 5, sh: shA, iat, exp: iat + 600 });
    assert('A: correctly-signed but invalid role/sub pairing rejected', jwt.verifyStepUpProof(wrongRoleSub, { sessionHash: shA }) === null);

    const badSv = crafted({ v: 'su1', purpose: 'manage_pins', sub: 'owner', role: 'admin', sv: 0, sh: shA, iat, exp: iat + 600 });
    assert('A: correctly-signed but sv<1 rejected', jwt.verifyStepUpProof(badSv, { sessionHash: shA }) === null);

    const overCapTtl = crafted({ v: 'su1', purpose: 'manage_pins', sub: 'owner', role: 'admin', sv: 5, sh: shA, iat, exp: iat + 3600 });
    assert('A: correctly-signed but TTL above the 10-minute cap rejected', jwt.verifyStepUpProof(overCapTtl, { sessionHash: shA }) === null);

    const noSh = crafted({ v: 'su1', purpose: 'manage_pins', sub: 'owner', role: 'admin', sv: 5, sh: '', iat, exp: iat + 600 });
    assert('A: correctly-signed but empty session hash rejected', jwt.verifyStepUpProof(noSh, { sessionHash: shA }) === null);
  }

  assert('A: STEP_UP_TTL_SECONDS is 10 minutes', jwt.STEP_UP_TTL_SECONDS === 600);
  assert('A: STEP_UP_PURPOSE is manage_pins', jwt.STEP_UP_PURPOSE === 'manage_pins');
  assert('A: signStepUpProof rejects a non-admin role/sub pairing', jwt.signStepUpProof({ actor: 'rider', role: 'admin', sv: 5, sessionHash: shA }) === null);
  assert('A: signStepUpProof rejects sv<1', jwt.signStepUpProof({ actor: 'owner', role: 'admin', sv: 0, sessionHash: shA }) === null);
  assert('A: signStepUpProof rejects a missing sessionHash', jwt.signStepUpProof({ actor: 'owner', role: 'admin', sv: 5 }) === null);

  // ══ B. createPinStepUpVerifier — lockout-safe, session_version-aware ════════════════
  const { createPinStepUpVerifier } = require('../src/auth/pinStepUp');
  const pinPolicy = require('../src/auth/pinPolicy');

  function makeVerify() {
    const state = { calls: 0 };
    const fn = async (pin, stored) => { state.calls++; return stored === 'HASH:' + pin; };
    return { fn, state };
  }
  function makeDeps(over = {}) {
    const rec = {
      lockState: { locked: false }, row: null,
      resetRet: { active: true, session_version: 5 }, recRet: { locked: false },
      resetCalls: [], recordCalls: [], lockCalls: [],
    };
    Object.assign(rec, over.rec || {});
    const verify = over.verify || makeVerify();
    const dao = {
      getLockState: async (actor) => { rec.lockCalls.push(actor); if (rec.lockThrow) throw new Error('x'); return rec.lockState; },
      getActorForVerify_SENSITIVE: async () => rec.row,
      recordFailedAttempt: async (actor) => { rec.recordCalls.push(actor); return rec.recRet; },
      resetFailedAttempts: async (actor) => { rec.resetCalls.push(actor); return rec.resetRet; },
    };
    const fakeJwt = {
      hashBearerToken: (t) => (t ? 'H:' + t : null),
      signStepUpProof: ({ actor, role, sv, sessionHash }) => `PROOF:${actor}:${role}:${sv}:${sessionHash}`,
      STEP_UP_TTL_SECONDS: 600,
    };
    const verifier = createPinStepUpVerifier({
      dao, jwt: fakeJwt, pinPolicy, verifyPin: verify.fn, decoyHashPromise: Promise.resolve('DECOY'),
    });
    return { verifier, dao, rec, verify };
  }

  const BASE = { actor: 'owner', role: 'admin', sv: 5, pin: '284917563', bearerToken: 'bearer-X' };

  {
    const { verifier, rec, verify } = makeDeps({ rec: { row: { active: true, pin_hash: 'HASH:284917563' } } });
    const r = await verifier.verifyOwnPin(BASE);
    assert('B: correct PIN -> ok:true with a proof', r.ok === true && typeof r.stepUpProof === 'string' && r.stepUpProof.length > 0);
    assert('B: expiresInSec forwarded from jwt.STEP_UP_TTL_SECONDS', r.expiresInSec === 600);
    assert('B: exactly one verifyPin derivation', verify.state.calls === 1);
    assert('B: success calls resetFailedAttempts, not recordFailedAttempt', rec.resetCalls.length === 1 && rec.recordCalls.length === 0);
    assert('B: proof is bound to THIS bearer\'s hash', r.stepUpProof.endsWith(':H:bearer-X'));
  }

  {
    const { verifier, rec, verify } = makeDeps({ rec: { row: { active: true, pin_hash: 'HASH:503826719' } } }); // wrong PIN
    const r = await verifier.verifyOwnPin(BASE);
    assert('B: wrong PIN -> ok:false code:cred', r.ok === false && r.code === 'cred');
    assert('B: exactly one verifyPin derivation on failure too', verify.state.calls === 1);
    assert('B: failure calls recordFailedAttempt, not resetFailedAttempts', rec.recordCalls.length === 1 && rec.resetCalls.length === 0);
  }

  {
    // absent actor row -> decoy path, indistinguishable failure shape from a wrong PIN
    const { verifier, verify } = makeDeps({ rec: { row: null } });
    const r = await verifier.verifyOwnPin(BASE);
    assert('B: absent actor row -> generic cred failure (no oracle)', r.ok === false && r.code === 'cred');
    assert('B: absent actor row still does exactly one derivation (decoy)', verify.state.calls === 1);
  }

  {
    const { verifier } = makeDeps({ rec: { lockState: { locked: true, retryAfterSec: 42 } } });
    const r = await verifier.verifyOwnPin(BASE);
    assert('B: locked actor -> ok:false code:blocked with retryAfterSec', r.ok === false && r.code === 'blocked' && r.retryAfterSec === 42);
  }

  {
    const { verifier } = makeDeps({});
    const r = await verifier.verifyOwnPin({ ...BASE, role: 'operator' });
    assert('B: non-admin role -> rejected before any DB call', r.ok === false && r.code === 'bad');
  }
  {
    const { verifier } = makeDeps({});
    const r = await verifier.verifyOwnPin({ ...BASE, role: 'rider' });
    assert('B: rider role -> rejected before any DB call', r.ok === false && r.code === 'bad');
  }

  {
    const { verifier } = makeDeps({});
    const r = await verifier.verifyOwnPin({ ...BASE, bearerToken: undefined });
    assert('B: missing bearerToken -> rejected, bad shape', r.ok === false && r.code === 'bad');
  }
  {
    const { verifier } = makeDeps({});
    const r = await verifier.verifyOwnPin({ ...BASE, pin: '' });
    assert('B: empty pin -> rejected, bad shape', r.ok === false && r.code === 'bad');
  }

  {
    // A rotation landed between the guard's DB-fresh read and this call: resetFailedAttempts
    // returns a DIFFERENT session_version than the one the caller was verified against.
    const { verifier } = makeDeps({
      rec: { row: { active: true, pin_hash: 'HASH:284917563' }, resetRet: { active: true, session_version: 999 } },
    });
    const r = await verifier.verifyOwnPin(BASE);
    assert('B: session_version drift between guard and verify -> rejected, no proof', r.ok === false && r.code === 'cred');
  }

  {
    // Actor disabled mid-flow (resetFailedAttempts reports active:false).
    const { verifier } = makeDeps({
      rec: { row: { active: true, pin_hash: 'HASH:284917563' }, resetRet: { active: false, session_version: 5 } },
    });
    const r = await verifier.verifyOwnPin(BASE);
    assert('B: actor disabled mid-flow -> rejected, no proof', r.ok === false && r.code === 'cred');
  }

  {
    // getLockState throwing (transient/NOT_FOUND) falls through to the decoy path rather
    // than crashing or granting a proof.
    const { verifier, verify } = makeDeps({ rec: { lockThrow: true, row: null } });
    const r = await verifier.verifyOwnPin(BASE);
    assert('B: lock-check failure falls through to decoy path, not a crash', r.ok === false && r.code === 'cred');
    assert('B: still exactly one derivation', verify.state.calls === 1);
  }

  // ══ C. Static check — verifyOwnPin never trusts the body for identity ══════════════
  const idxSrc = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const start = idxSrc.indexOf('} else if (action === "verifyOwnPin") {');
  assert('C: verifyOwnPin dispatcher branch exists in index.js', start >= 0);
  const end = idxSrc.indexOf('} else if (action === "setActorPin") {', start);
  const branch = start >= 0 && end > start ? idxSrc.slice(start, end) : '';
  assert('C: branch sources actor from req.authCtx', /req\.authCtx\.actor/.test(branch));
  assert('C: branch sources role from req.authCtx', /req\.authCtx\.role/.test(branch));
  assert('C: branch sources sv from req.authCtx', /req\.authCtx\.sv/.test(branch));
  assert('C: branch never reads an actor/role/sv override from the body',
    !/req\.body\s*&&\s*req\.body\.actor\b/.test(branch)
    && !/req\.body\.role\b/.test(branch)
    && !/req\.body\.sv\b/.test(branch)
    && !/req\.body\.session_version\b/.test(branch));
  assert('C: branch only reads the pin from the body', /req\.body\s*&&\s*req\.body\.pin\b/.test(branch));

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})();
