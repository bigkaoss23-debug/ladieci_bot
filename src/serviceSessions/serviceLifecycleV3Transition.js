"use strict";
// ===============================================================
// serviceLifecycleV3Transition.js — SERVICE LIFECYCLE V3 / Slice 3.2
//
// Thin wrapper over close_service_session_v3 (see
// migrations/2026-08-09_service_lifecycle_v3_close_engine.sql) — the
// V3-native terminal transition (service_sessions -> 'closed'). Deliberately
// separate from src/serviceSessions/serviceSessionLifecycle.js, which wraps
// the LEGACY begin_service_session_close/complete_service_session_close pair
// the V3 engine is forbidden from calling. Mirrors closeoutAttempts.js's
// normalize()/createX({rpc}) factory pattern exactly.
// ===============================================================

const { sbRpc } = require("../utils/supabase");

function normalize(rpcResult) {
  if (!rpcResult || rpcResult.ok !== true || !rpcResult.body || typeof rpcResult.body !== "object") {
    return { ok: false, code: "SERVICE_LIFECYCLE_V3_TRANSITION_TRANSPORT_ERROR" };
  }
  return rpcResult.body;
}

function publicSession(row) {
  if (!row || typeof row !== "object") return null;
  return {
    id: row.id,
    businessDate: row.business_date,
    status: row.status,
    serviceKind: row.service_kind,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    openedBy: row.opened_by,
    closedBy: row.closed_by,
    openSource: row.open_source,
    closeSource: row.close_source,
    closeReason: row.close_reason || null,
    // SLICE 3.4 — set only on a session opened as the V3 rollover
    // continuation of another (see ensureNext() below); null for close()'s
    // own results (A never has this set on itself).
    rolloverSourceSessionId: row.rollover_source_session_id || null,
  };
}

function createServiceLifecycleV3Transition({ rpc = sbRpc } = {}) {
  return Object.freeze({
    // Idempotent: if the session is already closed (e.g. a retry after this
    // RPC already succeeded once but the caller crashed before marking the
    // closeout attempt completed), returns success with idempotent:true
    // instead of erroring.
    async close({ serviceSessionId, closeoutCorrelationId, actor, source }) {
      const res = normalize(await rpc("close_service_session_v3", {
        p_service_session_id: serviceSessionId,
        p_closeout_correlation_id: closeoutCorrelationId,
        p_closed_by: actor,
        p_source: source,
      }));
      if (res.ok !== true) {
        return { success: false, code: res.code || "SERVICE_LIFECYCLE_V3_CLOSE_FAILED", session: null };
      }
      return {
        success: true,
        idempotent: res.idempotent === true,
        code: res.code,
        session: publicSession(res.session),
      };
    },

    // SLICE 3.4 — thin wrapper over ensure_next_service_session_v3 (see
    // migrations/2026-08-09_service_lifecycle_v3_rollover.sql). Idempotent on
    // (rollover_source_session_id): a retry for the SAME sourceSessionId
    // always returns the SAME session, `created:false`, regardless of what
    // the clock says by the time the retry runs — the caller (the engine)
    // never needs to re-derive serviceKind/businessDate on a retry once B
    // already exists.
    async ensureNext({ sourceSessionId, serviceKind, businessDate, actor, source }) {
      const res = normalize(await rpc("ensure_next_service_session_v3", {
        p_source_session_id: sourceSessionId,
        p_service_kind: serviceKind,
        p_business_date: businessDate,
        p_opened_by: actor,
        p_source: source,
      }));
      if (res.ok !== true) {
        return { success: false, code: res.code || "SERVICE_LIFECYCLE_V3_ENSURE_NEXT_FAILED", session: null };
      }
      return {
        success: true,
        created: res.created === true,
        code: res.code,
        session: publicSession(res.session),
      };
    },
  });
}

const serviceLifecycleV3Transition = createServiceLifecycleV3Transition();

module.exports = { createServiceLifecycleV3Transition, serviceLifecycleV3Transition };
