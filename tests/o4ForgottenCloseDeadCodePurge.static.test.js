"use strict";
// ===============================================================
// o4ForgottenCloseDeadCodePurge.static.test.js — O-4
//
// O-4 changes no contract: O-3 (ledger 107) already made an open
// operational_service_v1 unconditional continuity across any Business Day
// boundary crossing, ending only on explicit Finalizar. This file is the
// anti-reintroduction guard for what O-4 (ledger 108) deleted as dead code
// once that contract made it unreachable: the FORGOTTEN_CLOSE_REQUIRED raise
// inside resolve_order_intake_context_v1, the unconsumed crossesBusinessDay
// field, the forgottenCloseRecovery.js recovery module, and both its callers.
//
// It does NOT re-prove the continuity contract itself — that is O-1/O-2/O-3's
// job (serviceSessionCreationSurface.static.test.js's replay,
// orderIntakePolicy.test.js's truth table, and this session's own live
// rollback-safe DB probes, documented in the session report, not committed
// as a permanent test since they require a real Postgres connection).
// ===============================================================

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const ROOT = path.join(__dirname, "..");
const O4_MIGRATION = path.join(ROOT, "migrations", "2026-08-23_o4_forgotten_close_dead_code_purge.sql");

function extractFunctionBody(sql, name) {
  const re = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${name}\\s*\\([^;]*?\\)[\\s\\S]*?\\$function\\$([\\s\\S]*?)\\$function\\$`);
  const m = re.exec(sql);
  return m ? m[1] : null;
}

// Comment-stripped: this codebase's own established convention (see
// g1AutonomousResumeOperationalService.static.test.js's "8b. PROSRC REALITY
// CHECK") is that explanatory prose comments MAY legitimately name a retired
// literal to say why it is absent (this migration's own header does exactly
// that for FORGOTTEN_CLOSE_REQUIRED/crossesBusinessDay) — so an absence check
// must read executable SQL, not comments, or it flags its own documentation.
const stripComments = (text) => text
  .split(/\r?\n/)
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");

test("1: resolve_order_intake_context_v1's O-4 EXECUTABLE body contains ZERO occurrences of FORGOTTEN_CLOSE_REQUIRED", () => {
  const sql = fs.readFileSync(O4_MIGRATION, "utf8");
  const body = stripComments(extractFunctionBody(sql, "resolve_order_intake_context_v1") || "");
  assert.ok(body, "resolve_order_intake_context_v1 body located in the O-4 migration");
  assert.equal((body.match(/FORGOTTEN_CLOSE_REQUIRED/g) || []).length, 0);
});

test("2: resolve_order_intake_context_v1's O-4 EXECUTABLE body contains ZERO occurrences of crossesBusinessDay", () => {
  const sql = fs.readFileSync(O4_MIGRATION, "utf8");
  const body = stripComments(extractFunctionBody(sql, "resolve_order_intake_context_v1") || "");
  assert.ok(body);
  assert.equal((body.match(/crossesBusinessDay/g) || []).length, 0);
});

test("3: the continuity fast-path survives O-4, unconditional and still reachable before the intake gate", () => {
  const sql = fs.readFileSync(O4_MIGRATION, "utf8");
  const body = extractFunctionBody(sql, "resolve_order_intake_context_v1");
  assert.ok(body);
  assert.match(body, /IF v_had_open_or_closing AND v_period\.lifecycle_semantics = 'operational_service_v1' THEN/);
  assert.match(body, /'advanced', false\s*\);/);
  const fastPathPos = body.indexOf("v_had_open_or_closing AND v_period.lifecycle_semantics");
  const gatePos = body.indexOf("IF NOT v_can_create_order AND NOT v_continuity THEN");
  assert.ok(fastPathPos > -1 && gatePos > -1 && fastPathPos < gatePos,
    "the continuity fast-path must precede the intake-window gate");
  assert.equal((body.match(/status IN \('open','closing'\) FOR UPDATE/g) || []).length, 1);
});

test("4: the O-1 overnight floor, O-2 pointer-integrity assertion, and 17:30 classification boundary are untouched", () => {
  const sql = fs.readFileSync(O4_MIGRATION, "utf8");
  const body = extractFunctionBody(sql, "resolve_order_intake_context_v1");
  assert.ok(body);
  assert.match(body, /v_can_create_order := \(v_minutes_of_day >= 480\);/);
  assert.match(body, /BUSINESS_DAY_POINTER_MISMATCH/);
  assert.match(body, /v_minutes_of_day >= 240 AND v_minutes_of_day < 1050/);
});

test("5: the legacy-rollover UPDATE remains, now unconditional, where the deleted raise used to gate it", () => {
  const sql = fs.readFileSync(O4_MIGRATION, "utf8");
  const body = extractFunctionBody(sql, "resolve_order_intake_context_v1");
  assert.ok(body);
  assert.match(body, /SET status = 'rolled_over', rolled_over_at = now\(\), updated_at = now\(\)/);
});

test("6: mesa_open_session_v1 / mesa_open_reservation_v1 (O-3, untouched by O-4) still contain ZERO FORGOTTEN_CLOSE_REQUIRED", () => {
  const o3 = fs.readFileSync(path.join(ROOT, "migrations", "2026-08-23_o3_operational_service_until_finalizar.sql"), "utf8");
  for (const fn of ["mesa_open_session_v1", "mesa_open_reservation_v1"]) {
    const body = extractFunctionBody(o3, fn);
    assert.ok(body, `${fn} body located in the O-3 migration`);
    assert.equal((body.match(/FORGOTTEN_CLOSE_REQUIRED/g) || []).length, 0, `${fn} must have zero FORGOTTEN_CLOSE_REQUIRED occurrences`);
  }
});

test("7: forgottenCloseRecovery.js no longer exists in the source tree", () => {
  assert.ok(!fs.existsSync(path.join(ROOT, "src", "serviceSessions", "forgottenCloseRecovery.js")));
});

test("8: no src/**/*.js file requires forgottenCloseRecovery.js any more (global anti-reintroduction sweep)", () => {
  const srcRoot = path.join(ROOT, "src");
  const offenders = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith(".js")) continue;
      const text = fs.readFileSync(full, "utf8");
      if (/require\([^)]*forgottenCloseRecovery['"]\)/.test(text)) offenders.push(path.relative(ROOT, full));
    }
  })(srcRoot);
  assert.deepEqual(offenders, []);
});

test("9: no src/**/*.js file contains a live FORGOTTEN_CLOSE_REQUIRED raise/parse/recover reference any more", () => {
  const srcRoot = path.join(ROOT, "src");
  const offenders = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith(".js")) continue;
      const text = fs.readFileSync(full, "utf8");
      if (/parseForgottenCloseRequired\(|recoverForgottenService\(|createForgottenCloseRecovery\(/.test(text)) {
        offenders.push(path.relative(ROOT, full));
      }
    }
  })(srcRoot);
  assert.deepEqual(offenders, []);
});

test("10: the O-4 migration is DDL-only on the ONE function — no product row is written, updated or deleted", () => {
  const sql = fs.readFileSync(O4_MIGRATION, "utf8");
  const topLevel = sql.split(/AS \$function\$[\s\S]*?\$function\$;/).join("\n");
  assert.doesNotMatch(topLevel, /INSERT\s+INTO\s+public\.(service_sessions|ordenes|business_days|payment_transactions)/i);
  assert.doesNotMatch(topLevel, /DELETE\s+FROM\s+public\./i);
  assert.doesNotMatch(topLevel, /UPDATE\s+public\.(service_sessions|ordenes|business_days)/i);
});

test("11: the O-4 migration touches exactly one function's grants (service_role only, anon/authenticated never granted)", () => {
  const sql = fs.readFileSync(O4_MIGRATION, "utf8");
  const revokes = sql.match(/REVOKE ALL ON FUNCTION public\.\w+/g) || [];
  const grants = sql.match(/GRANT EXECUTE ON FUNCTION public\.\w+[^;]*TO service_role/g) || [];
  assert.equal(revokes.length, 1);
  assert.equal(grants.length, 1);
  assert.ok(revokes[0].includes("resolve_order_intake_context_v1"));
  assert.ok(!/TO\s+anon\b/.test(sql) && !/TO\s+authenticated\b/.test(sql));
});

let pass = 0, fail = 0;
(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ✓ ${name}`); pass++; }
    catch (e) { console.log(`  ✗ ${name} — ${e.message}`); fail++; }
  }
  console.log(`\no4ForgottenCloseDeadCodePurge: ${pass}/${pass + fail} passed`);
  if (fail) process.exit(1);
})();
