"use strict";
// REFUND V1 SLICE C — closeoutReconciliation refund-scope fix.
//
// THE DEFECT (Slice A/B contract audit §G.4, deferred here): `collected` was
// always RECEIPT-scoped (events whose own instant falls in the window) but
// `refunded` was silently OBLIGATION-scoped (refunds against orders BORN in
// the window, regardless of when the refund itself happened). A cross-day
// refund made `collected` correctly drop while `refunded` stayed 0 -- an
// unexplained drop in Finalizar.
//
// THE FIX: `refunded` now matches `collected`'s own scope (receipt-time).
// The obligation-scoped figure it used to silently BE is kept, explicitly
// labeled `obligationRefunded`, never dropped.
//
// THE WORKED EXAMPLE: a 100,00 tarjeta sale on day 1, refunded 20,00 on
// day 2. Day 1's gross sale stays historical (100, unaffected); day 2 shows
// the refund movement (refunded 20, collected -20) with nothing unexplained;
// day 1's own obligationRefunded (20) still answers "how much of what day 1
// sold has since come back", without mixing into day 1's own receipt figures.
const assert = require("assert");
const { createCloseoutReconciliation } = require("../src/economy/closeoutReconciliation");
const { createEconomicSnapshot } = require("../src/economy/economicSnapshot");
const { createMemorySelect } = require("./fixtures/postgrestMemorySelect");

let passed = 0;
const atest = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (error) { console.error(`  ✗ FAIL: ${name}\n    ${error && error.stack}`); process.exitCode = 1; }
};

// Two consecutive certified Business Day windows (04:00 Madrid -> 04:00),
// same convention as the certified closeoutReconciliation.test.js fixture.
const DAY1_FROM = "2026-08-20T02:00:00.000Z";
const DAY1_TO = "2026-08-21T02:00:00.000Z";
const DAY2_FROM = "2026-08-21T02:00:00.000Z";
const DAY2_TO = "2026-08-22T02:00:00.000Z";

const SVC_DAY1 = Object.freeze({
  id: "svc-day1", business_date: "2026-08-20", status: "closed",
  opened_at: "2026-08-20T18:00:00Z", closed_at: "2026-08-20T23:30:00Z", service_kind: "SERA",
});
const SVC_DAY2 = Object.freeze({
  id: "svc-day2", business_date: "2026-08-21", status: "open",
  opened_at: "2026-08-21T18:00:00Z", closed_at: null, service_kind: "SERA",
});

// #100 -- sold and paid 100,00 tarjeta on day 1; refunded 20,00 tarjeta on
// day 2 (a different, later-opened Operational Service).
const ORDER = Object.freeze({
  id: "#100", service_session_id: "svc-day1", created_at: "2026-08-20T20:00:00Z",
  estado: "RETIRADO", totale: 100,
});
const PAYMENT_EVENT = Object.freeze({
  id: "evt-pay-1", order_id: "#100",
  service_session_id: "svc-day1", event_service_session_id: "svc-day1", // same day: obligation and receipt agree
  type: "payment", amount: 100, payment_method: "tarjeta", created_at: "2026-08-20T20:05:00Z",
});
const REFUND_EVENT = Object.freeze({
  id: "evt-refund-1", order_id: "#100",
  // service_session_id (obligation provenance) is FORCED by the real DB
  // trigger to the order's OWN service_session_id regardless of when the
  // refund happens -- mirrored here, not guessed.
  service_session_id: "svc-day1",
  // event_service_session_id (receipt-time provenance) is day 2's service --
  // this is the actual money movement instant.
  event_service_session_id: "svc-day2",
  type: "refund", amount: 20, payment_method: "tarjeta", created_at: "2026-08-21T20:00:00Z",
});

