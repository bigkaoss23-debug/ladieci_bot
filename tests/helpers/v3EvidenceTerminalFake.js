"use strict";
// CORRECTIVE SLICE 150 -- a unit-test model of the V3 close's terminal step (close_service_session_with_evidence_v1),
// built on the fakes a test already has, so every existing assertion on create / persist / close calls keeps its meaning.
//
// withEvidenceTerminal(deps, hooks) returns the engine dependencies with:
//   - select: payment_transactions answered by hooks.receipts(query) (default: no receipt);
//   - reconciliation.buildRpcArgs: the arguments the engine hands to the terminal step (default: a marker object);
//   - transition.closeWithEvidence: modelled on the SQL of migration 150 --
//       1. a closed service delegates to the test's closeAndCompleteAttempt (the 149 ALREADY_CLOSED rule);
//       2. hooks.isStale(args) -> ['service_facts' | 'receipts'] = CLOSE_EVIDENCE_STALE, NOTHING written;
//       3. closeout (when given) through the test's closeoutCreation.create, reconciliation through its persist, then its
//          closeAndCompleteAttempt; ANY refusal rolls the whole step back (hooks.rollbackCloseout(created) undoes the fake
//          closeout, as the database transaction does) and reports that refusal;
//       4. success returns the raw closeout row (closeoutRow) and the reconciliation row (reconciliationRow).
// Calls are recorded in hooks.calls.terminal when hooks.calls is given.

const ARG_TO_FIELD = {
  p_service_session_id: "serviceSessionId", p_closeout_correlation_id: "closeoutCorrelationId", p_closed_by: "closedBy", p_source: "source",
  p_close_reason: "closeReason", p_gross_sales_cents: "grossSalesCents", p_net_sales_cents: "netSalesCents", p_total_refunds_cents: "totalRefundsCents",
  p_total_void_cents: "totalVoidCents", p_paid_amount_cents: "paidAmountCents", p_unpaid_exposure_cents: "unpaidExposureCents", p_order_count: "orderCount",
  p_cash_amount_cents: "cashAmountCents", p_card_amount_cents: "cardAmountCents", p_bizum_amount_cents: "bizumAmountCents", p_other_amount_cents: "otherAmountCents",
  p_open_orders_at_close: "openOrdersAtClose", p_occupied_tables_at_close: "occupiedTablesAtClose", p_kitchen_pending_count: "kitchenPendingCount",
  p_listo_count: "listoCount", p_delivery_pending_count: "deliveryPendingCount", p_incident_count: "incidentCount",
  p_critical_incident_count: "criticalIncidentCount", p_current_obligation_cents: "currentObligationCents", p_over_collected_cents: "overCollectedCents",
};

function closeoutFieldsFromArgs(args) {
  const out = {};
  for (const [k, v] of Object.entries(args || {})) if (ARG_TO_FIELD[k]) out[ARG_TO_FIELD[k]] = v;
  return out;
}

// the inverse of serviceCloseouts.publicCloseout, for a fake that stores public (camelCase) rows
function rawCloseout(row) {
  if (!row || typeof row !== "object") return null;
  if (row.service_session_id) return row;
  const f = row.financial || {}; const o = row.operational || {};
  return {
    id: row.id, service_session_id: row.serviceSessionId, closeout_correlation_id: row.closeoutCorrelationId, business_date: row.businessDate,
    service_kind: row.serviceKind, opened_at: row.openedAt, closed_at: row.closedAt, close_source: row.closeSource, close_reason: row.closeReason,
    closed_by: row.closedBy, gross_sales_cents: f.grossSalesCents, total_discounts_cents: f.totalDiscountsCents, total_refunds_cents: f.totalRefundsCents,
    total_void_cents: f.totalVoidCents, paid_amount_cents: f.paidAmountCents, unpaid_exposure_cents: f.unpaidExposureCents, order_count: f.orderCount,
    cash_amount_cents: f.cashAmountCents, card_amount_cents: f.cardAmountCents, bizum_amount_cents: f.bizumAmountCents, other_amount_cents: f.otherAmountCents,
    current_obligation_cents: f.currentObligationCents, over_collected_cents: f.overCollectedCents,
    open_orders_at_close: o.openOrdersAtClose, occupied_tables_at_close: o.occupiedTablesAtClose, kitchen_pending_count: o.kitchenPendingCount,
    listo_count: o.listoCount, delivery_pending_count: o.deliveryPendingCount, incident_count: o.incidentCount, critical_incident_count: o.criticalIncidentCount,
  };
}

