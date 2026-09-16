// src/core/delivery/tripProjectionReader.js
// ===============================================================
// TripProjectionReader — the ONE canonical I/O boundary onto the Trip
// Authority projection (Planner W6.5). Pure I/O: resolves the operational
// scope, calls the SECURITY DEFINER RPC public.trip_projection_v1 (Planner
// W6.2, migration 135) and returns its raw jsonb result unchanged.
//
// Exact sibling of giroProjectionReader.js, deliberately: ALL interpretation
// (available/degraded/scope-invalid, membership split, ETA contract) lives in
// tripProjectionPort.js — this module never re-derives and never guesses.
//
// Fail-closed by construction: any resolution/RPC/transport failure returns
// null, which tripProjectionPort.tripProjectionAvailability() already treats
// as TRIP_PROJECTION_MISSING (available:false) -- never a silent "no trip",
// and never a DRIVER_STATO / raw manual_giros / ordenes.manual_giro_id
// fallback. This module reads none of those.
// ===============================================================
"use strict";

const { sbSelect, sbRpc } = require("../../utils/supabase");
const { getOperationalSessionIds } = require("../../serviceSessions/currentOperationalSession");

// deps are injectable for offline tests; defaults are the live wiring.
async function readTripProjection({
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
    result = await rpc("trip_projection_v1", { p_operational_session_ids: sessionIds });
  } catch (_) {
    return null;
  }
  if (!result || result.ok !== true || !result.body || typeof result.body !== "object") {
    return null;
  }
  return result.body;
}

module.exports = { readTripProjection };
