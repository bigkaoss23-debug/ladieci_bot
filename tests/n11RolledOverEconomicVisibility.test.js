"use strict";
// ===============================================================
// N-11 — LEGACY `rolled_over` ECONOMIC VISIBILITY (backend contract)
//
// Economía's ledger reader filtered service sessions with an inline
// `["open","closing","closed"].includes(s.status)`. service_sessions_status_check
// allows exactly FOUR values, so that array excluded exactly one — 'rolled_over' —
// and with it every euro of real history underneath it. On staging that was two
// business days (2026-08-10, 2026-08-15) worth 177.01 EUR of collected money.
//
// 'rolled_over' means (2026-08-16_r_day3_business_day_intake_authority.sql, verbatim):
// "no longer current for new economic attribution. Not paid, not reconciled, not
// empty, not closed, not consolidated, not archived." It is a statement about
// ATTRIBUTION CURRENCY, never about validity — so it must not delete history.
//
// This file pins:
//   * the predicate is a fail-closed ALLOWLIST, pinned to the DB CHECK vocabulary;
//   * rolled_over money is reportable, exactly once, on its own business date;
//   * a rolled-over period NEVER receives a fabricated Finalizar snapshot, and its
//     absence is explained with its own reason rather than a misleading one;
//   * N-8's closed-service semantics and N-6's composite scoping are untouched.
//
// Run: node --test tests/n11RolledOverEconomicVisibility.test.js
// ===============================================================

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  SERVICE_SESSION_STATUSES,
  isEconomicallyReportableServiceStatus,
  isHistoricalServiceStatus,
  isRolledOverServiceStatus,
} = require("../src/economy/serviceStatusReporting");
const { describeServiceEconomicTruth } = require("../src/closeout/closedServiceEconomicTruth");
const { getEconomiaLedgerAggregate } = require("../src/closeout/economiaLedgerAggregate");

// ── the status vocabulary, as the DB actually constrains it ──────────────────
// service_sessions_status_check, read live from staging 2026-08-25:
//   CHECK (status = ANY (ARRAY['open','closing','closed','rolled_over']))
const DB_CHECK_STATUSES = ["open", "closing", "closed", "rolled_over"];

// ── fixture helpers ─────────────────────────────────────────────────────────
const session = (id, status, businessDate, extra = {}) => ({
  id, status, business_date: businessDate, service_kind: "PRANZO", ...extra, // language-guard: allow-legacy PRANZO is the existing service_kind enum value, used as fixture data, not new vocabulary
});
const order = (id, sessionId, totale, extra = {}) => ({
  id, orden_id: id, service_session_id: sessionId, totale, estado: "RETIRADO",
  cobrado: false, ya_pagado: false, metodo_pago: "", ts: 1786351294893, ...extra,
});
const payment = (orderId, sessionId, amount, method = "efectivo", createdAt = "2026-08-10T08:43:20Z") => ({
  id: `${orderId}-${amount}-${createdAt}`, order_id: orderId, service_session_id: sessionId,
  type: "payment", amount, payment_method: method, created_at: createdAt, legacy: false,
});

// A select shim over in-memory tables, speaking the PostgREST subset these readers use.
function makeSelect(tables) {
  return async function select(table, query) {
    let rows = (tables[table] || []).slice();
    let limit = null;
    for (const part of String(query || "").split("&")) {
      if (!part) continue;
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      const col = part.slice(0, eq);
      const rhs = part.slice(eq + 1);
      if (col === "order" || col === "select") continue;
      if (col === "limit") { limit = Number(rhs); continue; }
      const dot = rhs.indexOf(".");
      const op = rhs.slice(0, dot);
      const val = rhs.slice(dot + 1);
      if (op === "eq") rows = rows.filter((r) => String(r[col] ?? "") === decodeURIComponent(val));
      else if (op === "gte") rows = rows.filter((r) => String(r[col] ?? "") >= decodeURIComponent(val));
      else if (op === "lte") rows = rows.filter((r) => String(r[col] ?? "") <= decodeURIComponent(val));
      else if (op === "in") {
        const set = new Set(val.replace(/^\(|\)$/g, "").split(",").map((s) => decodeURIComponent(s)));
        rows = rows.filter((r) => set.has(String(r[col] ?? "")));
      } else throw new Error("unsupported op " + op);
    }
    return limit === null ? rows : rows.slice(0, limit);
  };
}

