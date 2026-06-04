// src/core/delivery/diagnosticWording.js
// ===============================================================
// Operational wording for shadow diagnostics.
// Pure helper: no DB, no network, no env, no side effects.
// ===============================================================
"use strict";

const LEVELS = {
  info: "info",
  warning: "warning",
  critical: "critical",
};

function cleanTags(tags) {
  return [...new Set((tags || []).filter(Boolean))];
}

function baseMessage(overrides) {
  return {
    level: LEVELS.info,
    title: "Aviso planner",
    message: "El planner ha detectado un elemento que conviene revisar.",
    operatorHint: "Revísalo antes de interpretar el plan como definitivo.",
    tags: ["planner"],
    ...overrides,
  };
}

function formatDirtyGeoTiming(diagnostic) {
  const zona = diagnostic && diagnostic.zona ? String(diagnostic.zona) : "Q5/Marina/Evershine";
  return baseMessage({
    level: LEVELS.warning,
    title: "Tiempo estimado poco fiable",
    message: `Este pedido ${zona} usa una estimación no-Google o fallback. El tiempo puede estar inflado respecto a la realidad.`,
    operatorHint: "No lo interpretes como retraso real seguro. Si es posible, verifica con el rider o usa el evento \"rider volvió\".",
    tags: cleanTags(["dirty_geo", "q5", "low_confidence"]),
  });
}

function formatDirtyGeoRecovery() {
  return baseMessage({
    level: LEVELS.info,
    title: "Rider reajustable cuando vuelve",
    message: "La estimación inicial puede estar sucia, pero cuando el rider vuelve el futuro se recalcula con su disponibilidad real.",
    operatorHint: "El dato sucio puede afectar una previsión, pero no debe bloquear toda la noche.",
    tags: cleanTags(["rider_recovery", "dirty_geo", "future_replan"]),
  });
}

function ovenTitle(diagnostic) {
  const code = diagnostic && diagnostic.code;
  const pizzas = Number(diagnostic && diagnostic.pizzas);
  const capacity = Number(diagnostic && diagnostic.capacity) || 4;
  if (code === "forno_pieno" || pizzas >= capacity + 4) return "Horno lleno";
  if (code === "forno_overload_serio" || pizzas >= capacity + 2) return "Horno muy cargado";
  return "Horno ligeramente sobre capacidad";
}

function ovenLevel(diagnostic) {
  const code = diagnostic && diagnostic.code;
  if (code === "forno_pieno") return LEVELS.critical;
  if (code === "forno_overload_serio") return LEVELS.warning;
  return LEVELS.warning;
}

function formatGlobalOvenSlotWarning(diagnostic) {
  const slot = diagnostic && diagnostic.slot ? ` ${diagnostic.slot}` : "";
  return baseMessage({
    level: ovenLevel(diagnostic),
    title: ovenTitle(diagnostic),
    message: `El slot de horno${slot} está cargado contando también los retiros. Esto puede influir en las entregas.`,
    operatorHint: "Comprueba si conviene mover algo o forzar manualmente.",
    tags: cleanTags(["oven", "pickup_load", "capacity"]),
  });
}

function formatDiagnosticForOperator(diagnostic) {
  const type = diagnostic && diagnostic.type;
  if (type === "dirty_geo_timing") return formatDirtyGeoTiming(diagnostic);
  if (type === "dirty_geo_recovery") return formatDirtyGeoRecovery(diagnostic);
  if (type === "global_oven_slot_warning") return formatGlobalOvenSlotWarning(diagnostic);
  return baseMessage({});
}

function formatShadowDiagnosticsForOperator(shadowOutput) {
  const diagnostics = Array.isArray(shadowOutput)
    ? shadowOutput
    : ((shadowOutput && shadowOutput.diagnostics) || []);
  return diagnostics.map(formatDiagnosticForOperator);
}

module.exports = {
  formatDiagnosticForOperator,
  formatShadowDiagnosticsForOperator,
};
