// tests/economy149150GuardedStep.test.js — offline guard of scripts/economy149150GuardedStep.js (post-final-blind H-1).
// The behaviour on a real catalogue (PostgreSQL 17: refusal with an open service, busy lock, success, intake blocked during the step,
// the pair committed or rolled back as ONE transaction, a bypassed 149 completed, rollback, re-forward after rollback, no pooler,
// registry byte proof, in-flight Finalizar race) is certified in the corrective-cycle evidence; this file proves the control flow with a
// scripted client: nothing is applied unless every precondition holds under the lock, the pair is ONE transaction (never visible or left
// half-applied), the session is a direct one, and the lifecycle lock is always released.
// Run: node tests/economy149150GuardedStep.test.js

"use strict";

const fs = require("fs");
const path = require("path");
const GS = require("../scripts/economy149150GuardedStep.js");

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log("  ✓ " + label); } else { fail++; console.log("  ✗ " + label + (detail ? "  -> " + detail : "")); }
}

const B = { f149: GS.certifiedBody(149).body, f150: GS.certifiedBody(150).body, r149: GS.certifiedBody(149, true).body, r150: GS.certifiedBody(150, true).body };

// A scripted database with real transaction semantics: BEGIN snapshots (catalog, ledger), ROLLBACK restores it, COMMIT keeps it.
// Every statement is recorded.
function fakeDb({ catalog = "BEFORE_149", lockFree = true, st = {}, failOn = [], pids = [4242] } = {}) {
  const db = { catalog, lockFree, lockHeld: false, ledger: [], log: [], snap: null, pidCalls: 0, st: { open_services: 0, h1_states: 0, active_attempts: 0, closed_with_active_attempt: 0, ...st } };
  db.client = {
    async query(sql, params) {
      const s = String(sql);
      const which = s === B.f149 ? "APPLY_149" : s === B.f150 ? "APPLY_150" : s === B.r149 ? "APPLY_RB149" : s === B.r150 ? "APPLY_RB150" : null;
      if (which) {
        db.log.push(which);
        if (failOn.includes(which)) throw new Error("injected failure " + which);
        db.catalog = { APPLY_149: "BEFORE_150", APPLY_150: "BEFORE_151", APPLY_RB150: "BEFORE_150", APPLY_RB149: "BEFORE_149" }[which];
        return { rows: [] };
      }
      if (/^BEGIN/.test(s)) { db.log.push(/READ ONLY/.test(s) ? "BEGIN_RO" : "BEGIN"); db.snap = { catalog: db.catalog, ledger: [...db.ledger] }; return { rows: [] }; }
      if (/^ROLLBACK/.test(s)) { if (db.snap) { db.catalog = db.snap.catalog; db.ledger = db.snap.ledger; } db.snap = null; db.log.push("ROLLBACK"); return { rows: [] }; }
      if (/^COMMIT/.test(s)) { db.snap = null; db.log.push("COMMIT"); return { rows: [] }; }
      if (/pg_backend_pid\(\) AS pid/.test(s)) { const pid = pids[db.pidCalls % pids.length]; db.pidCalls += 1; return { rows: [{ pid }] }; }
      if (/FROM pg_locks/.test(s)) return { rows: [{ ok: db.lockHeld }] };
      if (/pg_try_advisory_lock/.test(s)) { db.log.push("LOCK_TRY"); if (db.lockFree) { db.lockHeld = true; return { rows: [{ ok: true }] }; } return { rows: [{ ok: false }] }; }
      if (/pg_advisory_unlock/.test(s)) { db.log.push("UNLOCK"); db.lockHeld = false; return { rows: [{ ok: true }] }; }
      const mode = (/PREFLIGHT, mode (\w+)/.exec(s) || [])[1];
      if (mode) {
        db.log.push("PREFLIGHT_" + mode);
        const catOk = db.catalog === mode;
        const ledOk = mode === "BEFORE_151" ? db.ledger.length === 2 : db.ledger.length === 0;
        if (failOn.includes("POSTCHECK_" + mode) && db.snap) return { rows: [{ sec: "D", k: "catalog", ok: false }] };
        const rows = [{ sec: "A", k: "a", ok: true }, { sec: "D", k: "catalog", ok: catOk }, { sec: "C", k: "ledger", ok: ledOk }];
        rows.push({ sec: "Z", k: "VERDICT " + mode, ok: rows.every((r) => r.ok) });
        return { rows };
      }
      if (s === GS.STATE_SQL) { db.log.push("STATE"); return { rows: [db.st] }; }
      if (/INSERT INTO public\.ladieci_schema_migrations/.test(s)) { db.log.push("LEDGER_" + params[2]); if (failOn.includes("LEDGER_" + params[2])) throw new Error("injected ledger failure"); db.ledger.push(params[2]); return { rows: [] }; }
      if (/FROM public\.ladieci_schema_migrations/.test(s)) return { rows: db.ledger.filter((n) => params && n === params[1]).map((n) => ({ filename: "x", checksum_sha256: "y" })) };
      if (/FROM supabase_migrations/.test(s)) return { rows: [] };
      throw new Error("unexpected statement: " + s.slice(0, 80));
    },
  };
  return db;
}
const quiet = () => {};
const saved = process.env.PREFLIGHT_DATABASE_URL;

