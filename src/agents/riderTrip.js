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

const { sbRpc, sbSelect } = require("../utils/supabase");
const { getOperationalSessionIds } = require("../serviceSessions/currentOperationalSession");

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
  ORDER_HAS_FINANCIAL_EVIDENCE: 409, // M-1: hard delete of a financially-evidenced order is refused
  INVALID_WA_ID: 400, // N-1: conversation hard-delete refuses a null/blank/whitespace-only wa_id
  CONVERSATION_HAS_FINANCIAL_EVIDENCE: 409, // N-1: hard delete of a conversation owning a financially-evidenced order is refused
  INVALID_TRIP_SNAPSHOT: 409, // corrupted active_trip snapshot: no close/log/write
  MISSING_TRIP_MEMBER: 409, // a snapshot member row is gone -> cannot close
  SERVICE_CLOSING: 409,     // no trip may start during service close
  SERVICE_CLOSE_ID_MISMATCH: 409,
  EARLY_CLOSE: 409,
  NO_ACTIVE_TRIP: 409,
  BAD_REQUEST: 400,
  INTERNAL: 500,
  // S2-7D6E2 — the ledger refused the collection, so the stop did NOT complete.
  // The rider retries; the deterministic key makes an honest retry a replay.
  PAYMENT_REFUSED: 409,
  RIDER_STOP_LOST_RACE: 409,
  // Identity refusals surfaced by the rider payment contract. Deliberately opaque codes.
  AUTH_METHOD_INVALID: 400,
  AUTH_SESSION_STALE: 401,
  AUTH_ACTOR_NOT_FOUND: 401,
  AUTH_INITIATOR_INACTIVE: 401,
  AUTH_FORBIDDEN_ROLE: 403,
  // Planner W6.3 — the canonical departure (start_rider_trip_v2, migration 135) speaks
  // the Giro/Trip Authority refusal vocabulary rather than the legacy v1 one. Each code
  // below is mapped explicitly; without these an ordinary operational refusal would fall
  // through mapResult's default and surface as a generic 500.
  INVALID_INPUT: 400,
  // Not a delivery order / a table order — the legacy RPC answered BAD_REQUEST (400)
  // for exactly this case, so the status the frontend already handles is preserved.
  ORDER_NOT_ELIGIBLE: 400,
  ORDER_NOT_FOUND: 404,
  // The order exists but carries no canonical order_uid, so it has no Trip Authority
  // identity. Fail closed rather than departing something the canonical lifecycle
  // could not then track.
  ORDER_NOT_CANONICAL: 409,
  SCOPE_MISMATCH: 409,
  // The operational scope could not be resolved, or the DRIVER_STATO compatibility
  // signal could not be read. Both are explicit degraded states, never a silent start.
  SCOPE_UNAVAILABLE: 409,
  UNVERIFIABLE: 409,
  // Migration 138 — start_rider_trip_v2 refuses to make a trip ACTIVE for a service that is
  // not 'open' at the atomic moment of departure (the caller resolved its scope BEFORE the
  // call, so a Finalizar that committed in between is only visible to the database). It is
  // an ordinary state conflict, never a 500; the departure control's existing failure path
  // (rollback of the optimistic state) already covers it.
  SERVICE_NOT_OPEN: 409,
  // The verified rider identity did not reach this boundary — refuse rather than
  // depart unattributed (same discipline as marcarEntregado's payment context).
  TRIP_CONTEXT_UNAVAILABLE: 401,
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

