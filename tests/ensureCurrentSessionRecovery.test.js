"use strict";
// S2-7D6F recovery pre-check, hardened by SERVICE CLOSEOUT V2 / SLICE 3 into
// an incident-safe rollover — fully controllable fake environment
// (currentCloseout + performRollover + ensure all injectable), driven by an
// explicit clock. Complements tests/ensureServiceSession.test.js (which keeps
// testing the ORIGINAL window-only behavior via graceful fallback when
// currentCloseout is unavailable — the production sessionLifecycle always
// provides it, so this file is the one that exercises the real path).
//
// SLICE 3 changed the contract this file locks in: pending operational
// activity NO LONGER keeps a session that is genuinely due for rollover
// (PRIOR_DAY_STALE / SAME_DAY_TRANSITION_DUE) current forever (RC-2). This
// module no longer even asks whether anything is "pending" — that decision
// now lives entirely inside performIncidentSafeRollover (tested in
// tests/incidentSafeRollover.test.js). What THIS file verifies is narrower
// and more mechanical: does ensureServiceSession.js correctly decide WHEN
// rollover is due, call performRollover exactly then, and react correctly to
// whatever it returns (success / deferred / hard failure)?
//
// Approved contract:
//   1. read the current open/closing session in EVERY window, before the
//      canEnsureSession gate;
//   2. genuinely due for rollover (classifySessionForRollover) -> call
//      performRollover, regardless of what is or isn't pending on it;
//   3. rollover succeeds -> re-enter the window logic from a clean slate —
//      never auto-open a new session outside an allowed window just because
//      the old one just closed;
//   4. rollover deferred (e.g. active rider trip) or hard-fails -> hand back
//      the SAME still-open session, never a dead end;
//   5. not due at all -> hand back the SAME session, no rollover attempted;
//   6. only when nothing recoverable exists does the ordinary window-typed
//      refusal (BETWEEN_SERVICES/AFTER_ORDER_CUTOFF/OUTSIDE_WINDOWS) apply.
const { createEnsureCurrentServiceSession, ENSURE_CODE } = require("../src/serviceSessions/ensureServiceSession");
const { DEFAULT_SCHEDULE } = require("../src/schedule/serviceSchedule");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };

const summer = (h, m = 0, day = 15) => new Date(Date.UTC(2026, 6, day, h - 2, m));

function fakeRecoveryDb({ current = null, rolloverResult = { success: true } } = {}) {
  const db = {
    current, rolloverResultSpec: rolloverResult,
    inserts: 0, ensureCalls: [], rolloverCalls: [],
  };
  db.lifecycle = {
    async currentCloseout() {
      if (!db.current) return { ok: true, code: "NO_SERVICE_SESSION", session: null };
      return { ok: true, session: db.current };
    },
    async ensure({ actor, serviceKind, source }) {
      db.ensureCalls.push({ actor, serviceKind, source });
      if (db.current) {
        if (db.current.status === "closing") return { ok: false, code: "SERVICE_SESSION_CLOSING", session: db.current };
        if (db.current.service_kind !== serviceKind) {
          return {
            ok: false,
            code: db.current.service_kind === "PRANZO" ? "LUNCH_SESSION_STILL_ACTIVE" : "OTHER_SERVICE_STILL_ACTIVE",
            session: db.current,
          };
        }
        return { ok: true, code: "REUSED", created: false, session: db.current };
      }
      db.inserts++;
      db.current = { id: "uuid-" + db.inserts, service_kind: serviceKind, business_date: "2026-07-15", status: "open", opened_at: "x" };
      return { ok: true, code: "CREATED", created: true, session: db.current };
    },
  };
  db.performRollover = async ({ session, actor, source }) => {
    db.rolloverCalls.push({ sessionId: session.id, actor, source });
    const result = typeof db.rolloverResultSpec === "function" ? db.rolloverResultSpec() : db.rolloverResultSpec;
    if (result && result.success === true) db.current = null; // simulate the archive actually completing
    return result;
  };
  return db;
}

