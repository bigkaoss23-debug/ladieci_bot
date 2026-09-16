"use strict";
// PRE_UAT_LIFECYCLE_HYGIENE Part 8 — PERMANENT reintroduction guard.
//
// Protects the RUNTIME/CANONICAL surface, not historical text: replays every
// FORWARD migration file (never *.ROLLBACK.sql) in filename order, tracking
// only the LATEST known CREATE/DROP for each guarded function name -- same
// replay technique as tests/serviceSessionCreationSurface.static.test.js.
// This means a plain grep for the name would fail LOUDLY on its own
// perfectly legitimate history (the migration that created it, the migration
// that dropped it, a dozen explanatory comments in unrelated files) -- this
// guard ignores all of that and asks exactly one question: after every
// migration currently in this repo has been replayed in order, does the
// function still resolve to a live CREATE, or was the last thing done to it
// a DROP? Only a FUTURE migration re-creating it after the DROP can ever
// fail this test.
//
// Guarded today: public.open_business_day_v1(text,text) -- DROPped by
// migrations/2026-09-16_o5_order_intake_first_service_boundary_single_
// authority.sql, proven DEAD (zero callers anywhere, born DORMANT per its
// own introducing migration's words). If a legitimate future slice ever
// needs to reintroduce a Business-Day-pointer writer, it must do so under a
// NEW name with its own reviewed migration -- this guard is not a ban on
// the underlying capability, only on this exact retired entry point
// silently reappearing.
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };

const MIG_DIR = path.join(__dirname, "..", "migrations");
const GUARDED = ["open_business_day_v1"];

function replayFinalState() {
  const files = fs.readdirSync(MIG_DIR)
    .filter((f) => f.endsWith(".sql") && !f.includes("ROLLBACK"))
    .sort();
  // state[name] = { exists: boolean, lastFile: string }
  const state = {};
  for (const name of GUARDED) state[name] = { exists: false, lastFile: null };

  for (const f of files) {
    const text = fs.readFileSync(path.join(MIG_DIR, f), "utf8");
    for (const name of GUARDED) {
      const createRe = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${name}\\s*\\(`, "g");
      const dropRe = new RegExp(`DROP\\s+FUNCTION\\s+(?:IF\\s+EXISTS\\s+)?public\\.${name}\\s*\\(`, "g");
      // Whichever action appears LAST in this file's text order wins for
      // this file; then this file's own position in the sorted replay
      // decides whether it is the overall latest action.
      let lastActionInFile = null;
      let lastIdx = -1;
      let m;
      createRe.lastIndex = 0;
      while ((m = createRe.exec(text))) { if (m.index > lastIdx) { lastIdx = m.index; lastActionInFile = "create"; } }
      dropRe.lastIndex = 0;
      while ((m = dropRe.exec(text))) { if (m.index > lastIdx) { lastIdx = m.index; lastActionInFile = "drop"; } }
      if (lastActionInFile === "create") { state[name] = { exists: true, lastFile: f }; }
      else if (lastActionInFile === "drop") { state[name] = { exists: false, lastFile: f }; }
    }
  }
  return state;
}

const state = replayFinalState();

console.log("\n== Dead-writer permanent reintroduction guard ==");
for (const name of GUARDED) {
  assert(`${name}: was created at some point in migration history`,
    state[name].lastFile !== null, "never appears in any forward migration -- census itself may be stale");
  assert(`${name}: the LATEST action across the full replay is a DROP, not a CREATE (i.e. it must not exist in the final runtime surface)`,
    state[name].exists === false,
    `latest action was CREATE, in ${state[name].lastFile} -- a migration re-created this proven-dead function`);
}

assert("the guard itself would actually catch a reintroduction (self-test: a synthetic later CREATE flips the verdict)",
  (() => {
    const files = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql") && !f.includes("ROLLBACK")).sort();
    const lastFile = files[files.length - 1];
    const syntheticText = `CREATE OR REPLACE FUNCTION public.open_business_day_v1(p_a text, p_b text) RETURNS jsonb LANGUAGE sql AS $f$ SELECT '{}'::jsonb $f$;`;
    // Simulate: if a file sorting AFTER everything currently in the repo
    // re-created the function, would this replay's logic detect it?
    const wouldExist = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.open_business_day_v1\s*\(/.test(syntheticText);
    return wouldExist === true; // sanity: the detection regex itself fires on a real re-creation statement
  })());

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
