"use strict";

const { sbSelect } = require("../utils/supabase");
const { madridDateStr } = require("../utils/servizio");

const round = (value) => Math.round((Number(value) || 0) * 100) / 100;
const CANCELLED = new Set(["CANCELADO", "CANCELLED", "ANULADO", "CHIUSO_FORZATO"]);

function paymentBucket(value) {
  const key = String(value || "").trim().toLowerCase();
  if (key === "efectivo" || key === "tarjeta" || key === "bizum") return key;
  return "other";
}

function eventType(event) {
  return String(event?.event_type || event?.type || "").trim().toLowerCase();
}

function eventAmount(event) {
  return round(event?.amount ?? event?.importe ?? 0);
}

function safeTicket(order, events) {
  const state = String(order.estado || order.state || "");
  const amount = round(order.totale ?? order.total ?? 0);
  const refunds = events.filter((event) => eventType(event) === "refund");
  const payments = events.filter((event) => ["payment", "payment_imported"].includes(eventType(event)));
  const voided = events.some((event) => eventType(event) === "void") || CANCELLED.has(state.toUpperCase());
  const refundedAmount = round(refunds.reduce((sum, event) => sum + eventAmount(event), 0));
  const paidAmount = round(payments.reduce((sum, event) => sum + eventAmount(event), 0));
  const legacyPaid = payments.length === 0 && (order.cobrado === true || order.ya_pagado === true);
  const collectedAmount = voided ? 0 : round(paidAmount || (legacyPaid ? amount : 0));
  const method = payments.at(-1)?.payment_method || order.metodo_pago || "";

  return Object.freeze({
    id: String(order.id || order.orden_id || ""),
    number: order.numero ?? order.numero_ordine ?? null,
    time: order.hora || "",
    state,
    amount,
    paymentMethod: method || null,
    paymentState: voided ? "cancelled" : refundedAmount > 0 ? "refunded" : collectedAmount > 0 ? "paid" : "unpaid",
    collectedAmount,
    refundedAmount,
    cancelled: voided,
    refunded: refundedAmount > 0,
  });
}

function aggregate(serviceDate, status, orders, events) {
  const byOrder = new Map();
  for (const event of events || []) {
    const id = String(event.order_id || event.orden_id || "");
    if (!byOrder.has(id)) byOrder.set(id, []);
    byOrder.get(id).push(event);
  }
  const tickets = (orders || []).map((order) => {
    const id = String(order.id || order.orden_id || "");
    return safeTicket(order, byOrder.get(id) || []);
  });
  const paymentTotals = { efectivo: 0, tarjeta: 0, bizum: 0, other: 0 };
  for (const ticket of tickets) {
    if (!ticket.cancelled && ticket.collectedAmount > 0) {
      const key = paymentBucket(ticket.paymentMethod);
      paymentTotals[key] = round(paymentTotals[key] + ticket.collectedAmount);
    }
  }
  const grossTotal = round(tickets.filter((t) => !t.cancelled).reduce((s, t) => s + t.amount, 0));
  const collectedTotal = round(tickets.reduce((s, t) => s + t.collectedAmount, 0));
  const refundedTotal = round(tickets.reduce((s, t) => s + t.refundedAmount, 0));
  const unpaidTotal = round(tickets.filter((t) => t.paymentState === "unpaid").reduce((s, t) => s + t.amount, 0));
  return {
    ok: true,
    available: status !== "none",
    code: status === "none" ? "NO_CURRENT_SERVICE" : "OK",
    serviceDate,
    status,
    tickets,
    totals: { gross: grossTotal, collected: collectedTotal, refunded: refundedTotal, unpaid: unpaidTotal, difference: round(grossTotal - collectedTotal) },
    paymentTotals,
    counts: {
      tickets: tickets.length,
      cancelled: tickets.filter((t) => t.cancelled).length,
      refunded: tickets.filter((t) => t.refunded).length,
      unpaid: tickets.filter((t) => t.paymentState === "unpaid").length,
    },
  };
}

function createCurrentServiceCloseout({ select = sbSelect, now = () => new Date() } = {}) {
  return async function getCurrentServiceCloseout() {
    const serviceDate = madridDateStr(now());
    const marker = await select("serata_summary", `fecha=eq.${encodeURIComponent(serviceDate)}&limit=1`);
    const closed = Array.isArray(marker) && marker.length > 0;
    const orders = await select(closed ? "storico" : "ordenes", closed
      ? `fecha=eq.${encodeURIComponent(serviceDate)}&order=ts.asc`
      : "order=ts.asc");
    const list = Array.isArray(orders) ? orders : [];
    if (!closed && list.length === 0) return aggregate(serviceDate, "none", [], []);
    const ids = list.map((o) => o.id || o.orden_id).filter(Boolean);
    const events = ids.length
      ? await select("order_financial_events", `order_id=in.(${ids.map((id) => encodeURIComponent(String(id))).join(",")})&order=created_at.asc`)
      : [];
    return aggregate(serviceDate, closed ? "closed" : "open", list, Array.isArray(events) ? events : []);
  };
}

const getCurrentServiceCloseout = createCurrentServiceCloseout();
module.exports = { createCurrentServiceCloseout, getCurrentServiceCloseout, aggregate };
