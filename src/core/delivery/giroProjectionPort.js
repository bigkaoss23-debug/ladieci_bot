// src/core/delivery/giroProjectionPort.js
// ===============================================================
// GiroProjectionPort — PURE adapter from the Giro Authority projection
// (SQL public.giro_projection_v1, Planner W3, dormant) to the GiroFacts that
// timingAssessmentV3 consumes. It is the prepared successor of giroFactsPort.js;
// the cutover happens in W4. Until then NOTHING requires this module except its
// own test (pinned by tests/giroAuthorityW3Candidate.static.test.js).
//
// Payload read (effective fields only — the projection carries no raw
// membership, and this module never looks for one):
//   { scope_valid, degraded,
//     giros:  [{ giro_id, giro_state, salida, effective_members: [{ order_uid, order_id }] }],
//     orders: [{ order_uid, order_id, effective_giro_id }] }
// No I/O, no clock, no environment: the caller passes the projection it read.
// ===============================================================
"use strict";

const { isRouteChannelCompatible } = require("./deliveryChannels");
const { toServiceDayMin } = require("../../utils/zones");

// A projection the Planner may not trust yields no giro facts at all: the caller
// reports DEGRADED (never a silent "no giro" and never a guessed one).
function projectionAvailability(projection) {
  if (!projection || typeof projection !== "object" || !Array.isArray(projection.giros)) {
    return { available: false, scopeAvailable: true, reason: "PROJECTION_MISSING" };
  }
  if (projection.scope_valid !== true) {
    return { available: false, scopeAvailable: false, reason: "SCOPE_UNAVAILABLE" };
  }
  if (projection.degraded === true) {
    return { available: false, scopeAvailable: true, reason: "TRIP_FACTS_UNAVAILABLE" };
  }
  return { available: true, scopeAvailable: true, reason: null };
}

const makeLookup = (ordersById) =>
  ordersById instanceof Map ? (id) => ordersById.get(id) : (id) => (ordersById || {})[id];

function memberZonas(giro, lookup) {
  return (giro.effective_members || [])
    .map((m) => lookup(m.order_id))
    .filter(Boolean)
    .map((o) => o.zona)
    .filter(Boolean);
}

// Same cross-zone channel rule giroFactsPort uses (sur Q1->Q2->Q5, oeste Q1->Q3->Q4).
function absorbs(zonas, newOrderZona) {
  const all = [...zonas, newOrderZona].filter(Boolean);
  return all.length > 0 && isRouteChannelCompatible(all);
}

function sameMembers(a, b) {
  if (a.length !== b.length) return false;
  const set = new Set(a.map(String));
  return b.every((x) => set.has(String(x)));
}

// GiroFacts for an intended giro. expectedMemberIds (optional) is the member list the
// operator saw when applying the proposal: a different effective set means CHANGED.
function resolveIntendedGiroFromProjection({ giroId, expectedMemberIds = null, newOrderZona = null, projection, ordersById } = {}) {
  const giro = ((projection && projection.giros) || []).find((g) => g && String(g.giro_id) === String(giroId));
  if (!giro || giro.giro_state === "DISSOLVED") {
    return { status: "GONE", absorbsOverlap: false, estimatedSalidaMin: null };
  }
  const estimatedSalidaMin = giro.salida ? toServiceDayMin(giro.salida) : null;
  if (giro.giro_state === "IN_TRIP" || giro.giro_state === "DONE") {
    return { status: "DEPARTED", absorbsOverlap: false, estimatedSalidaMin };
  }
  if (giro.giro_state !== "PLANNED") {
    return { status: "GONE", absorbsOverlap: false, estimatedSalidaMin: null };
  }
  const effectiveIds = (giro.effective_members || []).map((m) => m.order_id);
  if (Array.isArray(expectedMemberIds) && !sameMembers(effectiveIds, expectedMemberIds)) {
    return { status: "CHANGED", absorbsOverlap: false, estimatedSalidaMin };
  }
  return {
    status: "VALID",
    absorbsOverlap: absorbs(memberZonas(giro, makeLookup(ordersById)), newOrderZona),
    estimatedSalidaMin,
  };
}

// The giro part of timingAssessmentV3's facts: { scopeAvailable, intendedGiro,
// compatibleGiroAvailable }, plus `available`/`unavailableReason` for the caller.
function projectionGiroFacts({ projection, intendedGiroId = null, expectedMemberIds = null, newOrderZona = null, ordersById = null } = {}) {
  const av = projectionAvailability(projection);
  if (!av.available) {
    return { available: false, unavailableReason: av.reason, scopeAvailable: av.scopeAvailable, intendedGiro: null, compatibleGiroAvailable: false };
  }
  const lookup = makeLookup(ordersById);
  const intendedGiro = intendedGiroId != null
    ? resolveIntendedGiroFromProjection({ giroId: intendedGiroId, expectedMemberIds, newOrderZona, projection, ordersById })
    : null;
  const compatibleGiroAvailable = intendedGiroId == null && projection.giros.some((g) => {
    if (!g || g.giro_state !== "PLANNED") return false;
    const zonas = memberZonas(g, lookup);
    return zonas.length > 0 && absorbs(zonas, newOrderZona);
  });
  return { available: true, unavailableReason: null, scopeAvailable: true, intendedGiro, compatibleGiroAvailable };
}

// Source for the W4 compatibility alias: the ONLY giro id a reader may expose for an
// order is its EFFECTIVE giro. Unavailable projection -> empty map (visible "no giro").
function effectiveGiroIdByOrderId(projection) {
  const out = new Map();
  if (!projectionAvailability(projection).available) return out;
  for (const o of projection.orders || []) {
    if (o && o.order_id != null && o.effective_giro_id) out.set(String(o.order_id), String(o.effective_giro_id));
  }
  return out;
}

// Standalone advisory (no intended target yet): is there a compatible PLANNED giro
// right now that a new order could join? Mirrors giroFactsPort.findCompatibleGiro's
// contract exactly, sourced from the projection instead of the legacy shape. Never
// offers a departed (IN_TRIP/DONE) or DISSOLVED giro. Unavailable projection -> null
// (visible "no giro", never a guess).
function findCompatibleGiroFromProjection(projection, newOrderZona, ordersById) {
  if (!newOrderZona) return null;
  if (!projectionAvailability(projection).available) return null;
  const lookup = makeLookup(ordersById);
  for (const g of projection.giros || []) {
    if (!g || g.giro_state !== "PLANNED") continue;
    const zonas = memberZonas(g, lookup);
    if (zonas.length > 0 && absorbs(zonas, newOrderZona)) {
      return { giro_id: g.giro_id, effective_members: g.effective_members || [] };
    }
  }
  return null;
}

module.exports = {
  projectionAvailability,
  projectionGiroFacts,
  resolveIntendedGiroFromProjection,
  effectiveGiroIdByOrderId,
  findCompatibleGiroFromProjection,
};
