"use strict";
// REFUND V1 SLICE C — economicSnapshot additive reporting.
//
// receipts.byMethod stays NET and untouched (still the exact object
// cashCountService/closeoutReconciliation already read). Two new SIBLING
// fields, byMethodGross and byMethodRefunds, are purely additive: for every
// method, byMethod === byMethodGross - byMethodRefunds, always. Proven here
// against the worked example from the brief plus multi-method and
// no-double-counting cases. Read-only: createEconomicSnapshot never writes.
const assert = require("assert");
const { createEconomicSnapshot } = require("../src/economy/economicSnapshot");
const { createMemorySelect } = require("./fixtures/postgrestMemorySelect");

let passed = 0;
const atest = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (error) { console.error(`  ✗ FAIL: ${name}\n    ${error && error.stack}`); process.exitCode = 1; }
};

const WIN_FROM = "2026-08-20T02:00:00.000Z";
const WIN_TO = "2026-08-21T02:00:00.000Z";

const SESSION = Object.freeze({
  id: "svc-1", business_date: "2026-08-20", status: "closed",
  opened_at: "2026-08-20T18:00:00Z", closed_at: "2026-08-20T23:00:00Z", service_kind: "SERA",
});

function harness({ ordenes = [], events = [], sessions = [SESSION] } = {}) {
  // language-guard: allow-legacy storico is the existing archive table name this reader queries, keyed here verbatim, not new vocabulary
  const select = createMemorySelect({ ordenes, storico: [], order_financial_events: events, service_sessions: sessions });
  return createEconomicSnapshot({ select });
}

const order = (overrides) => Object.freeze({
  id: "#100", service_session_id: "svc-1", created_at: "2026-08-20T20:00:00Z",
  estado: "RETIRADO", totale: 100, ...overrides,
});
const event = (overrides) => Object.freeze({
  id: `evt-${Math.random()}`, order_id: "#100", service_session_id: "svc-1", event_service_session_id: "svc-1",
  created_at: "2026-08-20T20:05:00Z", ...overrides,
});

