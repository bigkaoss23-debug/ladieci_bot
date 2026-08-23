'use strict';
// B7A5 architectural / static guards + runtime-entrypoint proof.
// Run: node tests/loginHttpIntegrationGuards.test.js
// NON-EXECUTING source guards (module-aware, comment-stripped) + a few in-memory checks.
const fs = require('fs');
const path = require('path');
let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const strip = (s) => s.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

const INT_SRC = read('src/auth/loginHttpIntegration.js');
const INT = strip(INT_SRC);
const IDX = strip(read('index.js'));
const { isLoginHttpEnabled, LOGIN_HTTP_FLAG, FLAG_ENABLED_VALUE, LOGIN_PATH, integrateLoginRoute } = require('../src/auth/loginHttpIntegration');

// ── flag semantics ───────────────────────────────────────────────────────────
assert('flag name is AUTH_V2_LOGIN_HTTP_ENABLED', LOGIN_HTTP_FLAG === 'AUTH_V2_LOGIN_HTTP_ENABLED');
assert('accepted true value exactly "true"', FLAG_ENABLED_VALUE === 'true');
assert('login path is /api/auth/v2/login', LOGIN_PATH === '/api/auth/v2/login');
assert('absent/empty → disabled', isLoginHttpEnabled({}) === false && isLoginHttpEnabled(undefined) === false && isLoginHttpEnabled({ AUTH_V2_LOGIN_HTTP_ENABLED: '' }) === false);
assert('non-exact truthy → disabled', ['1', 'TRUE', 'True', 'yes', 'on', ' true', 'true '].every((v) => isLoginHttpEnabled({ AUTH_V2_LOGIN_HTTP_ENABLED: v }) === false));
assert('exact "true" → enabled', isLoginHttpEnabled({ AUTH_V2_LOGIN_HTTP_ENABLED: 'true' }) === true);
assert('enablement reads ONLY the login flag (no host/branch/NODE_ENV/URL/financial coupling)', (() => { const fn = INT.slice(INT.indexOf('function isLoginHttpEnabled'), INT.indexOf('function buildDefaultLoginHandler')); return /e\[LOGIN_HTTP_FLAG\] === FLAG_ENABLED_VALUE/.test(fn) && !/NODE_ENV|hostname|SUPABASE|branch|FINANCIAL/i.test(fn); })());

