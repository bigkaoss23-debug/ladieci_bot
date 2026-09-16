// src/core/delivery/plannerSnapshot.js
// ===============================================================
// Read-only snapshot loader for the delivery planner.
//
// This module only accepts injected DB dependencies and only uses `select`.
// It returns planner-compatible raw facts without PII by default.
//
// Final W4 Read-Cutover Packet — canonicalized at THIS boundary only.
// CURRENT business day: each order's manual_giro_id is the canonical
// compatibility alias (= giro_projection_v1's own effective_giro_id for that
// order), resolved from ONE Projection read per snapshot. It fully REPLACES
// the raw column — a raw/canonical disagreement is decided by the Projection,
// never merged. planner.js (Stage 1 bucketing) and previewStrategicOpportunities.js
// (giro-anchor merge) are UNCHANGED: they already key purely off this field's
// VALUE, so the canonical fact flows through them transparently.
//
// W6.5 — the raw `manual_giros` read is GONE. It selected nine columns of
// which seven (type/order_ids/route_order/block_start/manual_duration_min/
// created_by_operator/force) do not exist in public.manual_giros, and its only
// consumer was planner.js's unreachable Stage M. The rider block the planner
// now receives is the CANONICAL ACTIVE TRIP (Trip Authority,
// public.trip_projection_v1) in `active_trip` — a real departure, a frozen
// membership, one trip at a time.
//
// HISTORICAL day (an explicit date different from the current operational
// business date): byte-for-byte the pre-cutover raw reader — a distinct
// capability, not a fallback. The Projection has no notion of a past day.
//
// Degraded current-day Projection (unavailable/scope-invalid/degraded/RPC
// error): throws explicitly (never silently defaults every order's alias to
// null, which would misrepresent "membership unknown" as "no giro exists").
// Both existing callers (previewOrderPlanner.js, previewStrategicOpportunities.js)
// already catch a rejected loadPlannerSnapshot() and return their own existing
// `snapshot_unavailable`/`planner_unavailable` typed error — this is not a new
// public contract, it is the same failure path a raw db.select() error already
// took before this packet.
"use strict";

const { getCurrentOperationalBusinessDate } = require("../../serviceSessions/currentOperationalSession");
const { readGiroProjection } = require("./giroProjectionReader");
const { projectionAvailability, effectiveGiroIdByOrderId } = require("./giroProjectionPort");
const { readTripProjection } = require("./tripProjectionReader");
const { activeTripFacts } = require("./tripProjectionPort");
const { madridParts } = require("../../schedule/serviceSchedule");

const DEFAULT_LIMIT = 1000;

// `order_uid` is SELECTED (Trip Authority's join key) but deliberately NOT
// carried onto the normalized planner order: the uid->display-id map is built
// from the RAW rows, so the planner-visible order shape stays byte-identical
// to the pre-W6.5 one and no uid can leak into a preview DTO.
const ORDER_SELECT_FIELDS = [
  "id",
  "order_uid",
  "tipo_consegna",
  "estado",
  "zona",
  "hora",
  "durata_andata_min",
  "items",
  "manual_giro_id",
  "forzado",
  "forzado_hora",
  "promesa_precisa",
  "created_at",
  "forno_out",
  "salida_driver_estimada",
  "entrega_estimada",
  "retraso_estimado_min",
  "conflicto_driver",
];

const TERMINAL_STATES = new Set([
  "RETIRADO",
  "COMPLETADO",
  "COMPLETATO",
  "CANCELADO",
  "ANULADO",
  "ENTREGADO",
]);

// Stati NON terminali ma nemmeno lavoro operativo confermato: vanno comunque
// esclusi dallo snapshot del planner. POR_CONFIRMAR non è chiuso, ma può non
// confermarsi mai (il fantasma #001 Q1 20:25 inquinava le proposte come ancora);
// CHIUSO_FORZATO è un ordine chiuso a fine servizio. Tenuto separato da
// TERMINAL_STATES perché semanticamente diverso (vivo/non confermato).
const NON_PLANNER_STATES = new Set([
  "POR_CONFIRMAR",
  "CHIUSO_FORZATO",
]);

