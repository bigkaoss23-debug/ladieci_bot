'use strict';
// B7A4 real-application financial-route integration tests.
// Run: node tests/financialHttpIntegration.test.js
// Offline: drives the REAL Express stack (createFinancialIntegrationApp harness + the
// real index.js app) via in-memory request injection — NO network port, NO DB, injected
// JWT verifier / actor authority / financial service. Proves the flag gate, JWT vs
// X-Api-Key separation, mount order before the legacy /api proxy, parser/CORS behaviour,
// and session-freshness rejection.
const http = require('http');
const { Socket } = require('net');
let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

const { createFinancialIntegrationApp } = require('../src/auth/financialHttpIntegration');

// In-memory request injection against a real Express app (real http.ServerResponse).
function inject(app, { method = 'GET', url = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve) => {
    const req = new http.IncomingMessage(new Socket());
    req.method = method; req.url = url; req.headers = {};
    for (const k of Object.keys(headers)) req.headers[k.toLowerCase()] = headers[k];
    // Set content-length so the real body-parser recognizes a body and actually parses it.
    if (body != null && req.headers['content-length'] === undefined) req.headers['content-length'] = String(Buffer.byteLength(body));
    const res = new http.ServerResponse(req);
    const chunks = [];
    res.write = (c) => { if (c) chunks.push(Buffer.from(c)); return true; };
    res.end = (c) => { if (c) chunks.push(Buffer.from(c)); const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch (_) { /* non-json */ } resolve({ status: res.statusCode, text, json }); };
    app(req, res);
    if (body != null) req.push(Buffer.from(body));
    req.push(null);
  });
}

const verify = (t) => (t === 'good' ? { role: 'admin', sub: 'owner', sv: 2 } : (t === 'stale' ? { role: 'admin', sub: 'owner', sv: 2 } : null));
const getActorFresh = async (s) => (s === 'owner' ? { actor: 'owner', role: 'admin', active: true, session_version: 2 } : null);
const getActorStale = async (s) => (s === 'owner' ? { actor: 'owner', role: 'admin', active: true, session_version: 9 } : null);
const getActorInactive = async (s) => (s === 'owner' ? { actor: 'owner', role: 'admin', active: false, session_version: 2 } : null);
function fakeService(behavior = {}) {
  const calls = [];
  const mk = (name) => async (a) => { calls.push({ name, args: a }); const b = behavior[name]; if (b && b.out) return b.out; return { ok: true, result: { event_id: 'e1', order_id: a.orderId, type: 'payment', idempotent: false, ctxsub: a.authContext.sub, ctxsv: a.authContext.sv } }; };
  return { calls, markPaid: mk('markPaid'), importLegacyPayment: mk('importLegacyPayment'), refund: mk('refund'), voidOrder: mk('voidOrder') };
}
const PATHS = ['/api/financial/mark-paid', '/api/financial/import-legacy-payment', '/api/financial/refund', '/api/financial/void'];
const jbody = (o) => JSON.stringify(o);
const goodBody = jbody({ orderId: 'O', paymentMethod: 'efectivo', amount: 5, confirmation: 'IMPORT_LEGACY_PAYMENT', reason: 'r', idempotencyKey: 'k12345678' });
const H = (over = {}) => Object.assign({ 'content-type': 'application/json' }, over);

