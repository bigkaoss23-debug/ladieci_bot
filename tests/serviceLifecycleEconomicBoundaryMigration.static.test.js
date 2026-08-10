"use strict";
// language-guard: allow-legacy chiudiServizio/CHIUSO_FORZATO/serata_summary/servizio.js/storico are the exact forbidden legacy identifiers this file asserts are ABSENT from the new migration, not new vocabulary being introduced
// SERVICE LIFECYCLE / P0-C2 — static structural proof for
// migrations/2026-08-10_service_lifecycle_economic_boundary_v1.sql. Source
// inspection only (no DB) — the RPC's actual runtime behavior is proven
// separately, both against an isolated synthetic shadow schema (16/16
// checks, see P0_C2_INTRADAY_ECONOMIC_BOUNDARY_REPORT.md §14) and by
// tests/economicBoundaryEngine.test.js (the JS orchestrator that calls it).

const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };

const ROOT = path.join(__dirname, "..");
const MIGRATION_PATH = path.join(ROOT, "migrations", "2026-08-10_service_lifecycle_economic_boundary_v1.sql");
const ROLLBACK_PATH = path.join(ROOT, "migrations", "2026-08-10_service_lifecycle_economic_boundary_v1.ROLLBACK.sql");

function stripComments(text) {
  let out = ""; let i = 0; const n = text.length;
  while (i < n) {
    const c = text[i]; const c2 = i + 1 < n ? text[i + 1] : "";
    if (c === "-" && c2 === "-") { while (i < n && text[i] !== "\n") i++; continue; }
    out += c; i++;
  }
  return out;
}

