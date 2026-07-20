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

// Read the active-trip snapshot from DRIVER_STATO (config table). Returns null when no
// active trip. Never throws (best-effort; a read failure degrades to "no active trip").
async function readActiveTrip(deps) {
  try {
    const rows = await deps.sbSelect("config", "chiave=eq.DRIVER_STATO");
    const raw = Array.isArray(rows) && rows[0] ? rows[0].valore : null;
    const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
    const at = obj && obj.active_trip;
    if (at && at.status === "ACTIVE" && Array.isArray(at.order_ids)) return at;
    return null;
  } catch (_) {
    return null;
  }
}

// getRiderOrdenes — rider-scoped, snapshot-aware order list.
async function getRiderOrdenes(deps) {
  const trip = await readActiveTrip(deps);
  const rows = (await deps.sbSelect("ordenes", "order=ts.asc")) || [];
  let filtered;
  if (trip) {
    const ids = new Set(trip.order_ids.map(String));
    filtered = rows.filter((o) => ids.has(String(o.id)));
  } else {
    filtered = rows.filter((o) =>
      String(o.tipo_consegna || "").toUpperCase() === DELIVERY_TYPE &&
      PRE_TRIP_STATES.includes(o.estado) &&
      !TERMINAL.has(o.estado));
  }
  return filtered.map((o) => project(o, RIDER_ORDER_FIELDS));
}

// getRiderManualGiros — only the active-trip giros (or current operational giros pre-trip),
// never historical/dissolved ones, projected to RepartidorPage's needs.
async function getRiderManualGiros(deps) {
  const trip = await readActiveTrip(deps);
  const rows = (await deps.sbSelect("manual_giros", "order=id.asc")) || [];
  let filtered;
  if (trip) {
    const gids = new Set((trip.manual_giro_ids || []).map(String));
    filtered = rows.filter((g) => gids.has(String(g.id)));
  } else {
    // Pre-trip: only giros that still have operational (non-terminal) work.
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
