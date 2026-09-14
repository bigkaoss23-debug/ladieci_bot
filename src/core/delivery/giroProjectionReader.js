// src/core/delivery/giroProjectionReader.js
// ===============================================================
// GiroProjectionReader — the ONE canonical I/O boundary onto the Giro
// Authority projection (Planner W4, TB-1/TB-1A). Pure I/O: resolves the
// operational scope, calls the SECURITY DEFINER RPC public.giro_projection_v1
// (Planner W3, migration 130), and returns its raw jsonb result unchanged.
//
// ALL interpretation (available/degraded/scope-invalid, giro-state mapping,
// compatibility, the W4 compat alias) lives in giroProjectionPort.js — this
// module never re-derives, never guesses, and duplicates no business logic.
//
// Fail-closed by construction: any resolution/RPC/transport failure returns
// null, which giroProjectionPort.projectionAvailability() already treats as
// PROJECTION_MISSING (available:false) -- never a silent "no giro" and never
// a raw ordenes.manual_giro_id / manual_giros / salida_ref / dissolved_at
// fallback. This module reads none of those.
// ===============================================================
"use strict";

const { sbSelect, sbRpc } = require("../../utils/supabase");
const { getOperationalSessionIds } = require("../../serviceSessions/currentOperationalSession");

// deps are injectable for offline tests; defaults are the live wiring.
async function readGiroProjection({
  getOperationalSessionIds: resolveScope = getOperationalSessionIds,
  select = sbSelect,
  rpc = sbRpc,
} = {}) {
  let sessionIds;
  try {
    sessionIds = await resolveScope({ select });
  } catch (_) {
    return null;
  }
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
    return null;
  }

  let result;
  try {
    result = await rpc("giro_projection_v1", { p_operational_session_ids: sessionIds });
  } catch (_) {
    return null;
  }
  if (!result || result.ok !== true || !result.body || typeof result.body !== "object") {
    return null;
  }
  return result.body;
}

module.exports = { readGiroProjection };
