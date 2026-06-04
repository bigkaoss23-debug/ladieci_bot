// src/core/delivery/shadowPreview.js
// ===============================================================
// Internal read-only preview formatter for shadow planner output.
// Pure helper: no DB, no network, no env, no side effects.
// ===============================================================
"use strict";

const { formatShadowDiagnosticsForOperator } = require("./diagnosticWording");

function count(list) {
  return Array.isArray(list) ? list.length : 0;
}

function boolValues(obj) {
  return Object.values(obj || {});
}

function hasCriticalInvariant(shadowOutput) {
  const invariants = shadowOutput && shadowOutput.invariants;
  if (!invariants || typeof invariants !== "object") return false;
  return boolValues(invariants).some((v) => v === false);
}

function hasSignal(shadowOutput) {
  return count(shadowOutput && shadowOutput.diagnostics) > 0
    || count(shadowOutput && shadowOutput.warnings) > 0
    || count(shadowOutput && shadowOutput.differences) > 0;
}

function previewStatus(shadowOutput) {
  if (hasCriticalInvariant(shadowOutput)) return "critical";
  if (hasSignal(shadowOutput)) return "warning";
  return "ok";
}

function buildSummary(shadowOutput) {
  const zones = Array.isArray(shadowOutput && shadowOutput.zones)
    ? shadowOutput.zones.filter(Boolean)
    : [];
  return {
    totalOrders: Number(shadowOutput && shadowOutput.totalOrders) || 0,
    deliveryOrders: Number(shadowOutput && shadowOutput.deliveryOrders) || 0,
    pickupOrders: Number(shadowOutput && shadowOutput.pickupOrders) || 0,
    zones,
    trips: Number(shadowOutput && shadowOutput.trips) || 0,
    warningsCount: count(shadowOutput && shadowOutput.warnings),
    differencesCount: count(shadowOutput && shadowOutput.differences),
    diagnosticsCount: count(shadowOutput && shadowOutput.diagnostics),
  };
}

function ovenRiskSeverity(diagnostic) {
  if (!diagnostic || diagnostic.type !== "global_oven_slot_warning") return null;
  if (diagnostic.code === "forno_pieno") return "high";
  if (diagnostic.code === "forno_overload_serio") return "warning";
  return "warning";
}

function riskFromMessage(message, diagnostic) {
  const tags = message.tags || [];
  if (tags.includes("oven")) {
    return { type: "oven", label: message.title, severity: ovenRiskSeverity(diagnostic) || message.level };
  }
  if (tags.includes("dirty_geo")) {
    return { type: "dirty_geo", label: message.title, severity: message.level };
  }
  return null;
}

function buildKeyRisks(messages, diagnostics) {
  const risks = [];
  for (let i = 0; i < messages.length; i++) {
    const risk = riskFromMessage(messages[i], (diagnostics || [])[i]);
    if (risk) risks.push(risk);
  }
  return risks;
}

function addAction(actions, text) {
  if (text && !actions.includes(text)) actions.push(text);
}

function severityRank(level) {
  if (level === "critical" || level === "high") return 0;
  if (level === "warning") return 1;
  return 2;
}

function pluralOrden(count) {
  return count === 1 ? "1 orden usa" : `${count} órdenes usan`;
}

function pluralFranja(count) {
  return count === 1 ? "1 franja" : `${count} franjas`;
}

function uniqueSorted(values) {
  return [...new Set((values || []).filter(Boolean))].sort();
}

function makeGroup(groupType, level, title, message, operatorHint, items, extra = {}) {
  const tags = uniqueSorted((items || []).flatMap((item) => item.message.tags || []));
  return {
    groupType,
    level,
    title,
    message,
    operatorHint,
    count: (items || []).length,
    tags,
    ...extra,
  };
}

function ovenGroupKey(message) {
  if (message.title === "Horno lleno") return "hard";
  if (message.title === "Horno muy cargado") return "serious";
  return "soft";
}

function ovenGroupTitle(key) {
  if (key === "hard") return "Horno lleno";
  if (key === "serious") return "Horno muy cargado";
  return "Horno ligeramente sobre capacidad";
}

