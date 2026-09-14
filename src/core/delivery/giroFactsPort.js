// src/core/delivery/giroFactsPort.js
// ===============================================================
// GiroFactsPort — TEMPORARY boundary between timingAssessmentV3 (which must
// never know about `manual_giro_id` or raw manual_giros columns) and the
// legacy giro data shape, per TB-1A/TB-2/the canonical freeze §9.
//
// This is deliberately a PURE function: it takes already-fetched rows
// (from the existing, reused `manualGiros.getManualGiros()` read helper and
// whatever order rows the caller already has — previewOrderTiming/
// previewOrderPlanner already load both) and resolves them into the typed
// GiroFacts shape the core consumes. It performs NO I/O of its own, so it
// adds no new raw DB reader anywhere: the seam is a mapping, not a query.
//
// W4 replaces this file's body with a single call into the canonical SQL
// Giro Authority projection (TB-1 decision) — the signature is the contract
// that stays stable across that swap; this implementation is intentionally
// the simplest one that satisfies it today.
// ===============================================================
"use strict";

const { isRouteChannelCompatible } = require("./deliveryChannels");
const { toServiceDayMin } = require("../../utils/zones");

// Cross-zone channel compatibility is what makes a giro able to absorb a
// same-route-but-different-zone order into the SAME trip instead of the
// engine simulating it as a second, separate one (TB-2's headline bug).
// `zona|slot10` identity plays no part here.
function resolveAbsorption(memberZonas, newOrderZona) {
  const zones = [...memberZonas, newOrderZona].filter(Boolean);
  if (zones.length === 0) return false;
  return isRouteChannelCompatible(zones);
}

// giros: rows from manualGiros.getManualGiros() (or an equivalent shape:
//   { id, hora_ref, dissolved_at, order_ids }).
// ordersById: Map|object of already-loaded order facts, keyed by order id,
//   each carrying at least `zona` and `forno_out`.
// nowServiceDayMin: injected clock (service-day minutes) — used only to
//   decide the DEPARTED heuristic (hora_ref already in the past).
function resolveIntendedGiroFacts({ giroId, newOrderZona, giros, ordersById, nowServiceDayMin } = {}) {
  const list = Array.isArray(giros) ? giros : [];
  const giro = giroId != null ? list.find((g) => g && String(g.id) === String(giroId)) : null;

  if (!giro || giro.dissolved_at) {
    return { status: "GONE", absorbsOverlap: false, estimatedSalidaMin: null };
  }

  const lookup = ordersById instanceof Map ? (id) => ordersById.get(id) : (id) => (ordersById || {})[id];
  const memberIds = Array.isArray(giro.order_ids) ? giro.order_ids : [];
  const memberZonas = memberIds.map((id) => lookup(id)).filter(Boolean).map((o) => o.zona).filter(Boolean);

  const estimatedSalidaMin = giro.hora_ref != null ? toServiceDayMin(giro.hora_ref) : null;
  const departed =
    estimatedSalidaMin != null && nowServiceDayMin != null && nowServiceDayMin >= estimatedSalidaMin;

  if (departed) {
    return { status: "DEPARTED", absorbsOverlap: false, estimatedSalidaMin };
  }

  const absorbsOverlap = resolveAbsorption(memberZonas, newOrderZona);
  return { status: "VALID", absorbsOverlap, estimatedSalidaMin };
}

// Standalone advisory: "is there a compatible giro right now even though the
// operator hasn't targeted one" — mirrors the legacy findCompatibleManualGiro
// intent, but via channel compatibility rather than same-zona-only.
function findCompatibleGiro({ newOrderZona, giros, ordersById } = {}) {
  const list = Array.isArray(giros) ? giros : [];
  const lookup = ordersById instanceof Map ? (id) => ordersById.get(id) : (id) => (ordersById || {})[id];
  for (const g of list) {
    if (!g || g.dissolved_at) continue;
    const memberIds = Array.isArray(g.order_ids) ? g.order_ids : [];
    const memberZonas = memberIds.map((id) => lookup(id)).filter(Boolean).map((o) => o.zona).filter(Boolean);
    if (memberZonas.length > 0 && resolveAbsorption(memberZonas, newOrderZona)) return g.id;
  }
  return null;
}

module.exports = { resolveIntendedGiroFacts, findCompatibleGiro, _internal: { resolveAbsorption } };