(async () => {
  console.log("\n── forward: ONE transaction ──");
  { const db = fakeDb(); const r = await GS.runForward({ client: db.client, noRegistry: true, log: quiet });
    const applied = db.log.filter((x) => /^APPLY|^LEDGER|LOCK_TRY|UNLOCK|^BEGIN$|^COMMIT$|PREFLIGHT_BEFORE_151/.test(x));
    check("happy path: lock -> BEGIN -> 149 -> 150 -> ledger 149 + 150 -> preflight BEFORE_151 inside the transaction -> COMMIT -> unlock, code 0",
      r.code === 0 && JSON.stringify(applied) === JSON.stringify(["LOCK_TRY", "BEGIN", "APPLY_149", "APPLY_150", "LEDGER_149", "LEDGER_150", "PREFLIGHT_BEFORE_151", "COMMIT", "UNLOCK"]), JSON.stringify(applied));
    check("the state and the preflight BEFORE_149 are read under the lock, before any file", db.log.indexOf("STATE") > db.log.indexOf("LOCK_TRY") && db.log.indexOf("PREFLIGHT_BEFORE_149") < db.log.indexOf("APPLY_149"));
    check("the database ends at 150 with both ledger rows", db.catalog === "BEFORE_151" && JSON.stringify(db.ledger) === "[149,150]"); }
  for (const [label, st] of [["an open service", { open_services: 1 }], ["an H-1 state", { h1_states: 1, open_services: 1 }], ["an active attempt", { active_attempts: 1 }]]) {
    const db = fakeDb({ st }); const r = await GS.runForward({ client: db.client, noRegistry: true, log: quiet });
    check(`refused with ${label}: nothing applied, lock released`, r.code === 1 && r.result === "REFUSED_PRECONDITION" && !db.log.some((x) => /^APPLY/.test(x)) && !db.lockHeld);
  }
  { const db = fakeDb({ lockFree: false }); const r = await GS.runForward({ client: db.client, noRegistry: true, lockWaitMs: 0, log: quiet });
    check("lifecycle lock busy: LOCK_NOT_ACQUIRED, no state read, nothing applied", r.result === "LOCK_NOT_ACQUIRED" && !db.log.includes("STATE") && !db.log.some((x) => /^APPLY/.test(x))); }
  for (const f of ["APPLY_150", "LEDGER_150", "POSTCHECK_BEFORE_151"]) {
    const db = fakeDb({ failOn: [f] }); const r = await GS.runForward({ client: db.client, noRegistry: true, log: quiet });
    check(`${f} fails -> the WHOLE pair is rolled back in its one transaction: back at 148, no ledger row, no COMMIT, lock released`,
      r.code === 1 && r.result === "REFUSED_STEP_ROLLED_BACK" && db.catalog === "BEFORE_149" && db.ledger.length === 0 && !db.log.includes("COMMIT") && !db.lockHeld && !db.log.includes("APPLY_RB149"), JSON.stringify(r)); }
  { const db = fakeDb({ catalog: "BEFORE_150" }); const r = await GS.runForward({ client: db.client, noRegistry: true, log: quiet });
    check("a database resting at \"149 without 150\" is completed with 150 only, under the same guard", r.code === 0 && !db.log.includes("APPLY_149") && db.log.includes("APPLY_150")); }
  { const db = fakeDb({ catalog: "BEFORE_151" }); const r = await GS.runForward({ client: db.client, noRegistry: true, log: quiet });
    check("already at 150: nothing to do, nothing applied", r.result === "ALREADY_AT_150" && !db.log.some((x) => /^APPLY/.test(x))); }
  { let threw = null; try { await GS.runForward({ client: fakeDb().client, noRegistry: true, log: quiet, readFile: (rel) => Buffer.concat([fs.readFileSync(path.join(__dirname, "..", rel)), Buffer.from("\n")]) }); } catch (e) { threw = e.code; }
    check("a file that is not the certified bytes is refused before any statement", threw === "FILE_NOT_CERTIFIED"); }

  console.log("\n── session: no transaction pooler ──");
  { process.env.PREFLIGHT_DATABASE_URL = "postgres://postgres@aws-0-eu-west-1.pooler.supabase.com:6543/postgres"; let threw = null; const db = fakeDb();
    try { await GS.runForward({ client: db.client, noRegistry: true, log: quiet }); } catch (e) { threw = e.code; }
    process.env.PREFLIGHT_DATABASE_URL = saved;
    check("port 6543 (transaction pooler) refused before any statement", threw === "POOLER" && db.log.length === 0); }
  { const db = fakeDb({ pids: [11, 12] }); let threw = null;
    try { await GS.runForward({ client: db.client, noRegistry: true, log: quiet }); } catch (e) { threw = e.code; }
    check("statements answered by different server sessions: refused before the lock, nothing applied", threw === "POOLER" && !db.log.includes("LOCK_TRY") && !db.log.some((x) => /^APPLY/.test(x))); }

  console.log("\n── rollback: ONE transaction ──");
  { const db = fakeDb({ catalog: "BEFORE_151" }); db.ledger = [149, 150]; const r = await GS.runRollback({ client: db.client, log: quiet });
    const applied = db.log.filter((x) => /^APPLY|LOCK_TRY|UNLOCK|^BEGIN$|^COMMIT$/.test(x));
    check("happy path: lock -> BEGIN -> rb150 -> rb149 -> COMMIT -> unlock, catalog BEFORE_149, ledger untouched", r.code === 0 && db.catalog === "BEFORE_149" && JSON.stringify(db.ledger) === "[149,150]" && JSON.stringify(applied) === JSON.stringify(["LOCK_TRY", "BEGIN", "APPLY_RB150", "APPLY_RB149", "COMMIT", "UNLOCK"]), JSON.stringify(applied)); }
  { const db = fakeDb({ catalog: "BEFORE_151", st: { open_services: 1 } }); const r = await GS.runRollback({ client: db.client, log: quiet });
    check("rollback refused with an open service: nothing applied", r.result === "REFUSED_PRECONDITION" && !db.log.some((x) => /^APPLY/.test(x)) && !db.lockHeld); }
  { const db = fakeDb({ catalog: "BEFORE_149" }); const r = await GS.runRollback({ client: db.client, log: quiet });
    check("rollback refused when the database is not exactly at 150", r.result === "REFUSED_NOT_AT_150" && !db.log.some((x) => /^APPLY/.test(x))); }
  { const db = fakeDb({ catalog: "BEFORE_151", failOn: ["APPLY_RB149"] }); const r = await GS.runRollback({ client: db.client, log: quiet });
    check("rb149 refused -> the whole rollback is rolled back: still at 150, lock released, no second transaction", r.result === "REFUSED_ROLLBACK_ROLLED_BACK" && db.catalog === "BEFORE_151" && !db.lockHeld && !db.log.includes("COMMIT") && !db.log.includes("APPLY_150")); }

  console.log("\n── the lock is the one every service opening and the terminal close take ──");
  const mig = (n) => fs.readFileSync(path.join(__dirname, "..", "migrations", fs.readdirSync(path.join(__dirname, "..", "migrations")).find((f) => new RegExp(`_migration_${n}\\.sql$`).test(f))), "utf8");
  check("the guarded step locks hashtext('service_session_lifecycle')", GS.LIFECYCLE_LOCK_SQL === "hashtext('service_session_lifecycle')");
  check("143 (order intake prelude, the first lock of every intake) takes that same lock", /pg_advisory_xact_lock\(hashtext\('service_session_lifecycle'\)\)/.test(mig(143)));
  check("139 (close_service_session_v3, the terminal close) takes that same lock", /pg_advisory_xact_lock\(hashtext\('service_session_lifecycle'\)\)/.test(mig(139)));
  check("the H-1 state and the open services are 'open' / 'closing', the only states close_service_session_v3 transitions", /status IN \('open', 'closing'\)/.test(GS.STATE_SQL) && /NOT IN \('open','closing'\)/.test(mig(139)));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
