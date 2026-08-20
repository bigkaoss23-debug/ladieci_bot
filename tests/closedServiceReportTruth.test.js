"use strict";
// ===============================================================
// UAT-P1-B — a FINALIZED service must keep reporting the truth.
//
// Reproduces the real 2026-08-20 staging service 4f260f1e: an operator
// Finalizar (close_source='operator_finalizar_v3') closed the service and
// left its 7 order rows in `ordenes`, while the reader only looked in
// `storico`. The report collapsed to Tickets 0 / 0.00 EUR even though the  // language-guard: allow-legacy storico is the existing archive table name this reader queries, used verbatim in fixtures, not new vocabulary
// official service_closeouts snapshot held gross 143.50 / paid 124.00.
//
// TEST C: the closed service reports its own snapshot, not zeros.
// TEST D: header, tickets and money stay pinned to ONE service id.
// ===============================================================

const assert = require("node:assert/strict");
const test = require("node:test");
const { createCurrentServiceCloseout } = require("../src/closeout/currentServiceCloseout");

const SERVICE_A = "4f260f1e-8e1c-46f2-9db5-86f3446ff759";
const SERVICE_B = "00000000-0000-4000-8000-0000000000bb";

const closedSessionA = () => ({
  id: SERVICE_A, business_date: "2026-08-20",
  opened_at: "2026-08-20T07:18:52Z", closed_at: "2026-08-20T09:34:44Z",
  status: "closed", lifecycle_semantics: "operational_service_v1",
});
const identity = (value) => ({ currentCloseout: async () => value });

// The real staging snapshot, in cents, exactly as service_closeouts holds it.
const REAL_SNAPSHOT = {
  id: "6a953b9b-c50f-48f1-9a90-80987af0a380",
  service_session_id: SERVICE_A,
  gross_sales_cents: 14350, net_sales_cents: 14350,
  paid_amount_cents: 12400, unpaid_exposure_cents: 1950,
  cash_amount_cents: 7250, card_amount_cents: 1200,
  bizum_amount_cents: 3950, other_amount_cents: 0,
  order_count: 7, total_void_cents: 1000, total_refunds_cents: 0,
  incident_count: 2,
};

// Orders left in `ordenes` by the V3 operator Finalizar — `storico` is empty,  // language-guard: allow-legacy storico is the existing archive table name this reader queries, used verbatim in fixtures, not new vocabulary
// which is precisely what produced the zeros in the UAT.
const ORDENES_ROWS = [
  { id: "#999006", service_session_id: SERVICE_A, totale: 10, estado: "CANCELADO" },
  { id: "#999007", service_session_id: SERVICE_A, totale: 27, cobrado: true, metodo_pago: "efectivo" },
  { id: "#999008", service_session_id: SERVICE_A, totale: 19.5, estado: "POR_CONFIRMAR" },
  { id: "#999009", service_session_id: SERVICE_A, totale: 34.5, cobrado: true, metodo_pago: "efectivo" },
  { id: "#999010", service_session_id: SERVICE_A, totale: 12, cobrado: true, metodo_pago: "tarjeta" },
  { id: "#999011", service_session_id: SERVICE_A, totale: 11, cobrado: true, metodo_pago: "efectivo" },
  { id: "#999012", service_session_id: SERVICE_A, totale: 39.5, cobrado: true, metodo_pago: "bizum" },
];

function selectFor({ storico = [], ordenes = [], closeouts = [], calls = [] } = {}) {  // language-guard: allow-legacy storico is the existing archive table name this reader queries, used verbatim in fixtures, not new vocabulary
  return async (table, query) => {
    calls.push([table, query]);
    if (table === "storico") return storico;  // language-guard: allow-legacy storico is the existing archive table name this reader queries, used verbatim in fixtures, not new vocabulary
    if (table === "ordenes") return ordenes;
    if (table === "service_closeouts") return closeouts;
    return [];
  };
}

// ── TEST C — the closed service reports its own snapshot ──────────────────
test("TEST C: a finalized service reports the official closeout, never zeros", async () => {
  const s = closedSessionA();
  const out = await createCurrentServiceCloseout({
    select: selectFor({ storico: [], ordenes: ORDENES_ROWS, closeouts: [REAL_SNAPSHOT] }),  // language-guard: allow-legacy storico is the existing archive table name this reader queries, used verbatim in fixtures, not new vocabulary
    sessionLifecycle: identity({ ok: true, code: "OK", session: s }),
  })();

  assert.equal(out.serviceSessionId, SERVICE_A, "header service identity");
  assert.equal(out.status, "closed");
  assert.equal(out.businessDate, "2026-08-20");
  assert.equal(out.openedAt, s.opened_at);
  assert.equal(out.closedAt, s.closed_at);

  // The exact figures the UAT proved, sourced from the snapshot.
  assert.equal(out.counts.tickets, 7);
  assert.equal(out.totals.gross, 143.5);
  assert.equal(out.totals.collected, 124);
  assert.equal(out.totals.unpaid, 19.5);
  assert.equal(out.totals.refunded, 0);
  assert.equal(out.totals.voided, 10);
  assert.equal(out.totals.difference, 19.5);
  assert.deepEqual(out.paymentTotals, { efectivo: 72.5, tarjeta: 12, bizum: 39.5, other: 0 });
  assert.equal(out.counts.incidents, 2);
  assert.equal(out.financialSource, "official_closeout");
  assert.equal(out.closeoutId, REAL_SNAPSHOT.id);

  // Drill-down rows survive even though `storico` is empty.  // language-guard: allow-legacy storico is the existing archive table name this reader queries, used verbatim in fixtures, not new vocabulary
  assert.ok(out.tickets.length > 0, "ticket rows must not be empty");
});

