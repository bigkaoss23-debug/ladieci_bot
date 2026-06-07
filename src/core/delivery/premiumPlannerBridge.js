// ===============================================================
// premiumPlannerBridge.js — Premium Planner adapter bridge
// ===============================================================
// Mattone PURO/offline (Premium Planner fase 1, vedi
// PREMIUM_PLANNER_ENGINE_DESIGN.md §16 step 3). NON wired a index.js,
// nessun path live, nessun DB/fetch/env.
//
// Ruolo: tradurre l'output di `evaluateNewOrder.options` (planner reale)
// nell'INPUT del mapper `premiumPlannerOpportunities`. È qui — lato
// backend/motore — che è lecito derivare semantica dal planner
// (kind/status/warning, slipLabel da retraso). Il mapper resta assembler
// di contract; il frontend non calcola nulla.
//
// LIMITI ONESTI DI QUESTA FASE (vedi FINDINGS nel report):
//   1. `evaluateNewOrder` produce SOLO join same-zone (planner.js:713
//      `if (t.zona !== newOrder.zona) continue`). Le opportunità di giro
//      cross-zone "di passaggio" (Q2 dentro un giro Q5) NON esistono ancora
//      nel planner: vanno generate da un futuro strategic layer.
//   2. `option.retraso` è il ritardo del NUOVO ordine sulla sua promessa
//      (planner.js:201), NON lo slittamento delle ALTRE fermate del giro
//      (es. "Q5 se mueve +5"). Gli ETA per-fermata a valle e il loro slip
//      arrivano dal `context` fixture finché non esiste il route-impact
//      engine. Il bridge non li inventa.
//
// NAMING: `channel` (sur|oeste|cross) è derivato dal mapper dalle zone
// (singola fonte, niente duplicazione qui). NON è `canal` (sorgente
// WA/MANUAL del resto del codebase).
// ===============================================================
"use strict";

const {
  buildPremiumOpportunity,
} = require("./premiumPlannerOpportunities");
// Route-impact engine (puro/offline, zero-import): quando il context porta un
// `routeImpactInput`, il bridge delega A LUI il calcolo di routeEtas/capacity/
// status/blocked/warning/explanation. Il bridge NON duplica la matematica slip:
// la fa routeImpact. Import puro, nessun path live (vedi
// PREMIUM_PLANNER_STRATEGIC_LAYER_DESIGN.md §B).
const {
  buildRouteImpact,
  buildRouteImpactOpportunityFields,
} = require("./routeImpact");

// retraso (minuti, dal planner) → slipLabel "+N" | "". Backend math: OK qui.
// Niente eta−promised: il planner ha già calcolato il ritardo.
function slipLabelFromRetraso(retraso) {
  const n = Number(retraso);
  return Number.isFinite(n) && n > 0 ? `+${n}` : "";
}

// option.type → kind contract.
//   separate              → "crear"  (giro nuovo/standalone)
//   join_giro/join_block  → "agregar"
function kindFromPlannerOption(option) {
  return option && option.type === "separate" ? "crear" : "agregar";
}

// Policy ESPLICITA (testata) option+context → status contract.
// Precedenza: capacity full → lleno; blocked → lleno|no_recomendado;
// retraso>0 → ajuste; valid/recommended & retraso 0 → compatible; else null.
function statusFromPlannerOption(option, context = {}) {
  const cap = context.capacity || {};
  const capFull = String(cap.state || "").toLowerCase() === "full";
  if (capFull) return "lleno";

  const status = option && option.status;
  const reason = String((option && option.reason) || "").toLowerCase();
  if (status === "blocked") {
    return reason.includes("lleno") ? "lleno" : "no_recomendado";
  }

  const retraso = Number(option && option.retraso);
  if (Number.isFinite(retraso) && retraso > 0) return "ajuste";
  if (status === "valid" || status === "recommended") return "compatible";
  return null; // non inventare
}

// Warning già pronto. Precedenza: context.warning → option.reason →
// (per ajuste) default da retraso. Altrimenti "".
function warningFromPlannerOption(option, status, context = {}) {
  if (typeof context.warning === "string") return context.warning;
  if (option && typeof option.reason === "string" && option.reason) return option.reason;
  if (status === "ajuste") {
    const slip = slipLabelFromRetraso(option && option.retraso);
    return slip ? `Retraso estimado ${slip} min` : "";
  }
  return "";
}

// L'opzione "separate" del planner funge da baseline "directa sin giro".
function baselineFromSeparateOption(separateOption) {
  if (!separateOption || separateOption.type !== "separate") {
    return { directEta: null, label: "Directa sin giro" };
  }
  return {
    directEta: typeof separateOption.hora === "string" ? separateOption.hora : null,
    label: "Directa sin giro",
  };
}

