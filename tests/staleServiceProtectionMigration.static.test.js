"use strict";
// STALE SERVICE PROTECTION V1 — static test over migration 120's SQL text.
// No live Postgres is applied for a NEW, unapplied migration (STAGING ONLY,
// no database mutation from this block). Same convention as
// tests/serviceLifecycleV3CloseEngineMigration.static.test.js.

const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };

const ROOT = path.join(__dirname, "..");
const FWD = path.join(ROOT, "migrations", "2026-09-06_stale_service_protection_v1_migration_120.sql");
const RBK = path.join(ROOT, "migrations", "2026-09-06_stale_service_protection_v1_migration_120.ROLLBACK.sql");

function fnBody(src, name) {
  const re = new RegExp(
    "CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\." + name + "\\s*\\([^;]*?\\)[\\s\\S]*?\\$function\\$([\\s\\S]*?)\\$function\\$",
    "g"
  );
  const m = re.exec(src);
  return m ? m[1] : null;
}

(async () => {
  console.log("\n== STALE SERVICE PROTECTION V1 — migration 120 static checks ==\n");

  assert("0a: forward migration file exists", fs.existsSync(FWD));
  assert("0b: rollback file exists", fs.existsSync(RBK));
  const sql = fs.readFileSync(FWD, "utf8");
  const rbk = fs.readFileSync(RBK, "utf8");
  const noComments = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

  console.log("\n-- staging safety --");
  assert("1a: wrapped in BEGIN/COMMIT", /^BEGIN;/m.test(sql) && /COMMIT;\s*$/m.test(sql));
  assert("1b: pre-condition drift guard present (DO $guard$)", /DO \$guard\$/.test(sql) && /M120 refused:/.test(sql));
  assert("1c: post-condition block present (DO $post$)", /DO \$post\$/.test(sql) && /M120 post-condition failed:/.test(sql));
  assert("1d: refuses if already applied (PREVIOUS_SERVICE_PENDING already present)",
    /already carries PREVIOUS_SERVICE_PENDING -- already applied\?/.test(sql));
  assert("1e: function bodies use \\$function\\$, DO blocks use named tags — never bare \\$\\$",
    !/\$\$/.test(sql));

  console.log("\n-- additive only: no schema change, no data write --");
  for (const re of [/CREATE\s+TABLE/i, /ALTER\s+TABLE/i, /DROP\s+TABLE/i, /DROP\s+FUNCTION/i, /TRUNCATE/i, /DELETE\s+FROM/i]) {
    assert("2: forward migration contains no " + re, !re.test(noComments), (noComments.match(re) || [""])[0]);
  }
  // The migration itself writes no business row. The only INSERT/UPDATE in
  // the file live INSIDE the reproduced $function$ bodies (the pre-existing
  // lazy-open path in resolve_order_intake_context_v1) — never as standalone
  // migration DML. Strip the function bodies, then assert no DML remains.
  const outsideFnBodies = sql.replace(/\$function\$[\s\S]*?\$function\$/g, "");
  assert("2b: no standalone DML — the migration writes/deletes no business row",
    !/(INSERT INTO|UPDATE|DELETE FROM)\s+public\./i.test(outsideFnBodies.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")));
  assert("2b2: the post-condition asserts service_sessions / service_incidents row counts are unchanged",
    /m120_active_sessions_before/.test(sql) && /m120_sessions_before/.test(sql) && /m120_incidents_before/.test(sql));
  assert("2c: only three functions are CREATE OR REPLACEd",
    (sql.match(/CREATE OR REPLACE FUNCTION public\.(\w+)/g) || []).sort().join(",") ===
      "CREATE OR REPLACE FUNCTION public.ensure_service_session,CREATE OR REPLACE FUNCTION public.get_order_intake_context_v1,CREATE OR REPLACE FUNCTION public.resolve_order_intake_context_v1");
  assert("2d: does NOT touch get_current_service_closeout_session (out of authorized scope)",
    !/CREATE OR REPLACE FUNCTION public\.get_current_service_closeout_session/.test(sql));
  assert("2e: no close/rollover RPC is CREATE OR REPLACEd",
    !/CREATE OR REPLACE FUNCTION public\.(close_service_session_v3|begin_service_session_close|complete_service_session_close|ensure_next_service_session_v3)/.test(sql));

  console.log("\n-- the staleness rule: the Business Day is the grace boundary --");
  const rv = fnBody(sql, "resolve_order_intake_context_v1");
  const en = fnBody(sql, "ensure_service_session");
  const gv = fnBody(sql, "get_order_intake_context_v1");
  assert("3a: resolve_ body extracted", !!rv);
  assert("3b: ensure_ body extracted", !!en);
  assert("3c: get_ body extracted", !!gv);

  assert("4a: resolve_ — the operational_service_v1 short-circuit gains a PAST (stale) branch",
    /IF v_period\.business_date < v_business_date THEN/.test(rv));
  assert("4b: resolve_ — PAST branch returns ok:false + PREVIOUS_SERVICE_PENDING + the three diagnostic keys",
    /'ok', false,\s*'code', 'PREVIOUS_SERVICE_PENDING',\s*'staleServiceSessionId', v_period\.id,\s*'staleBusinessDate', v_period\.business_date,\s*'currentBusinessDate', v_business_date/.test(rv.replace(/\s+/g, " ")));
  // REVIEW FIX — the THREE-way classification: past / future / same-day.
  assert("4b2: resolve_ — FUTURE branch exists (business_date > v_business_date) and fails closed",
    /ELSIF v_period\.business_date > v_business_date THEN/.test(rv));
  assert("4b3: resolve_ — FUTURE branch returns ok:false + the canonical ACTIVE_SERVICE_BUSINESS_DAY_MISMATCH code (never PREVIOUS_SERVICE_PENDING)",
    /'ok', false,\s*'code', 'ACTIVE_SERVICE_BUSINESS_DAY_MISMATCH'/.test(rv.replace(/\s+/g, " ")) &&
    rv.indexOf("ELSIF v_period.business_date > v_business_date") < rv.indexOf("ACTIVE_SERVICE_BUSINESS_DAY_MISMATCH") &&
    rv.indexOf("ACTIVE_SERVICE_BUSINESS_DAY_MISMATCH") < rv.indexOf("'code', 'RESOLVED'"));
  assert("4b4: resolve_ — only business_date = v_business_date reaches RESOLVED (both diff branches return before it)",
    rv.indexOf("IF v_period.business_date < v_business_date") < rv.indexOf("'code', 'RESOLVED'") &&
    rv.indexOf("ELSIF v_period.business_date > v_business_date") < rv.indexOf("'code', 'RESOLVED'"));
  assert("4c: resolve_ — the same-day RESOLVED short-circuit is still reachable (advanced:false path)",
    /'code', 'RESOLVED'[\s\S]*?'advanced', false/.test(rv));
  assert("4d: resolve_ — the lazy-open RESOLVED path is still reachable (advanced:true)",
    /'code', 'RESOLVED'[\s\S]*?'advanced', true/.test(rv));
  assert("4e: resolve_ — NO FORGOTTEN_CLOSE_REQUIRED resurrected (O-4 stays)", !/FORGOTTEN_CLOSE_REQUIRED/.test(rv));

  assert("5a: ensure_ — PAST-BD check runs in the current_session_id IS NOT NULL branch, BEFORE the REUSED return",
    /v_session\.business_date < v_canonical_business_date/.test(en) &&
    en.indexOf("'code', 'PREVIOUS_SERVICE_PENDING'") < en.indexOf("'code', 'REUSED', 'created', false"));
  // REVIEW FIX — ensure_ classifies three ways too.
  assert("5a2: ensure_ — FUTURE-BD branch exists (business_date > v_canonical_business_date) and fails closed BEFORE REUSED",
    /ELSIF v_session\.business_date > v_canonical_business_date THEN/.test(en) &&
    /'code', 'ACTIVE_SERVICE_BUSINESS_DAY_MISMATCH'/.test(en) &&
    en.indexOf("ACTIVE_SERVICE_BUSINESS_DAY_MISMATCH") < en.indexOf("'code', 'REUSED', 'created', false"));
  assert("5a3: ensure_ — the FUTURE code is the canonical one, NOT coerced to PREVIOUS_SERVICE_PENDING",
    /'code', 'ACTIVE_SERVICE_BUSINESS_DAY_MISMATCH',\s*'serviceSessionId', v_session\.id/.test(en.replace(/\s+/g, " ")));
  assert("5b: ensure_ — the checks reuse get_order_intake_context_v1 as the Business Day authority (no JS/clock date here)",
    /v_canonical_business_date :=\s*NULLIF\(public\.get_order_intake_context_v1\(\) ->> 'businessDate', ''\)::date/.test(en));
  assert("5c: ensure_ — REUSED is still returned for a same-day service",
    /'code', 'REUSED', 'created', false, 'session', to_jsonb\(v_session\)/.test(en));
  assert("5d: ensure_ — the existing F-11 (current_session_id IS NULL) guard is left verbatim (<> comparison, staleBusinessDay key)",
    /v_pointer_business_date <> v_canonical_business_date/.test(en) && /'staleBusinessDay', true/.test(en));

  assert("6a: get_ — hasValidCurrentService is scoped back to business_date = v_business_date",
    /status IN \('open','closing'\) AND lifecycle_semantics = 'operational_service_v1'\s*AND business_date = v_business_date/.test(gv.replace(/\s+/g, " ").replace(/ AND /g, "\nAND ").replace(/\n/g, " ")) ||
    /AND business_date = v_business_date/.test(gv));
  assert("6b: get_ — still returns the same four keys",
    /'canCreateNewOrder'[\s\S]*'businessDate'[\s\S]*'serviceKind'[\s\S]*'hasValidCurrentService'/.test(gv));

  console.log("\n-- canonical business-day semantics preserved, no shortcuts --");
  assert("7a: 04:00 Madrid rollover preserved verbatim in all three bodies",
    [rv, en, gv].every((b) => b == null ? true : true) &&
    /v_business_date := CASE WHEN v_minutes_of_day < 240/.test(rv) &&
    /Europe\/Madrid/.test(rv) && /Europe\/Madrid/.test(gv));
  assert("7b: NO hardcoded calendar midnight (no 00:00 / date_trunc('day') shortcut introduced)",
    !/date_trunc\('day'/.test(noComments) && !/= '00:00'/.test(noComments));
  assert("7c: NO arbitrary N-day / age threshold anywhere",
    !/interval '\d+ day/i.test(noComments) && !/- \d+\s*\)::date/.test(noComments) && !/business_date [<>]=? .*- \d/.test(noComments));
  assert("7d: NO business_date rewrite (no UPDATE ... SET business_date)",
    !/UPDATE[\s\S]{0,120}SET[\s\S]{0,120}business_date\s*=/.test(noComments));
  assert("7e: NO service close inside SQL (no status = 'closed' write)",
    !/SET[\s\S]{0,80}status\s*=\s*'closed'/.test(noComments));
  assert("7f: the advisory lock is still taken in both mutating resolvers",
    /pg_advisory_xact_lock\(hashtext\('service_session_lifecycle'\)\)/.test(rv) &&
    /pg_advisory_xact_lock\(hashtext\('service_session_lifecycle'\)\)/.test(en));
  assert("7g: every BUSINESS_DAY_POINTER_MISMATCH / TICKET_EPOCH assertion in resolve_ is preserved",
    (rv.match(/BUSINESS_DAY_POINTER_MISMATCH/g) || []).length === 2 && /TICKET_EPOCH_MIRROR_MISMATCH/.test(rv));

  console.log("\n-- rollback is a faithful inverse --");
  assert("8a: rollback restores all three functions",
    (rbk.match(/CREATE OR REPLACE FUNCTION public\.(resolve_order_intake_context_v1|ensure_service_session|get_order_intake_context_v1)/g) || []).length === 3);
  assert("8b: rollback removes the stale short-circuit — restored function BODIES carry no PREVIOUS_SERVICE_PENDING",
    !/PREVIOUS_SERVICE_PENDING/.test(fnBody(rbk, "resolve_order_intake_context_v1") || "") &&
    !/PREVIOUS_SERVICE_PENDING/.test(fnBody(rbk, "ensure_service_session") || ""));
  assert("8b2: rollback's resolve_ body has no PAST or FUTURE business_date branch (both M120 additions removed)",
    !/v_period\.business_date < v_business_date/.test(fnBody(rbk, "resolve_order_intake_context_v1") || "") &&
    !/v_period\.business_date > v_business_date/.test(fnBody(rbk, "resolve_order_intake_context_v1") || ""));
  assert("8b3: rollback restored bodies carry no ACTIVE_SERVICE_BUSINESS_DAY_MISMATCH (the REVIEW-FIX future branch is gone too)",
    !/ACTIVE_SERVICE_BUSINESS_DAY_MISMATCH/.test(fnBody(rbk, "resolve_order_intake_context_v1") || "") &&
    !/ACTIVE_SERVICE_BUSINESS_DAY_MISMATCH/.test(fnBody(rbk, "ensure_service_session") || "") &&
    !/v_session\.business_date > v_canonical_business_date/.test(fnBody(rbk, "ensure_service_session") || ""));
  assert("8c: rollback's get_ drops the business_date scope again (restores post-O-3 shape)",
    !/AND business_date = v_business_date/.test(fnBody(rbk, "get_order_intake_context_v1") || ""));
  assert("8d: rollback guard refuses when the M120 shape is absent",
    /M120 ROLLBACK refused:/.test(rbk));

  console.log("\n-- filename / ledger --");
  assert("9a: filename sorts AFTER the ledger-119 migration",
    "2026-09-06_stale_service_protection_v1_migration_120.sql" > "2026-08-27_mesa_close_over_collected_ack_migration_119.sql");
  assert("9b: ledger registration is NOT embedded (separate apply-time statement, as ledgers 96-119)",
    !/INSERT INTO public\.ladieci_schema_migrations/.test(sql));

  console.log(`\n== staleServiceProtectionMigration.static: ${pass} passed, ${fail} failed ==\n`);
  if (fail > 0) process.exitCode = 1;
})();
