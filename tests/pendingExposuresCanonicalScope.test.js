"use strict";
// PENDENCIAS ECONÓMICAS — CANONICAL SCOPE.
//
// Proves the scope contract added on top of Slice 1: a bare request stays
// GLOBAL and byte-for-byte as before; `preset` routes the window through the
// SAME economicWindow authority /snapshot uses (04:00 Madrid rollover, never a
// client-side calculation); `servicio` scopes by canonical order identity, not
// a timestamp overlap; and `totals` is summed from the SAME item population it
// reports, so General.PENDIENTE(scope) and the list it opens are one number.
//
// safeTicket's own arithmetic is NOT re-litigated here (its suite +
// pendingExposures.test.js cover it). This file proves scope resolution,
// membership, totals and refusals.
const assert = require("assert");
const {
  createPendingExposures, PendingExposuresError, resolvePendencyScope, PENDENCY_PRESETS,
} = require("../src/economy/pendingExposures");
const { createMemorySelect } = require("./fixtures/postgrestMemorySelect");

let passed = 0;
const atest = async (name, fn) => {
  try { await fn(); passed += 1; }
  catch (error) { console.error(`FAIL: ${name}\n  ${error && error.message}`); process.exitCode = 1; }
};

// 14:00 Madrid (CEST, UTC+2) on 2026-09-05.
//   hoy  business day = 2026-09-05 -> [2026-09-05T02:00:00Z, 2026-09-06T02:00:00Z)
//   ayer business day = 2026-09-04 -> [2026-09-04T02:00:00Z, 2026-09-05T02:00:00Z)
const NOW = new Date("2026-09-05T12:00:00.000Z");
const WS = "ws-1";
const PICKUP = { tipo_consegna: "RITIRO" }; // language-guard: allow-legacy tipo_consegna/RITIRO are the existing ordenes column/literal, defined once, not new vocabulary

const SS_A = "SS-A"; // business_date 2026-09-05
const SS_B = "SS-B"; // business_date 2026-09-04

const sessions = [
  { id: SS_A, business_date: "2026-09-05", status: "closed",
    opened_at: "2026-09-05T08:00:00Z", closed_at: "2026-09-05T23:00:00Z" },
  { id: SS_B, business_date: "2026-09-04", status: "closed",
    opened_at: "2026-09-04T18:00:00Z", closed_at: "2026-09-05T01:30:00Z" },
];

const orders = [
  // Terminal, unpaid 20 -> POR_COBRAR. Created inside the HOY window, service A.
  { id: "#SC-HOY", order_uid: "uid-hoy", service_session_id: SS_A, table_session_id: null,
    estado: "RETIRADO", totale: 30, ...PICKUP, nombre: "Cliente Hoy", tel: "600000001",
    created_at: "2026-09-05T10:00:00Z" },
  // Terminal, unpaid 25 -> POR_COBRAR. Created inside the AYER window, service B.
  { id: "#SC-AYER", order_uid: "uid-ayer", service_session_id: SS_B, table_session_id: null,
    estado: "RETIRADO", totale: 40, ...PICKUP, nombre: "Cliente Ayer", tel: "600000002",
    created_at: "2026-09-04T20:00:00Z" },
  // Created 03:00 Madrid = 01:00Z on the 5th -> still the 2026-09-04 BUSINESS
  // day. The single most important row here: a naive calendar-date filter
  // would call this "hoy", the 04:00 rollover does not. Service B, unpaid 12.
  { id: "#SC-EARLYHOY", order_uid: "uid-early", service_session_id: SS_B, table_session_id: null,
    estado: "RETIRADO", totale: 12, ...PICKUP, nombre: "Cliente Madrugada", tel: "600000003",
    created_at: "2026-09-05T01:00:00Z" },
  // Over-collected 10 -> POR_DEVOLVER. HOY window, service A.
  { id: "#SC-DEV", order_uid: "uid-dev", service_session_id: SS_A, table_session_id: null,
    estado: "RETIRADO", totale: 20, ...PICKUP, nombre: "Cliente Devolver", tel: "600000004",
    created_at: "2026-09-05T11:00:00Z" },
  // Unpaid 50 but EN_ENTREGA -> operational phase NOT over -> excluded in
  // EVERY scope. HOY window, service A.
  { id: "#SC-ACTIVE", order_uid: "uid-active", service_session_id: SS_A, table_session_id: null,
    estado: "EN_ENTREGA", totale: 50, ...PICKUP, nombre: "Cliente Activo", tel: "600000005",
    created_at: "2026-09-05T11:30:00Z" },
  // Terminal, unpaid 15, but NO order_uid -> REQUIERE_REVISION, never
  // monetized. HOY window, service A.
  { id: "#SC-REV", order_uid: null, service_session_id: SS_A, table_session_id: null,
    estado: "RETIRADO", totale: 15, ...PICKUP, nombre: "", tel: "",
    created_at: "2026-09-05T09:00:00Z" },
];

