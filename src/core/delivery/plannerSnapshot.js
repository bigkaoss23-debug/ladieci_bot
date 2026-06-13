// src/core/delivery/plannerSnapshot.js
// ===============================================================
// Read-only snapshot loader for the delivery planner.
//
// This module only accepts injected DB dependencies and only uses `select`.
// It returns planner-compatible raw facts without PII by default.
// ===============================================================
"use strict";

const DEFAULT_LIMIT = 1000;

const ORDER_SELECT_FIELDS = [
  "id",
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

const MANUAL_GIRO_SELECT_FIELDS = [
  "id",
  "type",
  "order_ids",
  "route_order",
  "block_start",
  "manual_duration_min",
  "created_by_operator",
  "force",
  "hora_ref",
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

function buildManualGirosQuery({ limit } = {}) {
  return [
    `select=${MANUAL_GIRO_SELECT_FIELDS.join(",")}`,
    "dissolved_at=is.null",
    "order=created_at.asc",
    `limit=${cleanLimit(limit)}`,
  ].join("&");
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

function normalizeOrder(row = {}) {
  const estado = row.estado || "NUEVO";
  const estadoUp = String(estado).toUpperCase();
  if (TERMINAL_STATES.has(estadoUp) || NON_PLANNER_STATES.has(estadoUp)) return null;
  const out = {
    id: row.id,
    tipo_consegna: row.tipo_consegna || "DOMICILIO",
    estado,
    zona: row.zona ?? null,
    hora: row.hora ?? null,
    items: Array.isArray(row.items) ? row.items : [],
    n_pizze: Number.isFinite(Number(row.n_pizze)) ? Number(row.n_pizze) : countPizzas(row.items),
    manual_giro_id: row.manual_giro_id || null,
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

function normalizeManualGiro(row = {}) {
  return {
    id: row.id,
    type: row.type || null,
    order_ids: Array.isArray(row.order_ids) ? row.order_ids : [],
    route_order: Array.isArray(row.route_order) ? row.route_order : [],
    block_start: row.block_start || null,
    manual_duration_min: row.manual_duration_min != null ? Number(row.manual_duration_min) : null,
    created_by_operator: row.created_by_operator === true,
    force: row.force === true,
    hora_ref: row.hora_ref || null,
  };
}

function defaultNow() {
  return "19:00";
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
  const [orderRows, giroRows] = await Promise.all([
    safeDb.select("ordenes", buildOrdersQuery({ date, limit })),
    safeDb.select("manual_giros", buildManualGirosQuery({ limit })),
  ]);

  return {
    now: now || defaultNow(),
    orders: (Array.isArray(orderRows) ? orderRows : []).map(normalizeOrder).filter(Boolean),
    manual_giros: (Array.isArray(giroRows) ? giroRows : []).map(normalizeManualGiro).filter((g) => g.id),
    driver: null,
    driver_events: [],
    driver_status: null,
  };
}

module.exports = {
  loadPlannerSnapshot,
  _internal: {
    ORDER_SELECT_FIELDS,
    MANUAL_GIRO_SELECT_FIELDS,
    TERMINAL_STATES,
    NON_PLANNER_STATES,
    buildOrdersQuery,
    buildManualGirosQuery,
    normalizeOrder,
    normalizeManualGiro,
  },
};
