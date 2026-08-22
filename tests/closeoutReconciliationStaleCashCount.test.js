"use strict";
// J-2 — STALE CASH COUNT: a count is a fact at an instant, not a standing claim.
//
// THE BUG THIS FILE EXISTS FOR, reproduced from the real staging rows of
// 2026-08-22 (cash_counts 10d61ed6 and c772dfec):
//
//   13:35  the operator counts the drawer: 65.00 physical, 65.00 recorded.
//          Variance 0. Correct, and true.
//   later  51.00 more comes in as cash. The ledger moves to 116.00.
//   20:00  Finalizar is opened WITHOUT a new count, and reported
//                Efectivo registrado  116.00
//                Conteo fisico         65.00
//                Diferencia           -51.00
//
// That -51.00 is fabricated. Nothing went missing: 65.00 was the truth at
// 13:35 and stopped being the truth the moment more cash arrived. A count that
// no longer describes the present must produce NO variance at all -- reporting
// one is indistinguishable, to the person reading it, from a theft report.
//
// The rule under test: a count may serve as the CURRENT reconciliation count
// only while (1) the ledger figure it stored still equals this window's
// recorded cash receipts, and (2) no cash moved inside the window after its own
// counted_at. Failing either makes it STALE -- reported as history, never
// compared, never persisted as though it were valid.
const assert = require("assert");
const { createCloseoutReconciliation } = require("../src/economy/closeoutReconciliation");
const { createEconomicSnapshot } = require("../src/economy/economicSnapshot");
const { createMemorySelect } = require("./fixtures/postgrestMemorySelect");

let passed = 0;
const atest = async (name, fn) => {
  try { await fn(); passed += 1; }
  catch (error) { console.error(`FAIL: ${name}\n  ${error && error.stack}`); process.exitCode = 1; }
};

// ── The real Business Day of 2026-08-22 (04:00 Madrid -> 04:00) ─────────────
const SESSION = "5b1e0c74-9a7f-4c62-9c5e-0f2a1d6b3e40";
const DAY_FROM = "2026-08-22T02:00:00.000Z";
const DAY_TO = "2026-08-23T02:00:00.000Z";
const TZ = "Europe/Madrid";

const sessions = [Object.freeze({
  id: SESSION, business_date: "2026-08-22", status: "open",
  // language-guard: allow-legacy PRANZO is the existing service_kind enum value this fixture row must carry verbatim, not new vocabulary
  opened_at: "2026-08-22T09:02:00.000+00:00", closed_at: null, service_kind: "PRANZO",
})];

// 65.00 of cash, all of it before the 11:35 count.
const BEFORE = [
  { id: "#999101", amount: 30, at: "2026-08-22T10:10:00.000+00:00" },
  { id: "#999102", amount: 20, at: "2026-08-22T10:40:00.000+00:00" },
  { id: "#999103", amount: 15, at: "2026-08-22T11:20:00.000+00:00" },
];
// The 51.00 that arrives AFTER the count and turns 65.00 into 116.00.
const AFTER = { id: "#999104", amount: 51, at: "2026-08-22T12:00:00.000+00:00" };

const orderOf = ({ id, amount, at }) => ({
  id, estado: "ENTREGADO", totale: amount, metodo_pago: "efectivo",
  cobrado: true, ya_pagado: true, service_session_id: SESSION, created_at: at,
});
const eventOf = ({ id, amount, at }, type = "payment") => ({
  id: `ev-${id}-${type}`, order_id: id, type, amount, payment_method: "efectivo",
  created_at: at, service_session_id: SESSION, event_service_session_id: SESSION,
  // language-guard: allow-legacy PRANZO is the existing stamped-era key these S-C columns hold, reproduced verbatim in a fixture, not new vocabulary
  obligation_economic_period_kind: "PRANZO", event_economic_period_kind: "PRANZO",
});

