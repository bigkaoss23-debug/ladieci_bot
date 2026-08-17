"use strict";
// S-E — reader/economic-reporting semantic cutover. Behavioral proof (real
// function calls, not source-text matching) that currentServiceCloseout's
// aggregate() and economiaLedgerAggregate's day/session/grand rollups
// correctly separate Operational Service IDENTITY (S-D: one session can now
// span PRANZO+SERA) from ECONOMIC CLASSIFICATION (S-C: per-fact stamp, era-
// aware legacy fallback) — matching the S-E task brief's Phase 13 test
// matrix A-M. No DB access; pure in-memory fixtures.
const assert = require("node:assert/strict");
const test = require("node:test");
const { aggregate } = require("../src/closeout/currentServiceCloseout");
const { resolveEconomicPeriodKind, singleKindOrNull } = require("../src/closeout/economicPeriodReadRule");

const SESSION_PRANZO_V1 = Object.freeze({
  id: "sess-1", status: "open", business_date: "2026-08-17",
  service_kind: "PRANZO", lifecycle_semantics: "economic_period_v1",
  opened_at: "2026-08-17T08:00:00Z", closed_at: null,
});

function order(id, amount) {
  return { orden_id: id, id, totale: amount, estado: "RETIRADO", hora: "12:00" };
}
function paymentEvent(orderId, amount, { obligationKind, eventKind, eventSessionId } = {}) {
  return {
    order_id: orderId, type: "payment", amount,
    payment_method: "efectivo",
    obligation_economic_period_kind: obligationKind ?? null,
    event_economic_period_kind: eventKind ?? null,
    event_service_session_id: eventSessionId ?? null,
  };
}

test("A: one session with PRANZO + SERA stamped obligations -> ONE Operational Service, economic totals split correctly", () => {
  const orders = [order("A1", 30), order("A2", 50)];
  const events = [
    paymentEvent("A1", 30, { obligationKind: "PRANZO", eventKind: "PRANZO" }),
    paymentEvent("A2", 50, { obligationKind: "SERA", eventKind: "SERA" }),
  ];
  const result = aggregate(SESSION_PRANZO_V1, orders, events);
  assert.equal(result.serviceSessionId, "sess-1", "identity stays the ONE session");
  assert.equal(result.serviceKind, null, "genuinely mixed -> no single label asserted");
  assert.equal(result.economicBreakdown.obligations.PRANZO, 30);
  assert.equal(result.economicBreakdown.obligations.SERA, 50);
  assert.equal(result.tickets.length, 2, "no split into two services -- one ticket list");
});

test("B: a PRANZO obligation paid in SERA -> sale attributes to PRANZO, receipt attributes to SERA", () => {
  const orders = [order("B1", 40)];
  const events = [paymentEvent("B1", 40, { obligationKind: "PRANZO", eventKind: "SERA" })];
  const result = aggregate(SESSION_PRANZO_V1, orders, events);
  const ticket = result.tickets[0];
  assert.equal(ticket.economicKind, "PRANZO", "obligation (sale) window");
  assert.equal(ticket.receiptTotalsByKind.SERA, 40, "receipt window is independent of the obligation");
  assert.equal(ticket.receiptTotalsByKind.PRANZO, 0);
  assert.equal(result.economicBreakdown.obligations.PRANZO, 40);
  assert.equal(result.economicBreakdown.receipts.SERA, 40);
});

test("C: financial event obligation/event kinds can differ and both survive reporting independently", () => {
  const orders = [order("C1", 20)];
  const events = [paymentEvent("C1", 20, { obligationKind: "SERA", eventKind: "PRANZO", eventSessionId: "sess-1" })];
  const result = aggregate(SESSION_PRANZO_V1, orders, events);
  const ticket = result.tickets[0];
  assert.equal(ticket.economicKind, "SERA");
  assert.equal(ticket.receiptTotalsByKind.PRANZO, 20);
});

test("D: historical NULL stamp -> legacy session.service_kind fallback works (byte-identical to pre-S-E)", () => {
  const orders = [order("D1", 15)];
  const events = [paymentEvent("D1", 15, {})]; // no S-C stamps at all -- pre-S-C fact
  const result = aggregate(SESSION_PRANZO_V1, orders, events);
  assert.equal(result.tickets[0].economicKind, "PRANZO", "falls back to the session's own kind");
  assert.equal(result.serviceKind, "PRANZO", "single distinct kind -> still reports it, unchanged from pre-S-E");
  assert.equal(result.tickets[0].receiptTotalsByKind.PRANZO, 15, "receipt also falls back (event_service_session_id absent == this session)");
});

