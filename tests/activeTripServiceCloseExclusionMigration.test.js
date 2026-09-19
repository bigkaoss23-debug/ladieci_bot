"use strict";
// ===============================================================
// ACTIVE_TRIP_SERVICE_CLOSE_EXCLUSION (migration 138) — offline static contract.
//
// The behaviour itself (close vs trip start serialized by the dispatch lock; both forbidden states
// impossible; rollback exact) is proven on REAL PostgreSQL by
//   ci/giro-authority-certification/harness/runActiveTripCloseExclusion.js
// which is not part of `node --test` (it needs an embedded/ephemeral server). This file is the
// always-on guard for what CAN be checked without a database:
//   * the migration is EXACTLY its two predecessors (ledger 132 / ledger 137) plus marked blocks;
//   * the rollback restores those predecessors byte for byte;
//   * no third lock, no schema change, no grant change, no DML in the added logic;
//   * the typed codes the SQL returns are the codes the JS already speaks.
// No database, no network.
// ===============================================================

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = path.join(__dirname, "..");
const M = (f) => path.join(ROOT, "migrations", f);
const read = (p) => fs.readFileSync(p, "utf8");
const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");

const FWD_NAME = "2026-09-19_active_trip_service_close_exclusion_v1_migration_138.sql";
const RBK_NAME = "2026-09-19_active_trip_service_close_exclusion_v1_migration_138.ROLLBACK.sql";
const FWD = read(M(FWD_NAME));
const RBK = read(M(RBK_NAME));

// The md5(prosrc) of the two functions as installed on staging (ledger 137) on 2026-09-19.
const LIVE_CLOSE_MD5 = "3caf2da77baabd6b5533879d101b2cc7"; // close_service_session_v3, migration 132
const LIVE_START_MD5 = "d3482569db6df9ec5e6445e7748ebc3c"; // start_rider_trip_v2, migration 137

function bodyOf(sql, name, tag) {
  const i = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  assert.ok(i >= 0, `${name} is defined`);
  const open = `AS $${tag}$`;
  const j = sql.indexOf(open, i);
  const k = sql.indexOf(`$${tag}$;`, j + open.length);
  return sql.slice(j + open.length, k);
}
const PRE_CLOSE = bodyOf(read(M("2026-09-15_w5_intent_activation_v1_migration_132.sql")), "close_service_session_v3", "function");
const PRE_START = bodyOf(read(M("2026-09-17_b1_rider_dispatch_operator_parity_v1_migration_137.sql")), "start_rider_trip_v2", "fn");
const NEW_CLOSE = bodyOf(FWD, "close_service_session_v3", "function");
const NEW_START = bodyOf(FWD, "start_rider_trip_v2", "fn");

// Removes exactly the text migration 138 adds: marked blocks (+ the one blank line after each) and DECL lines.
function stripMarked(body) {
  return body
    .replace(/^ {2}-- 138:BEGIN (\w+)\n[\s\S]*?^ {2}-- 138:END \1\n\n/gm, "")
    .replace(/^.*-- 138:DECL\n/gm, "");
}
const markedBlocks = (body) => [...body.matchAll(/^ {2}-- 138:BEGIN (\w+)\n([\s\S]*?)^ {2}-- 138:END \1\n/gm)].map((m) => ({ name: m[1], text: m[2] }));
// One pass over SQL text: a `--` comment vs a '...' literal, whichever starts first (a comment may contain an
// apostrophe; a literal may contain `--`). Comments are dropped; literals are kept intact.
const noComments = (sql) => sql.replace(/--[^\n]*|'(?:[^']|'')*'/g, (m) => (m.startsWith("--") ? "" : m));

test("predecessors: the two bodies migration 138 starts from ARE the ones live on staging (md5 pinned)", () => {
  assert.equal(md5(PRE_CLOSE), LIVE_CLOSE_MD5, "ledger-132 close_service_session_v3");
  assert.equal(md5(PRE_START), LIVE_START_MD5, "ledger-137 start_rider_trip_v2");
  // …and the migration's own drift guard pins exactly those
  assert.ok(FWD.includes(`IS DISTINCT FROM '${LIVE_CLOSE_MD5}'`));
  assert.ok(FWD.includes(`IS DISTINCT FROM '${LIVE_START_MD5}'`));
});

