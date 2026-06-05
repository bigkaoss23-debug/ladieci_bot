// src/core/delivery/shadowPreviewContract.js
// ===============================================================
// Stable JSON contract for a future Shadow Preview UI.
// Pure helper: no DB, no network, no env, no side effects.
// ===============================================================
"use strict";

const VERSION = "shadow-preview-contract-v1";

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

function unique(values) {
  return [...new Set(arrayOrEmpty(values).filter(Boolean))];
}

function safeStatus(status) {
  return ["ok", "warning", "critical"].includes(status) ? status : "ok";
}

function safeSource({ source, dates } = {}) {
  const sourceObj = source && typeof source === "object" ? source : {};
  return {
    type: sourceObj.type || source || "fixture",
    dates: unique(sourceObj.dates || dates),
    readOnly: true,
  };
}

function groupId(group) {
  const type = group.groupType || "planner";
  if (type === "dirty_geo") return "dirty_geo_q5";
  if (type === "rider_recovery") return "rider_recovery";
  if (type === "oven") return `oven_${group.severity || group.level || "warning"}`;
  return `planner_${type}`.replace(/[^a-z0-9_]+/gi, "_").toLowerCase();
}

function contractGroup(group) {
  return {
    id: groupId(group || {}),
    level: (group && group.level) || "info",
    title: (group && group.title) || "Aviso planner",
    message: (group && group.message) || "Hay elementos que conviene revisar.",
    operatorHint: (group && group.operatorHint) || "Revisa antes de confirmar cambios.",
    count: Number(group && group.count) || 0,
    zones: unique(group && group.zones),
    tags: unique(group && group.tags),
  };
}

function action(id, label, type, priority) {
  return { id, label, type, priority };
}

function addAction(actions, next) {
  if (!actions.some((item) => item.id === next.id)) actions.push(next);
}

function buildActions(status, groups) {
  const actions = [];
  if (status === "critical") {
    addAction(actions, action("do_not_apply_plan", "No aplicar cambios", "safety_stop", "high"));
  }
  if (status === "warning") {
    addAction(actions, action("review_before_confirming", "Revisar antes de confirmar", "manual_check", "medium"));
  }
  for (const group of groups) {
    const tags = arrayOrEmpty(group.tags);
    if (group.id === "dirty_geo_q5" || tags.includes("dirty_geo") || group.id === "rider_recovery") {
      addAction(actions, action("check_rider_return", "Verificar vuelta del rider", "manual_check", "medium"));
    }
    if (group.id.startsWith("oven_") || tags.includes("oven")) {
      addAction(actions, action("review_oven_load", "Revisar carga del horno", "manual_check", "medium"));
    }
  }
  return actions;
}

function cleanRiderChainItem(item = {}) {
  return {
    orderId: item.orderId || null,
    level: item.level || "warning",
    delayMin: Number(item.delayMin) || 0,
    blockedByOrderId: item.blockedByOrderId || null,
    blockedByZone: item.blockedByZone || null,
    riderAvailableAt: item.riderAvailableAt || null,
    reason: item.reason || "rider_unavailable_unknown_previous_order",
    message: item.message || "",
  };
}

function buildRiderChain(preview) {
  return arrayOrEmpty(preview && preview.riderChain)
    .map(cleanRiderChainItem)
    .filter((item) => item.orderId)
    .slice(0, 3);
}

function riderChainPriority(riderChain) {
  const maxDelay = Math.max(0, ...arrayOrEmpty(riderChain).map((item) => Number(item.delayMin) || 0));
  return maxDelay > 15 ? "high" : "medium";
}

function buildSummary(preview, groups) {
  const summary = preview && preview.summary ? preview.summary : {};
  return {
    totalOrders: Number(summary.totalOrders) || 0,
    deliveryOrders: Number(summary.deliveryOrders) || 0,
    pickupOrders: Number(summary.pickupOrders) || 0,
    zones: unique(summary.zones),
    warningsCount: Number(summary.warningsCount) || 0,
    differencesCount: Number(summary.differencesCount) || 0,
    riderChainCount: Number(summary.riderChainCount) || 0,
    groupedMessagesCount: groups.length,
  };
}

function buildShadowPreviewContract({ preview, generatedAt, source, dates } = {}) {
  const safePreview = preview && typeof preview === "object" ? preview : {};
  const status = safeStatus(safePreview.status);
  const groups = arrayOrEmpty(safePreview.groupedOperatorMessages).map(contractGroup);
  const riderChain = buildRiderChain(safePreview);
  const actions = buildActions(status, groups);
  if (riderChain.length > 0) {
    addAction(actions, action("review_rider_chain", "Revisar cadena rider", "manual_check", riderChainPriority(riderChain)));
  }
  return {
    version: VERSION,
    mode: "read_only",
    status,
    title: safePreview.title || "Vista previa planner",
    generatedAt: generatedAt || new Date().toISOString(),
    source: safeSource({ source, dates }),
    summary: buildSummary(safePreview, groups),
    groups,
    riderChain,
    actions,
    safety: {
      readOnly: true,
      writesEnabled: false,
      rawDiagnosticsHidden: safePreview.rawDiagnosticsHidden !== false,
      piiIncluded: false,
    },
  };
}

function buildShadowPreviewUiContract(preview) {
  return buildShadowPreviewContract({ preview });
}

module.exports = {
  buildShadowPreviewContract,
  buildShadowPreviewUiContract,
  _internal: {
    contractGroup,
    buildActions,
    buildSummary,
    buildRiderChain,
  },
};