const events = [
  { order_id: "#SC-HOY", service_session_id: SS_A, type: "payment", amount: 10, payment_method: "efectivo", created_at: "2026-09-05T10:05:00Z" },
  { order_id: "#SC-AYER", service_session_id: SS_B, type: "payment", amount: 15, payment_method: "efectivo", created_at: "2026-09-04T20:05:00Z" },
  { order_id: "#SC-DEV", service_session_id: SS_A, type: "payment", amount: 30, payment_method: "tarjeta", created_at: "2026-09-05T11:05:00Z" },
];

// Legacy archive row (no order_uid column) -> REQUIERE_REVISION. Service B,
// created inside the AYER window.
const legacyArchive = [
  { orden_id: "#SC-ARCH", service_session_id: SS_B, estado: "RETIRADO", totale: 14,
    created_at: "2026-09-04T21:00:00Z" },
];

// A true orphan: matches no order in either store. lastMovement is 2026-09-01,
// outside every window here, so it only ever shows in a GLOBAL read.
const orphanEvent = { order_id: "#SC-ORPHAN", service_session_id: "ss-gone", type: "payment", amount: 5, created_at: "2026-09-01T09:00:00Z" };

const calls = [];
const select = createMemorySelect(
  {
    ordenes: orders,
    storico: legacyArchive, // language-guard: allow-legacy storico is the real PostgREST table name this key must match verbatim, not new vocabulary
    order_financial_events: [...events, orphanEvent],
    order_obligations: [],
    service_sessions: sessions,
    table_sessions: [],
  },
  { onCall: (c) => calls.push(c) },
);
const raw = createPendingExposures({ select });
const run = (params = {}) => raw({ workspaceId: WS, now: NOW, ...params });

const sum = (items) => Math.round(items.reduce((a, i) => a + (Number(i.amount) || 0), 0) * 100) / 100;

