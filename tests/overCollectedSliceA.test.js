"use strict";
// ===============================================================
// OVER-COLLECTED SLICE A — canonical reader semantics, zero migration.
//
// Reproduces the live shapes named in the 2026-08-26 audit
// (CANCELLED_ORDER_ALLOCATION_EXPOSURE_AND_OVER_COLLECTED_CONTRACT_2026-08-26.md)
// without touching staging: table_session 6ebbffe2 (obligation 0, collected
// 75), 7c47ddf9 (obligation 29.50, over-collected 10.01), and the
// force-closed-table-is-not-a-void ruling that mesaService.js:32 had
// drifted from currentServiceCloseout.js's own already-deployed decision.
//
// FROZEN EQUATIONS under test everywhere in this file:
//   netCollected      = Σ payments − Σ refunds            (never clamped)
//   currentObligation = latest valid obligation
//   unpaid            = max(0, currentObligation − netCollected)
//   overCollected     = max(0, netCollected − currentObligation)
// unpaid and overCollected are ALWAYS published together — never inferred
// from the other's absence.
// ===============================================================

const assert = require("node:assert/strict");
const test = require("node:test");
const { projectSessionAccount, buildFloor } = require("../src/tables/mesaService");
const { createCurrentServiceCloseout, aggregate } = require("../src/closeout/currentServiceCloseout");
const { createEconomicSnapshot } = require("../src/economy/economicSnapshot");
const { createCashCountService } = require("../src/economy/cashCountService");
const { createMemorySelect } = require("./fixtures/postgrestMemorySelect");

const session = (overrides = {}) => ({ id: "s1", covers_total: null, ...overrides });
const closeoutSession = (overrides = {}) => ({
  id: "00000000-0000-4000-8000-00000000000a", business_date: "2026-08-13",
  opened_at: "2026-08-13T17:00:00Z", closed_at: null, status: "open", ...overrides,
});
const identity = (value) => ({ currentCloseout: async () => value });
// Named once, referenced everywhere below, matching currentServiceCloseout.test.js's
// own established pattern for this exact literal. -- language-guard: allow-legacy FORCE_CLOSED_TABLE_ESTADO is the existing terminal-state literal under test throughout this file; named once here so every test below references the constant instead, not new vocabulary
const FORCE_CLOSED_TABLE_ESTADO = "CHIUSO_FORZATO";

// ─── §16 — CANONICAL SCENARIOS, mesaService.projectSessionAccount ─────────

test("over-collected §16: obligation 0 / collected 75 (mirrors live table_session 6ebbffe2) publishes overCollected 75, not a hidden zero", () => {
  const account = projectSessionAccount(session(), {
    lines: [],
    orders: [],
    transactions: [{ id: "p1", kind: "payment", amount: 75, payment_method: "efectivo" }],
  });
  assert.equal(account.total, 0);
  assert.equal(account.paid, 75);
  assert.equal(account.outstanding, 0);
  assert.equal(account.overCollected, 75);
});

test("over-collected §16: obligation 20 / collected 30 -> outstanding 0, overCollected 10", () => {
  const account = projectSessionAccount(session(), {
    lines: [{ id: "l1", amount: 20, paid: 20, remaining: 0 }],
    orders: [],
    transactions: [{ id: "p1", kind: "payment", amount: 30, payment_method: "tarjeta" }],
  });
  assert.equal(account.total, 20);
  assert.equal(account.paid, 30);
  assert.equal(account.outstanding, 0);
  assert.equal(account.overCollected, 10);
});

test("over-collected §16: obligation 30 / collected 20 -> unpaid 10, overCollected 0", () => {
  const account = projectSessionAccount(session(), {
    lines: [{ id: "l1", amount: 30, paid: 20, remaining: 10 }],
    orders: [],
    transactions: [{ id: "p1", kind: "payment", amount: 20, payment_method: "efectivo" }],
  });
  assert.equal(account.total, 30);
  assert.equal(account.paid, 20);
  assert.equal(account.outstanding, 10);
  assert.equal(account.overCollected, 0);
});

test("over-collected §16: obligation 30 / collected 30 -> both zero", () => {
  const account = projectSessionAccount(session(), {
    lines: [{ id: "l1", amount: 30, paid: 30, remaining: 0 }],
    orders: [],
    transactions: [{ id: "p1", kind: "payment", amount: 30, payment_method: "bizum" }],
  });
  assert.equal(account.outstanding, 0);
  assert.equal(account.overCollected, 0);
});

