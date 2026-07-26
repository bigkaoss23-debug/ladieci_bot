"use strict";
// S2-7D6B — the schedule resolver. Pure, so every boundary and both DST sides
// are provable without a clock, a database or a deploy.
const S = require("../src/schedule/serviceSchedule");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };

// Madrid wall-clock helper: build the UTC instant that IS the given Madrid time.
// CEST = UTC+2 (summer), CET = UTC+1 (winter).
const summer = (h, m = 0, day = 15) => new Date(Date.UTC(2026, 6, day, h - 2, m)); // July
const winter = (h, m = 0, day = 15) => new Date(Date.UTC(2026, 0, day, h - 1, m)); // January

const state = (d) => S.resolveSchedule(d).state;
const kind = (d) => S.resolveSchedule(d).serviceKind;

console.log("\n══ A. window boundaries (summer, CEST) ══");
assert("07:59 → OUTSIDE_WINDOWS", state(summer(7, 59)) === S.SCHEDULE_STATE.OUTSIDE_WINDOWS);
assert("08:00 → PRANZO_WINDOW (inclusive)", state(summer(8, 0)) === S.SCHEDULE_STATE.PRANZO_WINDOW);
assert("12:00 → PRANZO_WINDOW", state(summer(12)) === S.SCHEDULE_STATE.PRANZO_WINDOW);
assert("17:29 → PRANZO_WINDOW", state(summer(17, 29)) === S.SCHEDULE_STATE.PRANZO_WINDOW);
assert("17:30 → BETWEEN_SERVICES (exclusive end)", state(summer(17, 30)) === S.SCHEDULE_STATE.BETWEEN_SERVICES);
assert("17:59 → BETWEEN_SERVICES", state(summer(17, 59)) === S.SCHEDULE_STATE.BETWEEN_SERVICES);
assert("18:00 → SERA_WINDOW (inclusive)", state(summer(18, 0)) === S.SCHEDULE_STATE.SERA_WINDOW);
assert("23:50 → SERA_WINDOW (a 23:50 order is normal)", state(summer(23, 50)) === S.SCHEDULE_STATE.SERA_WINDOW);
assert("23:59 → SERA_WINDOW", state(summer(23, 59)) === S.SCHEDULE_STATE.SERA_WINDOW);
assert("00:00 → AFTER_ORDER_CUTOFF", state(summer(0, 0, 16)) === S.SCHEDULE_STATE.AFTER_ORDER_CUTOFF);
assert("03:59 → AFTER_ORDER_CUTOFF", state(summer(3, 59, 16)) === S.SCHEDULE_STATE.AFTER_ORDER_CUTOFF);
assert("04:00 → OUTSIDE_WINDOWS (rollover)", state(summer(4, 0, 16)) === S.SCHEDULE_STATE.OUTSIDE_WINDOWS);

console.log("\n══ B. ensure permission ══");
assert("lunch may ensure", S.resolveSchedule(summer(12)).canEnsureSession === true);
assert("dinner may ensure", S.resolveSchedule(summer(20)).canEnsureSession === true);
assert("BUFFER may NOT ensure", S.resolveSchedule(summer(17, 45)).canEnsureSession === false);
assert("after cutoff may NOT ensure", S.resolveSchedule(summer(1, 0, 16)).canEnsureSession === false);
assert("outside windows may NOT ensure", S.resolveSchedule(summer(6)).canEnsureSession === false);
assert("lunch kind is PRANZO", kind(summer(12)) === "PRANZO");
assert("dinner kind is SERA", kind(summer(20)) === "SERA");
assert("BUFFER has NO kind (never guess)", kind(summer(17, 45)) === null);
assert("expectedServiceKind null in buffer", S.expectedServiceKind(summer(17, 45)) === null);
assert("canonical result carries expectedServiceKind inline too", S.resolveSchedule(summer(12)).expectedServiceKind === "PRANZO");
assert("expectedServiceKind inline is null outside an ensure window", S.resolveSchedule(summer(17, 45)).expectedServiceKind === null);

console.log("\n══ C. order intake — canCreateNewOrder is the ONE decision every consumer reads ══");
assert("23:50 accepts new orders", S.resolveSchedule(summer(23, 50)).canCreateNewOrder === true);
assert("00:00 stops new orders", S.resolveSchedule(summer(0, 0, 16)).canCreateNewOrder === false);
// S2-7D6B3 — CORRECTED: the buffer accepts NO brand-new order of either kind,
// even if a lunch session is still technically open. An order already created
// before 17:30 is not new intake and keeps moving under canContinueExistingOrders
// — see section E below. The previous "lunch stragglers" exception documented
// here (and asserted true) silently contradicted the approved product policy
// and has been removed, not layered over.
assert("buffer accepts NO brand-new order (no stragglers exception)", S.resolveSchedule(summer(17, 45)).canCreateNewOrder === false);
assert("PRANZO_WINDOW accepts new orders", S.resolveSchedule(summer(12)).canCreateNewOrder === true);
assert("AFTER_ORDER_CUTOFF accepts no new orders", S.resolveSchedule(summer(1, 0, 16)).canCreateNewOrder === false);
assert("OUTSIDE_WINDOWS accepts no new orders", S.resolveSchedule(summer(6)).canCreateNewOrder === false);