(async () => {
  console.log("\n== P0-C2 economic boundary migration — static structural proof ==\n");

  assert("0: forward migration file exists", fs.existsSync(MIGRATION_PATH));
  assert("0b: rollback file exists", fs.existsSync(ROLLBACK_PATH));

  const sql = fs.readFileSync(MIGRATION_PATH, "utf8");
  const sqlNoComments = stripComments(sql);
  const rollback = fs.readFileSync(ROLLBACK_PATH, "utf8");

  console.log("\n── preflight guards ──");
  assert("1a: staging sentinel check present", /schema_migrations[\s\S]*20260710075612/.test(sql));
  assert("1b: refuses if the RPC already exists (predecessor guard)", /roll_service_session_economic_v1\(uuid,uuid,text,text,text,date\)'\)\s*IS NOT NULL/.test(sql));
  assert("1c: refuses if the status constraint already allows rolled_over (drift guard)", /already allows rolled_over/.test(sql));
  assert("1d: refuses if rolled_over_at already exists (drift guard)", /rolled_over_at already exists/.test(sql));
  assert("1e: checks V3 foundation tables exist first", /service_sessions.*IS NULL[\s\S]*service_closeout_attempts.*IS NULL/.test(sql.replace(/\n/g, " ")) || /to_regclass\('public\.service_closeout_attempts'\)/.test(sql));

  console.log("\n── schema change is exactly what it claims ──");
  assert("2a: DROP + ADD the status CHECK (Postgres has no ALTER CHECK)", /DROP CONSTRAINT service_sessions_status_check/.test(sql) && /ADD CONSTRAINT service_sessions_status_check/.test(sql));
  assert("2b: new CHECK is a strict superset — all 4 original values plus rolled_over, nothing removed", /CHECK \(status = ANY \(ARRAY\['open','closing','closed','rolled_over'\]\)\)/.test(sqlNoComments));
  assert("2c: rolled_over_at is a plain nullable timestamptz (no DEFAULT, no NOT NULL — deliberately optional)", /ADD COLUMN rolled_over_at timestamptz;/.test(sqlNoComments));
  assert("2d: never touches closed_at itself", !/ALTER (COLUMN )?closed_at/i.test(sql));

  console.log("\n── the RPC never touches ordenes or table_sessions ──");
  const fnBody = sql.slice(sql.indexOf("CREATE FUNCTION public.roll_service_session_economic_v1"), sql.indexOf("REVOKE ALL ON FUNCTION"));
  const fnBodyNoComments = stripComments(fnBody);
  assert("3a: zero references to the ordenes table anywhere in the function body", !/\bordenes\b/.test(fnBodyNoComments));
  assert("3b: zero references to the table_sessions table anywhere in the function body", !/\btable_sessions\b/.test(fnBodyNoComments));
  assert("3c: zero DELETE statements anywhere in the function", !/\bDELETE\b/i.test(fnBodyNoComments));
  assert("3d: never writes status='closed' (would trigger guard_service_session_closed_v1)", !/status\s*=\s*'closed'/.test(fnBodyNoComments));
  assert("3e: never references CHIUSO_FORZATO / force-termination vocabulary", !/CHIUSO_FORZATO/.test(fnBodyNoComments));

  console.log("\n── concurrency / atomicity ──");
  assert("4a: reuses the SAME advisory lock namespace as close_service_session_v3/ensure_service_session", /pg_advisory_xact_lock\(hashtext\('service_session_lifecycle'\)\)/.test(fnBodyNoComments));
  assert("4b: locks service_session_state FOR UPDATE before reading it", /service_session_state WHERE singleton = true FOR UPDATE/.test(fnBodyNoComments));
  assert("4c: locks the target session row FOR UPDATE", /service_sessions\s*\n?\s*WHERE id = p_service_session_id FOR UPDATE/.test(fnBodyNoComments));
  assert("4d: A's UPDATE and B's INSERT and the pointer flip are all in ONE function body (one transaction)", (fnBodyNoComments.match(/UPDATE public\.service_sessions/g) || []).length === 1 && /INSERT INTO public\.service_sessions/.test(fnBodyNoComments) && /UPDATE public\.service_session_state/.test(fnBodyNoComments));

  console.log("\n── idempotency ──");
  assert("5a: checks for an already-rolled-over status before doing any writes", /IF v_session\.status = 'rolled_over' THEN/.test(fnBodyNoComments));
  assert("5b: re-fetches the existing B via rollover_source_session_id rather than re-deriving it another way", /WHERE rollover_source_session_id = v_session\.id/.test(fnBodyNoComments));
  assert("5c: returns idempotent:true on a genuine retry", /'idempotent',true/.test(fnBodyNoComments));
  assert("5d: fails closed (never mints a second B) if rolled_over but no B is found", /ROLLOVER_IDENTITY_MISMATCH/.test(fnBodyNoComments));

  console.log("\n── reuses existing V3 primitives, never reinvents them ──");
  assert("6a: requires a pre-existing service_closeouts row for the exact (session, correlation) pair", /EXISTS\(\s*\n?\s*SELECT 1 FROM public\.service_closeouts/.test(fnBodyNoComments.replace(/EXISTS \(/g, "EXISTS(")));
  assert("6b: requires the closeout attempt to be active — same precondition style as close_service_session_v3", /service_closeout_attempts[\s\S]*status = 'active'/.test(fnBodyNoComments));
  assert("6c: never itself computes/writes financial totals (no _cents column ever assigned)", !/_cents\s*[:=]/.test(fnBodyNoComments));

  console.log("\n── accepts BOTH 'open' and 'closing' — the reconciliation-compatible design ──");
  assert("7a: the status guard explicitly allows 'closing', not just 'open'", /status NOT IN \('open','closing'\)/.test(fnBodyNoComments));

  console.log("\n── access control ──");
  assert("8a: REVOKE ALL FROM PUBLIC, anon, authenticated", /REVOKE ALL ON FUNCTION[\s\S]*roll_service_session_economic_v1[\s\S]*FROM PUBLIC, anon, authenticated/.test(sqlNoComments));
  assert("8b: GRANT EXECUTE TO service_role only", /GRANT EXECUTE ON FUNCTION[\s\S]*roll_service_session_economic_v1[\s\S]*TO service_role/.test(sqlNoComments));

  console.log("\n── never touches unrelated existing machinery ──");
  const forbidden = [
    { name: "chiudiServizio (legacy V2 close)", re: /chiudiServizio/ },
    { name: "begin_service_session_close / complete_service_session_close (legacy two-phase RPCs)", re: /(begin|complete)_service_session_close/ },
    { name: "close_service_session_v3 (V3's own destructive-adjacent close — deliberately not reused, see header)", re: /close_service_session_v3/ },
    { name: "guard_service_session_closed_v1 (never modified — the whole point)", re: /CREATE OR REPLACE FUNCTION public\.guard_service_session_closed_v1/ },
    { name: "LEGACY_AUTOMATIC_LIFECYCLE_ENABLED (no scheduler wiring here)", re: /LEGACY_AUTOMATIC_LIFECYCLE_ENABLED/ },
    { name: "storico / serata_summary (legacy archive)", re: /\b(storico|serata_summary)\b/ },
  ];
  for (const { name, re } of forbidden) {
    assert(`9: forward migration never references ${name}`, !re.test(sqlNoComments));
  }

  console.log("\n── rollback is a clean, safety-guarded mirror ──");
  assert("10a: rollback refuses if any real rolled_over row still exists", /status = 'rolled_over'[\s\S]*RAISE EXCEPTION/.test(stripComments(rollback)));
  assert("10b: rollback drops the RPC", /DROP FUNCTION IF EXISTS public\.roll_service_session_economic_v1/.test(rollback));
  assert("10c: rollback restores the original 3-value CHECK exactly", /CHECK \(status = ANY \(ARRAY\['open','closing','closed'\]\)\)/.test(stripComments(rollback)));
  assert("10d: rollback drops rolled_over_at", /DROP COLUMN IF EXISTS rolled_over_at/.test(rollback));
  assert("10e: rollback never touches ordenes/table_sessions either", !/\b(ordenes|table_sessions)\b/.test(stripComments(rollback)));

  console.log("");
  console.log("=== RESULT: " + pass + " passed, " + fail + " failed ===");
  process.exit(fail === 0 ? 0 : 1);
})();
