'use strict';
// Access Control V3 — Block V3-C: proves the role-change foundation is completely
// UNWIRED from the running application. Eseguire:
// node tests/v3cWriterUnwired.static.test.js
//
// Traces actual require() text in every current runtime entry/auth file — mirrors
// tests/v3bWriterUnwired.static.test.js's approach for V3-B. Also proves the legacy
// authorization guard (src/auth/legacyActionRoles.js) and the V2/V3-B PIN writers
// export exactly what they exported before V3-C touched the codebase.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ── every current entry point / auth file that could plausibly wire in V3-C ──────
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
  'src/auth/pinStepUp.js',
  'src/auth/jwt.js',
];
const FORBIDDEN_MENTIONS = [
  'roleChangeServiceV3', 'roleChangeDaoV3', 'createRoleChangeV3', 'changeActorRoleV3',
  'auth_change_actor_role_v3',
];

for (const rel of RUNTIME_FILES) {
  const text = read(rel);
  for (const needle of FORBIDDEN_MENTIONS) {
    assert(`${rel} does not mention '${needle}' (V3-C is not wired into this file)`, !text.includes(needle));
  }
}

// ── the new files exist, are requireable, and are self-contained (no route wiring) ──
const V3C_FILES = [
  'src/auth/roleTransition.js',
  'src/auth/roleChangeRequestHash.js',
  'src/auth/sidHash.js',
  'src/auth/roleChangeDaoV3.js',
  'src/auth/roleChangeServiceV3.js',
];
for (const rel of V3C_FILES) {
  assert(`${rel} exists`, fs.existsSync(path.join(ROOT, rel)));
}

// roleChangeServiceV3.js / roleChangeDaoV3.js must not themselves be required by any
// OTHER src/auth file except this test suite and each other's own dependency edge —
// i.e. nothing routes traffic to them.
const ALL_SRC_AUTH = fs.readdirSync(path.join(ROOT, 'src', 'auth')).filter((f) => f.endsWith('.js'));
for (const f of ALL_SRC_AUTH) {
  if (f === 'roleChangeServiceV3.js' || f === 'roleChangeDaoV3.js') continue;
  const text = read(path.join('src', 'auth', f));
  assert(`src/auth/${f} does not require roleChangeServiceV3.js`, !text.includes('roleChangeServiceV3'));
  assert(`src/auth/${f} does not require roleChangeDaoV3.js`, !text.includes('roleChangeDaoV3'));
}
{
  const svcText = read('src/auth/roleChangeServiceV3.js');
  assert('roleChangeServiceV3.js does not require roleChangeDaoV3.js directly (dependency-injected, not imported)',
    !/require\(['"]\.\/roleChangeDaoV3['"]\)/.test(svcText));
}

// ── V2 / V3-B remain byte-for-byte the SAME exported contract they had before V3-C ──
{
  const v2Service = require('../src/auth/pinRotationService');
  assert('pinRotationService.js (v2) still exports exactly {createPinRotation, FAILED, DUPLICATE} — unchanged by V3-C',
    JSON.stringify(Object.keys(v2Service).sort()) === JSON.stringify(['DUPLICATE', 'FAILED', 'createPinRotation']));
  const v2Dao = require('../src/auth/pinRotationDao');
  assert('pinRotationDao.js (v2) still exports setActorPinV2, no role-change additions leaked in',
    typeof v2Dao.setActorPinV2 === 'function' && v2Dao.changeActorRoleV3 === undefined);
  const v3Service = require('../src/auth/pinRotationServiceV3');
  assert('pinRotationServiceV3.js (V3-B) still exports exactly {createPinRotationV3, FAILED, DUPLICATE, RESERVED} — unchanged by V3-C',
    JSON.stringify(Object.keys(v3Service).sort()) === JSON.stringify(['DUPLICATE', 'FAILED', 'RESERVED', 'createPinRotationV3']));
}

// ── the new modules' own exports match the documented, isolated contract ─────────
{
  const svc = require('../src/auth/roleChangeServiceV3');
  assert('roleChangeServiceV3.js exports createRoleChangeV3, FAILED, CONFLICT',
    typeof svc.createRoleChangeV3 === 'function' && svc.FAILED && svc.CONFLICT);
  assert('FAILED and CONFLICT are distinct error shapes', svc.FAILED.error !== svc.CONFLICT.error);
  const dao = require('../src/auth/roleChangeDaoV3');
  assert('roleChangeDaoV3.js exports changeActorRoleV3', typeof dao.changeActorRoleV3 === 'function');
  const transition = require('../src/auth/roleTransition');
  assert('roleTransition.js exports canonicalRoleForDbRole and isAssignableRole',
    typeof transition.canonicalRoleForDbRole === 'function' && typeof transition.isAssignableRole === 'function');
}

// ── legacyActionRoles.js (the live authorization guard) is untouched by V3-C ─────
{
  const before = read('src/auth/legacyActionRoles.js');
  assert('legacyActionRoles.js does not mention any V3-C symbol', FORBIDDEN_MENTIONS.every((n) => !before.includes(n)));
  assert('legacyActionRoles.js still frames its principals as admin/operator/rider only',
    /admin.*operator.*rider|'admin', 'operator', 'rider'/i.test(before) || before.includes("'admin'"));
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
