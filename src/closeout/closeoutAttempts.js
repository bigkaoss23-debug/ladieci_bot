"use strict";
// ===============================================================
// closeoutAttempts.js — SERVICE CLOSEOUT V2 / SLICE 3.1
//
// Thin wrapper over acquire_closeout_attempt / supersede_closeout_attempt /
// complete_closeout_attempt (see
// migrations/2026-08-08_service_closeout_attempt_ownership.sql), mirroring
// the style of closeoutSnapshots.js / serviceIncidents.js: normalize the RPC
// transport shape once, expose a small typed surface, no business logic here
// the SQL functions don't already own.
//
// This module owns closeout_correlation_id minting for a session — nothing
// in incidentSafeRollover.js (or any other caller) generates one itself.
// acquire() is the ONLY entry point that produces or discovers the ONE
// active attempt for a service session; the database's partial unique index
// on (service_session_id) WHERE status='active' is what actually makes two
// concurrent callers converge on the same attempt, not anything in this file
// or its caller — see the migration header.
// ===============================================================

const { sbRpc } = require("../utils/supabase");

function normalize(rpcResult, transportCode) {
  if (!rpcResult || rpcResult.ok !== true || !rpcResult.body || typeof rpcResult.body !== "object") {
    return { ok: false, code: transportCode };
  }
  return rpcResult.body;
}

function publicAttempt(row) {
  if (!row || typeof row !== "object") return null;
  return {
    closeoutCorrelationId: row.closeout_correlation_id,
    serviceSessionId: row.service_session_id,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at || null,
    supersededAt: row.superseded_at || null,
    supersessionReason: row.supersession_reason || null,
    createdBy: row.created_by,
  };
}

function createCloseoutAttempts({ rpc = sbRpc } = {}) {
  return Object.freeze({
    // Race-safe get-or-create of THE active attempt for a session.
    // created:true only the first time; every later call (this process or a
    // brand new one after a restart) gets created:false with the SAME
    // closeoutCorrelationId, until that attempt is completed or superseded.
    async acquire({ serviceSessionId, actor }) {
      const res = normalize(await rpc("acquire_closeout_attempt", {
        p_service_session_id: serviceSessionId,
        p_actor: actor,
      }), "CLOSEOUT_ATTEMPT_TRANSPORT_ERROR");
      if (res.ok !== true) {
        return { success: false, created: false, code: res.code || "ACQUIRE_CLOSEOUT_ATTEMPT_FAILED", attempt: null };
      }
      return { success: true, created: res.created === true, code: res.code, attempt: publicAttempt(res.attempt) };
    },

    // Marks an attempt as no longer authoritative because live state has
    // moved on since it was captured. Idempotent: superseding an
    // already-superseded attempt returns the same success, never an error —
    // whichever concurrent caller got there first, both converge on
    // acquiring the SAME fresh attempt afterward via the active-uq invariant.
    async supersede({ closeoutCorrelationId, actor, reason = null }) {
      const res = normalize(await rpc("supersede_closeout_attempt", {
        p_closeout_correlation_id: closeoutCorrelationId,
        p_actor: actor,
        p_reason: reason,
      }), "CLOSEOUT_ATTEMPT_TRANSPORT_ERROR");
      if (res.ok !== true) {
        return { success: false, code: res.code || "SUPERSEDE_CLOSEOUT_ATTEMPT_FAILED", attempt: null };
      }
      return { success: true, idempotent: res.idempotent === true, code: res.code, attempt: publicAttempt(res.attempt) };
    },

    // Marks an attempt terminal-successful. Called only after chiudiServizio
    // itself has actually succeeded for the session this attempt owns.
    async complete({ closeoutCorrelationId, actor }) {
      const res = normalize(await rpc("complete_closeout_attempt", {
        p_closeout_correlation_id: closeoutCorrelationId,
        p_actor: actor,
      }), "CLOSEOUT_ATTEMPT_TRANSPORT_ERROR");
      if (res.ok !== true) {
        return { success: false, code: res.code || "COMPLETE_CLOSEOUT_ATTEMPT_FAILED", attempt: null };
      }
      return { success: true, idempotent: res.idempotent === true, code: res.code, attempt: publicAttempt(res.attempt) };
    },
  });
}

const closeoutAttempts = createCloseoutAttempts();

module.exports = { createCloseoutAttempts, closeoutAttempts, publicAttempt };
