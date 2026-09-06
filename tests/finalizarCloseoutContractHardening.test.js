"use strict";
// ===============================================================
// FINALIZAR CLOSEOUT CONTRACT HARDENING — 2026-09-06
//
// The forensic audit (REPORT_FINALIZAR_ECONOMIC_CONSISTENCY_AUDIT_2026-09-05)
// proved every economic figure on Finalizar is canonically correct, and that
// the defects live at the PUBLICATION BOUNDARY:
//
//   K1  closeoutReconciliation dropped economicSnapshot.balance.overCollected,
//       so the card showed 161 / 139 / 32 with no way to explain the missing
//       10 (an order over-paid: obligation 60, net collected 70). unpaid and
//       overCollected are INDEPENDENT exposures — never netted.
//   K4  the pre-close scan keyed `attivi` by customer identity (wa_id), so two
//       orders from one phone number collapsed into one row while
//       `blocking.orders` still counted both — summary and detail disagreed
//       and a real 17,00 € exposure vanished from the pre-close list.
//   K2/K3  the frontend composed "de este servicio: Y" inside "hoy se
//       cobraron X" — a false subset claim when the service window sits
//       OUTSIDE its Business Day window. The backend already has both windows;
//       it now publishes their RELATIONSHIP so the frontend never compares
//       dates.
//
// This file proves the backend side of all three. safeTicket's arithmetic is
// NOT re-litigated (its own suites cover it); this proves what survives the
// projection.
// ===============================================================

const test = require("node:test");
const assert = require("node:assert/strict");

const { createCloseoutReconciliation } = require("../src/economy/closeoutReconciliation");
const { createEconomicSnapshot } = require("../src/economy/economicSnapshot");
const { createMemorySelect } = require("./fixtures/postgrestMemorySelect");
// language-guard: allow-legacy scanServizio is the module's existing export name under test; aliased so the rest of this file uses Spanish, not new vocabulary
const scanPreClose = require("../src/utils/servizio").scanServizio;

// ── K1 + K2/K3 fixtures ─────────────────────────────────────────────────────
// SVC_CROSS mirrors the audited service 42af1de9: opened 2026-08-25, still
// open, its window running to `asOf` days later — so it CROSSES its own
// Business Day window. One order is over-paid, one is unpaid.
const SVC_CROSS = "11111111-1111-4111-8111-111111111111";
const SVC_NEST = "22222222-2222-4222-8222-222222222222";
const ASOF = "2026-09-06T10:00:00.000Z"; // days after the service opened

const sessions = [
  { id: SVC_CROSS, business_date: "2026-08-25", status: "open",
    opened_at: "2026-08-25T17:02:59.058Z", closed_at: null, service_kind: null },
  // A normal service opened AND closed inside its own Business Day.
  { id: SVC_NEST, business_date: "2026-08-25", status: "closed",
    opened_at: "2026-08-25T18:00:00.000Z", closed_at: "2026-08-25T21:00:00.000Z", service_kind: null },
];

const ordenes = [
  // Over-paid: canonical obligation 60 (legacy totale 85 is IGNORED), paid 85
  // cash then 15 refunded -> net 70 -> unpaid 0, overCollected 10.
  { id: "#SVC1", estado: "RETIRADO", totale: 85, metodo_pago: "efectivo", cobrado: true,
    ya_pagado: true, service_session_id: SVC_CROSS, created_at: "2026-08-25T19:10:00.000Z",
    order_uid: "aaaa1111-0000-4000-8000-000000000001" },
  // Unpaid: obligation 40, nothing collected.
  { id: "#SVC2", estado: "LISTO", totale: 40, metodo_pago: "", cobrado: false,
    ya_pagado: false, service_session_id: SVC_CROSS, created_at: "2026-08-25T19:40:00.000Z",
    order_uid: "aaaa1111-0000-4000-8000-000000000002" },
  // The nested service: one clean order.
  { id: "#NEST1", estado: "RETIRADO", totale: 20, metodo_pago: "efectivo", cobrado: true,
    ya_pagado: true, service_session_id: SVC_NEST, created_at: "2026-08-25T19:30:00.000Z",
    order_uid: "bbbb2222-0000-4000-8000-000000000001" },
];

