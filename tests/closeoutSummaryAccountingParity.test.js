"use strict";
// S2-7D6E2 — the live closeout and the archived serata_summary must report the SAME
// money, because they must be computed from the SAME source: order_financial_events.
// `metodo_pago` is an intent, not a receipt.
const assert = require("node:assert/strict");
const test = require("node:test");
const { createCurrentServiceCloseout } = require("../src/closeout/currentServiceCloseout");
const { computeSummary } = require("../src/utils/servizio");

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

// The live surface, exactly as index.js exposes it.
const live = (orders, events, s = session()) =>
  createCurrentServiceCloseout({
    select: async (table) =>
      table === "order_financial_events" ? events
      : (table === "ordenes" || table === "storico") ? orders
      : [],
    sessionLifecycle: identity({ ok: true, code: "OK", session: s }),
  })();

// The archived surface, called exactly as chiudiServizio PASSO 4 calls it.
const archived = (orders, events) =>
  computeSummary(orders, DATE, "lunedì", "test", OPENED_AT, events);

// pendiente is not a stored column: cassa_totale is gross, the buckets are collected.
const pendiente = (s) => Math.round((
  s.cassa_totale - (s.cassa_efectivo + s.cassa_tarjeta + s.cassa_bizum + s.cassa_non_specificato)
) * 100) / 100;

test("case 1 — 12 EUR with a cash payment event is 12 collected, live and archived", async () => {
  const orders = [order()];
  const events = [event()];

  const closeout = await live(orders, events);
  assert.equal(closeout.totals.gross, 12);
  assert.equal(closeout.totals.collected, 12);
  assert.equal(closeout.totals.unpaid, 0);
  assert.equal(closeout.paymentTotals.efectivo, 12);
  assert.equal(closeout.tickets[0].paymentState, "paid");

  const summary = await archived(orders, events);
  assert.equal(summary.cassa_totale, 12);
  assert.equal(summary.cassa_efectivo, 12);
  assert.equal(summary.cassa_tarjeta, 0);
  assert.equal(summary.cassa_bizum, 0);
  assert.equal(summary.cassa_non_specificato, 0);
  assert.equal(pendiente(summary), 0);

  // Parity is the point, not the individual numbers.
  assert.equal(summary.cassa_efectivo, closeout.paymentTotals.efectivo);
  assert.equal(pendiente(summary), closeout.totals.unpaid);
});

test("case 2 — metodo_pago=efectivo with NO payment event is 0 collected, live and archived", async () => {
  const orders = [order({ metodo_pago: "efectivo" })];
  const events = [];

  const closeout = await live(orders, events);
  assert.equal(closeout.totals.gross, 12);
  assert.equal(closeout.totals.collected, 0);
  assert.equal(closeout.totals.unpaid, 12);
  assert.equal(closeout.paymentTotals.efectivo, 0);
  assert.equal(closeout.tickets[0].paymentState, "unpaid");

  const summary = await archived(orders, events);
  assert.equal(summary.cassa_totale, 12);
  assert.equal(summary.cassa_efectivo, 0, "metodo_pago is an intent, never a receipt");
  assert.equal(pendiente(summary), 12);

  assert.equal(summary.cassa_efectivo, closeout.paymentTotals.efectivo);
  assert.equal(pendiente(summary), closeout.totals.unpaid);
});

test("legacy cobrado still counts, but only with no ledger event at all", async () => {
  const legacy = [order({ id: "#902", cobrado: true, metodo_pago: "tarjeta" })];
  const closeout = await live(legacy, []);
  assert.equal(closeout.totals.collected, 12);
  assert.equal(closeout.paymentTotals.tarjeta, 12);
  const summary = await archived(legacy, []);
  assert.equal(summary.cassa_tarjeta, 12);
  assert.equal(pendiente(summary), 0);

  // With a real event present the boolean must not add a second 12.
  const both = [order({ cobrado: true, metodo_pago: "efectivo" })];
  const withEvent = await live(both, [event()]);
  assert.equal(withEvent.totals.collected, 12);
  const summaryBoth = await archived(both, [event()]);
  assert.equal(summaryBoth.cassa_efectivo, 12);
});

test("a refund leaves the collected total on both paths", async () => {
  const orders = [order()];
  const events = [
    event(),
    event({ type: "refund", amount: 5, created_at: "2026-07-27T21:00:00Z" }),
  ];
  const closeout = await live(orders, events);
  assert.equal(closeout.totals.refunded, 5);
  assert.equal(closeout.totals.collected, 7);
  assert.equal(closeout.paymentTotals.efectivo, 7);

  const summary = await archived(orders, events);
  assert.equal(summary.cassa_efectivo, 7);
  assert.equal(pendiente(summary), 5);
});

test("a CLOSED session reads storico by orden_id, so its events are still found", async () => {
  // storico rows carry their own identity PK `id` AND the order key `orden_id`.
  // order_financial_events.order_id is the latter.
  const closed = session({ status: "closed", closed_at: "2026-07-27T23:30:00Z" });
  const storicoRow = { id: 7, orden_id: "#901", service_session_id: SESSION_ID, estado: "RETIRADO", totale: 12, metodo_pago: "efectivo", cobrado: false, ya_pagado: false };
  const out = await live([storicoRow], [event()], closed);
  assert.equal(out.tickets[0].id, "#901");
  assert.equal(out.totals.collected, 12, "closing a service must not erase the ledger link");
  assert.equal(out.totals.unpaid, 0);
});
