'use strict';
// Access Control V2 — Block B7A3: protected financial HTTP boundary (UNWIRED).
// Four explicit POST handlers one-to-one with the B7A2C financial service, a JWT
// auth-context middleware that REUSES the accepted B3 verifier (jwt.verifyToken —
// no second verifier), a centralized error→status mapper (financialHttpErrors), and
// an additive route registration. NOT imported by index.js; production routes and the
// legacy X-Api-Key proxy are untouched.
//
// Boundary (handlers NEVER call the DAO or Supabase directly):
//   authenticated route → verified B3 context (req.authContext) → handler →
//   operation-specific sanitized body → financialService → financialDao → one RPC.
//
// Guarantees:
//  * actor identity ONLY from the verified context; body actor/role/sub/digest/state
//    are never read;
//  * each handler reads ONLY its operation's permitted body fields;
//  * exactly one service call per request; NO automatic retry;
//  * success (fresh OR idempotent replay) → HTTP 200 with the service result intact
//    (never a 201 insertion inference, never a manufactured event id / idempotent);
//  * every failure → sanitized { ok:false, code } at the centrally-mapped status;
//  * raw IP comes from the server-managed req.ip (accepted proxy model), never body;
//    hashing/validation stay in the accepted service/ipSecurity layer.

const jwt = require('./jwt');
const dao = require('./dao');
const { statusForCode, UNAUTHENTICATED } = require('./financialHttpErrors');

const DEFAULT_PREFIX = '/api/financial';
// Inherited application body-parser limit (express.json() default). Documented so a
// future staging mount can pin it explicitly: express.json({ limit: JSON_BODY_LIMIT }).
const JSON_BODY_LIMIT = '100kb';
// DB-authoritative freshness-failure classifications (reuse the accepted B7A3 mapper).
const INACTIVE_CODE = 'AUTH_INITIATOR_INACTIVE';   // → 403
const ROLE_MISMATCH_CODE = 'AUTH_FORBIDDEN_ROLE';  // → 403

// Ordered route table — explicit, never client-selected.
const ROUTES = Object.freeze([
  { path: '/mark-paid', handler: 'markPaid' },
  { path: '/import-legacy-payment', handler: 'importLegacyPayment' },
  { path: '/refund', handler: 'refund' },
  { path: '/void', handler: 'voidOrder' },
]);

// Server-managed client IP only (Express honors its own trust-proxy setting). Never a
// body-supplied ip / ip_hash / forwarded-for chain. Raw value is passed to the service,
// which normalizes + HMAC-hashes it (B3) and never returns/logs it.
function extractClientIp(req) {
  if (req && typeof req.ip === 'string' && req.ip) return req.ip;
  if (req && req.socket && typeof req.socket.remoteAddress === 'string') return req.socket.remoteAddress;
  return null;
}

function bodyOf(req) {
  return req && req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
}

// One stable envelope. 200 + { ok:true, result } for any successful RPC execution
// (incl. replay); otherwise the centrally-mapped status + { ok:false, code }. Nothing
// else is ever emitted (no SQL text/host/digest/ip/meta/claims).
function sendResult(res, out, log) {
  if (out && out.ok === true) {
    if (log) log('ok', 200, null);
    return res.status(200).json({ ok: true, result: out.result });
  }
  const code = out && typeof out.code === 'string' ? out.code : 'FINANCIAL_INTERNAL_ERROR';
  const status = statusForCode(code);
  if (log) log('fail', status, code);
  return res.status(status).json({ ok: false, code });
}

const sendDeny = (res, code) => res.status(statusForCode(code)).json({ ok: false, code });
const send401 = (res) => res.status(401).json({ ok: false, code: UNAUTHENTICATED });

