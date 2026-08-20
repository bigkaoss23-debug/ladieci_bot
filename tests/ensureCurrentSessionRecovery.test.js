"use strict";
// LEGACY WRITER HARDENING — the page-load ensure is INERT.
//
// WHAT THIS FILE USED TO PROVE. From S2-7D6F until now, the silent page-load
// ensure carried a "recovery pre-check": it read the current session, decided
// whether that session was due for rollover, and if so called
// language-guard: allow-legacy chiudiServizio is the existing legacy close function, named here only to describe the retired call path, not new vocabulary
// performIncidentSafeRollover -> chiudiServizio, i.e. a REAL, MUTATING CLOSE
// attributed to whichever operator's browser happened to be open. This file
// was the mechanical proof that it called the rollover at exactly the right
// moments and reacted correctly to success / deferred / hard failure.
//
// P0-C1 later put that call behind LEGACY_AUTOMATIC_LIFECYCLE_ENABLED, so the
// invariant "APP_RELOAD_MUTATES_SERVICE = NO" held only by environment
// variable. One unset env var in one deploy and a page load could close a live
// service again. close_source 'ensure_reconcile' in the live staging data is
// that path having fired for real, once.
//
// WHAT THIS FILE PROVES NOW. The call site is gone, not gated. Whatever the
// clock says, whatever state the current session is in, and under every
// configuration, a page load performs ZERO lifecycle mutations: it reads, it
// classifies, it returns. There is no seam left to inject a rollover into and
// no flag left to flip -- which is the point, and is why the scenario matrix
// below is expressed as "for every state, zero writes".
//
// The rollover ENGINE itself is unchanged and still fully covered:
//   * tests/incidentSafeRollover.test.js -- the orchestrator's own contract;
//   * tests/staleServiceSessionPendingActivityGuard.test.js -- the frozen
//     stale-session-with-pending-activity scenario, now driven through the
//     orchestrator directly (which is how F-10's forgotten-close path reaches
//     it) instead of through a browser refresh.
// Nothing about incident classification, snapshots or the close engine is
// retired by this change; only the page load's ability to trigger them.
//
// Run: node tests/ensureCurrentSessionRecovery.test.js
const { createEnsureCurrentServiceSession, ENSURE_CODE } = require("../src/serviceSessions/ensureServiceSession");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };

// language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values, used here only as fixture labels on legacy-era sessions, not new vocabulary
const LUNCH_STALE = Object.freeze({ id: "uuid-lunch", service_kind: "PRANZO", business_date: "2026-07-14", status: "open", opened_at: "x" });
const DINNER_TODAY = Object.freeze({ id: "uuid-dinner", service_kind: "SERA", business_date: "2026-07-15", status: "open", opened_at: "x" });
const CLOSING_NOW = Object.freeze({ id: "uuid-closing", service_kind: "SERA", business_date: "2026-07-15", status: "closing", opened_at: "x" });
const OPERATIONAL = Object.freeze({ id: "uuid-operational", service_kind: null, business_date: "2026-07-15", status: "open", opened_at: "x", lifecycle_semantics: "operational_service_v1" });

// A fake DB that RECORDS every write it is asked to perform. Nothing in the
// production module can reach these any more -- that is exactly what the
// assertions check.
function fakeDb({ current = null, hasHistoryToday = false, readThrows = false } = {}) {
  const db = { current, hasHistoryToday, ensureCalls: [], writes: [] };
  db.lifecycle = {
    async currentCloseout() {
      if (readThrows) throw new Error("simulated transport failure");
      if (!db.current) return { ok: true, code: "NO_SERVICE_SESSION", session: null };
      return { ok: true, session: db.current };
    },
    async ensure({ actor, source }) {
      db.ensureCalls.push({ actor, source });
      if (db.current) return { ok: true, code: "REUSED", created: false, session: db.current };
      if (db.hasHistoryToday) {
        return { ok: false, code: "NO_OPEN_SERVICE", businessDate: "2026-07-15", hadPriorServiceToday: true };
      }
      return { ok: false, code: "NO_OPEN_SERVICE", businessDate: "2026-07-15" };
    },
    // Any of these being called at all is a failure of the invariant.
    async beginClose(args) { db.writes.push({ op: "beginClose", args }); return { ok: true }; },
    async completeClose(args) { db.writes.push({ op: "completeClose", args }); return { ok: true }; },
    async openOperational(args) { db.writes.push({ op: "openOperational", args }); return { ok: true }; },
    async resolveOperationalContext(args) { db.writes.push({ op: "resolveOperationalContext", args }); return { ok: true }; },
  };
  return db;
}

const make = (db) => createEnsureCurrentServiceSession({ sessionLifecycle: db.lifecycle });

