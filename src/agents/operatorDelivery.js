// operatorDelivery.js — the pizzeria's own confirmation "the customer received the order".
//
// DELIVERY x ECONOMY DECOUPLING (migration 139). Wraps ONE transactional RPC:
//   operator_confirm_delivery_v1(p_order_id text, p_by_actor text, p_session_version integer, p_payment jsonb)
// EN_ENTREGA -> RETIRADO by an admin/operator, optionally TOGETHER with the payment through the EXISTING canonical
// Cash V1 writer (order_post_payment_v1), in one transaction under the dispatch lock. The two facts are independent:
// no payment = "delivered, still owed" (a valid state); a payment means the customer's debt is settled (it does NOT
// mean the banknotes are already in the drawer -- that is a Caja / reconciliation question).
//
// WHAT THIS MODULE IS NOT.
//   * It is not the rider's Entregado (riderTrip.completeStop / rider_collect_and_complete_stop), which stays
//     rider-exclusive. This is a separate action with its own identity: the delivery and the payment are recorded AS
//     THE OPERATOR (ledger by_actor / by_role and the orden_estado_logs audit row), never as the rider.
//   * It does not close a trip and does not mean "the driver is back" ("Driver volvió" is close_rider_trip, an
//     operational action): the trip is neither read nor closed here.
//   * It derives no amount and builds no digest of its own: SQL owns the amount (the canonical obligation), the
//     idempotency and the double-payment protection. This module only validates the shape of the request and adds
//     the two proofs the canonical writer requires from its caller (the session-id hash and the request hash),
//     exactly like cash/cashService.js does for Cash V1.
//
// Identity comes ONLY from `ctx` (built by index.js from the VERIFIED req.authCtx, spread last so a `__authCtx` in the
// body can never be trusted). Every failure is a typed code; raw PostgREST/SQL text never leaves this module.

"use strict";

const { sbRpc } = require("../utils/supabase");
const { sidHash: defaultSidHash } = require("../auth/sidHash");
const { canonicalHash } = require("../tables/mesaService");

const PAYMENT_METHODS = Object.freeze(new Set(["efectivo", "tarjeta", "bizum"]));
const PAYMENT_MODES = Object.freeze(new Set(["full", "custom_amount"]));
const CLIENT_REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/;
const MONEY = /^[0-9]{1,7}(\.[0-9]{1,2})?$/;

// Structured RPC code -> HTTP status. Deterministic, no leakage.
const CODE_TO_HTTP = Object.freeze({
  OK: 200,
  IDEMPOTENT: 200,
  INVALID_INPUT: 400,
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  ORDER_NOT_ELIGIBLE: 400,     // not a delivery order / a table order
  INVALID_STATE: 409,          // the order is not EN_ENTREGA
  ORDER_NOT_CANONICAL: 409,
  PAYMENT_REFUSED: 409,        // the canonical writer refused: nothing was written, the delivery is NOT confirmed
  DELIVERY_LOST_RACE: 409,     // the order changed under the confirmation: the whole transaction rolled back
  AUTH_METHOD_INVALID: 400,
  AUTH_SESSION_STALE: 401,
  AUTH_ACTOR_NOT_FOUND: 401,
  AUTH_INITIATOR_INACTIVE: 401,
  AUTH_FORBIDDEN_ROLE: 403,
  OPERATOR_DELIVERY_CONTEXT_UNAVAILABLE: 401,
  CASH_CLIENT_REQUEST_ID_INVALID: 400,
  CASH_RELOGIN_REQUIRED: 401,
});

// The canonical writer's own refusals, as a typed status for the operator UI. Anything not listed is still a 409:
// it is a refusal of THIS request, never a server fault.
const PAYMENT_CODE_TO_HTTP = Object.freeze({
  ORDER_PAYMENT_INVALID: 400,
  ORDER_PAYMENT_AMOUNT_INVALID: 400,
  ORDER_PAYMENT_FORBIDDEN: 403,
  ORDER_PAYMENT_ORDER_NOT_FOUND: 404,
});

function refusal(status, error, extra = {}) {
  return { status, payload: { error, ...extra } };
}

function mapResult(rpcResult) {
  const body = rpcResult && rpcResult.body;
  if (!rpcResult || rpcResult.ok !== true) {
    // The RPC raises (never returns) exactly one business error: the lost race, so the recorded payment cannot
    // survive a delivery that did not complete. PostgREST reports it as the exception message.
    const message = body && typeof body === "object" && typeof body.message === "string" ? body.message : "";
    if (/OPERATOR_DELIVERY_LOST_RACE/.test(message)) return refusal(CODE_TO_HTTP.DELIVERY_LOST_RACE, "DELIVERY_LOST_RACE");
    return refusal(500, "internal_error");
  }
  if (!body || typeof body !== "object") return refusal(500, "internal_error");
  const code = body.code || (body.ok ? "OK" : "INTERNAL");
  if (body.ok) return { status: CODE_TO_HTTP[code] != null ? CODE_TO_HTTP[code] : 200, payload: { ...body } };
  if (code === "PAYMENT_REFUSED") {
    const pc = typeof body.payment_code === "string" ? body.payment_code : null;
    return refusal(PAYMENT_CODE_TO_HTTP[pc] != null ? PAYMENT_CODE_TO_HTTP[pc] : CODE_TO_HTTP.PAYMENT_REFUSED, code, { payment_code: pc });
  }
  return refusal(CODE_TO_HTTP[code] != null ? CODE_TO_HTTP[code] : 500, code, body.reason ? { reason: body.reason } : {});
}

