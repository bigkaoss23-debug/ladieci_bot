'use strict';
// S2-7D6E4 — step-up PIN confirmation, session-bound via per-login `sid`. Run:
//   node tests/pinStepUp.test.js
//
// WHY sid AND NOT A BEARER HASH. An earlier draft bound the step-up proof to
// sha256(rawBearer). Part A0 below reproduces, with REAL src/auth/jwt.js and frozen time,
// the exact failure mode that made that binding wrong: signToken's payload was
// {role,sub,iat,exp,sv,v:2} — no per-login randomness — so two logins for the SAME actor at
// the SAME session_version within the SAME clock second produced a BYTE-IDENTICAL token.
// hashBearerToken(tokenA) === hashBearerToken(tokenB) in that case not because the hash is
// weak, but because tokenA === tokenB. `sid` (crypto.randomBytes, minted fresh by signToken,
// never caller-supplied) is what actually distinguishes two otherwise-identical logins, and
// is what the step-up proof is bound to now.
//
// Part A exercises the REAL src/auth/jwt.js. Part B exercises createPinStepUpVerifier with
// injected fakes, same house style as tests/authLogin.test.js. Part C is a static check on
// index.js.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

process.env.AUTH_JWT_SECRET_B64URL = crypto.randomBytes(32).toString('base64url');
delete require.cache[require.resolve('../src/auth/jwt')];
const jwt = require('../src/auth/jwt');
const SECRET_BUF = Buffer.from(process.env.AUTH_JWT_SECRET_B64URL, 'base64url');

function b64url(buf) { return Buffer.from(buf).toString('base64url'); }
function hmacWithTestSecret(data) { return crypto.createHmac('sha256', SECRET_BUF).update(data).digest('base64url'); }
// Hand-craft a token in jwt.js's exact wire format, signed with the SAME secret jwt.js
// itself uses (this test set the env var before requiring jwt.js). NOT reading jwt.js's
// private SECRET — an independent HMAC over a secret only this test controls.
function crafted(payloadObj) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify(payloadObj));
  const sig = hmacWithTestSecret(header + '.' + payload);
  return header + '.' + payload + '.' + sig;
}