// Capacity: pass-through dal context fixture. Il planner espone solo il
// boolean `full` per-opzione, NON la stringa "3/6" né la durata: quelle
// arrivano dal context finché non esiste un capacity-formatter su
// maxOrdiniPerGiro / simulateDriverSchedule.
function capacityFromContext(context = {}) {
  const c = context.capacity || {};
  return {
    pizzas: typeof c.pizzas === "string" ? c.pizzas : null,
    routeMin: Number.isFinite(c.routeMin) ? c.routeMin : null,
    limitMin: Number.isFinite(c.limitMin) ? c.limitMin : null,
    state: typeof c.state === "string" ? c.state : null,
  };
}

// Route-impact: se il context porta `routeImpactInput`, esegui il route-impact
// engine puro e ritorna i campi GIÀ CALCOLATI pronti per il mapper. Altrimenti
// null → il bridge resta sul comportamento fixture esistente (backward-compat).
function routeImpactFieldsFromContext(context = {}) {
  if (!context || context.routeImpactInput == null) return null;
  const impact = buildRouteImpact(context.routeImpactInput);
  return buildRouteImpactOpportunityFields(impact);
}

// Traduce UNA option planner (+ context fixture) nell'INPUT del mapper.
// I campi che il planner non fornisce (routeEtas a valle, baseline,
// capacity string, label) arrivano dal context: il bridge non li inventa.
//
// PRECEDENZA route-impact: se `context.routeImpactInput` esiste, i campi
// COMPUTATI dal route-impact (routeEtas, capacity, status, blocked, warning,
// explanation) BATTONO i corrispondenti campi fixture del context e la policy
// status del planner. Senza `routeImpactInput` nulla cambia.
function buildOpportunityInputFromPlannerOption(option = {}, context = {}) {
  const impact = routeImpactFieldsFromContext(context);

  const status = impact ? impact.status : statusFromPlannerOption(option, context);
  const baseline = context.baseline
    || (typeof context.directEta === "string"
      ? { directEta: context.directEta, label: "Directa sin giro" }
      : undefined);

  const input = {
    id: context.id,
    kind: kindFromPlannerOption(option),
    giroId: option && option.giro_id != null ? option.giro_id : (context.giroId != null ? context.giroId : null),
    currentOrderZone: context.currentOrderZone != null ? context.currentOrderZone : null,
    currentOrderLabel: context.currentOrderLabel,
    routeZones: Array.isArray(context.routeZones) ? context.routeZones : [],
    mapPath: context.mapPath,
    routeEtas: impact ? impact.routeEtas : (Array.isArray(context.routeEtas) ? context.routeEtas : []),
    baseline,
    capacity: impact ? impact.capacity : capacityFromContext(context),
    status,
    severity: context.severity,
    warning: impact ? impact.warning : warningFromPlannerOption(option, status, context),
    title: context.title,
    subtitle: context.subtitle,
    chip: context.chip,
    explanation: impact
      ? impact.explanation
      : (context.explanation != null
        ? context.explanation
        : (option && option.reason != null ? option.reason : "")),
    quickOptionId: context.quickOptionId,
  };

  // blocked esplicito SOLO quando il route-impact è autoritativo: il suo
  // `blocked` (es. no_recomendado per ruta larga = forzabile → false) deve
  // battere la policy di default del mapper (BLOCKING_STATUSES marcherebbe
  // no_recomendado come blocked=true). Senza routeImpact, il mapper deriva
  // blocked dallo status come prima (invariato).
  if (impact) input.blocked = impact.blocked;

  return input;
}

// Comodità: option planner → Opportunity contract-ready (via mapper).
function buildOpportunityFromPlannerOption(option, context) {
  return buildPremiumOpportunity(buildOpportunityInputFromPlannerOption(option, context));
}

// Risolve il context per ogni option: oggetto condiviso o funzione(opt, i).
function resolveContext(contextResolver, option, index) {
  if (typeof contextResolver === "function") return contextResolver(option, index) || {};
  return contextResolver || {};
}

// evaluateNewOrder result → lista di INPUT mapper (una per option).
function buildOpportunityInputsFromPlannerResult(plannerResult, contextResolver) {
  const options = plannerResult && Array.isArray(plannerResult.options) ? plannerResult.options : [];
  return options.map((opt, i) =>
    buildOpportunityInputFromPlannerOption(opt, resolveContext(contextResolver, opt, i)));
}

// evaluateNewOrder result → lista di Opportunity contract-ready.
function buildOpportunitiesFromPlannerResult(plannerResult, contextResolver) {
  return buildOpportunityInputsFromPlannerResult(plannerResult, contextResolver)
    .map((input) => buildPremiumOpportunity(input));
}

module.exports = {
  slipLabelFromRetraso,
  kindFromPlannerOption,
  statusFromPlannerOption,
  warningFromPlannerOption,
  baselineFromSeparateOption,
  capacityFromContext,
  routeImpactFieldsFromContext,
  buildOpportunityInputFromPlannerOption,
  buildOpportunityFromPlannerOption,
  buildOpportunityInputsFromPlannerResult,
  buildOpportunitiesFromPlannerResult,
};
