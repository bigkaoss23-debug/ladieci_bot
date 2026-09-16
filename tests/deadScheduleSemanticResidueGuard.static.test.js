"use strict";
// PRE_UAT_LIFECYCLE_HYGIENE — FINAL BLOCKER FIX. PROVE ZERO CALLER → DELETE → GUARD.
//
// Removed from src/schedule/serviceSchedule.js after a zero-caller proof on
// the candidate (backend src, index.js, scripts, ci, SQL function bodies,
// dynamic property access):
//   * canEnsureSession            (resolveSchedule() result fact)
//   * expectedServiceKind         (derived result field + standalone export)
//   * closeEligibility()          (export)
// ensure_service_session never consults the clock, and an Operational
// Service carries no clock-derived kind (service_sessions_active_kind_chk
// forces service_kind NULL), so none of these facts had a consumer left.
//
// The frontend's ensure-outcome classifier carried three schedule-window
// codes (BETWEEN_SERVICES / AFTER_ORDER_CUTOFF / OUTSIDE_WINDOWS) that no
// backend emitter produces any more; they were removed there in the same
// slice. Section C below is the backend half of that contract: a census
// DERIVED from the real emitter sources of the ensureCurrentServiceSession
// action (not a hand-maintained list), asserting those three codes cannot be
// emitted. If a future change makes the backend emit one again, this fails
// here, where the emitter lives, before the frontend silently renders it as
// UNKNOWN.
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const stripJsComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:\\])\/\/[^\n]*/g, "$1 ");
const stripSqlComments = (sql) => sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");

const DEAD_NAMES = ["canEnsureSession", "expectedServiceKind", "closeEligibility"];
const RETIRED_ENSURE_CODES = ["BETWEEN_SERVICES", "AFTER_ORDER_CUTOFF", "OUTSIDE_WINDOWS"];

// ── A. The schedule module no longer exposes the dead semantics ──────────
console.log("\n== A. serviceSchedule.js public surface ==");
const S = require("../src/schedule/serviceSchedule");
assert("A1: expectedServiceKind() and closeEligibility() are no longer exported",
  !("expectedServiceKind" in S) && !("closeEligibility" in S), Object.keys(S).join(","));
assert("A2: the still-reachable authorities are kept (madridParts, businessDateFor, resolveEconomicPeriod, DEFAULT_SCHEDULE, TIMEZONE, resolveSchedule)",
  ["madridParts", "businessDateFor", "resolveEconomicPeriod", "DEFAULT_SCHEDULE", "TIMEZONE", "resolveSchedule"].every((k) => k in S));
{
  // Every schedule state, both DST sides.
  const instants = [];
  for (const [month, off] of [[0, 1], [6, 2]]) {
    for (let m = 0; m < 1440; m += 15) instants.push(new Date(Date.UTC(2026, month, 15, 0, m - off * 60)));
  }
  const leaked = instants.map((d) => S.resolveSchedule(d)).filter((r) => "canEnsureSession" in r || "expectedServiceKind" in r);
  assert("A3: no resolveSchedule() result (96 instants x 2 DST sides) carries canEnsureSession or expectedServiceKind",
    leaked.length === 0, leaked.length && JSON.stringify(leaked[0]));
  const states = new Set(instants.map((d) => S.resolveSchedule(d).state));
  assert("A3b: the sweep really covered all five schedule states", states.size === 5, [...states].join(","));
}
const SCHEDULE_CODE = stripJsComments(read("src/schedule/serviceSchedule.js"));
assert("A4: serviceSchedule.js code (comments excluded) no longer names any dead fact",
  DEAD_NAMES.every((n) => !new RegExp(`\\b${n}\\b`).test(SCHEDULE_CODE)));

// ── B. No production code references them (comments excluded) ───────────
console.log("\n== B. zero production references ==");
function walk(dir, out = []) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) walk(rel, out);
    else if (/\.(c|m)?js$/.test(e.name)) out.push(rel);
  }
  return out;
}
const PROD_FILES = ["index.js", ...walk("src"), ...walk("scripts"), ...walk("ci")];
assert("B0: the scan covers a real production surface (sanity)", PROD_FILES.length > 100 && PROD_FILES.includes("index.js"), PROD_FILES.length);
const offenders = [];
for (const f of PROD_FILES) {
  const code = stripJsComments(read(f));
  for (const n of DEAD_NAMES) if (new RegExp(`\\b${n}\\b`).test(code)) offenders.push(`${f}:${n}`);
  if (/\[\s*["'`](canEnsureSession|expectedServiceKind|closeEligibility)["'`]\s*\]/.test(code)) offenders.push(`${f}:dynamic-access`);
}
assert("B1: no index.js / src / scripts / ci code references canEnsureSession, expectedServiceKind or closeEligibility (direct or bracket access)",
  offenders.length === 0, offenders.join(", "));

// ── C. Ensure-path emitter census (derived, with a positive control) ─────
console.log("\n== C. ensureCurrentServiceSession emitter census ==");
const literals = (src) => new Set((src.match(/["'`]([A-Z][A-Z0-9_]{3,})["'`]/g) || []).map((s) => s.slice(1, -1)));
const INDEX = read("index.js");
const actionStart = INDEX.indexOf('if (action === "ensureCurrentServiceSession")');
const actionEnd = INDEX.indexOf("if (action ===", actionStart + 10);
assert("C0: the ensureCurrentServiceSession action block is located in index.js", actionStart > -1 && actionEnd > actionStart);
const ACTION_CODE = stripJsComments(INDEX.slice(actionStart, actionEnd));

const forward = fs.readdirSync(path.join(ROOT, "migrations"))
  .filter((f) => f.endsWith(".sql") && !/\.ROLLBACK\.sql$/i.test(f)).sort();
let ensureSql = null, ensureFile = null;
for (const f of forward) {
  const text = read(path.join("migrations", f));
  const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.ensure_service_session\s*\([\s\S]*?\bAS\s+(\$\w*\$)([\s\S]*?)\1/gi;
  let m;
  while ((m = re.exec(text))) { ensureSql = m[2]; ensureFile = f; }
}
assert("C1: the latest forward definition of ensure_service_session is found by replay", !!ensureSql, ensureFile);

const EMITTER_SOURCES = {
  "index.js#ensureCurrentServiceSession": ACTION_CODE,
  "src/serviceSessions/ensureServiceSession.js": stripJsComments(read("src/serviceSessions/ensureServiceSession.js")),
  "src/serviceSessions/staleServiceRecovery.js": stripJsComments(read("src/serviceSessions/staleServiceRecovery.js")),
  "src/serviceSessions/serviceSessionLifecycle.js": stripJsComments(read("src/serviceSessions/serviceSessionLifecycle.js")),
  [`migrations/${ensureFile}#ensure_service_session`]: stripSqlComments(ensureSql || ""),
};
const census = new Set();
for (const src of Object.values(EMITTER_SOURCES)) for (const c of literals(src)) census.add(c);
console.log("  derived vocabulary: " + [...census].sort().join(", "));
assert("C2: positive control -- the derived census contains the codes the ensure path really emits",
  ["REUSED", "NO_OPEN_SERVICE", "SERVICE_SESSION_CLOSING", "INVALID_ACTOR", "PREVIOUS_SERVICE_PENDING", "ENSURE_FAILED"].every((c) => census.has(c)));
for (const code of RETIRED_ENSURE_CODES) {
  assert(`C3: retired schedule-window code ${code} cannot be emitted by the ensure path`, !census.has(code),
    Object.entries(EMITTER_SOURCES).filter(([, src]) => literals(src).has(code)).map(([k]) => k).join(", "));
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
