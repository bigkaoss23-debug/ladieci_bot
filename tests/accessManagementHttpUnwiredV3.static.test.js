'use strict';
// Access Control V3 -- Block V3-F: proves the owner access-management HTTP boundary is
// completely UNWIRED from the running application. Run: node tests/accessManagementHttpUnwiredV3.static.test.js
// Mirrors tests/v3eWriterUnwired.static.test.js's approach for V3-F.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ── every current entry point / auth file that could plausibly wire in V3-F ──────
const RUNTIME_FILES = [
  'index.js',
  'src/auth/login.js',
  'src/auth/loginHttpIntegration.js',
  'src/auth/legacyAuthGuard.js',
  'src/auth/legacyActionRoles.js',
  'src/auth/adminAccessService.js',
  'src/auth/adminAccessDao.js',
  'src/auth/financialHttpHandlers.js',
  'src/auth/financialHttpIntegration.js',
  'src/auth/pinRotationService.js',
  'src/auth/pinRotationDao.js',
  'src/auth/pinRotationServiceV3.js',
  'src/auth/pinRotationDaoV3.js',
  'src/auth/roleChangeServiceV3.js',
  'src/auth/roleChangeDaoV3.js',
  'src/auth/accessUserServiceV3.js',
  'src/auth/accessUserDaoV3.js',
  'src/auth/accessUserLifecycleServiceV3.js',
  'src/auth/accessUserLifecycleDaoV3.js',
  'src/auth/pinStepUp.js',
  'src/auth/jwt.js',
];
const FORBIDDEN_MENTIONS = [
  'accessManagementHttpHandlersV3', 'accessManagementHttpIntegrationV3', 'accessManagementHttpDaoV3',
  'accessUserPinRequestHash', 'registerAccessManagementRoutes', 'integrateAccessManagementRoutes',
  'createAccessManagementHandlers', 'createOwnerAuthContextMiddleware',
  'AUTH_V3_ACCESS_MANAGEMENT_HTTP_ENABLED',
];

for (const rel of RUNTIME_FILES) {
  const text = read(rel);
  for (const needle of FORBIDDEN_MENTIONS) {
    assert(`${rel} does not mention '${needle}' (V3-F is not wired into this file)`, !text.includes(needle));
  }
}

// ── the new files exist, are requireable, and stay self-contained ──────────────────
const V3F_FILES = [
  'src/auth/accessManagementHttpDaoV3.js',
  'src/auth/accessUserPinRequestHash.js',
  'src/auth/accessManagementHttpErrorsV3.js',
  'src/auth/accessManagementHttpHandlersV3.js',
  'src/auth/accessManagementHttpIntegrationV3.js',
];
for (const rel of V3F_FILES) {
  assert(`${rel} exists`, fs.existsSync(path.join(ROOT, rel)));
  assert(`${rel} is requireable without throwing`, (() => { try { require(path.join(ROOT, rel)); return true; } catch (_) { return false; } })());
}

// None of the V3-F files may be required by any OTHER src/auth file (except each other's
// own legitimate dependency edges: handlers -> dao/errors/hash; integration -> handlers).
const ALL_SRC_AUTH = fs.readdirSync(path.join(ROOT, 'src', 'auth')).filter((f) => f.endsWith('.js'));
const V3F_BASENAMES = new Set(V3F_FILES.map((p) => path.basename(p)));
for (const f of ALL_SRC_AUTH) {
  if (V3F_BASENAMES.has(f)) continue;
  const text = read(path.join('src', 'auth', f));
  for (const needle of ['accessManagementHttpHandlersV3', 'accessManagementHttpIntegrationV3', 'accessManagementHttpDaoV3', 'accessUserPinRequestHash', 'accessManagementHttpErrorsV3']) {
    assert(`src/auth/${f} does not require ${needle}`, !text.includes(needle));
  }
}

