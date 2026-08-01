'use strict';
// B7A3 realistic HTTP app-stack tests. Run: node tests/financialHttpAppStack.test.js
// Offline: drives the REAL express.json() body parser (default 100kb) + a CORS
// middleware mirroring index.js + the intended sanitizing JSON error handler + the
// freshness auth middleware + a financial handler, using an in-memory mock request
// stream. NO network port is opened and NO staging is touched. Proves the transport
// contract: malformed/oversize/wrong-content-type JSON cannot mutate, auth+freshness
// run before the handler, and parser errors never leak stack/raw body.
const express = require('express');
const { Readable } = require('stream');
let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

const {
  createAuthContextMiddleware, createFinancialHandlers, financialJsonErrorHandler,
  registerFinancialRoutes, JSON_BODY_LIMIT,
} = require('../src/auth/financialHttpHandlers');
const { createFinancialService } = require('../src/auth/financialService');

const jsonParser = express.json(); // same default parser the app mounts (limit 100kb)

// CORS middleware mirroring index.js (Access-Control-* + OPTIONS → 204). V3-H.2 added
// PATCH/PUT/DELETE + Authorization for the V3 access-management routes.
function corsMw(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
}

function fakeRes() {
  return {
    _status: null, _json: null, _headers: {},
    status(c) { this._status = c; return this; },
    json(o) { this._json = o; return this; },
    setHeader(k, v) { this._headers[k] = v; },
    sendStatus(c) { this._status = c; return this; },
  };
}
function mockReq({ body = '', contentType = 'application/json', method = 'POST', ip = '1.2.3.4', token = 'good' } = {}) {
  const buf = Buffer.from(body, 'utf8');
  const req = new Readable({ read() {} });
  if (buf.length) req.push(buf);
  req.push(null);
  req.headers = { 'content-length': String(buf.length) };
  if (contentType) req.headers['content-type'] = contentType;
  if (token) req.headers.authorization = 'Bearer ' + token;
  req.method = method; req.url = '/api/financial/mark-paid'; req.ip = ip;
  return req;
}
// Real financial service over a fake DAO so the FULL chain (parser → auth → service
// validation → mapper) is exercised; the fake DAO records reaching the RPC boundary.
function fakeDao() {
  const calls = [];
  const mk = (name) => async (args) => { calls.push({ name, args }); return { event_id: 'e1', order_id: args.orderId, type: 'payment', prev_estado: 'EN_COCINA', new_estado: 'EN_COCINA', prev_pay_state: 'unpaid', new_pay_state: 'paid', legacy: false, original_giro_id: null, idempotent: false, created_at: 't' }; };
  return { calls, markOrderPaid: mk('markOrderPaid'), importLegacyPayment: mk('importLegacyPayment'), refundOrder: mk('refundOrder'), voidOrder: mk('voidOrder') };
}
const ipHash = (ip) => (typeof ip === 'string' && ip ? 'h_' + ip : null);
const verify = (t) => (t === 'good' ? { role: 'admin', sub: 'owner', sv: 4 } : null);
const getActor = async (sub) => (sub === 'owner' ? { actor: 'owner', role: 'admin', active: true, session_version: 4 } : null);

// Runs the same effective stack the future mount uses: CORS → json parse → (error
// handler) → auth+freshness → handler.
async function runStack(req, res, { dao }) {
  const auth = createAuthContextMiddleware({ verifyToken: verify, getActor });
  const handler = createFinancialHandlers({ service: createFinancialService({ dao, ipHash }) }).markPaid;
  corsMw(req, res, () => {});
  if (req.method === 'OPTIONS') return { authReached: false, handlerReached: false };
  let perr = null;
  await new Promise((resolve) => jsonParser(req, res, (e) => { perr = e || null; resolve(); }));
  if (perr) { financialJsonErrorHandler(perr, req, res, () => {}); return { authReached: false, handlerReached: false }; }
  let authReached = true; let passed = false;
  await auth(req, res, () => { passed = true; });
  if (!passed) return { authReached, handlerReached: false };
  await handler(req, res);
  return { authReached, handlerReached: true };
}

