"use strict";
// S2-7D6B — the ensure lifecycle, with an injected fake RPC layer so every
// branch is provable offline. The SQL-side atomicity is asserted separately
// by the migration test; here the subject is the DECISION the JS
// orchestrator makes and what the caller learns.
//
// F-7 (opening authority cutover) rewrites this file's whole premise: before
// F-7, this module decided "which kind, and may we create it?" (window- // language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values, named here only to describe the retired pre-F-7 contract, not new vocabulary
// gated PRANZO/SERA creation). After F-7 it decides nothing and creates
// nothing — it is read/reuse only. An active session (any era) is REUSED;
// otherwise the answer is NO_OPEN_SERVICE (the current Business Day has
// never had a service) or REOPEN_REQUIRED (it has, but nothing is active
// now) — both purely DB-derived, both clock-independent. The FIRST-EVER
// creation for a Business Day happens lazily on the first real order via
// resolve_order_intake_context_v1 (see tests/f7OpeningAuthorityCutover
// .static.test.js and the live fixture matrix report), never from here.
const { createEnsureCurrentServiceSession, ENSURE_CODE } = require("../src/serviceSessions/ensureServiceSession");
const { DEFAULT_SCHEDULE } = require("../src/schedule/serviceSchedule");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };

const summer = (h, m = 0, day = 15) => new Date(Date.UTC(2026, 6, day, h - 2, m));

// A fake of the SQL contract, faithful to the real F-7 function's branches:
// REUSED (active session exists, era-blind) / NO_OPEN_SERVICE (pristine
// Business Day) / REOPEN_REQUIRED (Business Day has history, nothing
// active) / INVALID_ACTOR. Never creates. No serviceKind parameter exists.
function fakeDb({ current = null, hasHistoryToday = false, noCurrentBusinessDay = false } = {}) {
  const db = { current, hasHistoryToday, noCurrentBusinessDay, calls: [] };
  db.lifecycle = {
    async ensure({ actor, source }) {
      db.calls.push({ actor, source });
      if (!actor || !String(actor).trim()) return { ok: false, code: "INVALID_ACTOR" };
      if (db.current) {
        if (db.current.status === "closing") return { ok: false, code: "SERVICE_SESSION_CLOSING", session: db.current };
        return { ok: true, code: "REUSED", created: false, session: db.current };
      }
      if (db.noCurrentBusinessDay) {
        return { ok: false, code: "NO_OPEN_SERVICE" };
      }
      if (db.hasHistoryToday) {
        return { ok: false, code: "REOPEN_REQUIRED", businessDate: "2026-07-15" };
      }
      return { ok: false, code: "NO_OPEN_SERVICE", businessDate: "2026-07-15" };
    },
  };
  return db;
}

// This module's own S2-7D6F recovery pre-check calls currentCloseout()
// before ever reaching ensure() — since these tests are about ensure()'s
// OWN discriminator, currentCloseout() is stubbed to report nothing active
// (mirroring db.current === null), letting the recovery pre-check fall
// straight through, exactly matching every real "no current session" case.
function withRecoveryStub(db) {
  db.lifecycle.currentCloseout = async () => {
    if (!db.current) return { ok: true, code: "NO_SERVICE_SESSION", session: null };
    return { ok: true, session: db.current };
  };
  return db;
}

const make = (db, when) => createEnsureCurrentServiceSession({
  sessionLifecycle: withRecoveryStub(db).lifecycle, schedule: DEFAULT_SCHEDULE, now: () => when,
});