test("MINIMAL: removing the marked blocks from each new body reproduces its predecessor BYTE FOR BYTE", () => {
  assert.equal(stripMarked(NEW_CLOSE), PRE_CLOSE, "close_service_session_v3 = ledger 132 + marked blocks only");
  assert.equal(stripMarked(NEW_START), PRE_START, "start_rider_trip_v2 = ledger 137 + marked blocks only");
  assert.deepEqual(markedBlocks(NEW_CLOSE).map((b) => b.name), ["close_l0", "close_active_trip"]);
  assert.deepEqual(markedBlocks(NEW_START).map((b) => b.name), ["start_service_open"]);
  assert.equal((NEW_CLOSE.match(/-- 138:DECL/g) || []).length, 1);
  assert.equal((NEW_START.match(/-- 138:DECL/g) || []).length, 1);
});

test("ROLLBACK: restores the two predecessors verbatim, and its guards pin exactly the bodies 138 installs", () => {
  assert.equal(bodyOf(RBK, "close_service_session_v3", "function"), PRE_CLOSE);
  assert.equal(bodyOf(RBK, "start_rider_trip_v2", "fn"), PRE_START);
  const pins = [...RBK.matchAll(/md5\(v_src\) IS DISTINCT FROM '([0-9a-f]{32})'/g)].map((m) => m[1]);
  assert.deepEqual(pins, [md5(NEW_CLOSE), md5(NEW_START), LIVE_CLOSE_MD5, LIVE_START_MD5],
    "guard refuses unless the 138 bodies are installed; post-condition asserts the predecessors are back");
  // no data, no schema: no point of no return
  const code = noComments(RBK);
  assert.doesNotMatch(code, /\b(DELETE FROM|TRUNCATE|DROP\s+(TABLE|FUNCTION|SCHEMA|INDEX|TRIGGER|COLUMN|CONSTRAINT|VIEW|SEQUENCE)|ALTER\s+(TABLE|FUNCTION|SCHEMA|ROLE)|CREATE\s+(UNIQUE\s+)?INDEX|CREATE\s+TRIGGER|GRANT|REVOKE)\b/i);
  assert.deepEqual([...code.matchAll(/CREATE\s+(\w+\s+)?TABLE\s+(\S+)/gi)].map((m) => `${(m[1] || "").trim()} ${m[2]}`), ["TEMP atc138_before"]);
});

test("NO SCHEMA / GRANT / DATA CHANGE: only two CREATE OR REPLACE FUNCTION and a temp snapshot table", () => {
  const code = noComments(FWD);
  assert.equal((code.match(/CREATE OR REPLACE FUNCTION/g) || []).length, 2);
  assert.equal((code.match(/CREATE (OR REPLACE )?FUNCTION/g) || []).length, 2, "no new function either");
  assert.doesNotMatch(code, /\b(GRANT|REVOKE|ALTER (TABLE|FUNCTION|SCHEMA|ROLE)|DROP |CREATE (UNIQUE )?INDEX|CREATE TRIGGER|CREATE SCHEMA|CREATE SEQUENCE|CREATE VIEW|COMMENT ON|TRUNCATE|DELETE FROM)\b/i);
  // the only CREATE TABLE is the ON COMMIT DROP snapshot of the security posture
  assert.deepEqual([...code.matchAll(/CREATE\s+(\w+\s+)?TABLE\s+(\S+)/gi)].map((m) => `${(m[1] || "").trim()} ${m[2]}`), ["TEMP atc138_before"]);
  assert.match(code, /ON COMMIT DROP/);
  assert.match(FWD, /^BEGIN;$/m);
  assert.match(FWD, /^COMMIT;$/m);
});

test("NO DML IN THE ADDED LOGIC: the inserted blocks read and decide; they never write, never touch a trip or an order", () => {
  const all = [...markedBlocks(NEW_CLOSE), ...markedBlocks(NEW_START)];
  assert.equal(all.length, 3);
  for (const b of all) {
    const code = noComments(b.text);
    assert.doesNotMatch(code, /\b(INSERT|UPDATE|DELETE|TRUNCATE|PERFORM\s+(?!pg_advisory_xact_lock))/i, `${b.name} contains DML`);
  }
});