function withEvidenceTerminal(deps, hooks = {}) {
  const baseSelect = deps.select;
  const baseTransition = deps.transition || {};
  const baseReconciliation = deps.reconciliation || {};
  const closeoutCreation = deps.closeoutCreation;
  const select = async (table, query) => {
    if (table === "payment_transactions") return hooks.receipts ? hooks.receipts(query) : [];
    return baseSelect(table, query);
  };
  const reconciliation = {
    ...baseReconciliation,
    buildRpcArgs: baseReconciliation.buildRpcArgs || (async ({ serviceSessionId, closeoutCorrelationId, actor }) => (
      hooks.reconciliationBuildFails
        ? { success: false, code: hooks.reconciliationBuildFails }
        : { success: true, args: { p_service_session_id: serviceSessionId, p_closeout_correlation_id: closeoutCorrelationId, p_actor: actor, fake: true } })),
  };
  const transition = {
    ...baseTransition,
    async closeWithEvidence(args) {
      const { serviceSessionId, closeoutCorrelationId, actor, source, closeout, reconciliation: reconArgs } = args;
      if (hooks.calls) (hooks.calls.terminal = hooks.calls.terminal || []).push({ serviceSessionId, closeoutCorrelationId, withCloseout: !!closeout, withReconciliation: !!reconArgs, receiptIds: args.receiptIds });
      if (hooks.terminalTransportFailure && hooks.terminalTransportFailure()) {
        return { success: false, code: "SERVICE_LIFECYCLE_V3_TRANSITION_TRANSPORT_ERROR", session: null };
      }
      if (hooks.isClosed && hooks.isClosed(serviceSessionId)) {
        return baseTransition.closeAndCompleteAttempt({ serviceSessionId, closeoutCorrelationId, actor, source });
      }
      const stale = hooks.isStale ? hooks.isStale(args) : null;
      if (Array.isArray(stale) && stale.length > 0) {
        return { success: false, code: "CLOSE_EVIDENCE_STALE", stale, closeoutCommitted: !closeout, session: null };
      }
      let created = null;
      if (closeout) {
        const c = await closeoutCreation.create(closeoutFieldsFromArgs(closeout));
        if (!c || c.success !== true) return { success: false, code: (c && c.code) || "SERVICE_CLOSEOUT_CREATE_FAILED", session: null };
        created = c.created === false ? null : c.closeout;
        if (c.created === false) hooks.existingCloseout = c.closeout;
      }
      let recon = null;
      if (reconArgs && typeof baseReconciliation.persist === "function") {
        recon = await baseReconciliation.persist({ serviceSessionId, closeoutCorrelationId, actor });
        if (!recon || recon.success !== true) {
          if (created && hooks.rollbackCloseout) hooks.rollbackCloseout(created);
          return { success: false, code: (recon && recon.code) || "RECONCILIATION_PERSIST_FAILED", session: null };
        }
      }
      const t = await baseTransition.closeAndCompleteAttempt({ serviceSessionId, closeoutCorrelationId, actor, source });
      if (!t || t.success !== true) {
        // a refusal rolls the whole step back; a failure whose close DID commit (a response lost after the commit) keeps it
        const committed = hooks.isClosed ? hooks.isClosed(serviceSessionId) : false;
        if (created && hooks.rollbackCloseout && !committed) hooks.rollbackCloseout(created);
        return t;
      }
      const row = created || hooks.existingCloseout || (hooks.closeoutOf ? hooks.closeoutOf(serviceSessionId) : null);
      return { ...t, closeoutRow: rawCloseout(row), reconciliationRow: recon ? recon.reconciliation : null };
    },
  };
  return { ...deps, select, reconciliation, transition };
}

module.exports = { withEvidenceTerminal, rawCloseout, closeoutFieldsFromArgs };
