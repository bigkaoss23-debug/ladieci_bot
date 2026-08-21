"use strict";
// I-1 — the two invariants that must be true of the SOURCE, not merely of one
// test run: the snapshot never writes, and nothing in the economy module can
// reach the Operational Service lifecycle.
//
// These are static scans on purpose. A runtime test proves what happened on
// the paths it exercised; a scan proves there is no path at all — including
// the one a future edit might add on a branch no test covers.
const assert = require("assert");
const fs = require("fs");
const path = require("path");

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; }
  catch (error) { console.error(`FAIL: ${name}\n  ${error && error.message}`); process.exitCode = 1; }
};

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
// Comments explain the rules; only real code may violate them.
const code = (rel) => read(rel)
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((line) => !/^\s*(\/\/|--)/.test(line))
  .join("\n");

const SNAPSHOT = "src/economy/economicSnapshot.js";
const WINDOW = "src/economy/economicWindow.js";
const CASH = "src/economy/cashCountService.js";
const HTTP = "src/economy/economyHttpHandlers.js";
const INTEGRATION = "src/economy/economyHttpIntegration.js";
const ALL = [SNAPSHOT, WINDOW, CASH, HTTP, INTEGRATION];

// Every mutating helper the Supabase util exposes, plus the RPC door.
const WRITE_HELPERS = ["sbInsert", "sbUpsert", "sbUpdate", "sbDelete", "sbRpc"];

