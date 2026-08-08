"use strict";
// S2-7D6D — the shared auto-close decision. Pure, so every boundary, both DST
// sides and both service kinds are provable without a clock, a database or a
// deploy. This is the direct behavioral test the S2-7D6B audit flagged as
// missing: nothing previously drove serviceCloseDecision/serviceCloseTick with
// an injected `now` and a fabricated session.
const { computeAutoCloseDecision } = require("../src/serviceSessions/autoCloseDecision");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };

const summer = (h, m = 0, day = 15) => new Date(Date.UTC(2026, 6, day, h - 2, m)); // July, CEST
const winter = (h, m = 0, day = 15) => new Date(Date.UTC(2026, 0, day, h - 1, m)); // January, CET

const session = (over = {}) => ({ id: "s1", status: "open", service_kind: "PRANZO", ...over });

console.log("\n══ A. SERA — before/after cutoff ══");
{
  const r1 = computeAutoCloseDecision({ now: summer(23, 50), session: session({ service_kind: "SERA" }) });
  assert("SERA before 00:00 cutoff -> not due", r1.due === false, JSON.stringify(r1));

  const r2 = computeAutoCloseDecision({ now: summer(0, 5, 16), session: session({ service_kind: "SERA" }) });
  assert("SERA after 00:00 cutoff -> due", r2.due === true, JSON.stringify(r2));
  assert("SERA due -> source cron_dinner", r2.source === "cron_dinner");
}

console.log("\n══ B. PRANZO — before/after cutoff ══");
{
  const r1 = computeAutoCloseDecision({ now: summer(12, 0), session: session({ service_kind: "PRANZO" }) });
  assert("PRANZO before 17:30 cutoff -> not due", r1.due === false, JSON.stringify(r1));

  const r2 = computeAutoCloseDecision({ now: summer(17, 35), session: session({ service_kind: "PRANZO" }) });
  assert("PRANZO after 17:30 cutoff -> due", r2.due === true, JSON.stringify(r2));
  assert("PRANZO due -> source cron_lunch", r2.source === "cron_lunch");

  const r3 = computeAutoCloseDecision({ now: summer(20, 0), session: session({ service_kind: "PRANZO" }) });
  assert("a forgotten PRANZO stays closable during SERA hours -> due", r3.due === true, JSON.stringify(r3));
}

console.log("\n══ C. session status guards ══");
{
  const r1 = computeAutoCloseDecision({ now: summer(20, 0), session: null });
  assert("no session -> not due (no_active_session)", r1.due === false && r1.reason === "no_active_session");

  const r2 = computeAutoCloseDecision({ now: summer(20, 0), session: session({ status: "closed" }) });
  assert("already-closed session -> not due (not_active), no-op", r2.due === false && r2.reason === "not_active");

  const r3 = computeAutoCloseDecision({ now: summer(20, 0), session: session({ status: "closing" }) });
  assert("mid-close ('closing') session is still a valid target", r3.due === true);
}

console.log("\n══ D. repeated calls are idempotent (pure, no side effects) ══");
{
  const now = summer(20, 0);
  const s = session({ service_kind: "PRANZO" });
  const a = computeAutoCloseDecision({ now, session: s });
  const b = computeAutoCloseDecision({ now, session: s });
  assert("same input twice -> same output", JSON.stringify(a) === JSON.stringify(b));
}

console.log("\n══ E. escalation boundary (04:00) ══");
{
  const r = computeAutoCloseDecision({ now: summer(4, 30, 16), session: session({ service_kind: "SERA" }) });
  assert("SERA still open past 04:00 -> due AND escalate", r.due === true && r.escalate === true, JSON.stringify(r));
  const r2 = computeAutoCloseDecision({ now: summer(20, 0), session: session({ service_kind: "PRANZO" }) });
  assert("normal PRANZO close is not an escalation", r2.due === true && r2.escalate === false);
}

console.log("\n══ F. timezone / DST parity with serviceSchedule ══");
{
  const rSummer = computeAutoCloseDecision({ now: summer(18, 0), session: session({ service_kind: "PRANZO" }) });
  const rWinter = computeAutoCloseDecision({ now: winter(18, 0), session: session({ service_kind: "PRANZO" }) });
  assert("CEST 18:00 -> due (past 17:30 lunch boundary)", rSummer.due === true);
  assert("CET 18:00 -> due (same Madrid wall-clock, different UTC offset)", rWinter.due === true);
}

console.log("\n══ G. SERVICE CLOSEOUT V2 / Slice 3 — RC-1 fix: PRIOR_DAY_STALE is due regardless of today's window ══");
{
  // A PRANZO session opened YESTERDAY, evaluated at 10:00 TODAY — squarely
  // inside PRANZO's own "too early to close" window if judged as today's
  // lunch (closeEligibility('PRANZO', 10:00) would say not-eligible). Before
  // this fix, a caller that (unlike this one) never separately checked
  // business_date would see due:false and never reconcile the stale session.
  const staleLunch = session({ service_kind: "PRANZO", business_date: "2026-07-14" });
  const r1 = computeAutoCloseDecision({ now: summer(10, 0, 15), session: staleLunch });
  assert("G1: yesterday's PRANZO at 10:00 today is due (RC-1 fixed)", r1.due === true, JSON.stringify(r1));
  assert("G1: source is the stale-rollover source, not the ordinary cron_lunch", r1.source === "cron_stale_rollover");
  assert("G1: always escalated — a stale session is inherently an anomaly worth flagging loudly", r1.escalate === true);
  assert("G1: classification is attached and says PRIOR_DAY_STALE", r1.classification && r1.classification.type === "PRIOR_DAY_STALE");

  // Same stale session at a time where PRANZO's OWN window would ALSO say
  // eligible (20:00) — must still report the SAME due:true, via the SAME
  // stale path, not by coincidentally agreeing with closeEligibility.
  const r2 = computeAutoCloseDecision({ now: summer(20, 0, 15), session: staleLunch });
  assert("G2: same stale session at a different time of day -> still due via the stale path", r2.due === true && r2.source === "cron_stale_rollover", JSON.stringify(r2));

  // A session from TODAY (matching business date) must be completely
  // unaffected by this new branch — this is the regression guard against
  // ever widening PRIOR_DAY_STALE by accident.
  const todaySession = session({ service_kind: "PRANZO", business_date: "2026-07-15" });
  const r3 = computeAutoCloseDecision({ now: summer(12, 0, 15), session: todaySession });
  assert("G3: a session dated TODAY is unaffected — ordinary not-due-yet logic still applies", r3.due === false && r3.reason === "PRANZO_CLOSE_TOO_EARLY", JSON.stringify(r3));
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
