"use strict";
// R-DAY4 — Service Period consolidation. Static (source-text) proof for the
// migration + paired rollback + JS wrapper + index.js wiring, same convention
// as tests/rDay3HotfixResolverBootstrapDemotion.static.test.js. Live/DB
// acceptance (idempotency, concurrency, immutability, financial invariants)
// runs as its own separate, controlled, rollback-guarded step against real
// staging, per the same discipline every prior R-DAY slice used.
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

const SQL = read("migrations/2026-08-16_r_day4_period_consolidation.sql");
const ROLLBACK = read("migrations/2026-08-16_r_day4_period_consolidation.ROLLBACK.sql");
const INDEX = read("index.js");
const JS = read("src/serviceSessions/periodConsolidation.js");

console.log("\n== A. Predecessor guards ==");
assert("1a: refuses if business_day_lifecycle_state does not exist (R-DAY1 dependency)",
  /R-DAY4 refused: business_day_lifecycle_state does not exist/.test(SQL));
assert("1b: refuses if resolve_order_intake_context_v1 does not exist (R-DAY3 dependency)",
  /R-DAY4 refused: resolve_order_intake_context_v1 does not exist/.test(SQL));
assert("1c: refuses if capture_closeout_snapshot does not exist (S-slice closeout foundation dependency)",
  /R-DAY4 refused: capture_closeout_snapshot does not exist/.test(SQL));
assert("1d: refuses if mesa_singleton_workspace_v1 does not exist (R-DAY2 dependency)",
  /R-DAY4 refused: mesa_singleton_workspace_v1 does not exist/.test(SQL));
assert("1e: refuses if period_consolidations or consolidate_period_v1 already exist (drift guard)",
  /R-DAY4 refused: period_consolidations already exists/.test(SQL)
  && /R-DAY4 refused: consolidate_period_v1 already exists/.test(SQL));

console.log("\n== B. period_consolidations DDL — exact R-DAY0 §9 shape ==");
for (const col of [
  "id\\s+uuid\\s+PRIMARY KEY",
  "workspace_id\\s+uuid\\s+NOT NULL REFERENCES public\\.workspaces\\(id\\)",
  "business_day_id\\s+uuid\\s+NOT NULL REFERENCES public\\.business_days\\(id\\)",
  "period_id\\s+uuid\\s+NOT NULL REFERENCES public\\.service_sessions\\(id\\)",
  "cutoff_at\\s+timestamptz\\s+NOT NULL",
  "reset_ticket_sequence\\s+boolean\\s+NOT NULL",
  "new_ticket_epoch\\s+integer\\s+NULL",
  "snapshot_id\\s+uuid\\s+NOT NULL REFERENCES public\\.service_closeout_snapshots\\(id\\)",
  "client_request_id\\s+text\\s+NOT NULL",
]) {
  assert(`2: column present — ${col}`, new RegExp(col).test(SQL));
}
assert("2a: idempotency unique constraint on (workspace_id, client_request_id)",
  /CONSTRAINT period_consolidations_idempotency_uq UNIQUE \(workspace_id, client_request_id\)/.test(SQL));
assert("2b: reset/epoch pairing CHECK constraint (reset=true<=>epoch set)",
  /period_consolidations_reset_epoch_chk/.test(SQL));
assert("2c: append-only trigger reuses the EXISTING generic mesa_append_only_v1 (no new one-off function)",
  /CREATE TRIGGER period_consolidations_append_only_v1\s*\n\s*BEFORE UPDATE OR DELETE ON public\.period_consolidations\s*\n\s*FOR EACH ROW EXECUTE FUNCTION public\.mesa_append_only_v1\(\)/.test(SQL));
assert("2d: RLS enabled, zero actual CREATE POLICY statement (default-deny + service_role bypass)",
  /ALTER TABLE public\.period_consolidations ENABLE ROW LEVEL SECURITY/.test(SQL)
  && !/^CREATE POLICY\b/m.test(SQL));
