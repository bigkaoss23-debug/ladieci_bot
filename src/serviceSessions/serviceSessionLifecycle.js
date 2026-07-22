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
    async open({ actor, source = "backend" }) {
      return normalize(await rpc("open_service_session", { p_opened_by: actor, p_source: source }));
    },
    async beginClose({ actor, source = "backend" }) {
      return normalize(await rpc("begin_service_session_close", { p_closed_by: actor, p_source: source }));
    },
    async completeClose({ sessionId, actor, source = "backend" }) {
      return normalize(await rpc("complete_service_session_close", { p_session_id: sessionId, p_closed_by: actor, p_source: source }));
    },
    async currentCloseout() {
      return normalize(await rpc("get_current_service_closeout_session", {}));
    },
  });
}

const lifecycle = createServiceSessionLifecycle();
module.exports = { createServiceSessionLifecycle, lifecycle };
