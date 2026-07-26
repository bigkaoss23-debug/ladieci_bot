"use strict";
// S2-7D6B — the ensure lifecycle, with an injected fake RPC layer so every
// branch (including the ones a real database would take hours to reproduce) is
// provable offline. The SQL-side atomicity is asserted separately by the
// migration test; here the subject is the DECISION: which kind, may we create,
// and what does the caller learn.
const { createEnsureCurrentServiceSession, ENSURE_CODE } = require("../src/serviceSessions/ensureServiceSession");
const { DEFAULT_SCHEDULE } = require("../src/schedule/serviceSchedule");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };

const summer = (h, m = 0, day = 15) => new Date(Date.UTC(2026, 6, day, h - 2, m));

// A fake of the SQL contract, faithful to the real function's branches.
function fakeDb(initial = {}) {
  const db = {
    current: initial.current || null,      // { id, service_kind, business_date, status, opened_at }
    completed: initial.completed || [],    // [{ business_date, service_kind }]
    inserts: 0,
    calls: [],
  };
  db.lifecycle = {
    async ensure({ actor, serviceKind, source }) {
      db.calls.push({ actor, serviceKind, source });
      if (!serviceKind || !["PRANZO", "SERA"].includes(serviceKind)) return { ok: false, code: "INVALID_SERVICE_KIND" };
      if (!actor || !String(actor).trim()) return { ok: false, code: "INVALID_ACTOR" };
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
      const businessDate = "2026-07-15";
      if (db.completed.some((c) => c.business_date === businessDate && c.service_kind === serviceKind)) {
        return { ok: false, code: "SERVICE_ALREADY_COMPLETED_TODAY" };
      }
      db.inserts++;
      db.current = {
        id: "uuid-" + db.inserts, service_kind: serviceKind, business_date: businessDate,
        status: "open", opened_at: "2026-07-15T10:00:00Z",
      };
      return { ok: true, code: "CREATED", created: true, session: db.current };
    },
  };
  return db;
}

const make = (db, when) => createEnsureCurrentServiceSession({
  sessionLifecycle: db.lifecycle, schedule: DEFAULT_SCHEDULE, now: () => when,
});

