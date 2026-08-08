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
// closeoutCorrelationId defaults to serviceSessionId when the caller doesn't
// supply one. A service session's close is a one-time terminal event in the
// happy path (docs/SERVICE_SESSION_IDENTITY.md: reopening always mints a new
// UUID), so the session's own id is already a stable, naturally-unique
// per-attempt key — retries of the SAME closeout attempt against the SAME
// session id then dedupe for free via the DB unique constraint, with no
// extra caller-side bookkeeping required.
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
    // Idempotent: a retry with the same closeoutCorrelationId (default:
    // serviceSessionId) returns the existing snapshot, created:false, never
    // a duplicate row and never an overwrite of the original payload.
    async capture({
      serviceSessionId,
      closeoutCorrelationId = serviceSessionId,
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
  });
}

const closeoutSnapshots = createCloseoutSnapshots();

module.exports = { createCloseoutSnapshots, closeoutSnapshots, publicSnapshot };
