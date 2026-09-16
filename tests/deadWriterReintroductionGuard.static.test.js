"use strict";
// PRE_UAT_LIFECYCLE_HYGIENE Part 8 — PERMANENT reintroduction guard.
//
// Protects the RUNTIME/CANONICAL surface, not historical text: replays every
// FORWARD migration file (never *.ROLLBACK.sql) in filename order, tracking
// only the LATEST CREATE/DROP statement for each guarded function name --
// same replay technique as tests/serviceSessionCreationSurface.static.test.js.
// A plain grep for the name would fail LOUDLY on its own perfectly legitimate
// history (the migration that created it, the migration that dropped it, a
// dozen explanatory comments in unrelated files); this guard ignores all of
// that and asks exactly one question: after every migration currently in
// this repo has been replayed in order, was the last statement executed on
// the function a DROP? Only a FUTURE forward migration re-creating it after
// the DROP can ever fail this test.
//
// Guarded today: public.open_business_day_v1(text,text) -- DROPped by
// migrations/2026-09-16_o5_order_intake_first_service_boundary_single_
// authority_migration_136.sql, proven DEAD (zero callers anywhere, born
// DORMANT per its own introducing migration's words). If a legitimate future
// slice ever needs a Business-Day-pointer writer, it must introduce it under
// a NEW name with its own reviewed migration -- this guard is not a ban on
// the capability, only on this exact retired entry point silently reappearing.
//
// Detection (FINAL BLOCKER FIX hardening -- the first version was bypassed by
// a schema-less, a lowercase and a quoted-identifier re-creation):
//   * CREATE [OR REPLACE] FUNCTION, any letter case, any whitespace;
//   * schema qualifier optional, "public" optionally quoted;
//   * function identifier optionally quoted;
//   * DROP FUNCTION with or without IF EXISTS, same identifier rules;
//   * SQL comments (-- line, /* block */) are stripped BEFORE matching, so a
//     comment that merely mentions or quotes the statement is inert;
//   * *.ROLLBACK.sql files are never replayed (a rollback legitimately
//     re-creates what its forward dropped).
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };

const MIG_DIR = path.join(__dirname, "..", "migrations");
const GUARDED = ["open_business_day_v1"];

function stripSqlComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

function statementRes(name) {
  const ident = `(?:"?public"?\\s*\\.\\s*)?"?${name}"?(?![A-Za-z0-9_$])`;
  return {
    create: new RegExp(`\\bCREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${ident}\\s*\\(`, "gi"),
    drop: new RegExp(`\\bDROP\\s+FUNCTION\\s+(?:IF\\s+EXISTS\\s+)?${ident}`, "gi"),
  };
}

const isForwardMigration = (f) => f.endsWith(".sql") && !/\.ROLLBACK\.sql$/i.test(f);

// files: [{ name, text }] -- replayed in filename order, like the real ledger.
function replayFinalState(files, names = GUARDED) {
  const ordered = files.filter((f) => isForwardMigration(f.name))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const state = {};
  for (const name of names) state[name] = { exists: false, lastFile: null };
  for (const f of ordered) {
    const text = stripSqlComments(f.text);
    for (const name of names) {
      const { create, drop } = statementRes(name);
      let last = null, lastIdx = -1, m;
      while ((m = create.exec(text))) if (m.index > lastIdx) { lastIdx = m.index; last = "create"; }
      while ((m = drop.exec(text))) if (m.index > lastIdx) { lastIdx = m.index; last = "drop"; }
      if (last) state[name] = { exists: last === "create", lastFile: f.name };
    }
  }
  return state;
}

// ── 1. The real repository ────────────────────────────────────────────────
const repoFiles = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql"))
  .map((name) => ({ name, text: fs.readFileSync(path.join(MIG_DIR, name), "utf8") }));
const state = replayFinalState(repoFiles);

console.log("\n== Dead-writer permanent reintroduction guard ==");
for (const name of GUARDED) {
  assert(`${name}: appears in the forward migration history at all`,
    state[name].lastFile !== null, "never appears in any forward migration -- census itself may be stale");
  assert(`${name}: the LATEST statement across the full replay is a DROP (it must not exist in the final runtime surface)`,
    state[name].exists === false,
    `latest statement was CREATE, in ${state[name].lastFile} -- a migration re-created this proven-dead function`);
}

