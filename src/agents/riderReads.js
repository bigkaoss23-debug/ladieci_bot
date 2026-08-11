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
// All DB access is injected (deps.sbSelect) so the logic is unit-testable offline.

"use strict";

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
  return filtered.map((o) => project(o, RIDER_ORDER_FIELDS));
}

// getRiderManualGiros — active-trip giros only (or operational giros pre-trip), fail-closed.
async function getRiderManualGiros(deps) {
  const m = await resolveTripMode(deps);
  if (m.mode === "fail-closed") return { error: "rider_read_unavailable", reason: m.reason };
  const rows = (await deps.sbSelect("manual_giros", "order=id.asc")) || [];
  let filtered;
  if (m.mode === "in-trip") {
    const gids = new Set((m.trip.manual_giro_ids || []).map(String));
    filtered = rows.filter((g) => gids.has(String(g.id)));
  } else {
    filtered = rows.filter((g) => g.dissolved !== true && g.completed !== true);
  }
  return filtered.map((g) => project(g, RIDER_GIRO_FIELDS));
}

module.exports = {
  getRiderOrdenes,
  getRiderManualGiros,
  readActiveTrip,
  RIDER_ORDER_FIELDS,
  RIDER_GIRO_FIELDS,
};