// Builds the `p_payment` object the RPC expects from the request body's `payment` (or returns a typed refusal).
// No amount is ever taken from the client except for the explicit canonical `custom_amount` mode (partial payment),
// which the writer bounds by what is still owed.
function buildPayment(displayId, raw, ctx, hashSid) {
  if (raw == null) return { payment: null };
  if (typeof raw !== "object" || Array.isArray(raw)) return { refusal: refusal(CODE_TO_HTTP.INVALID_INPUT, "INVALID_INPUT") };
  const method = typeof raw.method === "string" ? raw.method.trim().toLowerCase() : "";
  if (!PAYMENT_METHODS.has(method)) return { refusal: refusal(CODE_TO_HTTP.AUTH_METHOD_INVALID, "AUTH_METHOD_INVALID") };
  const mode = raw.mode == null || raw.mode === "" ? "full" : String(raw.mode);
  if (!PAYMENT_MODES.has(mode)) return { refusal: refusal(CODE_TO_HTTP.INVALID_INPUT, "INVALID_INPUT") };
  let amount = null;
  if (mode === "custom_amount") {
    const text = raw.amount == null ? "" : String(raw.amount).trim();
    if (!MONEY.test(text) || !(Number(text) > 0)) return { refusal: refusal(CODE_TO_HTTP.INVALID_INPUT, "INVALID_INPUT") };
    amount = Number(text).toFixed(2);
  }
  const clientRequestId = raw.clientRequestId;
  if (typeof clientRequestId !== "string" || !CLIENT_REQUEST_ID.test(clientRequestId)) {
    return { refusal: refusal(CODE_TO_HTTP.CASH_CLIENT_REQUEST_ID_INVALID, "CASH_CLIENT_REQUEST_ID_INVALID") };
  }
  if (raw.confirmDuplicate != null && typeof raw.confirmDuplicate !== "boolean") {
    return { refusal: refusal(CODE_TO_HTTP.INVALID_INPUT, "INVALID_INPUT") };
  }
  const sid = typeof ctx.sid === "string" && ctx.sid ? ctx.sid : null;
  const bySidHash = sid ? hashSid(sid) : null;
  if (typeof bySidHash !== "string" || !/^[0-9a-f]{64}$/.test(bySidHash)) {
    return { refusal: refusal(CODE_TO_HTTP.CASH_RELOGIN_REQUIRED, "CASH_RELOGIN_REQUIRED") };
  }
  const semantic = { orderId: displayId, paymentMethod: method, mode, amount };
  return {
    payment: {
      method, mode, ...(amount == null ? {} : { amount }),
      client_request_id: clientRequestId,
      request_hash: canonicalHash(semantic),
      by_sid_hash: bySidHash,
      confirm_duplicate: raw.confirmDuplicate === true,
    },
  };
}

// confirmDelivery(orderId, ctx, payment?) -> { status, payload }
//   ctx     = { byActor, sessionVersion, sid }   (verified identity only)
//   payment = optional { method, mode?, amount?, clientRequestId, confirmDuplicate? }
async function confirmDelivery(orderId, ctx = {}, payment = null, deps = {}) {
  const hashSid = typeof deps.hashSid === "function" ? deps.hashSid : defaultSidHash;

  const actor = typeof ctx.byActor === "string" ? ctx.byActor.trim() : "";
  if (!actor || !Number.isInteger(ctx.sessionVersion) || ctx.sessionVersion < 1) {
    return refusal(CODE_TO_HTTP.OPERATOR_DELIVERY_CONTEXT_UNAVAILABLE, "OPERATOR_DELIVERY_CONTEXT_UNAVAILABLE");
  }
  const displayId = orderId == null ? "" : String(orderId).trim();
  if (!displayId) return refusal(CODE_TO_HTTP.BAD_REQUEST, "BAD_REQUEST");

  const built = buildPayment(displayId, payment, ctx, hashSid);
  if (built.refusal) return built.refusal;

  const args = {
    p_order_id: displayId,
    p_by_actor: actor,
    p_session_version: ctx.sessionVersion,
    p_payment: built.payment,
  };
  // The literal sbRpc(...) form is what the H1B registry scanner reads; `deps.rpc` exists only for offline tests.
  const r = typeof deps.rpc === "function"
    ? await deps.rpc("operator_confirm_delivery_v1", args)
    : await sbRpc("operator_confirm_delivery_v1", args);
  return mapResult(r);
}

module.exports = { confirmDelivery, mapResult, buildPayment, CODE_TO_HTTP, PAYMENT_CODE_TO_HTTP };
