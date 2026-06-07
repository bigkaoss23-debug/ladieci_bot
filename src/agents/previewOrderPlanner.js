// src/agents/previewOrderPlanner.js
// ===============================================================
// Nuevo Pedido Premium planner preview v1.
//
// Minimal read-only contract adapter. All runtime dependencies are injected so
// tests can guard side effects and the frontend can consume planner decisions
// without owning delivery scheduling.
// ===============================================================
"use strict";

const { loadPlannerSnapshot } = require("../core/delivery/plannerSnapshot");
const { evaluateNewOrder } = require("../core/delivery/planner");
const { resolveDeliveryFieldsReadOnly } = require("./resolveDeliveryFieldsReadOnly");

const CONTRACT = "nuevo-pedido-planner-preview-v1";
const SOURCE = "planner";
const MODE = "read_only";

function isValidHora(value) {
  if (typeof value !== "string") return false;
  const m = value.trim().match(/^(\d{1,2}):([0-5]\d)$/);
  if (!m) return false;
  const h = Number(m[1]);
  return Number.isInteger(h) && h >= 0 && h <= 23;
}

function normalizeTipo(value) {
  const v = String(value || "").trim().toUpperCase();
  if (v === "DOMICILIO" || v === "RITIRO") return v;
  return null;
}

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

function safeInput(params, tipoConsegna) {
  return {
    tipo_consegna: tipoConsegna || null,
    requested_hora: typeof params.hora === "string" ? params.hora : null,
    pizzas_count: Number.isFinite(Number(params.pizzas_count)) ? Number(params.pizzas_count) : 0,
  };
}

function basePayload(params, tipoConsegna) {
  return {
    contract: CONTRACT,
    source: SOURCE,
    mode: MODE,
    input: safeInput(params || {}, tipoConsegna),
    geo: {},
    recommendation: {},
    driver: {},
    giro: {},
    alternatives: [],
    availability_rows: [],
    warnings: [],
    blockers: [],
    explanation: [],
    safety: {
      readOnly: true,
      writesEnabled: false,
      piiIncluded: false,
    },
  };
}

function safeError(params, tipoConsegna, code, message) {
  return {
    ...basePayload(params, tipoConsegna),
    ok: false,
    error: {
      code,
      message,
      safe: true,
    },
    blockers: [{ code, message }],
  };
}

function mapWarnings(values) {
  return arrayOrEmpty(values).map((item) => {
    if (typeof item === "string") return { code: "planner_warning", message: item };
    return {
      code: item && item.code ? String(item.code) : "planner_warning",
      message: item && item.message ? String(item.message) : String(item && item.reason ? item.reason : "Planner warning"),
    };
  });
}

function mapAvailabilityRows(options) {
  return arrayOrEmpty(options).map((option) => ({
    type: option.type || "planner_option",
    hora: option.hora || option.anchor || null,
    label: option.label || option.reason || option.status || "Planner option",
    status: option.status || "info",
    reason: option.reason || null,
    giro_id: option.giro_id || null,
    can_attach: option.type === "join_giro" && (option.status === "valid" || option.status === "recommended"),
  }));
}

function mapAlternatives(options) {
  return arrayOrEmpty(options)
    .filter((option) => option && option.type === "join_giro")
    .map((option) => ({
      type: "giro",
      label: option.status === "recommended" ? "Giro recomendado" : "Giro",
      hora: option.hora || option.anchor || null,
      giro_id: option.giro_id || null,
      can_attach: option.status === "valid" || option.status === "recommended",
      reason: option.reason || null,
    }));
}

function mapBlockers(options) {
  return arrayOrEmpty(options)
    .filter((option) => option && option.status === "blocked")
    .map((option) => ({
      code: option.type || "planner_blocker",
      message: option.reason || "Planner blocker",
      giro_id: option.giro_id || null,
    }));
}

