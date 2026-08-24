"use strict";
// J-1 — FINAL RECONCILIATION V1, against the REAL staging rows.
//
// The single most important thing in this file: a variance may only ever be
// computed between a cash count and an economic window that are the SAME
// window. Service 480eca89's cash is 85.00; its Business Day's cash receipts
// are 157.50. Comparing the day's 150.00 physical count against the service's
// 85.00 would report a 65.00 EUR discrepancy that does not exist.
const assert = require("assert");
const { createCloseoutReconciliation } = require("../src/economy/closeoutReconciliation");
const { createEconomicSnapshot } = require("../src/economy/economicSnapshot");
const fx = require("./fixtures/economicSnapshotStagingRows");
const { createMemorySelect } = require("./fixtures/postgrestMemorySelect");

let passed = 0;
const atest = async (name, fn) => {
  try { await fn(); passed += 1; }
  catch (error) { console.error(`FAIL: ${name}\n  ${error && error.message}`); process.exitCode = 1; }
};

// The certified Business Day window of 2026-08-20 (04:00 Madrid -> 04:00).
const DAY_FROM = "2026-08-20T02:00:00.000Z";
const DAY_TO = "2026-08-21T02:00:00.000Z";
const TZ = "Europe/Madrid";

// The real UAT cash count (ledger 98): 150.00 counted against 157.50 recorded.
const UAT_COUNT = Object.freeze({
  id: "77f010ad-d82f-49c5-8afd-633cadf4deb0",
  counted_at: "2026-08-21T15:43:01.033+00:00",
  actor: "owner", actor_role: "admin", workspace_id: "ws-1",
  counted_cash_cents: 15000, recorded_cash_receipts_cents: 15750, variance_cents: -750,
  window_from: DAY_FROM, window_to: DAY_TO, window_timezone: TZ, window_preset: "ayer",
  service_session_id: null, note: "UAT-CASH-COUNT-V1", client_request_id: "cash_uat_0001",
});

// A count over the SERVICE's interval, not the day's. It must never be used.
const SERVICE_SCOPED_COUNT = Object.freeze({
  ...UAT_COUNT,
  id: "aaaaaaaa-0000-4000-8000-000000000001",
  counted_at: "2026-08-21T16:00:00.000+00:00",
  counted_cash_cents: 8500, recorded_cash_receipts_cents: 8500, variance_cents: 0,
  window_from: "2026-08-20T17:06:44.405Z", window_to: "2026-08-21T02:00:00.000Z",
  window_preset: "servicio", note: "SERVICE-SCOPED-DO-NOT-MATCH", client_request_id: "cash_svc_0001",
});

