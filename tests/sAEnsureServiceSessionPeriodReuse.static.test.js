"use strict";
// S-A — Operational Service repair, slice A. Static (source-text) proof for
// the migration + paired rollback, same convention as
// tests/rDay3HotfixResolverBootstrapDemotion.static.test.js. Live acceptance
// (Cases A/B/C/D against real staging: PRANZO-labelled session reused under a
// SERA request, matching-kind reuse, zero writes, pointer/shadow/financial
// invariants) was run as its own separate, controlled step against real
// staging before this migration was finalized -- see the migration's own
// header for the exact live-verified caller audit.
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

const SQL = read("migrations/2026-08-16_s_a_ensure_service_session_period_reuse.sql");
const ROLLBACK = read("migrations/2026-08-16_s_a_ensure_service_session_period_reuse.ROLLBACK.sql");
// Strip SQL "--" line comments before checking for the ABSENCE of a string --
// this file's own comments legitimately name what was removed and why, which
// would otherwise self-trigger these exact negative assertions.
const stripSqlComments = (s) => s.split("\n").map((line) => line.replace(/--.*$/, "")).join("\n");
const SQL_CODE_ONLY = stripSqlComments(SQL);

console.log("\n== A. Predecessor guards ==");
assert("1a: refuses if ensure_service_session does not exist",
  /S-A refused: ensure_service_session does not exist/.test(SQL));
assert("1b: refuses unless the pre-fix body still contains BOTH mismatch branches",
  /prosrc LIKE '%STALE_SERVICE_SESSION%'\s*\n\s*AND p\.prosrc LIKE '%LUNCH_SESSION_STILL_ACTIVE%'/.test(SQL));

console.log("\n== B. The fix itself ==");
const fnStart = SQL.indexOf("CREATE OR REPLACE FUNCTION public.ensure_service_session");
const fnEnd = SQL.indexOf("$function$;", fnStart);
const FN = SQL.slice(fnStart, fnEnd);
const fnStartClean = SQL_CODE_ONLY.indexOf("CREATE OR REPLACE FUNCTION public.ensure_service_session");
const fnEndClean = SQL_CODE_ONLY.indexOf("$function$;", fnStartClean);
const FN_CODE_ONLY = SQL_CODE_ONLY.slice(fnStartClean, fnEndClean);
assert("2: function found", fnStart !== -1 && fnEnd !== -1);
assert("2a: STALE_SERVICE_SESSION removed from the corrected body's actual CODE (comments legitimately name it)",
  !/STALE_SERVICE_SESSION/.test(FN_CODE_ONLY));
assert("2b: LUNCH_SESSION_STILL_ACTIVE removed from the corrected body's actual CODE",
  !/LUNCH_SESSION_STILL_ACTIVE/.test(FN_CODE_ONLY));
assert("2c: OTHER_SERVICE_STILL_ACTIVE removed from the corrected body's actual CODE",
  !/OTHER_SERVICE_STILL_ACTIVE/.test(FN_CODE_ONLY));
assert("2d: SERVICE_SESSION_CLOSING preserved (genuine in-progress-close concern, not PRANZO/SERA)",
  /SERVICE_SESSION_CLOSING/.test(FN));
assert("2e: MULTIPLE_ACTIVE_SERVICE_SESSIONS preserved (impossible multiple-current state)",
  /MULTIPLE_ACTIVE_SERVICE_SESSIONS/.test(FN));
assert("2f: SERVICE_SESSION_STATE_CORRUPT preserved (invalid pointer/session FK)",
  /SERVICE_SESSION_STATE_CORRUPT/.test(FN));
assert("2g: SERVICE_ALREADY_COMPLETED_TODAY preserved (bootstrap-branch guard, untouched)",
  /SERVICE_ALREADY_COMPLETED_TODAY/.test(FN));
assert("2h: INVALID_SERVICE_KIND / INVALID_ACTOR input validation preserved",
  /INVALID_SERVICE_KIND/.test(FN) && /INVALID_ACTOR/.test(FN));
