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

// P0 — closed-session table routing. Unlike the fixtures above (whose mock
// `select` returns the same `orders` array for both `ordenes` and the
// legacy archive table, so it can't actually prove which store a row came
// from), these mocks route each store to its OWN array — the only way to
// reproduce, and guard against regressing, the real defect: a V3 Finalizar
// close (close_source='operator_finalizar_v3') leaves order rows in
// `ordenes` and never archives them. Reproduced live against staging
// service 480eca89 (5 tickets, 262.50 EUR, all in `ordenes`, archive empty).
// `archiveRows` names the legacy nightly-archive table's rows generically —
// only the routing line below needs the table's literal name.
const routedSelect = ({ archiveRows = [], ordenes = [], events = [], sessions } = {}) => async (table, query) => {
  if (table === "service_sessions") return sessions;
  if (table === "order_financial_events") return events;
  if (table === "storico") return archiveRows; // language-guard: allow-legacy storico is the existing archive table name, routed here exactly as loadSessionOrders/economiaLedgerAggregate.js already query it, not new vocabulary
  if (table === "ordenes") return ordenes;
  return [];
};

test("a CLOSED session with rows ONLY in the legacy archive table is read and still agrees", async () => {
  const closed = session({ status: "closed", closed_at: "2026-07-27T23:30:00Z" });
  const archiveRow = { id: 7, orden_id: "#901", service_session_id: SESSION_ID, estado: "RETIRADO", totale: 12, metodo_pago: "efectivo", cobrado: false, ya_pagado: false };
  const select = routedSelect({ archiveRows: [archiveRow], ordenes: [], events: [event()], sessions: [closed] });

  const closeout = await createCurrentServiceCloseout({ select, sessionLifecycle: identity({ ok: true, code: "OK", session: closed }) })();
  const eco = await getEconomiaLedgerAggregate({ desde: DATE, hasta: DATE, select });

  assert.equal(eco.totals.collected, 12);
  assert.equal(eco.totals.collected, closeout.totals.collected);
});

test("P0 REGRESSION — a CLOSED V3 service with rows ONLY in ordenes (never archived) must NOT report zero", async () => {
  const closed = session({ status: "closed", closed_at: "2026-08-22T09:52:20Z" });
  // Mirrors staging service 480eca89: rows live only in `ordenes`, the archive table is empty.
  const ordenesRow = { id: "#901", service_session_id: SESSION_ID, estado: "RETIRADO", totale: 12, metodo_pago: "", cobrado: false, ya_pagado: false };
  const select = routedSelect({ archiveRows: [], ordenes: [ordenesRow], events: [event()], sessions: [closed] });

  const closeout = await createCurrentServiceCloseout({ select, sessionLifecycle: identity({ ok: true, code: "OK", session: closed }) })();
  const eco = await getEconomiaLedgerAggregate({ desde: DATE, hasta: DATE, select });

  assert.notEqual(eco.totals.collected, 0, "Economía must not silently report zero revenue for a closed V3 service");
  assert.equal(eco.totals.collected, 12);
  assert.equal(eco.totals.collected, closeout.totals.collected, "Economía must agree with the live closeout, the same reader both now share");
});

test("P0 — a CLOSED session with rows in BOTH the archive table and ordenes sums both without double-counting", async () => {
  const closed = session({ status: "closed", closed_at: "2026-08-13T17:38:29Z" });
  // Mirrors staging service c9d5aaa7 (order_intake_reconcile): disjoint order ids across both stores.
  const archiveRow = { id: 7, orden_id: "#369", service_session_id: SESSION_ID, estado: "RETIRADO", totale: 25, metodo_pago: "efectivo", cobrado: false, ya_pagado: false };
  const ordenesRow = { id: "#370", service_session_id: SESSION_ID, estado: "RETIRADO", totale: 17, metodo_pago: "", cobrado: false, ya_pagado: false };
  const archiveEvent = event({ order_id: "#369", amount: 25, payment_method: "efectivo" });
  const ordenesEvent = event({ order_id: "#370", amount: 17, payment_method: "tarjeta" });
  const select = routedSelect({ archiveRows: [archiveRow], ordenes: [ordenesRow], events: [archiveEvent, ordenesEvent], sessions: [closed] });

  const eco = await getEconomiaLedgerAggregate({ desde: DATE, hasta: DATE, select });

  assert.equal(eco.totals.collected, 42, "25 (archive) + 17 (ordenes), summed once each");
  assert.equal(eco.paymentTotals.efectivo, 25);
  assert.equal(eco.paymentTotals.tarjeta, 17);
});