(async () => {

  // ── PURE: the scope set is exactly the four the spec names ───────────────
  await atest("PENDENCY_PRESETS is exactly {hoy, ayer, servicio, personalizado}", async () => {
    assert.deepStrictEqual([...PENDENCY_PRESETS].sort(), ["ayer", "hoy", "personalizado", "servicio"]);
  });

  // ── GLOBAL — unchanged behaviour, plus the new fields ───────────────────
  await atest("GLOBAL · a bare request stays global: every eligible exposure, no scope echo", async () => {
    const r = await run();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.scope, null, "no scope was applied");
    assert.strictEqual(r.window, null, "and no window echo");
    assert.strictEqual(r.counts.porCobrar, 3, "#SC-HOY, #SC-AYER, #SC-EARLYHOY");
    assert.strictEqual(r.counts.porDevolver, 1, "#SC-DEV");
    assert.strictEqual(r.counts.requiereRevision, 3, "#SC-REV, #SC-ARCH, #SC-ORPHAN");
    assert.ok(!r.porCobrar.some((i) => i.orderUid === "uid-active"), "an EN_ENTREGA order is never a pendency");
  });

  await atest("GLOBAL · totals are summed from the SAME item population, to the cent", async () => {
    const r = await run();
    assert.strictEqual(r.totals.porCobrar, 57, "20 + 25 + 12");
    assert.strictEqual(r.totals.porDevolver, 10);
    assert.strictEqual(r.totals.porCobrar, sum(r.porCobrar), "invariant: totals.porCobrar === Σ porCobrar[].amount");
    assert.strictEqual(r.totals.porDevolver, sum(r.porDevolver), "invariant: totals.porDevolver === Σ porDevolver[].amount");
  });

  await atest("GLOBAL · requiereRevision is never folded into any total", async () => {
    const r = await run();
    // 15 (#SC-REV) + 14 (#SC-ARCH) + 5 (#SC-ORPHAN) would be 34 if monetized.
    assert.strictEqual(r.totals.porCobrar, 57, "unchanged by revision amounts");
    assert.strictEqual(r.totals.porDevolver, 10, "unchanged by revision amounts");
  });

  // ── HOY — server-resolved window, 04:00 Madrid ─────────────────────────
  await atest("HOY · window is the 2026-09-05 business day, 04:00 Madrid = 02:00Z", async () => {
    const r = await run({ preset: "hoy" });
    assert.deepStrictEqual(r.scope, { preset: "hoy", businessDate: "2026-09-05" });
    assert.strictEqual(r.window.from, "2026-09-05T02:00:00.000Z");
    assert.strictEqual(r.window.to, "2026-09-06T02:00:00.000Z");
    assert.strictEqual(r.window.timezone, "Europe/Madrid");
    assert.strictEqual(r.window.bounds, "[from,to)");
  });

  await atest("HOY · #SC-EARLYHOY (03:00 Madrid) is EXCLUDED — the 04:00 rollover, not the calendar date", async () => {
    const r = await run({ preset: "hoy" });
    assert.strictEqual(r.counts.porCobrar, 1, "only #SC-HOY");
    assert.strictEqual(r.porCobrar[0].orderUid, "uid-hoy");
    assert.strictEqual(r.totals.porCobrar, 20);
    assert.ok(!r.porCobrar.some((i) => i.orderUid === "uid-early"), "01:00Z is still yesterday's business day");
  });

  await atest("HOY · POR_DEVOLVER and REQUIERE_REVISION are windowed by the same authority", async () => {
    const r = await run({ preset: "hoy" });
    assert.strictEqual(r.counts.porDevolver, 1, "#SC-DEV, 11:00Z");
    assert.strictEqual(r.totals.porDevolver, 10);
    assert.strictEqual(r.counts.requiereRevision, 1, "#SC-REV (09:00Z) in; #SC-ARCH and #SC-ORPHAN out");
  });

  await atest("HOY · the active EN_ENTREGA order is still excluded under a scope", async () => {
    const r = await run({ preset: "hoy" });
    assert.ok(!r.porCobrar.some((i) => i.orderUid === "uid-active"));
    assert.strictEqual(r.totals.porCobrar, sum(r.porCobrar), "invariant holds under scope");
  });

  // ── AYER — same authority, shifted one business day ────────────────────
  await atest("AYER · window is 2026-09-04, and #SC-EARLYHOY lands in it", async () => {
    const r = await run({ preset: "ayer" });
    assert.strictEqual(r.window.from, "2026-09-04T02:00:00.000Z");
    assert.strictEqual(r.window.to, "2026-09-05T02:00:00.000Z");
    assert.strictEqual(r.counts.porCobrar, 2, "#SC-AYER + #SC-EARLYHOY");
    assert.strictEqual(r.totals.porCobrar, 37, "25 + 12");
    assert.strictEqual(r.totals.porCobrar, sum(r.porCobrar));
    assert.strictEqual(r.counts.porDevolver, 0);
    assert.strictEqual(r.totals.porDevolver, 0, "an empty group totals 0, not null");
    assert.strictEqual(r.counts.requiereRevision, 1, "#SC-ARCH (21:00Z on the 4th)");
  });

  // ── SERVICIO — canonical identity, never a timestamp overlap ───────────
  await atest("SERVICIO · membership is order.service_session_id, not a time range", async () => {
    const r = await run({ preset: "servicio", serviceSessionId: SS_A });
    assert.deepStrictEqual(r.scope, { preset: "servicio", serviceSessionId: SS_A, businessDate: "2026-09-05" });
    assert.strictEqual(r.counts.porCobrar, 1, "only #SC-HOY belongs to SS-A");
    assert.strictEqual(r.porCobrar[0].orderUid, "uid-hoy");
    assert.strictEqual(r.totals.porCobrar, 20);
    assert.strictEqual(r.counts.porDevolver, 1, "#SC-DEV is SS-A");
    assert.strictEqual(r.counts.requiereRevision, 1, "#SC-REV is SS-A; #SC-ARCH is SS-B; the orphan has no service");
  });

  await atest("SERVICIO · a different service sees a disjoint set — no same-time leakage", async () => {
    const r = await run({ preset: "servicio", serviceSessionId: SS_B });
    assert.strictEqual(r.counts.porCobrar, 2, "#SC-AYER + #SC-EARLYHOY");
    assert.strictEqual(r.totals.porCobrar, 37);
    assert.strictEqual(r.counts.requiereRevision, 1, "#SC-ARCH is SS-B");
    assert.ok(!r.porCobrar.some((i) => i.orderUid === "uid-hoy"), "SS-A's order never leaks into SS-B");
  });

  await atest("SERVICIO · the window is echoed but is NOT the membership rule", async () => {
    const r = await run({ preset: "servicio", serviceSessionId: SS_A });
    // SS-A opened 08:00Z; #SC-REV was created 09:00Z — inside that interval AND
    // in SS-A, so it is in. #SC-EARLYHOY (01:00Z, before SS-A opened) is SS-B,
    // so it is out — by identity, which a pure time-overlap would have gotten
    // wrong the other way for any SS-B order created during SS-A's hours.
    assert.ok(r.window && r.window.from === "2026-09-05T08:00:00.000Z");
  });

  // ── direction / q still work under a scope ─────────────────────────────
  await atest("direction=POR_COBRAR under a scope empties porDevolver, keeps porCobrar", async () => {
    const r = await run({ preset: "ayer", direction: "POR_COBRAR" });
    assert.strictEqual(r.porDevolver.length, 0);
    assert.strictEqual(r.counts.porCobrar, 2);
    assert.strictEqual(r.totals.porDevolver, 0);
  });

  await atest("q free-text still filters within a scope", async () => {
    const r = await run({ preset: "ayer", q: "Madrugada" });
    assert.strictEqual(r.counts.porCobrar, 1, "only #SC-EARLYHOY matches");
    assert.strictEqual(r.porCobrar[0].orderUid, "uid-early");
    assert.strictEqual(r.totals.porCobrar, 12, "and the total follows the filtered list");
  });

  // ── PERSONALIZADO — explicit half-open ────────────────────────────────
  await atest("PERSONALIZADO · explicit [from, to), half-open on originalDate", async () => {
    const r = await run({
      preset: "personalizado",
      from: "2026-09-05T09:30:00.000Z",
      to: "2026-09-05T11:00:00.000Z",
    });
    // [09:30, 11:00): #SC-HOY (10:00) in; #SC-REV (09:00) out; #SC-DEV (11:00) out (half-open).
    assert.strictEqual(r.counts.porCobrar, 1);
    assert.strictEqual(r.porCobrar[0].orderUid, "uid-hoy");
    assert.strictEqual(r.counts.porDevolver, 0, "11:00 is excluded by the half-open upper bound");
    assert.strictEqual(r.window.from, "2026-09-05T09:30:00.000Z");
  });

  // ── REFUSALS — §17, unambiguous combinations only ─────────────────────
  const rejects = async (params, code, status) => {
    await assert.rejects(() => run(params), (e) => {
      assert.ok(e instanceof PendingExposuresError, "typed error");
      assert.strictEqual(e.code, code);
      if (status) assert.strictEqual(e.status, status);
      return true;
    });
  };

  await atest("REFUSAL · preset=servicio without serviceSessionId", async () => {
    await rejects({ preset: "servicio" }, "ECONOMY_PENDENCIES_SERVICE_SESSION_REQUIRED");
  });
  await atest("REFUSAL · serviceSessionId supplied without preset=servicio", async () => {
    await rejects({ preset: "hoy", serviceSessionId: SS_A }, "ECONOMY_PENDENCIES_SCOPE_INVALID");
    await rejects({ serviceSessionId: SS_A }, "ECONOMY_PENDENCIES_SCOPE_INVALID");
  });
  await atest("REFUSAL · an unknown / unsupported preset (mediodia, noche, garbage)", async () => {
    await rejects({ preset: "mediodia" }, "ECONOMY_PENDENCIES_SCOPE_INVALID");
    await rejects({ preset: "noche" }, "ECONOMY_PENDENCIES_SCOPE_INVALID");
    await rejects({ preset: "whenever" }, "ECONOMY_PENDENCIES_SCOPE_INVALID");
  });
  await atest("REFUSAL · preset=servicio with an id that resolves to no session -> 404", async () => {
    await rejects({ preset: "servicio", serviceSessionId: "does-not-exist" }, "ECONOMY_PENDENCIES_SERVICE_NOT_FOUND", 404);
  });
  await atest("REFUSAL · preset=personalizado without both ends", async () => {
    await rejects({ preset: "personalizado", from: "2026-09-05T09:00:00Z" }, "ECONOMY_PENDENCIES_RANGE_INVALID");
  });

  // ── RECONCILIATION INVARIANT — across every scope at once ─────────────
  await atest("RECONCILIATION · totals === Σ items for global, hoy, ayer, servicio, personalizado", async () => {
    const scopes = [
      {},
      { preset: "hoy" },
      { preset: "ayer" },
      { preset: "servicio", serviceSessionId: SS_A },
      { preset: "servicio", serviceSessionId: SS_B },
      { preset: "personalizado", from: "2026-09-01T00:00:00Z", to: "2026-09-30T00:00:00Z" },
    ];
    for (const s of scopes) {
      const r = await run(s);
      assert.strictEqual(r.totals.porCobrar, sum(r.porCobrar), `porCobrar mismatch for ${JSON.stringify(s)}`);
      assert.strictEqual(r.totals.porDevolver, sum(r.porDevolver), `porDevolver mismatch for ${JSON.stringify(s)}`);
    }
  });

  // ── the scope resolver never invents its own calendar ─────────────────
  await atest("resolvePendencyScope · a 'window' scope carries economicWindow's own instants verbatim", async () => {
    const { resolveEconomicWindow } = require("../src/economy/economicWindow");
    const canonical = resolveEconomicWindow({ preset: "hoy", now: NOW });
    const scope = await resolvePendencyScope({ select, preset: "hoy", now: NOW });
    assert.strictEqual(scope.windowEcho.from, canonical.from);
    assert.strictEqual(scope.windowEcho.to, canonical.to);
  });

  console.log(`pendingExposuresCanonicalScope: ${passed} passed`);
})();