test("ONE SHARED EXCLUSION, NO THIRD LOCK: the close takes lifecycle then L0 (the lock every trip writer already takes first); the start keeps its single L0", () => {
  const locks = (body) => [...noComments(body).matchAll(/hashtext\('([^']+)'\)/g)].map((m) => m[1]);
  assert.deepEqual(locks(PRE_CLOSE), ["service_session_lifecycle"], "before 138 the close took only the lifecycle lock directly");
  assert.deepEqual(locks(NEW_CLOSE), ["service_session_lifecycle", "LA_DIECI_DRIVER_STATO"], "after: lifecycle -> L0, and nothing else");
  assert.deepEqual(locks(PRE_START), ["LA_DIECI_DRIVER_STATO"]);
  assert.deepEqual(locks(NEW_START), ["LA_DIECI_DRIVER_STATO"], "the start already had L0 first; it takes no new lock");
  // lock order inside the close: lifecycle < L0 < first row lock < exclusion < terminal write
  const c = noComments(NEW_CLOSE);
  const at = (needle) => c.indexOf(needle);
  assert.ok(at("hashtext('service_session_lifecycle')") < at("hashtext('LA_DIECI_DRIVER_STATO')"));
  assert.ok(at("hashtext('LA_DIECI_DRIVER_STATO')") < at("FOR UPDATE"), "L0 is held BEFORE the first row lock (the order start_rider_trip_v2 also follows)");
  assert.ok(at("BUSINESS_DAY_POINTER_OWNERSHIP_MISMATCH") < at("trip_projection_v1"), "the exclusion is the LAST check");
  assert.ok(at("trip_projection_v1") < at("UPDATE public.service_sessions"), "…judged before the terminal write");
  assert.ok(at("trip_projection_v1") < at("set_config('ladieci.v3_close_authorized_session_id'"), "…and before the trigger authorization is armed");
  // L0 is the FIRST statement of the start, and the service check precedes the trip INSERT
  const s = noComments(NEW_START);
  assert.ok(s.indexOf("hashtext('LA_DIECI_DRIVER_STATO')") < s.indexOf("SERVICE_NOT_OPEN"));
  assert.ok(s.indexOf("SERVICE_NOT_OPEN") < s.indexOf("INSERT INTO trip_authority.trips"));
  assert.ok(s.indexOf("SCOPE_MISMATCH") < s.indexOf("SERVICE_NOT_OPEN"), "an ineligible order keeps its earlier, more specific refusal");
  assert.ok(s.indexOf("ACTIVE_TRIP_CONFLICT") < s.indexOf("SERVICE_NOT_OPEN"), "the single-active-trip refusal is unchanged and still first");
});

test("SCOPE OF THE READ: the trip is read through trip_projection_v1 scoped to exactly THIS service (never a global 'any ACTIVE trip'), rider_actor is never read, fail closed", () => {
  const block = markedBlocks(NEW_CLOSE).find((b) => b.name === "close_active_trip").text;
  const code = noComments(block);
  assert.match(code, /public\.trip_projection_v1\(ARRAY\[v_session\.id\]\)/);
  assert.doesNotMatch(code, /trip_authority\.trips|rider_actor|trip_authority_active_trip_v1/, "no direct table read (no USAGE for service_role), no global helper, no identity");
  assert.match(code, /IS DISTINCT FROM 'true'/, "anything but ok:true is unverifiable");
  assert.match(code, /jsonb_typeof\(v_trip->'active'\) IS DISTINCT FROM 'boolean'/);
  assert.match(code, /V3_CLOSE_RIDER_TRIP_UNVERIFIABLE/);
  assert.match(code, /V3_CLOSE_ACTIVE_RIDER_TRIP/);
  // the start judges the service of EVERY departing order, and only 'open' passes
  const startBlock = noComments(markedBlocks(NEW_START)[0].text);
  assert.match(startBlock, /order_facts_v1\(v_uids, v_legacy_trip\)/);
  assert.match(startBlock, /LEFT JOIN public\.service_sessions/, "a missing row is refused, not skipped");
  assert.match(startBlock, /v_svc\.status IS DISTINCT FROM 'open'/);
});

test("ONE VOCABULARY: the codes the SQL returns are the codes the JS engine, stale recovery and FE already speak; the departure code is mapped to 409", () => {
  const { ACTIVE_RIDER_TRIP_CODE } = require("../src/serviceSessions/activeRiderTripBlocker");
  assert.ok(NEW_CLOSE.includes(`'${ACTIVE_RIDER_TRIP_CODE.ACTIVE_RIDER_TRIP}'`));
  assert.ok(NEW_CLOSE.includes(`'${ACTIVE_RIDER_TRIP_CODE.RIDER_TRIP_UNVERIFIABLE}'`));
  const { CODE_TO_HTTP } = require("../src/agents/riderTrip");
  assert.equal(CODE_TO_HTTP.SERVICE_NOT_OPEN, 409);
  assert.ok(NEW_START.includes("'SERVICE_NOT_OPEN'"));
});

test("OUT OF SCOPE STAYS UNTOUCHED: nothing 138 ADDS mentions trip-close / rider-payment / Entregado / refund / economy / planner objects", () => {
  // Only the text 138 adds is judged: the marked blocks plus the guard / snapshot / post-conditions that sit
  // OUTSIDE the two function bodies. (The verbatim predecessor bodies legitimately mention service_closeouts, the intent sweep, …)
  const outsideBodies = FWD
    .replace(/CREATE OR REPLACE FUNCTION public\.close_service_session_v3\([\s\S]*?\$function\$;/, "")
    .replace(/CREATE OR REPLACE FUNCTION public\.start_rider_trip_v2\([\s\S]*?\$fn\$;/, "");
  // string literals are data, not statements (the post-conditions search for 'UPDATE public.service_sessions' as TEXT)
  const noLiterals = (sql) => sql.replace(/'(?:[^']|'')*'/g, "''");  // (input already comment-free)
  const added = noLiterals(noComments([...markedBlocks(NEW_CLOSE), ...markedBlocks(NEW_START)].map((b) => b.text).join("\n") + "\n" + outsideBodies));
  assert.ok(added.length > 500, "the added-text extraction really captured the added logic");
  assert.doesNotMatch(added, /close_rider_trip|rider_collect_and_complete_stop|roll_service_session_economic_v1|begin_service_close_if_idle|end_service_close|complete_service_session_close|begin_service_session_close/);
  assert.doesNotMatch(added, /order_financial_events|payment_transactions|payment_allocations|order_obligations|service_closeout|consolidate_period|giro_authority_\w+_v1\(/);
  assert.doesNotMatch(added, /estado\s*=\s*'(RETIRADO|EN_ENTREGA|CANCELADO)'/);
  assert.doesNotMatch(added, /\b(UPDATE|DELETE|TRUNCATE)\b/, "the added logic writes nothing (the only INSERT is the temp posture snapshot)");
  assert.deepEqual([...added.matchAll(/INSERT INTO (\S+)/g)].map((m) => m[1]), ["atc138_before"]);
  // Nor do the two function bodies gain or lose any write: every DML target of each new body is the predecessor's.
  const dml = (b) => [...noComments(b).matchAll(/\b(INSERT INTO|UPDATE|DELETE FROM)\s+([\w.]+)/g)].map((m) => `${m[1]} ${m[2]}`);
  assert.deepEqual(dml(NEW_CLOSE), dml(PRE_CLOSE));
  assert.deepEqual(dml(NEW_START), dml(PRE_START));
});

test("ARTIFACTS: the harness that proves the concurrency exists and names this migration; the manifest records it as NOT APPLIED", () => {
  const runner = path.join(ROOT, "ci", "giro-authority-certification", "harness", "runActiveTripCloseExclusion.js");
  const group = path.join(ROOT, "ci", "giro-authority-certification", "harness", "groups", "activeTripCloseExclusion.js");
  assert.ok(fs.existsSync(runner) && fs.existsSync(group));
  assert.match(read(runner), new RegExp(FWD_NAME.replace(/\./g, "\\.")));
  assert.match(FWD, /runActiveTripCloseExclusion\.js/);
  const manifest = read(M("MIGRATION_MANIFEST.md"));
  assert.match(manifest, /\| 138 \|/);
  assert.match(manifest, /NOT APPLIED/i);
});
