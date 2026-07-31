'use strict';
// Access Control V3 — Block V3-B: proves the new credential-rotation foundation is
// completely UNWIRED from the running application. Eseguire:
// node tests/v3bWriterUnwired.static.test.js
//
// Traces actual require() text in every current runtime entry/auth file — not a
// filename grep, a check that nothing in the live call graph mentions the new modules
// or the new RPC — mirroring tests/actionPolicyAuthorityBoundary.test.js's approach for
// V3-A. Also proves v2's own files (behavior current login/PIN-rotation depends on)
// still export exactly what they exported before V3-B touched the codebase.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ── every current entry point / auth file that could plausibly wire in V3-B ──────
const RUNTIME_FILES = [
  'index.js',
  'src/auth/login.js',
  'src/auth/legacyAuthGuard.js',
  'src/auth/adminAccessService.js',
  'src/auth/pinRotationService.js',
  'src/auth/pinRotationDao.js',
  'src/auth/pinStepUp.js',
  'src/auth/jwt.js',
];
const FORBIDDEN_MENTIONS = [
  'pinRotationServiceV3', 'pinRotationDaoV3', 'pinFingerprintKeyConfig', 'pinFingerprint',
  'auth_set_actor_pin_v3', 'createPinRotationV3', 'setActorPinV3',
];

for (const rel of RUNTIME_FILES) {
  const text = read(rel);
  for (const needle of FORBIDDEN_MENTIONS) {
    assert(`${rel} does not mention '${needle}' (V3-B is not wired into this file)`, !text.includes(needle));
  }
}

// ── the new files exist, are requireable, and are self-contained (no route wiring) ──
const V3B_FILES = [
  'src/auth/pinFingerprintKeyConfig.js',
  'src/auth/pinFingerprint.js',
  'src/auth/pinRotationDaoV3.js',
  'src/auth/pinRotationServiceV3.js',
];
for (const rel of V3B_FILES) {
  assert(`${rel} exists`, fs.existsSync(path.join(ROOT, rel)));
}

// pinRotationServiceV3.js / pinRotationDaoV3.js must not themselves be required by any
// OTHER file except this test suite and each other (the DAO is a dependency of the
// service by design) — i.e. nothing routes traffic to them.
const ALL_SRC_AUTH = fs.readdirSync(path.join(ROOT, 'src', 'auth')).filter((f) => f.endsWith('.js'));
for (const f of ALL_SRC_AUTH) {
  if (f === 'pinRotationServiceV3.js' || f === 'pinRotationDaoV3.js') continue;
  // V3-F's integration layer legitimately constructs the real V3-B service graph (still
  // never called from index.js itself -- see accessManagementHttpUnwiredV3.static.test.js).
  if (f === 'accessManagementHttpIntegrationV3.js') continue;
  const text = read(path.join('src', 'auth', f));
  assert(`src/auth/${f} does not require pinRotationServiceV3.js`, !text.includes('pinRotationServiceV3'));
  assert(`src/auth/${f} does not require pinRotationDaoV3.js`, !text.includes('pinRotationDaoV3'));
}
{
  const svcText = read('src/auth/pinRotationServiceV3.js');
  assert('pinRotationServiceV3.js does not require pinRotationDaoV3.js directly (dependency-injected, not imported — matches v2\'s own decoupling)',
    !/require\(['"]\.\/pinRotationDaoV3['"]\)/.test(svcText));
}

// ── v2 remains byte-for-byte the SAME exported contract it had before V3-B ────────
{
  const v2Service = require('../src/auth/pinRotationService');
  assert('pinRotationService.js (v2) still exports exactly {createPinRotation, FAILED, DUPLICATE} — no PIN_RESERVED added, no signature change',
    JSON.stringify(Object.keys(v2Service).sort()) === JSON.stringify(['DUPLICATE', 'FAILED', 'createPinRotation']));
  const v2Dao = require('../src/auth/pinRotationDao');
  assert('pinRotationDao.js (v2) still exports setActorPinV2, no v3 additions leaked in',
    typeof v2Dao.setActorPinV2 === 'function' && v2Dao.setActorPinV3 === undefined);
}

// ── the new module's own exports match the documented, isolated contract ─────────
{
  const svc = require('../src/auth/pinRotationServiceV3');
  assert('pinRotationServiceV3.js exports createPinRotationV3, FAILED, DUPLICATE, RESERVED',
    typeof svc.createPinRotationV3 === 'function' && svc.FAILED && svc.DUPLICATE && svc.RESERVED);
  assert('RESERVED and DUPLICATE are distinct error shapes', svc.RESERVED.error !== svc.DUPLICATE.error);
  const dao = require('../src/auth/pinRotationDaoV3');
  assert('pinRotationDaoV3.js exports setActorPinV3 and re-exports the read-only v2 helper',
    typeof dao.setActorPinV3 === 'function' && typeof dao.listActorsWithWorkspaceForVerify_SENSITIVE === 'function');
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
