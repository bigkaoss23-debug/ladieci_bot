"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  getCurrentOperationalSession,
  serviceSessionQuery,
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
