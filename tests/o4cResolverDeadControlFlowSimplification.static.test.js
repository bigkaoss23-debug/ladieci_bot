"use strict";
// ===============================================================
// o4cResolverDeadControlFlowSimplification.static.test.js — O-4.2
//
// O-4.2 changes no contract: the outer same-business-day-reuse branch
// (`IF v_had_open_or_closing AND v_period.business_day_id = v_day.id THEN
// v_period_needs_advance := false; ELSE v_period_needs_advance := true;
// ...`) inside resolve_order_intake_context_v1's slow path was proven
// structurally unreachable in its TRUE arm — O-4.1 already established that
// every open/closing row shares the modern lifecycle semantics, so the
// continuity fast-path above always returns first, meaning
// v_had_open_or_closing is provably always false by the time this branch is
// reached. Its ELSE arm was therefore the only value ever reachable, making
// v_period_needs_advance a constant, not a decision. This file is the
// anti-reintroduction guard for what O-4.2 (ledger 110) deleted.
//
// It does NOT re-prove O-1/O-2/O-3/O-4/O-4.1's own invariants — those are
// covered by their own tests.
// ===============================================================

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const ROOT = path.join(__dirname, "..");
const O4C_MIGRATION = path.join(ROOT, "migrations", "2026-08-24_o4c_resolver_dead_control_flow_simplification.sql");

function extractFunctionBody(sql, name) {
  const re = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${name}\\s*\\([^;]*?\\)[\\s\\S]*?\\$function\\$([\\s\\S]*?)\\$function\\$`);
  const m = re.exec(sql);
  return m ? m[1] : null;
}

test("1: resolve_order_intake_context_v1's O-4.2 body contains ZERO occurrences of v_period_needs_advance", () => {
  const sql = fs.readFileSync(O4C_MIGRATION, "utf8");
  const body = extractFunctionBody(sql, "resolve_order_intake_context_v1");
  assert.ok(body, "resolve_order_intake_context_v1 body located in the O-4.2 migration");
  assert.equal((body.match(/v_period_needs_advance/g) || []).length, 0);
});

test("2: resolve_order_intake_context_v1's O-4.2 body has EXACTLY three v_had_open_or_closing occurrences (DECLARE + assignment + the live fast-path use)", () => {
  const sql = fs.readFileSync(O4C_MIGRATION, "utf8");
  const body = extractFunctionBody(sql, "resolve_order_intake_context_v1");
  assert.ok(body);
  assert.equal((body.match(/v_had_open_or_closing/g) || []).length, 3);
});

test("3: the slow-path RETURN reports the literal 'advanced', true", () => {
  const sql = fs.readFileSync(O4C_MIGRATION, "utf8");
  const body = extractFunctionBody(sql, "resolve_order_intake_context_v1");
  assert.ok(body);
  assert.match(body, /'advanced', true\s*\n\s*\);/);
});

test("4: the continuity fast-path and the (now-unconditional) re-SELECT + lazy-open both survive, in order", () => {
  const sql = fs.readFileSync(O4C_MIGRATION, "utf8");
  const body = extractFunctionBody(sql, "resolve_order_intake_context_v1");
  assert.ok(body);
  assert.match(body, /IF v_had_open_or_closing AND v_period\.lifecycle_semantics = 'operational_service_v1' THEN/);
  const reselectRe = /SELECT \* INTO v_period FROM public\.service_sessions\s*\n\s*WHERE business_day_id = v_day\.id AND status IN \('open','closing'\);/;
  assert.match(body, reselectRe);
  assert.match(body, /open_operational_service_v1\(/);
  const fastPathPos = body.indexOf("v_had_open_or_closing AND v_period.lifecycle_semantics");
  const reselectPos = body.search(reselectRe);
  assert.ok(fastPathPos > -1 && reselectPos > -1 && fastPathPos < reselectPos);
});

test("5: O-1/O-2/O-4/O-4.1 invariants (overnight floor, pointer-integrity, F-10/crossesBusinessDay/rolled_over absence) are untouched", () => {
  const sql = fs.readFileSync(O4C_MIGRATION, "utf8");
  const body = extractFunctionBody(sql, "resolve_order_intake_context_v1");
  assert.ok(body);
  assert.match(body, /v_can_create_order := \(v_minutes_of_day >= 480\);/);
  assert.match(body, /BUSINESS_DAY_POINTER_MISMATCH/);
  assert.equal((body.match(/FORGOTTEN_CLOSE_REQUIRED/g) || []).length, 0);
  assert.equal((body.match(/crossesBusinessDay/g) || []).length, 0);
  assert.equal((body.match(/rolled_over/g) || []).length, 0);
  assert.equal((body.match(/UPDATE public\.service_sessions/g) || []).length, 0);
});

test("6: the O-4.2 migration is DDL-only on the ONE function — no product row is written, updated or deleted", () => {
  const sql = fs.readFileSync(O4C_MIGRATION, "utf8");
  const topLevel = sql.split(/AS \$function\$[\s\S]*?\$function\$;/).join("\n");
  assert.doesNotMatch(topLevel, /INSERT\s+INTO\s+public\.(service_sessions|ordenes|business_days|payment_transactions)/i);
  assert.doesNotMatch(topLevel, /DELETE\s+FROM\s+public\./i);
});

test("7: the O-4.2 migration touches exactly one function's grants (service_role only, anon/authenticated never granted)", () => {
  const sql = fs.readFileSync(O4C_MIGRATION, "utf8");
  const revokes = sql.match(/REVOKE ALL ON FUNCTION public\.\w+/g) || [];
  const grants = sql.match(/GRANT EXECUTE ON FUNCTION public\.\w+[^;]*TO service_role/g) || [];
  assert.equal(revokes.length, 1);
  assert.equal(grants.length, 1);
  assert.ok(revokes[0].includes("resolve_order_intake_context_v1"));
  assert.ok(!/TO\s+anon\b/.test(sql) && !/TO\s+authenticated\b/.test(sql));
});

test("8: no live src/**/*.js references v_had_open_or_closing or v_period_needs_advance (PL/pgSQL-local, never crosses to JS)", () => {
  const srcRoot = path.join(ROOT, "src");
  const offenders = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith(".js")) continue;
      const text = fs.readFileSync(full, "utf8");
      if (/v_had_open_or_closing|v_period_needs_advance/.test(text)) offenders.push(path.relative(ROOT, full));
    }
  })(srcRoot);
  assert.deepEqual(offenders, []);
});

let pass = 0, fail = 0;
(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ✓ ${name}`); pass++; }
    catch (e) { console.log(`  ✗ ${name} — ${e.message}`); fail++; }
  }
  console.log(`\no4cResolverDeadControlFlowSimplification: ${pass}/${pass + fail} passed`);
  if (fail) process.exit(1);
})();
