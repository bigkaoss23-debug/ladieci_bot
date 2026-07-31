'use strict';
// Access Control V3 -- Block V3-D: proves the dynamic access-user foundation is
// completely UNWIRED from the running application. Eseguire:
// node tests/v3dWriterUnwired.static.test.js
//
// Mirrors tests/v3cWriterUnwired.static.test.js's approach for V3-D.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ── every current entry point / auth file that could plausibly wire in V3-D ──────
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
  'src/auth/pinStepUp.js',
  'src/auth/jwt.js',
];
const FORBIDDEN_MENTIONS = [
  'accessUserServiceV3', 'accessUserDaoV3', 'createAccessUserV3Service',
  'createAccessUserV3', 'renameAccessUserV3',
  'auth_create_access_user_v3', 'auth_rename_access_user_v3',
];

for (const rel of RUNTIME_FILES) {
  const text = read(rel);
  for (const needle of FORBIDDEN_MENTIONS) {
    assert(`${rel} does not mention '${needle}' (V3-D is not wired into this file)`, !text.includes(needle));
  }
}

// ── the new files exist, are requireable, and are self-contained (no route wiring) ──
const V3D_FILES = [
  'src/auth/accessUserIdentity.js',
  'src/auth/accessUserDisplayName.js',
  'src/auth/accessUserRequestHash.js',
  'src/auth/accessUserDaoV3.js',
  'src/auth/accessUserServiceV3.js',
];
for (const rel of V3D_FILES) {
  assert(`${rel} exists`, fs.existsSync(path.join(ROOT, rel)));
}

// accessUserServiceV3.js / accessUserDaoV3.js must not themselves be required by any
// OTHER src/auth file except this test suite and each other's own dependency edge.
const ALL_SRC_AUTH = fs.readdirSync(path.join(ROOT, 'src', 'auth')).filter((f) => f.endsWith('.js'));
for (const f of ALL_SRC_AUTH) {
  if (f === 'accessUserServiceV3.js' || f === 'accessUserDaoV3.js') continue;
  // V3-F's integration layer legitimately constructs the real V3-D service graph (still
  // never called from index.js itself -- see accessManagementHttpUnwiredV3.static.test.js).
  if (f === 'accessManagementHttpIntegrationV3.js') continue;
  const text = read(path.join('src', 'auth', f));
  assert(`src/auth/${f} does not require accessUserServiceV3.js`, !text.includes('accessUserServiceV3'));
  assert(`src/auth/${f} does not require accessUserDaoV3.js`, !text.includes('accessUserDaoV3'));
}
{
  const svcText = read('src/auth/accessUserServiceV3.js');
  assert('accessUserServiceV3.js does not require accessUserDaoV3.js directly (dependency-injected, not imported)',
    !/require\(['"]\.\/accessUserDaoV3['"]\)/.test(svcText));
}

// ── V2 / V3-B / V3-C remain byte-for-byte the SAME exported contract as before V3-D ──
{
  const v2Service = require('../src/auth/pinRotationService');
  assert('pinRotationService.js (v2) still exports exactly {createPinRotation, FAILED, DUPLICATE} -- unchanged by V3-D',
    JSON.stringify(Object.keys(v2Service).sort()) === JSON.stringify(['DUPLICATE', 'FAILED', 'createPinRotation']));
  const v2Dao = require('../src/auth/pinRotationDao');
  assert('pinRotationDao.js (v2) still exports setActorPinV2, no access-user additions leaked in',
    typeof v2Dao.setActorPinV2 === 'function' && v2Dao.createAccessUserV3 === undefined);
  const v3PinService = require('../src/auth/pinRotationServiceV3');
  assert('pinRotationServiceV3.js (V3-B) still exports exactly {createPinRotationV3, FAILED, DUPLICATE, RESERVED} -- unchanged by V3-D',
    JSON.stringify(Object.keys(v3PinService).sort()) === JSON.stringify(['DUPLICATE', 'FAILED', 'RESERVED', 'createPinRotationV3']));
  const v3RoleService = require('../src/auth/roleChangeServiceV3');
  // V3-G.1 later added WAITER_HAS_OPEN_TABLES to this export set (a legitimate
  // extension, not a V3-D change) -- accept any shape that still includes the original
  // V3-C-era exports; V3-D itself added nothing here.
  assert('roleChangeServiceV3.js (V3-C) exports at least {createRoleChangeV3, FAILED, CONFLICT} -- V3-D itself added nothing here',
    typeof v3RoleService.createRoleChangeV3 === 'function' && !!v3RoleService.FAILED && !!v3RoleService.CONFLICT);
}

// ── the new modules' own exports match the documented, isolated contract ─────────
{
  const svc = require('../src/auth/accessUserServiceV3');
  assert('accessUserServiceV3.js exports createAccessUserV3Service, FAILED, CONFLICT, NOT_FOUND',
    typeof svc.createAccessUserV3Service === 'function' && svc.FAILED && svc.CONFLICT && svc.NOT_FOUND);
  assert('FAILED, CONFLICT, NOT_FOUND are distinct error shapes',
    new Set([svc.FAILED.error, svc.CONFLICT.error, svc.NOT_FOUND.error]).size === 3);
  const dao = require('../src/auth/accessUserDaoV3');
  assert('accessUserDaoV3.js exports createAccessUserV3, renameAccessUserV3, listAccessUsersForWorkspace, getAccessUserForWorkspace',
    typeof dao.createAccessUserV3 === 'function' && typeof dao.renameAccessUserV3 === 'function' &&
    typeof dao.listAccessUsersForWorkspace === 'function' && typeof dao.getAccessUserForWorkspace === 'function');
  const identity = require('../src/auth/accessUserIdentity');
  assert('accessUserIdentity.js exports isValidActorId, isLegacyActorId, isDynamicActorId',
    typeof identity.isValidActorId === 'function' && typeof identity.isLegacyActorId === 'function' && typeof identity.isDynamicActorId === 'function');
}

// ── legacyActionRoles.js (the live authorization guard) is untouched by V3-D ─────
{
  const before = read('src/auth/legacyActionRoles.js');
  assert('legacyActionRoles.js does not mention any V3-D symbol', FORBIDDEN_MENTIONS.every((n) => !before.includes(n)));
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
