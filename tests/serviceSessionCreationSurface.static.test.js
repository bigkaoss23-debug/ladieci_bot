"use strict";
// F-7 — HARD STATIC GATE on the service_sessions creation surface. Replays
// every FORWARD migration file (never *.ROLLBACK.sql, which deliberately
// restores retired creators for reversal purposes only, not normal runtime)
// in filename order, tracking the LATEST known CREATE (OR REPLACE) FUNCTION
// body for every distinct function name — a real migration replay, not a
// live-DB snapshot, so it holds even offline and even before a slice's own
// migration has been applied for real. For each function whose latest body
// contains `INSERT INTO service_sessions`, it is a "creator". This file
// fails LOUDLY the moment a future migration introduces a NEW creator (or
// resurrects INSERT capability in an existing one) that this allowlist does
// not already know about — it does not rely on anyone remembering to update
// a comment.
//
// Filename-lexical order is verified against the real ledger's apply_order
// for every file this test's own target functions touch (11 files, cross-
// checked live against public.ladieci_schema_migrations during F-7's Phase
// 0 audit: 34, 38, 62, 65, 77, 78, 81, 84, 86, 91, and F-7's own unregistered
// 92) — lexical order matches apply order exactly for this file set,
// including the one date collision (2026-08-16, three files: r_day3_
// business_day_intake_authority=77 < r_day3_hotfix_resolver_bootstrap_
// demotion=78 < s_a_ensure_service_session_period_reuse=81, which is also
// their lexical order). This is not assumed generally true repo-wide (the
// manifest itself documents exceptions elsewhere) — it is verified true for
// exactly the files this gate depends on.
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };

const MIG_DIR = path.join(__dirname, "..", "migrations");

function replayLatestFunctionBodies() {
  const files = fs.readdirSync(MIG_DIR)
    .filter((f) => f.endsWith(".sql") && !f.includes("ROLLBACK"))
    .sort();
  const latest = {};
  for (const f of files) {
    const text = fs.readFileSync(path.join(MIG_DIR, f), "utf8");
    // This codebase's own established convention (verified across every
    // forward migration touching these functions): CREATE FUNCTION bodies
    // always use the $function$...$function$ dollar-quote tag; bare $$...$$
    // is reserved for anonymous DO blocks (predecessor guards/post-
    // conditions), never a real function body — so this pattern cannot
    // accidentally capture a DO block's text as a function's own body.
    const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.(\w+)\s*\([^;]*?\)[\s\S]*?\$function\$([\s\S]*?)\$function\$/g;
    let m;
    while ((m = re.exec(text))) {
      const [, name, body] = m;
      latest[name] = { file: f, body };
    }
  }
  return latest;
}

const latest = replayLatestFunctionBodies();

console.log("\n== A. Replay sanity — a non-trivial, real function set was found ==");
assert("1a: at least 20 distinct functions tracked across migration history (guards against an empty/broken scan)",
  Object.keys(latest).length >= 20, String(Object.keys(latest).length));
// 1b/1c/1d track WHICH migration file most recently (re)defines each of the
// three lifecycle-authority functions. They are bookkeeping anchors for the
// replay, not the guard itself — the actual frozen invariant is section B/C
// below (the creation surface is exactly three functions, and the two F-7
// cutover targets are non-creators). The anchors move whenever a later slice
// legitimately redefines a body:
//   F-6  (2026-08-18) introduced open_operational_service_v1
//   F-10 (2026-08-19) redefined resolve_order_intake_context_v1, row 93
//   F-11 (2026-08-19) redefined ensure_service_session, row 94
//   G-1  (2026-08-20) redefines ALL THREE in one slice, row 96: the
//        Operational Service now resumes by itself on the first real
//        activity after a same-day Finalizar
//        (open_operational_service_v1 gains the
//        'next_service_of_business_day' reason; the resolver calls it
//        instead of refusing with REOPEN_REQUIRED; ensure_service_session
//        reports that state as ordinary NO_OPEN_SERVICE idle).
const G1 = "2026-08-20_g1_autonomous_resume_operational_service.sql";
for (const [n, fn] of [["1b", "open_operational_service_v1"],
                       ["1c", "ensure_service_session"],
                       ["1d", "resolve_order_intake_context_v1"]]) {
  assert(`${n}: ${fn}'s latest definition is G-1's own migration file`,
    latest[fn] && latest[fn].file === G1,
    latest[fn] && latest[fn].file);
}

console.log("\n== B. The exact, frozen, expected creation surface ==");
const INSERT_RE = /INSERT\s+INTO\s+(?:public\.)?service_sessions\b/i;
const creators = Object.entries(latest)
  .filter(([, e]) => INSERT_RE.test(e.body))
  .map(([name, e]) => ({ name, file: e.file }))
  .sort((a, b) => a.name.localeCompare(b.name));

const EXPECTED_CREATORS = ["ensure_next_service_session_v3", "open_operational_service_v1", "roll_service_session_economic_v1"].sort();

assert("2a: exactly the expected 3 functions can INSERT INTO service_sessions in their LATEST definition -- no more, no fewer",
  creators.map((c) => c.name).join(",") === EXPECTED_CREATORS.join(","),
  JSON.stringify(creators));
assert("2b: open_operational_service_v1 is the canonical creator (F-6/F-7)",
  creators.some((c) => c.name === "open_operational_service_v1"));
assert("2c: roll_service_session_economic_v1 remains a creator, unchanged by F-7 -- contained via ECONOMIC_PERIOD_ROLLOVER_ENABLED, not cut over in this slice",
  creators.some((c) => c.name === "roll_service_session_economic_v1"));
assert("2d: ensure_next_service_session_v3 remains a creator, unchanged by F-7 -- dead code (zero callers since F-5), not touched in this slice",
  creators.some((c) => c.name === "ensure_next_service_session_v3"));

console.log("\n== C. The two F-7 cutover targets are confirmed NON-creators in their latest form ==");
assert("3a: ensure_service_session's latest body contains NO INSERT INTO service_sessions",
  !INSERT_RE.test(latest.ensure_service_session.body));
assert("3b: resolve_order_intake_context_v1's latest body contains NO direct INSERT INTO service_sessions",
  !INSERT_RE.test(latest.resolve_order_intake_context_v1.body));
assert("3c: resolve_order_intake_context_v1's latest body DOES call the canonical primitive for its first-ever-lazy-open path",
  /open_operational_service_v1\s*\(/.test(latest.resolve_order_intake_context_v1.body));

console.log("\n== D. Regression tripwire -- this test itself must be able to detect a reintroduced creator ==");
{
  // Prove the detector actually works, not just that today's data happens to
  // pass: inject a synthetic INSERT into a COPY of a known non-creator's
  // body and confirm the SAME regex used above flags it. This guards
  // against a future edit to INSERT_RE silently making this gate a no-op.
  const poisoned = latest.ensure_service_session.body + "\n  INSERT INTO public.service_sessions (business_date) VALUES (now());\n";
  assert("4a: the detector DOES fire on a synthetically reintroduced creator (tripwire self-test)", INSERT_RE.test(poisoned));
}

console.log("\n=== RESULT: " + pass + " passed, " + fail + " failed ===");
process.exit(fail === 0 ? 0 : 1);
