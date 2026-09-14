// riderReads.js — S2-1C rider-scoped read boundary.
//
// When the authenticated principal is `rider`, the backend (not the client) decides which
// orders/giros are visible, using the DRIVER_STATO active-trip snapshot as source of truth:
//   • before a trip  -> delivery candidates only (tipo_consegna=domicilio, LISTO/EN_ENTREGA)
//   • during a trip  -> ONLY orders whose id is in active_trip.order_ids (no next-trip orders)
// Responses are projected to the delivery-necessary fields only (no WhatsApp/conversation/
// financial-ledger internals). Admin/operator reads are untouched (this module is only
// invoked on the rider branch).
//
// All ORDER/TRIP DB access is injected (deps.sbSelect) so the logic is unit-testable
// offline. W4 Packet 02A: giro facts (membership/state/salida/hora_ref/dissolved) come
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

// PostgREST in.(…) literal builder for giro ids. Giro ids are always mg_<yymmdd>_<seq>
// (see manualGiros.generateManualGiroId) — alphanumeric/underscore only, never a
// character PostgREST's CSV list needs quoting for. A local, tiny, pure duplicate of
// manualGiros.js's encodeIdList, kept local on purpose: this module must not depend on
// manualGiros.js (writer-adjacent, out of Packet 02A scope) for a two-line helper.
function encodeGiroIdList(ids) {
  return (ids || []).map((id) => encodeURIComponent(String(id))).join(",");
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

// Resolve the DRIVER_STATO trip mode. FAIL-CLOSED (S2-1D): a read error, or an IN_GIRO
// state with a malformed/missing active-trip snapshot, MUST NOT broaden to the pre-trip
// candidate list. Returns one of:
//   { mode: "pre-trip" }                     — no active trip (LIBERO / absent)
//   { mode: "in-trip", trip }                — valid ACTIVE snapshot with order_ids[]
//   { mode: "fail-closed", reason }          — read error or IN_GIRO-but-malformed snapshot
async function resolveTripMode(deps) {
  let rows;
  try {
    rows = await deps.sbSelect("config", "chiave=eq.DRIVER_STATO");
  } catch (_) {
    return { mode: "fail-closed", reason: "config_read_error" };
  }
  const raw = Array.isArray(rows) && rows[0] ? rows[0].valore : null;
  if (raw == null || raw === "") return { mode: "pre-trip" };
  let obj;
  try { obj = typeof raw === "string" ? JSON.parse(raw) : raw; }
  catch (_) { return { mode: "fail-closed", reason: "driver_stato_unparseable" }; }
  if (!obj || typeof obj !== "object") return { mode: "fail-closed", reason: "driver_stato_invalid" };

  const at = obj.active_trip;
  const inGiro = obj.stato === "IN_GIRO";
  const hasActive = at && at.status === "ACTIVE";
  if (hasActive) {
    if (!Array.isArray(at.order_ids)) return { mode: "fail-closed", reason: "snapshot_missing_order_ids" };
    return { mode: "in-trip", trip: at };
  }
  // IN_GIRO but no valid ACTIVE snapshot => inconsistent => fail closed (do NOT broaden).
  if (inGiro) return { mode: "fail-closed", reason: "in_giro_without_active_snapshot" };
  return { mode: "pre-trip" };
}

// Back-compat: null when no active trip, snapshot when ACTIVE, throws never.
async function readActiveTrip(deps) {
  const r = await resolveTripMode(deps);
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
  const m = await resolveTripMode(deps);
  if (m.mode === "fail-closed") return { error: "rider_read_unavailable", reason: m.reason };
  let rows;
  if (m.mode === "in-trip") {
    rows = (await deps.sbSelect("ordenes", "order=ts.asc")) || [];
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
    const ids = new Set(m.trip.order_ids.map(String));
    // Only valid referenced rows; never add unrelated orders.
    filtered = rows.filter((o) => ids.has(String(o.id)));
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
  const m = await resolveTripMode(deps);
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
    const gids = new Set((m.trip.manual_giro_ids || []).map(String));
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
