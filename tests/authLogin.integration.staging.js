// Integration for B3 login/JWT — STAGING (tdikhfeinufaahagmpjz). SYNTHETIC PINs only.
// Run: node tests/authLogin.integration.staging.js
//
// Part A (always runs): real crypto E2E — scrypt (B1) hash/verify + JWT (B3)
//   sign/verify with a generated test secret. No DB. No full hash is printed.
// Part B (runs only if SUPABASE_URL + a service_role SUPABASE_KEY are set in the
//   env out-of-band): wires the REAL dao + login.js against staging. It is
//   SKIPPED otherwise (the service_role key must never be committed or printed).
//
// login.js orchestration itself is covered by tests/authLogin.test.js (mocked
// dao returning the exact shapes the real RPCs return). The DB-side effects
// (reset/record/lock/audit) were additionally exercised on staging via the
// service-role RPC sequence documented in the B3 report.
'use strict';
const crypto = require('crypto');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  → ' + d : '')); } };

(async () => {
  // ── Part A: real scrypt (B1) + JWT (B3) end-to-end ──────────────────────────
  console.log('=== Part A — crypto E2E (scrypt B1 + JWT B3) ===');
  process.env.AUTH_JWT_SECRET_B64URL = crypto.randomBytes(48).toString('base64url');
  const scrypt = require('../src/auth/scrypt');
  delete require.cache[require.resolve('../src/auth/jwt')];
  const jwt = require('../src/auth/jwt');

  const cases = [
    ['admin', 'owner', '817263549'],          // 9 digits, strong (admin policy 9–12)
    ['operator', 'operator_primary', '284617'],
    ['operator', 'operator_backup', '736194'],
    ['rider', 'rider', '905172'],
  ];
  for (const [role, sub, pin] of cases) {
    const h = await scrypt.hashPin(pin);          // real hash (never printed)
    assert(`${role}/${sub} verify correct`, (await scrypt.verifyPin(pin, h)) === true);
    assert(`${role}/${sub} verify wrong`, (await scrypt.verifyPin('111119', h)) === false);
    const token = jwt.signToken({ role, sub, sv: 4, authMethod: jwt.AUTH_METHOD_ACTOR_PIN });
    const p = jwt.verifyToken(token);
    assert(`${role}/${sub} JWT payload`, p && p.role === role && p.sub === sub && p.sv === 4 && p.v === 2);
    assert(`${role}/${sub} JWT TTL`, p && (p.exp - p.iat) === jwt.TTL_SECONDS[role]);
  }

  // ── Part B: real DB E2E (only with a service_role key) ──────────────────────
  console.log('\n=== Part B — staging DB E2E ===');
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    console.log('  SKIPPED: set SUPABASE_URL + service_role SUPABASE_KEY (out-of-band) to run.');
  } else {
    // Wire real modules. Seeds a synthetic PIN, logs in, then cleans up.
    const dao = require('../src/auth/dao');
    const audit = require('../src/auth/audit');
    const { createLoginHandler } = require('../src/auth/login');
    const ipsec = require('../src/auth/ipSecurity');
    const decoyHashPromise = scrypt.hashPin(crypto.randomBytes(24).toString('hex'));
    const login = createLoginHandler({
      dao, jwt, pinPolicy: require('../src/auth/pinPolicy'),
      verifyPin: scrypt.verifyPin, decoyHashPromise,
      ipHash: ipsec.ipHash, ipLimiter: ipsec.createIpLimiter(), audit,
    });
    const ACTOR = 'rider', ROLE = 'rider', PIN = '905172';
    const saved = await dao.getActorForVerify_SENSITIVE(ACTOR);
    try {
      await dao.setActorPinHash({ actor: ACTOR, pinHash: await scrypt.hashPin(PIN), byActor: 'owner', meta: { src: 'b3int' } });
      const okR = await login({ role: ROLE, pin: PIN, actor: ACTOR, trustedClientIp: '203.0.113.7' });
      assert('E2E login success', okR.status === 200 && jwt.verifyToken(okR.body.token));
      const badR = await login({ role: ROLE, pin: '284619', actor: ACTOR, trustedClientIp: '203.0.113.7' });
      assert('E2E wrong pin 401', badR.status === 401);
    } finally {
      // cleanup handled out-of-band by the report's SQL teardown (restore B0).
      console.log('  NOTE: run the report SQL teardown to restore B0 (pin NULL, sv=1, audit purge).');
    }
  }

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log('  FATAL  ' + (e && e.message)); process.exit(1); });