// ── 2. Self-test of the SAME replay function on synthetic histories ───────
// Not a regex-against-a-string tautology: every case runs replayFinalState()
// itself over a synthetic migration history and checks the final verdict.
console.log("\n== Self-test: the replay detects every re-creation shape, ignores inert text ==");
const BIRTH = { name: "2026-01-01_birth.sql", text: "CREATE OR REPLACE FUNCTION public.open_business_day_v1(p_opened_by text, p_source text) RETURNS jsonb LANGUAGE sql AS $f$ SELECT '{}'::jsonb $f$;" };
const DEATH = { name: "2026-01-02_death.sql", text: "DROP FUNCTION IF EXISTS public.open_business_day_v1(text, text);" };
const verdict = (...later) => replayFinalState([BIRTH, DEATH, ...later]).open_business_day_v1.exists;
const future = (text, name = "2099-01-01_future.sql") => ({ name, text });

assert("baseline history (create, then drop) ends DROPPED", verdict() === false);
const MUST_DETECT = {
  "standard CREATE OR REPLACE public.": "CREATE OR REPLACE FUNCTION public.open_business_day_v1(a text, b text) RETURNS jsonb LANGUAGE sql AS $f$ SELECT NULL::jsonb $f$;",
  "plain CREATE FUNCTION with extra spacing": "CREATE   FUNCTION\n  public.open_business_day_v1 (a text, b text) RETURNS jsonb LANGUAGE sql AS $f$ SELECT NULL::jsonb $f$;",
  "no schema qualifier": "CREATE OR REPLACE FUNCTION open_business_day_v1(a text, b text) RETURNS jsonb LANGUAGE sql AS $f$ SELECT NULL::jsonb $f$;",
  "lowercase statement": "create or replace function public.open_business_day_v1(a text, b text) returns jsonb language sql as $f$ select null::jsonb $f$;",
  "quoted identifier": "CREATE OR REPLACE FUNCTION public.\"open_business_day_v1\"(a text, b text) RETURNS jsonb LANGUAGE sql AS $f$ SELECT NULL::jsonb $f$;",
  "quoted schema and identifier": "CREATE FUNCTION \"public\" . \"open_business_day_v1\"(a text) RETURNS jsonb LANGUAGE sql AS $f$ SELECT NULL::jsonb $f$;",
};
for (const [label, text] of Object.entries(MUST_DETECT)) {
  assert(`detects re-creation: ${label}`, verdict(future(text)) === true);
}
const MUST_IGNORE = {
  "line comment quoting the statement": "-- never again: CREATE OR REPLACE FUNCTION public.open_business_day_v1(a text) ...\nSELECT 1;",
  "block comment quoting the statement": "/* history: CREATE FUNCTION open_business_day_v1(a text) was dropped by O-5 */\nSELECT 1;",
  "catalog lookup by name": "DO $$ BEGIN IF to_regprocedure('public.open_business_day_v1(text,text)') IS NOT NULL THEN RAISE EXCEPTION 'x'; END IF; END $$;",
  "a differently named function sharing the prefix": "CREATE OR REPLACE FUNCTION public.open_business_day_v1_audit(a text) RETURNS jsonb LANGUAGE sql AS $f$ SELECT NULL::jsonb $f$;",
};
for (const [label, text] of Object.entries(MUST_IGNORE)) {
  assert(`stays DROPPED despite: ${label}`, verdict(future(text)) === false);
}
assert("a *.ROLLBACK.sql re-creating the function is never replayed",
  verdict(future(MUST_DETECT["standard CREATE OR REPLACE public."], "2099-01-01_future.ROLLBACK.sql")) === false);
assert("DROP without IF EXISTS (and quoted) after a re-creation ends DROPPED again",
  verdict(future(MUST_DETECT["lowercase statement"], "2099-01-01_a.sql"), future('DROP FUNCTION "open_business_day_v1"(text, text);', "2099-01-02_b.sql")) === false);

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
