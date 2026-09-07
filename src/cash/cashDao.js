'use strict';
// CHECK-CENTRIC UNIVERSAL CASH V1 — data access for the check-centric cash
// surface (Servicio/Banco/Retiro). Same primitives mesaDao.js already uses
// (sbRest via ../auth/audit) — this is a parallel DAO for a parallel target
// (a check/order_uid instead of a table session), not a second transport.

const { AuthDaoError, sbRest } = require('../auth/audit');

function idsFilter(ids) {
  const values = [...new Set((ids || []).map(String).filter(Boolean))];
  return values.length ? `in.(${values.map(encodeURIComponent).join(',')})` : null;
}

async function select(resource, query) {
  const response = await sbRest('GET', resource, { query });
  if (!response.ok || !Array.isArray(response.body)) {
    throw new AuthDaoError('CASH_DATA_READ_FAILED', `read failed: ${resource}`);
  }
  return response.body;
}

async function rpc(name, body) {
  const response = await sbRest('POST', `rpc/${name}`, { body });
  if (!response.ok) {
    const rawCode = response.body && typeof response.body.message === 'string'
      ? response.body.message.trim() : '';
    const error = new AuthDaoError(rawCode || 'CASH_DATA_WRITE_FAILED', 'Cash RPC failed');
    error.status = response.status;
    error.pgDetail = response.body && typeof response.body.details === 'string'
      ? response.body.details : null;
    throw error;
  }
  return response.body;
}

// Resolves the check by its permanent identity. Returns null if it does not
// exist. Callers must reject a non-null table_session_id themselves (a Mesa
// order routed here by mistake) -- this DAO does not decide policy.
async function getOrderByUid(orderUid) {
  const rows = await select('ordenes',
    `select=id,order_uid,estado,totale,service_session_id,table_session_id,cobrado,ya_pagado,metodo_pago`
    + `&order_uid=eq.${encodeURIComponent(orderUid)}`);
  return rows[0] || null;
}

async function listObligations(orderUid) {
  return select('order_obligations',
    `select=order_uid,order_id,revision,gross_amount,cause,reason,created_at`
    + `&order_uid=eq.${encodeURIComponent(orderUid)}&order=revision.asc`);
}

// Every payment/refund/import/legacy-collection fact for this order, scoped by
// (service_session_id, order_id) exactly as safeTicket/mesaService read it --
// this is what makes a legacy event-only collection (payment_transaction_id
// NULL) visible here even though it has no payment_transactions row.
async function listFinancialEvents(serviceSessionId, orderId) {
  return select('order_financial_events',
    `select=id,order_id,type,amount,payment_method,payment_transaction_id,created_at,prev_pay_state,new_pay_state`
    + `&service_session_id=eq.${encodeURIComponent(serviceSessionId)}`
    + `&order_id=eq.${encodeURIComponent(orderId)}`
    + `&type=in.(payment,payment_imported,refund)&order=created_at.asc`);
}

// Canonical, transaction-backed payments/refunds for this check ONLY (never a
// legacy event-only row -- those have no payment_allocations at all). One
// allocation per check-centric transaction (§8/§11/§28 of the brief), so the
// allocation list and the transaction list are the same length.
async function listCanonicalTransactions(orderUid) {
  const allocations = await select('payment_allocations',
    `select=id,payment_transaction_id,order_id,order_uid,amount,created_at`
    + `&order_uid=eq.${encodeURIComponent(orderUid)}&order=created_at.asc`);
  const txFilter = idsFilter(allocations.map((a) => a.payment_transaction_id));
  const transactions = txFilter
    ? await select('payment_transactions',
      `select=id,kind,mode,amount,payment_method,covers_settled,reverses_transaction_id,by_actor,created_at`
      + `&id=${txFilter}&order=created_at.asc`)
    : [];
  return transactions;
}

const postPayment = (args) => rpc('order_post_payment_v1', {
  p_workspace_id: args.workspaceId,
  p_by_actor: args.byActor,
  p_by_sid_hash: args.bySidHash,
  p_order_uid: args.orderUid,
  p_payment_method: args.paymentMethod,
  p_mode: args.mode,
  p_amount: args.amount ?? null,
  p_client_request_id: args.clientRequestId,
  p_request_hash: args.requestHash,
  p_meta: args.meta || {},
  p_confirm_duplicate: args.confirmDuplicate === true,
});

const postRefund = (args) => rpc('order_post_refund_v1', {
  p_workspace_id: args.workspaceId,
  p_by_actor: args.byActor,
  p_by_sid_hash: args.bySidHash,
  p_order_uid: args.orderUid,
  p_original_transaction_id: args.originalTransactionId,
  p_reason: args.reason,
  p_client_request_id: args.clientRequestId,
  p_request_hash: args.requestHash,
  p_amount: args.amount ?? null,
  p_meta: args.meta || {},
});

const postCommercialAdjustment = (args) => rpc('order_apply_commercial_adjustment_v1', {
  p_workspace_id: args.workspaceId,
  p_by_actor: args.byActor,
  p_by_sid_hash: args.bySidHash,
  p_order_uid: args.orderUid,
  p_new_gross: args.newGross,
  p_reason: args.reason,
  p_client_request_id: args.clientRequestId,
  p_request_hash: args.requestHash,
  p_expected_current_gross: args.expectedCurrentGross ?? null,
  p_meta: args.meta || {},
});

module.exports = {
  getOrderByUid,
  listObligations,
  listFinancialEvents,
  listCanonicalTransactions,
  postPayment,
  postRefund,
  postCommercialAdjustment,
};
