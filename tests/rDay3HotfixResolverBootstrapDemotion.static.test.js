"use strict";
// R-DAY3 HOTFIX — resolver bootstrap-demotion fix. Static (source-text) proof
// for the migration + paired rollback, same convention as
// tests/rDay2HotfixServiceSessionsBusinessDayDerive.static.test.js. The
// underlying defect (INSERT into service_sessions violating
// service_sessions_single_active_uq when the pointer is still dormant but a
// legacy session predating it is genuinely open) was reproduced live, in a
// rolled-back transaction, before this fix was authored -- see this
// migration's own header comment for the exact error text.
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

const SQL = read("migrations/2026-08-16_r_day3_hotfix_resolver_bootstrap_demotion.sql");
const ROLLBACK = read("migrations/2026-08-16_r_day3_hotfix_resolver_bootstrap_demotion.ROLLBACK.sql");

console.log("\n== A. Predecessor guards ==");
assert("1a: refuses if resolve_order_intake_context_v1 does not exist",
  /R-DAY3 hotfix refused: resolve_order_intake_context_v1 does not exist/.test(SQL));
assert("1b: refuses unless the resolver body still matches the exact pre-hotfix (buggy) shape",
  /prosrc LIKE '%IF v_pointer\.current_period_id IS NOT NULL AND v_period\.status IN%'/.test(SQL));

console.log("\n== B. The fix itself ==");
assert("2a: demotion detection now queries the GLOBAL active session directly, not the pointer",
  /SELECT \* INTO v_period FROM public\.service_sessions WHERE status IN \('open','closing'\) FOR UPDATE;/.test(SQL));
assert("2b: the old pointer-keyed condition is gone from the corrected function body",
  (() => {
    const fnStart = SQL.indexOf("CREATE OR REPLACE FUNCTION public.resolve_order_intake_context_v1");
    const fnEnd = SQL.indexOf("$function$;", fnStart);
    const body = SQL.slice(fnStart, fnEnd);
    return !/IF v_pointer\.current_period_id IS NOT NULL AND v_period\.status IN/.test(body);
  })());
assert("2c: demotes whatever is found active, unconditional on the pointer's prior state",
  /IF FOUND THEN\s*\n\s*(?:--[^\n]*\n\s*)*(?:--[^\n]*\n\s*)*(?:--[^\n]*\n\s*)*UPDATE public\.service_sessions\s*\n\s*SET status = 'rolled_over'/.test(SQL));
assert("2d: never reopens a historical row -- adopts an active match or creates NEW, same as the original design",
  /WHERE business_date = v_business_date AND service_kind = v_service_kind\s*\n\s*AND status IN \('open','closing'\);\s*\n\s*IF NOT FOUND THEN\s*\n\s*INSERT INTO public\.service_sessions/.test(SQL));
assert("2e: invariant assertions (BUSINESS_DAY_POINTER_MISMATCH / TICKET_EPOCH_MIRROR_MISMATCH) preserved verbatim",
  /BUSINESS_DAY_POINTER_MISMATCH/.test(SQL) && /TICKET_EPOCH_MIRROR_MISMATCH/.test(SQL));
assert("2f: C1 legacy shadow write-through preserved in the same transaction",
  /UPDATE public\.service_session_state\s*\n\s*SET current_session_id = v_pointer\.current_period_id/.test(SQL));
assert("2g: get_order_intake_context_v1 is not touched by this migration (unaffected, read-only, no service_sessions access)",
  !/CREATE OR REPLACE FUNCTION public\.get_order_intake_context_v1/.test(SQL));
assert("2h: service_session_assign_order() is not redefined by this migration",
  !/CREATE OR REPLACE FUNCTION public\.service_session_assign_order/.test(SQL));

console.log("\n== C. Post-conditions — structural only, never a real live call ==");
assert("3a: post-condition never calls the mutating resolver for real (no SELECT public.resolve_order_intake_context_v1)",
  !/SELECT public\.resolve_order_intake_context_v1\(/.test(SQL));
assert("3b: asserts the corrected query pattern is present in the live function body",
  /resolver body does not contain the corrected global-active-session query/.test(SQL));
assert("3c: asserts the old buggy pattern is gone from the live function body",
  /the old pointer-keyed demotion condition is still present/.test(SQL));
assert("3d: asserts d20ee320 (the real live legacy session) is untouched by this migration",
  /d20ee320 status changed unexpectedly/.test(SQL));
assert("3e: asserts the pointer was NOT activated as a side effect of applying this migration",
  /pointer unexpectedly activated/.test(SQL));
assert("3f: asserts financial baseline unchanged",
  /payment_transactions population changed -- must be exactly 20/.test(SQL));

console.log("\n== D. Rollback — exact byte-captured pre-hotfix body ==");
assert("4a: refuses if the hotfixed body is not present (nothing to roll back)",
  /R-DAY3 hotfix rollback refused: resolver does not contain the hotfixed body/.test(ROLLBACK));
assert("4b: restores the exact pre-hotfix pointer-keyed demotion condition verbatim",
  /IF v_pointer\.current_period_id IS NOT NULL AND v_period\.status IN \('open','closing'\) THEN/.test(ROLLBACK));
assert("4c: restores the exact same invariant assertions",
  /BUSINESS_DAY_POINTER_MISMATCH/.test(ROLLBACK) && /TICKET_EPOCH_MIRROR_MISMATCH/.test(ROLLBACK));
assert("4d: rollback post-condition re-asserts financial baseline",
  /payment_transactions population changed -- must be exactly 20/.test(ROLLBACK));

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
