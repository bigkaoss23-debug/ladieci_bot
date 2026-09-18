"use strict";
// ECON-R1 — economicSnapshot.js's `obligation.currentServiceUnpaid`.
//
// POST_REMEDIATION_FINAL_OPUS_REVIEW (2026-09-18), §4: the General Economía screen
// bound its live "Por cobrar ahora" KPI to `obligation.unpaid`, which is WINDOW-WIDE
// (every order born in the window, operationally over or not). Pendencias'
// `totals.porCobrar` narrows that SAME population by `isOperationallyOver`
// (pendingExposures.js) to only the post-operational subset. So for one scope,
// "Pendientes anteriores" was always a subset of "Por cobrar ahora" — showing both
// side by side double-counted the historical figure inside the live one.
//
// The fix: `currentServiceUnpaid` is the COMPLEMENT of that same subset — unpaid
// summed over obligations `isOperationallyOver` says are still open — using the
// SAME predicate Pendencias owns (imported, not re-derived). This suite proves:
//   1. `unpaid` (window-wide, unchanged) and `currentServiceUnpaid` (still-open
//      subset) never disagree about which population is bigger — a real backend
//      state can only ever have currentServiceUnpaid <= unpaid.
//   2. The still-open/post-operational split matches isOperationallyOver's own
//      documented rules for both non-Mesa (estado) and Mesa (table session status)
//      orders, including its fail-closed rule for an unresolved table session.
//   3. `unpaid` itself never changes shape or value — no existing caller regresses.
const assert = require("assert");
const { createEconomicSnapshot } = require("../src/economy/economicSnapshot");
const { createMemorySelect } = require("./fixtures/postgrestMemorySelect");

let passed = 0;
const atest = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (error) { console.error(`  ✗ FAIL: ${name}\n    ${error && error.stack}`); process.exitCode = 1; }
};

const WIN_FROM = "2026-09-18T02:00:00.000Z";
const WIN_TO = "2026-09-18T12:00:00.000Z";
const NOW = new Date("2026-09-18T12:00:00.000Z");

const SESSION = Object.freeze({
  id: "svc-1", business_date: "2026-09-18", status: "open",
  opened_at: "2026-09-18T09:00:00Z", closed_at: null, service_kind: "SERA",
});

function harness({ ordenes = [], events = [], sessions = [SESSION], tableSessions = [] } = {}) {
  // language-guard: allow-legacy storico is the existing archive table name this reader queries, keyed here verbatim, not new vocabulary
  const select = createMemorySelect({ ordenes, storico: [], order_financial_events: events, service_sessions: sessions, table_sessions: tableSessions });
  return createEconomicSnapshot({ select });
}

let n = 0;
const order = (overrides) => Object.freeze({
  id: `#${(n += 1)}`, service_session_id: "svc-1", created_at: "2026-09-18T10:00:00Z",
  estado: "LISTO", totale: 50, ...overrides,
});
const payment = (orderId, amount, overrides = {}) => Object.freeze({
  id: `evt-${orderId}-${Math.random()}`, order_id: orderId, service_session_id: "svc-1", event_service_session_id: "svc-1",
  event_type: "payment", amount, created_at: "2026-09-18T10:05:00Z", ...overrides,
});

