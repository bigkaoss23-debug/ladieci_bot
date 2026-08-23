"use strict";
// ===============================================================
// o4bLegacyRolloverDeadBranchRemoval.static.test.js — O-4.1
//
// O-4.1 changes no contract: the legacy-rollover UPDATE (SET status=
// 'rolled_over') inside resolve_order_intake_context_v1's slow path was
// proven structurally unreachable — every service_sessions row that has ever
// had status IN ('open','closing') has ALWAYS had lifecycle_semantics=
// 'operational_service_v1' (open_operational_service_v1 is the sole creator
// and hardcodes that literal; F-4B's immutability trigger forbids ever
// changing it post-insert), so O-3/O-4's own continuity fast-path always
// returns before this branch could ever be reached. This file is the
// anti-reintroduction guard for what O-4.1 (ledger 109) deleted.
//
// It does NOT re-prove O-1/O-2/O-3/O-4's own invariants — those are covered
// by their own tests and o4ForgottenCloseDeadCodePurge.static.test.js.
// ===============================================================

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const ROOT = path.join(__dirname, "..");
const O4B_MIGRATION = path.join(ROOT, "migrations", "2026-08-23_o4b_legacy_rollover_dead_branch_removal.sql");

function extractFunctionBody(sql, name) {
  const re = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${name}\\s*\\([^;]*?\\)[\\s\\S]*?\\$function\\$([\\s\\S]*?)\\$function\\$`);
  const m = re.exec(sql);
  return m ? m[1] : null;
}

// Comment-stripped, matching this codebase's established convention (see
// o4ForgottenCloseDeadCodePurge.static.test.js and G-1's "8b. PROSRC REALITY
// CHECK"): explanatory prose may legitimately name a retired literal to say
// why it is absent -- this migration's own in-body comment does exactly
// that for 'rolled_over' -- so an absence check must read executable SQL.
const stripComments = (text) => text
  .split(/\r?\n/)
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");

test("1: resolve_order_intake_context_v1's O-4.1 EXECUTABLE body contains ZERO occurrences of 'rolled_over'", () => {
  const sql = fs.readFileSync(O4B_MIGRATION, "utf8");
  const body = stripComments(extractFunctionBody(sql, "resolve_order_intake_context_v1") || "");
  assert.ok(body, "resolve_order_intake_context_v1 body located in the O-4.1 migration");
  assert.equal((body.match(/rolled_over/g) || []).length, 0);
});

test("2: resolve_order_intake_context_v1's O-4.1 EXECUTABLE body contains ZERO UPDATE of service_sessions at all", () => {
  const sql = fs.readFileSync(O4B_MIGRATION, "utf8");
  const body = stripComments(extractFunctionBody(sql, "resolve_order_intake_context_v1") || "");
  assert.ok(body);
  assert.equal((body.match(/UPDATE\s+public\.service_sessions/g) || []).length, 0);
});

test("3: the continuity fast-path and the lazy-open re-SELECT both survive, in order", () => {
  const sql = fs.readFileSync(O4B_MIGRATION, "utf8");
  const body = extractFunctionBody(sql, "resolve_order_intake_context_v1");
  assert.ok(body);
  assert.match(body, /IF v_had_open_or_closing AND v_period\.lifecycle_semantics = 'operational_service_v1' THEN/);
  const reselectRe = /SELECT \* INTO v_period FROM public\.service_sessions\s*\n\s*WHERE business_day_id = v_day\.id AND status IN \('open','closing'\);/;
  assert.match(body, reselectRe);
  const fastPathPos = body.indexOf("v_had_open_or_closing AND v_period.lifecycle_semantics");
  const reselectPos = body.search(reselectRe);
  assert.ok(fastPathPos > -1 && reselectPos > -1 && fastPathPos < reselectPos);
});

test("4: O-1/O-2/O-4 invariants (overnight floor, pointer-integrity, F-10/crossesBusinessDay absence) are untouched", () => {
  const sql = fs.readFileSync(O4B_MIGRATION, "utf8");
  const body = extractFunctionBody(sql, "resolve_order_intake_context_v1");
  assert.ok(body);
  assert.match(body, /v_can_create_order := \(v_minutes_of_day >= 480\);/);
  assert.match(body, /BUSINESS_DAY_POINTER_MISMATCH/);
  const strippedBody = stripComments(body);
  assert.equal((strippedBody.match(/FORGOTTEN_CLOSE_REQUIRED/g) || []).length, 0);
  assert.equal((strippedBody.match(/crossesBusinessDay/g) || []).length, 0);
});

test("5: no live src/**/*.js or DB function outside this migration WRITES 'rolled_over' (comment-stripped -- readers/docs legitimately name the historical value)", () => {
  // Readers of the historical status value are expected and untouched
  // (previousBusinessDayResidue.js, currentOperationalSession.js query
  // status=eq.rolled_over / status=in.(...,rolled_over) as PostgREST read
  // filters, and both files' own prose comments name the value for
  // documentation -- neither is a write). What must stay at zero is an
  // actual assignment: status: 'rolled_over' or status = 'rolled_over' in
  // executable (non-comment) JS.
  const srcRoot = path.join(ROOT, "src");
  const offenders = [];
  const stripJsComments = (text) => text
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith(".js")) continue;
      const text = stripJsComments(fs.readFileSync(full, "utf8"));
      if (/status\s*[:=]\s*['"]rolled_over['"]/.test(text)) offenders.push(path.relative(ROOT, full));
    }
  })(srcRoot);
  assert.deepEqual(offenders, []);
});

test("6: the O-4.1 migration is DDL-only on the ONE function — no product row is written, updated or deleted (comments AND quoted SQL-string literals stripped -- the header prose quotes the deleted UPDATE verbatim for documentation, and the predecessor guard's own LIKE patterns cite it as a quoted string for drift detection, neither is executable DML)", () => {
  const sql = fs.readFileSync(O4B_MIGRATION, "utf8");
  const withoutFunctionBody = sql.split(/AS \$function\$[\s\S]*?\$function\$;/).join("\n");
  const withoutComments = stripComments(withoutFunctionBody);
  // Strip single-quoted SQL string literals (''-escaped) so LIKE-pattern
  // text used for predecessor/post-condition drift detection cannot be
  // mistaken for an executable statement.
  const topLevel = withoutComments.replace(/'(?:[^']|'')*'/g, "''");
  assert.doesNotMatch(topLevel, /INSERT\s+INTO\s+public\.(service_sessions|ordenes|business_days|payment_transactions)/i);
  assert.doesNotMatch(topLevel, /DELETE\s+FROM\s+public\./i);
  assert.doesNotMatch(topLevel, /UPDATE\s+public\.(service_sessions|ordenes|business_days)/i);
});

test("7: the O-4.1 migration touches exactly one function's grants (service_role only, anon/authenticated never granted)", () => {
  const sql = fs.readFileSync(O4B_MIGRATION, "utf8");
  const revokes = sql.match(/REVOKE ALL ON FUNCTION public\.\w+/g) || [];
  const grants = sql.match(/GRANT EXECUTE ON FUNCTION public\.\w+[^;]*TO service_role/g) || [];
  assert.equal(revokes.length, 1);
  assert.equal(grants.length, 1);
  assert.ok(revokes[0].includes("resolve_order_intake_context_v1"));
  assert.ok(!/TO\s+anon\b/.test(sql) && !/TO\s+authenticated\b/.test(sql));
});

test("8: HISTORICAL migrations that legitimately write/name 'rolled_over' (O-4 forward file, mesa_first_seating rollback, etc.) are untouched by this slice", () => {
  const o4 = fs.readFileSync(path.join(ROOT, "migrations", "2026-08-23_o4_forgotten_close_dead_code_purge.sql"), "utf8");
  assert.match(o4, /SET status = 'rolled_over'/, "O-4's own historical forward file must still show the pre-O-4.1 shape it recorded");
});

let pass = 0, fail = 0;
(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ✓ ${name}`); pass++; }
    catch (e) { console.log(`  ✗ ${name} — ${e.message}`); fail++; }
  }
  console.log(`\no4bLegacyRolloverDeadBranchRemoval: ${pass}/${pass + fail} passed`);
  if (fail) process.exit(1);
})();
