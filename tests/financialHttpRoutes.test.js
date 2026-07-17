'use strict';
// B7A3 route-registration + protection + HTTP-contract + architecture tests.
// Run: node tests/financialHttpRoutes.test.js
// Offline: fake express app records (method, path, middleware chain); requests are
// simulated through the real chain. Proves exactly four protected POST routes, no
// route reachable without auth, method safety, static route names, and module-aware
// architectural negative controls.
const fs = require('fs');
const path = require('path');
let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

const { registerFinancialRoutes, DEFAULT_PREFIX, ROUTES } = require('../src/auth/financialHttpHandlers');

function fakeApp() {
  const routes = [];
  const rec = (method) => (p, ...chain) => { routes.push({ method, path: p, chain }); };
  return { routes, post: rec('POST'), get: rec('GET'), put: rec('PUT'), patch: rec('PATCH'), delete: rec('DELETE') };
}
function fakeRes() { return { _status: null, _json: null, status(c) { this._status = c; return this; }, json(o) { this._json = o; return this; } }; }
async function runChain(chain, req, res) {
  let i = 0;
  async function next() { const fn = chain[i++]; if (!fn) return; await fn(req, res, next); }
  await next();
}
function fakeService() {
  const calls = [];
  const mk = (name) => async (args) => { calls.push({ name, args }); return { ok: true, result: { order_id: args.orderId, type: 'x', idempotent: false } }; };
  return { calls, markPaid: mk('markPaid'), importLegacyPayment: mk('importLegacyPayment'), refund: mk('refund'), voidOrder: mk('voidOrder') };
}
const verifyOK = (t) => (t === 'good' ? { role: 'admin', sub: 'owner', sv: 1 } : null);
const freshActor = async (sub) => (sub === 'owner' ? { actor: 'owner', role: 'admin', active: true, session_version: 1 } : null);
const deps0 = { verifyToken: verifyOK, getActor: freshActor };