// The 13:35 Madrid count: 65.00 counted against 65.00 recorded. Variance 0.
const COUNT_1335 = Object.freeze({
  id: "10d61ed6-2d71-4421-8d73-ac3fd984eb5b",
  counted_at: "2026-08-22T11:35:06.567+00:00",
  actor: "owner", actor_role: "admin", workspace_id: "ws-1",
  counted_cash_cents: 6500, recorded_cash_receipts_cents: 6500, variance_cents: 0,
  window_from: DAY_FROM, window_to: DAY_TO, window_timezone: TZ, window_preset: "hoy",
  service_session_id: null, note: null, client_request_id: "cash_1335",
});
// The 14:06 Madrid re-count, taken after the 51.00 landed: 116.00 / 116.00.
const COUNT_1406 = Object.freeze({
  ...COUNT_1335,
  id: "c772dfec-707d-4e09-a6c5-c5477406bfeb",
  counted_at: "2026-08-22T12:06:19.467+00:00",
  counted_cash_cents: 11600, recorded_cash_receipts_cents: 11600, variance_cents: 0,
  client_request_id: "cash_1406",
});

function harness({ cashCounts = [], extraEvents = [], extraOrders = [] } = {}) {
  const rpcCalls = [];
  const store = [];
  const counts = cashCounts.map((c) => ({ ...c }));
  const select = createMemorySelect({
    // language-guard: allow-legacy storico is the existing archive table name in this fixture map, not new vocabulary
    ordenes: [...BEFORE.map(orderOf), ...extraOrders], storico: [],
    order_financial_events: [...BEFORE.map((b) => eventOf(b)), ...extraEvents],
    service_sessions: sessions, cash_counts: counts,
    service_closeout_reconciliations: store,
  });
  const rpc = async (fn, args) => {
    rpcCalls.push({ fn, args });
    const row = {
      id: `rec-${store.length + 1}`, created_at: "2026-08-22T18:00:00.000Z",
      service_session_id: args.p_service_session_id,
      closeout_correlation_id: args.p_closeout_correlation_id,
      window_from: args.p_window_from, window_to: args.p_window_to,
      window_timezone: args.p_window_timezone, window_preset: args.p_window_preset,
      business_date: args.p_business_date,
      gross_cents: args.p_gross_cents, collected_cents: args.p_collected_cents,
      unpaid_cents: args.p_unpaid_cents, voided_cents: args.p_voided_cents,
      refunded_cents: args.p_refunded_cents,
      cash_receipts_cents: args.p_cash_receipts_cents, card_receipts_cents: args.p_card_receipts_cents,
      bizum_receipts_cents: args.p_bizum_receipts_cents, other_receipts_cents: args.p_other_receipts_cents,
      order_count: args.p_order_count, service_count: args.p_service_count,
      cash_count_id: args.p_cash_count_id || null,
      counted_cash_cents: args.p_cash_count_id ? args.p_counted_cash_cents : null,
      variance_cents: args.p_cash_count_id ? args.p_counted_cash_cents - args.p_cash_receipts_cents : null,
      actor: args.p_actor,
    };
    store.push(row);
    return { ok: true, body: { ok: true, created: true, reconciliation: row } };
  };
  const service = createCloseoutReconciliation({ select, rpc, snapshot: createEconomicSnapshot({ select }) });
  return { service, rpcCalls, store, counts };
}

const build = (opts) => harness(opts).service.build({ serviceSessionId: SESSION });