const RANGE = { desde: "2026-08-01", hasta: "2026-08-31" };
const dayOf = (res, d) => res.porGiorno.find((x) => x.businessDate === d) || null;
const svcOf = (res, id) => res.sessions.find((x) => x.serviceSessionId === id) || null;

// ═══════════════════════════════════════════════════════════════════════════
// THE PREDICATE ITSELF
// ═══════════════════════════════════════════════════════════════════════════

test("N-11 · the status vocabulary matches the DB CHECK constraint exactly", () => {
  assert.deepEqual([...SERVICE_SESSION_STATUSES].sort(), [...DB_CHECK_STATUSES].sort(),
    "serviceStatusReporting drifted from service_sessions_status_check — reconcile before shipping");
});

test("N-11 · every status the DB can hold is economically reportable — that is the decision", () => {
  for (const s of DB_CHECK_STATUSES) {
    assert.equal(isEconomicallyReportableServiceStatus(s), true, `${s} must be reportable`);
  }
});

test("N-11 · F · the predicate FAILS CLOSED — an unclassified status is never admitted", () => {
  // A future 5th status must be classified on purpose, not inherit inclusion by default.
  for (const s of ["cancelled", "voided", "superseded", "archived", "ROLLED_OVER", "", null, undefined, 0]) {
    assert.equal(isEconomicallyReportableServiceStatus(s), false, `${String(s)} must NOT be reportable`);
  }
});

test("N-11 · historical statuses are exactly the two that may have archived orders", () => {
  assert.equal(isHistoricalServiceStatus("closed"), true);
  assert.equal(isHistoricalServiceStatus("rolled_over"), true);
  assert.equal(isHistoricalServiceStatus("open"), false);
  assert.equal(isHistoricalServiceStatus("closing"), false);
  // fails closed the other way too: never widen a query on an unknown status
  assert.equal(isHistoricalServiceStatus("cancelled"), false);
});

test("N-11 · isRolledOverServiceStatus is exact, never a prefix/case match", () => {
  assert.equal(isRolledOverServiceStatus("rolled_over"), true);
  assert.equal(isRolledOverServiceStatus("ROLLED_OVER"), false);
  assert.equal(isRolledOverServiceStatus("rolled"), false);
  assert.equal(isRolledOverServiceStatus("closed"), false);
});

// ═══════════════════════════════════════════════════════════════════════════
// D / E — NO FABRICATED FINALIZAR SNAPSHOT (N-8 contract)
// ═══════════════════════════════════════════════════════════════════════════

test("N-11 · D · a rolled-over period gets its OWN absent reason, not 'service_not_closed'", () => {
  const truth = describeServiceEconomicTruth({
    status: "rolled_over",
    current: { totals: { collected: 77.01 }, paymentTotals: {} },
    snapshot: null,
  });
  assert.equal(truth.closeoutSnapshot, null);
  assert.equal(truth.closeoutSnapshotAbsentReason, "service_rolled_over");
  assert.equal(truth.divergesFromCloseout, false);
  assert.equal(truth.divergence, null);
});

test("N-11 · E · a real closeout row does NOT become a Finalizar snapshot for a rolled-over period", () => {
  // Staging 9746dfdd genuinely carries a service_closeouts row written by
  // close_source='p0c2_controlled_recovery'. That is a roll-boundary record, NOT the
  // operator-signed Finalizar figure `closeoutSnapshot` is defined to mean. Even when
  // such a row is handed in, it must not be presented as one.
  const truth = describeServiceEconomicTruth({
    status: "rolled_over",
    current: { totals: { collected: 77.01 }, paymentTotals: { efectivo: 77.01 } },
    snapshot: { id: "x", gross_sales_cents: 6701, paid_amount_cents: 6701, cash_amount_cents: 6701 },
  });
  assert.equal(truth.closeoutSnapshot, null, "a roll record must never be dressed up as Finalizar");
  assert.equal(truth.closeoutSnapshotAbsentReason, "service_rolled_over");
  assert.equal(truth.divergesFromCloseout, false);
});

test("N-11 · the three absent reasons stay distinct — open, legacy close, rolled over", () => {
  const mk = (status, snapshot = null) => describeServiceEconomicTruth({
    status, current: { totals: {}, paymentTotals: {} }, snapshot,
  }).closeoutSnapshotAbsentReason;
  assert.equal(mk("open"), "service_not_closed");
  assert.equal(mk("closing"), "service_not_closed");
  assert.equal(mk("closed"), "no_closeout_row");
  assert.equal(mk("rolled_over"), "service_rolled_over");
});

