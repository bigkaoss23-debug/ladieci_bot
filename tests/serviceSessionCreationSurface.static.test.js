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
//   O-1  (2026-08-23) redefines resolve_order_intake_context_v1 AGAIN, row
//        107: removes the 17:30-18:00 order-intake blackout (canCreateNewOrder
//        simplifies to a single overnight-floor check). open_operational_
//        service_v1/ensure_service_session are untouched by O-1 and stay
//        pinned to G-1.
//   O-2  (2026-08-23) redefines resolve_order_intake_context_v1 A THIRD time,
//        row 108: relocates the pre-existing open/closing lookup before the
//        intake gate and adds the continuity check (00:00-08:00 no longer
//        blocks an already-open, same-business-date service). open_
//        operational_service_v1/ensure_service_session remain untouched and
//        stay pinned to G-1.
//   O-3  (2026-08-23, task label F-10B) redefines resolve_order_intake_
//        context_v1 A FOURTH time, row 109: an open operational_service_v1
//        is now unconditional continuity regardless of business_date — the
//        Business Day boundary itself no longer hard-stops a still-open
//        service, only an explicit Finalizar does. Filename is o3, not
//        f10b, so it still sorts lexically after o1/o2 for this replay.
//        open_operational_service_v1/ensure_service_session remain
//        untouched and stay pinned to G-1.
//   O-4  (2026-08-23) redefines resolve_order_intake_context_v1 A FIFTH
//        time, row 110: post-O-3 dead-code purge — deletes the now-
//        structurally-unreachable FORGOTTEN_CLOSE_REQUIRED raise and the
//        unconsumed crossesBusinessDay field. No contract change; see this
//        file's own header for the reachability proof. open_operational_
//        service_v1/ensure_service_session remain untouched and stay
//        pinned to G-1.
//   O-4.1 (2026-08-23) redefines resolve_order_intake_context_v1 A SIXTH
//        time, row 111: deletes the legacy-rollover UPDATE (SET status=
//        'rolled_over'), the one piece of the same dead-code shape O-4's
//        own report flagged but had not yet removed — proven structurally
//        unreachable by a closed creation surface (open_operational_
//        service_v1 hardcodes lifecycle_semantics) plus an immutability
//        trigger (F-4B) on that same column, so O-4's continuity fast-path
//        always returns first. No contract change. Filename is o4b, not
//        o4_1, so it still sorts lexically after o4_forgotten_close_
//        dead_code_purge.sql for this replay. open_operational_service_v1/
//        ensure_service_session remain untouched and stay pinned to G-1.
const G1 = "2026-08-20_g1_autonomous_resume_operational_service.sql";
const O4B = "2026-08-23_o4b_legacy_rollover_dead_branch_removal.sql";
for (const [n, fn, expectedFile] of [["1b", "open_operational_service_v1", G1],
                       ["1c", "ensure_service_session", G1],
                       ["1d", "resolve_order_intake_context_v1", O4B]]) {
  assert(`${n}: ${fn}'s latest definition is ${expectedFile === O4B ? "O-4.1's" : "G-1's"} own migration file`,
    latest[fn] && latest[fn].file === expectedFile,
    latest[fn] && latest[fn].file);
}

console.log("\n== B. The exact, frozen, expected creation surface ==");
const INSERT_RE = /INSERT\s+INTO\s+(?:public\.)?service_sessions\b/i;
const creators = Object.entries(latest)
  .filter(([, e]) => INSERT_RE.test(e.body))
  .map(([name, e]) => ({ name, file: e.file }))
  .sort((a, b) => a.name.localeCompare(b.name));

// H-1 (LEGACY WRITER HARDENING, ledger 97) fail-closed the two legacy
// creators, so the surface is now exactly ONE function. This is strictly
// stronger than the previous "exactly these 3" assertion: before H-1 the two
// legacy creators were held back only by an unset env var
// (ECONOMIC_PERIOD_ROLLOVER_ENABLED) and by having no caller; now their bodies
// cannot insert at all.
const EXPECTED_CREATORS = ["open_operational_service_v1"];

assert("2a: EXACTLY ONE function can INSERT INTO service_sessions in its LATEST definition",
  creators.map((c) => c.name).join(",") === EXPECTED_CREATORS.join(","),
  JSON.stringify(creators));
assert("2b: and it is the canonical opener (F-6/F-7/G-1)",
  creators.length === 1 && creators[0].name === "open_operational_service_v1");
assert("2c (H-1): roll_service_session_economic_v1 is NO LONGER a creator -- fail-closed, not merely env-gated",
  !creators.some((c) => c.name === "roll_service_session_economic_v1"));
assert("2d (H-1): ensure_next_service_session_v3 is NO LONGER a creator -- fail-closed, not merely caller-less",
  !creators.some((c) => c.name === "ensure_next_service_session_v3"));
assert("2e (H-1): both retired creators return a typed refusal naming the replacement",
  /LEGACY_PERIOD_ROLLOVER_RETIRED/.test(latest.roll_service_session_economic_v1.body)
  && /LEGACY_SUCCESSOR_OPENER_RETIRED/.test(latest.ensure_next_service_session_v3.body),
  JSON.stringify({ roll: latest.roll_service_session_economic_v1.file, next: latest.ensure_next_service_session_v3.file }));

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
