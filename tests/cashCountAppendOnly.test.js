"use strict";
// I-1 — Cash Count V1: attribution, append-only, and lifecycle independence.
const assert = require("assert");
const { createCashCountService, CashCountError, toCents } = require("../src/economy/cashCountService");
const { createEconomicSnapshot } = require("../src/economy/economicSnapshot");
const fx = require("./fixtures/economicSnapshotStagingRows");
const { createMemorySelect } = require("./fixtures/postgrestMemorySelect");

let passed = 0;
const atest = async (name, fn) => {
  try { await fn(); passed += 1; }
  catch (error) { console.error(`FAIL: ${name}\n  ${error && error.message}`); process.exitCode = 1; }
};

const NOW = new Date("2026-08-21T12:00:00.000Z");
const OWNER = Object.freeze({ actor: "owner", role: "admin", workspaceId: "ws-1", sessionVersion: 3 });

// A harness that records EVERY table touched and every write attempted, so a
// test can assert not just what the service did but what it never went near.
function harness({ rows = [] } = {}) {
  const store = rows.slice();
  const reads = [];
  const writes = [];
  const select = createMemorySelect(
    // language-guard: allow-legacy storico is the existing archive table name in this fixture map, not new vocabulary
    { ordenes: fx.ordenes, storico: fx.storico, order_financial_events: fx.events, service_sessions: fx.sessions, cash_counts: store },
    { onCall: (c) => reads.push(c) },
  );
  const insert = async (table, payload) => {
    writes.push({ table, payload });
    if (store.some((r) => r.client_request_id === payload.client_request_id)) {
      throw Object.assign(new Error("duplicate key"), { code: "23505" });
    }
    const row = { id: `cc-${store.length + 1}`, created_at: NOW.toISOString(), ...payload };
    store.push(row);
    return [row];
  };
  const service = createCashCountService({ select, insert, snapshot: createEconomicSnapshot({ select }) });
  return { service, store, reads, writes };
}

const EVENING = { preset: "personalizado", from: "2026-08-20T17:06:44.000Z", to: "2026-08-20T20:00:00.000Z" };

