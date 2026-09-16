// riderReads.js — S2-1C rider-scoped read boundary.
//
// When the authenticated principal is `rider`, the backend (not the client) decides which
// orders/giros are visible. W6.5 — the authority for "is there a trip, and what is in it"
// is now TRIP AUTHORITY (public.trip_projection_v1), not the DRIVER_STATO blob:
//   • before a trip  -> delivery candidates only (tipo_consegna=domicilio, LISTO/EN_ENTREGA)
//   • during a trip  -> ONLY the trip's FROZEN members (trip_members), by order_uid
// Responses are projected to the delivery-necessary fields only (no WhatsApp/conversation/
// financial-ledger internals). Admin/operator reads are untouched (this module is only
// invoked on the rider branch).
//
// W6.5 rationale: DRIVER_STATO is a COMPATIBILITY signal the canonical trip RPCs
// happen to maintain — it is not the lifecycle authority, and reading it here made a
// read boundary depend on a projection rather than on the record. Trip membership is
// frozen at departure in trip_members; that is what this module now reads. The public
// DTO is unchanged (same fields, same fail-closed 503 contract at index.js), so no
// caller and no frontend changes with it.
//
// ORDER DB access is injected (deps.sbSelect) so the logic is unit-testable
// offline; the two Authority projections are required directly (same pattern as
// previewTiming.js's W4 Packet 01 cutover). W4 Packet 02A: giro facts (membership/state/salida/hora_ref/dissolved) come
// exclusively from the canonical Giro Authority projection (public.giro_projection_v1,
// Planner W3) via giroProjectionReader/giroProjectionPort — required directly here (same
// pattern as previewTiming.js's W4 Packet 01 cutover), not injected via deps, so no
// caller (index.js) needs to change. ordenes.manual_giro_id and the raw manual_giros
// table are no longer truth for giro facts in this module; entrega_ref is the one
// legacy-metadata field the Projection doesn't claim, kept as a narrow, explicit raw
// enrichment read (see getRiderManualGiros).

"use strict";

const { readGiroProjection } = require("../core/delivery/giroProjectionReader");
const {
  effectiveGiroIdByOrderId,
  projectionAvailability,
} = require("../core/delivery/giroProjectionPort");
const { readTripProjection } = require("../core/delivery/tripProjectionReader");
const { activeTripFacts, UNAVAILABLE } = require("../core/delivery/tripProjectionPort");

// PostgREST in.(…) literal builder for giro ids. Giro ids are always mg_<yymmdd>_<seq>
// (see manualGiros.generateManualGiroId) — alphanumeric/underscore only, never a
// character PostgREST's CSV list needs quoting for. A local, tiny, pure duplicate of
// manualGiros.js's encodeIdList, kept local on purpose: this module must not depend on
// manualGiros.js (writer-adjacent, out of Packet 02A scope) for a two-line helper.
function encodeGiroIdList(ids) {
  return (ids || []).map((id) => encodeURIComponent(String(id))).join(",");
}

// Same, for the canonical order_uid (uuid) keys Trip Authority speaks.
function encodeUidList(uids) {
  return (uids || []).map((u) => encodeURIComponent(String(u))).join(",");
}

const DELIVERY_TYPE = "DOMICILIO";
const PRE_TRIP_STATES = ["LISTO", "EN_ENTREGA"];
const TERMINAL = new Set(["RETIRADO", "COMPLETADO", "COMPLETATO", "CANCELADO", "ANULADO"]);

// Minimal rider projection — delivery-required fields only.
const RIDER_ORDER_FIELDS = Object.freeze([
  "id", "num", "estado", "tipo_consegna", "zona",
  "direccion", "direccion_note", "nombre", "tel",
  "items", "totale", "metodo_pago", "cobrado",
  "nota", "nota_cucina", "hora", "forno_out",
  "salida_driver_estimada", "manual_giro_id", "salida_ref",
  "llegado", "ui_offset_min",
]);

const RIDER_GIRO_FIELDS = Object.freeze([
  "id", "salida_ref", "hora_ref", "entrega_ref",
]);

function project(row, fields) {
  const out = {};
  for (const f of fields) if (row[f] !== undefined) out[f] = row[f];
  return out;
}

// Resolve the canonical trip mode from TRIP AUTHORITY. FAIL-CLOSED (S2-1D
// discipline, unchanged): an unreadable or scope-invalid projection MUST NOT
// broaden to the pre-trip candidate list, and must never be rendered as "no
// active trip". Returns one of:
//   { mode: "pre-trip" }              — projection trustworthy, no ACTIVE trip
//   { mode: "in-trip", trip }         — ACTIVE trip with its frozen membership
//   { mode: "fail-closed", reason }   — projection missing / scope unavailable
async function resolveTripMode() {
  let projection = null;
  try {
    projection = await readTripProjection();
  } catch (_) {
    projection = null;
  }
  const facts = activeTripFacts({ projection });
  if (!facts.available) {
    return {
      mode: "fail-closed",
      reason: facts.reason === UNAVAILABLE.SCOPE ? "trip_scope_unavailable" : "trip_projection_unavailable",
    };
  }
  if (!facts.active || !facts.trip) return { mode: "pre-trip" };
  return { mode: "in-trip", trip: facts.trip };
}

// Back-compat: null when no active trip, snapshot when ACTIVE, throws never.
async function readActiveTrip() {
  const r = await resolveTripMode();
  return r.mode === "in-trip" ? r.trip : null;
}