// ═══════════════════════════════════════════════════════════════════════════
// A / B / C / G / H / I — THE READER
// ═══════════════════════════════════════════════════════════════════════════

const SCENARIO = () => ({
  service_sessions: [
    session("OPEN-1", "open", "2026-08-20"),
    session("CLOSED-1", "closed", "2026-08-21", { closed_at: "2026-08-21T20:00:00Z" }),
    session("ROLL-1", "rolled_over", "2026-08-10", { rolled_over_at: "2026-08-11T05:43:11Z" }),
  ],
  ordenes: [
    order("#A1", "OPEN-1", 20),
    order("#B1", "CLOSED-1", 30),
    order("#R1", "ROLL-1", 12),
    order("#R2", "ROLL-1", 13),
    order("#R3", "ROLL-1", 25), // never paid -> unpaid exposure
  ],
  storico: [], // language-guard: allow-legacy storico is the existing archive table name this reader already queries, used here as a fixture key, not new vocabulary
  order_financial_events: [
    payment("#A1", "OPEN-1", 20, "bizum"),
    payment("#B1", "CLOSED-1", 30, "tarjeta"),
    payment("#R1", "ROLL-1", 12, "efectivo"),
    payment("#R2", "ROLL-1", 13, "tarjeta"),
  ],
  order_obligations: [],
  service_closeouts: [
    { id: "co-1", service_session_id: "CLOSED-1", gross_sales_cents: 3000, paid_amount_cents: 3000,
      cash_amount_cents: 0, card_amount_cents: 3000, bizum_amount_cents: 0, other_amount_cents: 0,
      total_refunds_cents: 0, total_void_cents: 0, unpaid_exposure_cents: 0, order_count: 1 },
  ],
});

test("N-11 · A · an OPEN service is unchanged and still reported", async () => {
  const res = await getEconomiaLedgerAggregate({ ...RANGE, select: makeSelect(SCENARIO()) });
  const s = svcOf(res, "OPEN-1");
  assert.equal(s.status, "open");
  assert.equal(s.totals.collected, 20);
  assert.equal(s.closeoutSnapshot, null);
  assert.equal(s.closeoutSnapshotAbsentReason, "service_not_closed");
});

test("N-11 · B · a MODERN CLOSED service is unchanged, snapshot still attached", async () => {
  const res = await getEconomiaLedgerAggregate({ ...RANGE, select: makeSelect(SCENARIO()) });
  const s = svcOf(res, "CLOSED-1");
  assert.equal(s.totals.collected, 30);
  assert.ok(s.closeoutSnapshot, "closed service must keep its Finalizar snapshot");
  assert.equal(s.closeoutSnapshot.totals.collected, 30);
  assert.equal(s.closeoutSnapshotAbsentReason, null);
  assert.equal(s.divergesFromCloseout, false);
});

test("N-11 · C · a ROLLED_OVER service with real facts is now reportable", async () => {
  const res = await getEconomiaLedgerAggregate({ ...RANGE, select: makeSelect(SCENARIO()) });
  const s = svcOf(res, "ROLL-1");
  assert.ok(s, "rolled_over service must appear in sessions[]");
  assert.equal(s.status, "rolled_over");
  assert.equal(s.totals.collected, 25);   // 12 + 13
  assert.equal(s.totals.gross, 50);       // 12 + 13 + 25
  assert.equal(s.totals.unpaid, 25);      // #R3 never paid
});

test("N-11 · G · the money lands on its own business date, exactly once", async () => {
  const res = await getEconomiaLedgerAggregate({ ...RANGE, select: makeSelect(SCENARIO()) });
  const day = dayOf(res, "2026-08-10");
  assert.ok(day, "the rolled-over period's business date must appear");
  assert.equal(day.totals.collected, 25);
  // exactly once: day sums, session sums and the grand total must all agree
  const sumSessions = res.sessions.reduce((n, s) => n + Number(s.totals.collected), 0);
  const sumDays = res.porGiorno.reduce((n, d) => n + Number(d.totals.collected), 0);
  assert.equal(sumSessions, 75);
  assert.equal(sumDays, 75);
  assert.equal(res.totals.collected, 75);
  // and no business date is emitted twice
  const dates = res.porGiorno.map((d) => d.businessDate);
  assert.equal(dates.length, new Set(dates).size);
});