assert("2e: deterministic privilege floor — REVOKE ALL including service_role, then GRANT back only SELECT, INSERT",
  /REVOKE ALL ON public\.period_consolidations FROM PUBLIC, anon, authenticated, service_role/.test(SQL)
  && /GRANT SELECT, INSERT ON public\.period_consolidations TO service_role/.test(SQL)
  && !/GRANT[^;]*UPDATE[^;]*ON public\.period_consolidations/.test(SQL)
  && !/GRANT[^;]*DELETE[^;]*ON public\.period_consolidations/.test(SQL));

console.log("\n== C. consolidate_period_v1 — literal R-DAY0 §9 seven-step body ==");
const fnStart = SQL.indexOf("CREATE OR REPLACE FUNCTION public.consolidate_period_v1");
const fnEnd = SQL.indexOf("$function$;", fnStart);
const FN = SQL.slice(fnStart, fnEnd);
assert("3: function found", fnStart !== -1 && fnEnd !== -1);
assert("3a: signature matches R-DAY0 §9 exactly (7 params, correct order/types)",
  /p_workspace_id\s+uuid,\s*\n\s*p_period_id\s+uuid,\s*\n\s*p_by_actor\s+text,\s*\n\s*p_by_role\s+text,\s*\n\s*p_by_sid_hash\s+text,\s*\n\s*p_reset_tickets\s+boolean,\s*\n\s*p_client_request_id\s+text/.test(FN));
assert("3b: step 1 — acquires the EXISTING shared lifecycle lock (name unchanged, §6)",
  /PERFORM pg_advisory_xact_lock\(hashtext\('service_session_lifecycle'\)\)/.test(FN));
assert("3c: step 2 — idempotency check on (workspace_id, client_request_id) BEFORE any cutoff/snapshot/insert",
  FN.indexOf("WHERE workspace_id = p_workspace_id AND client_request_id = p_client_request_id")
    < FN.indexOf("v_cutoff := clock_timestamp()"));
assert("3d: idempotent replay returns ALREADY_CONSOLIDATED, never re-captures a snapshot",
  /'code', 'ALREADY_CONSOLIDATED', 'idempotent', true/.test(FN));
assert("3e: step 3 / STOP condition 3 — cutoff is server-assigned clock_timestamp(), no p_cutoff_at parameter declared",
  /v_cutoff := clock_timestamp\(\)/.test(FN) && !/p_cutoff_at\s+timestamp/.test(FN));
