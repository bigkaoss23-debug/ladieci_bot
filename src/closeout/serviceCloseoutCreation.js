"use strict";
// ===============================================================
// serviceCloseoutCreation.js — SERVICE LIFECYCLE V3 / Slice 3.2
//
// Thin wrapper over create_service_closeout (see
// migrations/2026-08-09_service_lifecycle_v3_close_engine.sql) — the ONLY
// writer of service_closeouts. Mirrors src/closeout/closeoutAttempts.js /
// closeoutSnapshots.js exactly: normalize() extraction convention, a
// camelCase<->snake_case row mapper, createX({rpc}) factory + singleton
// export. Reuses serviceCloseouts.js's own publicCloseout() mapper rather
// than duplicating the field list, so the read path (serviceCloseouts.js)
// and this write path can never silently drift apart.
// ===============================================================

const { sbRpc } = require("../utils/supabase");
const { publicCloseout } = require("./serviceCloseouts");

function normalize(rpcResult) {
  if (!rpcResult || rpcResult.ok !== true || !rpcResult.body || typeof rpcResult.body !== "object") {
    return { ok: false, code: "SERVICE_CLOSEOUT_CREATION_TRANSPORT_ERROR" };
  }
  return rpcResult.body;
}

function createServiceCloseoutCreation({ rpc = sbRpc } = {}) {
  return Object.freeze({
    // Idempotent: a retry with the SAME closeoutCorrelationId never creates a
    // second row (service_closeouts_correlation_uq) — create_service_closeout
    // detects the conflict and returns the existing row instead (created:false).
    async create({
      serviceSessionId,
      closeoutCorrelationId,
      closedBy,
      source,
      closeReason = null,
      grossSalesCents,
      netSalesCents,
      totalRefundsCents = 0,
      totalVoidCents = 0,
      paidAmountCents,
      unpaidExposureCents,
      orderCount,
      cashAmountCents = 0,
      cardAmountCents = 0,
      bizumAmountCents = 0,
      otherAmountCents = 0,
      openOrdersAtClose = 0,
      occupiedTablesAtClose = 0,
    }) {
      const res = normalize(await rpc("create_service_closeout", {
        p_service_session_id: serviceSessionId,
        p_closeout_correlation_id: closeoutCorrelationId,
        p_closed_by: closedBy,
        p_source: source,
        p_close_reason: closeReason,
        p_gross_sales_cents: grossSalesCents,
        p_net_sales_cents: netSalesCents,
        p_total_refunds_cents: totalRefundsCents,
        p_total_void_cents: totalVoidCents,
        p_paid_amount_cents: paidAmountCents,
        p_unpaid_exposure_cents: unpaidExposureCents,
        p_order_count: orderCount,
        p_cash_amount_cents: cashAmountCents,
        p_card_amount_cents: cardAmountCents,
        p_bizum_amount_cents: bizumAmountCents,
        p_other_amount_cents: otherAmountCents,
        p_open_orders_at_close: openOrdersAtClose,
        p_occupied_tables_at_close: occupiedTablesAtClose,
      }));
      if (res.ok !== true) {
        return { success: false, created: false, code: res.code || "SERVICE_CLOSEOUT_CREATE_FAILED", closeout: null };
      }
      return {
        success: true,
        created: res.created === true,
        code: res.code,
        closeout: publicCloseout(res.closeout),
      };
    },
  });
}

const serviceCloseoutCreation = createServiceCloseoutCreation();

module.exports = { createServiceCloseoutCreation, serviceCloseoutCreation };
