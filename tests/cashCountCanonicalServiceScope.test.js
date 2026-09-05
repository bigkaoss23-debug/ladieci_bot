"use strict";
// CASH COUNT — CANONICAL SERVICE ATTRIBUTION (writer) + CANONICAL SCOPE (reader).
//
// WRITER: a "count now" (preset hoy) is attributed to the canonical current
// Operational Service, resolved BY THE BACKEND, and persisted in the existing
// nullable, FK-free `service_session_id` column — pure provenance. It never
// gates, delays or fails the count; window_* and the recorded figure are
// untouched, so closeoutReconciliation's exact-window matching is unaffected.
//
// READER: `list` gains the SAME scope shape as /pendencies. A bare call is
// byte-for-byte the old behaviour. `servicio` is an EXACT identity match on the
// count's own service_session_id — never a timestamp overlap — so a legacy
// NULL-attribution row is correctly not fabricated in.
const assert = require("assert");
const {
  createCashCountService, CashCountError, resolveCashCountListScope,
} = require("../src/economy/cashCountService");
const { createMemorySelect } = require("./fixtures/postgrestMemorySelect");

let passed = 0;
const atest = async (name, fn) => {
  try { await fn(); passed += 1; }
  catch (error) { console.error(`FAIL: ${name}\n  ${error && error.message}`); process.exitCode = 1; }
};

const NOW = new Date("2026-09-05T12:00:00.000Z");
const OWNER = Object.freeze({ actor: "owner", role: "admin", workspaceId: "ws-1" });

// A stub snapshot: the writer only ever reads view.window.* , view.receipts,
// view.obligation, view.counts and view.windowCrossing.*.length . Giving it a
// fixed shape keeps this test about ATTRIBUTION, not about the snapshot reader
// (which has its own suite).
function stubSnapshot({ efectivo = 100, serviceSessionId = null } = {}) {
  return async ({ preset = "hoy", from, to } = {}) => ({
    window: {
      from: from || "2026-09-05T02:00:00.000Z",
      to: to || "2026-09-06T02:00:00.000Z",
      timezone: "Europe/Madrid",
      preset,
      serviceSessionId,
      generatedAt: NOW.toISOString(),
      asOf: NOW.toISOString(),
    },
    receipts: { byMethod: { efectivo } },
    obligation: { gross: 0, unpaid: 0, voided: 0, refunded: 0 },
    counts: { obligations: 0 },
    windowCrossing: {
      obligationBeforeWindowReceiptInside: [],
      obligationInsideWindowReceiptAfter: [],
      receiptsSplitAcrossBoundary: [],
    },
  });
}

function harness({ cashRows = [], sessionRows = [], currentService, efectivo = 100, snapServiceSessionId = null } = {}) {
  const store = cashRows.slice();
  const reads = [];
  const writes = [];
  const select = createMemorySelect(
    { cash_counts: store, service_sessions: sessionRows },
    { onCall: (c) => reads.push(c) },
  );
  const insert = async (table, payload) => {
    writes.push({ table, payload });
    const row = { id: `cc-${store.length + 1}`, created_at: NOW.toISOString(), ...payload };
    store.push(row);
    return [row];
  };
  const service = createCashCountService({
    select, insert,
    snapshot: stubSnapshot({ efectivo, serviceSessionId: snapServiceSessionId }),
    getCurrentService: currentService === undefined
      ? async () => ({ id: "svc-current", business_date: "2026-09-05", status: "open" })
      : currentService,
  });
  return { service, store, reads, writes };
}

const RID = (s) => `${s}-req-000001`;

