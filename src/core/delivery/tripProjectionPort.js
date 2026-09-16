// src/core/delivery/tripProjectionPort.js
// ===============================================================
// TripProjectionPort — PURE adapter from the Trip Authority projection
// (SQL public.trip_projection_v1, Planner W6.2) to the canonical operational
// rider/Planner read model (Planner W6.5).
//
// Payload read (exactly what the RPC returns — this module never looks for a
// field the projection does not carry):
//   { ok:false, code:'SCOPE_UNAVAILABLE' }
//   { ok:true, active:false }
//   { ok:true, active:true, trip_id, anchor_order_uid, giro_id, departed_at,
//     members: [{ order_uid, stop_seq }] }
//
// AUTHORITY RULE (W6.2/W6.3, non-negotiable here):
//   after departure the FROZEN trip membership is the authority. It is taken
//   from trip_members and nothing else. It never shrinks as stops complete, it
//   is never re-derived from the (mutable) Giro membership, and it is never
//   reconstructed from DRIVER_STATO's active_trip snapshot.
//
// Completion is NOT a Trip Authority column — trip_members carries no
// completed_at. It is derived here from the CANONICAL ORDER FACT (`estado`)
// of each frozen member, which is what the caller already loaded. That
// derivation classifies a stop; it is emphatically not a claim to be the DB's
// trip-close authority (that is trip_authority_close_active_trip_v1).
//
// No I/O, no clock of its own, no environment: the caller passes the
// projection it read and the order facts it already has.
// ===============================================================
"use strict";

// Delivery-terminal order states. Same convention already used by
// riderReads.js and plannerSnapshot.js — a stop whose order reached one of
// these is done from the rider's point of view.
const STOP_TERMINAL_STATES = new Set([
  "RETIRADO",
  "COMPLETADO",
  // language-guard: allow-legacy COMPLETATO is the existing terminal-state literal already used verbatim by riderReads.js and plannerSnapshot.js, reproduced here, not new vocabulary
  "COMPLETATO",
  "CANCELADO",
  "ANULADO",
  "ENTREGADO",
]);

// Reasons a caller may NOT trust the trip facts. Both are explicit degraded
// states: neither may ever be rendered as "no active trip".
const UNAVAILABLE = Object.freeze({
  MISSING: "TRIP_PROJECTION_MISSING",
  SCOPE: "SCOPE_UNAVAILABLE",
});

// ETA contract (Planner W6.5 §5). UNKNOWN is a first-class answer: no
// arrival-time estimate is manufactured anywhere in this module.
const ETA_STATUS = Object.freeze({
  UNKNOWN: "UNKNOWN",
  DEGRADED: "DEGRADED",
});

const ETA_REASON = Object.freeze({
  NO_ACTIVE_TRIP: "NO_ACTIVE_TRIP",
  NO_ARRIVAL_ESTIMATE_PROVIDER: "NO_ARRIVAL_ESTIMATE_PROVIDER",
  TRIP_FACTS_UNAVAILABLE: "TRIP_FACTS_UNAVAILABLE",
});

// A projection the Planner may not trust yields no trip facts at all: the
// caller reports DEGRADED (never a silent "no trip", never a guessed one).
function tripProjectionAvailability(projection) {
  if (!projection || typeof projection !== "object") {
    return { available: false, reason: UNAVAILABLE.MISSING };
  }
  if (projection.ok !== true) {
    // The only refusal the RPC emits is SCOPE_UNAVAILABLE; anything else
    // unrecognized is still an explicit "do not trust this", never a pass.
    return {
      available: false,
      reason: projection.code === UNAVAILABLE.SCOPE ? UNAVAILABLE.SCOPE : UNAVAILABLE.MISSING,
    };
  }
  return { available: true, reason: null };
}

const lookupBy = (map) =>
  map instanceof Map ? (k) => map.get(String(k)) : (k) => (map || {})[String(k)];

function isCompleted(orderFact) {
  const estado = orderFact && orderFact.estado;
  return estado != null && STOP_TERMINAL_STATES.has(String(estado).toUpperCase());
}

// Frozen membership, in stop order, enriched with the canonical order facts the
// caller already has. An order_uid the caller could not resolve stays in the
// list as `known:false` — a member we cannot describe is still a member, and
// dropping it would silently shrink the frozen membership.
function resolveMembers(projection, ordersByUid) {
  const lookup = lookupBy(ordersByUid);
  return (projection.members || [])
    .filter((m) => m && m.order_uid != null)
    .slice()
    .sort((a, b) => (Number(a.stop_seq) || 0) - (Number(b.stop_seq) || 0))
    .map((m) => {
      const fact = lookup(m.order_uid) || null;
      return {
        order_uid: String(m.order_uid),
        stop_seq: Number(m.stop_seq),
        order_id: fact && fact.id != null ? String(fact.id) : null,
        estado: fact && fact.estado != null ? String(fact.estado) : null,
        zona: fact && fact.zona != null ? fact.zona : null,
        andata_min: fact && fact.andata_min != null ? Number(fact.andata_min) : null,
        known: !!fact,
        completed: isCompleted(fact),
      };
    });
}