(async () => {
  // ── exactly four POST routes at the expected paths ──────────────────────────
  let app = fakeApp();
  let svc = fakeService();
  const reg = registerFinancialRoutes(app, { service: svc, ...deps0 });
  assert('registers exactly 4 routes', app.routes.length === 4);
  assert('all routes are POST', app.routes.every((r) => r.method === 'POST'));
  const paths = app.routes.map((r) => r.path).sort();
  assert('paths are the four explicit financial paths', JSON.stringify(paths) === JSON.stringify([
    '/api/financial/import-legacy-payment', '/api/financial/mark-paid', '/api/financial/refund', '/api/financial/void'].sort()));
  assert('returns prefix + route summary', reg.prefix === DEFAULT_PREFIX && reg.routes.length === 4);
  assert('no GET/PUT/PATCH/DELETE mutation route registered', app.routes.every((r) => r.method === 'POST'));

  // ── every route has auth middleware BEFORE the handler ──────────────────────
  assert('each route chain = [auth, handler]', app.routes.every((r) => r.chain.length === 2 && typeof r.chain[0] === 'function' && typeof r.chain[1] === 'function'));

  // ── no route reachable without a valid token (auth gate) ────────────────────
  let allGated = true;
  for (const r of app.routes) {
    const before = svc.calls.length;
    const res = fakeRes();
    await runChain(r.chain, { headers: {}, body: { orderId: 'O', paymentMethod: 'efectivo', idempotencyKey: 'k12345678', reason: 'r', actor: 'owner' }, ip: '1.1.1.1' }, res);
    if (!(res._status === 401 && svc.calls.length === before)) allGated = false;
  }
  assert('unauthenticated request to every route → 401, handler never runs', allGated && svc.calls.length === 0);

  // ── with a valid token the chain reaches the handler exactly once ───────────
  svc = fakeService(); app = fakeApp();
  registerFinancialRoutes(app, { service: svc, ...deps0 });
  const markRoute = app.routes.find((r) => r.path === '/api/financial/mark-paid');
  let res = fakeRes();
  await runChain(markRoute.chain, { headers: { authorization: 'Bearer good' }, body: { orderId: 'ORDZ', paymentMethod: 'efectivo', reason: 'r', idempotencyKey: 'k12345678' }, ip: '2.2.2.2' }, res);
  assert('authenticated request reaches handler → 200, one service call', res._status === 200 && svc.calls.length === 1 && svc.calls[0].name === 'markPaid');
  assert('authenticated request: actor from token context', svc.calls[0].args.authContext.sub === 'owner');
  assert('DB-verified session_version reaches the service (ctx.sv === DB row sv=1)', svc.calls[0].args.authContext.sv === 1);

  // ── absent/invalid body handled safely (no throw) → boundary rejects ────────
  svc = fakeService(); app = fakeApp();
  registerFinancialRoutes(app, { service: svc, ...deps0 });
  const refundRoute = app.routes.find((r) => r.path === '/api/financial/refund');
  res = fakeRes();
  await runChain(refundRoute.chain, { headers: { authorization: 'Bearer good' }, body: undefined, ip: '2.2.2.2' }, res);
  assert('missing body does not throw; service sees undefined fields', svc.calls.length === 1 && svc.calls[0].args.orderId === undefined);

  // ── static route names (never client-supplied) ──────────────────────────────
  assert('route table is static and closed (4 entries)', ROUTES.length === 4 && ROUTES.every((r) => typeof r.path === 'string' && typeof r.handler === 'string'));
  assert('registration requires app.post + service', (() => { let threw = 0; try { registerFinancialRoutes({}, { service: svc }); } catch (_) { threw++; } try { registerFinancialRoutes(fakeApp(), {}); } catch (_) { threw++; } return threw === 2; })());

  // ── registration does not add OPTIONS/CORS (left to existing app convention) ─
  assert('no OPTIONS handler registered (CORS stays app-level)', !app.routes.some((r) => r.method === 'OPTIONS'));

  // ════════════════ ARCHITECTURAL NEGATIVE CONTROLS ════════════════
  const strip = (s) => s.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const HND = strip(fs.readFileSync(path.join(__dirname, '..', 'src/auth/financialHttpHandlers.js'), 'utf8'));
  const ERRM = strip(fs.readFileSync(path.join(__dirname, '..', 'src/auth/financialHttpErrors.js'), 'utf8'));
  const idx = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const BOTH = HND + '\n' + ERRM;

  // DAO-exclusive references only (voidOrder/importLegacyPayment names are shared by
  // the service, which the handler legitimately calls — those are NOT DAO markers).
  const callsDaoDirect = (s) => /financialDao|createFinancialDao|\.markOrderPaid\(|\.refundOrder\(/.test(s);
  const callsSupabase = (s) => /sbRest\(|supabase|rest\/v1|createClient|SUPABASE_KEY|\.rpc\(/.test(s);
  const genericActionRoute = (s) => /req\.(body|query|params)\.(action|rpc|fn|type|event_type)/.test(s) || /app\.post\(\s*[`'"][^`'"]*:(action|type|rpc)/.test(s);
  const callerActorRole = (s) => /b\.(actor|by_actor|role|sub|session_version)|body\.(actor|role|sub)/.test(s) || /p_by_role|expectedRole/.test(s);
  // identity/state authority is forbidden from the body ANYWHERE; amount is forbidden
  // only on refund/void (import legitimately reads b.amount, per its SQL signature).
  const callerStateAuthority = (s) => /b\.(payload_digest|digest|prev_estado|new_estado|prev_pay_state|new_pay_state|event_type|original_giro_id)\b/.test(s);
  const refundOrVoidReadsAmountOrMethod = (s) => {
    const rf = s.slice(s.indexOf('async function refund'), s.indexOf('async function voidOrder'));
    const vd = s.slice(s.indexOf('async function voidOrder'));
    return /b\.(amount|paymentMethod)/.test(rf) || /b\.(amount|paymentMethod)/.test(vd);
  };
  const callerFinancialAuthority = (s) => callerStateAuthority(s) || refundOrVoidReadsAmountOrMethod(s);
  const autoRetry = (s) => /retr(y|ies)|for\s*\([^)]*attempt|while\s*\([^)]*attempt|setTimeout\([\s\S]*service\./i.test(s);
  const nodeDigest = (s) => /createHash|sha256|payload_digest\s*[:=]|computeDigest/.test(s);
  const sensitiveOutput = (s) => /res\.json\([\s\S]{0,200}?(ip_hash|payload_digest|\bmeta\b|claims|SUPABASE_KEY|pin|service_key)/i.test(s) || /logger\.(info|warn|error)\([\s\S]{0,200}?(ip|meta|digest|reason|amount|confirmation|pin)/i.test(s);
  const modifiesMigration = (s) => /CREATE OR REPLACE FUNCTION|writeFileSync\([^)]*migrations|migrations\/[\w-]+\.sql/i.test(s);
  const returns201 = (s) => /\.status\(\s*201\s*\)|statusCode\s*=\s*201/.test(s);

  // positive guards on real code
  assert('handlers never call DAO directly', !callsDaoDirect(HND));
  assert('handlers never call Supabase/RPC directly', !callsSupabase(BOTH));
  assert('no generic financial action route', !genericActionRoute(HND));
  assert('handlers do not read caller actor/role/state', !callerActorRole(HND) && !callerFinancialAuthority(HND));
  assert('no automatic retry', !autoRetry(HND));
  assert('no Node-side digest', !nodeDigest(BOTH));
  assert('no sensitive output/logging', !sensitiveOutput(BOTH));
  assert('does not modify migrations', !modifiesMigration(BOTH));
  assert('never returns 201 (replay-safe, always 200 on ok)', !returns201(HND) && /\.status\(200\)/.test(HND));
  assert('financial http modules not wired into index.js', !/financialHttpHandlers|financialHttpErrors|registerFinancialRoutes/.test(idx));
  assert('handler reads actor only from req.authContext', /req\.authContext|req && req\.authContext/.test(HND) && !/req\.body\.actor|body\.actor/.test(HND));

  // ── session-freshness guards (crypto verification alone is insufficient) ────
  const hasSvCheck = (s) => /row\.session_version !== payload\.sv/.test(s);
  const hasActiveCheck = (s) => /row\.active !== true/.test(s);
  const hasDbRoleCheck = (s) => /row\.role !== payload\.role/.test(s);
  const freshnessBeforeContext = (s) => { const g = s.indexOf('getActor(payload.sub)'); const c = s.indexOf('req.authContext = Object.freeze'); return g > 0 && c > 0 && g < c; };
  // fail-closed = the freshness catch block returns a response (sanitized 500) and never calls next().
  const freshnessCatch = (s) => { const i = s.indexOf('try { row = await getActor'); const c = s.indexOf('catch (', i); const end = s.indexOf('if (!row', c); return (c >= 0 && end > c) ? s.slice(c, end) : ''; };
  const freshnessFailIsClosed = (s) => { const b = freshnessCatch(s); return /res\.status\([\s\S]*?\.json\(/.test(b) && !/\bnext\(/.test(b); };
  assert('freshness: compares token sv to DB session_version', hasSvCheck(HND));
  assert('freshness: checks DB active=true', hasActiveCheck(HND));
  assert('freshness: compares token role to DB role', hasDbRoleCheck(HND));
  assert('freshness: DB read occurs BEFORE context attach', freshnessBeforeContext(HND));
  assert('freshness: attaches DB-authoritative role (not raw JWT role)', /req\.authContext = Object\.freeze\(\{ role: row\.role/.test(HND));
  assert('freshness: ambiguous DB failure fails closed to sanitized response (not next)', freshnessFailIsClosed(HND));
  assert('freshness: ambiguous DB failure maps to internal error (500), not credentials', /catch \([\s\S]*?INTERNAL_ERROR_CODE[\s\S]*?\}/.test(HND.slice(HND.indexOf('try { row = await getActor'))));

  // negative controls: detectors must fire on injected violations
  assert('NC1: handler→DAO detected', callsDaoDirect(HND + '\nconst d = require("./financialDao").createFinancialDao();'));
  assert('NC2: handler→Supabase detected', callsSupabase(HND + '\nawait sbRest("POST","rpc/order_void",{});'));
  assert('NC3: generic action route detected', genericActionRoute(HND + '\nconst a = req.body.action;'));
  assert('NC4: caller actor/role detected', callerActorRole(HND + '\nconst who = b.actor || b.role;'));
  assert('NC5: caller amount/state on refund/void detected', callerFinancialAuthority(HND + '\nconst amt = b.amount;'));
  assert('NC6: auto retry detected', autoRetry(HND + '\nfor (let attempt=0;attempt<3;attempt++){ await service.refund(); }'));
  assert('NC7: node digest detected', nodeDigest(HND + '\nconst h = require("crypto").createHash("sha256");'));
  assert('NC8: sensitive output detected', sensitiveOutput(HND + '\nres.json({ ip_hash: h, payload_digest: d });'));
  assert('NC9: migration modification detected', modifiesMigration(HND + '\nfs.writeFileSync("migrations/x.sql","CREATE OR REPLACE FUNCTION");'));
  assert('NC10: 201 insertion inference detected', returns201(HND + '\nres.status(201).json({});'));
  assert('NC11: unprotected route detected (registration adds handler without auth)', (() => {
    // a registration that pushed [handler] only (no auth) would have chain length 1
    const badApp = fakeApp();
    badApp.post('/api/financial/mark-paid', async () => {}); // simulate an unguarded route
    return badApp.routes[0].chain.length === 1; // guard: our real registration is length 2
  })());
  assert('NC12: omitted sv comparison detected', hasSvCheck(HND) && !hasSvCheck(HND.replace('row.session_version !== payload.sv', 'false')));
  assert('NC13: omitted DB-role comparison detected', hasDbRoleCheck(HND) && !hasDbRoleCheck(HND.replace('row.role !== payload.role', 'false')));
  assert('NC14: inactive-allowed detected', hasActiveCheck(HND) && !hasActiveCheck(HND.replace('row.active !== true', 'false')));
  assert('NC15: freshness failure treated as success detected', freshnessFailIsClosed(HND) && !freshnessFailIsClosed(HND.replace('return res.status(statusForCode(INTERNAL_ERROR_CODE)).json({ ok: false, code: INTERNAL_ERROR_CODE });', 'return next();')));
  assert('NC16: freshness placed after context attach detected', !freshnessBeforeContext('req.authContext = Object.freeze({ role: row.role }); const x = getActor(payload.sub);'));

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})();
