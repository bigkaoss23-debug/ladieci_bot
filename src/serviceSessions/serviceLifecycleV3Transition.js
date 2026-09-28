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
    // instead of erroring. R4B: the engine no longer calls this (it uses
    // closeAndCompleteAttempt below); since migration 149 a close made
    // through it alone cannot commit while its attempt is still active.
    async close({ serviceSessionId, closeoutCorrelationId, actor, source }) {
      const res = normalize(await rpc("close_service_session_v3", {
        p_service_session_id: serviceSessionId,
        p_closeout_correlation_id: closeoutCorrelationId,
        p_closed_by: actor,
        p_source: source,
      }));
      if (res.ok !== true) {
        // A transport: the RPC's own typed code is the only thing that crosses. (Migration 139 removed the
        // active-trip refusal 138 had added here: a rider trip never refuses the close.)
        return { success: false, code: res.code || "SERVICE_LIFECYCLE_V3_CLOSE_FAILED", session: null };
      }
      return {
        success: true,
        idempotent: res.idempotent === true,
        code: res.code,
        session: publicSession(res.session),
      };
    },

    // R4B (migration 149) — the terminal step the V3 engine actually uses:
    // close_service_session_v3 and the attempt completion in ONE
    // transaction (close_service_session_and_complete_attempt_v1). Success
    // only when the RPC confirms this attempt is completed; a completion the
    // database refused rolled the close back with it. A transport failure is
    // reported as a failure even though the transaction may have committed:
    // the retry then finds the attempt completed (engine CASE C).
    async closeAndCompleteAttempt({ serviceSessionId, closeoutCorrelationId, actor, source }) {
      let raw;
      try {
        raw = await rpc("close_service_session_and_complete_attempt_v1", {
          p_service_session_id: serviceSessionId,
          p_closeout_correlation_id: closeoutCorrelationId,
          p_closed_by: actor,
          p_source: source,
        });
      } catch (e) {
        // outcome unknown (it may have committed): a typed failure, never a success
        raw = null;
      }
      const res = normalize(raw);
      const attempt = res.attempt && typeof res.attempt === "object" ? res.attempt : null;
      const attemptCompleted = res.attemptCompleted === true && !!attempt && attempt.status === "completed"
        && attempt.closeout_correlation_id === closeoutCorrelationId && attempt.service_session_id === serviceSessionId;
      if (res.ok !== true || !attemptCompleted) {
        return {
          success: false,
          code: res.ok === true ? "V3_CLOSE_ATTEMPT_NOT_CONFIRMED" : (res.code || "SERVICE_LIFECYCLE_V3_CLOSE_FAILED"),
          missing: res.missing,
          session: null,
        };
      }
      return {
        success: true,
        idempotent: res.idempotent === true,
        code: res.code,
        attemptCompleted: true,
        session: publicSession(res.session),
      };
    },

    // CORRECTIVE SLICE 150 — the terminal step the V3 engine uses from now on:
    // close_service_session_with_evidence_v1 judges the attempt's evidence under
    // the close's own lock prefix (the snapshot must still equal the service's
    // live facts; the receipts attributed to the service must still be exactly
    // `receiptIds`) and then creates the closeout, persists the reconciliation
    // and runs the 149 close + completion in ONE transaction. `closeout` /
    // `reconciliation` are the create_service_closeout /
    // create_service_closeout_reconciliation_v1 arguments (null when that row is
    // already committed). CLOSE_EVIDENCE_STALE comes back typed with nothing
    // written. Success exactly as closeAndCompleteAttempt: only with THIS attempt
    // completed; a transport failure is a failure (the retry finds CASE C).
    async closeWithEvidence({ serviceSessionId, closeoutCorrelationId, actor, source, closeout = null, reconciliation = null, receiptIds = null }) {
      let raw;
      try {
        raw = await rpc("close_service_session_with_evidence_v1", {
          p_service_session_id: serviceSessionId,
          p_closeout_correlation_id: closeoutCorrelationId,
          p_closed_by: actor,
          p_source: source,
          p_closeout: closeout,
          p_reconciliation: reconciliation,
          p_receipt_ids: receiptIds,
        });
      } catch (e) {
        // outcome unknown (it may have committed): a typed failure, never a success
        raw = null;
      }
      const res = normalize(raw);
      const attempt = res.attempt && typeof res.attempt === "object" ? res.attempt : null;
      const attemptCompleted = res.attemptCompleted === true && !!attempt && attempt.status === "completed"
        && attempt.closeout_correlation_id === closeoutCorrelationId && attempt.service_session_id === serviceSessionId;
      if (res.ok !== true || !attemptCompleted) {
        return {
          success: false,
          code: res.ok === true ? "V3_CLOSE_ATTEMPT_NOT_CONFIRMED" : (res.code || "SERVICE_LIFECYCLE_V3_CLOSE_FAILED"),
          missing: res.missing,
          stale: Array.isArray(res.stale) ? res.stale : undefined,
          closeoutCommitted: res.closeoutCommitted === true,
          session: null,
        };
      }
      return {
        success: true,
        idempotent: res.idempotent === true,
        code: res.code,
        attemptCompleted: true,
        session: publicSession(res.session),
        closeoutRow: res.closeout && typeof res.closeout === "object" ? res.closeout : null,
        reconciliationRow: res.reconciliation && typeof res.reconciliation === "object" ? res.reconciliation : null,
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

// publicSession is exported for the engine's CASE D (R4), which already holds
// the closed session row and must return it in exactly this shape without
// asking for a transition.
module.exports = { createServiceLifecycleV3Transition, serviceLifecycleV3Transition, publicSession };