// The ETA contract. It publishes only facts that genuinely exist — the real
// departure instant, elapsed time, and the frozen/completed/remaining stop
// counts — and refuses to name an arrival time, because no provider in this
// backend supplies a defensible one. `nowIso` is the caller's clock; without
// it `elapsed_min` is simply absent rather than invented.
function tripEtaContract(trip, { nowIso = null } = {}) {
  if (!trip) {
    return {
      eta_status: ETA_STATUS.UNKNOWN,
      eta_reason: ETA_REASON.NO_ACTIVE_TRIP,
      departed_at: null,
      elapsed_min: null,
      stops_total: 0,
      stops_completed: 0,
      stops_remaining: 0,
    };
  }
  let elapsedMin = null;
  const departedMs = trip.departed_at ? Date.parse(trip.departed_at) : NaN;
  const nowMs = nowIso ? Date.parse(nowIso) : NaN;
  if (Number.isFinite(departedMs) && Number.isFinite(nowMs) && nowMs >= departedMs) {
    elapsedMin = Math.floor((nowMs - departedMs) / 60000);
  }
  return {
    eta_status: ETA_STATUS.UNKNOWN,
    eta_reason: ETA_REASON.NO_ARRIVAL_ESTIMATE_PROVIDER,
    departed_at: trip.departed_at,
    elapsed_min: elapsedMin,
    stops_total: trip.stops_total,
    stops_completed: trip.stops_completed,
    stops_remaining: trip.stops_remaining,
  };
}

function degradedEta(reason) {
  return {
    eta_status: ETA_STATUS.DEGRADED,
    eta_reason: reason,
    departed_at: null,
    elapsed_min: null,
    stops_total: null,
    stops_completed: null,
    stops_remaining: null,
  };
}

// THE canonical operational rider/Planner read model.
//
// `ordersByUid` — canonical order facts already loaded by the caller, keyed by
// order_uid; each may carry { id, estado, zona, andata_min }.
// `nowIso`      — the caller's clock, used only for elapsed_min.
//
// Returns, always in the same shape:
//   { available, degraded, reason, active, trip, eta }
// `available:false` is the ONLY way an unavailable projection can present. It
// never collapses to `active:false`.
function activeTripFacts({ projection, ordersByUid = null, nowIso = null } = {}) {
  const av = tripProjectionAvailability(projection);
  if (!av.available) {
    return {
      available: false,
      degraded: true,
      reason: av.reason,
      active: false,
      trip: null,
      eta: degradedEta(ETA_REASON.TRIP_FACTS_UNAVAILABLE),
    };
  }
  if (projection.active !== true) {
    return { available: true, degraded: false, reason: null, active: false, trip: null, eta: tripEtaContract(null) };
  }

  const members = resolveMembers(projection, ordersByUid);
  const completed = members.filter((m) => m.completed);
  const outstanding = members.filter((m) => !m.completed);

  const trip = {
    trip_id: projection.trip_id != null ? String(projection.trip_id) : null,
    giro_id: projection.giro_id != null ? String(projection.giro_id) : null,
    anchor_order_uid: projection.anchor_order_uid != null ? String(projection.anchor_order_uid) : null,
    departed_at: projection.departed_at || null,
    // The projection only ever returns the ACTIVE trip, so the state is not a
    // guess; a closed trip simply comes back as active:false.
    trip_state: "IN_TRIP",
    // trip_projection_v1 does not carry trip_authority.trips.rider_actor. The
    // fact is persisted but not exposed by this contract, so it is reported as
    // explicitly unknown rather than inferred from DRIVER_STATO.
    rider_actor: null,
    rider_known: false,
    members,
    // FROZEN membership — every stop the trip departed with, in stop order.
    // Completing or closing stops never removes an entry here.
    frozen_member_order_uids: members.map((m) => m.order_uid),
    frozen_member_order_ids: members.filter((m) => m.order_id).map((m) => m.order_id),
    outstanding_member_order_ids: outstanding.filter((m) => m.order_id).map((m) => m.order_id),
    completed_member_order_ids: completed.filter((m) => m.order_id).map((m) => m.order_id),
    stops_total: members.length,
    stops_completed: completed.length,
    stops_remaining: outstanding.length,
    // Progress only where real facts support it: the next stop is the first
    // frozen member that is not yet terminal. No position, no interpolation.
    current_stop: outstanding.length
      ? { order_uid: outstanding[0].order_uid, order_id: outstanding[0].order_id, stop_seq: outstanding[0].stop_seq }
      : null,
    unresolved_member_count: members.filter((m) => !m.known).length,
  };

  return { available: true, degraded: false, reason: null, active: true, trip, eta: tripEtaContract(trip, { nowIso }) };
}

module.exports = {
  tripProjectionAvailability,
  activeTripFacts,
  tripEtaContract,
  STOP_TERMINAL_STATES,
  UNAVAILABLE,
  ETA_STATUS,
  ETA_REASON,
};
