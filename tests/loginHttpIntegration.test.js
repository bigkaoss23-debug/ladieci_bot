'use strict';
// B7A5 real-application Auth V2 login-route integration tests.
// Run: node tests/loginHttpIntegration.test.js
// Offline: drives the REAL Express stack (createAuthV2IntegrationApp harness + the real
// index.js app) via in-memory request injection — NO network port, NO DB, injected login
// handler. Proves the flag gate, exact route, field mapping, success/error passthrough,
// JWT/X-Api-Key independence, mount order before the legacy proxy, parser/CORS, and
// login/financial flag independence.
const http = require('http');
const { Socket } = require('net');
let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

const { createAuthV2IntegrationApp, LOGIN_PATH } = require('../src/auth/loginHttpIntegration');

function inject(app, { method = 'GET', url = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve) => {
    const req = new http.IncomingMessage(new Socket());
    req.method = method; req.url = url; req.headers = {};
    for (const k of Object.keys(headers)) req.headers[k.toLowerCase()] = headers[k];
    if (body != null && req.headers['content-length'] === undefined) req.headers['content-length'] = String(Buffer.byteLength(body));
    const res = new http.ServerResponse(req);
    const chunks = [];
    res.write = (c) => { if (c) chunks.push(Buffer.from(c)); return true; };
    res.end = (c) => { if (c) chunks.push(Buffer.from(c)); const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch (_) {} resolve({ status: res.statusCode, text, json }); };
    app(req, res);
    if (body != null) req.push(Buffer.from(body));
    req.push(null);
  });
}
function fakeLogin(behavior = {}) {
  const calls = [];
  const handler = async (args) => { calls.push(args); if (behavior.throw) throw behavior.throw; if (behavior.out) return behavior.out; return { status: 200, body: { token: 'TOKENVALUE', role: args.role, actor: args.actor, expiresIn: 900, tokenVersion: 2 } }; };
  return { calls, handler };
}
function fakeFinancialService() { const calls = []; const mk = (n) => async (a) => { calls.push({ n, a }); return { ok: true, result: {} }; }; return { calls, markPaid: mk('markPaid'), importLegacyPayment: mk('i'), refund: mk('r'), voidOrder: mk('v') }; }
const H = (over = {}) => Object.assign({ 'content-type': 'application/json' }, over);
const jbody = (o) => JSON.stringify(o);
const okLoginBody = jbody({ role: 'admin', pin: '135724' });

// harness builder
function mk(opts = {}) {
  const login = fakeLogin(opts.loginBehavior);
  const fin = fakeFinancialService();
  const deps = {
    dashboardApiKey: opts.dashboardApiKey,
    login: { env: { AUTH_V2_LOGIN_HTTP_ENABLED: opts.loginFlag }, loginHandler: login.handler, logger: opts.logger },
    financial: { env: { AUTH_V2_FINANCIAL_HTTP_ENABLED: opts.finFlag }, service: fin, verifyToken: () => ({ role: 'admin', sub: 'owner', sv: 1 }), getActor: async () => ({ actor: 'owner', role: 'admin', active: true, session_version: 1 }) },
  };
  const built = createAuthV2IntegrationApp(deps);
  return { app: built.app, login, fin, loginIntegration: built.loginIntegration, financialIntegration: built.financialIntegration };
}