test("SNAPSHOT_DB_WRITES = 0 — the reader names no write helper at all", () => {
  const source = code(SNAPSHOT);
  for (const helper of WRITE_HELPERS) {
    assert.ok(!source.includes(helper),
      `${SNAPSHOT} must not reference ${helper} — a snapshot reads and nothing else`);
  }
  // It may import exactly one thing from the supabase util, and that is the reader.
  const imports = source.match(/require\(["']\.\.\/utils\/supabase["']\)[\s\S]{0,80}/g) || [];
  assert.strictEqual(imports.length, 1, "one supabase import");
  assert.ok(/\{\s*sbSelect\s*\}/.test(source), "and it destructures sbSelect only");
});

test("the window resolver touches no database whatsoever", () => {
  const source = code(WINDOW);
  assert.ok(!source.includes("utils/supabase"), "the window resolver must stay pure");
  for (const helper of [...WRITE_HELPERS, "sbSelect"]) {
    assert.ok(!source.includes(helper), `${WINDOW} must not reference ${helper}`);
  }
});

test("the cash count writes to exactly one table, and it is its own", () => {
  const source = code(CASH);
  for (const helper of ["sbUpsert", "sbUpdate", "sbDelete", "sbRpc"]) {
    assert.ok(!source.includes(helper),
      `${CASH} must not reference ${helper} — a count is appended, never amended`);
  }
  assert.ok(source.includes("sbInsert"), "it does insert");
  const inserted = [...source.matchAll(/insert\(\s*["']([a-z_]+)["']/g)].map((m) => m[1]);
    assert.deepStrictEqual([...new Set(inserted)], ["cash_counts"],
    `the only insert target may be cash_counts, found: ${inserted.join(", ") || "none"}`);
});

test("nothing in the economy module can reach the service lifecycle", () => {
  // The exact names of every opener, closer and intake resolver this system
  // has. If a future edit wires one of them into an economy path, this fails
  // before it can ship — which is the whole point of the slice.
  const LIFECYCLE = [
    "close_service_session_v3", "open_operational_service_v1", "ensure_service_session",
    "begin_service_session_close", "complete_service_session_close",
    "roll_service_session_economic_v1", "ensure_next_service_session_v3",
    "resolve_order_intake_context_v1", "open_service_session", "open_business_day_v1",
    "serviceSessionLifecycle", "serviceLifecycleEngine", "serviceLifecycleV3Transition",
    // language-guard: allow-legacy chiudiServizio is the existing legacy close function, named here as a forbidden symbol this test proves is ABSENT, not new vocabulary
    "ensureCurrentServiceSession", "chiudiServizio", "currentCloseout",
    "createServiceCloseout", "closeoutAttempts", "mesa_open_session_v1",
    "mesa_close_session_v1", "mesa_post_payment_v1",
  ];
  for (const file of ALL) {
    const source = code(file);
    for (const symbol of LIFECYCLE) {
      assert.ok(!source.includes(symbol),
        `${file} must not reference ${symbol} — counting cash is not closing a service`);
    }
  }
});

test("the economy router exposes no mutating verb beyond the one append", () => {
  const source = code(HTTP);
  for (const verb of ["router.put", "router.patch", "router.delete"]) {
    assert.ok(!source.includes(verb), `${HTTP} must not register a ${verb} route`);
  }
  const posts = source.match(/router\.post\(/g) || [];
  assert.strictEqual(posts.length, 1, "exactly one POST: recording a count");
  assert.ok(source.includes("router.post('/cash-counts'"), "and it is the cash count");
  const gets = source.match(/router\.get\(/g) || [];
  assert.strictEqual(gets.length, 2, "two GETs: the snapshot and the history");
});

test("every economy route is authenticated and role-gated", () => {
  const source = code(HTTP);
  const routes = [...source.matchAll(/router\.(get|post)\((.+?)\);/g)].map((m) => m[2]);
  assert.strictEqual(routes.length, 3);
  for (const route of routes) {
    assert.ok(route.includes("auth"), `unauthenticated route: ${route}`);
    assert.ok(/canRead|canCount/.test(route), `ungated route: ${route}`);
  }
  assert.ok(source.includes("req.economyContext"),
    "and the actor comes from the middleware's verified context");
});

test("the actor is never taken from the request body", () => {
  const source = code(HTTP) + code(CASH);
  for (const bad of ["body?.actor", "body.actor", "body?.workspaceId", "body.workspace_id", "body?.role"]) {
    assert.ok(!source.includes(bad),
      `attribution must come from the token, found body-sourced identity: ${bad}`);
  }
});

// ── THE MIGRATION ─────────────────────────────────────────────────────────
const MIGRATION = "migrations/2026-08-21_i1_cash_counts_append_only.sql";
const ROLLBACK = "migrations/2026-08-21_i1_cash_counts_append_only.ROLLBACK.sql";

// These migrations explain their own rules in prose, and that prose NAMES the
// things the rules forbid ("without the revoke below, service_role would still
// hold UPDATE and DELETE"). Only executable statements may be judged, or the
// file's own documentation trips the guard that documents it.
const sqlOnly = (text) => text.split("\n").filter((line) => !/^\s*--/.test(line)).join("\n");

test("the migration is transactional and append-only in both halves", () => {
  const sql = read(MIGRATION);
  const stmts = sqlOnly(sql);
  assert.ok(/^\s*BEGIN;/m.test(sql) && /COMMIT;\s*$/.test(sql), "wrapped in one transaction");
  assert.ok(stmts.includes("CREATE TRIGGER cash_counts_append_only_trg"), "trigger half");
  assert.ok(/BEFORE UPDATE OR DELETE ON public\.cash_counts/.test(stmts), "covering UPDATE and DELETE");
  assert.ok(stmts.includes("GRANT SELECT, INSERT ON public.cash_counts TO service_role"), "privilege half");
  assert.ok(!/GRANT[^;]*UPDATE[^;]*ON public\.cash_counts/i.test(stmts), "and no UPDATE grant anywhere");
  assert.ok(!/GRANT[^;]*DELETE[^;]*ON public\.cash_counts/i.test(stmts), "and no DELETE grant anywhere");
  assert.ok(stmts.includes("ENABLE ROW LEVEL SECURITY") && stmts.includes("FORCE ROW LEVEL SECURITY"));
});

test("every role Supabase default-grants ALL to is explicitly revoked", () => {
  // Supabase's stock ALTER DEFAULT PRIVILEGES hands arwdDxtm on every new
  // public table to anon, authenticated AND service_role. A GRANT of
  // SELECT,INSERT neither adds nor removes anything against that, so each of
  // the three must be revoked by name or the privilege half is vacuous. The
  // first apply of this migration failed on exactly the missing one.
  const stmts = sqlOnly(read(MIGRATION));
  for (const role of ["PUBLIC", "anon", "authenticated", "service_role"]) {
    assert.ok(stmts.includes(`REVOKE ALL ON public.cash_counts FROM ${role};`),
      `missing: REVOKE ALL ON public.cash_counts FROM ${role}`);
  }
  const revokeAt = stmts.indexOf("REVOKE ALL ON public.cash_counts FROM service_role;");
  const grantAt = stmts.indexOf("GRANT SELECT, INSERT ON public.cash_counts TO service_role;");
  assert.ok(revokeAt >= 0 && grantAt > revokeAt,
    "the revoke must come BEFORE the grant, or it removes the grant it just made");
});

test("the migration refuses to claim an expected drawer balance", () => {
  const sql = read(MIGRATION);
  // The column that does exist says what it really is.
  assert.ok(sql.includes("recorded_cash_receipts_cents"), "the honest column name");
  // And the post-condition makes the ban structural, not merely a convention.
  assert.ok(sql.includes("must not claim an expected drawer balance"),
    "the post-condition that enforces honest naming is missing");
  // Only real DDL counts: the header comment deliberately NAMES the forbidden
  // names in order to explain why they are forbidden.
  const ddl = sqlOnly(sql.split("-- ── POST-CONDITIONS")[0]);
  for (const dishonest of ["expected_cash", "expected_drawer", "efectivo_esperado", "expected_balance"]) {
    assert.ok(!ddl.includes(dishonest),
      `opening float and drawer movements are unmodelled, so ${dishonest} would be a lie`);
  }
});

test("the migration creates no coupling to the service lifecycle", () => {
  const sql = read(MIGRATION);
  const ddl = sqlOnly(sql.split("-- ── POST-CONDITIONS")[0]);
  assert.ok(!/REFERENCES\s+public\.service_sessions/i.test(ddl),
    "service_session_id must stay optional provenance, never a foreign key");
  assert.ok(!/UPDATE\s+public\.service_sessions/i.test(sql), "it must not write a service row");
  assert.ok(!/INSERT\s+INTO\s+public\.service_sessions/i.test(sql), "it must not create a service");
  assert.ok(sql.includes("service_closeout_attempts"),
    "and it must assert no closeout was attempted");
});

test("a rollback exists and is honest about what it destroys", () => {
  const sql = read(ROLLBACK);
  assert.ok(sql.includes("DROP TABLE IF EXISTS public.cash_counts"));
  assert.ok(sql.includes("DROP FUNCTION IF EXISTS public.cash_counts_append_only_v1"));
  assert.ok(/DESTRUCTIVE/i.test(sql), "a rollback that destroys audit evidence must say so");
});

console.log(`economyReadOnlyAndLifecycleIsolation: ${passed} passed`);