const make = (db, when) => createEnsureCurrentServiceSession({
  sessionLifecycle: db.lifecycle, schedule: DEFAULT_SCHEDULE, now: () => when,
  performRollover: db.performRollover,
});

(async () => {
  console.log("\n══ 1. PRANZO open + due (past 17:30) at 17:45 (BETWEEN_SERVICES window) -> rollover attempted, then window refusal ══");
  {
    // SLICE 3: this used to be "pending order -> REUSED, no rollover attempted
    // at all". Now: PRANZO past its own 17:30 boundary is SAME_DAY_TRANSITION_DUE
    // regardless of what is pending on it — rollover is ALWAYS attempted. On
    // success the window logic resumes from a clean slate; at 17:45 that is the
    // BETWEEN_SERVICES buffer, so no new session opens (never invent one
    // outside a valid window just because the old one just closed).
    const db = fakeRecoveryDb({ current: { id: "uuid-lunch", service_kind: "PRANZO", business_date: "2026-07-15", status: "open", opened_at: "x" } });
    const r = await make(db, summer(17, 45))({ actor: "operator" });
    assert("1: rollover WAS attempted (PRANZO past 17:30 is due, regardless of pending activity)", db.rolloverCalls.length === 1 && db.rolloverCalls[0].source === "ensure_reconcile", JSON.stringify(db.rolloverCalls));
    assert("1: rollover succeeded, so the window logic resumed and found BETWEEN_SERVICES", r.success === false && r.code === ENSURE_CODE.BETWEEN_SERVICES && r.session === null, JSON.stringify(r));
    assert("1: no new session created (outside a valid window)", db.inserts === 0);
  }

  console.log("\n══ 2. PRANZO open + due, rollover deferred (active rider trip) -> same session, full access ══");
  {
    const db = fakeRecoveryDb({
      current: { id: "uuid-lunch2", service_kind: "PRANZO", business_date: "2026-07-15", status: "open", opened_at: "x" },
      rolloverResult: { success: false, skipped: true, deferred: true, reason: "active_rider_trip" },
    });
    const r = await make(db, summer(17, 45))({ actor: "operator" });
    assert("2: ALLOWED (REUSED), the SAME session", r.success && r.code === ENSURE_CODE.REUSED && r.session.id === "uuid-lunch2", JSON.stringify(r));
    assert("2: a rollover WAS attempted (due, past 17:30 boundary)...", db.rolloverCalls.length === 1);
    assert("2: ...but deferred by the trip gate, session untouched", db.current && db.current.id === "uuid-lunch2");
    assert("2: no duplicate session", db.inserts === 0);
  }

  console.log("\n══ 3. SERA open + due (past 00:00 cutoff) at 00:05, rollover deferred -> same session ══");
  {
    const db = fakeRecoveryDb({
      current: { id: "uuid-dinner", service_kind: "SERA", business_date: "2026-07-15", status: "open", opened_at: "x" },
      rolloverResult: { success: false, skipped: true, deferred: true, reason: "active_rider_trip" },
    });
    const r = await make(db, summer(0, 5, 16))({ actor: "operator" });
    assert("3: ALLOWED (REUSED), the SAME session", r.success && r.code === ENSURE_CODE.REUSED && r.session.id === "uuid-dinner", JSON.stringify(r));
    assert("3: a rollover WAS attempted (SERA always due after cutoff)", db.rolloverCalls.length === 1);
  }

  console.log("\n══ 4. SERA open + active trip at 02:00 -> same session ══");
  {
    const db = fakeRecoveryDb({
      current: { id: "uuid-dinner2", service_kind: "SERA", business_date: "2026-07-15", status: "open", opened_at: "x" },
      rolloverResult: { success: false, skipped: true, deferred: true, reason: "active_rider_trip" },
    });
    const r = await make(db, summer(2, 0, 16))({ actor: "operator" });
    assert("4: ALLOWED (REUSED), the SAME session", r.success && r.code === ENSURE_CODE.REUSED && r.session.id === "uuid-dinner2", JSON.stringify(r));
    assert("4: a rollover WAS attempted (SERA always due after cutoff)...", db.rolloverCalls.length === 1);
    assert("4: ...but deferred, session untouched", db.current && db.current.id === "uuid-dinner2");
  }

  console.log("\n══ 5. empty session past cutoff, INSIDE a valid window -> rollover then fresh ensure succeeds ══");
  {
    const db = fakeRecoveryDb({ current: { id: "uuid-lunch3", service_kind: "PRANZO", business_date: "2026-07-15", status: "open", opened_at: "x" }, rolloverResult: { success: true, summary: {} } });
    const r = await make(db, summer(20, 0))({ actor: "operator" }); // SERA_WINDOW
    assert("5: the stale PRANZO was reconciled via performRollover", db.rolloverCalls.length === 1 && db.rolloverCalls[0].source === "ensure_reconcile");
    assert("5: a FRESH SERA session was created after reconciliation", r.success && r.created === true && r.session.serviceKind === "SERA", JSON.stringify(r));
    assert("5: exactly one insert (the new SERA), no duplicate", db.inserts === 1);

    // Follow-up call in the same window must REUSE, not reconcile/create again.
    const r2 = await make(db, summer(20, 5))({ actor: "operator" });
    assert("5b: a follow-up ensure REUSES the new session, no second rollover/create", r2.success && r2.created === false && r2.session.id === r.session.id);
    assert("5b: still exactly one rollover call, one insert", db.rolloverCalls.length === 1 && db.inserts === 1);
  }

  console.log("\n══ 6. empty session past cutoff, OUTSIDE any valid window -> rollover, but do NOT open a new one ══");
  {
    const db = fakeRecoveryDb({ current: { id: "uuid-dinner3", service_kind: "SERA", business_date: "2026-07-15", status: "open", opened_at: "x" }, rolloverResult: { success: true, summary: {} } });
    const r = await make(db, summer(5, 0, 16))({ actor: "operator" }); // OUTSIDE_WINDOWS
    assert("6: the stale SERA was rolled over", db.rolloverCalls.length === 1);
    assert("6: NO new session opened outside an allowed window", r.success === false && r.code === ENSURE_CODE.OUTSIDE_WINDOWS && r.session === null, JSON.stringify(r));
    assert("6: the ensure RPC was never called after the rollover", db.ensureCalls.length === 0);
    assert("6: no duplicate/phantom session", db.inserts === 0);
  }

  console.log("\n══ 7. no session at all, between services -> no new opening (unchanged window behavior) ══");
  {
    const db = fakeRecoveryDb({ current: null });
    const r = await make(db, summer(17, 45))({ actor: "operator" });
    assert("7: BETWEEN_SERVICES, session:null, nothing created", r.success === false && r.code === ENSURE_CODE.BETWEEN_SERVICES && r.session === null);
    assert("7: no rollover attempted (nothing to reconcile)", db.rolloverCalls.length === 0);
    assert("7: the RPC was never called", db.ensureCalls.length === 0);
  }

  console.log("\n══ 8. no session at all, outside window -> session:null, ordinary refusal ══");
  {
    const db = fakeRecoveryDb({ current: null });
    const r = await make(db, summer(5, 0, 16))({ actor: "operator" });
    assert("8: OUTSIDE_WINDOWS, session:null", r.success === false && r.code === ENSURE_CODE.OUTSIDE_WINDOWS && r.session === null);
    assert("8: no rollover attempted, no insert", db.rolloverCalls.length === 0 && db.inserts === 0);
  }

  console.log("\n══ 9. no duplicates under concurrency (due session, forbidden window, rollover deferred) ══");
  {
    const db = fakeRecoveryDb({
      current: { id: "uuid-lunch4", service_kind: "PRANZO", business_date: "2026-07-15", status: "open", opened_at: "x" },
      rolloverResult: { success: false, skipped: true, deferred: true, reason: "active_rider_trip" },
    });
    const ensure = make(db, summer(17, 45));
    const [a, b] = await Promise.all([ensure({ actor: "a" }), ensure({ actor: "b" })]);
    assert("9: both calls see the SAME session", a.session.id === "uuid-lunch4" && b.session.id === "uuid-lunch4");
    assert("9: no session was ever created", db.inserts === 0);
  }

  console.log("\n══ 10. no operational dead-end on a genuine rollover error ══");
  {
    const db = fakeRecoveryDb({
      current: { id: "uuid-lunch5", service_kind: "PRANZO", business_date: "2026-07-15", status: "open", opened_at: "x" },
      rolloverResult: { success: false, error: "verify_failed" }, // a REAL failure, not a deferral
    });
    const r = await make(db, summer(20, 0))({ actor: "operator" });
    assert("10: never a dead-end exception — the still-open session is handed back", r.success === true && r.code === ENSURE_CODE.REUSED && r.session.id === "uuid-lunch5", JSON.stringify(r));
    assert("10: exactly one rollover attempt was made and tracked", db.rolloverCalls.length === 1);
  }

  console.log("\n══ 11. a 'closing' session is caught by the pre-check even in a forbidden window ══");
  {
    const db = fakeRecoveryDb({ current: { id: "uuid-c2", service_kind: "SERA", business_date: "2026-07-15", status: "closing", opened_at: "x" } });
    const r = await make(db, summer(5, 0, 16))({ actor: "operator" }); // OUTSIDE_WINDOWS
    assert("11: SERVICE_SESSION_CLOSING, not OUTSIDE_WINDOWS — the pre-check runs before the window gate", r.success === false && r.code === ENSURE_CODE.SERVICE_SESSION_CLOSING, JSON.stringify(r));
    assert("11: the conflicting session is reported back", r.session && r.session.id === "uuid-c2");
    assert("11: no rollover attempted for a session already closing", db.rolloverCalls.length === 0);
  }

  console.log("\n══ 12. a currentCloseout() read failure degrades gracefully to the old window-only behavior ══");
  {
    const db = fakeRecoveryDb({ current: { id: "uuid-x", service_kind: "PRANZO", business_date: "2026-07-15", status: "open", opened_at: "x" } });
    db.lifecycle.currentCloseout = async () => { throw new Error("transport down"); };
    const r = await make(db, summer(17, 45))({ actor: "operator" });
    assert("12: falls through to the ordinary window refusal, never throws", r.success === false && r.code === ENSURE_CODE.BETWEEN_SERVICES, JSON.stringify(r));
  }

  console.log("\n══ 13. CURRENT_VALID (not due) session -> REUSED, no rollover attempted at all ══");
  {
    // A PRANZO session, today, still well inside its own window (noon) — this
    // is NOT due for rollover regardless of anything pending on it. Slice 3
    // must not attempt a rollover just because a session exists; only when it
    // is actually classified as due.
    const db = fakeRecoveryDb({ current: { id: "uuid-lunch6", service_kind: "PRANZO", business_date: "2026-07-15", status: "open", opened_at: "x" } });
    const r = await make(db, summer(12, 0))({ actor: "operator" });
    assert("13: REUSED, the SAME session", r.success && r.code === ENSURE_CODE.REUSED && r.session.id === "uuid-lunch6", JSON.stringify(r));
    assert("13: no rollover attempted — the session is not due yet", db.rolloverCalls.length === 0);
  }

  console.log("");
  console.log("=== RESULT: " + pass + " passed, " + fail + " failed ===");
  process.exit(fail === 0 ? 0 : 1);
})();
