"use strict";
// F-11 — a STALE canonical Business Day pointer must classify as
// NO_OPEN_SERVICE, never REOPEN_REQUIRED. Static (source-text) proof that
// migration 2026-08-19_f11_ensure_stale_business_day_classification.sql is
// exactly as narrow as the frozen brief requires:
//   * it reuses the ONE existing canonical Business Day authority
//     (get_order_intake_context_v1) and invents no second clock rule;
//   * ensure_service_session stays READ/REUSE ONLY -- no INSERT/UPDATE/DELETE
//     of any kind, so classification never mutates lifecycle;
//   * same-Business-Day explicit reopen protection is NOT weakened -- the
//     REOPEN_REQUIRED branch survives, and the downgrade fires only on
//     positive evidence of staleness;
//   * F-10 (migration 93, the forgotten-close resolver) is untouched.
//
// The live behavioural matrix (A/B/C/D/E/F/H1/H2) was proven separately
// against real staging inside always-aborted transactions during this
// slice's own apply -- see the migration header and the session report. This
// file is the offline, permanently-replayable half of that proof.
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

const MIG = "migrations/2026-08-19_f11_ensure_stale_business_day_classification.sql";
const ROLLBACK = "migrations/2026-08-19_f11_ensure_stale_business_day_classification.ROLLBACK.sql";
const SRC = read(MIG);
const RB = read(ROLLBACK);

// The function body only, so explanatory prose in the migration header can
// never false-positive a check whose real intent is "no such statement in the
// executable body" -- same technique as f6/f7/f9_1's own static tests.
function functionBody(text, name) {
  const re = new RegExp(
    "CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\." + name + "\\s*\\([^;]*?\\)[\\s\\S]*?\\$function\\$([\\s\\S]*?)\\$function\\$"
  );
  const m = re.exec(text);
  return m ? m[1] : null;
}
const BODY = functionBody(SRC, "ensure_service_session");
const RB_BODY = functionBody(RB, "ensure_service_session");

console.log("\n== A. The migration exists, is transactional, and targets exactly one function ==");
assert("1a: forward migration file exists and is non-trivial", SRC.length > 2000, String(SRC.length));
assert("1b: paired ROLLBACK exists", RB.length > 500, String(RB.length));
assert("1c: wrapped in an explicit transaction", /^BEGIN;$/m.test(SRC) && /^COMMIT;$/m.test(SRC));
assert("1d: the forward migration replaces exactly ONE function", (SRC.match(/CREATE\s+OR\s+REPLACE\s+FUNCTION/g) || []).length === 1);
assert("1e: that function is ensure_service_session", BODY !== null);
assert("1f: it keeps F-7's 2-arg read/reuse-only signature",
  /FUNCTION\s+public\.ensure_service_session\(p_opened_by text, p_source text DEFAULT 'auto_entry'::text\)/.test(SRC));

console.log("\n== B. Canonical Business Day authority is REUSED, never re-derived ==");
assert("2a: the body calls get_order_intake_context_v1", /get_order_intake_context_v1\s*\(\s*\)/.test(BODY));
assert("2b: the predecessor guard refuses if that authority is absent",
  /to_regprocedure\('public\.get_order_intake_context_v1\(\)'\)\s+IS NULL/.test(SRC));
// The whole point of F-11 is to inherit the 04:00 Madrid overnight cutoff for
// free. If the body ever computes a date itself, that inheritance is broken
// and two rules exist again.
assert("2c: the body never names the Madrid timezone itself", !/Europe\/Madrid/.test(BODY));
assert("2d: the body never re-implements the 04:00 cutoff", !/240/.test(BODY));
assert("2e: the body never falls back to a naive CURRENT_DATE/now()::date rule",
  !/CURRENT_DATE/i.test(BODY) && !/now\(\)\s*::\s*date/i.test(BODY));
assert("2f: the body does not reuse open_business_day_v1 (its date rule omits the cutoff)",
  !/open_business_day_v1/.test(BODY));

console.log("\n== C. Still READ/REUSE ONLY -- classification never mutates lifecycle ==");
assert("3a: no INSERT in the body", !/INSERT\s+INTO/i.test(BODY));
assert("3b: no UPDATE in the body", !/\bUPDATE\s+/i.test(BODY));
assert("3c: no DELETE in the body", !/DELETE\s+FROM/i.test(BODY));
assert("3d: never advances the canonical Business Day pointer",
  !/current_business_day_id\s*=/.test(BODY.replace(/IS\s+NULL/g, "")) || !/UPDATE/i.test(BODY));