(async () => {
  // == 1. THE CORE INVARIANT - every session state, zero writes ==
  console.log("\n== 1. for EVERY current-session state, a page load performs zero lifecycle writes ==");
  const states = [
    ["a stale previous-day session (the classic rollover-due case)", LUNCH_STALE],
    ["a same-day session past its own close boundary", DINNER_TODAY],
    ["a session mid-close", CLOSING_NOW],
    ["a new-era operational service", OPERATIONAL],
    ["no session at all", null],
  ];
  for (const [label, current] of states) {
    const db = fakeDb({ current });
    await make(db)({ actor: "owner", source: "auto_entry" });
    assert("1: " + label + " -> zero lifecycle writes", db.writes.length === 0, JSON.stringify(db.writes));
  }

  // == 2. The read-only discriminator still answers correctly ==
  console.log("\n== 2. the read-only outcomes are unchanged ==");
  {
    const db = fakeDb({ current: LUNCH_STALE });
    const r = await make(db)({ actor: "owner", source: "auto_entry" });
    assert("2: a still-open session is REUSED and handed back, never force-closed",
      r.success === true && r.created === false && r.code === ENSURE_CODE.REUSED && r.session.id === LUNCH_STALE.id, JSON.stringify(r));
    assert("2: the discriminator is not even consulted when a session is already active", db.ensureCalls.length === 0);
  }
  {
    const db = fakeDb({ current: CLOSING_NOW });
    const r = await make(db)({ actor: "owner", source: "auto_entry" });
    assert("2: a 'closing' session is surfaced as its own typed state, not waited on or acted upon",
      r.success === false && r.code === ENSURE_CODE.SERVICE_SESSION_CLOSING && r.session.id === CLOSING_NOW.id, JSON.stringify(r));
    assert("2: still zero writes for a closing session", db.writes.length === 0);
  }
  {
    const db = fakeDb({ current: null, hasHistoryToday: true });
    const r = await make(db)({ actor: "owner", source: "auto_entry" });
    assert("2 (G-1): a finalized Business Day reads as ordinary idle, not an exception",
      r.success === false && r.code === ENSURE_CODE.NO_OPEN_SERVICE && r.session === null, JSON.stringify(r));
    assert("2: the read-only discriminator WAS consulted when nothing is active", db.ensureCalls.length === 1);
  }
  {
    const db = fakeDb({ current: null });
    const r = await make(db)({ actor: "owner", source: "auto_entry" });
    assert("2: a virgin Business Day is also NO_OPEN_SERVICE, session null",
      r.success === false && r.code === ENSURE_CODE.NO_OPEN_SERVICE && r.session === null, JSON.stringify(r));
  }

  // == 3. Input validation is unchanged and still pre-empts every read ==
  console.log("\n== 3. invalid actor is refused before anything is read ==");
  for (const bad of [undefined, null, "", "   ", 42, {}]) {
    const db = fakeDb({ current: DINNER_TODAY });
    const r = await make(db)({ actor: bad, source: "auto_entry" });
    assert("3: actor " + JSON.stringify(bad) + " -> INVALID_ACTOR, nothing read, nothing written",
      r.success === false && r.code === ENSURE_CODE.INVALID_ACTOR && r.session === null
        && db.ensureCalls.length === 0 && db.writes.length === 0, JSON.stringify(r));
  }

  // == 4. A read failure degrades gracefully, and still never writes ==
  console.log("\n== 4. a currentCloseout() transport failure degrades to the discriminator ==");
  {
    const db = fakeDb({ current: null, readThrows: true, hasHistoryToday: true });
    const r = await make(db)({ actor: "owner", source: "auto_entry" });
    assert("4: the throw is absorbed - ensure still returns a typed answer",
      r.success === false && r.code === ENSURE_CODE.NO_OPEN_SERVICE, JSON.stringify(r));
    assert("4: the read-only discriminator still ran underneath", db.ensureCalls.length === 1);
    assert("4: zero writes even on the failure path", db.writes.length === 0);
  }

  // == 5. Idempotency / concurrency - repetition changes nothing ==
  console.log("\n== 5. repeated and concurrent page loads converge, with zero writes ==");
  {
    const db = fakeDb({ current: DINNER_TODAY });
    const ensure = make(db);
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => ensure({ actor: "owner", source: "auto_entry" })));
    assert("5: five concurrent page loads all return the SAME session",
      results.every((r) => r.success === true && r.session.id === DINNER_TODAY.id), JSON.stringify(results.map((r) => r.code)));
    assert("5: none of them created anything", results.every((r) => r.created === false));
    assert("5: zero writes across all five", db.writes.length === 0, JSON.stringify(db.writes));
  }
  {
    const db = fakeDb({ current: null, hasHistoryToday: true });
    const ensure = make(db);
    const a = await ensure({ actor: "owner", source: "auto_entry" });
    const b = await ensure({ actor: "other_operator", source: "auto_entry" });
    assert("5: a second operator's page load reaches the identical verdict",
      a.code === b.code && a.session === null && b.session === null, JSON.stringify([a.code, b.code]));
    assert("5: still zero writes", db.writes.length === 0);
  }

  // == 6. Structural - the module cannot mutate even if someone tries ==
  console.log("\n== 6. there is no seam left to inject a mutation into ==");
  {
    // The old signature accepted schedule / now / performRollover /
    // automaticLifecycleEnabled. Passing them now is inert: the factory
    // ignores unknown options, so a stale caller cannot resurrect the
    // behaviour by supplying them.
    const db = fakeDb({ current: LUNCH_STALE });
    let injectedCalled = false;
    const ensure = createEnsureCurrentServiceSession({
      sessionLifecycle: db.lifecycle,
      performRollover: async () => { injectedCalled = true; return { success: true }; },
      automaticLifecycleEnabled: () => true,
      now: () => new Date(),
    });
    const r = await ensure({ actor: "owner", source: "auto_entry" });
    assert("6: an injected performRollover is NEVER called - the seam is gone, not merely defaulted off", injectedCalled === false);
    assert("6: an injected automaticLifecycleEnabled:true changes nothing", db.writes.length === 0);
    assert("6: the still-open session is simply handed back", r.code === ENSURE_CODE.REUSED, JSON.stringify(r));
  }

  console.log("");
  console.log("=== RESULT: " + pass + " passed, " + fail + " failed ===");
  process.exit(fail === 0 ? 0 : 1);
})();
