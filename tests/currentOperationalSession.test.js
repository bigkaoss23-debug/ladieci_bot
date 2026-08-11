"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  getCurrentOperationalSession,
  serviceSessionQuery,
  getOperationalSessionIds,
  serviceSessionsQuery,
} = require("../src/serviceSessions/currentOperationalSession");

test("returns only the lifecycle-authoritative open service", async () => {
  const session = { id: "service-open", status: "open", opened_at: "2026-08-02T09:00:00Z" };
  const result = await getCurrentOperationalSession({
    currentCloseout: async () => ({ ok: true, session }),
  });
  assert.equal(result, session);
});

test("a closed service is not operational", async () => {
  const result = await getCurrentOperationalSession({
    currentCloseout: async () => ({ ok: true, session: { id: "old", status: "closed" } }),
  });
  assert.equal(result, null);
});

// P0-C1 — a session mid-close still owns real, unresolved operational facts
// (orders, tables) until it actually reaches 'closed'. Before P0-C1 this
// returned null, which is exactly why Cocina/Listos/Mesa went dark for as
// long as a close attempt was in progress or stuck — see
// SERVICE_LIFECYCLE_ECONOMIC_BOUNDARY_AUDIT_REPORT.md §4/§7.6.
test("a session mid-close ('closing') IS still operational", async () => {
  const session = { id: "mid-close", status: "closing", opened_at: "2026-08-10T08:07:41Z" };
  const result = await getCurrentOperationalSession({
    currentCloseout: async () => ({ ok: true, session }),
  });
  assert.equal(result, session);
});

test("still scoped to THIS session's own id — closing does not widen to any other session", async () => {
  // The fix widens WHICH statuses count as operational, never which session
  // id is used. A 'closed' session (today's or any prior day's) stays
  // excluded no matter what — this is what proves a stale multi-day-old
  // ticket cannot be resurrected by this change.
  const result = await getCurrentOperationalSession({
    currentCloseout: async () => ({ ok: true, session: { id: "yesterday", status: "closed" } }),
  });
  assert.equal(result, null);
});

test("transport/lifecycle errors fail closed instead of broadening the read", async () => {
  await assert.rejects(
    () => getCurrentOperationalSession({ currentCloseout: async () => ({ ok: false, code: "DB_DOWN" }) }),
    (error) => error && error.code === "DB_DOWN",
  );
});

test("PostgREST scope always pins service_session_id first", () => {
  assert.equal(
    serviceSessionQuery("abc/123", "estado=eq.EN_COCINA"),
    "service_session_id=eq.abc%2F123&estado=eq.EN_COCINA",
  );
  assert.throws(() => serviceSessionQuery(null, "estado=eq.EN_COCINA"), /SERVICE_SESSION_ID_REQUIRED/);
});

// ── P0-C2 → P0-C3 — intraday carryover visibility, business-date-scoped ────
//
// P0-C2's original design bounded this to "one rollover-chain hop back" —
// these tests used to assert exactly that. P0-C3 proved (live, on the real
// stuck session, before touching any code — P0_C3 report §2) that the hop-
// count rule kept showing a PREVIOUS business_date's residue as if it were
// ordinary same-day carryover, because 'rolled_over' alone can't tell
// "this morning" from "yesterday". The correct dimension was always
// business_date. Rewritten below for the new query shape; the OLD "never
// widens beyond one hop" case is replaced by the NEW, actually-correct
// "never widens beyond the current business_date" case.

test("getOperationalSessionIds: select not provided -> just the current session", async () => {
  const ids = await getOperationalSessionIds({
    currentCloseout: async () => ({ ok: true, session: { id: "B", status: "open", business_date: "2026-08-11" } }),
  });
  assert.deepEqual(ids, ["B"]);
});

// language-guard: allow-legacy PRANZO is the existing service_kind enum value, exercised throughout this file's own fixtures, not new vocabulary
test("getOperationalSessionIds: same business_date, current + its rolled_over PRANZO source -> both ids", async () => {
  const ids = await getOperationalSessionIds({
    currentCloseout: async () => ({ ok: true, session: { id: "B", status: "open", business_date: "2026-08-11" } }),
    select: async (table, query) => {
      assert.equal(table, "service_sessions");
      assert.match(query, /business_date=eq\.2026-08-11/);
      assert.match(query, /status=in\.\(open,closing,rolled_over\)/);
      return [{ id: "A" }, { id: "B" }];
    },
  });
  assert.deepEqual(ids, ["A", "B"]);
});

