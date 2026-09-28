"use strict";
// POST-FINAL-BLIND M-1 — Pendientes reads its WHOLE population, whatever its size and whatever row cap the provider applies.
// The frozen reader asked for `ordenes?order=created_at.asc&limit=5000` once: past 5000 rows the NEWEST orders — and their real
// exposures — were silently dropped (reproduced on PostgreSQL 17 with 5001 / 5051 rows). This file drives the reader through a small
// keyset-capable PostgREST stand-in (eq / in / gt, order, limit, an optional provider cap) and proves:
//   1. an unpaid order that is the NEWEST of > 2 pages of rows is a POR_COBRAR, the OLDEST unpaid one too, an over-collected one a POR_DEVOLVER;
//   2. the same holds when the provider caps every response far below the page size (db-max-rows);
//   3. a display id whose events exceed one page is summed completely;
//   4. no request carries a fixed ceiling (limit=5000 / limit=20000) or a created_at sort on the population reads;
//   5. a select that ignores the cursor cannot make the reader loop or duplicate rows.
// Run: node tests/pendingExposuresCompleteRead.test.js
const assert = require("assert");
const { createPendingExposures } = require("../src/economy/pendingExposures");

let passed = 0;
const atest = async (name, fn) => {
  try { await fn(); passed += 1; console.log("  ✓ " + name); }
  catch (error) { console.error(`FAIL: ${name}\n  ${error && error.message}`); process.exitCode = 1; }
};

const WORKSPACE = "ws-authenticated";
const SS_OLD = "ss-closed";
const NOW = new Date("2026-09-27T12:00:00.000Z");
const PICKUP = Object.freeze({ tipo_consegna: "RITIRO" }); // language-guard: allow-legacy tipo_consegna/RITIRO are the existing ordenes column/literal, not new vocabulary

// A keyset-capable stand-in: filters are applied, then ORDER, then LIMIT (PostgREST semantics), then the provider cap.
const cmp = (a, b) => {
  const na = typeof a === "number" || /^-?\d+$/.test(String(a)); const nb = typeof b === "number" || /^-?\d+$/.test(String(b));
  if (na && nb) return Number(a) - Number(b);
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
};
function createKeysetSelect(tables, { cap = 0, ignoreCursor = false, calls = [] } = {}) {
  return async function select(table, query = "") {
    calls.push({ table, query });
    let rows = (tables[table] || []).slice();
    let order = null; let limit = Infinity;
    for (const part of String(query).split("&").filter(Boolean)) {
      if (part.startsWith("select=")) continue;
      const i = part.indexOf("="); const col = part.slice(0, i); const rest = part.slice(i + 1);
      if (col === "order") { const [c, dir] = rest.split("."); order = { c, desc: dir === "desc" }; continue; }
      if (col === "limit") { limit = Number(rest); continue; }
      const d = rest.indexOf("."); const op = rest.slice(0, d); const raw = decodeURIComponent(rest.slice(d + 1));
      if (op === "eq") rows = rows.filter((r) => String(r[col]) === raw);
      else if (op === "in") { const set = new Set(raw.replace(/^\(|\)$/g, "").split(",")); rows = rows.filter((r) => set.has(String(r[col]))); }
      else if (op === "gt") { if (!ignoreCursor) rows = rows.filter((r) => r[col] != null && cmp(r[col], raw) > 0); }
      else throw new Error(`unsupported operator ${op} on ${table}.${col}`);
    }
    if (order) { rows.sort((a, b) => cmp(a[order.c], b[order.c])); if (order.desc) rows.reverse(); }
    rows = rows.slice(0, limit);
    if (cap) rows = rows.slice(0, cap);
    return rows;
  };
}

