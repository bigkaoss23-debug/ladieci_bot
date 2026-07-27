"use strict";
// S2-7D6F — the recovery pre-check contract, with a fully controllable fake
// environment (currentCloseout + hasPendingActivity + closeSession all
// injectable), driven by an explicit clock. Complements
// tests/ensureServiceSession.test.js (which keeps testing the ORIGINAL
// window-only behavior via graceful fallback when currentCloseout is
// unavailable — the production sessionLifecycle always provides it, so this
// file is the one that exercises the real path).
//
// Approved contract (rejected the earlier PASS until this existed):
//   1. read the current open/closing session in EVERY window, before the
//      canEnsureSession gate;
//   2. pending activity -> hand back the SAME session, full access, whatever
//      the clock says;
//   3. empty + past its own close boundary -> reconcile through the SAME
//      engine cron/boot/external share, then re-enter the window logic from a
//      clean slate — never auto-open a new session outside an allowed window
//      just because the old one just closed;
//   4. only when nothing recoverable exists does the ordinary window-typed
//      refusal (BETWEEN_SERVICES/AFTER_ORDER_CUTOFF/OUTSIDE_WINDOWS) apply.
const { createEnsureCurrentServiceSession, ENSURE_CODE } = require("../src/serviceSessions/ensureServiceSession");
const { DEFAULT_SCHEDULE } = require("../src/schedule/serviceSchedule");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };

const summer = (h, m = 0, day = 15) => new Date(Date.UTC(2026, 6, day, h - 2, m));