const order_obligations = [
  { order_id: "#SVC1", revision: 1, gross_amount: 60, service_session_id: SVC_CROSS },
  { order_id: "#SVC2", revision: 1, gross_amount: 40, service_session_id: SVC_CROSS },
  { order_id: "#NEST1", revision: 1, gross_amount: 20, service_session_id: SVC_NEST },
];

const ev = (id, order, type, amount, method, at, session) => ({
  id, order_id: order, type, amount, payment_method: method, created_at: at,
  service_session_id: session, event_service_session_id: session,
});
const order_financial_events = [
  ev("e-svc1-pay", "#SVC1", "payment", 85, "efectivo", "2026-08-28T06:17:52.000Z", SVC_CROSS),
  ev("e-svc1-ref", "#SVC1", "refund", 15, "efectivo", "2026-08-28T06:24:47.000Z", SVC_CROSS),
  ev("e-nest1-pay", "#NEST1", "payment", 20, "efectivo", "2026-08-25T20:00:00.000Z", SVC_NEST),
];

function recon(extra = {}) {
  const select = createMemorySelect({
    ordenes, order_obligations, order_financial_events,
    // language-guard: allow-legacy the key below is the archive table name economicSnapshot's reader queries; it must match, not new vocabulary
    storico: [],
    service_sessions: sessions, cash_counts: extra.cash_counts || [],
    service_closeout_reconciliations: [],
  });
  const service = createCloseoutReconciliation({
    select,
    rpc: async () => ({ ok: true, body: { ok: true, created: true, reconciliation: {} } }),
    snapshot: createEconomicSnapshot({ select }),
  });
  return service;
}

test("K1 · service.overCollected is projected — the canonical 10,00 €, not recomputed", async () => {
  const v = await recon().build({ serviceSessionId: SVC_CROSS, now: new Date(ASOF) });
  // The exact audited shape: 100 sold, 70 net collected, 40 unpaid, 10 over.
  assert.equal(v.service.gross, 100);
  assert.equal(v.service.collected, 70);
  assert.equal(v.service.unpaid, 40);
  assert.equal(v.service.overCollected, 10);
  assert.equal(v.service.unresolvedOverCollected, 10);
});

test("K1 · unpaid and overCollected travel SEPARATELY — never netted at the boundary", async () => {
  const v = await recon().build({ serviceSessionId: SVC_CROSS, now: new Date(ASOF) });
  // gross - collected = 30, but unpaid = 40: the 10 difference IS overCollected.
  assert.equal(v.service.gross - v.service.collected, 30);
  assert.equal(v.service.unpaid - v.service.overCollected, 30);
  // Neither field was clamped or merged into the other.
  assert.equal(v.service.unpaid, 40);
  assert.equal(v.service.overCollected, 10);
});

test("K1 · the Business Day scope also carries overCollected, independently", async () => {
  const v = await recon().build({ serviceSessionId: SVC_CROSS, now: new Date(ASOF) });
  assert.equal(v.reconciliation.overCollected, 10);
  assert.equal(v.reconciliation.unresolvedOverCollected, 10);
  assert.equal(v.reconciliation.unpaid, 40);
});

test("K1 · a service with no over-collection projects 0, not undefined", async () => {
  const v = await recon().build({ serviceSessionId: SVC_NEST, now: new Date(ASOF) });
  assert.equal(v.service.overCollected, 0);
  assert.equal(v.service.unresolvedOverCollected, 0);
  assert.equal(typeof v.reconciliation.overCollected, "number");
});

test("K2/K3 · a service whose window outlives its Business Day is 'crossing', not comparable", async () => {
  const v = await recon().build({ serviceSessionId: SVC_CROSS, now: new Date(ASOF) });
  assert.equal(v.scopeRelation.kind, "crossing");
  assert.equal(v.scopeRelation.serviceWithinDay, false);
  assert.equal(v.scopeRelation.cashCountComparable, false);
  // Both windows are stated so the frontend renders, never computes.
  assert.ok(v.scopeRelation.serviceWindow.from && v.scopeRelation.dayWindow.from);
});

test("K2/K3 · a service opened and closed inside its Business Day is 'nested' and comparable", async () => {
  const v = await recon().build({ serviceSessionId: SVC_NEST, now: new Date(ASOF) });
  assert.equal(v.scopeRelation.kind, "nested");
  assert.equal(v.scopeRelation.serviceWithinDay, true);
  assert.equal(v.scopeRelation.cashCountComparable, true);
});