(async () => {
  await atest("non-Mesa, still LISTO (operational): fully counted in currentServiceUnpaid, not excluded", async () => {
    const o = order({ id: "#1", estado: "LISTO", totale: 50 });
    const snapshot = harness({ ordenes: [o] });
    const s = await snapshot({ preset: "personalizado", from: WIN_FROM, to: WIN_TO, now: NOW });
    assert.strictEqual(s.obligation.unpaid, 50);
    assert.strictEqual(s.obligation.currentServiceUnpaid, 50, "LISTO has not left the operational phase");
  });

  await atest("non-Mesa, RETIRADO (terminal): counted in unpaid, EXCLUDED from currentServiceUnpaid", async () => {
    const o = order({ id: "#2", estado: "RETIRADO", totale: 40 });
    const snapshot = harness({ ordenes: [o] });
    const s = await snapshot({ preset: "personalizado", from: WIN_FROM, to: WIN_TO, now: NOW });
    assert.strictEqual(s.obligation.unpaid, 40, "unpaid stays window-wide, unchanged");
    assert.strictEqual(s.obligation.currentServiceUnpaid, 0, "RETIRADO has left the operational phase — this is Pendencias' job now");
  });

  await atest("Mesa order on a still-OPEN table session: counted in currentServiceUnpaid (normal operational UI's job)", async () => {
    const o = order({ id: "#3", estado: "LISTO", totale: 30, table_session_id: "ts-open" });
    const snapshot = harness({
      ordenes: [o],
      tableSessions: [{ id: "ts-open", status: "open" }],
    });
    const s = await snapshot({ preset: "personalizado", from: WIN_FROM, to: WIN_TO, now: NOW });
    assert.strictEqual(s.obligation.unpaid, 30);
    assert.strictEqual(s.obligation.currentServiceUnpaid, 30);
  });

  await atest("Mesa order on a CLOSED table session: counted in unpaid, EXCLUDED from currentServiceUnpaid", async () => {
    const o = order({ id: "#4", estado: "RETIRADO", totale: 25, table_session_id: "ts-closed" });
    const snapshot = harness({
      ordenes: [o],
      tableSessions: [{ id: "ts-closed", status: "closed" }],
    });
    const s = await snapshot({ preset: "personalizado", from: WIN_FROM, to: WIN_TO, now: NOW });
    assert.strictEqual(s.obligation.unpaid, 25);
    assert.strictEqual(s.obligation.currentServiceUnpaid, 0, "the Mesa closed — this is exactly the Pendencias population");
  });

  await atest("Mesa order whose table session cannot be resolved: fails CLOSED toward still-open, matching pendingExposures' own rule", async () => {
    // isOperationallyOver({order, tableSession: null}) returns false when the order
    // has a table_session_id but no resolvable row — pendingExposures.js's own
    // documented fail-closed rule ("a Mesa order whose table_sessions row could not
    // be resolved is never treated as over"). economicSnapshot.js must inherit that
    // exact behaviour, not invent a different default.
    const o = order({ id: "#5", estado: "RETIRADO", totale: 12, table_session_id: "ts-missing" });
    const snapshot = harness({ ordenes: [o], tableSessions: [] });
    const s = await snapshot({ preset: "personalizado", from: WIN_FROM, to: WIN_TO, now: NOW });
    assert.strictEqual(s.obligation.unpaid, 12);
    assert.strictEqual(s.obligation.currentServiceUnpaid, 12, "unresolved table session must not be treated as operationally over");
  });

  await atest("mixed window: currentServiceUnpaid is the exact still-open subset of unpaid, never more", async () => {
    const stillOpen = order({ id: "#6", estado: "LISTO", totale: 64.5 });
    const postOperational = order({ id: "#7", estado: "RETIRADO", totale: 30 });
    const snapshot = harness({ ordenes: [stillOpen, postOperational] });
    const s = await snapshot({ preset: "personalizado", from: WIN_FROM, to: WIN_TO, now: NOW });
    assert.strictEqual(s.obligation.unpaid, 94.5, "window-wide total, unchanged shape");
    assert.strictEqual(s.obligation.currentServiceUnpaid, 64.5, "only the still-open order");
    // The two never overlap and never exceed the window-wide total: this is the
    // exact partition property ECON-R1 requires.
    assert.ok(s.obligation.currentServiceUnpaid <= s.obligation.unpaid);
    assert.strictEqual(
      Math.round((s.obligation.unpaid - s.obligation.currentServiceUnpaid) * 100) / 100,
      30,
      "the complement is exactly the post-operational amount Pendencias would report",
    );
  });

  await atest("a cancelled order contributes 0 to both fields regardless of operational state", async () => {
    const o = order({ id: "#8", estado: "CANCELADO", totale: 20 });
    const snapshot = harness({ ordenes: [o] });
    const s = await snapshot({ preset: "personalizado", from: WIN_FROM, to: WIN_TO, now: NOW });
    assert.strictEqual(s.obligation.unpaid, 0);
    assert.strictEqual(s.obligation.currentServiceUnpaid, 0);
  });

  await atest("a partially paid still-open order: currentServiceUnpaid is the remaining balance, from safeTicket, not re-derived", async () => {
    const o = order({ id: "#9", estado: "EN_ENTREGA", totale: 20 });
    const snapshot = harness({ ordenes: [o], events: [payment("#9", 5)] });
    const s = await snapshot({ preset: "personalizado", from: WIN_FROM, to: WIN_TO, now: NOW });
    assert.strictEqual(s.obligation.unpaid, 15);
    assert.strictEqual(s.obligation.currentServiceUnpaid, 15);
  });

  await atest("no writes: this reader only ever calls the select it was given (SNAPSHOT_DB_WRITES = 0 holds for the new table_sessions read too)", async () => {
    const calls = [];
    const select = createMemorySelect(
      // language-guard: allow-legacy storico is the existing archive table name this reader queries, keyed here verbatim, not new vocabulary
      { ordenes: [order({ id: "#10", table_session_id: "ts-open" })], storico: [], order_financial_events: [], service_sessions: [SESSION], table_sessions: [{ id: "ts-open", status: "open" }] },
      { onCall: (c) => calls.push(c) },
    );
    const snapshot = createEconomicSnapshot({ select });
    await snapshot({ preset: "personalizado", from: WIN_FROM, to: WIN_TO, now: NOW });
    assert.ok(calls.some((c) => c.table === "table_sessions"), "table_sessions must actually be read for a Mesa obligation");
    assert.ok(calls.every((c) => typeof c.table === "string"), "every call went through the injected read-only select");
  });

  console.log(`\neconomicSnapshotCurrentServiceUnpaid: ${passed} passed`);
})();
