'use strict';
// CHECK-CENTRIC UNIVERSAL CASH V1 — the check-centric cash service (Servicio/
// Banco/Retiro). Structural analogue of src/tables/mesaService.js's
// pay/refund/commercialAdjustment/sessionAccount, reusing the same primitives
// (sidHash, canonicalHash, requireContext shape, projectOrderFinancial) rather
// than reimplementing them. Mesa's own service/DAO/RPCs are not imported or
// touched here -- this is a parallel adapter against the SAME ledger, not a
// second payment engine.

const defaultDao = require('./cashDao');
const { sidHash: defaultSidHash } = require('../auth/sidHash');
const { canonicalHash, projectOrderFinancial } = require('../tables/mesaService');

class CashServiceError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'CashServiceError';
    this.code = code;
    this.status = status;
  }
}

// Preserves the EXISTING, narrower Servicio payment gate (order_mark_paid's
// own DB gate: admin, operator) -- does NOT inherit Mesa's broader
// PAYMENT_ROLES (owner/cashier/legacy_operator). Frozen brief §25: no
// authorization widening in this slice.
const ORDER_PAYMENT_ROLES = new Set(['admin', 'operator']);
// REFUND_ROLES / ADJUSTMENT_ROLES identical to Mesa's own sets -- same
// segregation-of-duties reasoning (the role that takes money is not the one
// that can silently return it or reduce what is owed).
const ORDER_REFUND_ROLES = new Set(['admin', 'owner']);
const ORDER_ADJUSTMENT_ROLES = new Set(['admin', 'owner']);
// Viewing the cash surface is not itself a money-moving action; kept no
// broader than the narrowest write gate plus owner, so nobody who could not
// already reach a Servicio order operationally gains a new capability here.
const CASH_VIEW_ROLES = new Set(['admin', 'operator', 'owner']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireContext(context, allowed) {
  if (!context || typeof context.actor !== 'string' || typeof context.workspaceId !== 'string') {
    throw new CashServiceError('CASH_UNAUTHENTICATED', 401);
  }
  if (!allowed.has(context.role)) throw new CashServiceError('CASH_FORBIDDEN', 403);
  return context;
}

function requireSidHash(ctx, hashSid) {
  if (typeof ctx.sid !== 'string' || !ctx.sid) throw new CashServiceError('CASH_RELOGIN_REQUIRED', 401);
  const bySidHash = hashSid(ctx.sid);
  if (typeof bySidHash !== 'string' || !/^[0-9a-f]{64}$/.test(bySidHash)) {
    throw new CashServiceError('CASH_RELOGIN_REQUIRED', 401);
  }
  return bySidHash;
}

// cents -> euros, same convention as mesaService.js's own `money` helper
// (NOT a "round euros to 2dp" function -- every caller below passes cents).
const money = (value) => Math.round(value) / 100;

// The read model: reuses safeTicket-shaped facts already computed elsewhere
// (order_financial_events) rather than a new accounting projection (§18 of
// the brief). Distinguishes CANONICAL transaction-backed payments (visible in
// `payments`, refundable) from LEGACY event-only collection (visible in
// `legacyPayments`, display-only -- Refund V1 is structurally unavailable for
// them, §16/§T: no fabricated transaction, ever).
function buildCheckAccount(order, obligations, events, transactions) {
  const financial = projectOrderFinancial(order, obligations);
  const netCollectedCents = events.reduce((sum, e) =>
    sum + (e.type === 'refund' ? -1 : 1) * Math.round((Number(e.amount) || 0) * 100), 0);
  const currentCents = Math.round(financial.currentObligation * 100);
  const outstanding = money(Math.max(0, currentCents - netCollectedCents));
  const overCollected = money(Math.max(0, netCollectedCents - currentCents));
  const canonicalTxIds = new Set(transactions.map((t) => String(t.id)));
  const legacyPayments = events
    .filter((e) => e.type !== 'refund' && !(e.payment_transaction_id && canonicalTxIds.has(String(e.payment_transaction_id))))
    .map((e) => ({
      id: e.id, amount: Number(e.amount), method: e.payment_method, createdAt: e.created_at,
      legacy: true, refundable: false,
    }));
  return {
    orderUid: order.order_uid,
    displayOrderId: order.id,
    estado: order.estado,
    total: financial.currentObligation,
    paid: money(netCollectedCents),
    outstanding,
    overCollected,
    commands: [{
      id: order.id,
      orderUid: order.order_uid,
      // No "comanda number" concept for a standalone check; the display order
      // id ("#999035") is the closest equivalent MesaCommercialAdjustments'
      // existing "Comanda {commandNumber}" copy can render meaningfully.
      commandNumber: order.id,
      state: order.estado,
      financial,
    }],
    payments: transactions.map((tx) => ({
      id: tx.id, kind: tx.kind, mode: tx.mode, amount: Number(tx.amount),
      method: tx.payment_method, coversSettled: tx.covers_settled,
      actor: tx.by_actor, createdAt: tx.created_at,
      reversesTransactionId: tx.reverses_transaction_id || null,
    })),
    legacyPayments,
  };
}

function createCashService({ dao = defaultDao, hashSid = defaultSidHash } = {}) {
  return Object.freeze({
    async checkAccount({ context, orderUid } = {}) {
      const ctx = requireContext(context, CASH_VIEW_ROLES);
      if (typeof orderUid !== 'string' || !UUID_RE.test(orderUid)) {
        throw new CashServiceError('CASH_INVALID_REQUEST', 400);
      }
      const order = await dao.getOrderByUid(orderUid);
      if (!order) throw new CashServiceError('CASH_ORDER_NOT_FOUND', 404);
      if (order.table_session_id) throw new CashServiceError('CASH_ORDER_IS_TABLE_ORDER', 400);
      const [obligations, events, transactions] = await Promise.all([
        dao.listObligations(orderUid),
        dao.listFinancialEvents(order.service_session_id, order.id),
        dao.listCanonicalTransactions(orderUid),
      ]);
      return { ok: true, ...buildCheckAccount(order, obligations, events, transactions) };
    },

    // Direct structural analogue of mesaService.pay -- full/custom_amount
    // only (no covers, no line selection: Banco/Retiro has neither).
    async pay({ context, orderUid, paymentMethod, mode, amount, clientRequestId, confirmDuplicate } = {}) {
      const ctx = requireContext(context, ORDER_PAYMENT_ROLES);
      const bySidHash = requireSidHash(ctx, hashSid);
      if (typeof orderUid !== 'string' || !UUID_RE.test(orderUid)) {
        throw new CashServiceError('CASH_INVALID_REQUEST', 400);
      }
      const semantic = {
        orderUid, paymentMethod, mode,
        amount: amount == null ? null : Number(amount),
      };
      return dao.postPayment({
        workspaceId: ctx.workspaceId, byActor: ctx.actor, bySidHash,
        ...semantic, clientRequestId, requestHash: canonicalHash(semantic),
        meta: { source: 'servicio_dashboard' },
        confirmDuplicate: confirmDuplicate === true,
      });
    },

    // Refund V1 adapter -- method is forced from the original transaction
    // inside the RPC; amount:null means "the full currently-refundable
    // remainder", exactly like Mesa's refund.
    async refund({ context, orderUid, originalTransactionId, amount, reason, clientRequestId } = {}) {
      const ctx = requireContext(context, ORDER_REFUND_ROLES);
      const bySidHash = requireSidHash(ctx, hashSid);
      if (typeof orderUid !== 'string' || !UUID_RE.test(orderUid)) {
        throw new CashServiceError('CASH_INVALID_REQUEST', 400);
      }
      const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
      if (!trimmedReason) throw new CashServiceError('ORDER_REFUND_REASON_REQUIRED', 400);
      const semantic = {
        orderUid, originalTransactionId,
        amount: amount == null ? null : Number(amount),
        reason: trimmedReason,
      };
      return dao.postRefund({
        workspaceId: ctx.workspaceId, byActor: ctx.actor, bySidHash,
        ...semantic, clientRequestId, requestHash: canonicalHash(semantic),
        meta: { source: 'servicio_dashboard' },
      });
    },

    // Corregir importe adapter -- changes the OBLIGATION only, never a
    // payment_transactions row. Target is the PERMANENT order_uid.
    async commercialAdjustment({ context, orderUid, newGross, reason, expectedCurrentGross, clientRequestId } = {}) {
      const ctx = requireContext(context, ORDER_ADJUSTMENT_ROLES);
      const bySidHash = requireSidHash(ctx, hashSid);
      if (typeof orderUid !== 'string' || !UUID_RE.test(orderUid)) {
        throw new CashServiceError('CASH_INVALID_REQUEST', 400);
      }
      const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
      if (!trimmedReason) throw new CashServiceError('ORDER_ADJUSTMENT_REASON_REQUIRED', 400);
      const gross = Number(newGross);
      if (!Number.isFinite(gross) || gross < 0) {
        throw new CashServiceError('ORDER_ADJUSTMENT_INVALID', 400);
      }
      const semantic = {
        orderUid, newGross: gross, reason: trimmedReason,
        expectedCurrentGross: expectedCurrentGross == null ? null : Number(expectedCurrentGross),
      };
      return dao.postCommercialAdjustment({
        workspaceId: ctx.workspaceId, byActor: ctx.actor, bySidHash,
        ...semantic, clientRequestId, requestHash: canonicalHash(semantic),
        meta: { source: 'servicio_dashboard' },
      });
    },
  });
}

module.exports = {
  createCashService, CashServiceError, buildCheckAccount,
  ORDER_PAYMENT_ROLES, ORDER_REFUND_ROLES, ORDER_ADJUSTMENT_ROLES, CASH_VIEW_ROLES,
};