function mapPlannerResult(params, geo, plannerResult) {
  const selected = plannerResult && plannerResult.selected ? plannerResult.selected : {};
  const options = arrayOrEmpty(plannerResult && plannerResult.options);
  const recommended = plannerResult && plannerResult.recommended ? plannerResult.recommended : null;
  const selectedHora = selected.hora || params.hora || null;
  const selectedForno = selected.forno_out || selected.required_forno_out || null;
  const salida = selected.salida || null;

  return {
    ...basePayload(params, "DOMICILIO"),
    ok: true,
    geo: {
      resolved: true,
      zona: geo.zona || null,
      zona_lat: geo.zona_lat ?? null,
      zona_lon: geo.zona_lon ?? null,
      durata_andata_min: geo.durata_andata_min ?? null,
      duracion_andata_min: geo.durata_andata_min ?? null,
      durata_google_min: geo.durata_google_min ?? null,
      durata_haversine_min: geo.durata_haversine_min ?? null,
      source: geo.geo_source || null,
    },
    recommendation: {
      requested_hora: params.hora || null,
      recommended_hora: selectedHora || plannerResult.proximo_slot || null,
      can_confirm_requested_hora: selected.status === "valid" || selected.status === "recommended",
      forno_out: selectedForno,
      salida_driver: salida,
      entrega_estimada: selectedHora,
      reason: selected.reason || selected.status || null,
    },
    driver: {
      required: true,
      available: true,
      has_conflict: false,
      message: null,
    },
    giro: recommended && recommended.type === "join_giro"
      ? {
          recommended: true,
          giro_id: recommended.giro_id || null,
          zona: geo.zona || null,
          slot_hora: recommended.hora || recommended.anchor || null,
          salida_driver: recommended.required_forno_out || null,
          entrega_estimada: recommended.hora || recommended.anchor || null,
          reason: recommended.reason || null,
          can_attach: true,
        }
      : {
          recommended: false,
          giro_id: null,
          zona: geo.zona || null,
          slot_hora: null,
          salida_driver: null,
          entrega_estimada: null,
          reason: null,
          can_attach: false,
        },
    alternatives: mapAlternatives(options),
    availability_rows: mapAvailabilityRows(options),
    warnings: [
      ...mapWarnings(geo.warnings),
      ...mapWarnings(plannerResult && plannerResult.warnings),
    ],
    blockers: mapBlockers(options),
    explanation: ["Planner source of truth", "Read-only preview"],
  };
}

async function previewOrderPlanner(params = {}, deps = {}) {
  const tipoConsegna = normalizeTipo(params.tipo_consegna);
  if (!tipoConsegna) {
    return safeError(params, null, "missing_tipo_consegna", "Selecciona tipo de entrega");
  }
  if (!isValidHora(params.hora)) {
    return safeError(params, tipoConsegna, "invalid_hora", "Selecciona una hora valida");
  }

  if (tipoConsegna === "RITIRO") {
    return {
      ...basePayload(params, tipoConsegna),
      ok: true,
      geo: { resolved: false, zona: null },
      recommendation: {
        requested_hora: params.hora,
        recommended_hora: params.hora,
        can_confirm_requested_hora: true,
        forno_out: params.hora,
        salida_driver: null,
        entrega_estimada: params.hora,
        reason: "pickup_no_driver_required",
      },
      driver: {
        required: false,
        available: true,
        status: "not_required",
        has_conflict: false,
        message: null,
      },
      giro: {
        recommended: false,
        giro_id: null,
        zona: null,
        slot_hora: null,
        salida_driver: null,
        entrega_estimada: null,
        reason: "pickup_no_giro_required",
        can_attach: false,
      },
    };
  }

  if (!params.direccion) {
    return safeError(params, tipoConsegna, "missing_direccion", "Falta direccion para domicilio");
  }
  // Resolver geo: injected override se presente, altrimenti il wrapper
  // read-only/no-cache di default (mai scrive geo_cache). Le deps vengono
  // inoltrate così il wrapper può ricevere sbSelect/geocoder iniettabili nei
  // test; ignora qualsiasi writer.
  const resolveGeo = typeof deps.resolveDeliveryFields === "function"
    ? deps.resolveDeliveryFields
    : resolveDeliveryFieldsReadOnly;
  try {
    const geo = await resolveGeo(params, deps);
    if (!geo || !geo.zona || geo.durata_andata_min == null) {
      return safeError(params, tipoConsegna, "unresolved_geo", "No se pudo resolver la direccion");
    }

    const loadSnapshot = typeof deps.loadPlannerSnapshot === "function"
      ? deps.loadPlannerSnapshot
      : loadPlannerSnapshot;
    const runPlanner = typeof deps.evaluateNewOrder === "function"
      ? deps.evaluateNewOrder
      : evaluateNewOrder;
    const snapshot = await loadSnapshot({
      db: deps.db,
      date: params.date,
      now: typeof deps.now === "function" ? deps.now() : params.now,
      includePii: false,
    });
    const newOrder = {
      id: params.id || "__preview_new_order__",
      tipo_consegna: "DOMICILIO",
      estado: "NUEVO",
      zona: geo.zona,
      hora: params.hora,
      andata_min: geo.durata_andata_min,
      n_pizze: Number.isFinite(Number(params.pizzas_count)) ? Number(params.pizzas_count) : 0,
      items: arrayOrEmpty(params.items),
    };
    const plannerResult = runPlanner(snapshot, newOrder);
    return mapPlannerResult(params, geo, plannerResult || {});
  } catch (e) {
    if (e && /db_client|snapshot/i.test(String(e.code || e.message || ""))) {
      return safeError(params, tipoConsegna, "snapshot_unavailable", "Snapshot no disponible");
    }
    return safeError(params, tipoConsegna, "planner_unavailable", "Planner no disponible");
  }
}

module.exports = { previewOrderPlanner };
