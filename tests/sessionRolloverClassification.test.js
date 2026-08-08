"use strict";
// SERVICE CLOSEOUT V2 / Slice 3 — pure taxonomy tests for
// classifySessionForRollover (fixes RC-1:
// PRIOR_DAY_STALE_SESSION_BLOCKED_BY_CURRENT_DAY_SCHEDULE_GATE). The
// critical assertion running through every PRIOR_DAY_STALE case is that
// classification is due WITHOUT ever having consulted today's
// closeEligibility window for the stale session's kind.

const { ROLLOVER_CLASSIFICATION, classifySessionForRollover, isRolloverDue } = require("../src/serviceSessions/sessionRolloverClassification");
const { DEFAULT_SCHEDULE } = require("../src/schedule/serviceSchedule");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };

const summer = (h, m = 0, day = 15) => new Date(Date.UTC(2026, 6, day, h - 2, m));

(async () => {
  console.log("\n== classifySessionForRollover ==\n");

  console.log("── MISSING / INTEGRITY_ERROR ──");
  {
    assert("1a: no session -> MISSING", classifySessionForRollover(null, summer(12, 0)).type === ROLLOVER_CLASSIFICATION.MISSING);
    assert("1b: missing business_date -> INTEGRITY_ERROR", classifySessionForRollover({ service_kind: "PRANZO" }, summer(12, 0)).type === ROLLOVER_CLASSIFICATION.INTEGRITY_ERROR);
    assert("1c: missing service_kind -> INTEGRITY_ERROR", classifySessionForRollover({ business_date: "2026-07-15" }, summer(12, 0)).type === ROLLOVER_CLASSIFICATION.INTEGRITY_ERROR);
  }

  console.log("\n── CURRENT_VALID — same business date, still inside the window ──");
  {
    // At 12:00 Madrid on 2026-07-15, effective business date is 2026-07-15
    // (well past the 04:00 rollover). PRANZO's own window has not yet reached
    // its 17:30 close boundary.
    const session = { business_date: "2026-07-15", service_kind: "PRANZO" };
    const c = classifySessionForRollover(session, summer(12, 0));
    assert("2a: today's PRANZO at noon is CURRENT_VALID", c.type === ROLLOVER_CLASSIFICATION.CURRENT_VALID, JSON.stringify(c));
    assert("2b: not due for rollover", isRolloverDue(c) === false);
  }

  console.log("\n── SAME_DAY_TRANSITION_DUE — same business date, kind's own window has arrived ──");
  {
    const session = { business_date: "2026-07-15", service_kind: "PRANZO" };
    const c = classifySessionForRollover(session, summer(18, 0)); // past 17:30
    assert("3a: today's PRANZO after 17:30 is SAME_DAY_TRANSITION_DUE", c.type === ROLLOVER_CLASSIFICATION.SAME_DAY_TRANSITION_DUE, JSON.stringify(c));
    assert("3b: due for rollover", isRolloverDue(c) === true);
  }

  console.log("\n── PRIOR_DAY_STALE — the RC-1 case: must NOT depend on today's closeEligibility ──");
  {
    // A PRANZO session opened YESTERDAY, evaluated at 10:00 today — squarely
    // inside PRANZO's own "too early to close" window if judged as if it were
    // today's lunch. Real closeEligibility('PRANZO', 10:00) would say
    // eligible:false (PRANZO_CLOSE_TOO_EARLY). The classifier must still say
    // PRIOR_DAY_STALE, and it must say so WITHOUT that gate ever mattering.
    const staleSession = { business_date: "2026-07-14", service_kind: "PRANZO" };
    const c = classifySessionForRollover(staleSession, summer(10, 0, 15));
    assert("4a: yesterday's PRANZO at 10:00 today is PRIOR_DAY_STALE (RC-1 fixed)", c.type === ROLLOVER_CLASSIFICATION.PRIOR_DAY_STALE, JSON.stringify(c));
    assert("4b: no `gate` field is attached — closeEligibility was never consulted", !("gate" in c), JSON.stringify(c));
    assert("4c: due for rollover, unconditionally", isRolloverDue(c) === true);

    // Same stale PRANZO, but now evaluated at 20:00 (SERA_WINDOW) — a time
    // where PRANZO's OWN closeEligibility would say eligible:true anyway. The
    // classification must be identical (PRIOR_DAY_STALE), proving the
    // precedence rule holds regardless of what today's clock happens to be.
    const c2 = classifySessionForRollover(staleSession, summer(20, 0, 15));
    assert("4d: same stale session at a DIFFERENT time of day is still PRIOR_DAY_STALE, not SAME_DAY_TRANSITION_DUE", c2.type === ROLLOVER_CLASSIFICATION.PRIOR_DAY_STALE, JSON.stringify(c2));

    // A stale SERA session, evaluated at 10:00 the next day. SERA's own
    // closeEligibility would ALSO say eligible:true at 10:00 (OUTSIDE_WINDOWS
    // is a valid close-attempt state) — but must still classify as
    // PRIOR_DAY_STALE via business-date precedence, not by accidentally
    // agreeing with closeEligibility for the wrong reason.
    const staleSera = { business_date: "2026-07-14", service_kind: "SERA" };
    const c3 = classifySessionForRollover(staleSera, summer(10, 0, 15));
    assert("4e: yesterday's SERA at 10:00 today is PRIOR_DAY_STALE", c3.type === ROLLOVER_CLASSIFICATION.PRIOR_DAY_STALE, JSON.stringify(c3));
  }

  console.log("\n── the 04:00 rollover boundary is respected — 'yesterday' before 04:00 is NOT stale yet ──");
  {
    // At 00:05 on July 16, the service day has not rolled over (rolloverMin
    // is 04:00) — the EFFECTIVE business date is still July 15. A session
    // opened July 15 is therefore CURRENT_VALID/SAME_DAY_TRANSITION_DUE, not
    // PRIOR_DAY_STALE, at this instant.
    const session = { business_date: "2026-07-15", service_kind: "SERA" };
    const c = classifySessionForRollover(session, summer(0, 5, 16));
    assert("5: 00:05 the next calendar day is still the SAME business day (04:00 rollover) -> not stale", c.type !== ROLLOVER_CLASSIFICATION.PRIOR_DAY_STALE, JSON.stringify(c));
  }

  console.log("\n── FUTURE_DATED_INVALID — should not occur in normal operation, but must be its own classification ──");
  {
    const session = { business_date: "2026-07-16", service_kind: "PRANZO" };
    const c = classifySessionForRollover(session, summer(12, 0, 15));
    assert("6a: a session dated tomorrow is FUTURE_DATED_INVALID", c.type === ROLLOVER_CLASSIFICATION.FUTURE_DATED_INVALID, JSON.stringify(c));
    assert("6b: never treated as due for rollover", isRolloverDue(c) === false);
  }

  console.log("\n=== RESULT: " + pass + " passed, " + fail + " failed ===");
  process.exit(fail === 0 ? 0 : 1);
})();