function ovenGroupLevel(key) {
  return key === "hard" ? "critical" : "warning";
}

function groupOperatorMessages(operatorMessages = [], diagnostics = []) {
  const dirty = [];
  const rider = [];
  const oven = { soft: [], serious: [], hard: [] };
  const fallback = [];

  for (let i = 0; i < operatorMessages.length; i++) {
    const message = operatorMessages[i];
    const diagnostic = diagnostics[i] || {};
    const tags = message.tags || [];
    const item = { message, diagnostic };
    if (tags.includes("rider_recovery") || tags.includes("future_replan")) rider.push(item);
    else if (tags.includes("dirty_geo")) dirty.push(item);
    else if (tags.includes("oven")) oven[ovenGroupKey(message)].push(item);
    else fallback.push(item);
  }

  const groups = [];
  if (dirty.length) {
    groups.push(makeGroup(
      "dirty_geo",
      "warning",
      "Q5 / Marina: tiempo estimado poco fiable",
      `${pluralOrden(dirty.length)} una estimación no-Google o poco fiable.`,
      "No lo interpretes como retraso real seguro. Verifica cuando el rider vuelve.",
      dirty,
      { zones: uniqueSorted(dirty.map((item) => item.diagnostic.zona)) },
    ));
  }
  if (rider.length) {
    groups.push(makeGroup(
      "rider_recovery",
      "info",
      "Rider reajustable cuando vuelve",
      "El sistema puede recalcular los próximos pedidos cuando el rider vuelva.",
      "El pasado no se reescribe; el futuro se ajusta con la disponibilidad real.",
      rider,
    ));
  }
  for (const key of ["hard", "serious", "soft"]) {
    const items = oven[key];
    if (!items.length) continue;
    groups.push(makeGroup(
      "oven",
      ovenGroupLevel(key),
      key === "serious" ? `Horno: ${pluralFranja(items.length)} muy cargadas` : ovenGroupTitle(key),
      `Hay ${pluralFranja(items.length)} con más pizzas que la capacidad nominal, contando también los retiros.`,
      "Revisa si conviene mover o forzar manualmente.",
      items,
      { severity: key },
    ));
  }
  if (fallback.length) {
    groups.push(makeGroup(
      "planner",
      "info",
      "Avisos del planner",
      "Hay elementos que conviene revisar antes de confirmar cambios.",
      "Revisa estos avisos antes de interpretar el plan como definitivo.",
      fallback,
    ));
  }
  return groups.sort((a, b) => severityRank(a.level) - severityRank(b.level) || a.title.localeCompare(b.title));
}

function buildSuggestedActions(messages, status) {
  const actions = [];
  for (const msg of messages || []) {
    const tags = msg.tags || [];
    if (tags.includes("dirty_geo") || tags.includes("rider_recovery")) {
      addAction(actions, "Verificar vuelta del rider");
    }
    if (tags.includes("oven")) {
      addAction(actions, "Revisar si conviene mover o forzar manualmente");
    }
  }
  if (status === "critical") addAction(actions, "Revisar invariantes críticas antes de usar el plan");
  return actions;
}

function buildShadowPreviewForOperator(shadowOutput = {}) {
  const status = previewStatus(shadowOutput);
  const diagnostics = Array.isArray(shadowOutput.diagnostics) ? shadowOutput.diagnostics : [];
  const operatorMessages = formatShadowDiagnosticsForOperator({ diagnostics });
  const groupedOperatorMessages = groupOperatorMessages(operatorMessages, diagnostics);
  return {
    status,
    title: "Vista previa planner",
    summary: buildSummary(shadowOutput),
    operatorMessages,
    groupedOperatorMessages,
    keyRisks: buildKeyRisks(operatorMessages, diagnostics),
    suggestedOperatorActions: buildSuggestedActions(operatorMessages, status),
    rawDiagnosticsHidden: true,
    readOnly: true,
  };
}

module.exports = {
  buildShadowPreviewForOperator,
  _internal: {
    previewStatus,
    buildSummary,
    groupOperatorMessages,
    buildKeyRisks,
    buildSuggestedActions,
  },
};