console.log("\n══ D. escalation ══");
assert("00:30 close attempt due, no escalation", S.resolveSchedule(summer(0, 30, 16)).canAttemptClose === true && S.resolveSchedule(summer(0, 30, 16)).isEscalationBoundary === false);
assert("04:30 escalates", S.resolveSchedule(summer(4, 30, 16)).isEscalationBoundary === true);
assert("20:00 does not escalate", S.resolveSchedule(summer(20)).isEscalationBoundary === false);

console.log("\n══ D2. canContinueExistingOrders — never gated by the clock ══");
assert("true during PRANZO_WINDOW", S.resolveSchedule(summer(12)).canContinueExistingOrders === true);
assert("true during BETWEEN_SERVICES", S.resolveSchedule(summer(17, 45)).canContinueExistingOrders === true);
assert("true during SERA_WINDOW", S.resolveSchedule(summer(20)).canContinueExistingOrders === true);
assert("true during AFTER_ORDER_CUTOFF (a delivery at 00:30 is still valid)", S.resolveSchedule(summer(0, 30, 16)).canContinueExistingOrders === true);
assert("true during OUTSIDE_WINDOWS (never blindly destroy active work)", S.resolveSchedule(summer(6)).canContinueExistingOrders === true);

console.log("\n══ E. business date / 04:00 rollover ══");
assert("20:00 on the 15th → 2026-07-15", S.businessDateFor(summer(20)) === "2026-07-15");
assert("01:30 on the 16th → still 2026-07-15", S.businessDateFor(summer(1, 30, 16)) === "2026-07-15");
assert("03:59 on the 16th → still 2026-07-15", S.businessDateFor(summer(3, 59, 16)) === "2026-07-15");
assert("04:00 on the 16th → 2026-07-16", S.businessDateFor(summer(4, 0, 16)) === "2026-07-16");
assert("12:00 lunch → same day", S.businessDateFor(summer(12)) === "2026-07-15");

console.log("\n══ F. DST — winter (CET, UTC+1) ══");
assert("winter 12:00 → PRANZO_WINDOW", state(winter(12)) === S.SCHEDULE_STATE.PRANZO_WINDOW);
assert("winter 17:30 → BETWEEN_SERVICES", state(winter(17, 30)) === S.SCHEDULE_STATE.BETWEEN_SERVICES);
assert("winter 18:00 → SERA_WINDOW", state(winter(18)) === S.SCHEDULE_STATE.SERA_WINDOW);
assert("winter 01:00 on the 16th → business date 2026-01-15", S.businessDateFor(winter(1, 0, 16)) === "2026-01-15");
assert("winter 08:00 → PRANZO (not shifted by an assumed +02:00)", state(winter(8)) === S.SCHEDULE_STATE.PRANZO_WINDOW);
// The old code assumed CEST year-round. Prove the resolver reads the real zone.
assert("winter 07:00 UTC is 08:00 Madrid", S.madridParts(new Date(Date.UTC(2026, 0, 15, 7, 0))).hour === 8);
assert("summer 07:00 UTC is 09:00 Madrid", S.madridParts(new Date(Date.UTC(2026, 6, 15, 7, 0))).hour === 9);

console.log("\n══ G. close eligibility (replaces the flat 22:00 rule) ══");
assert("PRANZO cannot close at 12:00", S.closeEligibility("PRANZO", summer(12)).eligible === false);
assert("PRANZO CAN close at 17:30 (was impossible before)", S.closeEligibility("PRANZO", summer(17, 30)).eligible === true);
assert("PRANZO can still close at 20:00 (forgotten lunch)", S.closeEligibility("PRANZO", summer(20)).eligible === true);
assert("SERA cannot close at 23:50", S.closeEligibility("SERA", summer(23, 50)).eligible === false);
assert("SERA can close at 00:00", S.closeEligibility("SERA", summer(0, 0, 16)).eligible === true);
assert("SERA can close at 04:30", S.closeEligibility("SERA", summer(4, 30, 16)).eligible === true);
assert("legacy kind keeps the 22:00 rule", S.closeEligibility(null, summer(21)).eligible === false && S.closeEligibility(null, summer(22)).eligible === true);

console.log("\n══ H. closed weekdays are NOT invented ══");
assert("closedWeekdays is empty", S.DEFAULT_SCHEDULE.closedWeekdays.length === 0);
assert("a Monday lunch still resolves normally", state(summer(12, 0, 13)) === S.SCHEDULE_STATE.PRANZO_WINDOW);

console.log("\n══ I. purity / overridability ══");
const custom = { ...S.DEFAULT_SCHEDULE, lunchEnsureStartMin: S.HM(11) };
assert("a custom schedule is honoured (future restaurant_profile)", S.resolveSchedule(summer(9), custom).state === S.SCHEDULE_STATE.OUTSIDE_WINDOWS);
assert("same input twice → same output", JSON.stringify(S.resolveSchedule(summer(12))) === JSON.stringify(S.resolveSchedule(summer(12))));
assert("result is frozen", Object.isFrozen(S.resolveSchedule(summer(12))));

console.log("");
console.log("=== RESULT: " + pass + " passed, " + fail + " failed ===");
process.exit(fail === 0 ? 0 : 1);
