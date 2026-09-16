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
//
// Planner W6.6 final cleanup — `canonical_departed_order_ids` closes the one
// remaining gap: trip_projection_v1 only ever reports the ACTIVE trip (a
// CLOSED one reads back identically to "never departed", see
// tripProjectionPort.js's header), so once a trip closes this module's own
// has_active_trip/members facts can no longer vouch for its former members.
// giro_projection_v1's salida_source='DEPARTED' (derive_giros_v1, migration
// 135) is the one canonical fact that survives that close, for any order whose
// departure went out attached to a giro. It is read unconditionally, not only
// on an active trip, and reported fail-closed (empty) alongside every DTO
// shape below -- never merged into has_active_trip/members, which stay exactly
// what trip_projection_v1 itself says.
// ===============================================================
"use strict";

const { sbSelect } = require("../../utils/supabase");
const { readTripProjection } = require("./tripProjectionReader");
const { activeTripFacts } = require("./tripProjectionPort");
const { readGiroProjection } = require("./giroProjectionReader");
const { projectionAvailability, canonicalDepartedOrderIds } = require("./giroProjectionPort");

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
// `departedOrderIds` is the giro-sourced fact (see header): reported even
// while the trip projection itself is degraded, since it is read separately
// and fails closed (empty) on its own, never borrowing the trip read's state.
function degradedDto(facts, departedOrderIds) {
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
    canonical_departed_order_ids: departedOrderIds,
  };
}

function noActiveTripDto(facts, departedOrderIds) {
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
    canonical_departed_order_ids: departedOrderIds,
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

function activeTripDto(facts, salidaFacts, departedOrderIds) {
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
    canonical_departed_order_ids: departedOrderIds,
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

  // Read unconditionally -- not only once a trip is found active -- because
  // its one useful fact here (salida_source='DEPARTED') is exactly the signal
  // that must still answer after the trip itself has closed (see header).
  let giroProjection = null;
  try {
    giroProjection = await readGiro();
  } catch (_) {
    giroProjection = null;
  }
  const departedOrderIds = canonicalDepartedOrderIds(giroProjection);

  // Cheap pre-check with no order query at all: covers unavailable/no-active
  // trip without touching `ordenes`.
  const preview = activeTripFacts({ projection });
  if (!preview.available) return degradedDto(preview, departedOrderIds);
  if (!preview.active || !preview.trip) return noActiveTripDto(preview, departedOrderIds);

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
  if (!facts.available) return degradedDto(facts, departedOrderIds);
  if (!facts.active || !facts.trip) return noActiveTripDto(facts, departedOrderIds);
  // Reuses the giro projection already read above -- never a second RPC round trip.
  const salidaFacts = await resolveGiroSalida(facts.trip.giro_id, { readGiro: async () => giroProjection });
  return activeTripDto(facts, salidaFacts, departedOrderIds);
}

module.exports = {
  getTripOperationalState,
  _internal: { ordersByUid, encodeUidList, degradedDto, noActiveTripDto, activeTripDto, resolveGiroSalida },
};
