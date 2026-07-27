"use strict";
// S2-7D6E — orden_estado_logs session identity: migration contract.
//
// Structural proof that the migration says what it must say. The runtime behaviour
// (a new log row picking up the open session, a legacy row staying NULL) can only be
// proven against a live database after the migration is applied; it is deliberately
// NOT asserted here, and this file must not be read as evidence that it was applied.
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };

const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
const MIG = read("migrations/2026-07-27_order_state_logs_session_identity.sql");
const RB = read("migrations/2026-07-27_order_state_logs_session_identity.ROLLBACK.sql");
const MANIFEST = read("migrations/MIGRATION_MANIFEST.md");

console.log("\n══ A. staging safety ══");
assert("A: staging sentinel guard present", /schema_migrations WHERE version='20260710075612'/.test(MIG));
assert("A: rollback carries the same sentinel", /schema_migrations WHERE version='20260710075612'/.test(RB));
assert("A: refuses without the service-session foundation", /service_session_state absent/.test(MIG));
assert("A: wrapped in a transaction", /^BEGIN;/m.test(MIG) && /COMMIT;\s*$/.test(MIG));
assert("A: rollback wrapped in a transaction", /^BEGIN;/m.test(RB) && /COMMIT;\s*$/.test(RB));

console.log("\n══ B. additive and legacy-compatible ══");
assert("B: column added nullable (no NOT NULL)", /ADD COLUMN IF NOT EXISTS service_session_id uuid/.test(MIG)
  && !/service_session_id uuid[^;]*NOT NULL/.test(MIG));
assert("B: no default value that would rewrite existing rows", !/ADD COLUMN[^;]*DEFAULT/.test(MIG));
assert("B: idempotent (IF NOT EXISTS on column and indexes)",
  (MIG.match(/IF NOT EXISTS/g) || []).length >= 3);
assert("B: NO backfill of legacy rows", !/\bUPDATE\s+public\.orden_estado_logs\b/i.test(MIG));
assert("B: does not infer a session from timestamps", !/created_at\s*(<|>|BETWEEN)/i.test(MIG.replace(/--.*$/gm, "")));
assert("B: legacy orden_id index explicitly preserved", /idx_orden_estado_logs_orden_id is intentionally KEPT/.test(MIG)
  && !/DROP INDEX[^;]*idx_orden_estado_logs_orden_id/.test(MIG));
assert("B: does not touch any other table", !/ALTER TABLE(?!\s+public\.orden_estado_logs)/.test(MIG));
assert("B: never deletes log rows", !/\bDELETE\s+FROM\b/i.test(MIG) && !/\bDELETE\s+FROM\b/i.test(RB));

console.log("\n══ C. referential integrity ══");
assert("C: FK to service_sessions", /REFERENCES public\.service_sessions\(id\)/.test(MIG));
assert("C: ON DELETE RESTRICT, matching every other session-scoped table", /ON DELETE RESTRICT/.test(MIG));

console.log("\n══ D. indexes ══");
assert("D: composite (session, order, created_at) index", /orden_estado_logs_session_order_created_idx[\s\S]*?\(service_session_id, orden_id, created_at\)/.test(MIG));
assert("D: session timeline index", /orden_estado_logs_session_created_idx[\s\S]*?\(service_session_id, created_at\)/.test(MIG));
assert("D: both indexes are partial on NOT NULL", (MIG.match(/WHERE service_session_id IS NOT NULL/g) || []).length === 2);

console.log("\n══ E. soft assignment trigger ══");
assert("E: BEFORE INSERT trigger installed", /BEFORE INSERT ON public\.orden_estado_logs/.test(MIG));
assert("E: reads the open session from the singleton state row", /service_session_state[\s\S]*?singleton = true[\s\S]*?status = 'open'/.test(MIG));
assert("E: assigns NULL when no session is open (soft, never raises)", /NEW\.service_session_id := v_current/.test(MIG));
assert("E: does NOT raise on a missing session", !/RAISE EXCEPTION 'NO_[A-Z_]*SESSION/.test(MIG));
assert("E: still refuses a forged session id", /SERVICE_SESSION_FORGERY/.test(MIG));
assert("E: SECURITY INVOKER with a pinned search_path", /SECURITY INVOKER SET search_path = public, pg_temp/.test(MIG));

console.log("\n══ F. rollback completeness ══");
for (const obj of [
  ["trigger", /DROP TRIGGER IF EXISTS orden_estado_logs_assign_service_session/],
  ["function", /DROP FUNCTION IF EXISTS public\.orden_estado_logs_assign_service_session/],
  ["composite index", /DROP INDEX IF EXISTS public\.orden_estado_logs_session_order_created_idx/],
  ["timeline index", /DROP INDEX IF EXISTS public\.orden_estado_logs_session_created_idx/],
  ["column", /ALTER TABLE public\.orden_estado_logs DROP COLUMN IF EXISTS service_session_id/],
]) assert("F: rollback drops the " + obj[0], obj[1].test(RB));

console.log("\n══ G. manifest ══");
assert("G: registered in the manifest", /2026-07-27_order_state_logs_session_identity\.sql/.test(MANIFEST));
assert("G: recorded as NOT applied", /2026-07-27_order_state_logs_session_identity\.sql[\s\S]{0,200}?NOT APPLIED/.test(MANIFEST));

console.log("\n  " + pass + " passed, " + fail + " failed");
process.exit(fail === 0 ? 0 : 1);