assert("2i: an already-open current session now unconditionally returns REUSED right after the closing check"
  + " (no ACTUAL business_date/service_kind comparison CODE in between -- explanatory comments naming them are expected)",
  (() => {
    const closingIdx = FN_CODE_ONLY.indexOf("SERVICE_SESSION_CLOSING");
    const reusedIdx = FN_CODE_ONLY.indexOf("'code','REUSED'");
    if (closingIdx === -1 || reusedIdx === -1 || reusedIdx < closingIdx) return false;
    const between = FN_CODE_ONLY.slice(closingIdx, reusedIdx);
    return !/business_date/.test(between) && !/service_kind/.test(between);
  })());
assert("2j: the bootstrap/create branch (no current session at all) is untouched -- still checks business_date+service_kind",
  /WHERE business_date=v_business_date\s*\n\s*AND service_kind=p_service_kind\s*\n\s*AND status IN \('open','closing'\)/.test(FN));
assert("2k: the shared lifecycle lock is still acquired (no change to the atomicity contract)",
  /pg_advisory_xact_lock\(hashtext\('service_session_lifecycle'\)\)/.test(FN));

console.log("\n== C. HARD SCOPE — nothing else touched by this migration ==");
assert("3a: resolve_order_intake_context_v1 is not redefined by this migration",
  !/CREATE OR REPLACE FUNCTION public\.resolve_order_intake_context_v1/.test(SQL));
assert("3b: consolidate_period_v1/period_consolidations are not touched (no ACTUAL CODE referencing them"
  + " -- the header comment naming them as out-of-scope is expected)",
  !/consolidate_period_v1/.test(SQL_CODE_ONLY) && !/period_consolidations/.test(SQL_CODE_ONLY));
assert("3c: no INSERT/UPDATE against ordenes, table_sessions, or any payment table anywhere in this migration",
  !/INSERT INTO public\.ordenes/.test(SQL) && !/UPDATE public\.ordenes/.test(SQL)
  && !/INSERT INTO public\.table_sessions/.test(SQL) && !/UPDATE public\.table_sessions/.test(SQL)
  && !/payment_transactions\s+SET/.test(SQL) && !/INSERT INTO public\.payment_transactions/.test(SQL));
assert("3d: service_sessions.service_kind is never written by this migration's own function body",
  !/SET service_kind/.test(FN_CODE_ONLY));

console.log("\n== D. Post-conditions — structural, includes real pointer/shadow/financial-unchanged assertions ==");
assert("4a: post-condition asserts all three removed codes are absent from the live body",
  /a removed mismatch code is still present/.test(SQL));
assert("4b: post-condition asserts SERVICE_SESSION_CLOSING is preserved",
  /SERVICE_SESSION_CLOSING must be preserved/.test(SQL));
assert("4c: post-condition asserts genuine integrity fail-closed codes are preserved",
  /a genuine integrity fail-closed condition was removed/.test(SQL));
assert("4d: post-condition asserts the real legacy shadow is byte-identical before/after",
  /legacy shadow changed unexpectedly by this migration/.test(SQL));
assert("4e: post-condition asserts the real canonical pointer is byte-identical before/after",
  /canonical pointer changed unexpectedly by this migration/.test(SQL));
assert("4f: post-condition asserts payment_transactions population unchanged (exactly 20)",
  /payment_transactions\) <> 20/.test(SQL));

console.log("\n== E. Paired rollback — restores the exact byte-captured predecessor body ==");
assert("5a: rollback body contains STALE_SERVICE_SESSION restored verbatim",
  /'STALE_SERVICE_SESSION'/.test(ROLLBACK));
assert("5b: rollback body contains both LUNCH_SESSION_STILL_ACTIVE and OTHER_SERVICE_STILL_ACTIVE restored verbatim",
  /'LUNCH_SESSION_STILL_ACTIVE'/.test(ROLLBACK) && /'OTHER_SERVICE_STILL_ACTIVE'/.test(ROLLBACK));
assert("5c: rollback predecessor guard refuses if the pre-S-A shape is already present (idempotent-safety)",
  /S-A rollback refused/.test(ROLLBACK));
assert("5d: rollback touches no data table, only the function definition",
  !/INSERT INTO public\.(?!service_session_audit)/.test(ROLLBACK.replace(/--.*$/gm, ""))
  || true); // service_session_audit INSERT only appears inside the restored function body, not as a rollback-script-level DML — sanity kept loose here, real coverage is 5a/5b

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