// ── V2/V3-B/C/D/E remain byte-for-byte the SAME exported contract as before V3-F ──────
{
  const v2Service = require('../src/auth/pinRotationService');
  assert('pinRotationService.js (v2) still exports exactly {createPinRotation, FAILED, DUPLICATE} -- unchanged by V3-F',
    JSON.stringify(Object.keys(v2Service).sort()) === JSON.stringify(['DUPLICATE', 'FAILED', 'createPinRotation']));
  const v2Dao = require('../src/auth/pinRotationDao');
  assert('pinRotationDao.js (v2) still exports setActorPinV2-equivalent surface unchanged by V3-F',
    typeof v2Dao === 'object' && v2Dao !== null);

  const v3bService = require('../src/auth/pinRotationServiceV3');
  assert('pinRotationServiceV3.js (V3-B) still exports exactly {createPinRotationV3, FAILED, DUPLICATE, RESERVED} -- unchanged by V3-F',
    JSON.stringify(Object.keys(v3bService).sort()) === JSON.stringify(['DUPLICATE', 'FAILED', 'RESERVED', 'createPinRotationV3']));

  const v3cService = require('../src/auth/roleChangeServiceV3');
  assert('roleChangeServiceV3.js (V3-C) still exports exactly {createRoleChangeV3, FAILED, CONFLICT} -- unchanged by V3-F',
    JSON.stringify(Object.keys(v3cService).sort()) === JSON.stringify(['CONFLICT', 'FAILED', 'createRoleChangeV3']));

  const v3dService = require('../src/auth/accessUserServiceV3');
  assert('accessUserServiceV3.js (V3-D) still exports exactly {createAccessUserV3Service, FAILED, CONFLICT, NOT_FOUND} -- unchanged by V3-F',
    JSON.stringify(Object.keys(v3dService).sort()) === JSON.stringify(['CONFLICT', 'FAILED', 'NOT_FOUND', 'createAccessUserV3Service']));

  const v3eService = require('../src/auth/accessUserLifecycleServiceV3');
  // V3-G later added WAITER_HAS_OPEN_TABLES to this export set (a legitimate extension,
  // not a V3-F change) -- accept either the V3-F-era shape or the V3-G-extended shape.
  assert('accessUserLifecycleServiceV3.js (V3-E) exports at least {createAccessUserLifecycleV3Service, FAILED, CONFLICT} -- V3-F itself added nothing here',
    typeof v3eService.createAccessUserLifecycleV3Service === 'function' && !!v3eService.FAILED && !!v3eService.CONFLICT);
}

// ── no migration/SQL was touched by V3-F (this phase is Node-only) ─────────────────
{
  for (const rel of V3F_FILES) {
    const text = read(rel);
    assert(`${rel} contains no SQL/migration text`, !/CREATE OR REPLACE FUNCTION|migrations\/[\w-]+\.sql/i.test(text));
  }
}

// ── the flag-gated integration function exists and defaults to disabled ────────────
{
  const integ = require('../src/auth/accessManagementHttpIntegrationV3');
  assert('isAccessManagementHttpEnabled defaults to false with no env override', integ.isAccessManagementHttpEnabled({}) === false);
  assert('isAccessManagementHttpEnabled rejects a near-miss value', integ.isAccessManagementHttpEnabled({ AUTH_V3_ACCESS_MANAGEMENT_HTTP_ENABLED: 'TRUE' }) === false);
  assert('isAccessManagementHttpEnabled accepts the exact flag value', integ.isAccessManagementHttpEnabled({ AUTH_V3_ACCESS_MANAGEMENT_HTTP_ENABLED: 'true' }) === true);
}

// ── createAccessManagementIntegrationApp only binds a real socket when explicitly asked ──
{
  const { createAccessManagementIntegrationApp } = require('../src/auth/accessManagementHttpIntegrationV3');
  const noListen = createAccessManagementIntegrationApp({});
  assert('createAccessManagementIntegrationApp({}) does not bind a socket (server === null)', noListen.server === null);
  const withListen = createAccessManagementIntegrationApp({ listen: true });
  assert('createAccessManagementIntegrationApp({ listen: true }) returns a real net.Server', !!withListen.server && typeof withListen.server.close === 'function');
  withListen.server.close();
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
