"use strict";

const { sbSelect } = require("../utils/supabase");
const { lifecycle } = require("../serviceSessions/serviceSessionLifecycle");

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

function emptyPaymentTotals() {
  return { efectivo: 0, tarjeta: 0, bizum: 0, other: 0 };
}

function addMethodAmount(target, method, amount) {
  const key = paymentBucket(method);
  target[key] = round(target[key] + amount);
}

function safeTicket(order, events) {
  const state = String(order.estado || order.state || "");
  const amount = round(order.totale ?? order.total ?? 0);
  const refunds = events.filter((event) => eventType(event) === "refund");
  const payments = events.filter((event) => ["payment", "payment_imported"].includes(eventType(event)));
  const voided = events.some((event) => eventType(event) === "void") || CANCELLED.has(state.toUpperCase());
  const refundedAmount = round(refunds.reduce((sum, event) => sum + eventAmount(event), 0));
  const paidAmount = round(payments.reduce((sum, event) => sum + eventAmount(event), 0));
  const hasLedgerEvidence = events.length > 0;
  const legacyPaid = !hasLedgerEvidence && (order.cobrado === true || order.ya_pagado === true);
  const grossCollected = round(paidAmount || (legacyPaid ? amount : 0));
  // A refund hands money back, so it must LEAVE the collected total — in the live
  // closeout and in the archived summary alike, which now share this function.
  const collectedAmount = voided ? 0 : Math.min(amount, Math.max(0, round(grossCollected - refundedAmount)));
  const unpaidAmount = voided ? 0 : Math.max(0, round(amount - collectedAmount));
  const methods = new Set(payments.map((event) => paymentBucket(event.payment_method)));
  const method = methods.size > 1 ? "mixto" : (payments.at(-1)?.payment_method || order.metodo_pago || "");
  const methodTotals = emptyPaymentTotals();
  if (!voided) {
    if (payments.length > 0) {
      for (const event of payments) addMethodAmount(methodTotals, event.payment_method, eventAmount(event));
      for (const event of refunds) addMethodAmount(methodTotals, event.payment_method, -eventAmount(event));
    } else if (legacyPaid) {
      addMethodAmount(methodTotals, order.metodo_pago, amount);
    }
  }

  const paymentState = voided ? "cancelled"
    : refundedAmount > 0 && collectedAmount === 0 ? "refunded"
    : collectedAmount >= amount && amount > 0 ? "paid"
    : collectedAmount > 0 ? "partially_paid"
    : "unpaid";

  return Object.freeze({
    // storico rows carry BOTH their own identity PK `id` and the real order key
    // `orden_id`; order_financial_events.order_id is the latter. Preferring `id`
    // made every CLOSED-session closeout look up integer PKs, match no event and
    // fall back to the legacy booleans.
    id: String(order.orden_id || order.id || ""),
    number: order.numero ?? order.numero_ordine ?? null,
    time: order.hora || "",
    state,
    amount,
    paymentMethod: method || null,
    paymentState,
    collectedAmount,
    unpaidAmount,
    refundedAmount,
    paymentTotals: methodTotals,
    cancelled: voided,
    refunded: refundedAmount > 0,
  });
}