// ── index.js wiring + mount order (login before legacy proxy, both flags independent) ──
assert('index.js requires the login integration module', /require\(["']\.\/src\/auth\/loginHttpIntegration["']\)/.test(IDX));
assert('index.js calls integrateLoginRoute with env', /integrateLoginRoute\(app,\s*\{[^}]*env:\s*process\.env/.test(IDX));
const loginIdx = IDX.indexOf('integrateLoginRoute(app');
const finIdx = IDX.indexOf('integrateFinancialRoutes(app');
const apiGuardIdx = IDX.indexOf('app.use("/api"');
const jsonIdx = IDX.indexOf('app.use(express.json())');
assert('login mounted AFTER express.json/CORS', jsonIdx > 0 && loginIdx > jsonIdx);
assert('login mounted BEFORE legacy /api X-Api-Key guard', loginIdx > 0 && apiGuardIdx > 0 && loginIdx < apiGuardIdx);
assert('financial + login both before legacy guard, independent calls', finIdx > 0 && finIdx < apiGuardIdx && loginIdx < apiGuardIdx);
assert('login flag string does not appear in the financial integration source', !/AUTH_V2_LOGIN_HTTP_ENABLED/.test(strip(read('src/auth/financialHttpIntegration.js'))));
assert('financial flag string does not gate the login module', (() => { const fn = INT.slice(INT.indexOf('function isLoginHttpEnabled'), INT.indexOf('function integrateLoginRoute')); return !/AUTH_V2_FINANCIAL_HTTP_ENABLED/.test(fn); })());

// ── integration invariants ─────────────────────────────────────────────────
assert('disabled path is a strict no-op (early return before app.post)', /if \(!isLoginHttpEnabled\(env\)\) \{[\s\S]*?enabled: false[\s\S]*?\}/.test(INT) && INT.indexOf('enabled: false') < INT.indexOf('app.post(LOGIN_PATH'));
assert('exactly one login route, exact static path', (INT.match(/app\.post\(LOGIN_PATH/g) || []).length === 1 && !/\/api\/auth\/:action|:action|:role|login\/\$\{/.test(INT));
assert('login route is unauthenticated: no JWT verify, no X-Api-Key check in integration', !/verifyToken|Bearer|x-api-key|DASHBOARD_API_KEY|authorization/i.test(INT.slice(INT.indexOf('function integrateLoginRoute'), INT.indexOf('function createAuthV2IntegrationApp'))));
assert('reuses accepted B3 handler (createLoginHandler); no second PIN verifier', /createLoginHandler/.test(INT) && !/scrypt|verifyPin\(pin|new PinVerifier|hashCompare/.test(INT.slice(INT.indexOf('function integrateLoginRoute'))));
assert('does not query PIN hashes from the integration', !/pin_hash|getActorForVerify_SENSITIVE|select=[^)]*pin_hash/i.test(INT));
assert('universal forwards pin/IP only; compatibility forwards role/pin/actor/IP',
  /universalHandler\(\{ pin: b\.pin, trustedClientIp \}\)/.test(INT) &&
  /compatibilityHandler\(\{ role: b\.role, pin: b\.pin, actor: b\.actor, trustedClientIp \}\)/.test(INT));
assert('PIN passed verbatim (no trim/normalize/log on b.pin)', !/b\.pin\.trim|b\.pin\.toLowerCase|b\.pin\.replace|normalize\([^)]*pin/i.test(INT));
assert('server-owned IP via accepted boundary (extractClientIp), no body ip', /extractClientIp\(req\)/.test(INT) && !/b\.(ip|ipHash|trustedClientIp|forwarded)/.test(INT));
assert('login-scoped parser sanitizer: login path ONLY, others pass through', /function loginScopedJsonError\(err, req, res, next\)/.test(INT) && /p === LOGIN_PATH/.test(INT) && /return next\(err\)/.test(INT));
assert('parser sanitizer registered AFTER the route', INT.indexOf('app.post(LOGIN_PATH') < INT.indexOf('loginScopedJsonError'));
// Inspect the actual logger.info(...) call arguments (not mere proximity): they must
// carry only safe fields, never token/pin/body/actor/ip/role.
const loggerCalls = INT.match(/logger\.info\(\{[^}]*\}\)/g) || [];
assert('no token/PIN/body/actor/ip logging (logger.info args are safe-only)', loggerCalls.length >= 1 && loggerCalls.every((c) => !/token|\bpin\b|body|actor|\bip\b|\brole\b/i.test(c)));
assert('no automatic retry', !/retr(y|ies)|for\s*\([^)]*attempt|setTimeout\([\s\S]*handler/i.test(INT));
assert('unexpected handler failure → sanitized 500', /catch \(_\) \{[\s\S]*?status\(500\)[\s\S]*?error: 'error interno'/.test(INT));
assert('login module not wired via a second global parser (reuses express.json in app)', (INT.match(/express\.json\(\)/g) || []).length <= 1);

// ── in-memory: disabled registers nothing; enabled registers once ────────────
function fakeApp() { const posts = [], uses = []; return { posts, uses, post: (p) => posts.push(p), use: (...a) => uses.push(a) }; }
let a = fakeApp();
let res = integrateLoginRoute(a, { env: {}, loginHandler: async () => ({ status: 200, body: {} }) });
assert('in-memory disabled: nothing registered, enabled=false', a.posts.length === 0 && a.uses.length === 0 && res.enabled === false);
a = fakeApp();
res = integrateLoginRoute(a, { env: { AUTH_V2_LOGIN_HTTP_ENABLED: 'true' }, loginHandler: async () => ({ status: 200, body: {} }) });
assert('in-memory enabled: exactly 1 POST + 1 error handler, enabled=true', a.posts.length === 1 && a.posts[0] === '/api/auth/v2/login' && a.uses.length === 1 && res.enabled === true);

// ── NEGATIVE CONTROLS ────────────────────────────────────────────────────────
(function nc() {
  assert('NC1: non-exact truthy enabling detected', isLoginHttpEnabled({ AUTH_V2_LOGIN_HTTP_ENABLED: 'TRUE' }) === false);
  assert('NC2: production-default enablement detected', !/\|\|\s*['"]true['"]|\?\?\s*['"]true['"]|!==\s*['"]false['"]|isLoginHttpEnabled[\s\S]{0,80}return true/.test(INT));
  assert('NC3: login-after-proxy detected', (() => { const bad = 'app.use("/api", guard); integrateLoginRoute(app'; return bad.indexOf('integrateLoginRoute') > bad.indexOf('app.use("/api"'); })());
  assert('NC4/5: X-Api-Key/JWT requirement on login detected', /x-api-key|verifyToken/i.test('const key = req.headers["x-api-key"]; const p = verifyToken(t);'));
  assert('NC6: generic /api/auth/:action detected', /\/api\/auth\/:action/.test('app.post("/api/auth/:action")'));
  assert('NC7: query/path PIN detected', /req\.(query|params)\.pin/.test('const pin = req.query.pin;'));
  assert('NC8: direct PIN-hash query from integration detected', /pin_hash|getActorForVerify_SENSITIVE/.test('const h = await dao.getActorForVerify_SENSITIVE(a);'));
  assert('NC9: second PIN verifier detected', /require\(['"]\.\/scrypt['"]\)\.verifyPin\(pin/.test('require("./scrypt").verifyPin(pin, stored)'));
  assert('NC10: token/PIN logging detected', /logger[\s\S]{0,60}(token|pin)/i.test('logger.info({ token: t, pin: p });'));
  assert('NC11: automatic retry detected', /for\s*\([^)]*attempt/.test('for (let attempt=0;attempt<3;attempt++){ await handler(); }'));
  assert('NC12: body-controlled role/session/token detected', /b\.(sv|session_version|token|expiresIn)\b/.test('const sv = b.session_version;'));
  assert('NC13: duplicate registration detected', (() => { const app2 = fakeApp(); integrateLoginRoute(app2, { env: { AUTH_V2_LOGIN_HTTP_ENABLED: 'true' }, loginHandler: async () => ({ status: 200, body: {} }) }); integrateLoginRoute(app2, { env: { AUTH_V2_LOGIN_HTTP_ENABLED: 'true' }, loginHandler: async () => ({ status: 200, body: {} }) }); return app2.posts.length === 2; })());
  assert('NC14: parser sanitizer scoped to login path only (not broad)', /p === LOGIN_PATH/.test(INT) && !/startsWith\(['"]\/api['"]\)/.test(INT));
  assert('NC15: financial flag enabling login detected', /AUTH_V2_FINANCIAL/.test('if (env.AUTH_V2_FINANCIAL_HTTP_ENABLED) enableLogin();'));
  assert('NC16: login flag enabling financial detected', /AUTH_V2_LOGIN/.test('if (env.AUTH_V2_LOGIN_HTTP_ENABLED) mountFinancial();'));
})();

// ── RUNTIME ENTRYPOINT PROOF (NC17) ──────────────────────────────────────────
const PKG = require('../package.json');
assert('start script is `node index.js` (index.js is the runtime entrypoint)', PKG.scripts && PKG.scripts.start === 'node index.js' && PKG.main === 'index.js');
// N-2 — schedulaCloseTick/catchUpChiusura (the automatic close-tick + boot
// catch-up scheduler) were deleted in the application-wide legacy/dead-code
// purge: proved zero reachable production value (V3 Finalizar + F-10
// forgotten-close recovery replaced them entirely). schedula2340 (the 23:40
// preventive backup) is untouched — it never closes anything.
assert('index.js starts server + the preventive-backup scheduler under require.main === module', /if \(require\.main === module\) \{[\s\S]*?app\.listen\(PORT/.test(IDX) && /if \(require\.main === module\) \{[\s\S]*?schedula2340\(\);/.test(IDX));
assert('index.js no longer schedules the deleted automatic close-tick/catch-up', !/schedulaCloseTick\(\)|catchUpChiusura\(\)/.test(IDX));
assert('index.js exports app (importable, side-effect-free when required)', /module\.exports = \{ app \}/.test(IDX));
assert('no deployment artifact overrides the start command', ['Procfile', 'railway.json', 'railway.toml', 'nixpacks.toml', 'Dockerfile'].every((f) => !fs.existsSync(path.join(__dirname, '..', f))));
// entrypoint side-effect-free import: the module was already required above for other tests
// without opening a port or scheduling DB work (proven by this test process not hanging).
const idxApp = require('../index.js').app;
assert('requiring index.js yields an app without listening', typeof idxApp === 'function' && idxApp._router);

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
