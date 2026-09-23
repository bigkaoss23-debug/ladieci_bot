"use strict";
// DELIVERY x ECONOMY DECOUPLING V1 (migration 139) -- CORRECTION B1: ECONOMIC_PENDING_VISIBILITY_GAP.
//
// THE RULE. Economy depends on delivery-confirmed / money-confirmed / amount-owed -- never on the driver, never on
// the trip. A service can be finalized ("Finalizar con pendientes") while a delivery is still EN_ENTREGA. That
// order's credit must not vanish from Economía only because its delivery is not terminal yet:
//
//   OPEN   service + EN_ENTREGA + unpaid -> live/current        (Por cobrar aún abierto, NOT a pendency)
//   CLOSED service + EN_ENTREGA + unpaid -> historical pending  (Pendientes anteriores)
//   CLOSED service + RETIRADO   + unpaid -> historical pending
//   CLOSED service + anything   + paid   -> nothing
//
// and each euro sits in EXACTLY ONE bucket: obligation.currentServiceUnpaid (economicSnapshot) and
// totals.porCobrar (pendingExposures) both call the SAME predicate, so they partition obligation.unpaid.
const assert = require("assert");
const {
  createPendingExposures, isOperationallyOver, isUnconfirmedDeliveryOfClosedService,
} = require("../src/economy/pendingExposures");
const { createEconomicSnapshot } = require("../src/economy/economicSnapshot");
const { createMemorySelect } = require("./fixtures/postgrestMemorySelect");

let passed = 0;
const atest = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (error) { console.error(`  ✗ FAIL: ${name}\n    ${error && error.stack}`); process.exitCode = 1; }
};

const WS = "ws-1";
const NOW = new Date("2026-09-18T12:00:00.000Z");
const WIN_FROM = "2026-09-17T02:00:00.000Z";
const WIN_TO = "2026-09-19T02:00:00.000Z";

const OPEN = Object.freeze({ id: "svc-open", business_date: "2026-09-18", status: "open", opened_at: "2026-09-18T09:00:00Z", closed_at: null, service_kind: "SERA" });
const CLOSED = Object.freeze({ id: "svc-closed", business_date: "2026-09-17", status: "closed", opened_at: "2026-09-17T09:00:00Z", closed_at: "2026-09-17T23:30:00Z", service_kind: "SERA" });
const ROLLED = Object.freeze({ id: "svc-rolled", business_date: "2026-09-17", status: "rolled_over", opened_at: "2026-09-17T09:00:00Z", closed_at: null, service_kind: "PRANZO" }); // language-guard: allow-legacy PRANZO is the existing service_kind enum value, used verbatim in this fixture

let seq = 0;
const DELIVERY = { tipo_consegna: "DOMICILIO" }; // language-guard: allow-legacy tipo_consegna/DOMICILIO are the existing ordenes column/literal, reproduced verbatim in this fixture
const order = (o) => {
  seq += 1;
  return Object.freeze({
    id: `#${seq}`, order_uid: `uid-${seq}`, service_session_id: CLOSED.id, table_session_id: null,
    estado: "EN_ENTREGA", totale: 12.5, ...DELIVERY, nombre: "Cliente", tel: "600000000",
    created_at: "2026-09-17T20:00:00Z", ...o,
  });
};
// A receipt taken OFF-SERVICE (event_service_session_id NULL) against the order's own (closed) service.
const paid = (o, amount = o.totale, overrides = {}) => Object.freeze({
  id: `evt-${o.id}`, order_id: o.id, service_session_id: o.service_session_id, event_service_session_id: null,
  type: "payment", amount, payment_method: "efectivo", created_at: "2026-09-18T00:10:00Z", ...overrides,
});