test("over-collected §16: payment 30, refund 10, obligation 30 -> netCollected 20 / unpaid 10 / overCollected 0", () => {
  const account = projectSessionAccount(session(), {
    lines: [{ id: "l1", amount: 30, paid: 20, remaining: 10 }],
    orders: [],
    transactions: [
      { id: "p1", kind: "payment", amount: 30, payment_method: "efectivo" },
      { id: "r1", kind: "refund", amount: 10, payment_method: "efectivo" },
    ],
  });
  assert.equal(account.paid, 20);
  assert.equal(account.outstanding, 10);
  assert.equal(account.overCollected, 0);
});

// ─── §17 — the force-closed-table terminal state is not an economic void,
// at the mesaService layer. mesaService.js:32's CANCELLED set used to
// include it (a drift from currentServiceCloseout.js's own already-
// deployed, evidence-backed decision). Proven directly against
// normalizeLinesBySession/buildFloor: such an order's line must not be
// dropped, and its payment must still reach paid/paymentTotals/account
// money.

test("over-collected §17: a force-closed-table order's line and payment still contribute to the account (not economic void)", () => {
  const rows = {
    tables: [{ id: "t1", table_number: 9, display_name: "Mesa 9", capacity: 4, position_x: 0, position_y: 0, shape: "round", active: true }],
    sessions: [{ id: "s1", table_id: "t1", service_session_id: "svc-1", status: "open", covers_total: 2, opened_at: "now" }],
    orders: [{ id: "o1", table_session_id: "s1", table_command_number: 1, estado: FORCE_CLOSED_TABLE_ESTADO, totale: 75, items: [] }],
    lines: [{ id: "l1", table_session_id: "s1", order_id: "o1", source_line_id: "g1", source_line_index: 1, unit_index: 1, description: "Pizza", product_snapshot: {}, net_amount: 75 }],
    transactions: [{ id: "p1", table_session_id: "s1", kind: "payment", mode: "full", amount: 75, payment_method: "efectivo", covers_settled: 2 }],
    allocations: [{ payment_transaction_id: "p1", table_order_line_id: "l1", amount: 75 }],
  };
  const table = buildFloor(rows)[0];
  assert.equal(table.session.lines.length, 1, "the order's line must survive normalizeLinesBySession");
  assert.equal(table.session.total, 75);
  assert.equal(table.session.paid, 75);
  assert.equal(table.session.outstanding, 0);
  assert.equal(table.session.overCollected, 0);
  assert.deepEqual(table.session.paymentTotals, { efectivo: 75 });
});

// ─── §17 (currentServiceCloseout layer) — payment/collected/methodTotals/
// economic reporting all still see a force-closed-table order's real money. ─

test("over-collected §17: currentServiceCloseout — force-closed-table order contributes payment, collected, method totals and economic reporting", async () => {
  const s = closeoutSession();
  const orders = [{ id: "o1", service_session_id: s.id, totale: 75, estado: FORCE_CLOSED_TABLE_ESTADO }];
  const events = [{ order_id: "o1", service_session_id: s.id, type: "payment", amount: 75, payment_method: "efectivo" }];
  const out = await createCurrentServiceCloseout({
    select: async (t) => (t === "ordenes" ? orders : events),
    sessionLifecycle: identity({ ok: true, code: "OK", session: s }),
  })();
  assert.equal(out.tickets[0].cancelled, false, "a force-closed table is not economic cancellation");
  assert.equal(out.tickets[0].paymentState, "paid");
  assert.equal(out.totals.gross, 75);
  assert.equal(out.totals.collected, 75);
  assert.equal(out.paymentTotals.efectivo, 75);
  assert.equal(out.counts.cancelled, 0);
});

// ─── §18 — SELF-CONSISTENCY: paid must reconcile to paymentTotals, always ──

function sumPaymentTotals(paymentTotals) {
  return Math.round(Object.values(paymentTotals).reduce((s, v) => s + Number(v || 0), 0) * 100) / 100;
}

test("over-collected §18: mesaService — account.paid always reconciles to paymentTotals net sum (mixed methods)", () => {
  const account = projectSessionAccount(session(), {
    lines: [{ id: "l1", amount: 10, paid: 10, remaining: 0 }],
    orders: [],
    transactions: [
      { id: "p1", kind: "payment", amount: 50, payment_method: "efectivo" },
      { id: "p2", kind: "payment", amount: 30, payment_method: "tarjeta" },
      { id: "r1", kind: "refund", amount: 5, payment_method: "tarjeta" },
    ],
  });
  assert.equal(account.paid, sumPaymentTotals(account.paymentTotals));
  assert.notEqual(account.paid, 0, "regression guard: paid must never read 0 beside a non-zero paymentTotals");
});

