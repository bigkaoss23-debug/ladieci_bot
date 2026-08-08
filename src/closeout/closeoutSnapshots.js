"use strict";
// ===============================================================
// closeoutSnapshots.js — SERVICE CLOSEOUT V2 / Slice 1
//
// Thin wrapper over the capture_closeout_snapshot RPC (see
// migrations/2026-08-08_service_closeout_incidents_foundation.sql), mirroring
// the style of ../serviceSessions/serviceSessionLifecycle.js: normalize the
// RPC transport shape once, expose a small typed surface, no business logic
// here that the SQL function doesn't already own.
//
// NOT wired into chiudiServizio/ensureServiceSession/any HTTP action in this
// slice. The caller is responsible for building `payload` — this module only
// proves the storage/idempotency contract, it does not define what a
// real closeout payload contains (that is later-slice wiring work).
//
// closeoutCorrelationId identity contract (Slice 1.1 — fixes a Slice-1 bug):
// serviceSessionId != closeoutCorrelationId. A service session can be the
// subject of more than one real closeout ATTEMPT (attempt 1 captures a
// snapshot, then hard-fails before the session closes; the operator fixes
// state; attempt 2 at a later time is a genuinely new attempt against the
// SAME session). closeoutCorrelationId is REQUIRED here and is never
// defaulted to serviceSessionId — a prior Slice-1 default did exactly that,
// which meant attempt 2 would silently reuse attempt 1's stale snapshot
// (same session id -> same correlation id -> DB unique constraint treats it
// as a retry of attempt 1, not a new attempt).
//
// This module never mints closeoutCorrelationId itself. It is the future
// lifecycle orchestrator's job to create exactly one UUID per genuine
// closeout attempt and pass it consistently to capture(), to
// serviceIncidents.report(), and to every other closeout-related call for
// that attempt:
//   - same technical retry of the SAME attempt (network blip, re-invoked
//     handler, etc.) -> orchestrator reuses the SAME UUID -> this module's
//     idempotent ON CONFLICT DO NOTHING returns the existing snapshot.
//   - a NEW attempt, because the previous one was abandoned/failed and state
//     may have changed -> orchestrator mints a NEW UUID -> a new, separate,
//     authoritative snapshot is captured.
// Never a timestamp, never generated independently inside this or any other
// RPC/module — a single owned identity per attempt is what makes retries
// idempotent and distinct attempts distinct.
// ===============================================================

const { sbRpc, sbSelect } = require("../utils/supabase");

function normalize(rpcResult) {
  if (!rpcResult || rpcResult.ok !== true || !rpcResult.body || typeof rpcResult.body !== "object") {
    return { ok: false, code: "CLOSEOUT_SNAPSHOT_TRANSPORT_ERROR" };
  }
  return rpcResult.body;
}

function publicSnapshot(row) {
  if (!row || typeof row !== "object") return null;
  return {
    id: row.id,
    serviceSessionId: row.service_session_id,
    businessDate: row.business_date,
    serviceKind: row.service_kind,
    closeoutCorrelationId: row.closeout_correlation_id,
    schemaVersion: row.schema_version,
    capturedAt: row.captured_at,
    capturedBy: row.captured_by,
    source: row.source,
    payload: row.payload,
    payloadSha256: row.payload_sha256 || null,
  };
}

function createCloseoutSnapshots({ rpc = sbRpc, select = sbSelect } = {}) {
  return Object.freeze({
    // Idempotent: a retry with the same closeoutCorrelationId returns the
    // existing snapshot, created:false, never a duplicate row and never an
    // overwrite of the original payload. closeoutCorrelationId is REQUIRED
    // and is never derived from serviceSessionId here (see header) — an
    // omitted/undefined value is rejected server-side (p_closeout_correlation_id
    // IS NULL -> INVALID_ARGUMENTS), the same fail-closed contract
    // serviceIncidents.report() already uses.
    async capture({
      serviceSessionId,
      closeoutCorrelationId,
      capturedBy,
      source,
      payload,
      schemaVersion = 1,
      payloadSha256 = null,
    }) {
      const res = normalize(await rpc("capture_closeout_snapshot", {
        p_service_session_id: serviceSessionId,
        p_closeout_correlation_id: closeoutCorrelationId,
        p_captured_by: capturedBy,
        p_source: source,
        p_payload: payload,
        p_schema_version: schemaVersion,
        p_payload_sha256: payloadSha256,
      }));
      if (res.ok !== true) {
        return { success: false, created: false, code: res.code || "CLOSEOUT_SNAPSHOT_FAILED", snapshot: null };
      }
      return {
        success: true,
        created: res.created === true,
        code: res.code,
        snapshot: publicSnapshot(res.snapshot),
      };
    },

    // Queryable by service_session_id (plan §2 requirement #4), read-only —
    // this is a plain SELECT, not an RPC, since reads need no idempotency
    // contract. Ordered newest-first; in the happy path there is exactly one
    // row per session (see the correlation-id-defaults-to-session-id note
    // above), but this deliberately does not assume that.
    async listBySession({ serviceSessionId }) {
      const rows = await select(
        "service_closeout_snapshots",
        `service_session_id=eq.${encodeURIComponent(serviceSessionId)}&order=captured_at.desc`
      );
      if (!Array.isArray(rows)) return [];
      return rows.map(publicSnapshot);
    },

    // SLICE 3.1 — the snapshot owned by ONE specific attempt. Used instead of
    // listBySession() once closeout_correlation_id is known via
    // closeoutAttempts.acquire() (service_closeout_snapshots_correlation_uq
    // guarantees at most one row can ever match).
    async getByCorrelationId({ closeoutCorrelationId }) {
      const rows = await select(
        "service_closeout_snapshots",
        `closeout_correlation_id=eq.${encodeURIComponent(closeoutCorrelationId)}`
      );
      if (!Array.isArray(rows) || rows.length === 0) return null;
      return publicSnapshot(rows[0]);
    },
  });
}

const closeoutSnapshots = createCloseoutSnapshots();

module.exports = { createCloseoutSnapshots, closeoutSnapshots, publicSnapshot };
