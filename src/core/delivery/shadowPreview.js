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
  return {
    status,
    title: "Vista previa planner",
    summary: buildSummary(shadowOutput),
    operatorMessages,
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
    buildKeyRisks,
    buildSuggestedActions,
  },
};
