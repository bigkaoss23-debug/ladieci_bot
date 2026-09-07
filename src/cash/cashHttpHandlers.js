'use strict';
// CHECK-CENTRIC UNIVERSAL CASH V1 — HTTP surface for the check-centric cash
// service. Structural analogue of src/tables/mesaHttpHandlers.js: same JWT
// Bearer auth shape, same actor-freshness re-check against the authoritative
// DB row, same run()/safeError() error-mapping pattern -- a parallel router
// for a parallel target (a check instead of a table session), not a second
// auth mechanism.

const jwt = require('../auth/jwt');
const { getAuthoritativeActor } = require('../auth/accessManagementHttpDaoV3');
const { createCashService, CashServiceError } = require('./cashService');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function safeError(error) {
  if (error instanceof CashServiceError) {
    return { status: error.status, code: error.code };
  }
  // The check-centric writers raise ORDER_* codes (order_post_payment_v1,
  // order_post_refund_v1, order_apply_commercial_adjustment_v1); the shared
  // core they delegate to (order_obligation_apply_adjustment_v1) still raises
  // its own pre-existing MESA_ADJUSTMENT_* vocabulary (§15 of the brief: reuse,
  // not rename). Both are admitted; anything else collapses to a 500.
  const code = typeof error?.code === 'string' && /^(CASH|ORDER|MESA)_[A-Z0-9_]+$/.test(error.code)
    ? error.code : 'CASH_INTERNAL_ERROR';
  const conflict = new Set([
    'ORDER_PAYMENT_ALREADY_SETTLED', 'ORDER_PAYMENT_POSSIBLE_DUPLICATE',
    'ORDER_PAYMENT_IDEMPOTENCY_CONFLICT', 'ORDER_REFUND_ALREADY_FULL',
    'ORDER_REFUND_EXCEEDS_REMAINING', 'ORDER_REFUND_NOT_REFUNDABLE',
    'ORDER_REFUND_NOT_CHECK_CENTRIC', 'ORDER_REFUND_TRANSACTION_MISMATCH',
    'ORDER_REFUND_IDEMPOTENCY_CONFLICT', 'ORDER_ADJUSTMENT_NO_CHANGE',
    'MESA_ADJUSTMENT_EXCEEDS_OBLIGATION', 'MESA_ADJUSTMENT_STALE_OBLIGATION',
    'MESA_ADJUSTMENT_IDEMPOTENCY_CONFLICT',
  ]);
  const denied = new Set(['ORDER_PAYMENT_FORBIDDEN', 'ORDER_REFUND_FORBIDDEN', 'ORDER_ADJUSTMENT_FORBIDDEN']);
  const missing = new Set([
    'ORDER_PAYMENT_ORDER_NOT_FOUND', 'ORDER_REFUND_ORDER_NOT_FOUND', 'ORDER_ADJUSTMENT_ORDER_NOT_FOUND',
    'ORDER_REFUND_TRANSACTION_NOT_FOUND', 'CASH_ORDER_NOT_FOUND', 'MESA_ADJUSTMENT_ORDER_NOT_FOUND',
  ]);
  let status = 400;
  if (conflict.has(code)) status = 409;
  else if (denied.has(code)) status = 403;
  else if (missing.has(code)) status = 404;
  else if (code === 'CASH_INTERNAL_ERROR') status = 500;
  return { status, code };
}

function createCashAuthMiddleware({ verifyToken = jwt.verifyToken, getActor = getAuthoritativeActor } = {}) {
  return async function cashAuth(req, res, next) {
    const raw = req?.headers?.authorization || req?.headers?.Authorization;
    const match = typeof raw === 'string' ? raw.match(/^Bearer\s+(.+)$/i) : null;
    const payload = match ? verifyToken(match[1]) : null;
    if (!payload || typeof payload.sub !== 'string' || typeof payload.role !== 'string'
        || !Number.isInteger(payload.sv)) {
      return res.status(401).json({ ok: false, code: 'CASH_UNAUTHENTICATED' });
    }
    let actor;
    try { actor = await getActor(payload.sub); }
    catch (_) { return res.status(500).json({ ok: false, code: 'CASH_AUTHORITY_UNAVAILABLE' }); }
    if (!actor || actor.active !== true || actor.role !== payload.role
        || actor.session_version !== payload.sv || typeof actor.workspace_id !== 'string') {
      return res.status(401).json({ ok: false, code: 'CASH_SESSION_STALE' });
    }
    req.cashContext = Object.freeze({
      actor: actor.actor,
      role: actor.role,
      workspaceId: actor.workspace_id,
      sessionVersion: actor.session_version,
      sid: typeof payload.sid === 'string' ? payload.sid : null,
    });
    return next();
  };
}

function createCashHandlers({ service = createCashService(), logger = console } = {}) {
  const run = (operation, fn) => async (req, res) => {
    try {
      const body = await fn(req);
      return res.status(200).json(body);
    } catch (error) {
      const mapped = safeError(error);
      try { logger.warn({ component: 'cash', operation, outcome: 'error', code: mapped.code }); } catch (_) {}
      return res.status(mapped.status).json({ ok: false, code: mapped.code });
    }
  };
  const requireOrderUid = (value) => {
    if (typeof value !== 'string' || !UUID.test(value)) throw new CashServiceError('CASH_INVALID_ID', 400);
    return value;
  };
  const requestId = (body) => {
    const value = body?.clientRequestId;
    if (typeof value !== 'string' || value.length < 8 || value.length > 128 || !/^[A-Za-z0-9_-]+$/.test(value)) {
      throw new CashServiceError('CASH_CLIENT_REQUEST_ID_INVALID', 400);
    }
    return value;
  };

  return Object.freeze({
    checkAccount: run('check_account', (req) => service.checkAccount({
      context: req.cashContext,
      orderUid: requireOrderUid(req.params.orderUid),
    })),
    pay: run('pay', (req) => service.pay({
      context: req.cashContext,
      orderUid: requireOrderUid(req.params.orderUid),
      paymentMethod: req.body?.paymentMethod,
      mode: req.body?.mode,
      amount: req.body?.amount,
      clientRequestId: requestId(req.body),
      confirmDuplicate: req.body?.confirmDuplicate,
    })),
    refund: run('refund', (req) => service.refund({
      context: req.cashContext,
      orderUid: requireOrderUid(req.params.orderUid),
      originalTransactionId: req.body?.originalTransactionId,
      amount: req.body?.amount,
      reason: req.body?.reason,
      clientRequestId: requestId(req.body),
    })),
    commercialAdjustment: run('commercial_adjustment', (req) => service.commercialAdjustment({
      context: req.cashContext,
      orderUid: requireOrderUid(req.params.orderUid),
      newGross: req.body?.newGross,
      reason: req.body?.reason,
      expectedCurrentGross: req.body?.expectedCurrentGross,
      clientRequestId: requestId(req.body),
    })),
  });
}

function registerCashRoutes(router, deps = {}) {
  const handlers = createCashHandlers(deps);
  const auth = createCashAuthMiddleware(deps);
  router.get('/checks/:orderUid', auth, handlers.checkAccount);
  router.post('/checks/:orderUid/payments', auth, handlers.pay);
  router.post('/checks/:orderUid/refunds', auth, handlers.refund);
  router.post('/checks/:orderUid/adjustments', auth, handlers.commercialAdjustment);
  return Object.freeze({ routes: 4 });
}

module.exports = {
  createCashAuthMiddleware, createCashHandlers, registerCashRoutes, safeError,
};