assert("3e: never touches ticket_epoch", !/ticket_epoch/.test(BODY));
assert("3f: never creates a service (no open_operational_service_v1 call)", !/open_operational_service_v1/.test(BODY));
assert("3g: never runs rollover/forgotten-close recovery",
  !/rolled_over/.test(BODY) && !/FORGOTTEN_CLOSE/.test(BODY));
assert("3h: a post-condition enforces non-mutation after apply",
  /must remain non-mutating/.test(SRC));

console.log("\n== D. Same-day explicit reopen protection is NOT weakened ==");
assert("4a: the REOPEN_REQUIRED branch still exists", /'REOPEN_REQUIRED'/.test(BODY));
assert("4b: the stale downgrade returns NO_OPEN_SERVICE", /'NO_OPEN_SERVICE'[\s\S]*staleBusinessDay/.test(BODY));
// Fail direction: the downgrade must require BOTH dates present AND different.
assert("4c: downgrade requires the pointer date to be present",
  /v_pointer_business_date IS NOT NULL/.test(BODY));
assert("4d: downgrade requires the canonical date to be present",
  /v_canonical_business_date IS NOT NULL/.test(BODY));
assert("4e: downgrade requires the two dates to actually differ",
  /v_pointer_business_date\s*<>\s*v_canonical_business_date/.test(BODY));
assert("4f: every pre-existing typed branch survives verbatim",
  ["INVALID_ACTOR", "MULTIPLE_ACTIVE_SERVICE_SESSIONS", "SERVICE_SESSION_STATE_CORRUPT",
   "SERVICE_SESSION_CLOSING", "REUSED"].every((c) => BODY.includes("'" + c + "'")));
assert("4g: the advisory lock is preserved", /pg_advisory_xact_lock\(hashtext\('service_session_lifecycle'\)\)/.test(BODY));

console.log("\n== E. F-10 / migration 93 is untouched ==");
assert("5a: the forward migration never redefines the F-10 resolver",
  !/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.resolve_order_intake_context_v1/.test(SRC));
assert("5b: it asserts the F-10 resolver still exists, both before and after",
  (SRC.match(/resolve_order_intake_context_v1\(text,text\)'\)\s+IS NULL/g) || []).length >= 2);
assert("5c: it never redefines get_order_intake_context_v1 either",
  !/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.get_order_intake_context_v1/.test(SRC));

console.log("\n== F. Guards: predecessor pinning and ledger position ==");
assert("6a: staging sentinel guard present", /supabase_migrations\.schema_migrations WHERE version='20260710075612'/.test(SRC));
assert("6b: ledger head is pinned to 93 (F-11 becomes 94)", /<>\s*93 THEN/.test(SRC));
assert("6c: predecessor body md5 is pinned", /2c41409d31b3006fa5d01828add45ca6/.test(SRC));
assert("6d: post-conditions verify the new branch actually landed",
  /staleBusinessDay/.test(SRC.split("$function$").pop()));

console.log("\n== G. The ROLLBACK genuinely restores the pre-F-11 contract ==");
assert("7a: rollback restores ensure_service_session", RB_BODY !== null);
assert("7b: the restored body has NO stale-downgrade branch", !/staleBusinessDay/.test(RB_BODY));
assert("7c: the restored body does NOT call the canonical authority", !/get_order_intake_context_v1/.test(RB_BODY));
assert("7d: the restored body still has REOPEN_REQUIRED", /'REOPEN_REQUIRED'/.test(RB_BODY));
assert("7e: rollback refuses if F-11 is not actually installed", /does not contain the F-11 stale downgrade branch/.test(RB));
assert("7f: rollback touches no table/column/trigger",
  !/ALTER\s+TABLE/i.test(RB) && !/DROP\s+(TABLE|COLUMN|TRIGGER)/i.test(RB) && !/CREATE\s+TRIGGER/i.test(RB));

console.log("\n== H. No frontend/JS date authority was introduced anywhere ==");
const ENSURE_JS = read("src/serviceSessions/ensureServiceSession.js");
assert("8a: the JS ensure wrapper still computes no Business Day of its own",
  !/Europe\/Madrid/.test(ENSURE_JS) && !/240/.test(ENSURE_JS));

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
