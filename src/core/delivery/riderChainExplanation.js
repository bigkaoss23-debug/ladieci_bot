// src/core/delivery/riderChainExplanation.js
// ===============================================================
// Compact rider-chain explanation for Shadow Preview/reporting.
// Pure helper: no DB, no network, no env, no side effects.
// ===============================================================
"use strict";

const DEFAULT_BUFFER_MIN = 3;
const DEFAULT_MAX_EXPLANATIONS = 3;
const DEFAULT_MATCH_TOLERANCE_MIN = 2;
const TERMINAL_STATES = new Set(["RETIRADO", "COMPLETADO", "COMPLETATO", "CANCELADO"]);

function toServiceMin(hhmm) {
  const m = /^(\d{1,2}):([0-5]\d)$/.exec(String(hhmm || ""));
  if (!m) return null;
  let h = Number(m[1]);
  if (h < 6) h += 24;
  return h * 60 + Number(m[2]);
}

function fromServiceMin(min) {
  if (!Number.isFinite(Number(min))) return null;
  let h = Math.floor(Number(min) / 60);
  const m = Number(min) % 60;
  if (h >= 24) h -= 24;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function field(order, ...names) {
  for (const name of names) {
    if (order && order[name] != null && order[name] !== "") return order[name];
  }
  return null;
}

function deliveryDuration(order) {
  const n = Number(field(order, "durata_andata_min", "andata_min"));
  return Number.isFinite(n) ? n : null;
}

function delayMinutes(order) {
  const n = Number(field(order, "retraso_estimado_min", "retraso_driver_min", "retraso"));
  return Number.isFinite(n) ? n : 0;
}

function hasDriverConflict(order) {
  return field(order, "conflicto_driver", "conflicto") === true;
}

function orderState(order) {
  return String(order && order.estado || "").toUpperCase();
}

function isTerminalOrder(order) {
  return TERMINAL_STATES.has(orderState(order));
}

function isDelivery(order) {
  return order && order.tipo_consegna === "DOMICILIO";
}

function salidaTime(order) {
  return field(order, "salida_driver_estimada", "salida");
}

function entregaTime(order) {
  return field(order, "entrega_estimada", "entrega");
}

function formatMessage(explanation) {
  const blocker = explanation.blockedByOrderId
    ? `rider bloccato da ${explanation.blockedByOrderId}${explanation.blockedByZone ? ` ${explanation.blockedByZone}` : ""}`
    : "rider non disponibile da un giro precedente";
  const until = explanation.riderAvailableAt ? ` fino alle ${explanation.riderAvailableAt}` : "";
  return `${explanation.orderId} +${explanation.delayMin} min: ${blocker}${until}`;
}

function findBlocker(order, deliveries, opts = {}) {
  const salidaSvc = toServiceMin(salidaTime(order));
  if (salidaSvc == null) return null;
  const bufferMin = Number(opts.bufferMin) || DEFAULT_BUFFER_MIN;
  const toleranceMin = Number(opts.matchToleranceMin) || DEFAULT_MATCH_TOLERANCE_MIN;
  let best = null;

  for (const prev of deliveries || []) {
    if (!prev || prev.id === order.id) continue;
    const entregaSvc = toServiceMin(entregaTime(prev));
    const dur = deliveryDuration(prev);
    if (entregaSvc == null || dur == null) continue;
    if (entregaSvc > salidaSvc) continue;
    const returnSvc = entregaSvc + bufferMin + dur;
    const delta = Math.abs(returnSvc - salidaSvc);
    const candidate = {
      order: prev,
      returnSvc,
      delta,
      reason: delta <= toleranceMin
        ? "rider_return_from_previous_delivery"
        : "rider_unavailable_unknown_previous_order",
    };
    if (!best || candidate.delta < best.delta || (candidate.delta === best.delta && returnSvc > best.returnSvc)) {
      best = candidate;
    }
  }

  if (!best || best.delta > toleranceMin) return null;
  return best;
}

function buildFallback(order) {
  return {
    type: "rider_chain",
    level: "warning",
    orderId: order.id,
    delayMin: delayMinutes(order),
    blockedByOrderId: null,
    blockedByZone: null,
    riderAvailableAt: salidaTime(order) || null,
    reason: "rider_unavailable_unknown_previous_order",
  };
}

function explainRiderDelayChain(orders = [], opts = {}) {
  const max = Number(opts.maxExplanations) || DEFAULT_MAX_EXPLANATIONS;
  const deliveries = (orders || []).filter(isDelivery);
  const explanations = [];

  for (const order of deliveries) {
    const delay = delayMinutes(order);
    if (isTerminalOrder(order)) continue;
    if (!hasDriverConflict(order) || delay <= 0) continue;

    const blocker = findBlocker(order, deliveries, opts);
    const explanation = blocker ? {
      type: "rider_chain",
      level: "warning",
      orderId: order.id,
      delayMin: delay,
      blockedByOrderId: blocker.order.id || null,
      blockedByZone: blocker.order.zona || null,
      riderAvailableAt: fromServiceMin(blocker.returnSvc),
      reason: blocker.reason,
    } : buildFallback(order);
    explanation.message = formatMessage(explanation);
    explanations.push(explanation);
  }

  return explanations
    .sort((a, b) => b.delayMin - a.delayMin || String(a.orderId).localeCompare(String(b.orderId)))
    .slice(0, max);
}

module.exports = {
  DEFAULT_BUFFER_MIN,
  explainRiderDelayChain,
  _internal: {
    toServiceMin,
    fromServiceMin,
    findBlocker,
    isTerminalOrder,
  },
};