function aggregate(session, orders, events) {
  const status = session ? session.status : "none";
  const byOrder = new Map();
  for (const event of events || []) {
    const id = String(event.order_id || event.orden_id || "");
    if (!byOrder.has(id)) byOrder.set(id, []);
    byOrder.get(id).push(event);
  }
  const tickets = (orders || []).map((order) => {
    const id = String(order.orden_id || order.id || "");
    return safeTicket(order, byOrder.get(id) || []);
  });
  const paymentTotals = emptyPaymentTotals();
  for (const ticket of tickets) {
    if (ticket.cancelled) continue;
    for (const key of Object.keys(paymentTotals)) {
      paymentTotals[key] = round(paymentTotals[key] + (ticket.paymentTotals[key] || 0));
    }
  }
  const grossTotal = round(tickets.filter((t) => !t.cancelled).reduce((s, t) => s + t.amount, 0));
  const collectedTotal = round(tickets.reduce((s, t) => s + t.collectedAmount, 0));
  const refundedTotal = round(tickets.reduce((s, t) => s + t.refundedAmount, 0));
  const unpaidTotal = round(tickets.reduce((s, t) => s + t.unpaidAmount, 0));
  return {
    ok: true,
    available: status !== "none",
    code: status === "none" ? "NO_CURRENT_SERVICE" : "OK",
    serviceSessionId: session?.id || null,
    // S2-7D6C2 — the closeout must be able to say WHICH service it is reporting.
    // Projected straight from the session row (service_kind, CHECK'd to
    // PRANZO|SERA by 2026-07-26_two_service_identity.sql) and never derived from
    // the clock, business_date or status: a closeout can report a CLOSED session
    // whose kind no longer matches whatever service is current. camelCase to
    // match the ensureCurrentServiceSession contract.
    // Stays null for legacy sessions closed before the column existed — the
    // frontend renders a neutral fallback rather than guessing.
    serviceKind: session?.service_kind || null,
    businessDate: session?.business_date || null,
    openedAt: session?.opened_at || null,
    closedAt: session?.closed_at || null,
    status,
    tickets,
    totals: { gross: grossTotal, collected: collectedTotal, refunded: refundedTotal, unpaid: unpaidTotal, difference: round(grossTotal - collectedTotal) },
    paymentTotals,
    counts: {
      tickets: tickets.length,
      cancelled: tickets.filter((t) => t.cancelled).length,
      refunded: tickets.filter((t) => t.refunded).length,
      unpaid: tickets.filter((t) => t.paymentState === "unpaid").length,
      partiallyPaid: tickets.filter((t) => t.paymentState === "partially_paid").length,
    },
  };
}

function createCurrentServiceCloseout({ select = sbSelect, sessionLifecycle = lifecycle } = {}) {
  return async function getCurrentServiceCloseout() {
    const identity = await sessionLifecycle.currentCloseout();
    if (!identity?.ok) throw Object.assign(new Error("service session identity invalid"), { code: identity?.code || "SERVICE_SESSION_IDENTITY_ERROR" });
    if (identity.code === "NO_SERVICE_SESSION") return aggregate(null, [], []);
    const session = identity.session;
    if (!session?.id || !["open", "closing", "closed"].includes(session.status)) {
      throw Object.assign(new Error("service session state corrupt"), { code: "SERVICE_SESSION_STATE_CORRUPT" });
    }
    const closed = session.status === "closed";
    const sessionFilter = `service_session_id=eq.${encodeURIComponent(session.id)}`;
    const orders = await select(closed ? "storico" : "ordenes", `${sessionFilter}&order=ts.asc`);
    const list = Array.isArray(orders) ? orders : [];
    if (list.some((row) => String(row.service_session_id || "") !== String(session.id))) {
      throw Object.assign(new Error("mixed service session rows"), { code: "MIXED_SERVICE_SESSION_ROWS" });
    }
    const ids = list.map((o) => o.orden_id || o.id).filter(Boolean);
    const events = ids.length
      ? await select("order_financial_events", `${sessionFilter}&order_id=in.(${ids.map((id) => encodeURIComponent(String(id))).join(",")})&order=created_at.asc`)
      : [];
    if ((events || []).some((row) => String(row.service_session_id || "") !== String(session.id))) {
      throw Object.assign(new Error("mixed financial session rows"), { code: "MIXED_FINANCIAL_SESSION_ROWS" });
    }
    return aggregate(session, list, Array.isArray(events) ? events : []);
  };
}

const getCurrentServiceCloseout = createCurrentServiceCloseout();
module.exports = { createCurrentServiceCloseout, getCurrentServiceCloseout, aggregate };