test("P0 — a duplicate order id present in BOTH the archive table and ordenes is deduped (composite identity), counted once", async () => {
  const closed = session({ status: "closed", closed_at: "2026-08-22T10:00:00Z" });
  const archiveRow = { id: 7, orden_id: "#901", service_session_id: SESSION_ID, estado: "RETIRADO", totale: 12, metodo_pago: "efectivo", cobrado: false, ya_pagado: false };
  // Same order id (#901) also present in `ordenes` — a stale/duplicate row a
  // partial archive run could leave behind. Must not be double-counted.
  const ordenesRow = { id: "#901", service_session_id: SESSION_ID, estado: "RETIRADO", totale: 12, metodo_pago: "", cobrado: false, ya_pagado: false };
  const select = routedSelect({ archiveRows: [archiveRow], ordenes: [ordenesRow], events: [event()], sessions: [closed] });

  const eco = await getEconomiaLedgerAggregate({ desde: DATE, hasta: DATE, select });

  assert.equal(eco.totals.collected, 12, "the duplicated #901 must be counted once, not twice");
});

test("P0 — an OPEN service is unaffected: still reads ordenes only, never queries the archive table", async () => {
  const open = session({ status: "open" });
  let archiveQueried = false;
  const select = async (table, query) => {
    if (table === "storico") archiveQueried = true; // language-guard: allow-legacy storico is the existing archive table name, checked here only to prove an open session never queries it, not new vocabulary
    if (table === "service_sessions") return [open];
    if (table === "order_financial_events") return [event()];
    if (table === "ordenes") return [order()];
    return [];
  };

  const eco = await getEconomiaLedgerAggregate({ desde: DATE, hasta: DATE, select });

  assert.equal(archiveQueried, false, "an open service must never query the legacy archive table");
  assert.equal(eco.totals.collected, 12);
});

test("P0 — payment method totals are unaffected by the dual-store read (mixed methods across stores)", async () => {
  const closed = session({ status: "closed", closed_at: "2026-08-22T09:52:20Z" });
  // Mirrors staging service 480eca89's real payment split: efectivo 85 (in
  // ordenes-only fixture form here, simplified to one ticket per method).
  const archiveRow = { id: 1, orden_id: "#801", service_session_id: SESSION_ID, estado: "RETIRADO", totale: 85, metodo_pago: "", cobrado: false, ya_pagado: false };
  const ordenesRowCard = { id: "#802", service_session_id: SESSION_ID, estado: "RETIRADO", totale: 130, metodo_pago: "", cobrado: false, ya_pagado: false };
  const ordenesRowBizum = { id: "#803", service_session_id: SESSION_ID, estado: "RETIRADO", totale: 47.5, metodo_pago: "", cobrado: false, ya_pagado: false };
  const events = [
    event({ order_id: "#801", amount: 85, payment_method: "efectivo" }),
    event({ order_id: "#802", amount: 130, payment_method: "tarjeta" }),
    event({ order_id: "#803", amount: 47.5, payment_method: "bizum" }),
  ];
  const select = routedSelect({ archiveRows: [archiveRow], ordenes: [ordenesRowCard, ordenesRowBizum], events, sessions: [closed] });

  const eco = await getEconomiaLedgerAggregate({ desde: DATE, hasta: DATE, select });

  assert.equal(eco.paymentTotals.efectivo, 85);
  assert.equal(eco.paymentTotals.tarjeta, 130);
  assert.equal(eco.paymentTotals.bizum, 47.5);
  assert.equal(eco.totals.collected, 262.5);
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