function build({ ordenes, events = [], sessions = [OPEN, CLOSED], tableSessions = [] }) {
  const tables = {
    ordenes, storico: [], order_financial_events: events, order_obligations: [], service_sessions: sessions, table_sessions: tableSessions, // language-guard: allow-legacy storico is the real archive table key the memory select needs, not new vocabulary
  };
  const select = createMemorySelect(tables);
  const pend = createPendingExposures({ select });
  const snap = createEconomicSnapshot({ select });
  return {
    pending: () => pend({ workspaceId: WS, now: NOW }),
    snapshot: () => snap({ preset: "personalizado", from: WIN_FROM, to: WIN_TO, now: NOW }),
  };
}
const r2 = (n) => Math.round(n * 100) / 100;

(async () => {
  // ── pure predicate ───────────────────────────────────────────────────────
  await atest("predicate: EN_ENTREGA of a closed service is historical; every other combination keeps its old answer", () => {
    const o = (estado, extra = {}) => ({ estado, table_session_id: null, ...extra });
    assert.strictEqual(isUnconfirmedDeliveryOfClosedService({ order: o("EN_ENTREGA"), serviceSession: CLOSED }), true);
    assert.strictEqual(isUnconfirmedDeliveryOfClosedService({ order: o("EN_ENTREGA"), serviceSession: OPEN }), false);
    assert.strictEqual(isUnconfirmedDeliveryOfClosedService({ order: o("EN_ENTREGA"), serviceSession: ROLLED }), false, "rolled_over is still an operational scope");
    assert.strictEqual(isUnconfirmedDeliveryOfClosedService({ order: o("EN_ENTREGA"), serviceSession: null }), false, "unresolved service fails CLOSED toward live");
    for (const estado of ["LISTO", "EN_COCINA", "NUEVO", "POR_CONFIRMAR"]) {
      assert.strictEqual(isOperationallyOver({ order: o(estado), serviceSession: CLOSED }), false, `${estado} on a closed service keeps its old (live) answer`);
    }
    assert.strictEqual(isOperationallyOver({ order: o("RETIRADO"), serviceSession: OPEN }), true, "terminal stays terminal");
    assert.strictEqual(isOperationallyOver({ order: o("EN_ENTREGA") }), false, "a caller that passes no service gets the estado-only answer it always had");
    // A Mesa order is governed by its table session only: the closed service never makes it 'over'.
    assert.strictEqual(isOperationallyOver({ order: o("EN_ENTREGA", { table_session_id: "ts-1" }), tableSession: { status: "open" }, serviceSession: CLOSED }), false);
  });

  // ── A ────────────────────────────────────────────────────────────────────
  await atest("A · OPEN service, EN_ENTREGA, unpaid 12,50 -> current/open exposure, NOT a historical pendency", async () => {
    const h = build({ ordenes: [order({ id: "#A", order_uid: "uid-a", service_session_id: OPEN.id })] });
    const p = await h.pending();
    assert.strictEqual(p.counts.porCobrar, 0);
    assert.strictEqual(p.totals.porCobrar, 0);
    const s = await h.snapshot();
    assert.strictEqual(s.obligation.unpaid, 12.5);
    assert.strictEqual(s.obligation.currentServiceUnpaid, 12.5, "live: Por cobrar aún abierto");
  });

  // ── B ────────────────────────────────────────────────────────────────────
  await atest("B · CLOSED service, EN_ENTREGA, unpaid 12,50 -> historical pending 12,50 (delivery flagged SIN_CONFIRMAR)", async () => {
    const h = build({ ordenes: [order({ id: "#B", order_uid: "uid-b" })] });
    const p = await h.pending();
    assert.strictEqual(p.counts.porCobrar, 1);
    assert.strictEqual(p.totals.porCobrar, 12.5);
    assert.strictEqual(p.porCobrar[0].orderUid, "uid-b");
    assert.strictEqual(p.porCobrar[0].amount, 12.5);
    assert.strictEqual(p.porCobrar[0].serviceSessionId, CLOSED.id, "the sale stays attributed to the CLOSED service");
    assert.strictEqual(p.porCobrar[0].deliveryState, "SIN_CONFIRMAR", "the delivery fact travels next to the money fact");
    assert.deepStrictEqual([...p.porCobrar[0].allowedActions], [], "EN_ENTREGA (delivery not confirmed) never offers a plain collection -- it would read as a delivery confirmation");
    const s = await h.snapshot();
    assert.strictEqual(s.obligation.unpaid, 12.5);
    assert.strictEqual(s.obligation.currentServiceUnpaid, 0, "no longer counted as a live balance");
  });

  // ── C ────────────────────────────────────────────────────────────────────
  await atest("C · CLOSED service, RETIRADO (delivered), unpaid 12,50 -> still historical pending 12,50", async () => {
    const h = build({ ordenes: [order({ id: "#C", order_uid: "uid-c", estado: "RETIRADO" })] });
    const p = await h.pending();
    assert.strictEqual(p.totals.porCobrar, 12.5);
    assert.strictEqual(p.porCobrar[0].deliveryState, "ENTREGADO", "delivered: only the money is open");
    assert.deepStrictEqual([...p.porCobrar[0].allowedActions], ["COLLECT"], "delivered + unpaid + permanent identity: the operator can register the collection");
    assert.strictEqual((await h.snapshot()).obligation.currentServiceUnpaid, 0);
  });

  // ── D ────────────────────────────────────────────────────────────────────
  await atest("D · CLOSED service, RETIRADO, paid -> historical pending 0", async () => {
    const o = order({ id: "#D", order_uid: "uid-d", estado: "RETIRADO" });
    const h = build({ ordenes: [o], events: [paid(o)] });
    const p = await h.pending();
    assert.strictEqual(p.counts.porCobrar, 0);
    assert.strictEqual(p.totals.porCobrar, 0);
    const s = await h.snapshot();
    assert.strictEqual(s.obligation.unpaid, 0);
    assert.strictEqual(s.obligation.currentServiceUnpaid, 0);
  });

  // ── E ────────────────────────────────────────────────────────────────────
  await atest("E · CLOSED service, EN_ENTREGA, payment succeeds first -> pending 0, and it stays 0 when the delivery is confirmed afterwards", async () => {
    const o = order({ id: "#E", order_uid: "uid-e" });
    const beforeDelivery = build({ ordenes: [o], events: [paid(o)] });
    assert.strictEqual((await beforeDelivery.pending()).totals.porCobrar, 0, "paid while still EN_ENTREGA: no pendency");
    assert.strictEqual((await beforeDelivery.snapshot()).obligation.currentServiceUnpaid, 0);
    const afterDelivery = build({ ordenes: [{ ...o, estado: "RETIRADO" }], events: [paid(o)] });
    assert.strictEqual((await afterDelivery.pending()).totals.porCobrar, 0, "delivery confirmation arriving later changes nothing");
    assert.strictEqual((await afterDelivery.snapshot()).obligation.unpaid, 0);
  });

  await atest("E2 · the pendency DISAPPEARS when the payment is recorded (before/after on the same order)", async () => {
    const o = order({ id: "#E2", order_uid: "uid-e2" });
    assert.strictEqual((await build({ ordenes: [o] }).pending()).totals.porCobrar, 12.5, "before the payment");
    assert.strictEqual((await build({ ordenes: [o], events: [paid(o)] }).pending()).totals.porCobrar, 0, "after the payment");
  });

  await atest("E3 · a PARTIAL payment leaves exactly the remainder as the pendency", async () => {
    const o = order({ id: "#E3", order_uid: "uid-e3", totale: 20 });
    const p = await build({ ordenes: [o], events: [paid(o, 8)] }).pending();
    assert.strictEqual(p.totals.porCobrar, 12);
    assert.strictEqual(p.porCobrar[0].deliveryState, "SIN_CONFIRMAR");
  });

  // ── F ────────────────────────────────────────────────────────────────────
  await atest("F · no double count: every euro is in EXACTLY ONE of 'Por cobrar aún abierto' / 'Pendientes anteriores'", async () => {
    const ordenes = [
      order({ id: "#F1", order_uid: "uid-f1", service_session_id: OPEN.id, estado: "EN_ENTREGA", totale: 10 }),   // live
      order({ id: "#F2", order_uid: "uid-f2", service_session_id: OPEN.id, estado: "LISTO", totale: 7 }),          // live
      order({ id: "#F3", order_uid: "uid-f3", service_session_id: OPEN.id, estado: "RETIRADO", totale: 5 }),       // historical (terminal)
      order({ id: "#F4", order_uid: "uid-f4", estado: "EN_ENTREGA", totale: 12.5 }),                               // historical (closed service)
      order({ id: "#F5", order_uid: "uid-f5", estado: "RETIRADO", totale: 30 }),                                   // historical
      order({ id: "#F6", order_uid: "uid-f6", estado: "EN_ENTREGA", totale: 9 }),                                  // paid -> nothing
    ];
    const h = build({ ordenes, events: [paid(ordenes[5])] });
    const p = await h.pending();
    const s = await h.snapshot();
    assert.strictEqual(s.obligation.unpaid, 64.5, "10 + 7 + 5 + 12.5 + 30");
    assert.strictEqual(s.obligation.currentServiceUnpaid, 17, "F1 + F2 (live)");
    assert.strictEqual(p.totals.porCobrar, 47.5, "F3 + F4 + F5 (historical)");
    assert.strictEqual(r2(s.obligation.currentServiceUnpaid + p.totals.porCobrar), s.obligation.unpaid,
      "current + historical == the window-wide unpaid: a partition, never an overlap");
    const historicalIds = new Set(p.porCobrar.map((i) => i.orderUid));
    assert.deepStrictEqual([...historicalIds].sort(), ["uid-f3", "uid-f4", "uid-f5"]);
  });

  // ── fail-closed / non-interference ───────────────────────────────────────
  await atest("an EN_ENTREGA order whose service row cannot be resolved stays LIVE (fail closed), in both readers", async () => {
    const o = order({ id: "#G", order_uid: "uid-g", service_session_id: "svc-gone" });
    const h = build({ ordenes: [o], sessions: [OPEN] });
    assert.strictEqual((await h.pending()).totals.porCobrar, 0);
    assert.strictEqual((await h.snapshot()).obligation.currentServiceUnpaid, 12.5);
  });

  await atest("a rolled_over service is still an operational scope: its EN_ENTREGA order stays live", async () => {
    const o = order({ id: "#H", order_uid: "uid-h", service_session_id: ROLLED.id });
    const h = build({ ordenes: [o], sessions: [OPEN, ROLLED] });
    assert.strictEqual((await h.pending()).totals.porCobrar, 0);
    assert.strictEqual((await h.snapshot()).obligation.currentServiceUnpaid, 12.5);
  });

  await atest("other non-terminal states of a closed service keep their old answer (LISTO stays live)", async () => {
    const o = order({ id: "#I", order_uid: "uid-i", estado: "LISTO" });
    const h = build({ ordenes: [o] });
    assert.strictEqual((await h.pending()).totals.porCobrar, 0);
    assert.strictEqual((await h.snapshot()).obligation.currentServiceUnpaid, 12.5);
  });

  await atest("Mesa is untouched: an EN_ENTREGA-shaped Mesa order on an OPEN table of a closed service is not a pendency", async () => {
    const o = order({ id: "#J", order_uid: "uid-j", table_session_id: "ts-open", tipo_consegna: "SALA" }); // language-guard: allow-legacy tipo_consegna is the existing ordenes column name, reproduced verbatim in this fixture
    const h = build({ ordenes: [o], tableSessions: [{ id: "ts-open", workspace_id: WS, status: "open" }] });
    assert.strictEqual((await h.pending()).totals.porCobrar, 0);
    assert.strictEqual((await h.snapshot()).obligation.currentServiceUnpaid, 12.5);
  });

  await atest("a cancelled EN_ENTREGA order of a closed service is never a pendency", async () => {
    const o = order({ id: "#K", order_uid: "uid-k", estado: "CANCELADO" });
    assert.strictEqual((await build({ ordenes: [o] }).pending()).totals.porCobrar, 0);
  });

  console.log(`pendingExposuresClosedServiceDelivery: ${passed} passed`);
})();
