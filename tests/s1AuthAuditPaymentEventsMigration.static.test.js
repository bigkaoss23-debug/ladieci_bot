"use strict";
// MESA / SALA — S1 follow-up: auth_audit.event CHECK widening for the two
// payment-audit events row 71 already inserts. Static (source-text) proof,
// same convention as tests/authUnlockedEventMigration.test.js and
// tests/s1GuardNullPaymentIdempotency.static.test.js. No DB, no staging.
// Authority: MESA_REMEDIATION_PLAN_FINAL_V2_1_2_2026-08-15.md, slice S1.
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
const stripComments = (text) => text.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

const PREVIOUS_ALLOWLIST = [
  "login_ok", "login_fail", "locked", "pin_set", "pin_change", "revoke", "bootstrap", "recovery",
  "actor_disabled", "actor_enabled", "actor_unlocked",
  "user_created", "user_renamed", "role_changed", "user_deactivated", "user_reactivated",
  "access_denied", "credential_cleared", "fingerprint_upgraded", "session_invalidated",
  "rate_limit_triggered", "migration_login_used",
];
const NEW_EVENTS = ["PAYMENT_REPLAY_DIFFERENT_ACTOR", "PAYMENT_DUPLICATE_CONFIRMED"];
const FINAL_ALLOWLIST = PREVIOUS_ALLOWLIST.concat(NEW_EVENTS);

const FWD_NAME = "2026-08-15_s1_auth_audit_payment_events.sql";
const RB_NAME = "2026-08-15_s1_auth_audit_payment_events.ROLLBACK.sql";
const MIG_DIR = path.join(__dirname, "..", "migrations");

console.log("\n== file discovery / manifest wiring ==");
assert("files exist on disk", fs.existsSync(path.join(MIG_DIR, FWD_NAME)) && fs.existsSync(path.join(MIG_DIR, RB_NAME)));
const MANIFEST = read("migrations/MIGRATION_MANIFEST.md");
assert("forward migration has a manifest row", MANIFEST.includes(FWD_NAME));
assert("manifest row 72 apply_order sorts strictly after row 71 (S1's own migration)",
  (() => {
    const line71 = MANIFEST.split("\n").find((l) => l.includes("2026-08-15_s1_guard_null_payment_idempotency.sql") && /^\s*\|\s*\d+\s*\|/.test(l));
    const line72 = MANIFEST.split("\n").find((l) => l.includes(FWD_NAME) && /^\s*\|\s*\d+\s*\|/.test(l));
    if (!line71 || !line72) return false;
    const o71 = Number(line71.match(/^\s*\|\s*(\d+)\s*\|/)[1]);
    const o72 = Number(line72.match(/^\s*\|\s*(\d+)\s*\|/)[1]);
    return o71 < o72;
  })());

const MIGRATION = read("migrations/" + FWD_NAME);
const ROLLBACK = read("migrations/" + RB_NAME);
const MIGRATION_NC = stripComments(MIGRATION);
const ROLLBACK_NC = stripComments(ROLLBACK);

