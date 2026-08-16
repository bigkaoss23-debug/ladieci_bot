"use strict";
// R-DAY4 HOTFIX — consolidate_period_v1's missing pointer-authorization GUC
// on its conditional ticket-epoch mirror write. Reproduced live on staging
// (acceptance case C) before this fix was authored; see this migration's own
// header comment for the exact error text and root cause.
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

const SQL = read("migrations/2026-08-16_r_day4_hotfix_pointer_authorization.sql");
const ROLLBACK = read("migrations/2026-08-16_r_day4_hotfix_pointer_authorization.ROLLBACK.sql");

console.log("\n== A. Predecessor guards ==");
assert("1a: refuses if consolidate_period_v1 does not exist",
  /R-DAY4 hotfix refused: consolidate_period_v1 does not exist/.test(SQL));
assert("1b: refuses unless the live body still matches the exact pre-hotfix (missing-authorization) shape",
  /prosrc NOT LIKE '%set_config\(%ladieci\.business_day_pointer_authorized%''true''%'/.test(SQL));

console.log("\n== B. The fix itself ==");
const fnStart = SQL.indexOf("CREATE OR REPLACE FUNCTION public.consolidate_period_v1");
const fnEnd = SQL.indexOf("$function$;", fnStart);
const FN = SQL.slice(fnStart, fnEnd);
assert("2a: authorization call present, positioned immediately before the guarded UPDATE",
  /PERFORM set_config\('ladieci\.business_day_pointer_authorized', 'true', true\);\s*\n\s*UPDATE public\.business_day_lifecycle_state/.test(FN));
assert("2b: authorization call is INSIDE the p_reset_tickets branch, not unconditional",
  (() => {
    const ifIdx = FN.indexOf("IF p_reset_tickets THEN");
    const endIdx = FN.indexOf("END IF;", ifIdx);
    const branch = FN.slice(ifIdx, endIdx);
    return /set_config\('ladieci\.business_day_pointer_authorized'/.test(branch);
  })());
assert("2c: still never assigns current_period_id/current_business_day_id/current_session_id/status (non-fusion contract intact)",
  !/SET current_period_id/.test(FN) && !/SET current_business_day_id/.test(FN)
  && !/current_session_id\s*=/.test(FN) && !/SET status/.test(FN));
assert("2d: idempotency/lock/cutoff/capture/insert logic is otherwise byte-identical to the main migration"
  + " (same idempotency-check-before-cutoff ordering)",
  FN.indexOf("WHERE workspace_id = p_workspace_id AND client_request_id = p_client_request_id")
    < FN.indexOf("v_cutoff := clock_timestamp()"));

console.log("\n== C. Post-conditions ==");
assert("3a: post-condition never calls the RPC with p_reset_tickets=true for real (structural only)",
  !/SELECT public\.consolidate_period_v1\(/.test(SQL) || !/,\s*true,\s*'/.test(SQL.slice(SQL.indexOf("DO $$", SQL.lastIndexOf("$function$;")))));
assert("3b: post-condition reconfirms the append-only trigger on period_consolidations is untouched",
  /period_consolidations_append_only_v1/.test(SQL));

console.log("\n== D. Paired rollback — restores the exact pre-hotfix (buggy) body ==");
assert("4a: rollback body has NO set_config authorization call (byte-exact buggy restore)",
  !/set_config\('ladieci\.business_day_pointer_authorized'/.test(ROLLBACK.slice(ROLLBACK.indexOf("CREATE OR REPLACE FUNCTION"), ROLLBACK.indexOf("$function$;"))));
assert("4b: rollback post-condition asserts the authorization call is ABSENT (reproduces the exact defect)",
  /prosrc NOT LIKE '%set_config\(%ladieci\.business_day_pointer_authorized%''true''%'/.test(ROLLBACK));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