(async () => {
  console.log("\n══ 1-3. lunch ══");
  {
    const db = fakeDb();
    const ensure = make(db, summer(12));
    const first = await ensure({ actor: "operator_primary" });
    assert("1: first lunch access CREATES PRANZO", first.success && first.created && first.session.serviceKind === "PRANZO", JSON.stringify(first));
    assert("1: business date carried", first.session.businessDate === "2026-07-15");
    const second = await ensure({ actor: "operator_backup" });
    assert("2: second access REUSES the same UUID", second.success && second.created === false && second.session.id === first.session.id);
    assert("2: only one row was ever inserted", db.inserts === 1);
    assert("2: the kind was never taken from a caller argument", db.calls.every((c) => c.serviceKind === "PRANZO"));
  }
  {
    // Simultaneous first access: the real serialization is the advisory lock, so
    // here we prove the CALLER never asks for two different things at once and
    // that a concurrent pair still yields one identity.
    const db = fakeDb();
    const ensure = make(db, summer(12));
    const [a, b] = await Promise.all([ensure({ actor: "owner" }), ensure({ actor: "operator_primary" })]);
    assert("3: simultaneous ensure yields ONE uuid", a.session.id === b.session.id, `${a.session.id} vs ${b.session.id}`);
    assert("3: exactly one insert", db.inserts === 1);
  }

  console.log("\n══ 4-5. dinner ══");
  {
    const db = fakeDb();
    const ensure = make(db, summer(20));
    const first = await ensure({ actor: "owner" });
    assert("4: first dinner access CREATES SERA", first.success && first.created && first.session.serviceKind === "SERA");
    const second = await ensure({ actor: "owner" });
    assert("5: dinner access REUSES the same UUID", second.success && !second.created && second.session.id === first.session.id);
  }

  console.log("\n══ 6-7. boundaries ══");
  {
    const db = fakeDb({ current: { id: "uuid-lunch", service_kind: "PRANZO", business_date: "2026-07-15", status: "open", opened_at: "x" } });
    const ensure = make(db, summer(18, 30));
    const r = await ensure({ actor: "owner" });
    assert("6: lunch still active at 18:30 → typed conflict", r.success === false && r.code === ENSURE_CODE.LUNCH_SESSION_STILL_ACTIVE, JSON.stringify(r));
    assert("6: no dinner session was created", db.inserts === 0);
    assert("6: the conflicting session is reported back", r.session && r.session.serviceKind === "PRANZO");
  }
  {
    const db = fakeDb();
    const r = await make(db, summer(17, 45))({ actor: "owner" });
    assert("7: 17:30-18:00 buffer creates NOTHING", r.success === false && r.code === ENSURE_CODE.BETWEEN_SERVICES);
    assert("7: the RPC was never even called", db.calls.length === 0);
    assert("7: no kind was silently chosen", r.session === null);
  }

  console.log("\n══ 8-10. evening and midnight ══");
  {
    const db = fakeDb();
    const r = await make(db, summer(23, 50))({ actor: "owner" });
    assert("8: 23:50 is still a normal SERA ensure", r.success && r.session.serviceKind === "SERA");
  }
  {
    // After midnight an ALREADY-OPEN dinner stays valid and reusable; what must
    // not happen is a NEW session being minted at 01:00.
    const db = fakeDb({ current: { id: "uuid-dinner", service_kind: "SERA", business_date: "2026-07-15", status: "open", opened_at: "x" } });
    const r = await make(db, summer(1, 0, 16))({ actor: "owner" });
    assert("9: after midnight no new session is created", db.inserts === 0);
    assert("9: the state is typed AFTER_ORDER_CUTOFF", r.code === ENSURE_CODE.AFTER_ORDER_CUTOFF);
    assert("9: the dinner keeps its opening business date", db.current.business_date === "2026-07-15");
  }
  {
    const db = fakeDb();
    const r = await make(db, summer(4, 30, 16))({ actor: "owner" });
    assert("10: 04:00+ is OUTSIDE_WINDOWS, never a blind create", r.success === false && r.code === ENSURE_CODE.OUTSIDE_WINDOWS && db.inserts === 0);
  }

  console.log("\n══ 11. restart recovery ══");
  {
    // A restart loses in-memory state only. The identity lives in
    // service_session_state, so a fresh controller finds the same session.
    const db = fakeDb({ current: { id: "uuid-survivor", service_kind: "SERA", business_date: "2026-07-15", status: "open", opened_at: "x" } });
    const afterRestart = make(db, summer(21));
    const r = await afterRestart({ actor: "owner" });
    assert("11: identity survives a restart", r.success && r.created === false && r.session.id === "uuid-survivor");
    assert("11: no duplicate session after restart", db.inserts === 0);
  }

  console.log("\n══ 12-13. actor safety ══");
  {
    const db = fakeDb();
    for (const bad of [undefined, null, "", "   "]) {
      const r = await make(db, summer(12))({ actor: bad });
      assert(`13: actor ${JSON.stringify(bad)} fails closed`, r.success === false && r.code === ENSURE_CODE.INVALID_ACTOR);
    }
    assert("13: no session created for an unverified actor", db.inserts === 0);
    assert("13: the RPC was never called", db.calls.length === 0);
  }

  console.log("\n══ extra. already-completed service ══");
  {
    const db = fakeDb({ completed: [{ business_date: "2026-07-15", service_kind: "PRANZO" }] });
    const r = await make(db, summer(12))({ actor: "owner" });
    assert("a closed lunch is not silently reopened", r.success === false && r.code === "SERVICE_ALREADY_COMPLETED_TODAY");
  }
  {
    const db = fakeDb({ current: { id: "uuid-c", service_kind: "SERA", business_date: "2026-07-15", status: "closing", opened_at: "x" } });
    const r = await make(db, summer(20))({ actor: "owner" });
    assert("a closing session is a typed conflict, not a reuse", r.success === false && r.code === ENSURE_CODE.SERVICE_SESSION_CLOSING);
  }

  console.log("");
  console.log("=== RESULT: " + pass + " passed, " + fail + " failed ===");
  process.exit(fail === 0 ? 0 : 1);
})();
