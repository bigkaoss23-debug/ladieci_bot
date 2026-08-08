"use strict";
// ===============================================================
// archivedOrderFinancialResolutions.js — SERVICE CLOSEOUT V2 / Slice 2
//
// Thin wrapper over create_archived_order_financial_resolution (see
// migrations/2026-08-08_service_closeout_post_close_financial_resolutions.sql),
// mirroring the style of closeoutSnapshots.js / serviceIncidents.js.
//
// NOT wired into chiudiServizio/order_mark_paid/order_refund/order_void/any
// HTTP action in this slice — storage + idempotency + arithmetic contract
// only. Records what happened to an archived (storico) order's unpaid
// balance AFTER service close: a recovered payment, a write-off, or a
// reversal of one specific prior event in the same lineage. Never touches
// storico, serata_summary, service_closeout_snapshots, or
// service_incidents.financial_exposure_cents — those stay frozen "truth at
// close" forever; this module only ever appends new facts layered on top.
//
// Lineage identity is the PAIR (serviceSessionId, archivedOrderId), never
// archivedOrderId alone — storico's own uniqueness is
// UNIQUE(service_session_id, orden_id), because order numbers are reused
// across sessions/days. actionCorrelationId is the idempotency identity
// (never orderId+amount — the same amount can legitimately be recovered
// twice across two separate partial payments): caller/orchestrator mints
// exactly one UUID per real action, same contract as
// closeoutSnapshots.js's closeoutCorrelationId.
//
// SLICE 2.1: relatedIncidentId is mandatory (the RPC rejects with
// INCIDENT_LINK_REQUIRED otherwise) and originalExposureCents no longer
// exists as an input anywhere in this module — the RPC derives it
// server-side from the linked service_incidents row's immutable
// financial_exposure_cents. record() throws synchronously if a caller passes
// originalExposureCents at all, so a caller trying to set it fails loudly at
// the call site instead of having the value silently dropped.
//
// SLICE 2.2: actionCorrelationId reused with a payload that does not exactly
// match the originally recorded command (different amount/type/order/
// session/incident/paymentMethod/reversedEventId) returns
// code:'ACTION_CORRELATION_ID_CONFLICT', success:false — handled by the
// generic res.ok!==true branch below, no special-casing needed here. Only an
// EXACT repeat of the same command is idempotent.
//
// TRUST BOUNDARY (matches Slice 1.1 exactly): role='admin' here is a
// defense-in-depth check, NOT proof of identity — see
// src/incidents/serviceIncidents.js's resolve() for the pattern this reuses.
// Do not wire this module to an HTTP handler that forwards a request body's
// role field untouched.
// ===============================================================

const { sbRpc, sbSelect } = require("../utils/supabase");

const RESOLVER_ROLE = "admin"; // only role allowed to record a resolution, matches the SQL-side check

function normalize(rpcResult, transportCode) {
  if (!rpcResult || rpcResult.ok !== true || !rpcResult.body || typeof rpcResult.body !== "object") {
    return { ok: false, code: transportCode };
  }
  return rpcResult.body;
}

function publicResolution(row) {
  if (!row || typeof row !== "object") return null;
  return {
    id: row.id,
    serviceSessionId: row.service_session_id,
    businessDate: row.business_date,
    serviceKind: row.service_kind,
    archivedOrderId: row.archived_order_id,
    relatedIncidentId: row.related_incident_id,
    actionCorrelationId: row.action_correlation_id,
    resolutionType: row.resolution_type,
    reversedEventId: row.reversed_event_id || null,
    originalExposureCents: row.original_exposure_cents,
    amountCents: row.amount_cents,
    remainingExposureCents: row.remaining_exposure_cents,
    lineageSequence: row.lineage_sequence,
    paymentMethod: row.payment_method || null,
    actor: row.actor,
    reason: row.reason,
    note: row.note || null,
    createdAt: row.created_at,
  };
}

