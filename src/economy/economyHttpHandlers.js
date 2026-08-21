'use strict';
// ===============================================================
// economyHttpHandlers.js — I-1 the /api/economy/v1 surface.
//
// Three routes. Two of them are GETs that read; the third writes exactly one
// append-only row. There is no route here that can close, open or otherwise
// disturb an Operational Service, and there is no RPC call anywhere in this
// module.
//
// AUTH mirrors the Mesa router (createMesaAuthMiddleware): a verified JWT plus
// a fresh read of the authoritative actor row, so a revoked or role-changed
// operator cannot act on a token minted before the change. The actor identity
// this produces is the ONLY source of attribution for a cash count.
// ===============================================================

const jwt = require('../auth/jwt');
const { getAuthoritativeActor } = require('../auth/accessManagementHttpDaoV3');
const { createEconomicSnapshot } = require('./economicSnapshot');
const { createCashCountService, CashCountError } = require('./cashCountService');
const { createCloseoutReconciliation, ReconciliationError } = require('./closeoutReconciliation');
const { EconomicWindowError } = require('./economicWindow');

// ROLE GATE. Both sets are exactly mesaService.js's PAYMENT_ROLES — the set
// this repo already treats as "trusted with money". Reusing it deliberately:
// this slice is not the place to invent a new authority boundary, and anyone
// already trusted to take a customer's payment is trusted to read the day's
// economy and to say what was in the drawer. `waiter`, `shift_manager` and
// `rider` are excluded for the same reason they are excluded from taking
// payments. Note the live owner's ROLE is 'admin' (actor 'owner'), so 'admin'
// must be present or the owner is locked out of their own economy.
const READ_ROLES = new Set(['admin', 'operator', 'owner', 'cashier', 'legacy_operator']);
const COUNT_ROLES = new Set(['admin', 'operator', 'owner', 'cashier', 'legacy_operator']);

function safeError(error) {
  if (error instanceof CashCountError || error instanceof EconomicWindowError
      || error instanceof ReconciliationError) {
    return { status: error.status || 400, code: error.code };
  }
  const code = typeof error?.code === 'string' && /^(ECONOMY|RECONCILIATION)_[A-Z0-9_]+$/.test(error.code)
    ? error.code : 'ECONOMY_INTERNAL_ERROR';
  return { status: code === 'ECONOMY_INTERNAL_ERROR' ? 500 : 400, code };
}

function createEconomyAuthMiddleware({ verifyToken = jwt.verifyToken, getActor = getAuthoritativeActor } = {}) {
  return async function economyAuth(req, res, next) {
    const raw = req?.headers?.authorization || req?.headers?.Authorization;
    const match = typeof raw === 'string' ? raw.match(/^Bearer\s+(.+)$/i) : null;
    let payload = null;
    try { payload = match ? verifyToken(match[1]) : null; } catch (_) { payload = null; }
    if (!payload || typeof payload.sub !== 'string' || typeof payload.role !== 'string'
        || !Number.isInteger(payload.sv)) {
      return res.status(401).json({ ok: false, code: 'ECONOMY_UNAUTHENTICATED' });
    }
    let actor;
    try { actor = await getActor(payload.sub); }
    catch (_) { return res.status(500).json({ ok: false, code: 'ECONOMY_AUTHORITY_UNAVAILABLE' }); }
    if (!actor || actor.active !== true || actor.role !== payload.role
        || actor.session_version !== payload.sv || typeof actor.workspace_id !== 'string') {
      return res.status(401).json({ ok: false, code: 'ECONOMY_SESSION_STALE' });
    }
    req.economyContext = Object.freeze({
      actor: actor.actor,
      role: actor.role,
      workspaceId: actor.workspace_id,
      sessionVersion: actor.session_version,
    });
    return next();
  };
}

function requireRole(allowed, code) {
  return function roleGate(req, res, next) {
    if (!allowed.has(String(req?.economyContext?.role || ''))) {
      return res.status(403).json({ ok: false, code });
    }
    return next();
  };
}

function createEconomyHandlers({
  snapshot = createEconomicSnapshot(),
  cashCounts = createCashCountService(),
  reconciliation = createCloseoutReconciliation(),
  logger = console,
} = {}) {
  const run = (operation, fn) => async (req, res) => {
    try {
      return res.status(200).json(await fn(req));
    } catch (error) {
      const mapped = safeError(error);
      try { logger.warn({ component: 'economy', operation, outcome: 'error', code: mapped.code }); } catch (_) {}
      return res.status(mapped.status).json({ ok: false, code: mapped.code });
    }
  };

  // Query params are strings; the reader owns all validation and refuses
  // anything it cannot resolve rather than silently widening the window.
  const windowParams = (req) => ({
    preset: req.query?.preset,
    from: req.query?.from,
    to: req.query?.to,
    businessDate: req.query?.businessDate,
    asOf: req.query?.asOf,
    serviceSessionId: req.query?.serviceSessionId,
  });

  return Object.freeze({
    snapshot: run('snapshot', (req) => snapshot(windowParams(req))),
    // J-1 — the Finalizar preflight. READ-ONLY: it returns the two scopes
    // (this service, and its Business Day) side by side plus whichever cash
    // count is legitimately comparable, and writes nothing. Persisting the
    // context is the close engine's job, not this route's.
    reconciliation: run('reconciliation', (req) => reconciliation.build({
      serviceSessionId: req.query?.serviceSessionId,
    })),
    listCashCounts: run('cash_counts_list', (req) => cashCounts.list({
      context: req.economyContext,
      from: req.query?.from,
      to: req.query?.to,
      limit: req.query?.limit,
    })),
    createCashCount: run('cash_count_create', (req) => cashCounts.create({
      // From the token. Any actor named in the body is ignored entirely.
      context: req.economyContext,
      preset: req.body?.preset,
      from: req.body?.from,
      to: req.body?.to,
      businessDate: req.body?.businessDate,
      serviceSessionId: req.body?.serviceSessionId,
      countedCash: req.body?.countedCash,
      note: req.body?.note,
      clientRequestId: req.body?.clientRequestId,
    })),
  });
}

function registerEconomyRoutes(router, deps = {}) {
  const handlers = createEconomyHandlers(deps);
  const auth = createEconomyAuthMiddleware(deps);
  const canRead = requireRole(READ_ROLES, 'ECONOMY_READ_FORBIDDEN');
  const canCount = requireRole(COUNT_ROLES, 'ECONOMY_CASH_COUNT_FORBIDDEN');
  router.get('/snapshot', auth, canRead, handlers.snapshot);
  router.get('/reconciliation', auth, canRead, handlers.reconciliation);
  router.get('/cash-counts', auth, canRead, handlers.listCashCounts);
  router.post('/cash-counts', auth, canCount, handlers.createCashCount);
  // There is no PUT, PATCH or DELETE on this router, and there must never be:
  // a recorded count is history. A mistaken count is corrected by recording a
  // new one, which is why the table refuses UPDATE and DELETE outright.
  return Object.freeze({ routes: 4 });
}

module.exports = {
  READ_ROLES, COUNT_ROLES, safeError,
  createEconomyAuthMiddleware, createEconomyHandlers, registerEconomyRoutes,
};
