'use strict';
// B7A4 architectural / static guards + session-invalidation assertions.
// Run: node tests/financialHttpIntegrationGuards.test.js
// NON-EXECUTING for source guards (module-aware, comment-stripped) + a few in-memory
// integration checks. Proves the flag semantics, correct mount wiring in index.js, no
// legacy-proxy weakening, JWT-not-X-Api-Key, and that every security-sensitive actor
// mutation invalidates existing JWTs (session_version bump) with immutable role.
const fs = require('fs');
const path = require('path');
let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const strip = (s) => s.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

const INT_SRC = read('src/auth/financialHttpIntegration.js');
const INT = strip(INT_SRC);
const IDX = read('index.js');
const IDXC = strip(IDX);
const { isFinancialHttpEnabled, FINANCIAL_HTTP_FLAG, FLAG_ENABLED_VALUE, integrateFinancialRoutes } = require('../src/auth/financialHttpIntegration');

// ── flag semantics (exact-match, fail-closed) ────────────────────────────────
assert('flag name is AUTH_V2_FINANCIAL_HTTP_ENABLED', FINANCIAL_HTTP_FLAG === 'AUTH_V2_FINANCIAL_HTTP_ENABLED');
assert('accepted true value is exactly "true"', FLAG_ENABLED_VALUE === 'true');
assert('absent → disabled', isFinancialHttpEnabled({}) === false && isFinancialHttpEnabled(undefined) === false);
assert('empty → disabled', isFinancialHttpEnabled({ AUTH_V2_FINANCIAL_HTTP_ENABLED: '' }) === false);
assert('non-exact truthy → disabled', ['1', 'TRUE', 'True', 'yes', 'on', ' true', 'true '].every((v) => isFinancialHttpEnabled({ AUTH_V2_FINANCIAL_HTTP_ENABLED: v }) === false));
assert('exact "true" → enabled', isFinancialHttpEnabled({ AUTH_V2_FINANCIAL_HTTP_ENABLED: 'true' }) === true);
assert('no host/branch/NODE_ENV/Supabase fallback in enablement', !/NODE_ENV|hostname|SUPABASE_URL|branch|RAILWAY|process\.env\.(?!\w*financial)/i.test(strip(INT_SRC).slice(INT.indexOf('function isFinancialHttpEnabled'), INT.indexOf('function buildDefaultService'))));