(async () => {
  // ═══════════ FLAG DISABLED ═══════════
  let t = mk({});
  assert('disabled: login integration enabled=false, 0 routes', t.loginIntegration.enabled === false && t.loginIntegration.routes.length === 0);
  let r = await inject(t.app, { method: 'POST', url: LOGIN_PATH, headers: H(), body: okLoginBody });
  assert('disabled: POST login falls through to legacy (no login route), handler not called', r.status === 200 && r.json.legacy === true && t.login.calls.length === 0);

  // ═══════════ FLAG ENABLED ═══════════
  t = mk({ loginFlag: 'true' });
  assert('enabled: login integration enabled=true, 1 route', t.loginIntegration.enabled === true && t.loginIntegration.routes.length === 1 && t.loginIntegration.path === '/api/auth/v2/login');
  r = await inject(t.app, { method: 'POST', url: LOGIN_PATH, headers: H(), body: okLoginBody });
  assert('enabled: valid login → 200 with accepted envelope, handler called once', r.status === 200 && r.json.token === 'TOKENVALUE' && r.json.tokenVersion === 2 && t.login.calls.length === 1);
  assert('enabled: exact request fields passed (role/pin/actor/trustedClientIp) only', JSON.stringify(Object.keys(t.login.calls[0]).sort()) === JSON.stringify(['actor', 'pin', 'role', 'trustedClientIp'].sort()));
  assert('enabled: caller role/session/token/claims not forwarded as authority', (() => { const k = Object.keys(t.login.calls[0]); return !k.includes('sv') && !k.includes('session_version') && !k.includes('token') && !k.includes('expiresIn') && !k.includes('active') && !k.includes('failed_count'); })());

  // operator actor forwarded; server-owned IP used
  t = mk({ loginFlag: 'true' });
  r = await inject(t.app, { method: 'POST', url: LOGIN_PATH, headers: H(), body: jbody({ role: 'operator', pin: '778899', actor: 'operator_primary' }) });
  assert('enabled: operator actor forwarded verbatim', t.login.calls[0].actor === 'operator_primary' && t.login.calls[0].role === 'operator');
  assert('enabled: trustedClientIp is server-owned (undefined here, never from body)', 'trustedClientIp' in t.login.calls[0] && t.login.calls[0].trustedClientIp !== 'attacker-ip');

  // PIN passed verbatim (no trim/normalize)
  t = mk({ loginFlag: 'true' });
  await inject(t.app, { method: 'POST', url: LOGIN_PATH, headers: H(), body: jbody({ role: 'admin', pin: '  1 2 3  ' }) });
  assert('enabled: PIN passed verbatim (not trimmed/normalized)', t.login.calls[0].pin === '  1 2 3  ');

  // body-supplied ip cannot override server ip
  t = mk({ loginFlag: 'true' });
  await inject(t.app, { method: 'POST', url: LOGIN_PATH, headers: H(), body: jbody({ role: 'admin', pin: '135724', trustedClientIp: 'attacker-ip', ipHash: 'x', ip: '9.9.9.9' }) });
  assert('enabled: body-supplied ip/ipHash ignored', t.login.calls[0].trustedClientIp !== 'attacker-ip' && !('ipHash' in t.login.calls[0]));

  // ═══════════ ERROR PASSTHROUGH (accepted B3 mapping) ═══════════
  for (const [status, bodyOut] of [[400, { error: 'solicitud inválida' }], [401, { error: 'credenciales incorrectas' }], [429, { error: 'temporalmente bloqueado', retryAfterSec: 30 }], [503, { error: 'servicio auth no disponible' }]]) {
    t = mk({ loginFlag: 'true', loginBehavior: { out: { status, body: bodyOut } } });
    r = await inject(t.app, { method: 'POST', url: LOGIN_PATH, headers: H(), body: okLoginBody });
    assert(`enabled: handler ${status} preserved`, r.status === status && JSON.stringify(r.json) === JSON.stringify(bodyOut));
  }
  // handler throw → sanitized 500
  t = mk({ loginFlag: 'true', loginBehavior: { throw: new Error('db.internal secret detail') } });
  r = await inject(t.app, { method: 'POST', url: LOGIN_PATH, headers: H(), body: okLoginBody });
  assert('enabled: handler throw → sanitized 500, no detail', r.status === 500 && !/db\.internal|secret detail|\bat \b/.test(r.text));
  // malformed handler result → 500
  t = mk({ loginFlag: 'true', loginBehavior: { out: { nope: true } } });
  r = await inject(t.app, { method: 'POST', url: LOGIN_PATH, headers: H(), body: okLoginBody });
  assert('enabled: malformed handler result → 500', r.status === 500);

  // ═══════════ JWT / X-Api-Key INDEPENDENCE ═══════════
  t = mk({ loginFlag: 'true', dashboardApiKey: 'SECRET' });
  r = await inject(t.app, { method: 'POST', url: LOGIN_PATH, headers: H(), body: okLoginBody });
  assert('login works WITHOUT X-Api-Key (before legacy guard) and WITHOUT Bearer', r.status === 200 && t.login.calls.length === 1);
  t = mk({ loginFlag: 'true', dashboardApiKey: 'SECRET', loginBehavior: { out: { status: 401, body: { error: 'credenciales incorrectas' } } } });
  r = await inject(t.app, { method: 'POST', url: LOGIN_PATH, headers: H({ 'x-api-key': 'SECRET' }), body: jbody({ role: 'admin', pin: 'wrong' }) });
  assert('X-Api-Key grants NO special login behaviour (handler still authoritative)', r.status === 401 && t.login.calls.length === 1);
  t = mk({ loginFlag: 'true', dashboardApiKey: 'SECRET' });
  r = await inject(t.app, { method: 'GET', url: '/api/orders', headers: {} });
  assert('unrelated /api still requires legacy key → 401 unauthorized', r.status === 401 && r.json.error === 'unauthorized');

  // ═══════════ FLAG INDEPENDENCE ═══════════
  t = mk({ loginFlag: 'true', finFlag: undefined });
  r = await inject(t.app, { method: 'POST', url: '/api/financial/mark-paid', headers: H({ authorization: 'Bearer good' }), body: '{}' });
  assert('login on, financial off: financial route absent (legacy fallthrough), no fin service', r.json && r.json.legacy === true && t.fin.calls.length === 0);
  t = mk({ finFlag: 'true', loginFlag: undefined });
  r = await inject(t.app, { method: 'POST', url: LOGIN_PATH, headers: H(), body: okLoginBody });
  assert('financial on, login off: login route absent (legacy fallthrough), no login handler', r.json && r.json.legacy === true && t.login.calls.length === 0);
  t = mk({ loginFlag: 'true', finFlag: 'true' });
  assert('both on: exactly 1 login route + 4 financial routes', t.loginIntegration.routes.length === 1 && t.financialIntegration.routes.length === 4);

  // ═══════════ PARSER / CORS / METHOD ═══════════
  t = mk({ loginFlag: 'true' });
  r = await inject(t.app, { method: 'POST', url: LOGIN_PATH, headers: H(), body: '{ not json' });
  assert('parser: malformed JSON on login → 400 sanitized, handler not called', r.status === 400 && r.json && r.json.error === 'solicitud inválida' && t.login.calls.length === 0);
  assert('parser: malformed error leaks no PIN/raw body/stack', !/SyntaxError|Unexpected token|not json|\bat \b|pin/.test(r.text));
  t = mk({ loginFlag: 'true', dashboardApiKey: 'SECRET' });
  r = await inject(t.app, { method: 'POST', url: '/api/orders', headers: H({ 'x-api-key': 'SECRET' }), body: '{ not json' });
  assert('parser: malformed JSON on legacy path NOT login-sanitized (unchanged)', r.status === 400 && !/solicitud inválida/.test(r.text));
  t = mk({ loginFlag: 'true' });
  r = await inject(t.app, { method: 'POST', url: LOGIN_PATH, headers: H(), body: jbody({ role: 'admin', pin: 'x', blob: 'y'.repeat(200 * 1024) }) });
  assert('parser: oversized JSON on login → 413 sanitized, handler not called', r.status === 413 && r.json.error === 'cuerpo demasiado grande' && t.login.calls.length === 0);
  t = mk({ loginFlag: 'true' });
  r = await inject(t.app, { method: 'OPTIONS', url: LOGIN_PATH });
  assert('cors: OPTIONS login → 204, handler not called', r.status === 204 && t.login.calls.length === 0);
  for (const m of ['GET', 'PUT', 'PATCH', 'DELETE']) {
    t = mk({ loginFlag: 'true' });
    r = await inject(t.app, { method: m, url: LOGIN_PATH, headers: H(), body: null });
    assert(`method: ${m} cannot invoke login (handler not called)`, t.login.calls.length === 0);
  }

  // ═══════════ LOGGING: no token/PIN ═══════════
  const logs = [];
  t = mk({ loginFlag: 'true', logger: { info: (o) => logs.push(o) } });
  await inject(t.app, { method: 'POST', url: LOGIN_PATH, headers: H(), body: okLoginBody });
  assert('log record has only {op,status}', logs.length === 1 && JSON.stringify(Object.keys(logs[0]).sort()) === JSON.stringify(['op', 'status']));
  assert('logs never contain token/PIN', !/TOKENVALUE|135724|pin/.test(JSON.stringify(logs)));

  // ═══════════ REAL index.js APP: registration + mount order ═══════════
  function loadIndex(loginFlag, finFlag) {
    delete require.cache[require.resolve('../index.js')];
    const oL = process.env.AUTH_V2_LOGIN_HTTP_ENABLED, oF = process.env.AUTH_V2_FINANCIAL_HTTP_ENABLED;
    loginFlag === undefined ? delete process.env.AUTH_V2_LOGIN_HTTP_ENABLED : process.env.AUTH_V2_LOGIN_HTTP_ENABLED = loginFlag;
    finFlag === undefined ? delete process.env.AUTH_V2_FINANCIAL_HTTP_ENABLED : process.env.AUTH_V2_FINANCIAL_HTTP_ENABLED = finFlag;
    const app = require('../index.js').app;
    oL === undefined ? delete process.env.AUTH_V2_LOGIN_HTTP_ENABLED : process.env.AUTH_V2_LOGIN_HTTP_ENABLED = oL;
    oF === undefined ? delete process.env.AUTH_V2_FINANCIAL_HTTP_ENABLED : process.env.AUTH_V2_FINANCIAL_HTTP_ENABLED = oF;
    return app;
  }
  const loginLayers = (app) => app._router.stack.filter((l) => l.route && l.route.path === '/api/auth/v2/login');
  let a = loadIndex(undefined, undefined);
  assert('real app: both flags off → 0 login routes', loginLayers(a).length === 0);
  a = loadIndex('true', undefined);
  const ll = loginLayers(a);
  assert('real app: login flag → exactly 1 POST login route (no duplicate)', ll.length === 1 && ll[0].route.methods.post === true);
  const loginIdx = a._router.stack.findIndex((l) => l.route && l.route.path === '/api/auth/v2/login');
  const guardIdx = a._router.stack.findIndex((l) => !l.route && l.regexp && l.regexp.toString().includes('api') && l.name === '<anonymous>');
  assert('real app: login route registered BEFORE the legacy /api guard', loginIdx > 0 && (guardIdx === -1 || loginIdx < guardIdx), `login=${loginIdx} guard=${guardIdx}`);
  assert('real app: non-exact flag "1" → 0 login routes', loginLayers(loadIndex('1', undefined)).length === 0);
  a = loadIndex('true', 'true');
  assert('real app: both flags on → 1 login + 4 financial routes', loginLayers(a).length === 1 && a._router.stack.filter((l) => l.route && String(l.route.path).startsWith('/api/financial')).length === 4);

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})();
