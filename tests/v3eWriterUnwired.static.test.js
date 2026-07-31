'use strict';
// Access Control V3 -- Block V3-E: proves the access-user lifecycle foundation is
// completely UNWIRED from the running application. Eseguire:
// node tests/v3eWriterUnwired.static.test.js
//
// Mirrors tests/v3dWriterUnwired.static.test.js's approach for V3-E.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ── every current entry point / auth file that could plausibly wire in V3-E ──────
const RUNTIME_FILES = [
  'index.js',
  'src/auth/login.js',
  'src/auth/legacyAuthGuard.js',
  'src/auth/legacyActionRoles.js',
  'src/auth/adminAccessService.js',
  'src/auth/adminAccessDao.js',
  'src/auth/pinRotationService.js',
  'src/auth/pinRotationDao.js',
  'src/auth/pinRotationServiceV3.js',
  'src/auth/pinRotationDaoV3.js',
  'src/auth/roleChangeServiceV3.js',
  'src/auth/roleChangeDaoV3.js',
  'src/auth/accessUserServiceV3.js',
  'src/auth/accessUserDaoV3.js',
  'src/auth/pinStepUp.js',
  'src/auth/jwt.js',
];
const FORBIDDEN_MENTIONS = [
  'accessUserLifecycleServiceV3', 'accessUserLifecycleDaoV3', 'createAccessUserLifecycleV3Service',
  'setAccessUserActiveV3', 'clearAccessUserCredentialV3',
  'auth_set_access_user_active_v3', 'auth_clear_access_user_credential_v3',
];

for (const rel of RUNTIME_FILES) {
  const text = read(rel);
  for (const needle of FORBIDDEN_MENTIONS) {
    assert(`${rel} does not mention '${needle}' (V3-E is not wired into this file)`, !text.includes(needle));
  }
}

// ── the new files exist, are requireable, and are self-contained (no route wiring) ──
const V3E_FILES = [
  'src/auth/accessUserLifecycleRequestHash.js',
  'src/auth/accessUserLifecycleDaoV3.js',
  'src/auth/accessUserLifecycleServiceV3.js',
];
for (const rel of V3E_FILES) {
  assert(`${rel} exists`, fs.existsSync(path.join(ROOT, rel)));
}

// accessUserLifecycleServiceV3.js / accessUserLifecycleDaoV3.js must not themselves be
// required by any OTHER src/auth file except this test suite and each other's own
// dependency edge.
const ALL_SRC_AUTH = fs.readdirSync(path.join(ROOT, 'src', 'auth')).filter((f) => f.endsWith('.js'));
for (const f of ALL_SRC_AUTH) {
  if (f === 'accessUserLifecycleServiceV3.js' || f === 'accessUserLifecycleDaoV3.js') continue;
  // V3-F's integration layer legitimately constructs the real V3-E service graph (still
  // never called from index.js itself -- see accessManagementHttpUnwiredV3.static.test.js).
  if (f === 'accessManagementHttpIntegrationV3.js') continue;
  const text = read(path.join('src', 'auth', f));
  assert(`src/auth/${f} does not require accessUserLifecycleServiceV3.js`, !text.includes('accessUserLifecycleServiceV3'));
  assert(`src/auth/${f} does not require accessUserLifecycleDaoV3.js`, !text.includes('accessUserLifecycleDaoV3'));
}
{
  const svcText = read('src/auth/accessUserLifecycleServiceV3.js');
  assert('accessUserLifecycleServiceV3.js does not require accessUserLifecycleDaoV3.js directly (dependency-injected, not imported)',
    !/require\(['"]\.\/accessUserLifecycleDaoV3['"]\)/.test(svcText));
}

// ── V2/V3-B/V3-C/V3-D remain byte-for-byte the SAME exported contract as before V3-E ──
{
  const v2Service = require('../src/auth/pinRotationService');
  assert('pinRotationService.js (v2) still exports exactly {createPinRotation, FAILED, DUPLICATE} -- unchanged by V3-E',
    JSON.stringify(Object.keys(v2Service).sort()) === JSON.stringify(['DUPLICATE', 'FAILED', 'createPinRotation']));
  const v2Dao = require('../src/auth/pinRotationDao');
  assert('pinRotationDao.js (v2) still exports setActorPinV2, no lifecycle additions leaked in',
    typeof v2Dao.setActorPinV2 === 'function' && v2Dao.setAccessUserActiveV3 === undefined);
  const v3PinService = require('../src/auth/pinRotationServiceV3');
  assert('pinRotationServiceV3.js (V3-B) still exports exactly {createPinRotationV3, FAILED, DUPLICATE, RESERVED} -- unchanged by V3-E',
    JSON.stringify(Object.keys(v3PinService).sort()) === JSON.stringify(['DUPLICATE', 'FAILED', 'RESERVED', 'createPinRotationV3']));
  const v3RoleService = require('../src/auth/roleChangeServiceV3');
  // V3-G.1 later added WAITER_HAS_OPEN_TABLES to this export set (a legitimate
  // extension, not a V3-E change) -- accept any shape that still includes the original
  // V3-C-era exports; V3-E itself added nothing here.
  assert('roleChangeServiceV3.js (V3-C) exports at least {createRoleChangeV3, FAILED, CONFLICT} -- V3-E itself added nothing here',
    typeof v3RoleService.createRoleChangeV3 === 'function' && !!v3RoleService.FAILED && !!v3RoleService.CONFLICT);
  const v3AccessUserService = require('../src/auth/accessUserServiceV3');
  assert('accessUserServiceV3.js (V3-D) still exports exactly {createAccessUserV3Service, FAILED, CONFLICT, NOT_FOUND} -- unchanged by V3-E',
    JSON.stringify(Object.keys(v3AccessUserService).sort()) === JSON.stringify(['CONFLICT', 'FAILED', 'NOT_FOUND', 'createAccessUserV3Service']));
}

// ── the new modules' own exports match the documented, isolated contract ─────────
{
  const svc = require('../src/auth/accessUserLifecycleServiceV3');
  assert('accessUserLifecycleServiceV3.js exports createAccessUserLifecycleV3Service, FAILED, CONFLICT',
    typeof svc.createAccessUserLifecycleV3Service === 'function' && svc.FAILED && svc.CONFLICT);
  assert('FAILED and CONFLICT are distinct error shapes', svc.FAILED.error !== svc.CONFLICT.error);
  const dao = require('../src/auth/accessUserLifecycleDaoV3');
  assert('accessUserLifecycleDaoV3.js exports setAccessUserActiveV3 and clearAccessUserCredentialV3',
    typeof dao.setAccessUserActiveV3 === 'function' && typeof dao.clearAccessUserCredentialV3 === 'function');
  const hash = require('../src/auth/accessUserLifecycleRequestHash');
  assert('accessUserLifecycleRequestHash.js exports computeActiveStateRequestHash and computeClearCredentialRequestHash',
    typeof hash.computeActiveStateRequestHash === 'function' && typeof hash.computeClearCredentialRequestHash === 'function');
}

// ── legacyActionRoles.js (the live authorization guard) is untouched by V3-E ─────
{
  const before = read('src/auth/legacyActionRoles.js');
  assert('legacyActionRoles.js does not mention any V3-E symbol', FORBIDDEN_MENTIONS.every((n) => !before.includes(n)));
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