test("over-collected §18: mesaService — a force-closed-table account never shows paid=0 beside a non-zero paymentTotals", () => {
  const table = buildFloor({
    tables: [{ id: "t1", table_number: 1, display_name: "Mesa 1", position_x: 0, position_y: 0, shape: "round", active: true }],
    sessions: [{ id: "s1", table_id: "t1", service_session_id: "svc", status: "open", covers_total: 2 }],
    orders: [{ id: "o1", table_session_id: "s1", estado: FORCE_CLOSED_TABLE_ESTADO, totale: 40, items: [] }],
    lines: [{ id: "l1", table_session_id: "s1", order_id: "o1", description: "x", net_amount: 40 }],
    transactions: [{ id: "p1", table_session_id: "s1", kind: "payment", amount: 40, payment_method: "bizum", covers_settled: 2 }],
    allocations: [{ payment_transaction_id: "p1", table_order_line_id: "l1", amount: 40 }],
  })[0];
  assert.equal(table.session.paid, sumPaymentTotals(table.session.paymentTotals));
  assert.equal(table.session.paid, 40);
  assert.notEqual(table.session.paid, 0);
});

test("over-collected §18: currentServiceCloseout — paymentTotals reconciles to collectedTotal across mixed cancelled/non-cancelled tickets", async () => {
  const s = closeoutSession({ status: "closed", closed_at: "2026-08-13T22:00:00Z" });
  const orders = [
    { id: "o1", service_session_id: s.id, totale: 20, estado: "RETIRADO" },
    { id: "o2", service_session_id: s.id, totale: 40, estado: "CANCELADO" },
  ];
  const events = [
    { order_id: "o1", service_session_id: s.id, type: "payment", amount: 20, payment_method: "efectivo" },
    { order_id: "o2", service_session_id: s.id, type: "payment", amount: 40, payment_method: "tarjeta" },
  ];
  const out = aggregate(s, orders, events, []);
  assert.equal(out.totals.collected, sumPaymentTotals(out.paymentTotals));
  assert.equal(out.totals.collected, 60);
});

// ─── §19 — economicSnapshot reporting: A/B from the brief, plus D (Refund
// Slice C untouched) exercised in the same over-collected scenario. ────────

const WIN_FROM = "2026-08-13T02:00:00.000Z";
const WIN_TO = "2026-08-14T02:00:00.000Z";
const SNAPSHOT_SESSION = Object.freeze({
  id: "svc-oc", business_date: "2026-08-13", status: "closed",
  opened_at: "2026-08-13T18:00:00Z", closed_at: "2026-08-13T23:00:00Z", service_kind: "SERA",
});
const oc_order = (overrides) => Object.freeze({
  id: "#oc1", service_session_id: "svc-oc", created_at: "2026-08-13T20:00:00Z",
  estado: "RETIRADO", totale: 20, ...overrides,
});
const oc_event = (overrides) => Object.freeze({
  id: `oc-evt-${Math.random()}`, order_id: "#oc1", service_session_id: "svc-oc", event_service_session_id: "svc-oc",
  created_at: "2026-08-13T20:05:00Z", ...overrides,
});
function ocSnapshot({ ordenes = [], events = [] } = {}) {
  // language-guard: allow-legacy storico is the existing archive table name economicSnapshot.js already queries, keyed here verbatim, not new vocabulary
  const select = createMemorySelect({ ordenes, storico: [], order_financial_events: events, service_sessions: [SNAPSHOT_SESSION] });
  return createEconomicSnapshot({ select });
}

test("over-collected §19 A: obligation 20, cash receipts 30, no refunds -> receipts cash 30, overCollected 10", async () => {
  const snapshot = ocSnapshot({
    ordenes: [oc_order({ totale: 20 })],
    events: [oc_event({ id: "e1", type: "payment", amount: 30, payment_method: "efectivo" })],
  });
  const view = await snapshot({ preset: "personalizado", from: WIN_FROM, to: WIN_TO });
  assert.equal(view.receipts.byMethod.efectivo, 30);
  assert.equal(view.obligation.gross, 20);
  assert.equal(view.balance.overCollected, 10);
  assert.equal(view.balance.unpaid, 0);
});