test("N-11 · H · service ownership is exact — no foreign money joins the service", async () => {
  const res = await getEconomiaLedgerAggregate({ ...RANGE, select: makeSelect(SCENARIO()) });
  assert.equal(svcOf(res, "ROLL-1").totals.collected, 25);
  assert.equal(svcOf(res, "OPEN-1").totals.collected, 20);
  assert.equal(svcOf(res, "CLOSED-1").totals.collected, 30);
});

test("N-11 · I · payment methods are carried through correctly", async () => {
  const res = await getEconomiaLedgerAggregate({ ...RANGE, select: makeSelect(SCENARIO()) });
  const s = svcOf(res, "ROLL-1");
  assert.equal(s.paymentTotals.efectivo, 12);
  assert.equal(s.paymentTotals.tarjeta, 13);
  assert.equal(s.paymentTotals.bizum, 0);
  // grand totals include the rolled-over split exactly once
  assert.equal(res.paymentTotals.efectivo, 12);
  assert.equal(res.paymentTotals.tarjeta, 43); // 13 rolled_over + 30 closed
  assert.equal(res.paymentTotals.bizum, 20);
});

// ═══════════════════════════════════════════════════════════════════════════
// L — N-6 COMPOSITE SCOPING IS UNCHANGED
// ═══════════════════════════════════════════════════════════════════════════

test("N-11 · L · a foreign-session event does NOT leak in via the newly visible session", async () => {
  // Reproduces live staging: d20ee320 carries an event for order #999004, but that
  // order actually belongs to session b87e7364. N-6's composite (session, order) scoping
  // must keep dropping it even now that the session is reportable.
  const t = SCENARIO();
  t.service_sessions.push(session("OTHER-1", "closed", "2026-08-19", { closed_at: "2026-08-19T20:00:00Z" }));
  t.ordenes.push(order("#FOREIGN", "OTHER-1", 5));
  // event stamped with ROLL-1's session id, but the ORDER lives in OTHER-1
  t.order_financial_events.push(payment("#FOREIGN", "ROLL-1", 5, "efectivo"));

  const res = await getEconomiaLedgerAggregate({ ...RANGE, select: makeSelect(t) });
  assert.equal(svcOf(res, "ROLL-1").totals.collected, 25, "foreign event must NOT be counted here");
  assert.equal(dayOf(res, "2026-08-10").totals.collected, 25);
});

// ═══════════════════════════════════════════════════════════════════════════
// J — LATE PAYMENT / CURRENT-RECONCILED SEMANTICS (N-8)
// ═══════════════════════════════════════════════════════════════════════════

test("N-11 · J · a closed service's late payment still diverges from its snapshot", async () => {
  // Mirrors live staging 33174121: the service closed with real unpaid exposure, and the
  // rest of the money arrived afterwards. Note collectedAmount is capped at the ticket's
  // own total (currentServiceCloseout line ~119, `Math.min(amount, ...)`), so a late
  // payment can only close a genuine gap — it can never inflate collected past gross.
  const t = SCENARIO();
  t.ordenes = t.ordenes.map((o) => (o.id === "#B1" ? { ...o, totale: 45 } : o));
  // at close: 30 collected of 45 owed -> 15 unpaid, which is what the snapshot registered
  t.order_financial_events.push(payment("#B1", "CLOSED-1", 15, "efectivo", "2026-08-22T09:00:00Z"));
  const res = await getEconomiaLedgerAggregate({ ...RANGE, select: makeSelect(t) });
  const s = svcOf(res, "CLOSED-1");
  assert.equal(s.closeoutSnapshot.totals.collected, 30, "the snapshot is never rewritten");
  assert.equal(s.totals.collected, 45, "current reconciled includes the late payment");
  assert.equal(s.totals.unpaid, 0, "the exposure recorded at close is exactly what arrived");
  assert.equal(s.divergesFromCloseout, true);
  assert.equal(res.divergesFromCloseout, true);
  assert.equal(res.economicSemantic, "current_reconciled");
});

// ═══════════════════════════════════════════════════════════════════════════
// D (reader level) — ROLLED_OVER WITHOUT A CLOSEOUT ROW
// ═══════════════════════════════════════════════════════════════════════════

