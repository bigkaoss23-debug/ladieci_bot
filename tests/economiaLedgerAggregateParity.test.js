"use strict";
// S2-7D6E3 — Economía must report the SAME money as the live closeout and the archived
// serata_summary, because all three now call the SAME aggregate() function
// (src/closeout/currentServiceCloseout.js) instead of separately re-deriving totals from
// `metodo_pago`/`cobrado`. This mirrors tests/closeoutSummaryAccountingParity.test.js's
// fixtures and adds the Economía ledger read (readActions.getEconomiaLedger ->
// getEconomiaLedgerAggregate) as a third surface that must agree.
const assert = require("node:assert/strict");
const test = require("node:test");
const { createCurrentServiceCloseout } = require("../src/closeout/currentServiceCloseout");
const { computeSummary } = require("../src/utils/servizio");
const { getEconomiaLedgerAggregate } = require("../src/closeout/economiaLedgerAggregate");

const SESSION_ID = "00000000-0000-4000-8000-0000000000ac";
const DATE = "2026-07-27";
const OPENED_AT = "2026-07-27T17:00:00Z";

const session = (o = {}) => ({
  id: SESSION_ID, business_date: DATE, opened_at: OPENED_AT,
  closed_at: null, status: "open", service_kind: "SERA", ...o,
});
const identity = (value) => ({ currentCloseout: async () => value });

const order = (o = {}) => ({
  id: "#901", service_session_id: SESSION_ID, estado: "RETIRADO", hora: "20:30",
  totale: 12, tipo_consegna: "RITIRO", delivery_fee: 0, items: [],
  cobrado: false, ya_pagado: false, metodo_pago: "", ts: 1, ...o,
});

const event = (o = {}) => ({
  order_id: "#901", service_session_id: SESSION_ID, type: "payment",
  amount: 12, payment_method: "efectivo", created_at: "2026-07-27T20:35:00Z", ...o,
});

const live = (orders, events, s = session()) =>
  createCurrentServiceCloseout({
    select: async (table) =>
      table === "order_financial_events" ? events
      : (table === "ordenes" || table === "storico") ? orders
      : [],
    sessionLifecycle: identity({ ok: true, code: "OK", session: s }),
  })();

const archived = (orders, events) =>
  computeSummary(orders, DATE, "lunedì", "test", OPENED_AT, events);

// Economía's read: one service_session in range, resolved via the SAME select mock shape
// (ordenes/storico for the orders, order_financial_events for the events).
const economia = (orders, events, s = session()) =>
  getEconomiaLedgerAggregate({
    desde: DATE, hasta: DATE,
    select: async (table) =>
      table === "service_sessions" ? [s]
      : table === "order_financial_events" ? events
      : (table === "ordenes" || table === "storico") ? orders
      : [],
  });

test("case 1 — 12 EUR with a cash payment event: Economía agrees with the live closeout and the archived summary", async () => {
  const orders = [order()];
  const events = [event()];

  const closeout = await live(orders, events);
  const summary = await archived(orders, events);
  const eco = await economia(orders, events);

  assert.equal(eco.paymentTotals.efectivo, 12);
  assert.equal(eco.totals.collected, 12);
  assert.equal(eco.totals.unpaid, 0);

  assert.equal(eco.paymentTotals.efectivo, closeout.paymentTotals.efectivo);
  assert.equal(eco.paymentTotals.efectivo, summary.cassa_efectivo);
  assert.equal(eco.totals.collected, closeout.totals.collected);
});

test("case 2 — metodo_pago=efectivo with NO payment event: Economía also reports 0 collected, 12 pendiente", async () => {
  const orders = [order({ metodo_pago: "efectivo" })];
  const events = [];

  const closeout = await live(orders, events);
  const summary = await archived(orders, events);
  const eco = await economia(orders, events);

  assert.equal(eco.paymentTotals.efectivo, 0, "metodo_pago is an intent, never a receipt — Economía must not bucket it as collected");
  assert.equal(eco.totals.collected, 0);
  assert.equal(eco.totals.unpaid, 12);

  assert.equal(eco.paymentTotals.efectivo, closeout.paymentTotals.efectivo);
  assert.equal(eco.paymentTotals.efectivo, summary.cassa_efectivo);
  assert.equal(eco.totals.unpaid, closeout.totals.unpaid);
});

test("case 3 — payment 12 + refund 5 nets to 7 in Economía too", async () => {
  const orders = [order()];
  const events = [
    event(),
    event({ type: "refund", amount: 5, created_at: "2026-07-27T21:00:00Z" }),
  ];

  const closeout = await live(orders, events);
  const summary = await archived(orders, events);
  const eco = await economia(orders, events);

  assert.equal(eco.paymentTotals.efectivo, 7);
  assert.equal(eco.totals.refunded, 5);
  assert.equal(eco.totals.collected, 7);

  assert.equal(eco.paymentTotals.efectivo, closeout.paymentTotals.efectivo);
  assert.equal(eco.paymentTotals.efectivo, summary.cassa_efectivo);
});

test("case 4 — an imported payment event is treated identically to a live one", async () => {
  const orders = [order()];
  const events = [event({ type: "payment_imported" })];

  const closeout = await live(orders, events);
  const summary = await archived(orders, events);
  const eco = await economia(orders, events);

  assert.equal(eco.paymentTotals.efectivo, 12);
  assert.equal(eco.paymentTotals.efectivo, closeout.paymentTotals.efectivo);
  assert.equal(eco.paymentTotals.efectivo, summary.cassa_efectivo);
});

test("a CLOSED session is read from storico (by orden_id) and still agrees", async () => {
  const closed = session({ status: "closed", closed_at: "2026-07-27T23:30:00Z" });
  const storicoRow = { id: 7, orden_id: "#901", service_session_id: SESSION_ID, estado: "RETIRADO", totale: 12, metodo_pago: "efectivo", cobrado: false, ya_pagado: false };
  const closeout = await live([storicoRow], [event()], closed);
  const eco = await economia([storicoRow], [event()], closed);

  assert.equal(eco.totals.collected, 12);
  assert.equal(eco.totals.collected, closeout.totals.collected);
});

test("two service sessions on the same business_date (PRANZO + SERA) are summed into one day", async () => {
  const pranzo = session({ id: "00000000-0000-4000-8000-0000000000ad", service_kind: "PRANZO" });
  const sera = session({ id: SESSION_ID, service_kind: "SERA" });
  const orderPranzo = order({ id: "#801", service_session_id: pranzo.id });
  const eventPranzo = event({ order_id: "#801", service_session_id: pranzo.id, amount: 8, payment_method: "tarjeta" });

  const out = await getEconomiaLedgerAggregate({
    desde: DATE, hasta: DATE,
    select: async (table, query) => {
      if (table === "service_sessions") return [pranzo, sera];
      if (table === "order_financial_events") {
        return String(query).includes(pranzo.id) ? [eventPranzo] : [event()];
      }
      return String(query).includes(pranzo.id) ? [orderPranzo] : [order()];
    },
  });

  assert.equal(out.porGiorno.length, 1, "one calendar day, even with two sessions");
  assert.equal(out.porGiorno[0].paymentTotals.tarjeta, 8);
  assert.equal(out.porGiorno[0].paymentTotals.efectivo, 12);
  assert.equal(out.porGiorno[0].totals.collected, 20);
  assert.equal(out.totals.collected, 20);
});
