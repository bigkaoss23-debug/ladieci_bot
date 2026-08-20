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

// ─── UAT-P1-B — FINALIZED SERVICE REPORTING ──────────────────────────────
// A finalized service has ONE authoritative financial truth: its official
// service_closeouts snapshot, written by the close engine inside the close
// transaction. Recomputing money from still-mutable rows after the fact can
// only ever drift from it, so once a snapshot exists it wins outright.
const centsToEur = (value) => round((Number(value) || 0) / 100);

// Money-only overlay. Ticket rows, session identity, dates and the economic
// breakdown all stay exactly as aggregated from THIS service's own rows --
// only the headline financial figures are re-sourced from the snapshot.
function withOfficialSnapshot(base, snapshot) {
  if (!snapshot) return base;
  const paymentTotals = {
    efectivo: centsToEur(snapshot.cash_amount_cents),
    tarjeta: centsToEur(snapshot.card_amount_cents),
    bizum: centsToEur(snapshot.bizum_amount_cents),
    other: centsToEur(snapshot.other_amount_cents),
  };
  const gross = centsToEur(snapshot.gross_sales_cents);
  const collected = centsToEur(snapshot.paid_amount_cents);
  return {
    ...base,
    financialSource: "official_closeout",
    closeoutId: snapshot.id || null,
    totals: {
      gross,
      collected,
      refunded: centsToEur(snapshot.total_refunds_cents),
      unpaid: centsToEur(snapshot.unpaid_exposure_cents),
      // Cancelled/voided value is carried by the snapshot and has no live
      // equivalent in `totals` -- surfaced so the report can state it.
      voided: centsToEur(snapshot.total_void_cents),
      difference: round(gross - collected),
    },
    paymentTotals,
    counts: {
      ...base.counts,
      // order_count is the snapshot's own ticket count, authoritative even if
      // the drill-down rows below are incomplete for any reason.
      tickets: Number(snapshot.order_count) || 0,
      incidents: Number(snapshot.incident_count) || 0,
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
    // UAT-P1-B — where a closed service's order rows live depends on WHICH
    // close ran: the legacy nightly archive moves them to `storico`, while the // language-guard: allow-legacy storico is the existing archive table name this reader already queried, not new vocabulary
    // V3 operator Finalizar (close_source='operator_finalizar_v3') closes the
    // service and leaves them in `ordenes`. Reading only `storico` reported a // language-guard: allow-legacy storico is the same existing archive table name, cited to explain the defect, not new vocabulary
    // real 7-ticket / 143.50 EUR service as zero tickets and 0.00 EUR
    // (staging service 4f260f1e, 2026-08-20). Both are durable, service-pinned
    // stores, so a closed service reads BOTH and de-duplicates by order id.
    // This is not a cross-service fallback: every row is filtered by this one
    // service_session_id and the mixed-rows guard below still proves it.
    const orders = closed
      ? [].concat(
        (await select("storico", `${sessionFilter}&order=ts.asc`)) || [], // language-guard: allow-legacy storico is the existing archive table name, queried here exactly as this reader already did, not new vocabulary
        (await select("ordenes", `${sessionFilter}&order=ts.asc`)) || [],
      )
      : await select("ordenes", `${sessionFilter}&order=ts.asc`);
    const deduped = [];
    const seen = new Set();
    for (const row of Array.isArray(orders) ? orders : []) {
      const key = String(row.orden_id || row.id || "");
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      deduped.push(row);
    }
    const list = deduped;
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
    const base = aggregate(session, list, Array.isArray(events) ? events : []);
    if (!closed) return base;
    // The snapshot is looked up by THIS service's id, so the money can never
    // come from a different service than the header and tickets. A closed
    // service with no snapshot (legacy closes predating the closeout table)
    // keeps the previous recomputed behaviour rather than reporting zeros.
    const closeouts = await select("service_closeouts", `${sessionFilter}&limit=1`);
    const snapshot = Array.isArray(closeouts) ? closeouts[0] : null;
    if (snapshot && String(snapshot.service_session_id || "") !== String(session.id)) {
      throw Object.assign(new Error("mixed closeout session row"), { code: "MIXED_CLOSEOUT_SESSION_ROW" });
    }
    return withOfficialSnapshot(base, snapshot);
  };
}

const getCurrentServiceCloseout = createCurrentServiceCloseout();
module.exports = { createCurrentServiceCloseout, getCurrentServiceCloseout, aggregate, withOfficialSnapshot };
