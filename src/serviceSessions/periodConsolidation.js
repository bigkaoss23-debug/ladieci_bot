"use strict";
// periodConsolidation.js — R-DAY4
//
// Thin JS wrapper over public.consolidate_period_v1() (migrations/2026-08-16_
// r_day4_period_consolidation.sql), mirroring economicBoundaryEngine.js's own
// style: normalize the RPC transport shape once, no business logic here that
// the SQL function doesn't already own. The SQL function is the sole
// authority for the lock, the idempotency check, the server-assigned cutoff,
// the checkpoint capture and the optional ticket-epoch advance.
//
// PERIOD ASSIGNMENT vs PERIOD CONSOLIDATION — structurally separate, per
// R-DAY0 §9/§13 and the frozen FINAL REPORT line "the two are structurally
// incapable of being fused": this module NEVER reads or writes
// business_day_lifecycle_state, service_session_state, or service_sessions.
// status. It calls exactly one RPC and returns exactly what it returns.
const { sbRpc } = require("../utils/supabase");
const { sidHash } = require("../auth/sidHash");

function normalize(rpcResult) {
  if (!rpcResult || rpcResult.ok !== true || !rpcResult.body || typeof rpcResult.body !== "object") {
    return { success: false, code: "PERIOD_CONSOLIDATION_TRANSPORT_ERROR" };
  }
  const body = rpcResult.body;
  if (body.ok !== true) {
    return { success: false, code: body.code || "PERIOD_CONSOLIDATION_FAILED", detail: body.detail };
  }
  return {
    success: true,
    code: body.code,
    idempotent: body.idempotent === true,
    consolidationId: body.consolidationId,
    periodId: body.periodId,
    businessDayId: body.businessDayId,
    cutoffAt: body.cutoffAt,
    resetTicketSequence: body.resetTicketSequence,
    newTicketEpoch: body.newTicketEpoch,
    snapshotId: body.snapshotId,
  };
}

function createPeriodConsolidation({ rpc = sbRpc, hashSid = sidHash } = {}) {
  return Object.freeze({
    // consolidate({ workspaceId, periodId, actor, role, sid, resetTickets, clientRequestId })
    // actor/role/sid are the VERIFIED req.authCtx identity — never client-
    // asserted. resetTickets is a required, explicit boolean (R-DAY0 §7 of
    // the amendment's own ticket-reset contract: never defaulted implicitly
    // by this layer — the caller decides, or explicitly reads business_day_
    // policy.ticket_reset_on_consolidation_default itself before calling).
    async consolidate({ workspaceId, periodId, actor, role, sid, resetTickets, clientRequestId } = {}) {
      if (!periodId || typeof periodId !== "string") {
        return { success: false, code: "PERIOD_ID_REQUIRED" };
      }
      if (!actor || typeof actor !== "string") {
        return { success: false, code: "INVALID_ACTOR" };
      }
      if (!role || typeof role !== "string") {
        return { success: false, code: "INVALID_ROLE" };
      }
      if (typeof resetTickets !== "boolean") {
        return { success: false, code: "RESET_TICKETS_MUST_BE_EXPLICIT_BOOLEAN" };
      }
      if (!clientRequestId || typeof clientRequestId !== "string") {
        return { success: false, code: "CLIENT_REQUEST_ID_REQUIRED" };
      }

      let rpcResult;
      try {
        rpcResult = await rpc("consolidate_period_v1", {
          p_workspace_id: workspaceId || null,
          p_period_id: periodId,
          p_by_actor: actor,
          p_by_role: role,
          p_by_sid_hash: hashSid(sid) || "",
          p_reset_tickets: resetTickets,
          p_client_request_id: clientRequestId,
        });
      } catch (e) {
        return { success: false, code: "PERIOD_CONSOLIDATION_RPC_ERROR", detail: String((e && e.message) || e) };
      }
      return normalize(rpcResult);
    },
  });
}

const periodConsolidation = createPeriodConsolidation();

module.exports = { createPeriodConsolidation, periodConsolidation };