(async () => {
  // ══ A0. THE REGRESSION — reproduce the collision the session-binding review flagged ══
  // Sign AND verify while still frozen: freezing at a fixed epoch and restoring real time
  // before verifying would make the minted token read as expired under whatever the real
  // clock happens to be, which is a test artifact, not the property under test.
  {
    const realNow = Date.now;
    const frozen = realNow(); // same instant for both logins — that's the whole point
    Date.now = () => frozen;
    const tokenA = jwt.signToken({ role: 'admin', sub: 'owner', sv: 5, authMethod: jwt.AUTH_METHOD_ACTOR_PIN });
    const tokenB = jwt.signToken({ role: 'admin', sub: 'owner', sv: 5, authMethod: jwt.AUTH_METHOD_ACTOR_PIN });
    assert('A0: two logins minted in the identical second are DIFFERENT tokens (sid fix)', tokenA !== tokenB);
    const plA = jwt.verifyToken(tokenA), plB = jwt.verifyToken(tokenB);
    Date.now = realNow;
    assert('A0: both tokens verified successfully', plA !== null && plB !== null);
    assert('A0: both tokens are otherwise identical (same actor/role/sv/iat/exp)',
      plA && plB && plA.sub === plB.sub && plA.role === plB.role && plA.sv === plB.sv && plA.iat === plB.iat && plA.exp === plB.exp);
    assert('A0: session A and session B have DIFFERENT sid', plA && plB && plA.sid !== plB.sid);
    assert('A0: sid is present and non-trivial', plA && typeof plA.sid === 'string' && plA.sid.length >= 16);
  }

  // ══ A1. Token domain separation ══════════════════════════════════════════════════
  {
    const sessionToken = jwt.signToken({ role: 'admin', sub: 'owner', sv: 5, authMethod: jwt.AUTH_METHOD_ACTOR_PIN });
    const sid = jwt.verifyToken(sessionToken).sid;
    const stepUpProof = jwt.signStepUpProof({ actor: 'owner', role: 'admin', sv: 5, sid, authMethod: jwt.AUTH_METHOD_ACTOR_PIN });
    assert('A1: the normal Auth V2 verifier rejects a v=su1 token', jwt.verifyToken(stepUpProof) === null);
    assert('A1: the step-up verifier rejects a normal session token', jwt.verifyStepUpProof(sessionToken, { sid, authMethod: jwt.AUTH_METHOD_ACTOR_PIN }) === null);
  }

  // ══ A2. Cross-session rejection, same-session success, using REAL logins ════════════
  {
    const realNow = Date.now;
    const frozen = realNow();
    Date.now = () => frozen;
    const sessionA = jwt.signToken({ role: 'admin', sub: 'owner', sv: 5, authMethod: jwt.AUTH_METHOD_ACTOR_PIN });
    const sessionB = jwt.signToken({ role: 'admin', sub: 'owner', sv: 5, authMethod: jwt.AUTH_METHOD_ACTOR_PIN }); // same actor/role/sv/instant
    const sidA = jwt.verifyToken(sessionA).sid;
    const sidB = jwt.verifyToken(sessionB).sid;
    Date.now = realNow;
    assert('A2: sessions A and B (same owner, same second) have different sid', sidA !== sidB);

    const stepUpA = jwt.signStepUpProof({ actor: 'owner', role: 'admin', sv: 5, sid: sidA, authMethod: jwt.AUTH_METHOD_ACTOR_PIN });
    assert('A2: step-up A is REJECTED when checked against session B', jwt.verifyStepUpProof(stepUpA, { sid: sidB, authMethod: jwt.AUTH_METHOD_ACTOR_PIN }) === null);
    assert('A2: step-up A WORKS in session A', jwt.verifyStepUpProof(stepUpA, { sid: sidA, authMethod: jwt.AUTH_METHOD_ACTOR_PIN }) !== null);
  }

  // ══ A2b. Cross-auth_method rejection — S2-7D4C, the multi-device (same sid) analog ═══
  // A proof minted under one auth_method must never be usable by a verification context
  // expecting the OTHER method, even for the identical actor/role/sv/sid.
  {
    const sid = 'sid-same-for-both-methods';
    const proofUniversal = jwt.signStepUpProof({ actor: 'owner', role: 'admin', sv: 5, sid, authMethod: jwt.AUTH_METHOD_LEGACY_UNIVERSAL });
    assert('A2b: legacy_universal proof rejected when session expects actor_pin (same sid)',
      jwt.verifyStepUpProof(proofUniversal, { sid, authMethod: jwt.AUTH_METHOD_ACTOR_PIN }) === null);
    assert('A2b: legacy_universal proof accepted when session expects legacy_universal (same sid)',
      jwt.verifyStepUpProof(proofUniversal, { sid, authMethod: jwt.AUTH_METHOD_LEGACY_UNIVERSAL }) !== null);

    const proofActorPin = jwt.signStepUpProof({ actor: 'owner', role: 'admin', sv: 5, sid, authMethod: jwt.AUTH_METHOD_ACTOR_PIN });
    assert('A2b: actor_pin proof rejected when session expects legacy_universal (same sid)',
      jwt.verifyStepUpProof(proofActorPin, { sid, authMethod: jwt.AUTH_METHOD_LEGACY_UNIVERSAL }) === null);
  }

  // ══ A3. A token with no sid, or no valid auth_method, cannot obtain OR use a step-up proof ══
  {
    assert('A3: signStepUpProof refuses a missing sid', jwt.signStepUpProof({ actor: 'owner', role: 'admin', sv: 5, authMethod: jwt.AUTH_METHOD_ACTOR_PIN }) === null);
    assert('A3: signStepUpProof refuses an empty sid', jwt.signStepUpProof({ actor: 'owner', role: 'admin', sv: 5, sid: '', authMethod: jwt.AUTH_METHOD_ACTOR_PIN }) === null);
    const proofFromElsewhere = jwt.signStepUpProof({ actor: 'owner', role: 'admin', sv: 5, sid: 'some-real-sid', authMethod: jwt.AUTH_METHOD_ACTOR_PIN });
    assert('A3: verifyStepUpProof refuses a missing sid to check against', jwt.verifyStepUpProof(proofFromElsewhere, { authMethod: jwt.AUTH_METHOD_ACTOR_PIN }) === null);
    assert('A3: verifyStepUpProof refuses an empty sid to check against', jwt.verifyStepUpProof(proofFromElsewhere, { sid: '', authMethod: jwt.AUTH_METHOD_ACTOR_PIN }) === null);
    assert('A3: verifyStepUpProof refuses no options object at all', jwt.verifyStepUpProof(proofFromElsewhere) === null);
    // S2-7D4C — the auth_method analog: missing/invalid authMethod refuses sign AND verify.
    assert('A3: signStepUpProof refuses a missing authMethod', jwt.signStepUpProof({ actor: 'owner', role: 'admin', sv: 5, sid: 'some-real-sid' }) === null);
    assert('A3: signStepUpProof refuses an invalid authMethod', jwt.signStepUpProof({ actor: 'owner', role: 'admin', sv: 5, sid: 'some-real-sid', authMethod: 'universal' }) === null);
    assert('A3: verifyStepUpProof refuses a missing authMethod to check against', jwt.verifyStepUpProof(proofFromElsewhere, { sid: 'some-real-sid' }) === null);
    assert('A3: verifyStepUpProof refuses an invalid authMethod to check against', jwt.verifyStepUpProof(proofFromElsewhere, { sid: 'some-real-sid', authMethod: 'universal' }) === null);
  }

  // ══ A4. Round-trip, expiry, tamper, hand-crafted-but-correctly-signed wrong shapes ══
  {
    const sid = 'sid-fixed-for-this-block';
    const authMethod = jwt.AUTH_METHOD_ACTOR_PIN;
    const proof = jwt.signStepUpProof({ actor: 'owner', role: 'admin', sv: 5, sid, authMethod });
    const verified = jwt.verifyStepUpProof(proof, { sid, authMethod });
    assert('A4: a fresh proof verifies and carries actor/role/sv/purpose/sid/am',
      verified && verified.sub === 'owner' && verified.role === 'admin' && verified.sv === 5
      && verified.purpose === 'manage_pins' && verified.sid === sid && verified.am === authMethod);

    const realNow = Date.now;
    Date.now = () => realNow() - 700 * 1000; // TTL 600s + SKEW 30s cleared by 700s
    const staleProof = jwt.signStepUpProof({ actor: 'owner', role: 'admin', sv: 5, sid, authMethod });
    Date.now = realNow;
    assert('A4: a proof past its 10-minute TTL is rejected', jwt.verifyStepUpProof(staleProof, { sid, authMethod }) === null);

    const [h, p, s] = proof.split('.');
    const flipped = s[0] === 'A' ? 'B' + s.slice(1) : 'A' + s.slice(1);
    assert('A4: a tampered signature is rejected', jwt.verifyStepUpProof(`${h}.${p}.${flipped}`, { sid, authMethod }) === null);

    const iat = Math.floor(Date.now() / 1000);
    const wrongPurpose = crafted({ v: 'su1', purpose: 'delete_everything', sub: 'owner', role: 'admin', sv: 5, sid, am: authMethod, iat, exp: iat + 600 });
    assert('A4: correctly-signed but WRONG PURPOSE rejected', jwt.verifyStepUpProof(wrongPurpose, { sid, authMethod }) === null);

    const wrongRoleSub = crafted({ v: 'su1', purpose: 'manage_pins', sub: 'rider', role: 'admin', sv: 5, sid, am: authMethod, iat, exp: iat + 600 });
    assert('A4: correctly-signed but invalid role/sub pairing rejected', jwt.verifyStepUpProof(wrongRoleSub, { sid, authMethod }) === null);

    const badSv = crafted({ v: 'su1', purpose: 'manage_pins', sub: 'owner', role: 'admin', sv: 0, sid, am: authMethod, iat, exp: iat + 600 });
    assert('A4: correctly-signed but sv<1 rejected', jwt.verifyStepUpProof(badSv, { sid, authMethod }) === null);

    const overCapTtl = crafted({ v: 'su1', purpose: 'manage_pins', sub: 'owner', role: 'admin', sv: 5, sid, am: authMethod, iat, exp: iat + 3600 });
    assert('A4: correctly-signed but TTL above the 10-minute cap rejected', jwt.verifyStepUpProof(overCapTtl, { sid, authMethod }) === null);

    const emptySid = crafted({ v: 'su1', purpose: 'manage_pins', sub: 'owner', role: 'admin', sv: 5, sid: '', am: authMethod, iat, exp: iat + 600 });
    assert('A4: correctly-signed but empty sid in the payload rejected', jwt.verifyStepUpProof(emptySid, { sid, authMethod }) === null);

    const oversizeSid = crafted({ v: 'su1', purpose: 'manage_pins', sub: 'owner', role: 'admin', sv: 5, sid: 'x'.repeat(65), am: authMethod, iat, exp: iat + 600 });
    assert('A4: an oversized sid in the payload is rejected', jwt.verifyStepUpProof(oversizeSid, { sid: 'x'.repeat(65), authMethod }) === null);

    // S2-7D4C — am-specific malformed shapes
    const missingAm = crafted({ v: 'su1', purpose: 'manage_pins', sub: 'owner', role: 'admin', sv: 5, sid, iat, exp: iat + 600 }); // no am at all
    assert('A4: a step-up proof with NO am claim is rejected (unlike a session token, no legacy tolerance)', jwt.verifyStepUpProof(missingAm, { sid, authMethod }) === null);

    const invalidAm = crafted({ v: 'su1', purpose: 'manage_pins', sub: 'owner', role: 'admin', sv: 5, sid, am: 'universal', iat, exp: iat + 600 });
    assert('A4: a step-up proof with an invalid am value is rejected', jwt.verifyStepUpProof(invalidAm, { sid, authMethod }) === null);

    const mismatchedAm = crafted({ v: 'su1', purpose: 'manage_pins', sub: 'owner', role: 'admin', sv: 5, sid, am: jwt.AUTH_METHOD_LEGACY_UNIVERSAL, iat, exp: iat + 600 });
    assert('A4: a validly-signed proof for the OTHER am is rejected against this authMethod', jwt.verifyStepUpProof(mismatchedAm, { sid, authMethod: jwt.AUTH_METHOD_ACTOR_PIN }) === null);
  }

  assert('A5: STEP_UP_TTL_SECONDS is 10 minutes', jwt.STEP_UP_TTL_SECONDS === 600);
  assert('A5: STEP_UP_PURPOSE is manage_pins', jwt.STEP_UP_PURPOSE === 'manage_pins');
  assert('A5: hashBearerToken has been removed — sid is the only binding now', jwt.hashBearerToken === undefined);

  // ══ A6. verifyToken tolerates a sid-less (legacy) token for ordinary auth ═════════
  {
    const iat = Math.floor(Date.now() / 1000);
    const legacyToken = crafted({ role: 'admin', sub: 'owner', iat, exp: iat + 4 * 3600, sv: 5, v: 2 }); // no sid at all
    const pl = jwt.verifyToken(legacyToken);
    assert('A6: a token with NO sid still authorizes ordinary actions', pl !== null && pl.sub === 'owner' && pl.sid === undefined);
    const malformedSidToken = crafted({ role: 'admin', sub: 'owner', iat, exp: iat + 4 * 3600, sv: 5, v: 2, sid: '' });
    assert('A6: a token with a malformed (empty) sid is rejected outright, not silently downgraded', jwt.verifyToken(malformedSidToken) === null);
  }

  // ══ B. createPinStepUpVerifier — sid-bound, lockout-safe ════════════════════════════
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
    const FAKE_AUTH_METHODS = new Set(['actor_pin', 'legacy_universal']);
    const fakeJwt = {
      AUTH_METHOD_ACTOR_PIN: 'actor_pin',
      AUTH_METHOD_LEGACY_UNIVERSAL: 'legacy_universal',
      isValidAuthMethod: (m) => typeof m === 'string' && FAKE_AUTH_METHODS.has(m),
      signStepUpProof: ({ actor, role, sv, sid, authMethod }) => (sid && FAKE_AUTH_METHODS.has(authMethod) ? `PROOF:${actor}:${role}:${sv}:${sid}:${authMethod}` : null),
      STEP_UP_TTL_SECONDS: 600,
    };
    const verifier = createPinStepUpVerifier({
      dao, jwt: fakeJwt, pinPolicy, verifyPin: verify.fn, decoyHashPromise: Promise.resolve('DECOY'),
    });
    return { verifier, dao, rec, verify };
  }

  // BASE uses authMethod:'actor_pin' with a 9-digit PIN — valid under BOTH the strict admin
  // format (9-12) AND the universal format (6-12), so every pre-existing assertion below that
  // doesn't care about auth_method keeps passing unchanged regardless of which selector fires.
  const BASE = { actor: 'owner', role: 'admin', sv: 5, pin: '284917563', sid: 'sid-X', authMethod: 'actor_pin' };

  {
    const { verifier, rec, verify } = makeDeps({ rec: { row: { active: true, pin_hash: 'HASH:284917563' } } });
    const r = await verifier.verifyOwnPin(BASE);
    assert('B: correct PIN -> ok:true with a proof', r.ok === true && typeof r.stepUpProof === 'string' && r.stepUpProof.length > 0);
    assert('B: expiresInSec forwarded', r.expiresInSec === 600);
    assert('B: exactly one verifyPin derivation', verify.state.calls === 1);
    assert('B: success calls resetFailedAttempts, not recordFailedAttempt', rec.resetCalls.length === 1 && rec.recordCalls.length === 0);
    assert('B: proof is bound to THIS session\'s sid', r.stepUpProof.includes(':sid-X:'));
    assert('B: proof is bound to THIS session\'s auth_method', r.stepUpProof.endsWith(':actor_pin'));
  }

  {
    const { verifier, rec, verify } = makeDeps({ rec: { row: { active: true, pin_hash: 'HASH:503826719' } } }); // wrong PIN
    const r = await verifier.verifyOwnPin(BASE);
    assert('B: wrong PIN -> ok:false code:cred', r.ok === false && r.code === 'cred');
    assert('B: exactly one verifyPin derivation on failure too', verify.state.calls === 1);
    assert('B: failure calls recordFailedAttempt, not resetFailedAttempts', rec.recordCalls.length === 1 && rec.resetCalls.length === 0);
  }

  {
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

  // ══ B-sid. The precise contract this session added: no sid, no step-up, ever ══════
  {
    const { verifier, rec, verify } = makeDeps({ rec: { row: { active: true, pin_hash: 'HASH:284917563' } } });
    const r = await verifier.verifyOwnPin({ ...BASE, sid: undefined });
    assert('B-sid: missing sid -> reauth_required, distinct from a wrong PIN', r.ok === false && r.code === 'reauth_required');
    assert('B-sid: NO db calls at all — refused before touching lockout/PIN state',
      rec.lockCalls.length === 0 && rec.recordCalls.length === 0 && rec.resetCalls.length === 0 && verify.state.calls === 0);
  }
  {
    const { verifier, verify } = makeDeps({ rec: { row: { active: true, pin_hash: 'HASH:284917563' } } });
    const r = await verifier.verifyOwnPin({ ...BASE, sid: '' });
    assert('B-sid: empty-string sid -> reauth_required too', r.ok === false && r.code === 'reauth_required');
    assert('B-sid: empty sid also does zero derivations', verify.state.calls === 0);
  }
  {
    const { verifier } = makeDeps({ rec: { row: { active: true, pin_hash: 'HASH:284917563' } } });
    const r = await verifier.verifyOwnPin({ ...BASE, sid: 42 }); // wrong type entirely
    assert('B-sid: non-string sid -> reauth_required', r.ok === false && r.code === 'reauth_required');
  }

  // ══ B-am. S2-7D4C: no valid auth_method, no step-up, ever (same discipline as sid) ═══
  {
    const { verifier, rec, verify } = makeDeps({ rec: { row: { active: true, pin_hash: 'HASH:284917563' } } });
    const r = await verifier.verifyOwnPin({ ...BASE, authMethod: undefined });
    assert('B-am: missing authMethod -> reauth_required, distinct from a wrong PIN', r.ok === false && r.code === 'reauth_required');
    assert('B-am: NO db calls at all — refused before touching lockout/PIN state',
      rec.lockCalls.length === 0 && rec.recordCalls.length === 0 && rec.resetCalls.length === 0 && verify.state.calls === 0);
  }
  {
    const { verifier } = makeDeps({ rec: { row: { active: true, pin_hash: 'HASH:284917563' } } });
    const r = await verifier.verifyOwnPin({ ...BASE, authMethod: '' });
    assert('B-am: empty-string authMethod -> reauth_required too', r.ok === false && r.code === 'reauth_required');
  }
  {
    const { verifier } = makeDeps({ rec: { row: { active: true, pin_hash: 'HASH:284917563' } } });
    const r = await verifier.verifyOwnPin({ ...BASE, authMethod: 'universal' }); // not the canonical enum value
    assert('B-am: unrecognized authMethod string -> reauth_required', r.ok === false && r.code === 'reauth_required');
  }
  {
    const { verifier } = makeDeps({ rec: { row: { active: true, pin_hash: 'HASH:284917563' } } });
    const r = await verifier.verifyOwnPin({ ...BASE, authMethod: 'ACTOR_PIN' }); // wrong case
    assert('B-am: wrong-case authMethod -> reauth_required', r.ok === false && r.code === 'reauth_required');
  }

  // ══ B-format. THE ROOT CAUSE FIX: the PIN-format validator is selected by auth_method ═══
  // '284917' is 6 digits: valid under validateUniversalPinFormat (6-12) but BELOW the admin
  // floor of validatePinFormat (9-12) — exactly the real-world shape (a short owner PIN that
  // authenticates universal login but used to be rejected on FORMAT ALONE by step-up).
  {
    const { verifier, verify } = makeDeps({ rec: { row: { active: true, pin_hash: 'HASH:284917' } } });
    const r = await verifier.verifyOwnPin({ ...BASE, pin: '284917', authMethod: 'legacy_universal' });
    assert('B-format: legacy_universal session + matching 6-digit PIN -> 200 (root cause fixed)', r.ok === true && typeof r.stepUpProof === 'string');
    assert('B-format: reaches the hash check (one derivation), not rejected on format', verify.state.calls === 1);
  }
  {
    const { verifier, verify } = makeDeps({ rec: { row: { active: true, pin_hash: 'HASH:284917' } } });
    const r = await verifier.verifyOwnPin({ ...BASE, pin: '284917', authMethod: 'actor_pin' });
    assert('B-format: actor_pin session + the SAME 6-digit PIN -> cred (admin format needs 9-12)', r.ok === false && r.code === 'cred');
    // Still exactly one derivation? No — format is rejected BEFORE any hash derivation, so zero.
    assert('B-format: actor_pin rejects on format alone, no derivation reaches the hash', verify.state.calls === 0);
  }
  {
    // legacy_universal + an 8-digit value ALSO passes the universal gate (6-12) but would also
    // fail the strict admin gate (9-12) if authMethod had been actor_pin — confirms the boundary.
    const { verifier } = makeDeps({ rec: { row: { active: true, pin_hash: 'HASH:28491763' } } });
    const r = await verifier.verifyOwnPin({ ...BASE, pin: '28491763', authMethod: 'legacy_universal' });
    assert('B-format: legacy_universal + matching 8-digit PIN -> 200', r.ok === true);
  }
  {
    // A WRONG-value PIN still fails under either method — the format fix does not weaken the
    // hash check itself.
    const { verifier } = makeDeps({ rec: { row: { active: true, pin_hash: 'HASH:284917' } } });
    const r = await verifier.verifyOwnPin({ ...BASE, pin: '284918', authMethod: 'legacy_universal' }); // well-formed but wrong value
    assert('B-format: legacy_universal + WRONG 6-digit PIN -> cred (format ok, hash mismatch)', r.ok === false && r.code === 'cred');
  }
  {
    // The minted proof itself carries the authMethod it was confirmed under.
    const { verifier } = makeDeps({ rec: { row: { active: true, pin_hash: 'HASH:284917' } } });
    const r = await verifier.verifyOwnPin({ ...BASE, pin: '284917', authMethod: 'legacy_universal' });
    assert('B-format: minted proof is bound to legacy_universal', r.ok === true && r.stepUpProof.endsWith(':legacy_universal'));
  }

  {
    const { verifier } = makeDeps({});
    const r = await verifier.verifyOwnPin({ ...BASE, pin: '' });
    assert('B: empty pin -> rejected, bad shape', r.ok === false && r.code === 'bad');
  }

  {
    const { verifier } = makeDeps({
      rec: { row: { active: true, pin_hash: 'HASH:284917563' }, resetRet: { active: true, session_version: 999 } },
    });
    const r = await verifier.verifyOwnPin(BASE);
    assert('B: session_version drift between guard and verify -> rejected, no proof', r.ok === false && r.code === 'cred');
  }

  {
    const { verifier } = makeDeps({
      rec: { row: { active: true, pin_hash: 'HASH:284917563' }, resetRet: { active: false, session_version: 5 } },
    });
    const r = await verifier.verifyOwnPin(BASE);
    assert('B: actor disabled mid-flow -> rejected, no proof', r.ok === false && r.code === 'cred');
  }

  {
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
  assert('C: branch sources sid from req.authCtx (never the body)', /req\.authCtx\.sid/.test(branch));
  assert('C: branch sources authMethod from req.authCtx (never the body) — S2-7D4C', /req\.authCtx\.authMethod/.test(branch));
  assert('C: branch never reads an actor/role/sv/sid/auth_method override from the body',
    !/req\.body\s*&&\s*req\.body\.actor\b/.test(branch)
    && !/req\.body\.role\b/.test(branch)
    && !/req\.body\.sv\b/.test(branch)
    && !/req\.body\.sid\b/.test(branch)
    && !/req\.body\.session_version\b/.test(branch)
    && !/req\.body\.auth_method\b/.test(branch)
    && !/req\.body\.authMethod\b/.test(branch));
  assert('C: branch only reads the pin from the body', /req\.body\s*&&\s*req\.body\.pin\b/.test(branch));
  assert('C: branch maps reauth_required to a distinct response', /reauth_required/.test(branch) && /REAUTH_REQUIRED/.test(branch));

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})();