test("getOperationalSessionIds: a PREVIOUS business_date's rolled_over session is NEVER included, even though it would have been under the old one-hop rule — the exact live bug this fix closes", async () => {
  const ids = await getOperationalSessionIds({
    // A (2026-08-10, rolled_over) is B's rollover_source_session_id, exactly
    // like the real 9746dfdd->421f93e1 case — but the query below (the real
    // implementation) never even looks at rollover_source_session_id, only
    // business_date, so A structurally cannot leak in regardless.
    currentCloseout: async () => ({
      ok: true,
      session: { id: "B", status: "open", business_date: "2026-08-11", rollover_source_session_id: "A" },
    }),
    select: async (table, query) => {
      assert.match(query, /business_date=eq\.2026-08-11/);
      return [{ id: "B" }]; // the real DB would never return A here — different business_date
    },
  });
  assert.deepEqual(ids, ["B"]);
  assert.ok(!ids.includes("A"), "yesterday's session must never appear in today's operational set");
});

test("getOperationalSessionIds: empty result set -> falls back to just the current session", async () => {
  const ids = await getOperationalSessionIds({
    currentCloseout: async () => ({ ok: true, session: { id: "B", status: "open", business_date: "2026-08-11" } }),
    select: async () => [],
  });
  assert.deepEqual(ids, ["B"]);
});

test("getOperationalSessionIds: current is always included even if the read races and omits it", async () => {
  const ids = await getOperationalSessionIds({
    currentCloseout: async () => ({ ok: true, session: { id: "B", status: "open", business_date: "2026-08-11" } }),
    select: async () => [{ id: "A" }], // hypothetical stale/partial read, missing B itself
  });
  assert.deepEqual(ids, ["A", "B"]);
});

test("getOperationalSessionIds: a read error fails closed to just the current session", async () => {
  const ids = await getOperationalSessionIds({
    currentCloseout: async () => ({ ok: true, session: { id: "B", status: "open", business_date: "2026-08-11" } }),
    select: async () => { throw new Error("transport down"); },
  });
  assert.deepEqual(ids, ["B"], "never widen scope on an error — fail closed, not open");
});

test("getOperationalSessionIds: no current session at all -> empty array", async () => {
  const ids = await getOperationalSessionIds({
    currentCloseout: async () => ({ ok: true, session: null }),
    select: async () => [{ id: "A" }],
  });
  assert.deepEqual(ids, []);
});

test("getCurrentOperationalBusinessDate: returns the current session's own business_date", async () => {
  const { getCurrentOperationalBusinessDate } = require("../src/serviceSessions/currentOperationalSession");
  const date = await getCurrentOperationalBusinessDate({
    currentCloseout: async () => ({ ok: true, session: { id: "B", status: "open", business_date: "2026-08-11" } }),
  });
  assert.equal(date, "2026-08-11");
});

test("getCurrentOperationalBusinessDate: no current session -> null, never the wall clock/calendar date", async () => {
  const { getCurrentOperationalBusinessDate } = require("../src/serviceSessions/currentOperationalSession");
  const date = await getCurrentOperationalBusinessDate({
    currentCloseout: async () => ({ ok: true, session: null }),
  });
  assert.equal(date, null);
});

test("serviceSessionsQuery: a single id produces the byte-identical eq. format serviceSessionQuery already did", () => {
  assert.equal(serviceSessionsQuery(["B"], "estado=eq.EN_COCINA"), serviceSessionQuery("B", "estado=eq.EN_COCINA"));
});

test("serviceSessionsQuery: two ids switch to in.(...)", () => {
  assert.equal(serviceSessionsQuery(["B", "A"], "order=ts.asc"), "service_session_id=in.(B,A)&order=ts.asc");
});

test("serviceSessionsQuery: empty array fails closed, never queries unscoped", () => {
  assert.throws(() => serviceSessionsQuery([], "estado=eq.EN_COCINA"), /SERVICE_SESSION_IDS_REQUIRED/);
});
