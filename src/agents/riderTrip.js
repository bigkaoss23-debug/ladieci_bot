// riderTrip.js — single authority for the rider trip lifecycle.
//
// S2-1B. Wraps the three transactional PostgreSQL RPCs (migrations/2026-07-20_rider_trip_rpcs.sql):
//   start_rider_trip(p_anchor_order_id text)
//   complete_rider_stop(p_order_id text, p_cobrado boolean, p_metodo_pago text)
//   close_rider_trip()
// Each RPC runs in one transaction with an advisory lock and returns a structured
// { ok, code, snapshot?, ... } JSON payload. This wrapper maps the RPC's structured
// code to a backend HTTP status and NEVER surfaces raw PostgREST/SQL messages.
//
// State mutation lives entirely in the RPC (DB) — never in the authorization module.

"use strict";

const { sbRpc } = require("../utils/supabase");

// Structured RPC code -> backend HTTP status. Deterministic, no leakage.
const CODE_TO_HTTP = Object.freeze({
  OK: 200,
  IDEMPOTENT: 200,
  NON_MEMBER_NOOP: 200,     // reconciliation no-op: trigger order not in active snapshot
  NON_MEMBER: 403,          // do not reveal existence of unrelated orders
  ROLE_FORBIDDEN: 403,
  NOT_FOUND: 404,           // absent anchor/order
  INVALID_STATE: 409,       // wrong source state / invalid transition
  ACTIVE_TRIP_CONFLICT: 409,
  ACTIVE_TRIP_MEMBER_CONFLICT: 409, // hard delete of an active-trip member is refused
  INVALID_TRIP_SNAPSHOT: 409, // corrupted active_trip snapshot: no close/log/write
  MISSING_TRIP_MEMBER: 409, // a snapshot member row is gone -> cannot close
  SERVICE_CLOSING: 409,     // no trip may start during service close
  SERVICE_CLOSE_ID_MISMATCH: 409,
  EARLY_CLOSE: 409,
  NO_ACTIVE_TRIP: 409,
  BAD_REQUEST: 400,
  INTERNAL: 500,
});

function mapResult(rpcResult) {
  // rpcResult = { httpStatus, ok, body }. PostgREST returns the function's jsonb as body.
  const body = rpcResult && rpcResult.body;
  // Any transport/parse failure -> generic 500 (no internals).
  if (!rpcResult || rpcResult.ok !== true || !body || typeof body !== "object") {
    return { status: 500, payload: { error: "internal_error" } };
  }
  const code = body.code || (body.ok ? "OK" : "INTERNAL");
  const status = CODE_TO_HTTP[code] != null ? CODE_TO_HTTP[code] : (body.ok ? 200 : 500);
  if (body.ok) {
    return { status, payload: { ...body } };
  }
  return { status, payload: { error: code } };
}

async function startTrip(anchorOrderId) {
  const r = await sbRpc("start_rider_trip", { p_anchor_order_id: String(anchorOrderId) });
  return mapResult(r);
}

async function completeStop(orderId, cobrado, metodoPago) {
  const r = await sbRpc("complete_rider_stop", {
    p_order_id: String(orderId),
    p_cobrado: cobrado === true,
    p_metodo_pago: metodoPago == null ? "" : String(metodoPago),
  });
  return mapResult(r);
}

// closeTrip(triggerOrderId?) — no arg for an explicit rider close; a trigger order id for
// operator/admin reconciliation (the RPC no-ops if it is not an active-snapshot member).
async function closeTrip(triggerOrderId) {
  const args = triggerOrderId != null ? { p_trigger_order_id: String(triggerOrderId) } : {};
  const r = await sbRpc("close_rider_trip", args);
  return mapResult(r);
}

// beginServiceCloseIfIdle() — service-close gate + idle reset. Rejects (409) if a trip is
// active; on success marks service_closing so no new trip can start during cleanup.
async function beginServiceCloseIfIdle(opts = {}) {
  const r = await sbRpc("begin_service_close_if_idle", {
    p_service_date: opts.serviceDate == null ? null : String(opts.serviceDate),
    p_source: opts.source == null ? "backend" : String(opts.source),
  });
  return mapResult(r);
}

// endServiceClose(closeId) — clears the matching service_closing marker after cleanup.
async function endServiceClose(closeId) {
  const r = await sbRpc("end_service_close", { p_close_id: closeId == null ? "" : String(closeId) });
  return mapResult(r);
}

// deleteOrder(id) — transactional hard-delete guard: refuses (409) if the order is an
// active-trip member; otherwise deletes the non-member order.
async function deleteOrder(orderId) {
  const r = await sbRpc("delete_order_if_not_active", { p_order_id: String(orderId) });
  return mapResult(r);
}

// deleteConversation(waId) — transactional conversation hard-delete guard.
async function deleteConversation(waId) {
  const r = await sbRpc("delete_conversation_if_not_active", { p_wa_id: String(waId) });
  return mapResult(r);
}

module.exports = {
  startTrip, completeStop, closeTrip,
  beginServiceCloseIfIdle, endServiceClose, deleteOrder, deleteConversation,
  mapResult, CODE_TO_HTTP,
};