test("N-11 · D · rolled_over without a closeout row: full current economics, zero invention", async () => {
  const t = SCENARIO();
  assert.equal(t.service_closeouts.filter((c) => c.service_session_id === "ROLL-1").length, 0);
  const res = await getEconomiaLedgerAggregate({ ...RANGE, select: makeSelect(t) });
  const s = svcOf(res, "ROLL-1");
  assert.equal(s.totals.collected, 25, "current economics must be fully available");
  assert.equal(s.closeoutSnapshot, null, "no snapshot may be fabricated");
  assert.equal(s.closeoutSnapshotAbsentReason, "service_rolled_over");
  assert.equal(s.divergesFromCloseout, false, "nothing to diverge from");
});

// ═══════════════════════════════════════════════════════════════════════════
// F — OTHER STATUSES ARE NOT ADMITTED
// ═══════════════════════════════════════════════════════════════════════════

test("N-11 · F · a session with an unknown status contributes nothing", async () => {
  const t = SCENARIO();
  t.service_sessions.push(session("BOGUS-1", "cancelled", "2026-08-18"));
  t.ordenes.push(order("#X1", "BOGUS-1", 999));
  t.order_financial_events.push(payment("#X1", "BOGUS-1", 999, "efectivo"));
  const res = await getEconomiaLedgerAggregate({ ...RANGE, select: makeSelect(t) });
  assert.equal(svcOf(res, "BOGUS-1"), null, "an unclassified status must not be reported");
  assert.equal(dayOf(res, "2026-08-18"), null);
  assert.equal(res.totals.collected, 75, "and must not reach the grand total");
});

// ═══════════════════════════════════════════════════════════════════════════
// THE DUAL-STORE READ FOR HISTORICAL SESSIONS
// ═══════════════════════════════════════════════════════════════════════════

test("N-11 · a rolled-over session's ARCHIVED orders are read, not reported as zero", async () => {
  // The 480eca89 / 4f260f1e defect class: reading only the live table for a historical
  // session reports real money as 0.00. Inert on today's staging data (no archived row
  // points at a rolled_over session) — pinned here so it stays correct if that changes.
  const t = SCENARIO();
  t.ordenes = t.ordenes.filter((o) => o.service_session_id !== "ROLL-1");
  t.storico = [ // language-guard: allow-legacy storico is the same existing archive table name, populated here to exercise the dual-store read, not new vocabulary
    { id: "#R1", orden_id: "#R1", service_session_id: "ROLL-1", totale: 12, estado: "RETIRADO", metodo_pago: "efectivo", ts: 1786351294893 },
    { id: "#R2", orden_id: "#R2", service_session_id: "ROLL-1", totale: 13, estado: "RETIRADO", metodo_pago: "tarjeta", ts: 1786351358211 },
  ];
  const res = await getEconomiaLedgerAggregate({ ...RANGE, select: makeSelect(t) });
  assert.equal(svcOf(res, "ROLL-1").totals.collected, 25, "archived rolled-over orders must be found");
});

// ═══════════════════════════════════════════════════════════════════════════
// K — N-9 REPORTING WINDOW IS UNTOUCHED
// ═══════════════════════════════════════════════════════════════════════════

test("N-11 · K · N-9's business-date window still bounds the reader, no special calendar", async () => {
  const t = SCENARIO();
  // a rolled-over period OUTSIDE the requested window must stay outside it
  t.service_sessions.push(session("ROLL-OLD", "rolled_over", "2020-01-01"));
  t.ordenes.push(order("#OLD", "ROLL-OLD", 40));
  t.order_financial_events.push(payment("#OLD", "ROLL-OLD", 40, "efectivo"));
  const res = await getEconomiaLedgerAggregate({ ...RANGE, select: makeSelect(t) });
  assert.equal(svcOf(res, "ROLL-OLD"), null, "rolled_over gets no exemption from the window");
  assert.equal(dayOf(res, "2020-01-01"), null);
  assert.equal(res.totals.collected, 75);

  // ...and IS included when the window genuinely covers it — same rule as any status
  const wide = await getEconomiaLedgerAggregate({ desde: "2019-01-01", hasta: "2026-08-31", select: makeSelect(t) });
  assert.ok(svcOf(wide, "ROLL-OLD"), "inside the window it is reported like anything else");
  assert.equal(dayOf(wide, "2020-01-01").totals.collected, 40);
});
