// src/core/delivery/tripOperationalState.js
// ===============================================================
// TripOperationalState — the WIRE BRIDGE for the Trip Authority projection
// (Planner W6.6). This module adds NO new authority and NO new membership
// derivation: it composes the two existing canonical reads exactly as
// plannerSnapshot.js already does (readTripProjection -> ordersByUid ->
// activeTripFacts) and serializes tripProjectionPort's own computed shape
// into the DTO the HTTP action (getTripOperationalState, index.js) returns
// on the wire. It never reads DRIVER_STATO and never reconstructs membership
// from manual_giro_id/manual_giros.
// ===============================================================
"use strict";

const { sbSelect } = require("../../utils/supabase");
const { readTripProjection } = require("./tripProjectionReader");
const { activeTripFacts } = require("./tripProjectionPort");
const { readGiroProjection } = require("./giroProjectionReader");
const { projectionAvailability } = require("./giroProjectionPort");

// Same tiny local duplicate every read module in this codebase keeps on
// purpose (riderReads.js, manualGiroReads.js) rather than sharing a utility.
function encodeUidList(uids) {
  return (uids || []).map((u) => encodeURIComponent(String(u))).join(",");
}

const MEMBER_ORDER_SELECT = "order_uid,id,estado,zona,durata_andata_min";

// Canonical order facts keyed by order_uid -- exact sibling of
// plannerSnapshot.js's ordersByUid(), duplicated locally because that one is
// built from a broad date-scoped scan and this one is built from a query
// scoped to only the trip's own frozen members.
function ordersByUid(rows) {
  const map = new Map();
  for (const r of rows || []) {
    if (r && r.order_uid) {
      map.set(String(r.order_uid), {
        id: r.id,
        estado: r.estado,
        zona: r.zona ?? null,
        andata_min: r.durata_andata_min != null ? Number(r.durata_andata_min) : null,
      });
    }
  }
  return map;
}

// DEGRADED: never collapses to "no active trip". has_active_trip stays
// unknown (null, not false) -- false would tell a caller "rider is free".
function degradedDto(facts) {
  return {
    available: false,
    degraded: true,
    reason: facts.reason,
    has_active_trip: null,
    trip_id: null,
    trip_state: null,
    giro_id: null,
    members: [],
    completed_members: [],
    outstanding_members: [],
    stops_total: null,
    stops_completed: null,
    stops_remaining: null,
    departed_at: null,
    elapsed_min: null,
    salida: null,
    salida_source: null,
    eta_status: facts.eta.eta_status,
    eta_reason: facts.eta.eta_reason,
    rider_actor: null,
    rider_known: false,
  };
}

function noActiveTripDto(facts) {
  return {
    available: true,
    degraded: false,
    reason: null,
    has_active_trip: false,
    trip_id: null,
    trip_state: null,
    giro_id: null,
    members: [],
    completed_members: [],
    outstanding_members: [],
    stops_total: 0,
    stops_completed: 0,
    stops_remaining: 0,
    departed_at: null,
    elapsed_min: null,
    salida: null,
    salida_source: null,
    eta_status: facts.eta.eta_status,
    eta_reason: facts.eta.eta_reason,
    rider_actor: null,
    rider_known: false,
  };
}

// `salida`/`salida_source` are real Giro Authority fields (giro_projection_v1,
// migration 130; `derive_giros_v1` sets salida_source='DEPARTED' once the
// linked trip departs -- see migration 135's own header), NOT a Trip Authority
// concept -- trip_projection_v1 carries no such field. Read here, not
// invented: best-effort, exactly like riderReads.getRiderManualGiros's
// entrega_ref enrichment -- a giro-projection hiccup narrows this one pair to
// null, it never degrades the trip facts already resolved above.
async function resolveGiroSalida(giroId, { readGiro = readGiroProjection } = {}) {
  if (!giroId) return { salida: null, salida_source: null };
  let projection = null;
  try {
    projection = await readGiro();
  } catch (_) {
    projection = null;
  }
  if (!projectionAvailability(projection).available) return { salida: null, salida_source: null };
  const giro = (projection.giros || []).find((g) => g && String(g.giro_id) === String(giroId));
  if (!giro) return { salida: null, salida_source: null };
  return { salida: giro.salida ?? null, salida_source: giro.salida_source ?? null };
}

function activeTripDto(facts, salidaFacts) {
  const trip = facts.trip;
  return {
    available: true,
    degraded: false,
    reason: null,
    has_active_trip: true,
    trip_id: trip.trip_id,
    trip_state: trip.trip_state,
    giro_id: trip.giro_id,
    members: trip.members,
    completed_members: trip.completed_member_order_ids,
    outstanding_members: trip.outstanding_member_order_ids,
    stops_total: trip.stops_total,
    stops_completed: trip.stops_completed,
    stops_remaining: trip.stops_remaining,
    departed_at: trip.departed_at,
    elapsed_min: facts.eta.elapsed_min,
    salida: salidaFacts.salida,
    salida_source: salidaFacts.salida_source,
    eta_status: facts.eta.eta_status,
    eta_reason: facts.eta.eta_reason,
    rider_actor: trip.rider_actor,
    rider_known: trip.rider_known,
  };
}

// deps injectable for offline tests; defaults are the live wiring.
async function getTripOperationalState({
  select = sbSelect,
  readProjection = readTripProjection,
  readGiro = readGiroProjection,
  now = () => new Date().toISOString(),
} = {}) {
  let projection = null;
  try {
    projection = await readProjection();
  } catch (_) {
    projection = null;
  }

  // Cheap pre-check with no order query at all: covers unavailable/no-active
  // trip without touching `ordenes`.
  const preview = activeTripFacts({ projection });
  if (!preview.available) return degradedDto(preview);
  if (!preview.active || !preview.trip) return noActiveTripDto(preview);

  // Active trip: resolve the frozen membership's order facts, scoped to
  // EXACTLY the trip's own order_uids (same narrow-query discipline as
  // riderReads.getRiderOrdenes) -- never a broad `ordenes` scan.
  const uids = (projection.members || [])
    .filter((m) => m && m.order_uid != null)
    .map((m) => m.order_uid);
  let rows = [];
  if (uids.length > 0) {
    try {
      rows = (await select("ordenes", `order_uid=in.(${encodeUidList(uids)})&select=${MEMBER_ORDER_SELECT}`)) || [];
    } catch (_) {
      rows = []; // members stay resolvable (known:false) -- never dropped
    }
  }
  const facts = activeTripFacts({ projection, ordersByUid: ordersByUid(rows), nowIso: now() });
  if (!facts.available) return degradedDto(facts);
  if (!facts.active || !facts.trip) return noActiveTripDto(facts);
  const salidaFacts = await resolveGiroSalida(facts.trip.giro_id, { readGiro });
  return activeTripDto(facts, salidaFacts);
}

module.exports = {
  getTripOperationalState,
  _internal: { ordersByUid, encodeUidList, degradedDto, noActiveTripDto, activeTripDto, resolveGiroSalida },
};
