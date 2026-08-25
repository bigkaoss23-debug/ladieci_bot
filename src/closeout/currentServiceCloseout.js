"use strict";

const { sbSelect } = require("../utils/supabase");
const { lifecycle } = require("../serviceSessions/serviceSessionLifecycle");
const { resolveEconomicPeriodKind, singleKindOrNull, KNOWN_KINDS } = require("./economicPeriodReadRule");
// N-8 -- the shared definition of the two economic truths a closed service has.
const { snapshotToEconomicShape, describeDivergence } = require("./closedServiceEconomicTruth");
// N-11 -- the ONE definition of which statuses are historical (orders may be archived).
const { isHistoricalServiceStatus } = require("../economy/serviceStatusReporting");

const round = (value) => Math.round((Number(value) || 0) * 100) / 100;
// P0 — CHIUSO_FORZATO is deliberately NOT in this set. It is an operational -- language-guard: allow-legacy CHIUSO_FORZATO is the existing terminal-state literal this whole paragraph explains the ECONOMIC treatment of, not new vocabulary
// terminal state (the audit's own semantic verdict: "the table's business
// ended, not that the kitchen ticket was hand-confirmed served" -- see
// mesa_close_session_v1's own unconditional financial-settlement gate,
// never overridden by p_force), not an economic one -- unlike CANCELADO/
// CANCELLED/ANULADO, which ARE genuine economic voids. Reproduced live on -- language-guard: allow-legacy CHIUSO_FORZATO is the same existing terminal-state literal, restated for the staging-evidence sentence, not new vocabulary
// staging: 9 real CHIUSO_FORZATO orders, 7 fully paid, 1 partially paid, 1
// unpaid -- treating it as "cancelled" here zeroed gross/collected/unpaid/
// cash/card/bizum for real, ledger-evidenced money on 8 of those 9. Every
// downstream reader (economiaLedgerAggregate.js, economicSnapshot.js via
// the safeTicket/CANCELLED import below, and serviceLifecycleEngine.js's
// voidCents via this file's own `aggregate()` output) shares this ONE set,
// so removing it here is the one place that fixes all of them at once --
// see this slice's own report for the full reader-by-reader trace.
const CANCELLED = new Set(["CANCELADO", "CANCELLED", "ANULADO"]);

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

// N-2 — canonical obligation precedence, in ONE place so every reader that
// imports safeTicket inherits it. `obligations` is a list of order_obligations
// rows; the current obligation for an order is its HIGHEST revision (revision 1
// is written in the order's own INSERT transaction, and every later change to
// ordenes.totale appends a new immutable revision in the same transaction as
// that UPDATE, so the top revision always names the accepted total).
//
// The map is keyed exactly like the event map in aggregate() below -- on the
// order's display id -- because that is the key the callers already fold on.
// The composite (order_uid) identity is what the DB enforces uniqueness with;
// here we only need to pick a winner per order the caller already scoped.
function latestObligationsByOrder(obligations) {
  const byOrder = new Map();
  for (const row of obligations || []) {
    const id = String(row.order_id || "");
    if (!id) continue;
    const prev = byOrder.get(id);
    if (!prev || Number(row.revision || 0) > Number(prev.revision || 0)) byOrder.set(id, row);
  }
  return byOrder;
}