function fakeRecoveryDb({ current = null, pending = false, closeResult = { success: true } } = {}) {
  const db = {
    current, pendingFlag: pending, closeResultSpec: closeResult,
    inserts: 0, ensureCalls: [], closeCalls: [], pendingCalls: [],
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
  db.hasPendingActivity = async ({ sessionId }) => { db.pendingCalls.push(sessionId); return { pending: db.pendingFlag }; };
  db.closeSession = async (deleteAttivi, source) => {
    db.closeCalls.push({ deleteAttivi, source });
    const result = typeof db.closeResultSpec === "function" ? db.closeResultSpec() : db.closeResultSpec;
    if (result && result.success === true) db.current = null; // simulate the archive actually completing
    return result;
  };
  return db;
}

const make = (db, when) => createEnsureCurrentServiceSession({
  sessionLifecycle: db.lifecycle, schedule: DEFAULT_SCHEDULE, now: () => when,
  hasPendingActivity: db.hasPendingActivity, closeSession: db.closeSession,
});

(async () => {
  console.log("\n══ 1. PRANZO open + pending order at 17:45 (BETWEEN_SERVICES window) -> same session ══");
  {
    const db = fakeRecoveryDb({ current: { id: "uuid-lunch", service_kind: "PRANZO", business_date: "2026-07-15", status: "open", opened_at: "x" }, pending: true });
    const r = await make(db, summer(17, 45))({ actor: "operator" });
    assert("1: ALLOWED (REUSED), the SAME session", r.success && r.code === ENSURE_CODE.REUSED && r.session.id === "uuid-lunch", JSON.stringify(r));
    assert("1: no ensure RPC call — the pre-check short-circuits", db.ensureCalls.length === 0);
    assert("1: no close attempted", db.closeCalls.length === 0);
    assert("1: no new session created", db.inserts === 0);
  }

  console.log("\n══ 2. PRANZO open + active trip (no pending order) at 17:45 -> same session ══");
  {
    // No pending ORDER, but chiudiServizio's own rider-trip gate defers — this
    // is exactly how an active trip surfaces at this layer.
    const db = fakeRecoveryDb({
      current: { id: "uuid-lunch2", service_kind: "PRANZO", business_date: "2026-07-15", status: "open", opened_at: "x" },
      pending: false,
      closeResult: { success: false, skipped: true, deferred: true, reason: "active_rider_trip" },
    });
    const r = await make(db, summer(17, 45))({ actor: "operator" });
    assert("2: ALLOWED (REUSED), the SAME session", r.success && r.code === ENSURE_CODE.REUSED && r.session.id === "uuid-lunch2", JSON.stringify(r));
    assert("2: a close WAS attempted (empty + past 17:30 boundary)...", db.closeCalls.length === 1);
    assert("2: ...but deferred by the trip gate, session untouched", db.current && db.current.id === "uuid-lunch2");
    assert("2: no duplicate session", db.inserts === 0);
  }

  console.log("\n══ 3. SERA open + pending order at 00:05 (AFTER_ORDER_CUTOFF window) -> same session ══");
  {
    const db = fakeRecoveryDb({ current: { id: "uuid-dinner", service_kind: "SERA", business_date: "2026-07-15", status: "open", opened_at: "x" }, pending: true });
    const r = await make(db, summer(0, 5, 16))({ actor: "operator" });
    assert("3: ALLOWED (REUSED), the SAME session", r.success && r.code === ENSURE_CODE.REUSED && r.session.id === "uuid-dinner", JSON.stringify(r));
    assert("3: no ensure RPC call", db.ensureCalls.length === 0);
    assert("3: no close attempted", db.closeCalls.length === 0);
  }

  console.log("\n══ 4. SERA open + active trip at 02:00 -> same session ══");
  {
    const db = fakeRecoveryDb({
      current: { id: "uuid-dinner2", service_kind: "SERA", business_date: "2026-07-15", status: "open", opened_at: "x" },
      pending: false,
      closeResult: { success: false, skipped: true, deferred: true, reason: "active_rider_trip" },
    });
    const r = await make(db, summer(2, 0, 16))({ actor: "operator" });
    assert("4: ALLOWED (REUSED), the SAME session", r.success && r.code === ENSURE_CODE.REUSED && r.session.id === "uuid-dinner2", JSON.stringify(r));
    assert("4: a close WAS attempted (SERA always close-eligible after cutoff)...", db.closeCalls.length === 1);
    assert("4: ...but deferred, session untouched", db.current && db.current.id === "uuid-dinner2");
  }

  console.log("\n══ 5. empty session past cutoff, INSIDE a valid window -> auto-close then fresh ensure succeeds ══");
  {
    const db = fakeRecoveryDb({ current: { id: "uuid-lunch3", service_kind: "PRANZO", business_date: "2026-07-15", status: "open", opened_at: "x" }, pending: false, closeResult: { success: true, summary: {} } });
    const r = await make(db, summer(20, 0))({ actor: "operator" }); // SERA_WINDOW
    assert("5: the stale PRANZO was reconciled via the shared engine", db.closeCalls.length === 1 && db.closeCalls[0].source === "ensure_reconcile");
    assert("5: a FRESH SERA session was created after reconciliation", r.success && r.created === true && r.session.serviceKind === "SERA", JSON.stringify(r));
    assert("5: exactly one insert (the new SERA), no duplicate", db.inserts === 1);

    // Follow-up call in the same window must REUSE, not reconcile/create again.
    const r2 = await make(db, summer(20, 5))({ actor: "operator" });
    assert("5b: a follow-up ensure REUSES the new session, no second close/create", r2.success && r2.created === false && r2.session.id === r.session.id);
    assert("5b: still exactly one close call, one insert", db.closeCalls.length === 1 && db.inserts === 1);
  }

  console.log("\n══ 6. empty session past cutoff, OUTSIDE any valid window -> close, but do NOT open a new one ══");
  {
    const db = fakeRecoveryDb({ current: { id: "uuid-dinner3", service_kind: "SERA", business_date: "2026-07-15", status: "open", opened_at: "x" }, pending: false, closeResult: { success: true, summary: {} } });
    const r = await make(db, summer(5, 0, 16))({ actor: "operator" }); // OUTSIDE_WINDOWS
    assert("6: the stale SERA was closed", db.closeCalls.length === 1);
    assert("6: NO new session opened outside an allowed window", r.success === false && r.code === ENSURE_CODE.OUTSIDE_WINDOWS && r.session === null, JSON.stringify(r));
    assert("6: the ensure RPC was never called after the close", db.ensureCalls.length === 0);
    assert("6: no duplicate/phantom session", db.inserts === 0);
  }

  console.log("\n══ 7. no session at all, between services -> no new opening (unchanged window behavior) ══");
  {
    const db = fakeRecoveryDb({ current: null });
    const r = await make(db, summer(17, 45))({ actor: "operator" });
    assert("7: BETWEEN_SERVICES, session:null, nothing created", r.success === false && r.code === ENSURE_CODE.BETWEEN_SERVICES && r.session === null);
    assert("7: no close attempted (nothing to reconcile)", db.closeCalls.length === 0);
    assert("7: the RPC was never called", db.ensureCalls.length === 0);
  }

  console.log("\n══ 8. no session at all, outside window -> session:null, ordinary refusal ══");
  {
    const db = fakeRecoveryDb({ current: null });
    const r = await make(db, summer(5, 0, 16))({ actor: "operator" });
    assert("8: OUTSIDE_WINDOWS, session:null", r.success === false && r.code === ENSURE_CODE.OUTSIDE_WINDOWS && r.session === null);
    assert("8: no close attempted, no insert", db.closeCalls.length === 0 && db.inserts === 0);
  }

  console.log("\n══ 9. no duplicates under concurrency (pending session, forbidden window) ══");
  {
    const db = fakeRecoveryDb({ current: { id: "uuid-lunch4", service_kind: "PRANZO", business_date: "2026-07-15", status: "open", opened_at: "x" }, pending: true });
    const ensure = make(db, summer(17, 45));
    const [a, b] = await Promise.all([ensure({ actor: "a" }), ensure({ actor: "b" })]);
    assert("9: both calls see the SAME session", a.session.id === "uuid-lunch4" && b.session.id === "uuid-lunch4");
    assert("9: no session was ever created or closed", db.inserts === 0 && db.closeCalls.length === 0);
  }

  console.log("\n══ 10. no operational dead-end on a genuine close error ══");
  {
    const db = fakeRecoveryDb({
      current: { id: "uuid-lunch5", service_kind: "PRANZO", business_date: "2026-07-15", status: "open", opened_at: "x" },
      pending: false,
      closeResult: { success: false, error: "verify_failed" }, // a REAL failure, not a deferral
    });
    const r = await make(db, summer(20, 0))({ actor: "operator" });
    assert("10: never a dead-end exception — the still-open session is handed back", r.success === true && r.code === ENSURE_CODE.REUSED && r.session.id === "uuid-lunch5", JSON.stringify(r));
    assert("10: exactly one close attempt was made and tracked", db.closeCalls.length === 1);
  }

  console.log("\n══ 11. a 'closing' session is caught by the pre-check even in a forbidden window ══");
  {
    const db = fakeRecoveryDb({ current: { id: "uuid-c2", service_kind: "SERA", business_date: "2026-07-15", status: "closing", opened_at: "x" } });
    const r = await make(db, summer(5, 0, 16))({ actor: "operator" }); // OUTSIDE_WINDOWS
    assert("11: SERVICE_SESSION_CLOSING, not OUTSIDE_WINDOWS — the pre-check runs before the window gate", r.success === false && r.code === ENSURE_CODE.SERVICE_SESSION_CLOSING, JSON.stringify(r));
    assert("11: the conflicting session is reported back", r.session && r.session.id === "uuid-c2");
  }

  console.log("\n══ 12. a currentCloseout() read failure degrades gracefully to the old window-only behavior ══");
  {
    const db = fakeRecoveryDb({ current: { id: "uuid-x", service_kind: "PRANZO", business_date: "2026-07-15", status: "open", opened_at: "x" }, pending: true });
    db.lifecycle.currentCloseout = async () => { throw new Error("transport down"); };
    const r = await make(db, summer(17, 45))({ actor: "operator" });
    assert("12: falls through to the ordinary window refusal, never throws", r.success === false && r.code === ENSURE_CODE.BETWEEN_SERVICES, JSON.stringify(r));
  }

  console.log("");
  console.log("=== RESULT: " + pass + " passed, " + fail + " failed ===");
  process.exit(fail === 0 ? 0 : 1);
})();