// Planner W6.3 — THE canonical departure.
//
// The frontend contract is unchanged: it still posts the display order id it always
// has. Everything the canonical RPC additionally needs is resolved HERE, server-side,
// from sources the client cannot influence:
//   * order_uid   — looked up from public.ordenes by that display id;
//   * actor + session_version — from `ctx`, which index.js builds from the VERIFIED
//     req.authCtx (the Bearer token), spread last so a `__authCtx` in the request body
//     is overwritten, never trusted — exactly the marcarEntregado discipline;
//   * operational session ids — from the existing lifecycle authority
//     (getOperationalSessionIds), never from the body.
//
// Every resolution failure fails CLOSED with a structured code: an unresolvable
// identity, an unknown order, an order with no canonical identity, or an unresolvable
// operational scope all refuse instead of departing something the canonical lifecycle
// could not track. `deps` exists only so the offline tests can drive this without a
// live database — the defaults are the live wiring, and the RPC itself is called
// through the literal sbRpc(...) form the H1B registry scanner reads.
async function startTrip(anchorOrderId, ctx = {}, deps = {}) {
  const select = typeof deps.select === "function" ? deps.select : sbSelect;
  const resolveScope = typeof deps.resolveScope === "function" ? deps.resolveScope : getOperationalSessionIds;

  const actor = typeof ctx.byActor === "string" ? ctx.byActor.trim() : "";
  const sessionVersion = ctx.sessionVersion;
  if (!actor || !Number.isInteger(sessionVersion) || sessionVersion < 1) {
    return { status: CODE_TO_HTTP.TRIP_CONTEXT_UNAVAILABLE, payload: { error: "TRIP_CONTEXT_UNAVAILABLE" } };
  }

  const displayId = anchorOrderId == null ? "" : String(anchorOrderId).trim();
  if (!displayId) {
    return { status: CODE_TO_HTTP.BAD_REQUEST, payload: { error: "BAD_REQUEST" } };
  }

  let row;
  try {
    const rows = await select("ordenes", `id=eq.${encodeURIComponent(displayId)}`);
    row = Array.isArray(rows) ? rows[0] : null;
  } catch (_) {
    return { status: 500, payload: { error: "internal_error" } };
  }
  if (!row) return { status: CODE_TO_HTTP.ORDER_NOT_FOUND, payload: { error: "ORDER_NOT_FOUND" } };
  const orderUid = typeof row.order_uid === "string" && row.order_uid ? row.order_uid : null;
  if (!orderUid) {
    return { status: CODE_TO_HTTP.ORDER_NOT_CANONICAL, payload: { error: "ORDER_NOT_CANONICAL" } };
  }

  let sessionIds;
  try {
    sessionIds = await resolveScope({ select });
  } catch (_) {
    sessionIds = null;
  }
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
    return { status: CODE_TO_HTTP.SCOPE_UNAVAILABLE, payload: { error: "SCOPE_UNAVAILABLE" } };
  }

  const r = await sbRpc("start_rider_trip_v2", {
    p_anchor_order_uid: orderUid,
    p_actor: actor,
    p_session_version: sessionVersion,
    p_operational_session_ids: sessionIds,
  });
  return mapResult(r);
}

// S2-7D6E2 — the rider stop is no longer an accounting authority.
//
// The old signature took `cobrado` from the CLIENT and the RPC wrote it straight onto
// `ordenes` with no ledger event, no actor and no session_version. It is gone: this now
// calls the dedicated rider contract, which records the collection in
// order_financial_events (as the rider, source `rider_delivery`) and completes the stop in
// ONE transaction, rolling both back if the ledger refuses.
//
// This module still derives no amount and builds no digest — SQL owns all of that.
// `ctx` carries the VERIFIED session identity only; nothing here comes from the body.
async function completeStop(orderId, metodoPago, ctx = {}) {
  const r = await sbRpc("rider_collect_and_complete_stop", {
    p_order_id: String(orderId),
    p_metodo_pago: metodoPago == null ? "" : String(metodoPago),
    p_by_actor: ctx.byActor == null ? "" : String(ctx.byActor),
    p_session_version: ctx.sessionVersion,
    p_ip_hash: ctx.ipHash == null ? "" : String(ctx.ipHash),
    p_meta: ctx.meta || {},
    p_idem_scope_key: ctx.idemScopeKey == null ? "" : String(ctx.idemScopeKey),
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
// N-1 — application-layer wa_id validation, ahead of the network call: a
// null/blank/whitespace-only wa_id is rejected here too, so an invalid
// request never even reaches the RPC. This is defense in depth, not the
// authority — the DB function (migrations/2026-08-24_n1_...) enforces the
// identical rule independently and is what actually protects the data if
// this check is ever bypassed, forgotten, or has its own bug.
async function deleteConversation(waId) {
  const normalized = waId == null ? "" : String(waId);
  if (normalized.trim() === "") {
    return { status: CODE_TO_HTTP.INVALID_WA_ID, payload: { error: "INVALID_WA_ID" } };
  }
  const r = await sbRpc("delete_conversation_if_not_active", { p_wa_id: normalized });
  return mapResult(r);
}

module.exports = {
  startTrip, completeStop, closeTrip,
  beginServiceCloseIfIdle, endServiceClose, deleteOrder, deleteConversation,
  mapResult, CODE_TO_HTTP,
};