(async () => {
  // ── valid JSON POST reaches the protected handler → 200 ─────────────────────
  let dao = fakeDao();
  let res = fakeRes();
  let flow = await runStack(mockReq({ body: JSON.stringify({ orderId: 'ORD1', paymentMethod: 'efectivo', reason: 'r', idempotencyKey: 'k12345678' }) }), res, { dao });
  assert('valid JSON POST → handler runs, 200, one service call', flow.handlerReached && res._status === 200 && dao.calls.length === 1 && dao.calls[0].name === 'markOrderPaid');
  assert('valid JSON: body parsed and forwarded (orderId)', dao.calls[0].args.orderId === 'ORD1');

  // ── malformed JSON → safe 400, never reaches auth/service ───────────────────
  dao = fakeDao(); res = fakeRes();
  flow = await runStack(mockReq({ body: '{ this is : not json' }), res, { dao });
  assert('malformed JSON → 400, no auth, no service', res._status === 400 && res._json.code === 'FINANCIAL_INVALID_REQUEST' && !flow.authReached && dao.calls.length === 0);
  assert('malformed JSON error leaks no stack / parser message / raw body', (() => {
    const s = JSON.stringify(res._json);
    return !/SyntaxError|Unexpected token|not json|at JSON\.parse|\\n\s+at /.test(s) && JSON.stringify(Object.keys(res._json).sort()) === JSON.stringify(['code', 'ok']);
  })());

  // ── oversized JSON (> default 100kb) → safe rejection, never reaches service ─
  dao = fakeDao(); res = fakeRes();
  const huge = JSON.stringify({ orderId: 'O', blob: 'x'.repeat(200 * 1024) }); // ~200kb > 100kb
  flow = await runStack(mockReq({ body: huge }), res, { dao });
  assert('oversized JSON → 413, never reaches service', res._status === 413 && res._json.code === 'FINANCIAL_PAYLOAD_TOO_LARGE' && dao.calls.length === 0);
  assert('documented body limit is the inherited express default', JSON_BODY_LIMIT === '100kb');

  // ── unsupported content type → not parsed; downstream rejects safely ────────
  dao = fakeDao(); res = fakeRes();
  flow = await runStack(mockReq({ body: 'orderId=O', contentType: 'text/plain' }), res, { dao });
  assert('text/plain body not parsed → handler sees no fields → service INVALID (400)', res._status === 400 && res._json && res._json.ok === false);

  // ── missing body → handled safely (no throw) ────────────────────────────────
  dao = fakeDao(); res = fakeRes();
  flow = await runStack(mockReq({ body: '' }), res, { dao });
  assert('empty body → no throw, safe response (not 5xx)', res._status !== null && res._status < 500);

  // ── OPTIONS follows the CORS convention (204), never reaches auth/handler ────
  dao = fakeDao(); res = fakeRes();
  flow = await runStack(mockReq({ method: 'OPTIONS', token: null, body: '' }), res, { dao });
  assert('OPTIONS → 204 via CORS, no auth, no service', res._status === 204 && !flow.authReached && dao.calls.length === 0);
  assert('CORS headers set', res._headers['Access-Control-Allow-Origin'] === '*' && /POST/.test(res._headers['Access-Control-Allow-Methods']));

  // ── authentication + freshness run BEFORE the handler ───────────────────────
  dao = fakeDao(); res = fakeRes();
  flow = await runStack(mockReq({ body: JSON.stringify({ orderId: 'O', paymentMethod: 'efectivo', reason: 'r', idempotencyKey: 'k12345678' }), token: 'bad' }), res, { dao });
  assert('invalid token: valid JSON but 401 before handler/service', res._status === 401 && dao.calls.length === 0 && !flow.handlerReached);

  // ── GET/PUT/PATCH/DELETE cannot invoke a financial mutation (POST-only mount) ─
  const methods = [];
  const app = { post: (p) => methods.push('POST ' + p), get: () => methods.push('GET'), put: () => methods.push('PUT'), patch: () => methods.push('PATCH'), delete: () => methods.push('DELETE') };
  registerFinancialRoutes(app, { service: {}, verifyToken: verify, getActor });
  assert('registration mounts POST only (no GET/PUT/PATCH/DELETE)', methods.length === 4 && methods.every((m) => m.startsWith('POST ')));

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})();
