// src/core/delivery/shadowPreviewEndpoint.js
// ===============================================================
// Read-only HTTP adapter for Shadow Preview UI contract.
// Runtime DB access is injected, so this module is testable offline.
// ===============================================================
"use strict";

const { runShadowFromRows, filterByDate } = require("../../../scripts/deliveryPlannerShadowLiveReadOnly");
const { buildShadowPreviewForOperator } = require("./shadowPreview");
const { buildShadowPreviewContract } = require("./shadowPreviewContract");

const ENDPOINT_PATH = "/api/delivery/shadow-preview";
const DEFAULT_LIMIT = 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
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
  "created_at",
  "geo_source",
  "durata_google_min",
  "durata_haversine_min",
  "forno_out",
  "salida_driver_estimada",
  "entrega_estimada",
  "retraso_estimado_min",
  "conflicto_driver",
  // Observability ajuste operativo (read-only, non-PII): snooze +5/+10 e timestamp
  // reale per il confronto originale/operativo/reale. NON alimentano il planner.
  "ui_offset_min",
  "listo_at",
];

function addDays(date, days) {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function cleanLimit(limit) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), DEFAULT_LIMIT);
}

function validateDate(date) {
  if (!date) return "missing_date";
  const s = String(date);
  if (!DATE_RE.test(s)) return "invalid_date";
  // Shape ok, ma il calendario può essere impossibile (es. 2026-13-99, 2026-02-31):
  // verificare che sia una data reale facendo un roundtrip ISO. Senza questo controllo
  // il successivo new Date(...).toISOString() lancia "Invalid time value" → 500.
  const parsed = new Date(`${s}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return "invalid_date";
  if (parsed.toISOString().slice(0, 10) !== s) return "invalid_date";
  return null;
}

function buildOrdersQuery(date, limit = DEFAULT_LIMIT) {
  const nextDate = addDays(date, 1);
  return [
    `select=${ORDER_SELECT_FIELDS.join(",")}`,
    `created_at=gte.${encodeURIComponent(`${date}T00:00:00`)}`,
    `created_at=lt.${encodeURIComponent(`${nextDate}T00:00:00`)}`,
    "order=created_at.asc",
    `limit=${cleanLimit(limit)}`,
  ].join("&");
}

async function readOrderRows({ date, dbClient, limit }) {
  if (!dbClient) {
    const e = new Error("db_client_missing");
    e.statusCode = 500;
    throw e;
  }
  const query = buildOrdersQuery(date, limit);
  if (typeof dbClient === "function") return dbClient("ordenes", query);
  if (typeof dbClient.select === "function") return dbClient.select("ordenes", query);
  const e = new Error("db_client_invalid");
  e.statusCode = 500;
  throw e;
}

async function buildShadowPreviewResponse({
  date,
  source = "ordenes",
  dbClient,
  now,
  limit,
  rows,
  generatedAt,
  runShadow = runShadowFromRows,
  buildPreview = buildShadowPreviewForOperator,
  buildContract = buildShadowPreviewContract,
} = {}) {
  const dateError = validateDate(date);
  if (dateError) {
    const e = new Error(dateError);
    e.statusCode = 400;
    throw e;
  }

  const rawRows = Array.isArray(rows) ? rows : await readOrderRows({ date, dbClient, limit });
  const dayRows = filterByDate(Array.isArray(rawRows) ? rawRows : [], date);
  const shadow = runShadow(dayRows, { date, now });
  const preview = buildPreview(shadow);
  const contract = buildContract({
    preview,
    generatedAt,
    source: { type: source, dates: [date] },
  });
  return {
    ...contract,
    // OBSERVABILITY ONLY: ajuste operativo (ui_offset_min) — non cambia il planner
    // né le decisioni; summary safe (no PII) calcolato dal runner. Vuoto-ma-presente
    // se nessun ordine ha ajuste. Vedi operationalAdjustmentMetrics.js.
    operationalAdjustments: shadow && shadow.operationalAdjustments
      ? shadow.operationalAdjustments
      : { totalOrders: 0, adjustedOrders: 0, activeAdjustments: 0, absorbedAdjustments: 0, outsideMargin: 0, maxAdjustmentMin: 0, avgAdjustmentMin: 0, watchOrders: [] },
    source: {
      ...contract.source,
      type: source,
      date,
      dates: [date],
      readOnly: true,
    },
  };
}

function errorPayload(error) {
  return {
    ok: false,
    readOnly: true,
    error: String(error && error.message ? error.message : "shadow_preview_failed").slice(0, 80),
    safety: {
      readOnly: true,
      writesEnabled: false,
      rawDiagnosticsHidden: true,
      piiIncluded: false,
    },
  };
}

async function handleShadowPreviewReadOnly(req, res, deps = {}) {
  if (req && req.method && req.method !== "GET") {
    return res.status(405).json(errorPayload(new Error("method_not_allowed")));
  }
  try {
    const query = (req && req.query) || {};
    const payload = await buildShadowPreviewResponse({
      date: query.date,
      now: query.now,
      limit: query.limit,
      dbClient: deps.dbClient,
      generatedAt: deps.generatedAt,
      runShadow: deps.runShadow,
      buildPreview: deps.buildPreview,
      buildContract: deps.buildContract,
    });
    return res.json(payload);
  } catch (e) {
    return res.status(e.statusCode || 500).json(errorPayload(e));
  }
}

module.exports = {
  ENDPOINT_PATH,
  ORDER_SELECT_FIELDS,
  buildOrdersQuery,
  buildShadowPreviewResponse,
  handleShadowPreviewReadOnly,
  _internal: {
    cleanLimit,
    validateDate,
    errorPayload,
  },
};
