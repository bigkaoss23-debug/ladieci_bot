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
    // S2-7D6B — THE creator. Idempotent: an existing active session of the same
    // kind is returned as `created:false`, never re-opened. The kind is resolved
    // by the caller from the authoritative schedule module and is never taken
    // from a client request.
    async ensure({ actor, serviceKind, source = "auto_entry" }) {
      return normalize(await rpc("ensure_service_session", {
        p_opened_by: actor, p_service_kind: serviceKind, p_source: source,
      }));
    },
    // Retired: the kind-less opener now fail-closes in SQL with
    // SERVICE_KIND_REQUIRED, because it could only create a session that
    // violates service_sessions_active_kind_chk. Kept so a stale caller fails
    // loudly rather than silently writing a session with no service identity.
    async open({ actor, source = "backend" }) {
      return normalize(await rpc("open_service_session", { p_opened_by: actor, p_source: source }));
    },
    async beginClose({ actor, source = "backend" }) {
      return normalize(await rpc("begin_service_session_close", { p_closed_by: actor, p_source: source }));
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
  });
}

const lifecycle = createServiceSessionLifecycle();
module.exports = { createServiceSessionLifecycle, lifecycle };