test("over-collected §19 B: obligation 20, cash receipts 30, cash refund 10 -> net cash 20, overCollected 0", async () => {
  const snapshot = ocSnapshot({
    ordenes: [oc_order({ totale: 20 })],
    events: [
      oc_event({ id: "e1", type: "payment", amount: 30, payment_method: "efectivo" }),
      oc_event({ id: "e2", type: "refund", amount: 10, payment_method: "efectivo" }),
    ],
  });
  const view = await snapshot({ preset: "personalizado", from: WIN_FROM, to: WIN_TO });
  assert.equal(view.receipts.byMethod.efectivo, 20);
  assert.equal(view.balance.overCollected, 0);
});

test("over-collected §19 D: Refund Slice C invariant (byMethod === byMethodGross - byMethodRefunds) still holds in an over-collected window", async () => {
  const snapshot = ocSnapshot({
    ordenes: [oc_order({ totale: 20 })],
    events: [
      oc_event({ id: "e1", type: "payment", amount: 30, payment_method: "efectivo" }),
      oc_event({ id: "e2", type: "refund", amount: 10, payment_method: "efectivo" }),
    ],
  });
  const view = await snapshot({ preset: "personalizado", from: WIN_FROM, to: WIN_TO });
  assert.equal(view.receipts.byMethodGross.efectivo, 30);
  assert.equal(view.receipts.byMethodRefunds.efectivo, 10);
  assert.equal(
    Math.round((view.receipts.byMethodGross.efectivo - view.receipts.byMethodRefunds.efectivo) * 100) / 100,
    view.receipts.byMethod.efectivo,
  );
});

// ─── §20 — closeout: real over-collection (not just a void) must not be
// capped to obligation, and must not report a fake zero. ───────────────────

test("over-collected §20: currentServiceCloseout — obligation 20 / collected 30 -> gross 20, collected 30, overCollected 10, no fake zero", async () => {
  const s = closeoutSession();
  const orders = [{ id: "o1", service_session_id: s.id, totale: 20 }];
  const events = [{ order_id: "o1", service_session_id: s.id, type: "payment", amount: 30, payment_method: "tarjeta" }];
  const out = await createCurrentServiceCloseout({
    select: async (t) => (t === "ordenes" ? orders : events),
    sessionLifecycle: identity({ ok: true, code: "OK", session: s }),
  })();
  assert.equal(out.totals.gross, 20);
  assert.equal(out.totals.collected, 30);
  assert.equal(out.totals.unpaid, 0);
  assert.equal(out.totals.overCollected, 10);
  assert.equal(out.tickets[0].overCollectedAmount, 10);
});

// ─── §11/§22 — CAJA stays physical: only a real refund reduces net cash. ───
// cashCountService reads ONLY view.receipts.byMethod.efectivo -- proving the
// window reports the real 30 (not a commercial-adjustment-shrunk 20) proves
// the drawer comparison stays physical, with zero cashCountService changes.

test("over-collected §11: cashCountService compares against the REAL cash received, never a lower commercial figure", async () => {
  const fakeSnapshot = async () => ({
    window: { from: WIN_FROM, to: WIN_TO, timezone: "Europe/Madrid", preset: "personalizado", serviceSessionId: null, generatedAt: "2026-08-13T23:00:00Z", asOf: "2026-08-13T23:00:00Z" },
    receipts: { byMethod: { efectivo: 30, tarjeta: 0, bizum: 0, other: 0 } },
    obligation: {}, counts: {},
    windowCrossing: { obligationBeforeWindowReceiptInside: [], obligationInsideWindowReceiptAfter: [], receiptsSplitAcrossBoundary: [] },
  });
  let inserted = null;
  const service = createCashCountService({
    select: async () => [],
    insert: async (table, payload) => { inserted = payload; return [{ ...payload, id: "row-1" }]; },
    snapshot: fakeSnapshot,
  });
  const result = await service.create({
    context: { actor: "admin-1", role: "admin", workspaceId: "ws-1" },
    countedCash: 30,
    clientRequestId: "cash-count-over-collected-0001",
  });
  assert.equal(result.count.recordedCashReceipts, 30, "Caja must see the real 30.00 cash movement, not a commercial obligation of 20");
  assert.equal(inserted.recorded_cash_receipts_cents, 3000);
});