function extractCheckEvents(sqlNoComments) {
  const m = sqlNoComments.match(/ADD CONSTRAINT auth_audit_event_chk\s+CHECK\s*\(event IN \(([\s\S]*?)\)\)/i);
  if (!m) return null;
  return (m[1].match(/'([A-Za-z_]+)'/g) || []).map((s) => s.replace(/'/g, ""));
}
const fwdEvents = extractCheckEvents(MIGRATION_NC);
const rbEvents = extractCheckEvents(ROLLBACK_NC);

console.log("\n== forward: widens the CHECK by exactly the two new events ==");
assert("forward SQL CHECK parsed successfully", Array.isArray(fwdEvents) && fwdEvents.length > 0, String(fwdEvents));
assert("forward preserves every previously allowed event verbatim",
  fwdEvents && PREVIOUS_ALLOWLIST.every((e) => fwdEvents.includes(e)));
assert("forward adds exactly the two new payment events, nothing else",
  fwdEvents && fwdEvents.filter((e) => !PREVIOUS_ALLOWLIST.includes(e)).length === NEW_EVENTS.length &&
  NEW_EVENTS.every((e) => fwdEvents.includes(e)));
assert("forward final allowlist matches exactly (order-independent)",
  fwdEvents && eq([...fwdEvents].sort(), [...FINAL_ALLOWLIST].sort()));
assert("forward: exactly one DROP and one ADD of auth_audit_event_chk",
  (MIGRATION_NC.match(/DROP CONSTRAINT auth_audit_event_chk/g) || []).length === 1 &&
  (MIGRATION_NC.match(/ADD CONSTRAINT auth_audit_event_chk/g) || []).length === 1);

console.log("\n== forward: additive only -- no table/column/function/RLS/grant/data change ==");
assert("forward: NO CREATE/REPLACE/DROP FUNCTION", !/CREATE OR REPLACE FUNCTION/i.test(MIGRATION_NC) && !/DROP FUNCTION/i.test(MIGRATION_NC));
assert("forward: NO column change (ADD/DROP/ALTER COLUMN)", !/ADD COLUMN/i.test(MIGRATION_NC) && !/DROP COLUMN/i.test(MIGRATION_NC) && !/ALTER COLUMN/i.test(MIGRATION_NC));
assert("forward: NO CREATE TABLE / RENAME DDL statement (the 'user_renamed' event literal in the allowlist is not a rename statement)",
  !/CREATE TABLE/i.test(MIGRATION_NC) && !/\bRENAME\s+(TO|CONSTRAINT|COLUMN)\b/i.test(MIGRATION_NC));
assert("forward: NO grant/revoke statement", !/\b(GRANT|REVOKE)\b[\s\S]*?\bON\b/i.test(MIGRATION_NC));
assert("forward: NO RLS/policy change", !/ROW LEVEL SECURITY/i.test(MIGRATION_NC) && !/CREATE POLICY/i.test(MIGRATION_NC));
assert("forward: NO data mutation (INSERT/UPDATE/DELETE)", !/\bINSERT\b/i.test(MIGRATION_NC) && !/\bUPDATE\b/i.test(MIGRATION_NC) && !/\bDELETE\b/i.test(MIGRATION_NC));
assert("forward: does not reference row 71's DB objects (guard/idempotency/mesa_post_payment_v1 untouched here)",
  !/guard_service_session_closed_v1/.test(MIGRATION_NC) &&
  !/payment_transactions_idempotency_uq/.test(MIGRATION_NC) &&
  !/mesa_post_payment_v1/.test(MIGRATION_NC));

console.log("\n== forward: predecessor guard refuses over drift or a re-patch ==");
assert("refuses if the constraint is missing", /auth_audit_event_chk not found/.test(MIGRATION));
assert("refuses if either new event is already present (idempotent-refuse, not idempotent-apply)",
  /v_chk LIKE '%PAYMENT_REPLAY_DIFFERENT_ACTOR%' OR v_chk LIKE '%PAYMENT_DUPLICATE_CONFIRMED%'/.test(MIGRATION));
assert("refuses if the pre-widen 22-event set is not present (drift)", /migration_login_used/.test(MIGRATION) && /resolve drift first/.test(MIGRATION));

console.log("\n== rollback: narrows back, refuses if already-used, never touches audit rows ==");
assert("rollback SQL CHECK parsed successfully", Array.isArray(rbEvents) && rbEvents.length > 0, String(rbEvents));
assert("rollback restores the exact previous 22-event allowlist", rbEvents && eq([...rbEvents].sort(), [...PREVIOUS_ALLOWLIST].sort()));
assert("rollback removes both new events from the allowlist", rbEvents && !NEW_EVENTS.some((e) => rbEvents.includes(e)));
assert("rollback refuses when either new event has already been used", /ROLLBACK REFUSED/.test(ROLLBACK_NC) && NEW_EVENTS.every((e) => ROLLBACK.includes(e)));
assert("rollback counts usage of both new events before narrowing",
  /count\(\*\) INTO v_rows FROM public\.auth_audit\s*\n\s*WHERE event IN \('PAYMENT_REPLAY_DIFFERENT_ACTOR', 'PAYMENT_DUPLICATE_CONFIRMED'\)/.test(MIGRATION_NC.length ? ROLLBACK : ROLLBACK));
assert("rollback: NO row delete/rewrite of audit", !/DELETE\s+FROM\s+public\.auth_audit/i.test(ROLLBACK_NC) && !/UPDATE\s+public\.auth_audit\s+SET/i.test(ROLLBACK_NC));
assert("rollback: changes ONLY the event CHECK constraint", !/CREATE OR REPLACE FUNCTION/i.test(ROLLBACK_NC) && !/\bGRANT\b/i.test(ROLLBACK_NC) && !/ADD COLUMN/i.test(ROLLBACK_NC) && !/DROP TABLE/i.test(ROLLBACK_NC));

console.log("\n== deliberately does not touch Node's ALLOWED_EVENTS (documented, not an oversight) ==");
const AUDIT_JS = read("src/auth/audit.js");
assert("Node ALLOWED_EVENTS is untouched by this change (ALLOWED_EVENTS in audit.js does not yet include either new event -- direct-SQL write path, not assertEvent-gated)",
  !AUDIT_JS.includes("PAYMENT_REPLAY_DIFFERENT_ACTOR") && !AUDIT_JS.includes("PAYMENT_DUPLICATE_CONFIRMED"));
assert("the migration itself documents why (casing + direct-SQL-write rationale present in header prose)",
  /never calls Node's assertEvent/.test(MIGRATION) && /UPPER_SNAKE_CASE/.test(MIGRATION));

console.log("\n== test hygiene: no DB/PG client imported ==");
assert("test does not import a DB/PG client", (() => {
  const self = read("tests/s1AuthAuditPaymentEventsMigration.static.test.js");
  return !/require\(['"](pg|postgres|@supabase)/.test(self) && !/\.query\(/.test(self);
})());

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