(async () => {

  // ════════ WRITER — SERVICE ATTRIBUTION ════════

  await atest("preset hoy · a new count is attributed to the backend-resolved current service", async () => {
    const { service, writes } = harness();
    const out = await service.create({ context: OWNER, preset: "hoy", countedCash: 100, clientRequestId: RID("a"), now: NOW });
    assert.strictEqual(out.created, true);
    assert.strictEqual(writes[0].payload.service_session_id, "svc-current");
    assert.strictEqual(out.count.serviceSessionId, "svc-current");
  });

  await atest("preset hoy · the client cannot name the service — a body serviceSessionId is ignored, the backend decides", async () => {
    const { service, writes } = harness();
    await service.create({
      context: OWNER, preset: "hoy", serviceSessionId: "svc-client-claims", countedCash: 100,
      clientRequestId: RID("b"), now: NOW,
    });
    assert.strictEqual(writes[0].payload.service_session_id, "svc-current",
      "the backend-resolved current service wins over a client claim");
  });

  await atest("multiple counts in the same service all carry the same canonical id", async () => {
    const { service, store } = harness();
    await service.create({ context: OWNER, preset: "hoy", countedCash: 90, clientRequestId: RID("c1"), now: NOW });
    await service.create({ context: OWNER, preset: "hoy", countedCash: 110, clientRequestId: RID("c2"), now: new Date("2026-09-05T13:00:00Z") });
    assert.strictEqual(store.length, 2);
    assert.deepStrictEqual([...new Set(store.map((r) => r.service_session_id))], ["svc-current"]);
  });

  await atest("a subsequent service gets a new id — attribution follows the pointer, not the row", async () => {
    let current = { id: "svc-first", business_date: "2026-09-05", status: "open" };
    const { service, store } = harness({ currentService: async () => current });
    await service.create({ context: OWNER, preset: "hoy", countedCash: 100, clientRequestId: RID("d1"), now: NOW });
    current = { id: "svc-second", business_date: "2026-09-05", status: "open" };
    await service.create({ context: OWNER, preset: "hoy", countedCash: 100, clientRequestId: RID("d2"), now: new Date("2026-09-05T20:00:00Z") });
    assert.deepStrictEqual(store.map((r) => r.service_session_id), ["svc-first", "svc-second"]);
  });

  await atest("no current service · the count STILL records, with service_session_id NULL (lifecycle-independent)", async () => {
    const { service, writes } = harness({ currentService: async () => null });
    const out = await service.create({ context: OWNER, preset: "hoy", countedCash: 100, clientRequestId: RID("e"), now: NOW });
    assert.strictEqual(out.created, true, "a cash count has never required an open service");
    assert.strictEqual(writes[0].payload.service_session_id, null);
  });

  await atest("the current-service resolve throwing NEVER fails the count", async () => {
    const { service, writes } = harness({ currentService: async () => { throw new Error("SERVICE_SESSION_READ_FAILED"); } });
    const out = await service.create({ context: OWNER, preset: "hoy", countedCash: 100, clientRequestId: RID("f"), now: NOW });
    assert.strictEqual(out.created, true);
    assert.strictEqual(writes[0].payload.service_session_id, null);
  });

  await atest("a HISTORICAL window (ayer / personalizado) is NOT attributed to today's service", async () => {
    const { service, store } = harness();
    await service.create({ context: OWNER, preset: "ayer", countedCash: 100, clientRequestId: RID("g1"), now: NOW });
    await service.create({
      context: OWNER, preset: "personalizado",
      from: "2026-09-01T10:00:00Z", to: "2026-09-01T14:00:00Z",
      countedCash: 100, clientRequestId: RID("g2"), now: NOW,
    });
    assert.deepStrictEqual(store.map((r) => r.service_session_id), [null, null],
      "there is no such thing as physically counting yesterday's drawer under today's service");
  });

  await atest("preset servicio · the snapshot's own window session is used, not the current-service pointer", async () => {
    const { service, writes } = harness({ snapServiceSessionId: "svc-from-window" });
    await service.create({
      context: OWNER, preset: "servicio", serviceSessionId: "svc-from-window",
      countedCash: 100, clientRequestId: RID("h"), now: NOW,
    });
    assert.strictEqual(writes[0].payload.service_session_id, "svc-from-window");
  });

  await atest("attribution does NOT disturb window_* or the recorded figure (closeoutReconciliation compatibility)", async () => {
    const withSvc = harness();
    const withoutSvc = harness({ currentService: async () => null });
    const a = await withSvc.service.create({ context: OWNER, preset: "hoy", countedCash: 80, clientRequestId: RID("i1"), now: NOW });
    const b = await withoutSvc.service.create({ context: OWNER, preset: "hoy", countedCash: 80, clientRequestId: RID("i2"), now: NOW });
    for (const k of ["window_from", "window_to", "window_timezone", "window_preset", "recorded_cash_receipts_cents", "variance_cents"]) {
      assert.strictEqual(withSvc.writes[0].payload[k], withoutSvc.writes[0].payload[k], `${k} must be identical with/without attribution`);
    }
    assert.strictEqual(a.count.variance, b.count.variance);
    assert.strictEqual(a.count.variance, -20, "80 counted - 100 recorded");
  });

  await atest("recording a count still writes to cash_counts and nothing else", async () => {
    const { service, writes } = harness();
    await service.create({ context: OWNER, preset: "hoy", countedCash: 100, clientRequestId: RID("j"), now: NOW });
    assert.deepStrictEqual([...new Set(writes.map((w) => w.table))], ["cash_counts"]);
  });

  await atest("idempotency survives — a double-tap with attribution records ONE row", async () => {
    const { service, store } = harness();
    const a = await service.create({ context: OWNER, preset: "hoy", countedCash: 100, clientRequestId: RID("k"), now: NOW });
    const b = await service.create({ context: OWNER, preset: "hoy", countedCash: 100, clientRequestId: RID("k"), now: NOW });
    assert.strictEqual(a.created, true);
    assert.strictEqual(b.created, false);
    assert.strictEqual(store.length, 1);
    assert.strictEqual(b.count.serviceSessionId, "svc-current");
  });

  // ════════ READER — CANONICAL SCOPE ════════

  const SVC_A = "11111111-1111-1111-1111-111111111111";
  const SVC_B = "22222222-2222-2222-2222-222222222222";
  const listRows = [
    // Two counts attributed to service A, one clean one not.
    { id: "r1", counted_at: "2026-09-05T10:00:00Z", actor: "laura", actor_role: "admin",
      counted_cash_cents: 5000, recorded_cash_receipts_cents: 5000, variance_cents: 0,
      window_from: "2026-09-05T02:00:00Z", window_to: "2026-09-06T02:00:00Z",
      window_timezone: "Europe/Madrid", window_preset: "hoy", service_session_id: SVC_A,
      snapshot_context: {}, note: null, client_request_id: "r1-req-000001", created_at: "2026-09-05T10:00:00Z" },
    { id: "r2", counted_at: "2026-09-05T16:00:00Z", actor: "mario", actor_role: "admin",
      counted_cash_cents: 4250, recorded_cash_receipts_cents: 5000, variance_cents: -750,
      window_from: "2026-09-05T02:00:00Z", window_to: "2026-09-06T02:00:00Z",
      window_timezone: "Europe/Madrid", window_preset: "hoy", service_session_id: SVC_A,
      snapshot_context: {}, note: "faltan monedas", client_request_id: "r2-req-000001", created_at: "2026-09-05T16:00:00Z" },
    // One count attributed to service B, same business day.
    { id: "r3", counted_at: "2026-09-05T20:00:00Z", actor: "laura", actor_role: "admin",
      counted_cash_cents: 3000, recorded_cash_receipts_cents: 3000, variance_cents: 0,
      window_from: "2026-09-05T02:00:00Z", window_to: "2026-09-06T02:00:00Z",
      window_timezone: "Europe/Madrid", window_preset: "hoy", service_session_id: SVC_B,
      snapshot_context: {}, note: null, client_request_id: "r3-req-000001", created_at: "2026-09-05T20:00:00Z" },
    // A LEGACY row: real count, but NULL attribution. Timestamps put it inside
    // service A's hours — a temporal proxy would wrongly claim it.
    { id: "r4", counted_at: "2026-09-05T11:00:00Z", actor: "old", actor_role: "admin",
      counted_cash_cents: 9999, recorded_cash_receipts_cents: 9999, variance_cents: 0,
      window_from: "2026-09-05T02:00:00Z", window_to: "2026-09-06T02:00:00Z",
      window_timezone: "Europe/Madrid", window_preset: "hoy", service_session_id: null,
      snapshot_context: {}, note: null, client_request_id: "r4-req-000001", created_at: "2026-09-05T11:00:00Z" },
    // A count from the PREVIOUS business day.
    { id: "r5", counted_at: "2026-09-04T18:00:00Z", actor: "mario", actor_role: "admin",
      counted_cash_cents: 2000, recorded_cash_receipts_cents: 2000, variance_cents: 0,
      window_from: "2026-09-04T02:00:00Z", window_to: "2026-09-05T02:00:00Z",
      window_timezone: "Europe/Madrid", window_preset: "hoy", service_session_id: null,
      snapshot_context: {}, note: null, client_request_id: "r5-req-000001", created_at: "2026-09-04T18:00:00Z" },
  ];
  const listSessions = [
    { id: SVC_A, business_date: "2026-09-05", status: "closed", opened_at: "2026-09-05T08:00:00Z", closed_at: "2026-09-05T18:00:00Z" },
    { id: SVC_B, business_date: "2026-09-05", status: "closed", opened_at: "2026-09-05T18:30:00Z", closed_at: "2026-09-05T23:30:00Z" },
  ];
  const listHarness = () => harness({ cashRows: listRows, sessionRows: listSessions });

  await atest("bare list (no preset) is unchanged — every row, newest first, no scope echo", async () => {
    const { service } = listHarness();
    const r = await service.list({ context: OWNER, limit: 50 });
    assert.strictEqual(r.scope, null);
    assert.strictEqual(r.window, null);
    assert.strictEqual(r.counts.length, 5);
    assert.strictEqual(r.counts[0].id, "r3", "2026-09-05T20:00 is newest");
  });

  await atest("preset hoy · counted_at within the 2026-09-05 business day", async () => {
    const { service } = listHarness();
    const r = await service.list({ context: OWNER, preset: "hoy", now: NOW });
    assert.deepStrictEqual(r.scope, { preset: "hoy", businessDate: "2026-09-05" });
    assert.strictEqual(r.window.from, "2026-09-05T02:00:00.000Z");
    const ids = r.counts.map((c) => c.id).sort();
    assert.deepStrictEqual(ids, ["r1", "r2", "r3", "r4"], "r5 (previous day) excluded");
  });

  await atest("preset ayer · the previous business day", async () => {
    const { service } = listHarness();
    const r = await service.list({ context: OWNER, preset: "ayer", now: NOW });
    assert.deepStrictEqual(r.counts.map((c) => c.id), ["r5"]);
  });

  await atest("preset personalizado · explicit half-open on counted_at", async () => {
    const { service } = listHarness();
    const r = await service.list({
      context: OWNER, preset: "personalizado",
      from: "2026-09-05T09:00:00Z", to: "2026-09-05T16:00:00Z", now: NOW,
    });
    // [09:00, 16:00): r1 (10:00) and r4 (11:00). r2 is exactly 16:00 -> excluded.
    assert.deepStrictEqual(r.counts.map((c) => c.id).sort(), ["r1", "r4"]);
  });

  await atest("preset servicio · EXACT service_session_id match — legacy NULL rows are never fabricated in", async () => {
    const { service } = listHarness();
    const r = await service.list({ context: OWNER, preset: "servicio", serviceSessionId: SVC_A, now: NOW });
    assert.deepStrictEqual(r.scope, { preset: "servicio", serviceSessionId: SVC_A, businessDate: "2026-09-05" });
    const ids = r.counts.map((c) => c.id).sort();
    assert.deepStrictEqual(ids, ["r1", "r2"], "only rows STAMPED with SVC_A; r4 (NULL, same hours) is NOT invented in");
  });

  await atest("preset servicio · two same-day services do not leak into each other", async () => {
    const { service } = listHarness();
    const a = await service.list({ context: OWNER, preset: "servicio", serviceSessionId: SVC_A, now: NOW });
    const b = await service.list({ context: OWNER, preset: "servicio", serviceSessionId: SVC_B, now: NOW });
    assert.deepStrictEqual(a.counts.map((c) => c.id).sort(), ["r1", "r2"]);
    assert.deepStrictEqual(b.counts.map((c) => c.id), ["r3"]);
  });

  await atest("preset servicio · the discrepancy row is present so a summary can still warn", async () => {
    const { service } = listHarness();
    const r = await service.list({ context: OWNER, preset: "servicio", serviceSessionId: SVC_A, now: NOW });
    const nonZero = r.counts.filter((c) => Math.round(c.variance * 100) !== 0);
    assert.strictEqual(nonZero.length, 1, "r2 has a -7,50 variance");
    assert.strictEqual(nonZero[0].id, "r2");
  });

  // ── reader refusals ──
  const rejectsList = async (params, code, status) => {
    await assert.rejects(() => listHarness().service.list({ context: OWNER, now: NOW, ...params }), (e) => {
      assert.ok(e instanceof CashCountError);
      assert.strictEqual(e.code, code);
      if (status) assert.strictEqual(e.status, status);
      return true;
    });
  };

  await atest("reader REFUSAL · servicio without id / id without servicio / unknown preset", async () => {
    await rejectsList({ preset: "servicio" }, "ECONOMY_CASH_COUNT_SERVICE_SESSION_REQUIRED");
    await rejectsList({ preset: "hoy", serviceSessionId: SVC_A }, "ECONOMY_CASH_COUNT_SCOPE_INVALID");
    await rejectsList({ serviceSessionId: SVC_A }, "ECONOMY_CASH_COUNT_SCOPE_INVALID");
    await rejectsList({ preset: "mediodia" }, "ECONOMY_CASH_COUNT_SCOPE_INVALID");
    await rejectsList({ preset: "servicio", serviceSessionId: "no-such-session" }, "ECONOMY_CASH_COUNT_SERVICE_NOT_FOUND", 404);
  });

  await atest("resolveCashCountListScope · a 'window' scope carries economicWindow's own instants verbatim", async () => {
    const { resolveEconomicWindow } = require("../src/economy/economicWindow");
    const canonical = resolveEconomicWindow({ preset: "ayer", now: NOW });
    const scope = await resolveCashCountListScope({ select: async () => [], preset: "ayer", now: NOW });
    assert.strictEqual(scope.from, canonical.from);
    assert.strictEqual(scope.to, canonical.to);
    assert.strictEqual(scope.windowEcho.timezone, "Europe/Madrid");
  });

  console.log(`cashCountCanonicalServiceScope: ${passed} passed`);
})();