function safeError(code, message) {
  const e = new Error(message || code);
  e.code = code;
  e.safe = true;
  return e;
}

function cleanLimit(limit) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), DEFAULT_LIMIT);
}

function addDays(date, days) {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function buildOrdersQuery({ date, limit } = {}) {
  const parts = [
    `select=${ORDER_SELECT_FIELDS.join(",")}`,
    "order=created_at.asc",
    `limit=${cleanLimit(limit)}`,
  ];
  if (date) {
    // Service-day Madrid che ATTRAVERSA mezzanotte: gli ordini della sera hanno
    // created_at su `date`, quelli dopo mezzanotte (00:00–06:00) su `date+1`. La
    // finestra [date, date+2) li copre entrambi e — pur usando boundary naive —
    // è abbastanza ampia da assorbire lo skew UTC↔Madrid (≤2h) senza tagliare
    // ordini validi. Sostituisce il full-scan quando il caller runtime passa una
    // date (dispatcher). Il filtro fine anti-stale vive su buildAnchorsFromSnapshot.
    const upperDate = addDays(date, 2);
    parts.splice(
      1,
      0,
      `created_at=gte.${encodeURIComponent(`${date}T00:00:00`)}`,
      `created_at=lt.${encodeURIComponent(`${upperDate}T00:00:00`)}`,
    );
  }
  return parts.join("&");
}

function requireDb(db) {
  if (!db) throw safeError("db_client_missing", "db_client_missing");
  if (typeof db.select !== "function") throw safeError("db_client_invalid", "db_client_invalid");
  return db;
}

function countPizzas(items) {
  if (!Array.isArray(items)) return 0;
  return items.reduce((sum, item) => {
    const q = Number(item && (item.q ?? item.cantidad ?? item.quantity));
    return sum + (Number.isFinite(q) && q > 0 ? q : 1);
  }, 0);
}

// effectiveGiroIdMap: null on the HISTORICAL path (raw column used verbatim,
// byte-for-byte pre-cutover behavior). On the CURRENT-day path it is always a
// Map (possibly empty) built from the Projection — its presence, not its
// contents, is what selects canonical-alias behavior, so a giro-less current
// order (absent from the map) correctly gets `null`, never falls back to the
// raw column value.
function normalizeOrder(row = {}, effectiveGiroIdMap = null) {
  const estado = row.estado || "NUEVO";
  const estadoUp = String(estado).toUpperCase();
  if (TERMINAL_STATES.has(estadoUp) || NON_PLANNER_STATES.has(estadoUp)) return null;
  const canonicalGiroId = effectiveGiroIdMap
    ? (effectiveGiroIdMap.get(String(row.id)) || null)
    : (row.manual_giro_id || null);
  const out = {
    id: row.id,
    tipo_consegna: row.tipo_consegna || "DOMICILIO",
    estado,
    zona: row.zona ?? null,
    hora: row.hora ?? null,
    items: Array.isArray(row.items) ? row.items : [],
    n_pizze: Number.isFinite(Number(row.n_pizze)) ? Number(row.n_pizze) : countPizzas(row.items),
    manual_giro_id: canonicalGiroId,
    forzado: !!row.forzado,
  };

  if (row.durata_andata_min != null) out.andata_min = Number(row.durata_andata_min);
  if (row.forzado_hora != null) out.forzado_hora = row.forzado_hora;
  if (row.promesa_precisa != null) out.promesa_precisa = row.promesa_precisa === true;
  if (row.created_at != null) out.created_at = row.created_at;
  if (row.forno_out != null) out.forno_out = row.forno_out;
  if (row.salida_driver_estimada != null) out.salida_driver_estimada = row.salida_driver_estimada;
  if (row.entrega_estimada != null) out.entrega_estimada = row.entrega_estimada;
  if (row.retraso_estimado_min != null) out.retraso_estimado_min = Number(row.retraso_estimado_min);
  if (row.conflicto_driver != null) out.conflicto_driver = row.conflicto_driver === true;
  return out;
}

function defaultNow() {
  return "19:00";
}

// Routing rule identical to Packet 02B's getManualGirosRead: `date` absent, or
// equal to the DB-authoritative current operational business date, is the
// CURRENT-day capability (canonical). `date` present and genuinely different
// (or the current date is itself unknowable -- fail closed) is HISTORICAL, a
// distinct capability, decided BEFORE either read path runs -- never a
// try-Projection/catch-legacy fallback.
async function resolveIsHistorical(date) {
  if (date == null) return false;
  let currentBusinessDate = null;
  try {
    currentBusinessDate = await getCurrentOperationalBusinessDate();
  } catch (_) {
    currentBusinessDate = null;
  }
  return currentBusinessDate == null || date !== currentBusinessDate;
}

// Canonical order facts keyed by order_uid -- the join key Trip Authority
// speaks. Built from raw rows (terminal states included) so a completed stop
// is still resolvable.
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

// `departed_at` is a real timestamptz; the planner speaks Madrid wall clock.
// Same conversion authority every other planner module uses.
function isoToMadridHHMM(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const p = madridParts(new Date(ms));
  if (!p || p.hour == null || p.minute == null) return null;
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

async function loadPlannerSnapshot({
  db,
  date,
  now,
  includePii = false,
  limit = DEFAULT_LIMIT,
} = {}) {
  void includePii;
  const safeDb = requireDb(db);
  const isHistorical = await resolveIsHistorical(date);

  const orderRows = await safeDb.select("ordenes", buildOrdersQuery({ date, limit }));
  const rawRows = Array.isArray(orderRows) ? orderRows : [];

  let effectiveGiroIdMap = null;
  let trip = { active: false, trip: null, available: true, reason: null };
  if (!isHistorical) {
    let projection = null;
    try {
      projection = await readGiroProjection();
    } catch (_) {
      projection = null;
    }
    if (!projectionAvailability(projection).available) {
      // Explicit, typed failure -- never a silent "every order has no giro".
      // Both existing callers already catch this exact shape (their own
      // pre-cutover db.select() failures threw the same way) and surface
      // their own snapshot_unavailable/planner_unavailable typed error.
      throw safeError("giro_projection_snapshot_unavailable", "giro_projection_snapshot_unavailable");
    }
    effectiveGiroIdMap = effectiveGiroIdByOrderId(projection);

    // Canonical rider block. Built from the RAW rows on purpose: a completed
    // stop is terminal, so normalizeOrder drops it from the planner snapshot --
    // but it must still resolve here, or the FROZEN membership would silently
    // shrink as the trip progressed.
    let tripProjection = null;
    try {
      tripProjection = await readTripProjection();
    } catch (_) {
      tripProjection = null;
    }
    trip = activeTripFacts({ projection: tripProjection, ordersByUid: ordersByUid(rawRows) });
  }

  const out = {
    now: now || defaultNow(),
    orders: rawRows.map((row) => normalizeOrder(row, effectiveGiroIdMap)).filter(Boolean),
    active_trip: null,
    driver: null,
    driver_events: [],
    driver_status: null,
  };

  if (!trip.available) {
    // DEGRADED, explicitly. Trip facts exist but cannot be trusted: the planner
    // is told so, rather than being handed an "idle rider" it would believe.
    out.active_trip_unavailable = true;
    out.active_trip_unavailable_reason = trip.reason;
  } else if (trip.active && trip.trip) {
    out.active_trip = {
      trip_id: trip.trip.trip_id,
      giro_id: trip.trip.giro_id,
      departed_at_hhmm: isoToMadridHHMM(trip.trip.departed_at),
      member_order_ids: trip.trip.frozen_member_order_ids,
      outstanding_order_ids: trip.trip.outstanding_member_order_ids,
      completed_order_ids: trip.trip.completed_member_order_ids,
    };
  }

  return out;
}

module.exports = {
  loadPlannerSnapshot,
  _internal: {
    ORDER_SELECT_FIELDS,
    TERMINAL_STATES,
    NON_PLANNER_STATES,
    buildOrdersQuery,
    normalizeOrder,
    ordersByUid,
    isoToMadridHHMM,
  },
};
