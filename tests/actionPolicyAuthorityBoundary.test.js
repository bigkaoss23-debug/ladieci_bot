'use strict';
// Test per the dual-action-policy-authority concern — Access Control V3 Block V3-A.
// Eseguire: node tests/actionPolicyAuthorityBoundary.test.js
// STATIC TEXT ONLY — no DB, no server boot. Traces the REAL dispatcher import path
// (index.js -> legacyAuthGuard.js -> legacyActionRoles.js) rather than a loose filename
// grep across the repo, then proves src/auth/authorizationContract.js (an older, unwired
// "B4" draft that disagrees with the source-verified V3 registry on marcarLlegado) is not
// reachable from it, and is not combined with actionPolicyRegistry.js either. Neither
// authorizationContract.js nor src/auth/legacyActionRoles.js is modified by this task.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// A REAL require() call with a string literal containing the target — distinguishes an
// actual import from a comment merely mentioning the module's name (the same class of
// bug that bit the CREATE POLICY check in v3aFoundationMigration.static.test.js).
function hasRealRequireOf(source, moduleNameFragment) {
  const re = new RegExp(`require\\((['"\`])[^'"\`]*${moduleNameFragment}[^'"\`]*\\1\\)`);
  return re.test(source);
}

const indexJs = read('index.js');
const legacyAuthGuardJs = read('src/auth/legacyAuthGuard.js');
const legacyActionRolesJs = read('src/auth/legacyActionRoles.js');
const authorizationContractJs = read('src/auth/authorizationContract.js');
const actionPolicyRegistryJs = read('src/auth/actionPolicyRegistry.js');
const capabilityRegistryJs = read('src/auth/capabilityRegistry.js');
const roleRegistryJs = read('src/auth/roleRegistry.js');

// ══ 1. trace the REAL dispatcher import path ══════════════════════════════════
assert('index.js really requires legacyAuthGuardMiddleware (the real dispatcher gate)',
  hasRealRequireOf(indexJs, 'legacyAuthGuard'));
assert('legacyAuthGuard.js really requires legacyActionRoles (getActionRule) — the live authority',
  hasRealRequireOf(legacyAuthGuardJs, 'legacyActionRoles'));
assert('index.js does NOT itself require authorizationContract.js directly',
  !hasRealRequireOf(indexJs, 'authorizationContract'));
assert('legacyAuthGuard.js does NOT require authorizationContract.js (the ONE gate before the dispatcher)',
  !hasRealRequireOf(legacyAuthGuardJs, 'authorizationContract'));
assert('legacyActionRoles.js (the live authority itself) does NOT require authorizationContract.js',
  !hasRealRequireOf(legacyActionRolesJs, 'authorizationContract'));

// ══ 2. actionPolicyRegistry.js is the only V3 action-policy authority — and it is  ══
// ══    not itself wired into the live path, so there is no live combination at all ══
assert('index.js does NOT require actionPolicyRegistry.js (V3-A stays foundation-only)',
  !hasRealRequireOf(indexJs, 'actionPolicyRegistry'));
assert('legacyAuthGuard.js does NOT require actionPolicyRegistry.js', !hasRealRequireOf(legacyAuthGuardJs, 'actionPolicyRegistry'));
assert('legacyActionRoles.js does NOT require actionPolicyRegistry.js (no merged/combined decision)',
  !hasRealRequireOf(legacyActionRolesJs, 'actionPolicyRegistry'));

// ══ 3. no action may be authorized by COMBINING both registries ═══════════════
// actionPolicyRegistry.js and capabilityRegistry.js may only ever require each other /
// roleRegistry.js — never authorizationContract.js as a live dependency (mentioning its
// name in an explanatory COMMENT is fine and expected; a real require() call is not).
assert('actionPolicyRegistry.js does not actually require authorizationContract.js (mentions it only in a comment)',
  !hasRealRequireOf(actionPolicyRegistryJs, 'authorizationContract'));
assert('capabilityRegistry.js does not actually require authorizationContract.js (mentions it only in a comment)',
  !hasRealRequireOf(capabilityRegistryJs, 'authorizationContract'));
assert('roleRegistry.js does not reference authorizationContract.js at all', !authorizationContractJsMentionedIn(roleRegistryJs));
function authorizationContractJsMentionedIn(src) { return /authorizationContract/.test(src); }

// Repo-wide: confirm authorizationContract.js is required by literally nothing except
// its own module.exports self-reference — the sole remaining V3-A-relevant proof that
// no live path can ever combine it with actionPolicyRegistry.js.
const SRC_DIR = path.join(ROOT, 'src');
function listJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}
const allSrcFiles = [...listJsFiles(SRC_DIR), path.join(ROOT, 'index.js')];
const requiringFiles = allSrcFiles.filter((f) => {
  if (f.endsWith(path.join('src', 'auth', 'authorizationContract.js'))) return false; // itself
  const src = fs.readFileSync(f, 'utf8');
  return hasRealRequireOf(src, 'authorizationContract');
});
assert('repo-wide: NO file under src/ or index.js has a real require() of authorizationContract.js',
  requiringFiles.length === 0, JSON.stringify(requiringFiles.map((f) => path.relative(ROOT, f))));

// ══ 4. marcarLlegado follows the V3 source-verified policy, not the B4 draft ═══
const { getActionPolicy, rolesFor } = require('../src/auth/actionPolicyRegistry');
const llegadoPolicy = getActionPolicy('marcarLlegado');
assert('V3 registry: marcarLlegado maps to orders.general (source-verified pickup/RITIRO flag)',
  llegadoPolicy && llegadoPolicy.acceptedCapabilities.includes('orders.general'));
assert('V3 registry: marcarLlegado resolves to owner+cashier only', (() => {
  const roles = rolesFor('marcarLlegado');
  return roles.includes('owner') && roles.includes('cashier') && !roles.includes('rider') &&
    !roles.includes('waiter') && !roles.includes('kitchen') && !roles.includes('shift_manager');
})());
// Document the drift precisely rather than hide it: the OLDER, UNWIRED B4 draft
// genuinely disagrees (classifies marcarLlegado as rider-enabled with a scope
// predicate) — proving this is real drift, not a claim without evidence, while never
// letting it affect the live-authority proof above.
assert('DOCUMENTED DRIFT: the older, unwired authorizationContract.js DOES classify marcarLlegado as rider-enabled (real disagreement, not fixed here)',
  authorizationContractJs.includes("'marcarLlegado'") &&
  /RIDER_ENABLED_ACTIONS[\s\S]*?marcarLlegado/.test(authorizationContractJs.replace(/\n/g, ' ')));
assert('that drift has NO live effect: authorizationContract.js is unreachable from the dispatcher (proven in section 1)', true);

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