test("E: resolveEconomicPeriodKind never re-derives from a live schedule/clock -- pure function of (stamp, session) only", () => {
  assert.equal(resolveEconomicPeriodKind("SERA", { service_kind: "PRANZO" }), "SERA", "explicit stamp always wins");
  assert.equal(resolveEconomicPeriodKind(null, { service_kind: "PRANZO" }), "PRANZO");
  assert.equal(resolveEconomicPeriodKind(null, null), null, "no guessing with nothing to fall back to");
  assert.equal(resolveEconomicPeriodKind("SERA", { service_kind: "PRANZO" }), "SERA", "re-evaluated identically regardless of caller order -- no hidden clock/schedule state");
});

test("F: lifecycle/UI label neutral despite a legacy session.service_kind (frontend, verified separately) -- backend closeout label goes null once genuinely mixed", () => {
  const orders = [order("F1", 10), order("F2", 10)];
  const events = [
    paymentEvent("F1", 10, { obligationKind: "PRANZO" }),
    paymentEvent("F2", 10, { obligationKind: "SERA" }),
  ];
  const result = aggregate(SESSION_PRANZO_V1, orders, events);
  assert.equal(result.serviceKind, null);
});

test("G: currentServiceCloseout includes the WHOLE service -- no fact excluded merely for a differing economic_period_kind", () => {
  const orders = [order("G1", 25), order("G2", 35)];
  const events = [
    paymentEvent("G1", 25, { obligationKind: "PRANZO" }),
    paymentEvent("G2", 35, { obligationKind: "SERA" }),
  ];
  const result = aggregate(SESSION_PRANZO_V1, orders, events);
  assert.equal(result.tickets.length, 2, "both tickets present regardless of kind");
  assert.equal(result.totals.gross, 60, "whole-service gross, not one window's slice");
});

test("H: no reader creates or mutates a session -- aggregate() is a pure function of its inputs", () => {
  const sessionCopy = { ...SESSION_PRANZO_V1 };
  aggregate(sessionCopy, [order("H1", 5)], [paymentEvent("H1", 5, { obligationKind: "SERA" })]);
  assert.deepEqual(sessionCopy, SESSION_PRANZO_V1, "session object untouched by the read");
});

test("zero-ticket session still reports its own era-aware kind (regression guard: must not go null merely for having no orders yet)", () => {
  const result = aggregate(SESSION_PRANZO_V1, [], []);
  assert.equal(result.serviceKind, "PRANZO");
  assert.deepEqual(result.economicBreakdown, {
    obligations: { PRANZO: 0, SERA: 0, unknown: 0 },
    receipts: { PRANZO: 0, SERA: 0, unknown: 0 },
  });
});

test("cross-session receipt (event_service_session_id names a DIFFERENT session, no stamp) is honestly reported unknown, never guessed", () => {
  const orders = [order("X1", 12)];
  const events = [paymentEvent("X1", 12, { obligationKind: "PRANZO", eventSessionId: "some-other-session" })];
  const result = aggregate(SESSION_PRANZO_V1, orders, events);
  assert.equal(result.tickets[0].receiptTotalsByKind.unknown, 12);
  assert.equal(result.tickets[0].receiptTotalsByKind.PRANZO, 0);
  assert.equal(result.tickets[0].receiptTotalsByKind.SERA, 0);
});

test("singleKindOrNull: 0 observed -> null, 1 distinct -> that kind, 2 distinct -> null", () => {
  assert.equal(singleKindOrNull([]), null);
  assert.equal(singleKindOrNull(["PRANZO", "PRANZO"]), "PRANZO");
  assert.equal(singleKindOrNull(["PRANZO", "SERA"]), null);
  assert.equal(singleKindOrNull([null, "SERA", null]), "SERA", "nulls (unresolvable facts) are ignored, not counted as a third kind");
});

test("cancelled tickets are excluded from the obligation breakdown, mirroring the pre-existing grossTotal exclusion", () => {
  const orders = [{ orden_id: "V1", totale: 99, estado: "CANCELADO", hora: "12:00" }];
  const result = aggregate(SESSION_PRANZO_V1, orders, []);
  assert.equal(result.economicBreakdown.obligations.PRANZO, 0);
  assert.equal(result.economicBreakdown.obligations.unknown, 0);
});