(async () => {
  await atest("the recorded comparison figure is the window's own cash receipts", async () => {
    const { service } = harness();
    const out = await service.create({
      context: OWNER, ...EVENING, countedCash: 80, clientRequestId: "uat-cash-count-0001", now: NOW,
    });
    assert.strictEqual(out.created, true);
    // 85.00 EUR of cash was RECORDED in this window (10 + 30 + 45), certified
    // by PRE_CLOSE_ECONOMIC_TRUTH_480ECA89.
    assert.strictEqual(out.count.recordedCashReceipts, 85);
    assert.strictEqual(out.count.countedCash, 80);
    assert.strictEqual(out.count.variance, -5, "counted minus recorded, nothing else");
  });

  await atest("a count is attributed to the TOKEN's actor, never to the request body", async () => {
    const { service, writes } = harness();
    const out = await service.create({
      context: OWNER, ...EVENING, countedCash: 85, clientRequestId: "attribution-test-1", now: NOW,
      // A hostile or buggy client naming someone else must change nothing.
      actor: "someone_else", actor_role: "owner", workspace_id: "ws-evil",
    });
    assert.strictEqual(out.count.actor, "owner");
    assert.strictEqual(out.count.actorRole, "admin");
    assert.strictEqual(writes[0].payload.workspace_id, "ws-1");
    assert.strictEqual(writes[0].payload.actor, "owner");
  });

  await atest("an unauthenticated caller cannot record a count", async () => {
    const { service, writes } = harness();
    for (const bad of [undefined, null, {}, { actor: "x" }, { actor: "x", role: "admin" }]) {
      await assert.rejects(
        () => service.create({ context: bad, ...EVENING, countedCash: 10, clientRequestId: "unauth-0001", now: NOW }),
        (e) => e instanceof CashCountError && e.code === "ECONOMY_UNAUTHENTICATED" && e.status === 401,
      );
    }
    assert.strictEqual(writes.length, 0, "and nothing was written while trying");
  });

  await atest("the count itself is validated, not trusted", async () => {
    const { service } = harness();
    const bad = [
      ["not a number", "ECONOMY_CASH_COUNT_INVALID"],
      [NaN, "ECONOMY_CASH_COUNT_INVALID"],
      [-1, "ECONOMY_CASH_COUNT_OUT_OF_RANGE"],
      [99999999999, "ECONOMY_CASH_COUNT_OUT_OF_RANGE"],
    ];
    for (const [value, code] of bad) {
      await assert.rejects(
        () => service.create({ context: OWNER, ...EVENING, countedCash: value, clientRequestId: "validation-0001", now: NOW }),
        (e) => e.code === code, `countedCash=${String(value)}`,
      );
    }
    await assert.rejects(
      () => service.create({ context: OWNER, ...EVENING, countedCash: 10, clientRequestId: "short", now: NOW }),
      (e) => e.code === "ECONOMY_CLIENT_REQUEST_ID_INVALID",
    );
  });

  await atest("a double-tapped Confirmar records ONE count, not two", async () => {
    const { service, store } = harness();
    const a = await service.create({ context: OWNER, ...EVENING, countedCash: 80, clientRequestId: "idem-0001", now: NOW });
    const b = await service.create({ context: OWNER, ...EVENING, countedCash: 80, clientRequestId: "idem-0001", now: NOW });
    assert.strictEqual(a.created, true);
    assert.strictEqual(b.created, false, "the second call created nothing");
    assert.strictEqual(b.count.id, a.count.id, "and returned the first count");
    assert.strictEqual(store.length, 1);
  });

  await atest("history is read-only: the service exposes no update and no delete", async () => {
    const { service } = harness();
    assert.deepStrictEqual(Object.keys(service).sort(), ["create", "list"],
      "a cash-count service that can rewrite history is the wrong service");
    for (const forbidden of ["update", "delete", "remove", "amend", "void"]) {
      assert.strictEqual(service[forbidden], undefined, `service.${forbidden} must not exist`);
    }
  });

  await atest("an earlier count is untouched by a later corrective one", async () => {
    const { service, store, writes } = harness();
    const first = await service.create({ context: OWNER, ...EVENING, countedCash: 80, clientRequestId: "history-0001", now: NOW });
    const frozen = JSON.stringify(store[0]);
    const second = await service.create({
      context: OWNER, ...EVENING, countedCash: 85, clientRequestId: "history-0002",
      note: "correccion del conteo anterior", now: new Date("2026-08-21T12:30:00.000Z"),
    });
    assert.strictEqual(JSON.stringify(store[0]), frozen, "the first row is byte-identical");
    assert.strictEqual(store.length, 2, "the correction is a NEW fact");
    assert.strictEqual(first.count.variance, -5);
    assert.strictEqual(second.count.variance, 0);
    assert.ok(writes.every((w) => w.table === "cash_counts"), "and only ever inserted into its own table");
    const history = await service.list({ context: OWNER, limit: 10 });
    assert.strictEqual(history.counts.length, 2);
    assert.strictEqual(history.counts[0].note, "correccion del conteo anterior", "newest first");
  });

  await atest("recording a count writes to cash_counts and to nothing else", async () => {
    const { service, reads, writes } = harness();
    await service.create({ context: OWNER, ...EVENING, countedCash: 85, clientRequestId: "isolation-0001", now: NOW });
    assert.deepStrictEqual([...new Set(writes.map((w) => w.table))], ["cash_counts"]);
    // Every table it READ is a declared economic-fact table. Nothing lifecycle.
    const readTables = [...new Set(reads.map((r) => r.table))];
    for (const t of readTables) {
      // language-guard: allow-legacy storico is the existing archive table name in the allowed read set, not new vocabulary
      assert.ok(["ordenes", "storico", "order_financial_events", "service_sessions", "cash_counts"].includes(t),
        `unexpected table: ${t}`);
    }
    // service_sessions is read for PROVENANCE (business_date, kind fallback)
    // only, and only ever with a plain id filter — never a status transition.
    for (const r of reads.filter((x) => x.table === "service_sessions")) {
      assert.ok(/^(id=|select=)/.test(r.query) || r.query.includes("id=in.") || r.query.includes("id=eq."),
        `service_sessions must only be read by id, got: ${r.query}`);
    }
  });

  await atest("the window the operator saw is stored verbatim with the count", async () => {
    const { service } = harness();
    const out = await service.create({ context: OWNER, ...EVENING, countedCash: 85, clientRequestId: "window-0001", now: NOW });
    assert.strictEqual(out.count.window.from, "2026-08-20T17:06:44.000Z");
    assert.strictEqual(out.count.window.to, "2026-08-20T20:00:00.000Z");
    assert.strictEqual(out.count.window.timezone, "Europe/Madrid");
    assert.strictEqual(out.count.window.preset, "personalizado");
    assert.strictEqual(out.count.snapshotContext.receipts.collected, 262.5,
      "and enough context to re-read the count years later");
  });

  await atest("money is stored as integer cents, never as a float", async () => {
    const { service, writes } = harness();
    await service.create({ context: OWNER, ...EVENING, countedCash: 84.55, clientRequestId: "cents-0001", now: NOW });
    const p = writes[0].payload;
    for (const key of ["counted_cash_cents", "recorded_cash_receipts_cents", "variance_cents"]) {
      assert.ok(Number.isInteger(p[key]), `${key} must be an integer, got ${p[key]}`);
    }
    assert.strictEqual(p.counted_cash_cents, 8455);
    assert.strictEqual(p.recorded_cash_receipts_cents, 8500);
    assert.strictEqual(p.variance_cents, -45);
    assert.strictEqual(p.variance_cents, p.counted_cash_cents - p.recorded_cash_receipts_cents,
      "matching the CHECK constraint the table enforces");
    assert.strictEqual(toCents(0.1 + 0.2), 30, "and no float residue survives the conversion");
  });

  console.log(`cashCountAppendOnly: ${passed} passed`);
})();