assert("3f: step 4 — reuses the EXISTING, unchanged capture_closeout_snapshot() RPC, no new capture mechanism",
  /v_capture := public\.capture_closeout_snapshot\(/.test(FN));
assert("3g: checkpoint payload mirrors the one live reachable caller's exact shape (economicBoundaryEngine.js)",
  /'session', to_jsonb\(v_period\)/.test(FN) && /'orders',/.test(FN) && /'tableSessions',/.test(FN) && /'financialEvents',/.test(FN));
assert("3h: step 6 — ticket-epoch advance is conditional on the EXPLICIT p_reset_tickets flag, never implicit",
  /IF p_reset_tickets THEN/.test(FN));
assert("3i: ticket-epoch advance mirrors the pointer ONLY when this period's day is the currently-pointed one",
  /WHERE singleton = true AND current_business_day_id = v_period\.business_day_id/.test(FN));
assert("3j: step 5 — inserts exactly one period_consolidations row",
  /INSERT INTO public\.period_consolidations/.test(FN));
assert("3k: fail-closed workspace resolution via the EXISTING mesa_singleton_workspace_v1 (never trusts the caller blindly)",
  /IF p_workspace_id IS DISTINCT FROM public\.mesa_singleton_workspace_v1\(\) THEN/.test(FN));
assert("3l: monotonicity guard present (procedural, not a CHECK constraint — see migration header for why)",
  /CONSOLIDATION_CUTOFF_NOT_MONOTONIC/.test(FN));

console.log("\n== D. HARD PRINCIPLE — non-fusion with period assignment/currency (owner correction) ==");
assert("4a: NEVER writes business_day_lifecycle_state.current_period_id",
  !/current_period_id\s*=/.test(FN));
assert("4b: NEVER writes service_session_state.current_session_id",
  !/current_session_id\s*=/.test(FN));
assert("4c: NEVER writes service_sessions.status (no period supersession/demotion)",
  !/UPDATE public\.service_sessions/.test(FN) && !/SET status/.test(FN));
assert("4d: NEVER creates a successor service_sessions row",
  !/INSERT INTO public\.service_sessions/.test(FN));
assert("4e: resolveEconomicPeriod/resolve_order_intake_context_v1 never referenced INSIDE the function body itself"
  + " (predecessor-guard existence checks elsewhere in the file are dependency assertions, not calls)",
  !/resolveEconomicPeriod/.test(FN) && !/resolve_order_intake_context_v1/.test(FN));
assert("4f: the ONLY tables written by this function are business_days, business_day_lifecycle_state"
  + " (epoch-mirror only, conditional) and period_consolidations",
  (() => {
    const writes = [...FN.matchAll(/(?:UPDATE|INSERT INTO)\s+public\.(\w+)/g)].map((m) => m[1]);
    const allowed = new Set(["business_days", "business_day_lifecycle_state", "period_consolidations"]);
    return writes.length > 0 && writes.every((t) => allowed.has(t));
  })());
assert("4f2: the business_day_lifecycle_state write's SET clause touches ONLY current_ticket_epoch/updated_at"
  + " (current_business_day_id appears only in the WHERE guard, as a read comparison, never assigned)",
  (() => {
    const idx = FN.indexOf("UPDATE public.business_day_lifecycle_state");
    if (idx === -1) return false;
    const stmtEnd = FN.indexOf(";", idx);
    const setStart = FN.indexOf("SET", idx);
    const whereStart = FN.indexOf("WHERE", idx);
    if (setStart === -1 || whereStart === -1 || whereStart > stmtEnd) return false;
    const setClause = FN.slice(setStart, whereStart);
    return /current_ticket_epoch\s*=/.test(setClause)
      && !/current_period_id\s*=/.test(setClause)
      && !/current_business_day_id\s*=/.test(setClause);
  })());
assert("4g: no ordenes/table_sessions/payment_transactions/payment_allocations write anywhere in this migration",
  !/UPDATE public\.ordenes/.test(SQL) && !/INSERT INTO public\.ordenes/.test(SQL)
  && !/UPDATE public\.table_sessions/.test(SQL) && !/INSERT INTO public\.table_sessions/.test(SQL)
  && !/public\.payment_transactions\s+SET/.test(SQL) && !/INSERT INTO public\.payment_transactions/.test(SQL)
  && !/public\.payment_allocations\s+SET/.test(SQL) && !/INSERT INTO public\.payment_allocations/.test(SQL));

console.log("\n== E. Grants on the RPC itself ==");
assert("5a: REVOKE ALL FROM PUBLIC, anon, authenticated on consolidate_period_v1",
  /REVOKE ALL ON FUNCTION public\.consolidate_period_v1\([^)]*\) FROM PUBLIC, anon, authenticated/.test(SQL));
assert("5b: GRANT EXECUTE TO service_role only",
  /GRANT EXECUTE ON FUNCTION public\.consolidate_period_v1\([^)]*\) TO service_role/.test(SQL));

console.log("\n== F. Post-conditions — structural, includes a real pointer-unchanged assertion ==");
assert("6a: post-condition asserts the shared lock IS acquired in the live function body",
  /pg_advisory_xact_lock\(hashtext\(%service_session_lifecycle%\)\)/.test(SQL));
assert("6b: post-condition asserts pointer/shadow/status writes are ABSENT from the live function body",
  /consolidate_period_v1 appears to write the pointer, shadow, or period status/.test(SQL));
assert("6c: post-condition asserts the real canonical pointer is byte-identical before/after this migration",
  /canonical pointer changed unexpectedly by this migration/.test(SQL));