(async () => {
  // ═══════════ FLAG DISABLED ═══════════
  let svc = fakeService();
  let { app, integration } = createFinancialIntegrationApp({ env: {}, service: svc, verifyToken: verify, getActor: getActorFresh });
  assert('disabled: integration reports enabled=false, 0 routes', integration.enabled === false && integration.routes.length === 0);
  let r = await inject(app, { method: 'POST', url: '/api/financial/mark-paid', headers: H({ authorization: 'Bearer good' }), body: goodBody });
  assert('disabled: financial POST falls through to legacy (no financial route)', r.status === 200 && r.json && r.json.legacy === true && svc.calls.length === 0);
  r = await inject(app, { method: 'GET', url: '/health' });
  assert('disabled: health route unchanged', r.status === 200 && r.json.ok === true);
  r = await inject(app, { method: 'GET', url: '/api?action=x' });
  assert('disabled: legacy /api unchanged (no key configured → passes)', r.status === 200 && r.json.legacy === true);

  // ═══════════ FLAG ENABLED ═══════════
  const mk = (over = {}, env = { AUTH_V2_FINANCIAL_HTTP_ENABLED: 'true' }) => {
    const s = over.service || fakeService();
    const built = createFinancialIntegrationApp(Object.assign({ env, service: s, verifyToken: verify, getActor: getActorFresh }, over));
    return { app: built.app, integration: built.integration, svc: s };
  };
  let e = mk();
  assert('enabled: integration reports enabled=true, 4 routes', e.integration.enabled === true && e.integration.routes.length === 4);

  const methodByPath = { '/api/financial/mark-paid': 'markPaid', '/api/financial/import-legacy-payment': 'importLegacyPayment', '/api/financial/refund': 'refund', '/api/financial/void': 'voidOrder' };
  for (const p of PATHS) {
    e = mk();
    r = await inject(e.app, { method: 'POST', url: p, headers: H({ authorization: 'Bearer good' }), body: goodBody });
    assert(`enabled: ${p} → 200, exactly one service call to ${methodByPath[p]}`, r.status === 200 && e.svc.calls.length === 1 && e.svc.calls[0].name === methodByPath[p]);
    assert(`enabled: ${p} actor from token (owner), DB sv=2 reaches service`, e.svc.calls[0].args.authContext.sub === 'owner' && e.svc.calls[0].args.authContext.sv === 2);
  }

  // missing / invalid JWT rejected before service
  e = mk();
  r = await inject(e.app, { method: 'POST', url: PATHS[0], headers: H(), body: goodBody });
  assert('enabled: missing JWT → 401, no service', r.status === 401 && r.json.code === 'FINANCIAL_UNAUTHENTICATED' && e.svc.calls.length === 0);
  e = mk();
  r = await inject(e.app, { method: 'POST', url: PATHS[0], headers: H({ authorization: 'Bearer bad' }), body: goodBody });
  assert('enabled: invalid JWT → 401, no service', r.status === 401 && e.svc.calls.length === 0);

  // stale session rejected before service
  e = { ...mk({ getActor: getActorStale }) };
  { const built = createFinancialIntegrationApp({ env: { AUTH_V2_FINANCIAL_HTTP_ENABLED: 'true' }, service: e.svc, verifyToken: verify, getActor: getActorStale }); e.app = built.app; }
  r = await inject(e.app, { method: 'POST', url: PATHS[0], headers: H({ authorization: 'Bearer good' }), body: goodBody });
  assert('enabled: stale session_version → 401, no service', r.status === 401 && r.json.code === 'FINANCIAL_UNAUTHENTICATED' && e.svc.calls.length === 0);

  // inactive actor → 403
  { const s = fakeService(); const built = createFinancialIntegrationApp({ env: { AUTH_V2_FINANCIAL_HTTP_ENABLED: 'true' }, service: s, verifyToken: verify, getActor: getActorInactive });
    r = await inject(built.app, { method: 'POST', url: PATHS[0], headers: H({ authorization: 'Bearer good' }), body: goodBody });
    assert('enabled: inactive actor → 403 AUTH_INITIATOR_INACTIVE, no service', r.status === 403 && r.json.code === 'AUTH_INITIATOR_INACTIVE' && s.calls.length === 0); }

  // body actor/role/sv cannot override trusted context
  e = mk();
  r = await inject(e.app, { method: 'POST', url: PATHS[0], headers: H({ authorization: 'Bearer good' }), body: jbody({ orderId: 'O', paymentMethod: 'efectivo', reason: 'r', idempotencyKey: 'k12345678', actor: 'rider', role: 'rider', sub: 'rider', sv: 999, session_version: 999 }) });
  assert('enabled: body actor/role/sv ignored (ctx owner, sv 2)', r.status === 200 && e.svc.calls[0].args.authContext.sub === 'owner' && e.svc.calls[0].args.authContext.sv === 2);

  // replay → 200 same event id + idempotent
  e = mk({ service: fakeService({ voidOrder: { out: { ok: true, result: { event_id: 'EV', idempotent: true, order_id: 'O' } } } }) });
  r = await inject(e.app, { method: 'POST', url: '/api/financial/void', headers: H({ authorization: 'Bearer good' }), body: goodBody });
  assert('enabled: replay → 200, same event id + idempotent', r.status === 200 && r.json.result.event_id === 'EV' && r.json.result.idempotent === true);

  // recognized errors retain status; unknown → sanitized 500
  for (const [code, status] of [['AUTH_ORDER_NOT_FOUND', 404], ['AUTH_IDEMPOTENCY_CONFLICT', 409], ['AUTH_SESSION_STALE', 401], ['WHATEVER_UNKNOWN', 500]]) {
    e = mk({ service: fakeService({ refund: { out: { ok: false, code } } }) });
    r = await inject(e.app, { method: 'POST', url: '/api/financial/refund', headers: H({ authorization: 'Bearer good' }), body: goodBody });
    assert(`enabled: service code ${code} → ${status}`, r.status === status && r.json.ok === false);
  }

  // ═══════════ JWT vs X-Api-Key SEPARATION (dashboard key configured) ═══════════
  const mkKey = (over = {}) => { const s = fakeService(); const built = createFinancialIntegrationApp(Object.assign({ env: { AUTH_V2_FINANCIAL_HTTP_ENABLED: 'true' }, dashboardApiKey: 'SECRET', service: s, verifyToken: verify, getActor: getActorFresh }, over)); return { app: built.app, svc: s }; };
  let k = mkKey();
  r = await inject(k.app, { method: 'POST', url: PATHS[0], headers: H({ authorization: 'Bearer good' }), body: goodBody });
  assert('coexist: valid JWT works WITHOUT X-Api-Key (financial before legacy guard) → 200', r.status === 200 && k.svc.calls.length === 1);
  k = mkKey();
  r = await inject(k.app, { method: 'POST', url: PATHS[0], headers: H({ 'x-api-key': 'SECRET' }), body: goodBody });
  assert('coexist: X-Api-Key alone (no JWT) → 401, financial route not authenticated', r.status === 401 && r.json.code === 'FINANCIAL_UNAUTHENTICATED' && k.svc.calls.length === 0);
  k = mkKey();
  r = await inject(k.app, { method: 'POST', url: '/api/orders', headers: H({ authorization: 'Bearer good' }), body: '{}' });
  assert('coexist: non-financial /api with JWT but no key → 401 legacy unauthorized', r.status === 401 && r.json.error === 'unauthorized');
  k = mkKey();
  r = await inject(k.app, { method: 'GET', url: '/api?action=x', headers: { 'x-api-key': 'SECRET' } });
  assert('coexist: legacy /api still works with X-Api-Key → 200 legacy', r.status === 200 && r.json.legacy === true);

  // ═══════════ PARSER / CORS / METHOD ═══════════
  e = mk();
  r = await inject(e.app, { method: 'POST', url: PATHS[0], headers: H({ authorization: 'Bearer good' }), body: '{ not json' });
  assert('parser: malformed JSON on financial → 400 sanitized, no service', r.status === 400 && r.json && r.json.code === 'FINANCIAL_INVALID_REQUEST' && e.svc.calls.length === 0);
  assert('parser: malformed error leaks no stack/raw body', !/SyntaxError|Unexpected token|not json|\bat \b/.test(r.text));
  // malformed on a legacy /api path is NOT sanitized by the financial handler (behaviour unchanged)
  k = mkKey();
  r = await inject(k.app, { method: 'POST', url: '/api/orders', headers: H({ 'x-api-key': 'SECRET' }), body: '{ not json' });
  assert('parser: malformed JSON on legacy path NOT financial-sanitized (unchanged)', r.status === 400 && !/FINANCIAL_INVALID_REQUEST/.test(r.text));
  // oversize
  e = mk();
  r = await inject(e.app, { method: 'POST', url: PATHS[0], headers: H({ authorization: 'Bearer good' }), body: jbody({ orderId: 'O', blob: 'x'.repeat(200 * 1024) }) });
  assert('parser: oversized JSON on financial → 413 sanitized, no service', r.status === 413 && r.json.code === 'FINANCIAL_PAYLOAD_TOO_LARGE' && e.svc.calls.length === 0);
  // OPTIONS
  e = mk();
  r = await inject(e.app, { method: 'OPTIONS', url: PATHS[0] });
  assert('cors: OPTIONS financial → 204', r.status === 204);
  // GET/PUT/PATCH/DELETE cannot mutate (POST-only); fall to legacy echo, no service
  for (const m of ['GET', 'PUT', 'PATCH', 'DELETE']) {
    e = mk();
    r = await inject(e.app, { method: m, url: PATHS[0], headers: H({ authorization: 'Bearer good' }), body: null });
    assert(`method: ${m} on financial path does not mutate (no service call)`, e.svc.calls.length === 0);
  }

  // ═══════════ REAL index.js APP: registration + mount order ═══════════
  function loadIndex(flag) {
    delete require.cache[require.resolve('../index.js')];
    const old = process.env.AUTH_V2_FINANCIAL_HTTP_ENABLED;
    if (flag === undefined) delete process.env.AUTH_V2_FINANCIAL_HTTP_ENABLED; else process.env.AUTH_V2_FINANCIAL_HTTP_ENABLED = flag;
    const m = require('../index.js');
    if (old === undefined) delete process.env.AUTH_V2_FINANCIAL_HTTP_ENABLED; else process.env.AUTH_V2_FINANCIAL_HTTP_ENABLED = old;
    return m.app;
  }
  const finLayers = (app) => app._router.stack.filter((l) => l.route && String(l.route.path).startsWith('/api/financial'));
  const apiGuardIndex = (app) => app._router.stack.findIndex((l) => !l.route && l.regexp && l.regexp.test('/api/x') && l.name !== 'jsonParser' && l.name !== 'expressInit');
  let realOff = loadIndex(undefined);
  assert('real app: flag unset → 0 financial routes', finLayers(realOff).length === 0);
  let realOn = loadIndex('true');
  const fl = finLayers(realOn);
  assert('real app: flag true → exactly 4 financial POST routes (no duplicates)', fl.length === 4 && fl.every((l) => l.route.methods.post) && new Set(fl.map((l) => l.route.path)).size === 4);
  const firstFinIdx = realOn._router.stack.findIndex((l) => l.route && String(l.route.path).startsWith('/api/financial'));
  const guardIdx = realOn._router.stack.findIndex((l) => !l.route && l.regexp && l.regexp.toString().includes('api') && l.name === '<anonymous>');
  assert('real app: financial routes registered BEFORE the legacy /api guard', firstFinIdx > 0 && (guardIdx === -1 || firstFinIdx < guardIdx), `fin=${firstFinIdx} guard=${guardIdx}`);
  assert('real app: non-exact flag value 1 → 0 routes', finLayers(loadIndex('1')).length === 0);

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})();