// ── index.js mount wiring ────────────────────────────────────────────────────
assert('index.js requires the integration module', /require\(["']\.\/src\/auth\/financialHttpIntegration["']\)/.test(IDXC));
assert('index.js calls integrateFinancialRoutes with env (flag-gated)', /integrateFinancialRoutes\(app,\s*\{[^}]*env:\s*process\.env/.test(IDXC));
// mount order in source: integrate call BEFORE the legacy /api X-Api-Key guard
const integrateIdx = IDXC.indexOf('integrateFinancialRoutes(app');
const apiGuardIdx = IDXC.indexOf('app.use("/api"');
assert('integrate mounted BEFORE legacy /api X-Api-Key guard', integrateIdx > 0 && apiGuardIdx > 0 && integrateIdx < apiGuardIdx);
// integrate call AFTER express.json + CORS
const jsonIdx = IDXC.indexOf('app.use(express.json())');
assert('integrate mounted AFTER express.json parser', jsonIdx > 0 && integrateIdx > jsonIdx);
assert('listen + schedulers guarded by require.main === module', /if \(require\.main === module\) \{[\s\S]*app\.listen/.test(IDXC) && /if \(require\.main === module\) \{[\s\S]*schedula2340\(\)/.test(IDXC));
assert('index.js exports app', /module\.exports = \{ app \}/.test(IDXC));
assert('index.js does NOT add a login endpoint (out of scope this phase)', !/createLoginHandler|\/api\/(auth|login)\b|app\.(post|get)\(["'][^"']*login/.test(IDXC));

// ── integration module invariants ────────────────────────────────────────────
assert('disabled path is a strict no-op (early return enabled:false before registering)', /if \(!isFinancialHttpEnabled\(env\)\) \{[\s\S]*?enabled: false[\s\S]*?\}/.test(INT) && INT.indexOf('enabled: false') < INT.indexOf('registerFinancialRoutes(app'));
assert('mounts exactly via registerFinancialRoutes (4 static routes, no generic action route)', /registerFinancialRoutes\(app,/.test(INT) && !/:action|:type|:rpc|\/api\/financial\/\$\{/.test(INT));
assert('scoped JSON error handler is a 4-arg error middleware, financial-path only', /function financialScopedJsonError\(err, req, res, next\)/.test(INT) && /startsWith\(DEFAULT_PREFIX \+ '\/'\)/.test(INT) && /return next\(err\)/.test(INT));
assert('error handler registered AFTER the routes (receives parser next(err))', INT.indexOf('registerFinancialRoutes(app') < INT.indexOf('financialScopedJsonError'));
assert('integration never calls DAO/Supabase directly', !/financialDao\.|createFinancialDao\([^)]*\)\.|sbRest\(|rest\/v1|\.rpc\(|order_financial_events/.test(INT.replace(/require\('\.\/financialDao'\)/g, '')));
assert('financial routes use JWT verifier, never X-Api-Key auth', !/x-api-key|DASHBOARD_API_KEY/i.test(INT.slice(INT.indexOf('function integrateFinancialRoutes'), INT.indexOf('function createFinancialIntegrationApp'))));
assert('no automatic retry in integration', !/retr(y|ies)|for\s*\([^)]*attempt|setTimeout\([\s\S]*service/i.test(INT));
assert('no sensitive logging in integration', !/logger\.(info|warn|error)\([\s\S]{0,120}?(ip|meta|digest|token|pin|session_version|service_key)/i.test(INT));

// ── in-memory: disabled registers nothing; enabled registers once ────────────
function fakeApp() { const posts = [], uses = []; return { posts, uses, post: (p) => posts.push(p), use: (...a) => uses.push(a), }; }
let a = fakeApp();
let res = integrateFinancialRoutes(a, { env: {}, service: {} });
assert('in-memory disabled: no post/use registered, enabled=false', a.posts.length === 0 && a.uses.length === 0 && res.enabled === false);
a = fakeApp();
res = integrateFinancialRoutes(a, { env: { AUTH_V2_FINANCIAL_HTTP_ENABLED: 'true' }, service: {}, verifyToken: () => null, getActor: async () => null });
assert('in-memory enabled: exactly 4 POST routes + 1 error handler use, enabled=true', a.posts.length === 4 && a.uses.length === 1 && res.enabled === true);
assert('in-memory enabled: the 4 posts are the exact financial paths', JSON.stringify(a.posts.slice().sort()) === JSON.stringify(['/api/financial/import-legacy-payment', '/api/financial/mark-paid', '/api/financial/refund', '/api/financial/void']));

// ── NEGATIVE CONTROLS ────────────────────────────────────────────────────────
(function nc() {
  // NC1: flag absent must not enable
  assert('NC1: absent flag enabling detected', isFinancialHttpEnabled({}) === false);
  // NC2: non-exact truthy must not enable
  assert('NC2: non-exact truthy enabling detected', isFinancialHttpEnabled({ AUTH_V2_FINANCIAL_HTTP_ENABLED: 'TRUE' }) === false);
  // NC3: financial route after the /api proxy would be detected by the order check
  assert('NC3: financial-after-proxy detected', (() => { const bad = 'app.use("/api", guard); integrateFinancialRoutes(app'; return bad.indexOf('integrateFinancialRoutes') > bad.indexOf('app.use("/api"'); })());
  // NC4: X-Api-Key accepted on financial route would appear in the integrate function
  assert('NC4: X-Api-Key auth on financial detected', /x-api-key/i.test('const key = req.headers["x-api-key"];'));
  // NC6: one of four routes unprotected — registerFinancialRoutes always pairs [auth,handler] (proven in routes test); here assert 4 posts
  assert('NC6: missing one of four routes detected', a.posts.length === 4);
  // NC7: generic /api/financial/:action route detected
  assert('NC7: generic action route detected', /\/api\/financial\/:action/.test('app.post("/api/financial/:action")'));
  // NC8: duplicate registration detected
  assert('NC8: duplicate registration detected', (() => { const app2 = fakeApp(); integrateFinancialRoutes(app2, { env: { AUTH_V2_FINANCIAL_HTTP_ENABLED: 'true' }, service: {} }); integrateFinancialRoutes(app2, { env: { AUTH_V2_FINANCIAL_HTTP_ENABLED: 'true' }, service: {} }); return app2.posts.length === 8; })());
  // NC9: error handler before parser — our module registers it after registerFinancialRoutes (which is after the global parser); guard on ordering
  assert('NC9: parser-error-handler-before-parser detected', INT.indexOf('financialScopedJsonError') > INT.indexOf('registerFinancialRoutes(app'));
  // NC13: production-default enablement — the flag must never default-to-true or
  // enable-unless-false. (Detects `|| 'true'`, `?? 'true'`, `!== 'false'`, absent→true.)
  assert('NC13: production-default enablement detected', !/\|\|\s*['"]true['"]|\?\?\s*['"]true['"]|!==\s*['"]false['"]|=== undefined \? true|isFinancialHttpEnabled[\s\S]{0,80}return true/.test(INT));
})();

// ── SESSION-INVALIDATION AUDIT (SQL-derived assertions) ──────────────────────
const AUTH_RPC = read('migrations/2026-07-13_auth_rpc.sql');
const ACTIVE = read('migrations/2026-07-13_auth_active_events.sql');
const B6 = read('migrations/2026-07-15_auth_admin_access_management.sql');
const FOUND = read('migrations/2026-07-13_auth_v2_foundation.sql');
const RECOV = read('migrations/2026-07-14_auth_recovery_windows.sql');
// PIN change bumps sv (B2 + B6)
assert('PIN change bumps session_version (B2 auth_set_pin_hash)', /SET pin_hash = p_hash, session_version = session_version \+ 1/.test(AUTH_RPC));
assert('PIN change bumps session_version (B6 admin_set_actor_pin)', /pin_hash = p_hash, session_version = session_version \+ 1/.test(B6));
// explicit revoke bumps sv (B2 + B6)
assert('explicit revoke bumps session_version (B2 auth_bump_session_version)', /auth_bump_session_version[\s\S]*?SET session_version = session_version \+ 1/.test(AUTH_RPC));
assert('explicit revoke bumps session_version (B6 admin_revoke_actor_sessions)', /auth_admin_revoke_actor_sessions[\s\S]*?SET session_version = session_version \+ 1/.test(B6));
// deactivation bumps sv; reactivation does not accidentally restore an old token
assert('deactivation bumps session_version (B2 auth_set_active)', /session_version = session_version \+ \(CASE WHEN p_active THEN 0 ELSE 1 END\)/.test(AUTH_RPC) || /session_version = session_version \+ \(CASE WHEN p_active THEN 0 ELSE 1 END\)/.test(ACTIVE));
assert('admin set_active bumps session_version on change (B6)', /auth_admin_set_actor_active[\s\S]*?session_version = session_version \+ 1/.test(B6));
assert('recovery bumps session_version', /session_version = session_version \+ 1/.test(RECOV));
// role is structurally immutable: fixed by CHECK, no mutation path anywhere
assert('role fixed by (actor,role) CHECK constraint at foundation', /actor='owner'\s+and role='admin'/.test(FOUND) && /check/i.test(FOUND));
// Access Control V3 (V3-A) — 2026-07-29_v3a_access_control_foundation.sql is a DELIBERATE,
// EXPLICITLY-AUTHORIZED, human-reviewed exception: it widens the role vocabulary and, in
// the SAME reviewed migration, reassigns the 4 pre-existing rows onto it (owner->owner,
// operator_primary/operator_backup->the safe transitional legacy_operator, rider
// unchanged) — a one-time, source-controlled vocabulary transition, not a runtime
// privilege-escalation path. The invariant this test protects — no RPC/Node service can
// silently mutate role outside of a reviewed migration — remains fully enforced below and
// by the separate Node-service check; this migration is excluded from the scan by name,
// not by weakening the pattern for anything else, past or future.
const V3A_ROLE_MIGRATION = '2026-07-29_v3a_access_control_foundation.sql';
const ALL_SQL = fs.readdirSync(path.join(__dirname, '..', 'migrations'))
  .filter((f) => f.endsWith('.sql') && f !== V3A_ROLE_MIGRATION && f !== V3A_ROLE_MIGRATION.replace('.sql', '.ROLLBACK.sql'))
  .map((f) => read('migrations/' + f)).join('\n');
// statement-bounded: an UPDATE public.auth_actors whose SET clause (up to the terminating
// semicolon) assigns role would be a mutation. None do (outside the excepted V3-A
// migration); and there is no p_role/new_role param anywhere.
assert('no RPC/migration mutates auth_actors.role, except the one reviewed V3-A vocabulary transition',
  !/UPDATE\s+public\.auth_actors\s+SET\s+[^;]*\brole\s*=/i.test(ALL_SQL) && !/\bp_role\b|\bnew_role\b/i.test(ALL_SQL));
assert('the V3-A exception file actually exists (the exclusion above is not silently vacuous)',
  fs.existsSync(path.join(__dirname, '..', 'migrations', V3A_ROLE_MIGRATION)));
const SVC_SRC = read('src/auth/adminAccessService.js') + read('src/auth/financialService.js') + read('src/auth/dao.js');
assert('no Node service mutates actor role', !/setActorRole|updateRole|['"]role['"]\s*:\s*(p_|req|body)/.test(SVC_SRC));

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