// Verify the Bearer JWT with the accepted B3 verifier, THEN prove the session is
// current against DB-authoritative actor state before attaching a trusted context.
// Cryptographic verification alone does NOT prove freshness: jwt.verifyToken checks
// signature/expiry/structure but never compares the claim `sv` to the live
// auth_actors.session_version, nor `active`, nor the DB role — so a revoked / PIN-
// changed / deactivated / role-changed token stays valid until natural expiry. This
// middleware closes that gap with ONE injected DB-authoritative read (no PIN, no
// pin_hash, no retry). Effective order:
//   Bearer extraction → JWT signature/expiry → DB session/actor freshness →
//   trusted context attach → handler → service.
// getActor(sub) → { role, active, session_version } (accepted B2 dao.getActor safe
// read, never pin_hash). Injected for offline tests. Failures fail CLOSED, sanitized.
function createAuthContextMiddleware(deps = {}) {
  const verifyToken = typeof deps.verifyToken === 'function' ? deps.verifyToken : jwt.verifyToken;
  const getActor = typeof deps.getActor === 'function'
    ? deps.getActor
    : (deps.sessionAuthority && typeof deps.sessionAuthority.getActor === 'function'
      ? (sub) => deps.sessionAuthority.getActor(sub)
      : dao.getActor);
  return async function authContextMiddleware(req, res, next) {
    // (1) Bearer extraction + cryptographic verification (B3). No independent decode.
    const raw = req && req.headers ? (req.headers.authorization || req.headers.Authorization) : null;
    const m = typeof raw === 'string' ? raw.match(/^Bearer (.+)$/) : null;
    const payload = m ? verifyToken(m[1]) : null;
    if (!payload || typeof payload.sub !== 'string' || typeof payload.role !== 'string' || !Number.isInteger(payload.sv)) {
      return send401(res); // missing / invalid / unverifiable token → 401
    }
    // (2) DB-authoritative freshness — exactly one read, no retry, no PIN.
    let row;
    try { row = await getActor(payload.sub); }
    catch (_) { return send401(res); } // ambiguous DB/transport failure → fail closed (401)
    if (!row || typeof row.session_version !== 'number' || typeof row.role !== 'string') {
      return send401(res); // actor missing / unusable identity → 401
    }
    if (row.active !== true) return sendDeny(res, INACTIVE_CODE);           // inactive → 403
    if (row.role !== payload.role) return sendDeny(res, ROLE_MISMATCH_CODE); // DB role ≠ token role → 403
    if (row.session_version !== payload.sv) return send401(res);            // stale session_version → 401
    // (3) trusted context from DB-authoritative values — never the raw JWT role, and
    // never anything from the request body.
    req.authContext = Object.freeze({ role: row.role, sub: payload.sub, sv: row.session_version });
    return next();
  };
}

// Intended sanitizing error middleware for the future staging mount. Converts the
// inherited express.json()/body-parser transport errors into a stable envelope with NO
// stack, NO raw body, NO parser message: malformed/oversize JSON can never mutate and
// never reaches auth/service. Mount AFTER express.json() and BEFORE the financial routes.
function financialJsonErrorHandler(err, req, res, next) {
  if (!err) return next();
  const tooLarge = err.status === 413 || err.statusCode === 413 || err.type === 'entity.too.large';
  if (tooLarge) return res.status(413).json({ ok: false, code: 'FINANCIAL_PAYLOAD_TOO_LARGE' });
  // parse failure / unsupported charset / any other body-parser error → safe 400
  return res.status(400).json({ ok: false, code: 'FINANCIAL_INVALID_REQUEST' });
}

