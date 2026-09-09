"use strict";
// ===============================================================
// serviceCloseouts.js — SERVICE LIFECYCLE V3 / Slice 3.1
//
// Read-only wrapper over service_closeouts (see
// migrations/2026-08-09_service_lifecycle_v3_foundation.sql), mirroring the
// style of closeoutSnapshots.js: normalize the transport shape once, expose
// a small typed surface.
//
// No write method exists here on purpose. service_closeouts has no RPC in
// Slice 3.1 (schema-only — see the migration header): computing the
// financial/operational totals a real closeout row needs is V3.2's close
// engine, not this module's job. This file exists only so a future report/
// dashboard reader (and this slice's own tests) has a typed read surface,
// per the V3.1 plan's "DAO/read structures if genuinely needed by tests".
// ===============================================================

const { sbSelect } = require("../utils/supabase");

function publicCloseout(row) {
  if (!row || typeof row !== "object") return null;
  return {
    id: row.id,
    serviceSessionId: row.service_session_id,
    closeoutCorrelationId: row.closeout_correlation_id,
    businessDate: row.business_date,
    serviceKind: row.service_kind,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    closeSource: row.close_source,
    closeReason: row.close_reason || null,
    closedBy: row.closed_by,
    financial: {
      grossSalesCents: row.gross_sales_cents,
      // SERVICE_CLOSEOUT_NET_SALES_LEGACY_CONTRACT_HARDENING_V1 (2026-09-09) --
      // net_sales_cents is a LEGACY/HISTORICAL column: max(0, gross_sales_cents -
      // total_refunds_cents) off the ORIGINAL order gross, ignoring commercial
      // adjustments. It is NOT the current obligation, NOT the net collected,
      // NOT an accounting/taxable authority. It is deliberately NOT projected
      // onto the public closeout object so no HTTP consumer can bind to it (it
      // used to reach the client via the service-close response — index.js
      // res.json). The DB column, its formula and the RPC writer are all
      // unchanged -- see migration 125 and
      // SERVICE_CLOSEOUT_NET_SALES_LEGACY_SEMANTICS_V1_AUDIT.md.
      totalDiscountsCents: row.total_discounts_cents,
      totalRefundsCents: row.total_refunds_cents,
      totalVoidCents: row.total_void_cents,
      paidAmountCents: row.paid_amount_cents,
      unpaidExposureCents: row.unpaid_exposure_cents,
      orderCount: row.order_count,
      cashAmountCents: row.cash_amount_cents,
      cardAmountCents: row.card_amount_cents,
      bizumAmountCents: row.bizum_amount_cents,
      otherAmountCents: row.other_amount_cents,
      // FINALIZAR V3 CANONICAL CLOSEOUT V1 (migration 121). Both null on a row
      // written before the canonical-closeout contract; both non-null on a
      // canonical closeout (DB pairing CHECK). currentObligationCents is the
      // current obligation at close; grossSalesCents keeps its own, unchanged
      // meaning (original order gross).
      currentObligationCents: row.current_obligation_cents ?? null,
      overCollectedCents: row.over_collected_cents ?? null,
    },
    operational: {
      openOrdersAtClose: row.open_orders_at_close,
      occupiedTablesAtClose: row.occupied_tables_at_close,
      kitchenPendingCount: row.kitchen_pending_count,
      listoCount: row.listo_count,
      deliveryPendingCount: row.delivery_pending_count,
      incidentCount: row.incident_count,
      criticalIncidentCount: row.critical_incident_count,
    },
    createdAt: row.created_at,
  };
}

function createServiceCloseouts({ select = sbSelect } = {}) {
  return Object.freeze({
    // At most one row can ever match (service_closeouts_session_uq) — never
    // assumes that at the JS layer, always returns null vs the single row.
    async getBySessionId({ serviceSessionId }) {
      const rows = await select(
        "service_closeouts",
        `service_session_id=eq.${encodeURIComponent(serviceSessionId)}`
      );
      if (!Array.isArray(rows) || rows.length === 0) return null;
      return publicCloseout(rows[0]);
    },

    // At most one row can ever match (service_closeouts_correlation_uq).
    async getByCorrelationId({ closeoutCorrelationId }) {
      const rows = await select(
        "service_closeouts",
        `closeout_correlation_id=eq.${encodeURIComponent(closeoutCorrelationId)}`
      );
      if (!Array.isArray(rows) || rows.length === 0) return null;
      return publicCloseout(rows[0]);
    },

    // Reporting surface: every successful closeout in a date range, oldest first.
    async listByBusinessDateRange({ fromDate, toDate }) {
      const rows = await select(
        "service_closeouts",
        `business_date=gte.${encodeURIComponent(fromDate)}&business_date=lte.${encodeURIComponent(toDate)}&order=business_date.asc`
      );
      if (!Array.isArray(rows)) return [];
      return rows.map(publicCloseout);
    },
  });
}

const serviceCloseouts = createServiceCloseouts();

module.exports = { createServiceCloseouts, serviceCloseouts, publicCloseout };
