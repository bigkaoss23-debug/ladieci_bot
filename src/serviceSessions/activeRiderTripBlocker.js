"use strict";
// ===============================================================
// activeRiderTripBlocker.js — ACTIVE RIDER TRIP / SERVICE CLOSE GUARD
//
// THE one definition of "this Operational Service still has a rider trip
// ACTIVE". Nothing else in the repo decides that; every consumer calls this.
//
// ─── THE INVARIANT ────────────────────────────────────────────────────────
// An Operational Service must not be closed while a canonical rider trip
// (trip_authority.trips.status = 'ACTIVE') is attributed to it.
//
// The rider path completes a stop and closes its trip as TWO separate,
// successive backend calls (rider_collect_and_complete_stop, then
// close_rider_trip), i.e. two transactions. If the second one never lands the
// order is RETIRADO + paid while the trip stays ACTIVE — and every other
// close predicate (blocking.orders, blocking.tables, unpaid, overCollected)
// reads that state as "safe to close". Before the V3 close engine the legacy
// close refused on an active trip; that gate lived only inside the legacy
// close path and went away with it (see tests/lifecycleReset.test.js, N-2).
//
// ─── WHAT "ACTIVE TRIP OF THIS SERVICE" MEANS ─────────────────────────────
// The canonical source is the Trip Authority projection
// public.trip_projection_v1(uuid[]), already read by
// core/delivery/tripProjectionReader.js: it returns the ACTIVE trip whose
// trips.service_session_id is IN the requested scope. We scope it to exactly
// [serviceSessionId]:
//   - attribution is the trip's own service_session_id (the anchor order's
//     service, frozen at departure) — never a global "any ACTIVE trip", so an
//     ACTIVE trip that belongs to another service does NOT block this one;
//   - it does not read rider_actor, so a dispatcher-started trip
//     (rider_actor NULL, migration 137) blocks exactly like a rider-started one;
//   - it is independent of the members' order states, of the UI, and of
//     DRIVER_STATO (the legacy compatibility projection).
//
// ─── ROLE OF THIS MODULE AFTER MIGRATION 138: PREFLIGHT, NOT THE AUTHORITY ─
// The AUTHORITY for this invariant is the database: close_service_session_v3
// takes the dispatch lock (L0) that start_rider_trip_v2 also takes first, and
// refuses V3_CLOSE_ACTIVE_RIDER_TRIP itself when public.trip_projection_v1
// reports an ACTIVE trip for the service (migration 138). A JS check can never
// be atomic with that write — a trip may start between this read and the RPC —
// so this module is deliberately NOT relied on for correctness.
//
// It is kept because it is cheap and it is the same predicate: it refuses
// BEFORE anything durable is written (no attempt, no snapshot, no closeout, no
// incident — the DB refusal comes last, after Phase A-D artifacts exist, and
// leaves them as an ordinary CASE B resume), and it feeds the pre-close scan so
// the Finalizar modal can show the trip and offer the canonical "Driver volvió"
// action. It refuses with the SAME typed codes the database uses, so callers
// have ONE vocabulary. It can only ever refuse earlier than the DB would; it
// can never allow something the DB refuses.
//
// ─── FAIL CLOSED ──────────────────────────────────────────────────────────
// If the projection cannot be read or has an unexpected shape the answer is
// NOT "no trip": it is ok:false, and the close engine refuses with a typed
// code. A guard that could silently pass on a failed read would be the same
// gap with a nicer name.
//
// ─── WHAT THIS MODULE DOES NOT DO ─────────────────────────────────────────
// It never closes, repairs or mutates a trip (close_rider_trip stays the only
// trip-close authority), never reads or writes money, and never touches
// Entregado semantics. begin_service_close_if_idle (the pre-V3 predecessor) is
// NOT reused: it is global, writes a DRIVER_STATO service_closing marker and
// has no runtime caller.
// ===============================================================

const { readTripProjection } = require("../core/delivery/tripProjectionReader");

// Engine-facing typed refusal codes. Kept next to the predicate so the
// vocabulary has one home.
const ACTIVE_RIDER_TRIP_CODE = Object.freeze({
  ACTIVE_RIDER_TRIP: "V3_CLOSE_ACTIVE_RIDER_TRIP",
  RIDER_TRIP_UNVERIFIABLE: "V3_CLOSE_RIDER_TRIP_UNVERIFIABLE",
});

// The one mapping from a trip_projection_v1-shaped object to the camelCase
// summary every consumer sees. The database refusal (migration 138) carries the
// projection's own fields under `trip`, so the preflight and the DB refusal
// produce an identical `activeTrip`.
function summarizeActiveTrip(projected) {
  const p = projected && typeof projected === "object" ? projected : {};
  return {
    tripId: p.trip_id == null ? null : String(p.trip_id),
    anchorOrderUid: p.anchor_order_uid == null ? null : String(p.anchor_order_uid),
    giroId: p.giro_id == null ? null : String(p.giro_id),
    departedAt: p.departed_at == null ? null : String(p.departed_at),
    memberCount: Array.isArray(p.members) ? p.members.length : null,
  };
}

// findActiveRiderTripForService({ serviceSessionId }) ->
//   { ok: true,  active: false }
//   { ok: true,  active: true,  trip: { tripId, anchorOrderUid, giroId, departedAt, memberCount } }
//   { ok: false, code: "RIDER_TRIP_UNVERIFIABLE" }
// Never throws.
async function findActiveRiderTripForService({ serviceSessionId, readProjection = readTripProjection } = {}) {
  if (typeof serviceSessionId !== "string" || serviceSessionId.trim() === "") {
    return { ok: false, code: "RIDER_TRIP_UNVERIFIABLE" };
  }

  let body = null;
  try {
    body = await readProjection({ getOperationalSessionIds: async () => [serviceSessionId] });
  } catch (_) {
    body = null;
  }
  // readTripProjection() already returns null for any transport/RPC failure;
  // a body that is not a well-formed `ok` projection is treated the same way.
  if (!body || body.ok !== true || typeof body.active !== "boolean") {
    return { ok: false, code: "RIDER_TRIP_UNVERIFIABLE" };
  }
  if (body.active === false) {
    return { ok: true, active: false };
  }
  return { ok: true, active: true, trip: summarizeActiveTrip(body) };
}

// closeRefusalFromCheck(check) -> null when the close may proceed, otherwise
// the typed { success:false, code, ... } refusal the close engine returns.
function closeRefusalFromCheck(check) {
  if (!check || check.ok !== true) {
    return { success: false, code: ACTIVE_RIDER_TRIP_CODE.RIDER_TRIP_UNVERIFIABLE };
  }
  if (check.active === true) {
    return { success: false, code: ACTIVE_RIDER_TRIP_CODE.ACTIVE_RIDER_TRIP, activeTrip: check.trip || null };
  }
  return null;
}

module.exports = { findActiveRiderTripForService, closeRefusalFromCheck, summarizeActiveTrip, ACTIVE_RIDER_TRIP_CODE };
