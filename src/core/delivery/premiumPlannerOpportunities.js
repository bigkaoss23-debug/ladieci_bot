// ===============================================================
// premiumPlannerOpportunities.js — Premium Planner opportunity mapper
// ===============================================================
// Mattone PURO/offline (Premium Planner fase 1, vedi
// PREMIUM_PLANNER_ENGINE_DESIGN.md §16 step 2). NON wired a index.js,
// nessun path live, nessun DB/fetch/env.
//
// Ruolo: ASSEMBLER/NORMALIZER. Trasforma campi GIÀ CALCOLATI (oggi da
// fixture; domani da un adapter che legge evaluateNewOrder +
// simulateDriverSchedule) nella shape `Opportunity` del contract
// frontend `premium-planner-popup-lab-v2`.
//
// Cosa fa (puro, no motore vivo):
//   - legge campi già dati (eta, promised, slipLabel, baseline, capacity, status…);
//   - deriva `channel` + `mapPath` dalle zone via deliveryChannels (config pura);
//   - deriva `severity` + `blocked` dallo `status` via policy ESPLICITA e testata;
//   - normalizza/valida la shape, riempiendo null/"" dove manca.
//
// Cosa NON fa (resta al motore vero, più avanti):
//   - NON stima ETA reali;
//   - NON calcola ritardi (slipLabel arriva dall'input, niente eta−promised);
//   - NON calcola capacity reale;
//   - NON decide status/compatibilità da geometria nascosta;
//   - NON chiama simulateDriverSchedule / evaluateNewOrder / DB / fetch.
//
// NB naming: `channel` (sur|oeste|cross) NON è `canal` (sorgente WA/MANUAL
// del resto del codebase). Sono concetti diversi: qui sempre `channel`.
// ===============================================================
"use strict";

const { routeChannel, orderZonesByChannel } = require("./deliveryChannels");

const CONTRACT = "premium-planner-popup-lab-v2";

// Stati ammessi (decisi dal motore, non dal frontend).
const VALID_STATUSES = ["compatible", "ajuste", "no_recomendado", "lleno"];

// Policy ESPLICITA status → severity (chiave tono UI). Testata.
const STATUS_SEVERITY = {
  compatible: "ok",
  ajuste: "warning",
  no_recomendado: "blocked",
  lleno: "blocked",
};

// Policy ESPLICITA: quali status sono "blocked" (non applicabili
// normalmente) salvo override esplicito dell'input. Testata.
const BLOCKING_STATUSES = new Set(["no_recomendado", "lleno"]);

const KIND_VALUES = new Set(["agregar", "crear"]);

function str(v, fallback = "") {
  return typeof v === "string" ? v : (v == null ? fallback : String(v));
}
function strOrNull(v) {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function arr(v) {
  return Array.isArray(v) ? v : [];
}
function has(obj, key) {
  return obj != null && Object.prototype.hasOwnProperty.call(obj, key);
}

// Normalizza/valida lo status. Non inventa: input fuori dal set → null.
function normalizePremiumPlannerStatus(status) {
  const s = str(status).trim().toLowerCase();
  return VALID_STATUSES.includes(s) ? s : null;
}

// severity dallo status, con tono "manual" per i giri da CREARE compatibili
// (coerente con la card viola del frontend). input.severity ha precedenza.
function deriveSeverity(status, kind) {
  if (kind === "crear" && status === "compatible") return "manual";
  return STATUS_SEVERITY[status] || "info";
}

// Normalizza una singola tappa della rotta. Pass-through: slipLabel arriva
// dall'input, NESSUN calcolo eta−promised qui.
function normalizeRouteEta(entry) {
  const e = entry || {};
  return {
    zone: strOrNull(e.zone),
    label: str(e.label, ""),
    eta: strOrNull(e.eta),
    promised: strOrNull(e.promised),
    slips: e.slips === true,
    slipLabel: str(e.slipLabel, ""),
    isNew: e.isNew === true,
  };
}

// Costruisce UNA opportunity contract-ready da un input già calcolato.
function buildPremiumOpportunity(input = {}) {
  const kind = KIND_VALUES.has(input.kind) ? input.kind : "agregar";
  const status = normalizePremiumPlannerStatus(input.status);

  const routeZones = arr(input.routeZones).map((z) => str(z)).filter(Boolean);

  // channel + mapPath: config pura da deliveryChannels.
  const channel = input.channel != null ? str(input.channel) : routeChannel(routeZones);
  const mapPath = has(input, "mapPath")
    ? arr(input.mapPath).map((z) => str(z))
    : ["Pizzería", ...orderZonesByChannel(routeZones)];

  // severity + blocked: policy esplicita, override input se presente.
  const severity = input.severity != null ? str(input.severity) : deriveSeverity(status, kind);
  const blocked = has(input, "blocked")
    ? input.blocked === true
    : BLOCKING_STATUSES.has(status);

  const baselineIn = input.baseline || {};
  const capacityIn = input.capacity || {};

  const giroId = kind === "crear" ? null : (strOrNull(input.giroId));
  const currentOrderZone = strOrNull(input.currentOrderZone);

  const id = strOrNull(input.id)
    || `opp-${(routeZones.join("-") || "x").toLowerCase()}`;

  const currentOrderLabel = strOrNull(input.currentOrderLabel)
    || (currentOrderZone ? `Pedido actual · ${currentOrderZone}` : "");

  const title = strOrNull(input.title)
    || (kind === "crear" && routeZones.length
        ? `Crear giro ${routeZones.join("+")}`
        : "");

  return {
    id,
    kind,
    giroId,
    channel: channel || null,
    currentOrderZone,
    currentOrderLabel,
    routeZones,
    mapPath,
    routeEtas: arr(input.routeEtas).map(normalizeRouteEta),
    baseline: {
      directEta: strOrNull(baselineIn.directEta),
      label: str(baselineIn.label, "Directa sin giro"),
    },
    capacity: {
      pizzas: strOrNull(capacityIn.pizzas),
      routeMin: Number.isFinite(capacityIn.routeMin) ? capacityIn.routeMin : null,
      limitMin: Number.isFinite(capacityIn.limitMin) ? capacityIn.limitMin : null,
      state: strOrNull(capacityIn.state),
    },
    status,
    severity,
    blocked,
    warning: str(input.warning, ""),
    title,
    subtitle: str(input.subtitle, ""),
    chip: strOrNull(input.chip) || "oportunidad",
    explanation: str(input.explanation, ""),
    quickOptionId: strOrNull(input.quickOptionId),
  };
}

// Mappa una lista di input → lista di opportunity contract-ready.
function buildPremiumOpportunities(inputs) {
  return arr(inputs).map((i) => buildPremiumOpportunity(i));
}

module.exports = {
  CONTRACT,
  VALID_STATUSES,
  STATUS_SEVERITY,
  BLOCKING_STATUSES,
  normalizePremiumPlannerStatus,
  deriveSeverity,
  normalizeRouteEta,
  buildPremiumOpportunity,
  buildPremiumOpportunities,
};