function harness({ cashCounts = [], reconciliations = [], rpcImpl = null } = {}) {
  const reads = [];
  const rpcCalls = [];
  const store = reconciliations.slice();
  const select = createMemorySelect({
    // language-guard: allow-legacy storico is the existing archive table name in this fixture map, not new vocabulary
    ordenes: fx.ordenes, storico: fx.storico,
    order_financial_events: fx.events, service_sessions: fx.sessions,
    cash_counts: cashCounts, service_closeout_reconciliations: store,
  }, { onCall: (c) => reads.push(c) });

  const rpc = rpcImpl || (async (fn, args) => {
    rpcCalls.push({ fn, args });
    if (store.some((r) => r.closeout_correlation_id === args.p_closeout_correlation_id)) {
      const existing = store.find((r) => r.closeout_correlation_id === args.p_closeout_correlation_id);
      return { ok: true, body: { ok: true, created: false, reconciliation: existing } };
    }
    // Mirrors the RPC's own window-match refusal.
    if (args.p_cash_count_id) {
      const c = cashCounts.find((x) => x.id === args.p_cash_count_id);
      if (!c || new Date(c.window_from).getTime() !== new Date(args.p_window_from).getTime()
        || new Date(c.window_to).getTime() !== new Date(args.p_window_to).getTime()
        || c.window_timezone !== args.p_window_timezone) {
        return { ok: true, body: { ok: false, code: "RECONCILIATION_CASH_COUNT_WINDOW_MISMATCH" } };
      }
    }
    const row = {
      id: `rec-${store.length + 1}`, created_at: "2026-08-21T18:00:00.000Z",
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
  });

  const service = createCloseoutReconciliation({ select, rpc, snapshot: createEconomicSnapshot({ select }) });
  return { service, reads, rpcCalls, store };
}

const FORENSIC = fx.S.FORENSIC;

(async () => {
  // ── B/C/D/E — the two scopes ─────────────────────────────────────────────
  await atest("B · the window comes from the SERVICE's business_date, never today", async () => {
    const { service } = harness();
    const view = await service.build({ serviceSessionId: FORENSIC, now: new Date("2026-08-21T18:00:00Z") });
    // The service is stale by a day; reconciling "today" would report zeros.
    assert.strictEqual(view.businessDate, "2026-08-20");
    assert.strictEqual(view.reconciliation.window.from, DAY_FROM);
    assert.strictEqual(view.reconciliation.window.to, DAY_TO);
    assert.strictEqual(view.reconciliation.window.timezone, TZ);
    assert.ok(view.reconciliation.gross > 0, "and it therefore reports a real economy, not zeros");
  });

  await atest("D/E · the two scopes are separate, and neither is merged into the other", async () => {
    const { service } = harness();
    const v = await service.build({ serviceSessionId: FORENSIC });
    // SERVICE — the certified V3 closeout truth.
    assert.strictEqual(v.service.scope, "service");
    assert.strictEqual(v.service.orderCount, 5);
    assert.strictEqual(v.service.gross, 262.5);
    assert.strictEqual(v.service.collected, 262.5);
    assert.strictEqual(v.service.byMethod.efectivo, 85);
    assert.strictEqual(v.service.byMethod.tarjeta, 130);
    assert.strictEqual(v.service.byMethod.bizum, 47.5);
    assert.strictEqual(v.service.unpaid, 0);
    // DAY — the Business Day, spanning BOTH Operational Services.
    assert.strictEqual(v.reconciliation.scope, "business_day");
    assert.strictEqual(v.reconciliation.orderCount, 12);
    assert.strictEqual(v.reconciliation.gross, 406);
    assert.strictEqual(v.reconciliation.collected, 386.5);
    assert.strictEqual(v.reconciliation.cashReceipts, 157.5);
    assert.strictEqual(v.reconciliation.unpaid, 19.5);
    assert.strictEqual(v.reconciliation.voided, 10);
    assert.strictEqual(v.reconciliation.serviceCount, 2, "two services in one Business Day");
    // The whole point: they differ, and nothing adds them together.
    assert.notStrictEqual(v.service.byMethod.efectivo, v.reconciliation.cashReceipts);
    assert.strictEqual(v.service.gross + v.reconciliation.gross, 668.5,
      "sanity: the payload exposes both, and no field anywhere holds this sum");
  });

  // ── F/G/H/I — cash-count matching ────────────────────────────────────────
  await atest("F · a cash count over a DIFFERENT window is never compared", async () => {
    const { service } = harness({ cashCounts: [SERVICE_SCOPED_COUNT] });
    const v = await service.build({ serviceSessionId: FORENSIC });
    assert.strictEqual(v.cashCount, null, "the service-scoped count must not be picked up");
    assert.strictEqual(v.variance, null, "and NO variance may be computed from it");
    assert.strictEqual(v.cashCountCandidates, 0);
    // The trap this guards: 150.00 (day count) vs 85.00 (service cash) would
    // report -65.00 of missing money that never existed.
    assert.notStrictEqual(v.variance, -65);
  });

  await atest("G · a cash count over the EXACT window is accepted", async () => {
    const { service } = harness({ cashCounts: [UAT_COUNT] });
    const v = await service.build({ serviceSessionId: FORENSIC });
    assert.ok(v.cashCount, "the day-scoped count matches this window exactly");
    assert.strictEqual(v.cashCount.id, UAT_COUNT.id);
    assert.strictEqual(v.cashCount.windowMatchesExactly, true);
    assert.strictEqual(v.cashCount.countedCash, 150);
  });

  await atest("G2 · window equality is by INSTANT, not by string", async () => {
    // The same moment, serialized differently (+00:00 vs Z, fewer digits).
    const variant = { ...UAT_COUNT, window_from: "2026-08-20T02:00:00+00:00", window_to: "2026-08-21T02:00:00Z" };
    const { service } = harness({ cashCounts: [variant] });
    const v = await service.build({ serviceSessionId: FORENSIC });
    assert.ok(v.cashCount, "an equal instant written differently is still the same window");
    assert.strictEqual(v.variance, -7.5);
  });

  await atest("H · with several compatible counts the LATEST by counted_at wins, deterministically", async () => {
    const older = { ...UAT_COUNT, id: "bbbbbbbb-0000-4000-8000-000000000002", counted_at: "2026-08-21T10:00:00.000+00:00", counted_cash_cents: 10000, client_request_id: "cash_old_0001" };
    const newer = { ...UAT_COUNT, id: "cccccccc-0000-4000-8000-000000000003", counted_at: "2026-08-21T20:00:00.000+00:00", counted_cash_cents: 16000, client_request_id: "cash_new_0001" };
    for (const order of [[older, UAT_COUNT, newer], [newer, older, UAT_COUNT], [UAT_COUNT, newer, older]]) {
      const { service } = harness({ cashCounts: order });
      const v = await service.build({ serviceSessionId: FORENSIC });
      assert.strictEqual(v.cashCount.id, newer.id, "insertion order must not change the answer");
      assert.strictEqual(v.cashCount.countedCash, 160);
      assert.strictEqual(v.cashCountCandidates, 3, "and the operator is told there are three");
    }
  });

  await atest("I · no compatible count is a valid outcome, not a blocked one", async () => {
    const { service } = harness({ cashCounts: [] });
    const v = await service.build({ serviceSessionId: FORENSIC });
    assert.strictEqual(v.ok, true);
    assert.strictEqual(v.cashCount, null);
    assert.strictEqual(v.variance, null, "null, never 0 — 0 would assert an agreement nobody verified");
    assert.strictEqual(v.reconciliation.cashReceipts, 157.5, "the economy is still fully reported");
  });

  // ── J — variance ─────────────────────────────────────────────────────────
  await atest("J · variance is counted minus recorded, and is exact", async () => {
    const { service } = harness({ cashCounts: [UAT_COUNT] });
    const v = await service.build({ serviceSessionId: FORENSIC });
    assert.strictEqual(v.variance, -7.5, "150.00 counted - 157.50 recorded");
    assert.strictEqual(v.varianceSemantics, "counted_minus_recorded_receipts");
    assert.strictEqual(v.drawerMovementsModeled, false,
      "so this is not an accounting conclusion about a shortfall");
    // Sign is load-bearing: negative means the drawer held LESS than recorded.
    assert.ok(v.variance < 0);
  });

  await atest("J2 · an over-count is positive, and exact to the cent", async () => {
    const over = { ...UAT_COUNT, counted_cash_cents: 16025 };
    const { service } = harness({ cashCounts: [over] });
    const v = await service.build({ serviceSessionId: FORENSIC });
    assert.strictEqual(v.variance, 2.75, "160.25 - 157.50");
  });

  // ── K/L/M/N — it owns no money ───────────────────────────────────────────
  await atest("K/L/N · building a reconciliation writes nothing at all", async () => {
    const { service, reads, rpcCalls } = harness({ cashCounts: [UAT_COUNT] });
    await service.build({ serviceSessionId: FORENSIC });
    assert.strictEqual(rpcCalls.length, 0, "no RPC — no payment, refund, adjustment or cancellation");
    const tables = [...new Set(reads.map((r) => r.table))];
    for (const t of tables) {
      // N-2 — order_obligations joins this allowlist as a declared economic-fact
      // table: the canonical obligation ledger the reconciliation's own reader
      // now consults for gross. Still read-only, and this test's real assertion
      // (zero writes, zero RPC) is unchanged and still passing.
      // language-guard: allow-legacy storico is the existing archive table name in the allowed read set, not new vocabulary
      assert.ok(["ordenes", "storico", "order_financial_events", "order_obligations", "service_sessions", "cash_counts"].includes(t),
        `unexpected table read: ${t}`);
    }
  });

  await atest("M · persisting never touches the cash count row", async () => {
    const counts = [{ ...UAT_COUNT }];
    const frozen = JSON.stringify(counts[0]);
    const { service, rpcCalls } = harness({ cashCounts: counts });
    const out = await service.persist({ serviceSessionId: FORENSIC, closeoutCorrelationId: "corr-j1-1", actor: "owner" });
    assert.strictEqual(out.success, true);
    assert.strictEqual(JSON.stringify(counts[0]), frozen, "the count is referenced, never rewritten");
    assert.strictEqual(rpcCalls.length, 1, "exactly one write, and it is the reconciliation");
    assert.strictEqual(rpcCalls[0].fn, "create_service_closeout_reconciliation_v1");
  });

  await atest("persisted values are the DAY's, in cents, with the count attached", async () => {
    const { service, store } = harness({ cashCounts: [UAT_COUNT] });
    const out = await service.persist({ serviceSessionId: FORENSIC, closeoutCorrelationId: "corr-j1-2", actor: "owner" });
    const r = out.reconciliation;
    assert.strictEqual(r.gross, 406);
    assert.strictEqual(r.collected, 386.5);
    assert.strictEqual(r.cashReceipts, 157.5);
    assert.strictEqual(r.orderCount, 12);
    assert.strictEqual(r.serviceCount, 2);
    assert.strictEqual(r.cashCountId, UAT_COUNT.id);
    assert.strictEqual(r.countedCash, 150);
    assert.strictEqual(r.variance, -7.5);
    assert.strictEqual(r.businessDate, "2026-08-20");
    for (const key of ["gross_cents", "collected_cents", "cash_receipts_cents", "variance_cents"]) {
      assert.ok(Number.isInteger(store[0][key]), `${key} must be an integer cent value`);
    }
  });

  await atest("F2 · a mismatched count is never even SENT to the writer", async () => {
    const { service, rpcCalls } = harness({ cashCounts: [SERVICE_SCOPED_COUNT] });
    const out = await service.persist({ serviceSessionId: FORENSIC, closeoutCorrelationId: "corr-j1-3", actor: "owner" });
    assert.strictEqual(out.success, true, "the close still proceeds — a missing count never blocks it");
    assert.strictEqual(rpcCalls[0].args.p_cash_count_id, null);
    assert.strictEqual(rpcCalls[0].args.p_counted_cash_cents, null);
    assert.strictEqual(out.reconciliation.variance, null);
  });

  // ── O — idempotency ──────────────────────────────────────────────────────
  await atest("O · a retry on the same correlation id creates ONE reconciliation", async () => {
    const { service, store } = harness({ cashCounts: [UAT_COUNT] });
    const a = await service.persist({ serviceSessionId: FORENSIC, closeoutCorrelationId: "corr-retry", actor: "owner" });
    const b = await service.persist({ serviceSessionId: FORENSIC, closeoutCorrelationId: "corr-retry", actor: "owner" });
    const c = await service.persist({ serviceSessionId: FORENSIC, closeoutCorrelationId: "corr-retry", actor: "owner" });
    assert.strictEqual(a.created, true);
    assert.strictEqual(b.created, false);
    assert.strictEqual(c.created, false);
    assert.strictEqual(store.length, 1, "one row, three calls");
    assert.strictEqual(b.reconciliation.id, a.reconciliation.id);
  });

  // ── P — fail closed ──────────────────────────────────────────────────────
  await atest("P · a refused write is reported as failure, never as a false success", async () => {
    const { service, store } = harness({
      cashCounts: [UAT_COUNT],
      rpcImpl: async () => ({ ok: true, body: { ok: false, code: "RECONCILIATION_CLOSEOUT_NOT_FOUND" } }),
    });
    const out = await service.persist({ serviceSessionId: FORENSIC, closeoutCorrelationId: "corr-fail", actor: "owner" });
    assert.strictEqual(out.success, false);
    assert.strictEqual(out.code, "RECONCILIATION_CLOSEOUT_NOT_FOUND");
    assert.strictEqual(out.reconciliation, undefined);
    assert.strictEqual(store.length, 0);
  });

  await atest("P2 · a transport failure is reported as failure, never swallowed", async () => {
    const { service } = harness({
      cashCounts: [UAT_COUNT],
      rpcImpl: async () => { throw new Error("network down"); },
    });
    const out = await service.persist({ serviceSessionId: FORENSIC, closeoutCorrelationId: "corr-boom", actor: "owner" });
    assert.strictEqual(out.success, false);
    assert.strictEqual(out.code, "RECONCILIATION_PERSIST_TRANSPORT_ERROR");
  });

  await atest("a service with no business_date is refused, never guessed from the clock", async () => {
    const { service } = harness();
    assert.throws(
      () => service.windowForService({ id: "x", business_date: null }),
      (e) => e.code === "RECONCILIATION_BUSINESS_DATE_MISSING",
      "reconciling a service whose day is unknown must refuse, not substitute today",
    );
  });

  await atest("an unknown service is a 404, not an empty reconciliation", async () => {
    const { service } = harness();
    await assert.rejects(
      () => service.build({ serviceSessionId: "00000000-0000-4000-8000-000000000000" }),
      (e) => e.code === "RECONCILIATION_SESSION_NOT_FOUND" && e.status === 404,
    );
  });

  await atest("with no id, the preflight resolves THE active service and says which", async () => {
    const { service } = harness({ cashCounts: [UAT_COUNT] });
    const v = await service.build({});
    // The fixture's only open service is the preserved forensic one.
    assert.strictEqual(v.serviceSessionId, FORENSIC);
    assert.strictEqual(v.status, "open");
    assert.strictEqual(v.service.gross, 262.5, "and it describes THAT service, not another");
    assert.strictEqual(v.reconciliation.gross, 406);
  });

  await atest("no active service is refused with a typed code, never guessed", async () => {
    const closedOnly = fx.sessions.map((s) => ({ ...s, status: "closed" }));
    const select = createMemorySelect({
      // language-guard: allow-legacy storico is the existing archive table name in this fixture map, not new vocabulary
      ordenes: fx.ordenes, storico: fx.storico, order_financial_events: fx.events,
      service_sessions: closedOnly, cash_counts: [], service_closeout_reconciliations: [],
    });
    const svc = createCloseoutReconciliation({ select, rpc: async () => ({ ok: true, body: { ok: true } }), snapshot: createEconomicSnapshot({ select }) });
    await assert.rejects(() => svc.build({}), (e) => e.code === "RECONCILIATION_NO_ACTIVE_SERVICE" && e.status === 409);
  });

  console.log(`closeoutReconciliation: ${passed} passed`);
})();
