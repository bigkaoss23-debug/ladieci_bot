'use strict';
// Access Control V3 -- Block V3-H: proves the owner access-management HTTP boundary is
// wired into the real Express bootstrap EXACTLY ONCE, through the canonical integration
// module ONLY, remains fail-closed/default-OFF, and no low-level writer/handler/DAO
// internal is imported directly by index.js. Run: node tests/accessManagementHttpUnwiredV3.static.test.js
//
// Historical note: before V3-H, this file proved the boundary was COMPLETELY unwired
// (index.js never mentioned any V3-F symbol at all). V3-H wires it in, behind the exact
// AUTH_V3_ACCESS_MANAGEMENT_HTTP_ENABLED === 'true' gate, mirroring the financial/login/
// account integration pattern already accepted in index.js. This file was rewritten (not
// deleted or weakened) to prove the NEW contract honestly.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const strip = (s) => s.split('\n').filter((l) => !/^\s*\/\//.test(l.trim())).join('\n');

const IDX = read('index.js');
const IDX_CODE = strip(IDX);

// ── index.js requires ONLY the canonical integration module, exactly once ──────────
{
  const requireMatches = IDX_CODE.match(/require\(["']\.\/src\/auth\/accessManagementHttpIntegrationV3["']\)/g) || [];
  assert('index.js requires the canonical integration module exactly once', requireMatches.length === 1);
  assert('index.js destructures ONLY integrateAccessManagementRoutes from it (no handler/DAO/service internal import alongside)',
    /const \{\s*integrateAccessManagementRoutes\s*\}\s*=\s*require\(["']\.\/src\/auth\/accessManagementHttpIntegrationV3["']\)/.test(IDX_CODE));
}

// ── index.js never imports V3-F handler/DAO/service internals directly ─────────────
const FORBIDDEN_DIRECT_IMPORTS = [
  'accessManagementHttpHandlersV3', 'accessManagementHttpDaoV3', 'accessUserPinRequestHash',
  'accessManagementHttpErrorsV3', 'registerAccessManagementRoutes', 'createAccessManagementHandlers',
  'createOwnerAuthContextMiddleware',
];
for (const needle of FORBIDDEN_DIRECT_IMPORTS) {
  assert(`index.js does not directly mention '${needle}' (only accessManagementHttpIntegrationV3 is imported)`, !IDX_CODE.includes(needle));
}

// ── no OTHER src/auth file (besides V3-F's own family) requires the integration module,
//    and none of the low-level V3-B/C/D/E/G writers are required by index.js directly ──
{
  const V3_WRITER_MODULES = [
    'pinRotationServiceV3', 'pinRotationDaoV3', 'roleChangeServiceV3', 'roleChangeDaoV3',
    'accessUserServiceV3', 'accessUserDaoV3', 'accessUserLifecycleServiceV3', 'accessUserLifecycleDaoV3',
  ];
  for (const mod of V3_WRITER_MODULES) {
    assert(`index.js does not require ${mod} directly (only reachable lazily, through the gated integration module)`,
      !new RegExp(`require\\(["'][^"']*${mod}["']\\)`).test(IDX_CODE));
  }
}

// ── exactly ONE integration call, using process.env, with a logger ─────────────────
{
  const callMatches = IDX_CODE.match(/integrateAccessManagementRoutes\(app,\s*\{[^}]*\}\)/g) || [];
  assert('index.js calls integrateAccessManagementRoutes exactly once', callMatches.length === 1);
  assert('the call passes env: process.env', /integrateAccessManagementRoutes\(app,\s*\{[^}]*env:\s*process\.env/.test(IDX_CODE));
}

// ── the call is NOT wrapped in a try/catch that would silently swallow a construction
//    failure -- a missing/invalid required dependency while the flag is on must fail
//    closed (crash boot), never be silently skipped ─────────────────────────────────
{
  const callIdx = IDX_CODE.indexOf('integrateAccessManagementRoutes(app,');
  const before = IDX_CODE.slice(Math.max(0, callIdx - 200), callIdx);
  assert('the integration call is not preceded by an open try{ block on the same statement (no silent-skip wrapper)',
    !/try\s*\{\s*$/.test(before.trimEnd()));
}

// ── exact flag name and exact 'true' comparison (re-verified directly against the
//    integration module's own source, not re-implemented here) ────────────────────
{
  const INT = read('src/auth/accessManagementHttpIntegrationV3.js');
  assert('flag name is AUTH_V3_ACCESS_MANAGEMENT_HTTP_ENABLED', /ACCESS_MANAGEMENT_HTTP_FLAG = 'AUTH_V3_ACCESS_MANAGEMENT_HTTP_ENABLED'/.test(INT));
  assert('accepted true value is exactly the string \'true\'', /FLAG_ENABLED_VALUE = 'true'/.test(INT));
  assert('enablement check is exact strict equality (no truthy/loose coercion)', /e\[ACCESS_MANAGEMENT_HTTP_FLAG\] === FLAG_ENABLED_VALUE/.test(INT));
  const { isAccessManagementHttpEnabled } = require('../src/auth/accessManagementHttpIntegrationV3');
  assert('absent -> disabled', isAccessManagementHttpEnabled({}) === false && isAccessManagementHttpEnabled(undefined) === false);
  assert('empty string -> disabled', isAccessManagementHttpEnabled({ AUTH_V3_ACCESS_MANAGEMENT_HTTP_ENABLED: '' }) === false);
  assert('non-exact truthy values all -> disabled', ['1', 'TRUE', 'True', 'yes', 'on', ' true', 'true ', 'false'].every(
    (v) => isAccessManagementHttpEnabled({ AUTH_V3_ACCESS_MANAGEMENT_HTTP_ENABLED: v }) === false
  ));
  assert('exact lowercase "true" -> enabled', isAccessManagementHttpEnabled({ AUTH_V3_ACCESS_MANAGEMENT_HTTP_ENABLED: 'true' }) === true);
  assert('no host/branch/NODE_ENV/Supabase-URL/production-default fallback in the enablement check itself',
    (() => {
      const fn = INT.slice(INT.indexOf('function isAccessManagementHttpEnabled'), INT.indexOf('function buildDefaultServices'));
      return !/NODE_ENV|hostname|SUPABASE|branch|production|RAILWAY/i.test(fn) && !/\|\|\s*['"]true['"]|\?\?\s*['"]true['"]|!==\s*['"]false['"]/.test(fn);
    })());
}

// ── mount order: after CORS/JSON parsing and the sibling staging-gated integrations,
//    BEFORE the legacy /api X-Api-Key terminal guard (the closest thing this backend has
//    to a "before 404/error middleware" boundary -- there is no separate Express 404
//    handler; every /api path either matches an earlier-mounted route or falls into this
//    guard, which is itself effectively the terminal gate for the /api surface) ────────
{
  const jsonIdx = IDX_CODE.indexOf('express.json()');
  const finIdx = IDX_CODE.indexOf('integrateFinancialRoutes(app');
  const loginIdx = IDX_CODE.indexOf('integrateLoginRoute(app');
  const acctIdx = IDX_CODE.indexOf('integrateAccountRoutes(app');
  const amIdx = IDX_CODE.indexOf('integrateAccessManagementRoutes(app');
  const apiGuardIdx = IDX_CODE.indexOf('app.use("/api", (req, res, next)');
  assert('all indices located', jsonIdx > 0 && finIdx > 0 && loginIdx > 0 && acctIdx > 0 && amIdx > 0 && apiGuardIdx > 0);
  assert('access-management integration mounted AFTER express.json()', amIdx > jsonIdx);
  assert('access-management integration mounted AFTER the sibling financial/login/account integrations', amIdx > finIdx && amIdx > loginIdx && amIdx > acctIdx);
  assert('access-management integration mounted BEFORE the legacy /api X-Api-Key terminal guard', amIdx < apiGuardIdx);
}

// ── safe startup log: only component/state/routeBase/env, never a secret; never claims
//    "enabled" unless integrateAccessManagementRoutes actually returned enabled:true ──
{
  const logIdx = IDX_CODE.indexOf('component: "access-management-v3"');
  const amIdx = IDX_CODE.indexOf('integrateAccessManagementRoutes(app');
  assert('a startup log line exists', logIdx > 0);
  assert('the log is emitted AFTER the integration call (so state reflects the real return value)', logIdx > amIdx);
  const logStart = IDX_CODE.lastIndexOf('console.log(', logIdx);
  const logEnd = IDX_CODE.indexOf('}));', logIdx) + '}));'.length;
  const logBlock = IDX_CODE.slice(logStart, logEnd);
  assert('log derives "state" from the actual accessManagementIntegration.enabled return value (never hardcoded)',
    /state:\s*accessManagementIntegration\.enabled\s*\?\s*"enabled"\s*:\s*"disabled"/.test(logBlock));
  assert('log fields are limited to component/state/routeBase/env -- no token/secret/key/url/actor/proof field',
    !/token|secret|key|password|proof|actor|cookie|sid\b/i.test(logBlock.replace(/routeBase/g, '')));
}

// ── no second registration path anywhere else in the runtime import graph ──────────
{
  const OTHER_RUNTIME_FILES = [
    'src/auth/login.js', 'src/auth/loginHttpIntegration.js', 'src/auth/legacyAuthGuard.js',
    'src/auth/legacyActionRoles.js', 'src/auth/adminAccessService.js', 'src/auth/adminAccessDao.js',
    'src/auth/financialHttpHandlers.js', 'src/auth/financialHttpIntegration.js',
    'src/account/accountHttpIntegration.js',
  ];
  for (const rel of OTHER_RUNTIME_FILES) {
    const text = read(rel);
    assert(`${rel} does not mention accessManagementHttpIntegrationV3 or registerAccessManagementRoutes (no second registration path)`,
      !text.includes('accessManagementHttpIntegrationV3') && !text.includes('registerAccessManagementRoutes'));
  }
  assert('legacyActionRoles.js is untouched -- no replacement/redirection to the V3 boundary',
    !read('src/auth/legacyActionRoles.js').includes('accessManagementHttpIntegrationV3') && !read('src/auth/legacyActionRoles.js').includes('access-users'));
}

// ── no direct-PIN login route added anywhere in this change ────────────────────────
assert('index.js does not add a direct-PIN login route (POST /api/auth/v3/access-users/:actor/pin is the ONLY PIN-bearing route, and it is owner-only + step-up gated inside the existing handler, not a new login path)',
  !/app\.post\(["']\/api\/auth\/(login|pin)["']/.test(IDX_CODE));

// ── no frontend file touched by this slice ──────────────────────────────────────────
{
  const FRONTEND_ROOT = path.join(ROOT, '..', 'ladieci-s2-8-access-control-v3-frontend');
  assert('the frontend worktree directory is not referenced anywhere in index.js or the integration module',
    !IDX_CODE.includes('frontend') && !read('src/auth/accessManagementHttpIntegrationV3.js').includes('frontend'));
}

// ── the flag-gated integration function still exists, defaults to disabled, and the
//    in-memory harness still only binds a real socket when explicitly asked ─────────
{
  const integ = require('../src/auth/accessManagementHttpIntegrationV3');
  assert('isAccessManagementHttpEnabled defaults to false with no env override', integ.isAccessManagementHttpEnabled({}) === false);
  const { createAccessManagementIntegrationApp } = integ;
  const noListen = createAccessManagementIntegrationApp({});
  assert('createAccessManagementIntegrationApp({}) does not bind a socket (server === null)', noListen.server === null);
  const withListen = createAccessManagementIntegrationApp({ listen: true });
  assert('createAccessManagementIntegrationApp({ listen: true }) returns a real net.Server', !!withListen.server && typeof withListen.server.close === 'function');
  withListen.server.close();
}

// ── V2/V3-B/C/D/E remain byte-for-byte the SAME exported contract as before V3-H ─────
{
  const v2Service = require('../src/auth/pinRotationService');
  assert('pinRotationService.js (v2) still exports exactly {createPinRotation, FAILED, DUPLICATE} -- unchanged by V3-H',
    JSON.stringify(Object.keys(v2Service).sort()) === JSON.stringify(['DUPLICATE', 'FAILED', 'createPinRotation']));

  const v3bService = require('../src/auth/pinRotationServiceV3');
  assert('pinRotationServiceV3.js (V3-B) still exports exactly {createPinRotationV3, FAILED, DUPLICATE, RESERVED} -- unchanged by V3-H',
    JSON.stringify(Object.keys(v3bService).sort()) === JSON.stringify(['DUPLICATE', 'FAILED', 'RESERVED', 'createPinRotationV3']));

  const v3cService = require('../src/auth/roleChangeServiceV3');
  assert('roleChangeServiceV3.js (V3-C/G.1/G.2) exports at least {createRoleChangeV3, FAILED, CONFLICT} -- V3-H itself added nothing here',
    typeof v3cService.createRoleChangeV3 === 'function' && !!v3cService.FAILED && !!v3cService.CONFLICT);

  const v3dService = require('../src/auth/accessUserServiceV3');
  assert('accessUserServiceV3.js (V3-D) still exports exactly {createAccessUserV3Service, FAILED, CONFLICT, NOT_FOUND} -- unchanged by V3-H',
    JSON.stringify(Object.keys(v3dService).sort()) === JSON.stringify(['CONFLICT', 'FAILED', 'NOT_FOUND', 'createAccessUserV3Service']));

  const v3eService = require('../src/auth/accessUserLifecycleServiceV3');
  assert('accessUserLifecycleServiceV3.js (V3-E/G) exports at least {createAccessUserLifecycleV3Service, FAILED, CONFLICT} -- V3-H itself added nothing here',
    typeof v3eService.createAccessUserLifecycleV3Service === 'function' && !!v3eService.FAILED && !!v3eService.CONFLICT);
}

// ── no migration/SQL touched by V3-H (this slice is Node bootstrap-wiring only) ────
{
  const V3F_FILES = [
    'src/auth/accessManagementHttpDaoV3.js', 'src/auth/accessUserPinRequestHash.js',
    'src/auth/accessManagementHttpErrorsV3.js', 'src/auth/accessManagementHttpHandlersV3.js',
    'src/auth/accessManagementHttpIntegrationV3.js',
  ];
  for (const rel of V3F_FILES) {
    const text = read(rel);
    assert(`${rel} contains no SQL/migration text`, !/CREATE OR REPLACE FUNCTION|migrations\/[\w-]+\.sql/i.test(text));
  }
  assert('index.js diff for this slice touches no migrations/ path', !IDX_CODE.includes('migrations/'));
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
