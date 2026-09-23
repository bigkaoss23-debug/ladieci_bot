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
//
// DELIVERY x ECONOMY DECOUPLING (migration 139) -- THE SCOPE IS operational ∪ residual.
// A trip that has already departed may outlive the close of its economic service
// (service CLOSED + trip ACTIVE is a valid, recoverable state). The operational
// scope (getOperationalSessionIds) never contains a closed service, so on its own
// it would make that trip invisible -- or, with no service open at all, turn every
// rider read into a fail-closed 503. The residual scope is the service_session_id
// of every ACTIVE trip (public.trip_residual_scope_v1, attribution only): it adds
// the departed trip's OWN service and nothing else -- never "all old closed
// services". The union is handed to the UNCHANGED trip_projection_v1.
//
// FAIL-CLOSED CONTRACT OF THE RESIDUAL (correction, independent review N6). The
// residual answers ONE question -- "does an ACTIVE trip belong to a service that
// is not operational?" -- and an answer we could not read is NOT "no". So:
//   * residual readable            -> scope = operational ∪ residual;
//   * residual UNREADABLE (transport error, HTTP/RPC failure, malformed body,
//     function not installed)      -> readTripProjection returns null, exactly like
//     an unreadable projection: consumers see "trip facts unavailable"
//     (rider 503 / Planner + getTripOperationalState DEGRADED), NEVER a silent
//     { ok:true, active:false } that would read as "the rider is free".
// This holds whether or not an operational scope exists. Because migration 139
// introduces the closed-service trip state, the DATABASE MIGRATION MUST BE
// APPLIED BEFORE this backend is deployed (an uninstalled residual RPC is an
// unreadable residual on purpose). It is the one place a missing function is not
// tolerated: guessing "there is no such trip" would be a false negative.
"use strict";

const { sbSelect, sbRpc } = require("../../utils/supabase");
const { getOperationalSessionIds } = require("../../serviceSessions/currentOperationalSession");

// The service ids that still own a departed (ACTIVE) trip.
//   -> { ok:true,  ids:[...], reason:null }   readable (ids may be empty: there is genuinely none)
//   -> { ok:false, ids:[],    reason }        UNREADABLE: the caller must fail closed, never treat it as "none"
// Never throws.
const RESIDUAL_REASON = Object.freeze({
  UNREADABLE: "RESIDUAL_SCOPE_UNREADABLE",
  MALFORMED: "RESIDUAL_SCOPE_MALFORMED",
});
async function readResidualServiceScope({ rpc = sbRpc } = {}) {
  let result;
  try {
    result = await rpc("trip_residual_scope_v1", {});
  } catch (_) {
    return { ok: false, ids: [], reason: RESIDUAL_REASON.UNREADABLE };
  }
  if (!result || result.ok !== true) return { ok: false, ids: [], reason: RESIDUAL_REASON.UNREADABLE };
  const body = result.body;
  if (!body || body.ok !== true || !Array.isArray(body.service_session_ids)) {
    return { ok: false, ids: [], reason: RESIDUAL_REASON.MALFORMED };
  }
  if (!body.service_session_ids.every((id) => typeof id === "string" && id.length > 0)) {
    return { ok: false, ids: [], reason: RESIDUAL_REASON.MALFORMED };
  }
  return { ok: true, ids: [...body.service_session_ids], reason: null };
}

// deps are injectable for offline tests; defaults are the live wiring.
async function readTripProjection({
  getOperationalSessionIds: resolveScope = getOperationalSessionIds,
  select = sbSelect,
  rpc = sbRpc,
  residualScope = readResidualServiceScope,
} = {}) {
  let sessionIds;
  try {
    sessionIds = await resolveScope({ select });
  } catch (_) {
    return null;
  }
  const operational = Array.isArray(sessionIds) ? sessionIds : [];
  let residual;
  try {
    residual = await residualScope({ rpc });
  } catch (_) {
    return null;
  }
  // An unreadable residual is NEVER "no departed trip": fail closed (null = unavailable), like an unreadable projection.
  if (!residual || residual.ok !== true || !Array.isArray(residual.ids)) return null;
  const scope = [...new Set([...operational, ...residual.ids])];
  if (scope.length === 0) {
    return null;
  }

  let result;
  try {
    result = await rpc("trip_projection_v1", { p_operational_session_ids: scope });
  } catch (_) {
    return null;
  }
  if (!result || result.ok !== true || !result.body || typeof result.body !== "object") {
    return null;
  }
  return result.body;
}

module.exports = { readTripProjection, readResidualServiceScope, RESIDUAL_REASON };