(async () => {
  // ── THE WORKED EXAMPLE FROM THE BRIEF ────────────────────────────────────
  await atest("100 tarjeta received, 20 tarjeta refunded -> gross 100 / refunds 20 / net 80", async () => {
    const snapshot = harness({
      ordenes: [order({ totale: 100 })],
      events: [
        event({ id: "e1", type: "payment", amount: 100, payment_method: "tarjeta", created_at: "2026-08-20T20:05:00Z" }),
        event({ id: "e2", type: "refund", amount: 20, payment_method: "tarjeta", created_at: "2026-08-20T20:10:00Z" }),
      ],
    });
    const view = await snapshot({ preset: "personalizado", from: WIN_FROM, to: WIN_TO });
    assert.strictEqual(view.receipts.byMethod.tarjeta, 80, "byMethod (net) must stay exactly as before");
    assert.strictEqual(view.receipts.byMethodGross.tarjeta, 100);
    assert.strictEqual(view.receipts.byMethodRefunds.tarjeta, 20);
    assert.strictEqual(view.receipts.collected, 80);
    assert.strictEqual(view.receipts.collectedGross, 100);
    assert.strictEqual(view.receipts.refunded, 20);
  });

  await atest("the invariant byMethod === byMethodGross - byMethodRefunds holds for every method, multi-method", async () => {
    const snapshot = harness({
      ordenes: [order({ id: "#100" }), order({ id: "#101", service_session_id: "svc-1" })],
      events: [
        event({ id: "e1", order_id: "#100", type: "payment", amount: 50, payment_method: "efectivo" }),
        event({ id: "e2", order_id: "#100", type: "refund", amount: 10, payment_method: "efectivo" }),
        event({ id: "e3", order_id: "#101", type: "payment", amount: 30, payment_method: "bizum" }),
        event({ id: "e4", order_id: "#101", type: "payment", amount: 20, payment_method: "tarjeta" }),
        event({ id: "e5", order_id: "#101", type: "refund", amount: 20, payment_method: "tarjeta" }),
      ],
    });
    const view = await snapshot({ preset: "personalizado", from: WIN_FROM, to: WIN_TO });
    for (const method of ["efectivo", "tarjeta", "bizum", "other"]) {
      const net = view.receipts.byMethod[method];
      const gross = view.receipts.byMethodGross[method];
      const refunds = view.receipts.byMethodRefunds[method];
      assert.strictEqual(Math.round((gross - refunds) * 100) / 100, net,
        `${method}: byMethod (${net}) must equal byMethodGross (${gross}) - byMethodRefunds (${refunds})`);
    }
    assert.strictEqual(view.receipts.byMethodGross.efectivo, 50);
    assert.strictEqual(view.receipts.byMethodRefunds.efectivo, 10);
    assert.strictEqual(view.receipts.byMethodGross.bizum, 30);
    assert.strictEqual(view.receipts.byMethodRefunds.bizum, 0);
    // tarjeta fully refunded: gross and refunds equal, net 0 -- no double counting.
    assert.strictEqual(view.receipts.byMethodGross.tarjeta, 20);
    assert.strictEqual(view.receipts.byMethodRefunds.tarjeta, 20);
    assert.strictEqual(view.receipts.byMethod.tarjeta, 0);
  });

  await atest("no refunds in the window: byMethodRefunds is all zero, byMethodGross === byMethod", async () => {
    const snapshot = harness({
      ordenes: [order()],
      events: [event({ id: "e1", type: "payment", amount: 40, payment_method: "efectivo" })],
    });
    const view = await snapshot({ preset: "personalizado", from: WIN_FROM, to: WIN_TO });
    assert.deepStrictEqual(view.receipts.byMethodRefunds, { efectivo: 0, tarjeta: 0, bizum: 0, other: 0 });
    assert.deepStrictEqual(view.receipts.byMethodGross, view.receipts.byMethod);
  });

  await atest("a refund alone (no payment in window) is NOT double-counted: gross 0, refunds full amount", async () => {
    // Same shape as the cross-day scenario in isolation: a window that only
    // ever sees the refund side.
    const snapshot = harness({
      ordenes: [order({ created_at: "2026-08-19T20:00:00Z" })], // obligation born OUTSIDE this window
      events: [event({ id: "e1", type: "refund", amount: 20, payment_method: "tarjeta", created_at: "2026-08-20T20:10:00Z" })],
    });
    const view = await snapshot({ preset: "personalizado", from: WIN_FROM, to: WIN_TO });
    assert.strictEqual(view.receipts.byMethodGross.tarjeta, 0);
    assert.strictEqual(view.receipts.byMethodRefunds.tarjeta, 20);
    assert.strictEqual(view.receipts.byMethod.tarjeta, -20);
    assert.strictEqual(view.receipts.collected, -20);
    // The obligation (born yesterday) contributes NOTHING to this window's gross.
    assert.strictEqual(view.obligation.gross, 0);
  });

  await atest("a voided/cancelled order contributes to neither byMethodGross nor byMethodRefunds", async () => {
    const snapshot = harness({
      ordenes: [order({ estado: "CANCELADO" })],
      events: [
        event({ id: "e1", type: "payment", amount: 40, payment_method: "efectivo" }),
        event({ id: "e2", type: "refund", amount: 40, payment_method: "efectivo" }),
      ],
    });
    const view = await snapshot({ preset: "personalizado", from: WIN_FROM, to: WIN_TO });
    assert.deepStrictEqual(view.receipts.byMethodGross, { efectivo: 0, tarjeta: 0, bizum: 0, other: 0 });
    assert.deepStrictEqual(view.receipts.byMethodRefunds, { efectivo: 0, tarjeta: 0, bizum: 0, other: 0 });
  });

  await atest("this module remains read-only: createMemorySelect exposes no write method for it to reach", async () => {
    // language-guard: allow-legacy storico is the existing archive table name this reader queries, keyed here verbatim, not new vocabulary
    const select = createMemorySelect({ ordenes: [order()], storico: [], order_financial_events: [], service_sessions: [SESSION] });
    assert.strictEqual(typeof select, "function");
    // The fixture module deliberately implements ONLY select() -- proving the
    // reader compiles and runs against it is itself proof no rpc/insert/
    // update/delete call was ever attempted.
    const snapshot = createEconomicSnapshot({ select });
    await snapshot({ preset: "personalizado", from: WIN_FROM, to: WIN_TO });
  });

  console.log(`\neconomicSnapshotRefundReporting: ${passed} passed`);
  process.exit(process.exitCode || 0);
})();
