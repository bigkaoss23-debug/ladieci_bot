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

// ── P0-C2 — intraday carryover visibility ──────────────────────────────────

test("getOperationalSessionIds: no rollover source -> just the current session", async () => {
  const ids = await getOperationalSessionIds({
    currentCloseout: async () => ({ ok: true, session: { id: "B", status: "open", rollover_source_session_id: null } }),
    select: async () => { throw new Error("should never be called with no rollover_source_session_id"); },
  });
  assert.deepEqual(ids, ["B"]);
});

test("getOperationalSessionIds: rollover source that IS still 'rolled_over' -> both ids", async () => {
  const ids = await getOperationalSessionIds({
    currentCloseout: async () => ({ ok: true, session: { id: "B", status: "open", rollover_source_session_id: "A" } }),
    select: async (table, query) => {
      assert.equal(table, "service_sessions");
      assert.match(query, /id=eq\.A/);
      assert.match(query, /status=eq\.rolled_over/);
      return [{ id: "A" }];
    },
  });
  assert.deepEqual(ids, ["B", "A"]);
});

test("getOperationalSessionIds: rollover source that is NOT 'rolled_over' (e.g. a destructive V2/V3 close) -> excluded", async () => {
  const ids = await getOperationalSessionIds({
    currentCloseout: async () => ({ ok: true, session: { id: "B", status: "open", rollover_source_session_id: "A" } }),
    select: async () => [], // the status=eq.rolled_over filter found nothing — A is 'closed', not carried
  });
  assert.deepEqual(ids, ["B"], "A's orders are already archived/gone under V2/V3 close — nothing to widen for");
});

test("getOperationalSessionIds: a read error on the source lookup fails closed to just the current session", async () => {
  const ids = await getOperationalSessionIds({
    currentCloseout: async () => ({ ok: true, session: { id: "B", status: "open", rollover_source_session_id: "A" } }),
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

test("getOperationalSessionIds: never widens beyond one hop even if the source itself has a further source", async () => {
  // A's own rollover_source_session_id (if any) is never consulted — only
  // B's. This is what keeps the scope structurally bounded to exactly one
  // intraday boundary, never a multi-day chain.
  const ids = await getOperationalSessionIds({
    currentCloseout: async () => ({ ok: true, session: { id: "C", status: "open", rollover_source_session_id: "B" } }),
    select: async (table, query) => {
      assert.match(query, /id=eq\.B/);
      return [{ id: "B" }]; // does NOT also return B's own source "A" — never asked for it
    },
  });
  assert.deepEqual(ids, ["C", "B"]);
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