// getRiderOrdenes — rider-scoped, snapshot-aware, fail-closed order list.
//
// P0-C3 — the pre-trip candidate scan used to fetch EVERY row in `ordenes`
// (no session/date scope at all, "order=ts.asc" only) and filter client-side.
// A stale multi-day-old DOMICILIO order stuck in LISTO/EN_ENTREGA would have
// resurfaced to a rider indefinitely — proven the same class of gap as
// Cocina/Listos, just never fixed for this surface. Now scoped the same way:
// current-business-date session set (getOperationalSessionIds), same fail-
// closed posture (a read error here still yields [], never a broadened list
// -- see the try/catch below). In-trip mode is untouched: it was already
// precisely bounded by the trip's own order_ids, never a broad scan.
async function getRiderOrdenes(deps) {
  const m = await resolveTripMode();
  if (m.mode === "fail-closed") return { error: "rider_read_unavailable", reason: m.reason };
  let rows;
  if (m.mode === "in-trip") {
    // W6.5 — the frozen membership IS the query. The pre-cutover in-trip read
    // scanned every row in `ordenes` (no scope at all, "order=ts.asc" only) and
    // filtered client-side against the DRIVER_STATO snapshot's display ids. It
    // now asks for exactly the trip's canonical members, by order_uid.
    const uids = m.trip.frozen_member_order_uids || [];
    rows = uids.length > 0
      ? (await deps.sbSelect("ordenes", `order_uid=in.(${encodeUidList(uids)})&order=ts.asc`)) || []
      : [];
  } else {
    let sessionIds = [];
    try {
      sessionIds = await deps.getOperationalSessionIds({ select: deps.sbSelect });
    } catch (_) {
      sessionIds = []; // fail closed to an empty candidate list, never an unscoped scan
    }
    rows = sessionIds.length > 0
      ? (await deps.sbSelect("ordenes", deps.serviceSessionsQuery(sessionIds, "order=ts.asc"))) || []
      : [];
  }
  let filtered;
  if (m.mode === "in-trip") {
    const uids = new Set((m.trip.frozen_member_order_uids || []).map(String));
    // Defence in depth: the query above already bounds this exactly.
    filtered = rows.filter((o) => o && o.order_uid && uids.has(String(o.order_uid)));
  } else {
    filtered = rows.filter((o) =>
      String(o.tipo_consegna || "").toUpperCase() === DELIVERY_TYPE &&
      PRE_TRIP_STATES.includes(o.estado) &&
      !TERMINAL.has(o.estado));
  }

  // W4 Packet 02A — canonical giro membership. One Projection read per request, reused
  // for every order below. ordenes.manual_giro_id is never read for this DTO field: a
  // Projection failure degrades every order's manual_giro_id to null (orders themselves
  // stay fully readable — their I/O above is independent of this), it never falls back
  // to the raw column and never raises/blocks the request.
  let giroIdByOrderId = new Map();
  try {
    const projection = await readGiroProjection();
    giroIdByOrderId = effectiveGiroIdByOrderId(projection);
  } catch (_) {
    // giroIdByOrderId stays empty -> every order's manual_giro_id below is null
  }

  return filtered.map((o) => {
    const dto = project(o, RIDER_ORDER_FIELDS);
    dto.manual_giro_id = giroIdByOrderId.get(String(o.id)) || null;
    return dto;
  });
}

// getRiderManualGiros — active-trip giros only (or operational giros pre-trip), fail-closed.
//
// W4 Packet 02A — canonical giro facts. Membership, state, salida, hora_ref and
// dissolved facts come exclusively from the Giro Authority projection; the raw
// manual_giros table is never read as truth for any of those. A single Projection
// read serves the whole request. Projection unavailable/degraded -> [] (no
// trustworthy giro facts to show — never a guessed list, never a raw fallback).
// entrega_ref is NOT a canonical W3 fact (absent from the projection by design,
// see migrations/2026-09-14_giro_authority_v1_migration_130.sql) and is kept as a
// narrow, explicit legacy-metadata enrichment read, scoped to only the giro ids
// the Projection already returned — it can never override a canonical fact because
// it supplies a field the Projection doesn't claim at all.
async function getRiderManualGiros(deps) {
  const m = await resolveTripMode();
  if (m.mode === "fail-closed") return { error: "rider_read_unavailable", reason: m.reason };

  let projection = null;
  try {
    projection = await readGiroProjection();
  } catch (_) {
    projection = null;
  }
  if (!projectionAvailability(projection).available) {
    return [];
  }

  let filtered;
  if (m.mode === "in-trip") {
    // ONE trip per Giro (W6.2): the active trip links to at most one giro_id,
    // so that is the whole in-trip giro visibility. An anchor that departed
    // without a giro shows none — never the full operational list.
    const gids = new Set(m.trip.giro_id ? [String(m.trip.giro_id)] : []);
    filtered = projection.giros.filter((g) => gids.has(String(g.giro_id)));
  } else {
    filtered = projection.giros.filter((g) => g.giro_state !== "DISSOLVED");
  }

  const giroIds = filtered.map((g) => g.giro_id);
  let entregaRefById = new Map();
  if (giroIds.length > 0) {
    try {
      const rows = (await deps.sbSelect(
        "manual_giros",
        `id=in.(${encodeGiroIdList(giroIds)})&select=id,entrega_ref`
      )) || [];
      for (const r of rows) entregaRefById.set(String(r.id), r.entrega_ref ?? null);
    } catch (_) {
      // best-effort legacy metadata only: on failure entrega_ref is null below,
      // canonical giro facts (already resolved above) are entirely unaffected
    }
  }

  return filtered.map((g) => ({
    id: g.giro_id,
    salida_ref: g.salida ?? null,
    hora_ref: g.hora_ref ?? null,
    entrega_ref: entregaRefById.get(String(g.giro_id)) ?? null,
  }));
}

module.exports = {
  getRiderOrdenes,
  getRiderManualGiros,
  readActiveTrip,
  RIDER_ORDER_FIELDS,
  RIDER_GIRO_FIELDS,
};