assert("6d: post-condition asserts payment_transactions population unchanged (exactly 20)",
  /payment_transactions\) <> 20/.test(SQL));
assert("6e: post-condition asserts the table is created EMPTY (never self-seeds a row)",
  /this migration must create the table empty, never seed a row/.test(SQL));

console.log("\n== G. Paired rollback — refuses on real historical evidence, never deletes it ==");
assert("7a: refuses if ANY consolidation row exists — a committed checkpoint is a historical economic fact",
  /R-DAY4 rollback refused: %.*real consolidation checkpoint row/.test(ROLLBACK) || /real consolidation checkpoint row/.test(ROLLBACK));
assert("7b: no p_force/force-flag parameter or override branch exists in the rollback",
  !/p_force/i.test(ROLLBACK) && !/force\s*:?=\s*true/i.test(ROLLBACK));
assert("7c: drops only this migration's own objects — never touches R-DAY1-R-DAY3 objects",
  /DROP FUNCTION IF EXISTS public\.consolidate_period_v1/.test(ROLLBACK)
  && /DROP TABLE IF EXISTS public\.period_consolidations/.test(ROLLBACK)
  && !/DROP FUNCTION IF EXISTS public\.resolve_order_intake_context_v1/.test(ROLLBACK)
  && !/DROP TABLE IF EXISTS public\.business_day_lifecycle_state/.test(ROLLBACK));
assert("7d: rollback post-condition reconfirms R-DAY3's resolver and the pre-existing capture mechanism survive",
  /resolve_order_intake_context_v1.*was unexpectedly removed/.test(ROLLBACK)
  && /capture_closeout_snapshot.*was unexpectedly removed/.test(ROLLBACK));

console.log("\n== H. JS wrapper (periodConsolidation.js) — thin, no business logic the SQL doesn't own ==");
assert("8a: calls exactly the consolidate_period_v1 RPC, no other RPC/table access",
  /rpc\("consolidate_period_v1"/.test(JS) && !/sbSelect|sbInsert|sbUpdate|sbUpsert/.test(JS));
assert("8b: resetTickets must be an explicit boolean — rejects undefined/non-boolean rather than defaulting",
  /typeof resetTickets !== "boolean"/.test(JS));
const JS_CODE_ONLY = JS.split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n");
assert("8c: never reads or writes business_day_lifecycle_state/service_session_state/service_sessions.status IN CODE"
  + " (header comment explaining their absence is expected and excluded from this check)",
  !/business_day_lifecycle_state/.test(JS_CODE_ONLY) && !/service_session_state/.test(JS_CODE_ONLY) && !/service_sessions\.status/.test(JS_CODE_ONLY));
assert("8d: sid is hashed via the existing sidHash module, never passed/stored raw",
  /hashSid\(sid\)/.test(JS) && /require\("\.\.\/auth\/sidHash"\)/.test(JS));

console.log("\n== I. index.js wiring — action, auth, workspace fail-closed resolution ==");
const actionStart = INDEX.indexOf('action === "consolidateServicePeriod"');
assert("9a: action registered in the dispatcher", actionStart !== -1);
const actionBlock = INDEX.slice(actionStart, INDEX.indexOf('} else if (action === "resolveServiceIncident")', actionStart));
assert("9b: requires a verified actor+role from req.authCtx (never client-asserted)",
  /req\.authCtx\?\.actor/.test(actionBlock) && /req\.authCtx\?\.role/.test(actionBlock));
assert("9c: resetTickets must be an explicit boolean at the HTTP boundary too (defense in depth)",
  /typeof resetTickets !== "boolean"/.test(actionBlock));
assert("9d: fail-closed workspace resolution — refuses unless exactly 1 workspace row",
  /workspaceRows\.length !== 1/.test(actionBlock));
assert("9e: delegates to periodConsolidation.consolidate, no direct RPC/DB call inline",
  /periodConsolidation\.consolidate\(/.test(actionBlock));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