function createFinancialHandlers(deps = {}) {
  const { service } = deps;
  const logger = deps.logger || null;

  const mkLog = (op, req) => (outcome, status, code) => {
    if (!logger || typeof logger.info !== 'function') return;
    // Safe operational fields only — never body reason/meta/ip/digest/amount/confirmation.
    try { logger.info({ op, status, outcome, code: code || null, authed: !!(req && req.authContext) }); } catch (_) { /* never throw from logging */ }
  };

  // context is guaranteed by the auth middleware; defensive fallback keeps the handler
  // safe even if mounted without it (still fails closed, never trusts the body).
  function context(req, res, op) {
    const ctx = req && req.authContext;
    if (!ctx || typeof ctx.sub !== 'string') {
      res.status(401).json({ ok: false, code: UNAUTHENTICATED });
      return null;
    }
    return ctx;
  }

  async function markPaid(req, res) {
    const log = mkLog('mark_paid', req);
    const ctx = context(req, res, 'mark_paid'); if (!ctx) return undefined;
    const b = bodyOf(req);
    const out = await service.markPaid({
      authContext: ctx,
      orderId: b.orderId, paymentMethod: b.paymentMethod, reason: b.reason,
      idempotencyKey: b.idempotencyKey, metadata: b.metadata,
      trustedClientIp: extractClientIp(req),
    });
    return sendResult(res, out, log);
  }

  async function importLegacyPayment(req, res) {
    const log = mkLog('import_legacy_payment', req);
    const ctx = context(req, res, 'import_legacy_payment'); if (!ctx) return undefined;
    const b = bodyOf(req);
    const out = await service.importLegacyPayment({
      authContext: ctx,
      orderId: b.orderId, amount: b.amount, paymentMethod: b.paymentMethod, reason: b.reason,
      confirmation: b.confirmation, idempotencyKey: b.idempotencyKey, metadata: b.metadata,
      trustedClientIp: extractClientIp(req),
    });
    return sendResult(res, out, log);
  }

  async function refund(req, res) {
    const log = mkLog('refund', req);
    const ctx = context(req, res, 'refund'); if (!ctx) return undefined;
    const b = bodyOf(req);
    const out = await service.refund({
      authContext: ctx,
      orderId: b.orderId, reason: b.reason, idempotencyKey: b.idempotencyKey, metadata: b.metadata,
      trustedClientIp: extractClientIp(req),
    });
    return sendResult(res, out, log);
  }

  async function voidOrder(req, res) {
    const log = mkLog('void', req);
    const ctx = context(req, res, 'void'); if (!ctx) return undefined;
    const b = bodyOf(req);
    const out = await service.voidOrder({
      authContext: ctx,
      orderId: b.orderId, reason: b.reason, idempotencyKey: b.idempotencyKey, metadata: b.metadata,
      trustedClientIp: extractClientIp(req),
    });
    return sendResult(res, out, log);
  }

  return { markPaid, importLegacyPayment, refund, voidOrder };
}

// Additive registration: mounts EXACTLY the four POST routes, each guarded by the auth
// middleware placed BEFORE the handler so no financial route is reachable unauthenticated.
// No wildcard/generic/action route; route names are static (never client-supplied).
function registerFinancialRoutes(app, deps = {}) {
  if (!app || typeof app.post !== 'function') throw new Error('registerFinancialRoutes: app.post required');
  if (!deps.service) throw new Error('registerFinancialRoutes: service required');
  const prefix = typeof deps.prefix === 'string' && deps.prefix ? deps.prefix : DEFAULT_PREFIX;
  const auth = createAuthContextMiddleware({
    verifyToken: deps.verifyToken, getActor: deps.getActor, sessionAuthority: deps.sessionAuthority,
  });
  const handlers = createFinancialHandlers({ service: deps.service, logger: deps.logger });
  const registered = [];
  for (const r of ROUTES) {
    app.post(prefix + r.path, auth, handlers[r.handler]);
    registered.push({ method: 'POST', path: prefix + r.path, handler: r.handler });
  }
  return Object.freeze({ prefix, routes: Object.freeze(registered) });
}

module.exports = {
  createFinancialHandlers,
  createAuthContextMiddleware,
  financialJsonErrorHandler,
  registerFinancialRoutes,
  extractClientIp,
  DEFAULT_PREFIX,
  JSON_BODY_LIMIT,
  ROUTES,
};