(async () => {
  console.log("\n══ 1-3. active session -> REUSED, era/clock-independent ══");
  {
    const db = fakeDb({ current: { id: "uuid-active", service_kind: "PRANZO", business_date: "2026-07-15", status: "open", opened_at: "x" } }); // language-guard: allow-legacy PRANZO is the existing service_kind enum value, used here only as a fixture label on a legacy-era session, not new vocabulary
    const ensure = make(db, summer(12));
    const first = await ensure({ actor: "operator_primary" });
    assert("1: active session is REUSED, never re-created", first.success && first.created === false && first.session.id === "uuid-active", JSON.stringify(first));
    const second = await ensure({ actor: "operator_backup" });
    assert("2: second access REUSES the same identity", second.success && second.created === false && second.session.id === first.session.id);
    assert("2: no serviceKind was ever forwarded to the RPC (the parameter no longer exists)", db.calls.every((c) => !("serviceKind" in c)));
  }
  {
    // Simultaneous access: proves the caller never invents two different
    // outcomes for a concurrent pair. The real serialization is the
    // advisory lock; here the fake DB is single-threaded, so this proves
    // the CALLER-side contract (idempotent, no local guessing).
    const db = fakeDb({ current: { id: "uuid-concurrent", service_kind: "SERA", business_date: "2026-07-15", status: "open", opened_at: "x" } });
    const ensure = make(db, summer(12));
    const [a, b] = await Promise.all([ensure({ actor: "owner" }), ensure({ actor: "operator_primary" })]);
    assert("3: simultaneous ensure yields ONE identity", a.session.id === b.session.id, `${a.session.id} vs ${b.session.id}`);
  }

  console.log("\n══ 4-5. no active session, pristine Business Day -> NO_OPEN_SERVICE, at ANY hour ══");
  {
    const db = fakeDb({ current: null, hasHistoryToday: false });
    const r = await make(db, summer(12))({ actor: "owner" });
    assert("4: NO_OPEN_SERVICE, session:null, nothing created — never creates", r.success === false && r.code === ENSURE_CODE.NO_OPEN_SERVICE && r.session === null, JSON.stringify(r));
  }
  {
    // The exact same DB state at a wildly different hour must yield the
    // identical answer — F-7 removed all clock/window dependence from this
    // discriminator.
    const db = fakeDb({ current: null, hasHistoryToday: false });
    const r = await make(db, summer(3, 30, 16))({ actor: "owner" });
    assert("5: identical NO_OPEN_SERVICE at 03:30 as at noon — clock-independent (F-7)", r.success === false && r.code === ENSURE_CODE.NO_OPEN_SERVICE && r.session === null, JSON.stringify(r));
  }

  console.log("\n══ 6-7. no active session, Business Day already has history -> REOPEN_REQUIRED, at ANY hour ══");
  {
    const db = fakeDb({ current: null, hasHistoryToday: true });
    const r = await make(db, summer(20))({ actor: "owner" });
    assert("6: REOPEN_REQUIRED, session:null, nothing created", r.success === false && r.code === ENSURE_CODE.REOPEN_REQUIRED && r.session === null, JSON.stringify(r));
  }
  {
    const db = fakeDb({ current: null, hasHistoryToday: true });
    const r = await make(db, summer(4, 15, 16))({ actor: "owner" });
    assert("7: identical REOPEN_REQUIRED at 04:15 — clock-independent (F-7)", r.success === false && r.code === ENSURE_CODE.REOPEN_REQUIRED && r.session === null, JSON.stringify(r));
  }

  console.log("\n══ 8. no current Business Day at all -> NO_OPEN_SERVICE, never a crash ══");
  {
    const db = fakeDb({ current: null, noCurrentBusinessDay: true });
    const r = await make(db, summer(12))({ actor: "owner" });
    assert("8: NO_OPEN_SERVICE (no current Business Day collapses to the same typed non-success, never throws)", r.success === false && r.code === ENSURE_CODE.NO_OPEN_SERVICE, JSON.stringify(r));
  }

  console.log("\n══ 9. restart recovery — identity survives, no duplicate ══");
  {
    // A restart loses in-memory state only. The identity lives in
    // service_session_state, so a fresh controller finds the same session.
    const db = fakeDb({ current: { id: "uuid-survivor", service_kind: "SERA", business_date: "2026-07-15", status: "open", opened_at: "x" } });
    const afterRestart = make(db, summer(21));
    const r = await afterRestart({ actor: "owner" });
    assert("9: identity survives a restart", r.success && r.created === false && r.session.id === "uuid-survivor");
  }

  console.log("\n══ 10. actor safety ══");
  {
    const db = fakeDb({ current: null });
    for (const bad of [undefined, null, "", "   "]) {
      const r = await make(db, summer(12))({ actor: bad });
      assert(`10: actor ${JSON.stringify(bad)} fails closed`, r.success === false && r.code === ENSURE_CODE.INVALID_ACTOR);
    }
    assert("10: the RPC was never called for an unverified actor (the JS-level guard rejects first)", db.calls.length === 0);
  }

  console.log("\n══ 11. a closing session is a typed conflict, not a reuse ══");
  {
    const db = fakeDb({ current: { id: "uuid-c", service_kind: "SERA", business_date: "2026-07-15", status: "closing", opened_at: "x" } });
    const r = await make(db, summer(20))({ actor: "owner" });
    assert("11: a closing session is a typed conflict, not a reuse", r.success === false && r.code === ENSURE_CODE.SERVICE_SESSION_CLOSING);
  }

  console.log("\n══ 12. created is always false — this module never creates, era or reason notwithstanding ══");
  {
    const db1 = fakeDb({ current: { id: "uuid-a", service_kind: null, business_date: "2026-07-15", status: "open", opened_at: "x" } });
    const r1 = await make(db1, summer(12))({ actor: "owner" });
    assert("12a: even an operational_service_v1 (service_kind:null) active session is REUSED, era-blind (grandfather requirement)", r1.success && r1.created === false && r1.session.id === "uuid-a", JSON.stringify(r1));

    const db2 = fakeDb({ current: null, hasHistoryToday: false });
    const r2 = await make(db2, summer(12))({ actor: "owner" });
    assert("12b: created is false even on a typed non-success (never true from here)", r2.created === false);
  }

  console.log("");
  console.log("=== RESULT: " + pass + " passed, " + fail + " failed ===");
  process.exit(fail === 0 ? 0 : 1);
})();