(async () => {
  // ── A — a count still describing the present is valid ────────────────────
  await atest("A · count 65 / recorded 65 / nothing since -> VALID, variance 0", async () => {
    const v = await build({ cashCounts: [COUNT_1335] });
    assert.strictEqual(v.reconciliation.cashReceipts, 65, "the ledger still holds 65.00");
    assert.strictEqual(v.cashCountStatus, "current");
    assert.strictEqual(v.cashCountStaleReason, null);
    assert.ok(v.cashCount, "and the count is attached");
    assert.strictEqual(v.cashCount.id, COUNT_1335.id);
    assert.strictEqual(v.cashCount.isCurrent, true);
    assert.strictEqual(v.variance, 0, "65.00 counted - 65.00 recorded");
  });

  // ── B — THE BUG. The count did not become a shortfall. ───────────────────
  await atest("B · +51.00 after the count -> STALE, and NEVER a -51.00 variance", async () => {
    const v = await build({
      cashCounts: [COUNT_1335], extraOrders: [orderOf(AFTER)], extraEvents: [eventOf(AFTER)],
    });
    // The economy really did move — that part was never in doubt.
    assert.strictEqual(v.reconciliation.cashReceipts, 116, "recorded cash is now 116.00");

    // The whole point of this file: the fabricated shortfall must not exist.
    assert.notStrictEqual(v.variance, -51, "-51.00 is money that never went missing");
    assert.strictEqual(v.variance, null, "no current count means NO variance, not a wrong one");

    assert.strictEqual(v.cashCountStatus, "stale");
    assert.strictEqual(v.cashCountStaleReason, "recorded_cash_receipts_changed");
    assert.strictEqual(v.cashCount, null, "the stale count is not the reconciliation's count");

    // ...but it is not hidden either: it is reported as the history it is,
    // with both figures that explain why it no longer applies.
    assert.ok(v.latestCashCount, "the operator is still told a count exists");
    assert.strictEqual(v.latestCashCount.id, COUNT_1335.id);
    assert.strictEqual(v.latestCashCount.isCurrent, false);
    assert.strictEqual(v.latestCashCount.countedCash, 65);
    assert.strictEqual(v.latestCashCount.recordedCashReceiptsAtCount, 65, "true when it was taken");
    assert.strictEqual(v.latestCashCount.recordedCashReceiptsNow, 116, "and this is why it is stale");
    assert.strictEqual(v.latestCashCount.countedAt, COUNT_1335.counted_at);
  });

  await atest("B2 · a stale count is never SENT to the writer, and never persisted", async () => {
    const h = harness({
      cashCounts: [COUNT_1335], extraOrders: [orderOf(AFTER)], extraEvents: [eventOf(AFTER)],
    });
    const out = await h.service.persist({
      serviceSessionId: SESSION, closeoutCorrelationId: "corr-j2-stale", actor: "owner",
    });
    assert.strictEqual(out.success, true, "the close still proceeds — staleness never blocks Finalizar");
    assert.strictEqual(h.rpcCalls[0].args.p_cash_count_id, null);
    assert.strictEqual(h.rpcCalls[0].args.p_counted_cash_cents, null);
    assert.strictEqual(h.rpcCalls[0].args.p_cash_receipts_cents, 11600, "the economy is still recorded in full");
    assert.strictEqual(out.reconciliation.variance, null);
    assert.strictEqual(out.reconciliation.countedCash, null);
    assert.strictEqual(out.reconciliation.cashCountId, null,
      "a permanent append-only row must not fossilise a variance that was never real");
  });

  await atest("B3 · movement that cancels back to the same total is STILL stale", async () => {
    // +51.00 then -51.00 refunded: the total returns to 65.00, so the ledger
    // check alone would call this fresh. The drawer was demonstrably touched
    // after the operator walked away from it, so it is not.
    const refund = { id: AFTER.id, amount: 51, at: "2026-08-22T12:30:00.000+00:00" };
    const v = await build({
      cashCounts: [COUNT_1335],
      extraOrders: [orderOf(AFTER)],
      extraEvents: [eventOf(AFTER), eventOf(refund, "refund")],
    });
    assert.strictEqual(v.reconciliation.cashReceipts, 65, "the totals agree again");
    assert.strictEqual(v.cashCountStatus, "stale", "but the count still predates real movement");
    assert.strictEqual(v.cashCountStaleReason, "cash_movement_after_count");
    assert.strictEqual(v.variance, null);
  });

  // ── C — a fresh re-count restores a real variance ────────────────────────
  await atest("C · after a new count 116 / recorded 116 -> VALID again, variance 0", async () => {
    const v = await build({
      cashCounts: [COUNT_1335, COUNT_1406],
      extraOrders: [orderOf(AFTER)], extraEvents: [eventOf(AFTER)],
    });
    assert.strictEqual(v.reconciliation.cashReceipts, 116);
    assert.strictEqual(v.cashCountStatus, "current");
    assert.strictEqual(v.cashCount.id, COUNT_1406.id, "the newest count is the one that counts");
    assert.strictEqual(v.cashCount.countedCash, 116);
    assert.strictEqual(v.variance, 0);
    assert.strictEqual(v.cashCountCandidates, 2, "and both are still acknowledged");
  });

  await atest("C2 · a fresh re-count that genuinely disagrees still reports the difference", async () => {
    // The fix must not have made variance unreachable — a real shortfall,
    // counted against the economy it belongs to, must still surface.
    const short = { ...COUNT_1406, id: "dddddddd-0000-4000-8000-000000000004", counted_cash_cents: 11100 };
    const v = await build({
      cashCounts: [COUNT_1335, short],
      extraOrders: [orderOf(AFTER)], extraEvents: [eventOf(AFTER)],
    });
    assert.strictEqual(v.cashCountStatus, "current");
    assert.strictEqual(v.variance, -5, "111.00 counted - 116.00 recorded is a REAL -5.00");
  });

  // ── D — no count at all is a normal outcome ──────────────────────────────
  await atest("D · no cash count -> Finalizar unchanged, and no variance is invented", async () => {
    const h = harness({ cashCounts: [], extraOrders: [orderOf(AFTER)], extraEvents: [eventOf(AFTER)] });
    const v = await h.service.build({ serviceSessionId: SESSION });
    assert.strictEqual(v.ok, true);
    assert.strictEqual(v.cashCountStatus, "none");
    assert.strictEqual(v.cashCount, null);
    assert.strictEqual(v.latestCashCount, null);
    assert.strictEqual(v.cashCountStaleReason, null);
    assert.strictEqual(v.variance, null, "null, never 0 — 0 asserts an agreement nobody verified");
    assert.strictEqual(v.reconciliation.cashReceipts, 116, "the economy is still fully reported");

    const out = await h.service.persist({
      serviceSessionId: SESSION, closeoutCorrelationId: "corr-j2-none", actor: "owner",
    });
    assert.strictEqual(out.success, true, "closing without a count remains permitted");
    assert.strictEqual(out.reconciliation.variance, null);
  });

  // ── E — the count itself is history, and history does not move ───────────
  await atest("E · no code path here rewrites, deletes or re-derives a cash count", async () => {
    const h = harness({
      cashCounts: [COUNT_1335], extraOrders: [orderOf(AFTER)], extraEvents: [eventOf(AFTER)],
    });
    const frozen = JSON.stringify(h.counts[0]);
    await h.service.build({ serviceSessionId: SESSION });
    await h.service.persist({ serviceSessionId: SESSION, closeoutCorrelationId: "corr-j2-e", actor: "owner" });
    assert.strictEqual(JSON.stringify(h.counts[0]), frozen,
      "going stale is a judgement made at READ time; the row is untouched");
    // Staleness must never be written back onto the count, so the only write
    // this module may make is the reconciliation itself.
    assert.strictEqual(h.rpcCalls.length, 1);
    assert.strictEqual(h.rpcCalls[0].fn, "create_service_closeout_reconciliation_v1");

    const source = require("fs").readFileSync(
      require("path").join(__dirname, "../src/economy/closeoutReconciliation.js"), "utf8");
    for (const forbidden of ["sbUpdate", "sbDelete", "sbInsert"]) {
      assert.ok(!source.includes(forbidden), `${forbidden} must not appear in a read+one-RPC module`);
    }
  });

  await atest("E2 · staleness is decided per-read, so the same row is valid before and stale after", async () => {
    // The same stored count, the same window, two different economies. This is
    // what makes it a point-in-time fact rather than a stored verdict.
    const fresh = await build({ cashCounts: [COUNT_1335] });
    const stale = await build({
      cashCounts: [COUNT_1335], extraOrders: [orderOf(AFTER)], extraEvents: [eventOf(AFTER)],
    });
    assert.strictEqual(fresh.cashCount.id, stale.latestCashCount.id, "one and the same row");
    assert.strictEqual(fresh.cashCountStatus, "current");
    assert.strictEqual(stale.cashCountStatus, "stale");
    assert.strictEqual(fresh.variance, 0);
    assert.strictEqual(stale.variance, null);
  });

  await atest("a count taken AFTER the window closed is current while nothing moves", async () => {
    // The ordinary end-of-day case: the window ended at 04:00, the operator
    // counts at 06:00. Nothing can arrive after the window, so gate 2 is
    // vacuous and the count stays current — the fix must not break this.
    const late = { ...COUNT_1335, counted_at: "2026-08-23T04:00:00.000+00:00", client_request_id: "cash_late" };
    const v = await build({ cashCounts: [late] });
    assert.strictEqual(v.cashCountStatus, "current");
    assert.strictEqual(v.variance, 0);
  });

  console.log(`closeoutReconciliationStaleCashCount: ${passed} passed`);
})();