function harness({ events }) {
  const select = createMemorySelect({
    // language-guard: allow-legacy storico is the existing archive table name this reader queries, keyed here verbatim, not new vocabulary
    ordenes: [ORDER], storico: [],
    order_financial_events: events,
    service_sessions: [SVC_DAY1, SVC_DAY2],
    cash_counts: [], service_closeout_reconciliations: [],
  });
  const snapshot = createEconomicSnapshot({ select });
  return createCloseoutReconciliation({ select, rpc: async () => ({ ok: true, body: { ok: true } }), snapshot });
}

(async () => {
  await atest("day 1 (the sale's own service): gross stays historical, receipt-scoped refunded is 0, obligationRefunded shows 20", async () => {
    const reconciliation = harness({ events: [PAYMENT_EVENT, REFUND_EVENT] });
    const view = await reconciliation.build({ serviceSessionId: "svc-day1", now: new Date("2026-08-22T00:00:00Z") });

    assert.strictEqual(view.service.gross, 100, "the historical sale must remain 100, untouched by a later refund");
    assert.strictEqual(view.service.collected, 100, "day 1's OWN receipts never saw the day-2 refund event");
    assert.strictEqual(view.service.refunded, 0, "receipt-scoped: no refund EVENT fell inside day 1's window");
    assert.strictEqual(view.service.obligationRefunded, 20, "obligation-scoped: day 1's sale HAS since been refunded, for 20");
    assert.strictEqual(view.reconciliation.gross, 100);
    assert.strictEqual(view.reconciliation.collected, 100);
    assert.strictEqual(view.reconciliation.refunded, 0);
    assert.strictEqual(view.reconciliation.obligationRefunded, 20);
  });

  // NOTE ON SCOPE: "service" (Este servicio) is deliberately NARROWER than
  // "reconciliation" (Día operativo) -- it is time-bounded to the service's
  // OWN open/close interval AND obligation-linked (service_session_id, the
  // sale's own provenance, per N-9). A cross-day refund's event therefore
  // falls OUTSIDE both day 1's and day 2's own service-scope window by
  // construction (pre-existing "servicio" preset behavior, untouched by this
  // slice) -- it is the DAY scope (reconciliation, no session filter at all)
  // that is unfiltered by obligation-linkage and correctly sees it. This is
  // exactly the field Finalizar/"today's economy" reads, and exactly where
  // the audit's "unexplained collected drop" was reported.
  await atest("day 2 (the refund's own Business Day): NO unexplained collected drop -- refunded (receipt-scoped) explains it exactly", async () => {
    const reconciliation = harness({ events: [PAYMENT_EVENT, REFUND_EVENT] });
    const view = await reconciliation.build({ serviceSessionId: "svc-day2", now: new Date("2026-08-22T00:00:00Z") });

    assert.strictEqual(view.reconciliation.gross, 0, "nothing was SOLD on day 2");
    assert.strictEqual(view.reconciliation.collected, -20, "day 2's own receipts moved -20 (the refund)");
    // THE FIX, proven: before Slice C this would have read obligationRefunded
    // (0, since no order was born today) under the field name `refunded`,
    // which is exactly the "unexplained -20,00 drop" the audit named.
    assert.strictEqual(view.reconciliation.refunded, 20, "receipt-scoped: the refund EVENT fell inside day 2's window");
    assert.strictEqual(view.reconciliation.obligationRefunded, 0, "obligation-scoped: no order born today has been refunded");
    // The identity that makes the drop EXPLAINED: collected === collectedGross - refunded.
    assert.strictEqual(view.reconciliation.collected, 0 - view.reconciliation.refunded);

    // The service scope (this open, in-progress service's OWN narrow window)
    // legitimately sees neither side yet -- proving the two scopes really
    // are independent, not that one silently stands in for the other.
    assert.strictEqual(view.service.refunded, 0);
    assert.strictEqual(view.service.obligationRefunded, 0);
  });

  await atest("byMethod/byMethodGross/byMethodRefunds pass through additively into the day scope", async () => {
    const reconciliation = harness({ events: [PAYMENT_EVENT, REFUND_EVENT] });
    const day2 = await reconciliation.build({ serviceSessionId: "svc-day2", now: new Date("2026-08-22T00:00:00Z") });
    assert.strictEqual(day2.reconciliation.byMethod.tarjeta, -20);
    assert.strictEqual(day2.reconciliation.byMethodGross.tarjeta, 0);
    assert.strictEqual(day2.reconciliation.byMethodRefunds.tarjeta, 20);
    // The service scope's own (narrower, still-empty) figures stay additive too.
    assert.deepStrictEqual(day2.service.byMethodGross, { efectivo: 0, tarjeta: 0, bizum: 0, other: 0 });
    assert.deepStrictEqual(day2.service.byMethodRefunds, { efectivo: 0, tarjeta: 0, bizum: 0, other: 0 });
  });

  await atest("Caja is untouched: cashReceipts is still receipts.byMethod.efectivo (net), same as before this slice", async () => {
    const efectivoOrder = { ...ORDER, id: "#101" };
    const efectivoPay = { id: "evt-pay-2", order_id: "#101", service_session_id: "svc-day2", event_service_session_id: "svc-day2", type: "payment", amount: 50, payment_method: "efectivo", created_at: "2026-08-21T20:30:00Z" };
    const efectivoRefund = { id: "evt-refund-2", order_id: "#101", service_session_id: "svc-day2", event_service_session_id: "svc-day2", type: "refund", amount: 15, payment_method: "efectivo", created_at: "2026-08-21T21:00:00Z" };
    const select = createMemorySelect({
      // language-guard: allow-legacy storico is the existing archive table name this reader queries, keyed here verbatim, not new vocabulary
      ordenes: [ORDER, efectivoOrder], storico: [],
      order_financial_events: [PAYMENT_EVENT, REFUND_EVENT, efectivoPay, efectivoRefund],
      service_sessions: [SVC_DAY1, SVC_DAY2], cash_counts: [], service_closeout_reconciliations: [],
    });
    const snapshot = createEconomicSnapshot({ select });
    const reconciliation = createCloseoutReconciliation({ select, rpc: async () => ({ ok: true, body: { ok: true } }), snapshot });
    const view = await reconciliation.build({ serviceSessionId: "svc-day2", now: new Date("2026-08-22T00:00:00Z") });
    // +50 -15 = 35 net efectivo -- exactly what cashCountService's
    // recordedCashReceipts (toCents(view.receipts.byMethod.efectivo)) reads,
    // unchanged by this slice.
    assert.strictEqual(view.reconciliation.cashReceipts, 35);
    assert.strictEqual(view.reconciliation.byMethod.efectivo, 35);
  });

  await atest("no double counting: the 20,00 refund appears EXACTLY once across the two days' receipt-scoped (day) windows", async () => {
    const reconciliation = harness({ events: [PAYMENT_EVENT, REFUND_EVENT] });
    const day1 = await reconciliation.build({ serviceSessionId: "svc-day1", now: new Date("2026-08-22T00:00:00Z") });
    const day2 = await reconciliation.build({ serviceSessionId: "svc-day2", now: new Date("2026-08-22T00:00:00Z") });
    assert.strictEqual(day1.reconciliation.refunded + day2.reconciliation.refunded, 20);
    assert.strictEqual(day1.reconciliation.refunded, 0, "day 1's own window never saw the refund event -- it happened on day 2");
    assert.strictEqual(day2.reconciliation.refunded, 20, "day 2's own window is where the refund event's instant actually falls");
    // And the SALE (obligation) appears exactly once too, on day 1, never day 2.
    assert.strictEqual(day1.reconciliation.gross + day2.reconciliation.gross, 100);
    assert.strictEqual(day1.reconciliation.gross, 100);
    assert.strictEqual(day2.reconciliation.gross, 0);
  });

  console.log(`\ncloseoutReconciliationRefundReporting: ${passed} passed`);
  process.exit(process.exitCode || 0);
})();