function safeTicket(order, events, session, obligation = null) {
  const state = String(order.estado || order.state || "");
  // N-2 PRECEDENCE, explicit and exclusive:
  //   canonical obligation row present -> its gross_amount is the obligation
  //   absent (every order created before N-2) -> the legacy ordenes.totale
  // Never both, so an order can never be counted twice, and a historical row
  // keeps reporting exactly what it always reported.
  const amount = round(
    obligation && obligation.gross_amount != null
      ? obligation.gross_amount
      : (order.totale ?? order.total ?? 0)
  );
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

function aggregate(session, orders, events, obligations) {
  const status = session ? session.status : "none";
  const byOrder = new Map();
  for (const event of events || []) {
    const id = String(event.order_id || event.orden_id || "");
    if (!byOrder.has(id)) byOrder.set(id, []);
    byOrder.get(id).push(event);
  }
  // N-2 — optional by design: a caller that passes nothing keeps the exact
  // pre-N-2 legacy behaviour for every ticket, so no reader breaks on the day
  // this ships and each one can adopt the canonical facts on its own commit.
  const obligationByOrder = latestObligationsByOrder(obligations);
  const tickets = (orders || []).map((order) => {
    const id = String(order.orden_id || order.id || "");
    return safeTicket(order, byOrder.get(id) || [], session, obligationByOrder.get(id) || null);
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
// N-8 — the cents->euros normalization and the snapshot-vs-current comparison now live
// in ONE place (closedServiceEconomicTruth.js) so this reader and Economia's
// multi-session ledger cannot grow two drifting definitions of what a snapshot means.

// Money-only overlay. Ticket rows, session identity, dates and the economic
// breakdown all stay exactly as aggregated from THIS service's own rows --
// only the headline financial figures are re-sourced from the snapshot.
//
// N-8 -- ADDITIVELY, the recomputed figures this overlay replaces are preserved under
// `currentReconciled`, and any disagreement is stated outright. The headline stays the
// SNAPSHOT and that is deliberate: this is the Finalizar record, the number the operator
// signed off on, and a late payment must never rewrite it. What changes is only that the
// other truth stops being discarded silently.
function withOfficialSnapshot(base, snapshot) {
  if (!snapshot) return base;
  const snap = snapshotToEconomicShape(snapshot);
  const divergence = describeDivergence({ current: base, snapshot });
  return {
    ...base,
    financialSource: "official_closeout",
    closeoutId: snap.closeoutId,
    totals: { ...snap.totals },
    paymentTotals: { ...snap.paymentTotals },
    counts: {
      ...base.counts,
      // order_count is the snapshot's own ticket count, authoritative even if
      // the drill-down rows below are incomplete for any reason.
      tickets: snap.counts.tickets,
      incidents: snap.counts.incidents,
    },
    // The same service as it stands NOW, including anything recorded after the close.
    // NEVER summed with the headline above -- they are two descriptions of one service.
    currentReconciled: {
      totals: base.totals,
      paymentTotals: base.paymentTotals,
      counts: base.counts,
    },
    divergesFromCloseout: divergence !== null,
    divergence,
  };
}

// UAT-P1-B, generalized for P0 Economía parity — where a closed service's
// order rows live depends on WHICH close ran: the legacy nightly archive
// moves them to `storico`, while the V3 operator Finalizar // language-guard: allow-legacy storico is the existing archive table name this reader already queried, not new vocabulary
// (close_source='operator_finalizar_v3') closes the service and leaves them
// in `ordenes`. Reading only `storico` reported a real 7-ticket / 153.50 EUR // language-guard: allow-legacy storico is the same existing archive table name, cited to explain the defect, not new vocabulary
// service as zero tickets and 0.00 EUR (staging service 4f260f1e,
// 2026-08-20) — the same defect independently reproduced against Economía's
// own per-session reader for service 480eca89 (262.50 EUR, 2026-08-22).
// Both are durable, service-pinned stores, so a closed session's rows are
// read from BOTH and de-duplicated by order id. This is not a cross-service
// fallback: every row is filtered by this one service_session_id and the
// mixed-rows guard below still proves it. Exported so every closed-session
// money reader (the live closeout here AND Economía's multi-session ledger
// in economiaLedgerAggregate.js) shares this ONE lookup instead of each
// re-deriving its own, divergence-prone version of it.
//
// N-11 — the dual-store read is keyed on HISTORICAL, not on 'closed' specifically.
// A rolled-over period is historical in exactly the same sense: it is no longer the
// attribution target, so nothing stops its rows having been archived, and reading only
// the live table would reproduce the very same zero-reporting defect described above.
// Today this widening is provably inert — zero archived rows point at a rolled_over
// session on staging — which is exactly why it is safe to make correct now rather than
// after someone rediscovers it as a third instance of the same bug.
async function loadSessionOrders(session, select) {
  const historical = isHistoricalServiceStatus(session.status);
  const sessionFilter = `service_session_id=eq.${encodeURIComponent(session.id)}`;
  const orders = historical
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
  if (deduped.some((row) => String(row.service_session_id || "") !== String(session.id))) {
    throw Object.assign(new Error("mixed service session rows"), { code: "MIXED_SERVICE_SESSION_ROWS" });
  }
  return deduped;
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
    const list = await loadSessionOrders(session, select);
    const ids = list.map((o) => o.orden_id || o.id).filter(Boolean);
    const events = ids.length
      ? await select("order_financial_events", `${sessionFilter}&order_id=in.(${ids.map((id) => encodeURIComponent(String(id))).join(",")})&order=created_at.asc`)
      : [];
    if ((events || []).some((row) => String(row.service_session_id || "") !== String(session.id))) {
      throw Object.assign(new Error("mixed financial session rows"), { code: "MIXED_FINANCIAL_SESSION_ROWS" });
    }
    // N-2 — canonical obligations for this service, scoped exactly like the
    // events above. Orders created before N-2 simply have no row here and fall
    // through to the legacy `totale` inside safeTicket.
    const obligations = ids.length
      ? await select("order_obligations", `${sessionFilter}&order_id=in.(${ids.map((id) => encodeURIComponent(String(id))).join(",")})&order=revision.asc`)
      : [];
    const base = aggregate(session, list, Array.isArray(events) ? events : [], Array.isArray(obligations) ? obligations : []);
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
// I-1 — the money primitives are exported so the timestamp-windowed Economic
// Snapshot reader (src/economy/economicSnapshot.js) can apply the EXACT same
// per-ticket rules (ledger-first, legacy-fallback-only-when-no-event, refunds
// leave the collected total, a voided ticket collects nothing) instead of
// growing a second, drifting implementation of the same accounting. Nothing
// below changes behaviour for existing callers: additive export only.
module.exports = {
  createCurrentServiceCloseout, getCurrentServiceCloseout, aggregate, withOfficialSnapshot,
  safeTicket, paymentBucket, eventType, eventAmount, emptyPaymentTotals, addMethodAmount,
  round, CANCELLED, loadSessionOrders,
  // N-2 — exported so the timestamp-windowed reader applies the SAME
  // canonical-obligation precedence instead of re-deriving it.
  latestObligationsByOrder,
};