function createArchivedOrderFinancialResolutions({ rpc = sbRpc, select = sbSelect } = {}) {
  return Object.freeze({
    // Idempotent: a retry with the same actionCorrelationId returns the
    // existing event, created:false, never a duplicate row. Two legitimate
    // separate actions (even an identical amount) require two distinct
    // actionCorrelationIds — this module never mints one itself.
    //
    // relatedIncidentId is mandatory (SLICE 2.1 — the RPC rejects with
    // INCIDENT_LINK_REQUIRED if omitted) and must be the SAME incident for
    // every event of a (serviceSessionId, archivedOrderId) lineage
    // (INCIDENT_LINK_MISMATCH otherwise). original_exposure_cents no longer
    // exists as an input anywhere in this contract — the RPC derives it,
    // once, from that incident's immutable financial_exposure_cents; this
    // wrapper throws synchronously if a caller passes originalExposureCents,
    // so a caller trying to set it fails loudly at the call site rather than
    // having the value silently dropped. recovered_payment/write_off fail
    // closed with OVER_RESOLUTION_EXCEEDS_REMAINING rather than let
    // remaining exposure go negative; reversal requires reversedEventId and
    // must match that event's amount exactly (full reversal only).
    async record({
      serviceSessionId,
      archivedOrderId,
      relatedIncidentId,
      actionCorrelationId,
      resolutionType,
      amountCents,
      actor,
      role,
      reason,
      originalExposureCents,
      paymentMethod = null,
      reversedEventId = null,
      note = null,
    }) {
      if (originalExposureCents !== undefined) {
        throw new Error("originalExposureCents is no longer a valid input — original exposure is derived server-side from the linked incident's financial_exposure_cents (SLICE 2.1)");
      }
      if (role !== RESOLVER_ROLE) {
        return { success: false, created: false, code: "FINANCIAL_RESOLUTION_FORBIDDEN", resolution: null };
      }
      const res = normalize(await rpc("create_archived_order_financial_resolution", {
        p_service_session_id: serviceSessionId,
        p_archived_order_id: archivedOrderId,
        p_related_incident_id: relatedIncidentId,
        p_action_correlation_id: actionCorrelationId,
        p_resolution_type: resolutionType,
        p_amount_cents: amountCents,
        p_actor: actor,
        p_actor_role: role,
        p_reason: reason,
        p_payment_method: paymentMethod,
        p_reversed_event_id: reversedEventId,
        p_note: note,
      }), "FINANCIAL_RESOLUTION_TRANSPORT_ERROR");

      if (res.ok !== true) {
        return { success: false, created: false, code: res.code || "FINANCIAL_RESOLUTION_FAILED", resolution: null };
      }
      return { success: true, created: res.created === true, code: res.code, resolution: publicResolution(res.resolution) };
    },

    // Full history for a lineage, oldest-first (so remainingExposureCents of
    // the LAST element is always the current balance) — a plain SELECT, no
    // idempotency contract needed for a read. SLICE 2.1: ordered by
    // lineage_sequence, never created_at — see the RPC's own header for why
    // timestamps must never be the accounting-order primitive.
    async listForArchivedOrder({ serviceSessionId, archivedOrderId }) {
      const rows = await select(
        "archived_order_financial_resolutions",
        `service_session_id=eq.${encodeURIComponent(serviceSessionId)}&archived_order_id=eq.${encodeURIComponent(archivedOrderId)}&order=lineage_sequence.asc`
      );
      if (!Array.isArray(rows)) return [];
      return rows.map(publicResolution);
    },

    // Current remaining exposure for a lineage: the remaining_exposure_cents
    // of the row with the highest lineage_sequence, or null if no resolution
    // has ever been recorded for this archived order (i.e. the original
    // exposure, if any, is still whatever the closeout/incident recorded —
    // this module has nothing to add).
    async getRemainingExposureCents({ serviceSessionId, archivedOrderId }) {
      const rows = await select(
        "archived_order_financial_resolutions",
        `service_session_id=eq.${encodeURIComponent(serviceSessionId)}&archived_order_id=eq.${encodeURIComponent(archivedOrderId)}&order=lineage_sequence.desc&limit=1`
      );
      if (!Array.isArray(rows) || rows.length === 0) return null;
      return rows[0].remaining_exposure_cents;
    },
  });
}

const archivedOrderFinancialResolutions = createArchivedOrderFinancialResolutions();

module.exports = { createArchivedOrderFinancialResolutions, archivedOrderFinancialResolutions, publicResolution, RESOLVER_ROLE };
