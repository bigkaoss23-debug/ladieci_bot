"use strict";
const { sbRpc } = require("../utils/supabase");

function normalize(rpcResult) {
  if (!rpcResult || rpcResult.ok !== true || !rpcResult.body || typeof rpcResult.body !== "object") {
    return { ok: false, code: "SERVICE_SESSION_TRANSPORT_ERROR" };
  }
  return rpcResult.body;
}

function createServiceSessionLifecycle({ rpc = sbRpc } = {}) {
  return Object.freeze({
    // F-7 — READ/REUSE ONLY. ensure_service_session no longer creates
    // anything (that authority moved to open_operational_service_v1, called
    // only from resolve_order_intake_context_v1's first-ever-lazy-open path)
    // — it answers REUSED / NO_OPEN_SERVICE / REOPEN_REQUIRED from DB state
    // alone. No serviceKind parameter: this wrapper never infers or forwards
    // a PRANZO/SERA identity, because the RPC no longer accepts one. // language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values, named here only to describe identity logic this wrapper never performs, not new vocabulary
    async ensure({ actor, source = "auto_entry" }) {
      return normalize(await rpc("ensure_service_session", {
        p_opened_by: actor, p_source: source,
      }));
    },
    // Retired: the kind-less opener now fail-closes in SQL with
    // SERVICE_KIND_REQUIRED, because it could only create a session that
    // violates service_sessions_active_kind_chk. Kept so a stale caller fails
    // loudly rather than silently writing a session with no service identity.
    async open({ actor, source = "backend" }) {
      return normalize(await rpc("open_service_session", { p_opened_by: actor, p_source: source }));
    },
    // preserveActiveOrders: forwarded to the RPC's own p_preserve_active_orders
    // -- same name, same meaning, same default as completeClose below, so the
    // two halves of the close transition express one identical policy, never
    // contradictory gates. Only the close engine's one incident-safe caller
    // ever passes true; every other caller keeps the guard exactly as strict
    // as before.
    async beginClose({ actor, source = "backend", preserveActiveOrders = false }) {
      return normalize(await rpc("begin_service_session_close", {
        p_closed_by: actor, p_source: source, p_preserve_active_orders: preserveActiveOrders,
      }));
    },
    // preserveActiveOrders: forwarded to the RPC's own p_preserve_active_orders
    // -- see that function's header for the exact, DB-enforced (incident-
    // backed, per-order) contract this authorizes. Only the close engine's one
    // incident-safe caller ever passes true; every other caller keeps the
    // guard exactly as strict as before.
    async completeClose({ sessionId, actor, source = "backend", preserveActiveOrders = false }) {
      return normalize(await rpc("complete_service_session_close", {
        p_session_id: sessionId, p_closed_by: actor, p_source: source,
        p_preserve_active_orders: preserveActiveOrders,
      }));
    },
    async currentCloseout() {
      return normalize(await rpc("get_current_service_closeout_session", {}));
    },
    // F-9 — the sole wrapper for the canonical opener (F-6). p_open_reason is
    // never defaulted here: every caller must state 'first_open_of_business_day'
    // or 'explicit_reopen' explicitly, matching the RPC's own fail-closed
    // signature (no default, INVALID_OPEN_REASON on anything else).
    async openOperational({ actor, openReason, source = 'backend' }) {
      return normalize(await rpc("open_operational_service_v1", {
        p_opened_by: actor, p_open_reason: openReason, p_source: source,
      }));
    },
  });
}

const lifecycle = createServiceSessionLifecycle();
module.exports = { createServiceSessionLifecycle, lifecycle };