test("TEST C2: zeros are impossible while a snapshot exists, even with no order rows at all", async () => {
  const out = await createCurrentServiceCloseout({
    select: selectFor({ storico: [], ordenes: [], closeouts: [REAL_SNAPSHOT] }),  // language-guard: allow-legacy storico is the existing archive table name this reader queries, used verbatim in fixtures, not new vocabulary
    sessionLifecycle: identity({ ok: true, code: "OK", session: closedSessionA() }),
  })();
  assert.equal(out.counts.tickets, 7);
  assert.equal(out.totals.gross, 143.5);
  assert.equal(out.totals.collected, 124);
});

test("a legacy close whose rows are in storico still reports, and is not double counted", async () => {  // language-guard: allow-legacy storico is the existing archive table name this reader queries, used verbatim in fixtures, not new vocabulary
  const s = closedSessionA();
  const archived = [{ orden_id: "#999009", service_session_id: SERVICE_A, totale: 34.5, cobrado: true, metodo_pago: "efectivo" }];
  const out = await createCurrentServiceCloseout({
    // Same order present in BOTH stores: must appear exactly once.
    select: selectFor({ storico: archived, ordenes: [ORDENES_ROWS[3]], closeouts: [] }),  // language-guard: allow-legacy storico is the existing archive table name this reader queries, used verbatim in fixtures, not new vocabulary
    sessionLifecycle: identity({ ok: true, code: "OK", session: s }),
  })();
  assert.equal(out.tickets.length, 1, "de-duplicated by order id");
  assert.equal(out.serviceSessionId, SERVICE_A);
});

test("a closed service with no snapshot keeps the recomputed report rather than zeros", async () => {
  const out = await createCurrentServiceCloseout({
    select: selectFor({ storico: [], ordenes: ORDENES_ROWS, closeouts: [] }),  // language-guard: allow-legacy storico is the existing archive table name this reader queries, used verbatim in fixtures, not new vocabulary
    sessionLifecycle: identity({ ok: true, code: "OK", session: closedSessionA() }),
  })();
  assert.ok(out.tickets.length > 0);
  assert.ok(out.totals.gross > 0, "must not collapse to zero");
  assert.notEqual(out.financialSource, "official_closeout");
});

// ── TEST D — no cross-service mixing ──────────────────────────────────────
test("TEST D: every read is pinned to the reported service id", async () => {
  const calls = [];
  await createCurrentServiceCloseout({
    select: selectFor({ storico: [], ordenes: ORDENES_ROWS, closeouts: [REAL_SNAPSHOT], calls }),  // language-guard: allow-legacy storico is the existing archive table name this reader queries, used verbatim in fixtures, not new vocabulary
    sessionLifecycle: identity({ ok: true, code: "OK", session: closedSessionA() }),
  })();
  assert.ok(calls.length > 0);
  for (const [table, query] of calls) {
    assert.match(query, new RegExp(`service_session_id=eq\\.${SERVICE_A}`), `${table} query must pin the service`);
    assert.doesNotMatch(query, new RegExp(SERVICE_B), `${table} must never reach another service`);
  }
  assert.ok(calls.some(([t]) => t === "service_closeouts"), "snapshot is consulted");
});

test("TEST D: an order row belonging to another service is refused, never blended in", async () => {
  await assert.rejects(
    () => createCurrentServiceCloseout({
      select: selectFor({
        storico: [],  // language-guard: allow-legacy storico is the existing archive table name this reader queries, used verbatim in fixtures, not new vocabulary
        ordenes: [...ORDENES_ROWS, { id: "#B1", service_session_id: SERVICE_B, totale: 500, cobrado: true }],
        closeouts: [REAL_SNAPSHOT],
      }),
      sessionLifecycle: identity({ ok: true, code: "OK", session: closedSessionA() }),
    })(),
    (e) => e.code === "MIXED_SERVICE_SESSION_ROWS",
  );
});

test("TEST D: a closeout row belonging to another service is refused", async () => {
  await assert.rejects(
    () => createCurrentServiceCloseout({
      select: selectFor({
        storico: [], ordenes: ORDENES_ROWS,  // language-guard: allow-legacy storico is the existing archive table name this reader queries, used verbatim in fixtures, not new vocabulary
        closeouts: [{ ...REAL_SNAPSHOT, service_session_id: SERVICE_B }],
      }),
      sessionLifecycle: identity({ ok: true, code: "OK", session: closedSessionA() }),
    })(),
    (e) => e.code === "MIXED_CLOSEOUT_SESSION_ROW",
  );
});

// ── An OPEN service must be untouched by all of the above ─────────────────
test("an open service still reports live and never consults the snapshot", async () => {
  const calls = [];
  const s = { ...closedSessionA(), status: "open", closed_at: null };
  const out = await createCurrentServiceCloseout({
    select: selectFor({ ordenes: [ORDENES_ROWS[1]], closeouts: [REAL_SNAPSHOT], calls }),
    sessionLifecycle: identity({ ok: true, code: "OK", session: s }),
  })();
  assert.equal(out.status, "open");
  assert.equal(out.totals.gross, 27, "live recomputation, not the snapshot");
  assert.equal(out.financialSource, undefined);
  assert.equal(calls.some(([t]) => t === "service_closeouts"), false, "no snapshot read while open");
  assert.equal(calls.some(([t]) => t === "storico"), false, "no archive read while open");  // language-guard: allow-legacy storico is the existing archive table name this reader queries, used verbatim in fixtures, not new vocabulary
});
