"use strict";

const { sbSelect } = require("../utils/supabase");
const { lifecycle } = require("../serviceSessions/serviceSessionLifecycle");
const { resolveEconomicPeriodKind, singleKindOrNull, KNOWN_KINDS } = require("./economicPeriodReadRule");

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

function safeTicket(order, events, session) {
  const state = String(order.estado || order.state || "");
  const amount = round(order.totale ?? order.total ?? 0);
  const refunds = events.filter((event) => eventType(event) === "refund");
  const payments = events.filter((event) => ["payment", "payment_imported"].includes(eventType(event)));
  const voided = events.some((event) => eventType(event) === "void") || CANCELLED.has(state.toUpperCase());

  // S-E — OBLIGATION-side economic classification for this ticket: the
  // explicit S-C stamp from any of its own financial events (all events on
  // one order share the same obligation, so the first present one suffices),
  // else the era-aware legacy fallback. Independent of any RECEIPT-side
  // language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values, named here only to describe the obligation/receipt separation, not new vocabulary
  // classification below (a PRANZO sale can be paid in SERA).
  const obligationStampedEvent = events.find((event) => KNOWN_KINDS.has(event.obligation_economic_period_kind));
  const economicKind = resolveEconomicPeriodKind(
    obligationStampedEvent ? obligationStampedEvent.obligation_economic_period_kind : null,
    session
  );

  // RECEIPT-side: each payment/refund event carries its OWN economic window,
  // independently of the obligation's. event_service_session_id, when
  // present, names the actual receipt-time session; only fall back to THIS
  // ticket's session when the event agrees with it (off-session/cross-
  // session receipts are honestly reported as unknown rather than guessed —
  // zero real rows currently diverge, see the S-E report).
  const receiptKindOf = (event) => resolveEconomicPeriodKind(
    event.event_economic_period_kind,
    (!event.event_service_session_id || String(event.event_service_session_id) === String(session && session.id))
      ? session : null
  );
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

  // S-E — net receipts (payments minus refunds) bucketed by their OWN
  // economic window, independent of economicKind above. "unknown" holds only
  // the rare, currently-inert case where a receipt's event_service_session_id
  // names a session other than this ticket's own and carries no S-C stamp
  // (see receiptKindOf) — never merged into a guessed bucket.
  // language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values, used here as object keys, not new vocabulary
  const receiptTotalsByKind = { PRANZO: 0, SERA: 0, unknown: 0 };
  if (!voided) {
    for (const event of payments) {
      const bucket = receiptKindOf(event) || "unknown";
      receiptTotalsByKind[bucket] = round(receiptTotalsByKind[bucket] + eventAmount(event));
    }
    for (const event of refunds) {
      const bucket = receiptKindOf(event) || "unknown";
      receiptTotalsByKind[bucket] = round(receiptTotalsByKind[bucket] - eventAmount(event));
    }
  }

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
    // S-E — era-aware economic classification. economicKind is the
    // OBLIGATION window (sale-creation time); receiptTotalsByKind splits net
    // receipts by their OWN, independent window (a sale created in one
    // window can legitimately be paid in the other) — see the S-E report for
    // the frozen S2 obligation/receipt precedent this mirrors.
    economicKind,
    receiptTotalsByKind,
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
    return safeTicket(order, byOrder.get(id) || [], session);
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

  // S-E — economic breakdown: an Operational Service now legitimately spans
  // both windows, so obligations (sales, gross) and receipts (net payments)
  // are split independently by their own era-aware kind, per Phase 2/3/6 of
  // the S-E brief. Cancelled tickets are excluded from obligations (mirrors
  // grossTotal above); receipts already exclude them at the source
  // (safeTicket zeroes receiptTotalsByKind for voided tickets).
  const economicBreakdown = {
    obligations: { PRANZO: 0, SERA: 0, unknown: 0 }, // language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values, used here as object keys, not new vocabulary
    receipts: { PRANZO: 0, SERA: 0, unknown: 0 },
  };
  for (const ticket of tickets) {
    if (!ticket.cancelled) {
      const bucket = ticket.economicKind || "unknown";
      economicBreakdown.obligations[bucket] = round(economicBreakdown.obligations[bucket] + ticket.amount);
    }
    for (const key of Object.keys(economicBreakdown.receipts)) {
      economicBreakdown.receipts[key] = round(economicBreakdown.receipts[key] + (ticket.receiptTotalsByKind[key] || 0));
    }
  }

  return {
    ok: true,
    available: status !== "none",
    code: status === "none" ? "NO_CURRENT_SERVICE" : "OK",
    serviceSessionId: session?.id || null,
    // S2-7D6C2, corrected S-E — the Operational Service identity (S-D) can
    // now legitimately contain obligations from BOTH economic windows, so
    // language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values, named here only to describe the label-honesty rule, not new vocabulary
    // this field only ever asserts a single PRANZO/SERA label when every
    // ticket's own era-aware economicKind agrees (singleKindOrNull) — which,
    // as of S-E, is still true for every real closeout (S-D PONR not yet
    // reached), so behavior is byte-identical to before for all current
    // data. A genuinely mixed closeout reports null here rather than a false
    // single label; economicBreakdown below always carries the real split.
    // camelCase to match the ensureCurrentServiceSession contract. A session
    // with zero tickets yet (nothing to disagree with) still reports its own
    // era-aware kind — matches pre-S-E behavior exactly for that case.
    serviceKind: tickets.length === 0
      ? resolveEconomicPeriodKind(null, session)
      : singleKindOrNull(tickets.map((t) => t.economicKind)),
    businessDate: session?.business_date || null,
    openedAt: session?.opened_at || null,
    closedAt: session?.closed_at || null,
    status,
    tickets,
    totals: { gross: grossTotal, collected: collectedTotal, refunded: refundedTotal, unpaid: unpaidTotal, difference: round(grossTotal - collectedTotal) },
    paymentTotals,
    economicBreakdown,
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