test("K2/K3 · scopeRelation writes nothing and never throws for a normal service", async () => {
  const v = await recon().build({ serviceSessionId: SVC_NEST, now: new Date(ASOF) });
  assert.equal(v.ok, true);
  assert.ok(Object.isFrozen(v.scopeRelation));
});

// ── K4 — pre-close scan order identity ─────────────────────────────────────
// A fake `select` narrow enough for the scan's queries. The two orders
// share a wa_id (a real customer with two open orders) but are distinct
// orders — they must stay two rows, or the pre-close list hides one.
function scanSelect(orders) {
  return async (table, query = "") => {
    if (table === "ordenes" && /estado=in\.\(POR_CONFIRMAR/.test(query)) return orders;
    return []; // completati, conv (open/closed), wa_msgs, table_sessions
  };
}
const CURRENT = { id: SVC_CROSS, opened_at: "2026-08-25T17:02:59.058Z" };

test("K4 · two orders on ONE wa_id, distinct order_uid, stay TWO pending rows", async () => {
  const orders = [
    { id: "#SVC1", order_uid: "u-1", wa_id: "41767011848", tel: "41767011848",
      nombre: "Big Art Vidéo Agency", hora: "19:59", estado: "EN_ENTREGA" },
    { id: "#SVC2", order_uid: "u-2", wa_id: "41767011848", tel: "41767011848",
      nombre: "Big Art Vidéo Agency", hora: "21:10", estado: "LISTO" },
  ];
  const out = await scanPreClose({ select: scanSelect(orders), resolveCurrentService: async () => CURRENT });
  const orderRows = out.attivi.filter((a) => a.kind === "order");
  assert.equal(orderRows.length, 2, "both orders present, not collapsed by wa_id");
  assert.deepEqual(orderRows.map((r) => r.stato).sort(), ["EN_ENTREGA", "LISTO"]);
});

test("K4 · blocking summary and visible detail reconcile — no hidden blocker", async () => {
  const orders = [
    { id: "#SVC1", order_uid: "u-1", wa_id: "x", estado: "EN_ENTREGA" },
    { id: "#SVC2", order_uid: "u-2", wa_id: "x", estado: "LISTO" },
    { id: "#SVC3", order_uid: "u-3", wa_id: "y", estado: "EN_COCINA" },
  ];
  const out = await scanPreClose({ select: scanSelect(orders), resolveCurrentService: async () => CURRENT });
  const blockerRows = out.attivi.filter((a) => a.kind === "order" || a.kind === "table");
  // THE INVARIANT: every distinct blocking order and blocking table has exactly
  // one row of that kind in the visible detail. No customer-key collision can
  // silently drop one while the summary still counts it.
  assert.equal(out.blocking.orders, 3);
  assert.equal(out.blocking.tables, 0);
  assert.equal(blockerRows.length, out.blocking.orders + out.blocking.tables);
});

test("K4 · a legacy order with no order_uid still gets its own row (falls to text id, never merges)", async () => {
  const orders = [
    { id: "#OLD1", wa_id: "z", estado: "LISTO" },
    { id: "#OLD2", wa_id: "z", estado: "EN_COCINA" },
  ];
  const out = await scanPreClose({ select: scanSelect(orders), resolveCurrentService: async () => CURRENT });
  assert.equal(out.attivi.filter((a) => a.kind === "order").length, 2);
});

test("K4 · the default path is unchanged — no args still resolves via the lifecycle pointer", () => {
  // Static proof that the seam did not replace the production resolver.
  // language-guard: allow-legacy the module filename and function name below are read verbatim to slice the source under test, not new vocabulary
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "src", "utils", "servizio.js"), "utf8"), FN = "async function scanServizio";
  const block = src.slice(src.indexOf(FN), src.indexOf("// ─── Backup raw"));
  // The lifecycle pointer is still the default resolver; the seam only adds an
  // optional override.
  assert.match(block, /await getCurrentOperationalSession\(\)/);
  assert.match(block, /typeof select === "function" \? select : _defaultScanSelect/);
  // Orders are keyed by their own identity now, not the customer's.
  assert.match(block, /`ord:\$\{o\.order_uid \|\| o\.id\}`/);
  assert.doesNotMatch(block, /const key = o\.wa_id \|\| o\.tel \|\| o\.id;/); // the old collapsing key is gone
});