function dataset(historical) {
  const t = (i) => new Date(Date.UTC(2026, 7, 1) + i * 60000).toISOString();
  const orders = [{ id: "#OLD", order_uid: "uid-old", service_session_id: SS_OLD, table_session_id: null, estado: "RETIRADO", totale: 13, ...PICKUP, nombre: "Old", tel: "600000001", created_at: t(0) }];
  for (let i = 1; i <= historical; i += 1) {
    orders.push({ id: `#H${String(i).padStart(6, "0")}`, order_uid: `uid-h-${i}`, service_session_id: SS_OLD, table_session_id: null, estado: "CANCELADO", totale: 0, ...PICKUP, nombre: "", tel: "", created_at: t(i) });
  }
  const n = historical + 1;
  orders.push({ id: "#DEV", order_uid: "uid-dev", service_session_id: SS_OLD, table_session_id: null, estado: "RETIRADO", totale: 10, ...PICKUP, nombre: "Dev", tel: "600000002", created_at: t(n) });
  orders.push({ id: "#NEW", order_uid: "uid-new", service_session_id: SS_OLD, table_session_id: null, estado: "RETIRADO", totale: 17, ...PICKUP, nombre: "New", tel: "600000003", created_at: t(n + 1) });
  const events = [{ id: "e-dev", order_id: "#DEV", service_session_id: SS_OLD, type: "payment", amount: 20, payment_method: "efectivo", created_at: t(n) }];
  return {
    ordenes: orders,
    storico: [], // language-guard: allow-legacy storico is the real PostgREST table name this key must match verbatim, not new vocabulary
    order_financial_events: events,
    order_obligations: [],
    service_sessions: [{ id: SS_OLD, business_date: "2026-08-01", status: "closed" }],
    table_sessions: [],
  };
}
const key = (list) => list.map((i) => [i.display && i.display.orderNumber, i.amount]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
const run = (tables, opts) => createPendingExposures({ select: createKeysetSelect(tables, opts) })({ workspaceId: WORKSPACE, now: NOW });

(async () => {
  await atest("1 · 2600 rows (> 2 pages): the NEWEST unpaid, the OLDEST unpaid and the over-collected order are all present, nothing else", async () => {
    const r = await run(dataset(2600));
    assert.deepStrictEqual(key(r.porCobrar), [["#NEW", 17], ["#OLD", 13]]);
    assert.deepStrictEqual(key(r.porDevolver), [["#DEV", 10]]);
  });
  await atest("1b · control on the frozen ceiling: 5001 rows still carry the newest exposure", async () => {
    const r = await run(dataset(4998));
    assert.strictEqual(r.porCobrar.some((i) => i.display.orderNumber === "#NEW"), true);
  });
  await atest("2 · a provider cap of 7 rows per response (far below the page size) loses nothing", async () => {
    const calls = [];
    const r = await run(dataset(60), { cap: 7, calls });
    assert.deepStrictEqual(key(r.porCobrar), [["#NEW", 17], ["#OLD", 13]]);
    assert.deepStrictEqual(key(r.porDevolver), [["#DEV", 10]]);
    assert.ok(calls.filter((c) => c.table === "ordenes").length >= 10, "the ordenes population was walked page by page");
  });
  await atest("2b · a provider cap EQUAL to the page size (1000) with 2600 rows: a full page proves the cap, the short page ends the walk, nothing lost", async () => {
    const calls = [];
    const r = await run(dataset(2600), { cap: 1000, calls });
    assert.deepStrictEqual(key(r.porCobrar), [["#NEW", 17], ["#OLD", 13]]);
    assert.deepStrictEqual(key(r.porDevolver), [["#DEV", 10]]);
    assert.strictEqual(calls.filter((c) => c.table === "ordenes").length, 3, "2602 rows = 1000 + 1000 + 602, no confirming empty request once a full page was seen");
  });
  await atest("3 · a recycled display id whose events exceed one page is summed completely (provider cap 50)", async () => {
    const tables = dataset(5);
    for (let i = 0; i < 120; i += 1) tables.order_financial_events.push({ id: `e-r-${String(i).padStart(4, "0")}`, order_id: "#NEW", service_session_id: "ss-elsewhere", type: "payment", amount: 1, payment_method: "efectivo", created_at: "2026-08-02T10:00:00Z" });
    tables.order_financial_events.push({ id: "e-new-part", order_id: "#NEW", service_session_id: SS_OLD, type: "payment", amount: 7, payment_method: "efectivo", created_at: "2026-08-02T11:00:00Z" });
    const r = await run(tables, { cap: 50 });
    const item = r.porCobrar.find((i) => i.display.orderNumber === "#NEW");
    assert.ok(item, "#NEW is still a pendency");
    assert.strictEqual(item.amount, 10, "17 obligation - 7 collected in ITS service; the 120 events of another service never leak in and the one that matters is not truncated");
  });
  await atest("4 · no population read carries a fixed ceiling or a created_at sort; every read walks a primary key", async () => {
    const calls = [];
    await run(dataset(30), { calls });
    for (const c of calls.filter((x) => ["ordenes", "storico", "order_financial_events", "order_obligations"].includes(x.table))) { // language-guard: allow-legacy storico is the real table name, not new vocabulary
      assert.ok(!/limit=(5000|20000)/.test(c.query), `fixed ceiling in ${c.table}: ${c.query}`);
      assert.ok(!/order=created_at/.test(c.query), `created_at sort in ${c.table}: ${c.query}`);
      assert.ok(/(^|&)order=id\.asc(&|$)/.test(c.query), `primary-key walk in ${c.table}: ${c.query}`);
    }
  });
  await atest("5 · a select that ignores the cursor terminates and never duplicates a row", async () => {
    const calls = [];
    const r = await run(dataset(40), { ignoreCursor: true, calls });
    assert.deepStrictEqual(key(r.porCobrar), [["#NEW", 17], ["#OLD", 13]]);
    assert.ok(calls.length < 50, "bounded number of requests");
  });
  console.log(`pendingExposuresCompleteRead: ${passed} passed`);
})();
