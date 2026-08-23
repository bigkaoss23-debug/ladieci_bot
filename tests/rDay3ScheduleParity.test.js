"use strict";
// R-DAY3 — SCHEDULE PARITY PROOF.
// (O-1, 2026-08-23 — updated for the 17:30-18:00 order-intake buffer
// removal: canCreateNewOrder's formula simplified from a two-clause
// lunch-or-dinner window to a single overnight-floor check. serviceKind's
// own 17:30 classification cutover is untouched by O-1 and still checked
// below.)
//
// resolve_order_intake_context_v1() and get_order_intake_context_v1()
// (migrations/2026-08-23_o1_order_intake_buffer_removal.sql, superseding
// 2026-08-16_r_day3_business_day_intake_authority.sql's canCreateNewOrder
// formula) restate src/schedule/serviceSchedule.js's DEFAULT_SCHEDULE
// constants in raw SQL, because a PL/pgSQL trigger cannot call into Node.
// This is the drift-risk point the R-DAY3 amendment names as a hard gate
// ("If exact parity cannot be guaranteed: STOP before cutover").
//
// Two independent checks:
//   A. a JS mirror of the exact SQL formula (transcribed verbatim, integer
//      constants only — no reuse of serviceSchedule.js's own arithmetic) is
//      compared against the REAL serviceSchedule.js across every minute of
//      a full day, both at the DST boundary weeks (parity must hold in both
//      CET and CEST, since AT TIME ZONE 'Europe/Madrid' is DST-correct and
//      Intl.DateTimeFormat must agree with it).
//   B. a static check that the SQL file's own literal minute constants
//      (240/480/1050) match DEFAULT_SCHEDULE's minutes exactly, so a
//      future change to one side that forgets the other fails loudly here
//      rather than silently drifting. 1080 (18:00) is no longer an intake
//      gate constant — checked separately as ABSENT from the intake
//      formula (B4 below).
const fs = require("fs");
const path = require("path");
const {
  DEFAULT_SCHEDULE, resolveSchedule, businessDateFor, resolveEconomicPeriod,
} = require("../src/schedule/serviceSchedule");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };

// ── A. SQL formula mirror (verbatim transcription of PART 1/PART 2's logic) ─
function sqlMirror(minutesOfDay, dateStr) {
  const businessDate = minutesOfDay < 240
    ? shiftDate(dateStr, -1)
    : dateStr;
  const serviceKind = (minutesOfDay >= 240 && minutesOfDay < 1050) ? "PRANZO" : "SERA";
  // O-1 — the 17:30-18:00 buffer no longer gates order intake; this now
  // governs only the overnight floor (00:00-08:00). serviceKind above is
  // untouched: the lunch/dinner split stays pure classification/reporting.
  const canCreateNewOrder = (minutesOfDay >= 480);
  return { businessDate, serviceKind, canCreateNewOrder };
}
function shiftDate(dateStr, deltaDays) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

console.log("\n== A. Full-day parity: SQL mirror vs. real serviceSchedule.js ==");
const SAMPLE_DAYS = [
  "2026-08-16", // CEST (summer, matches the live R-DAY3 cutover date)
  "2026-01-15", // CET (winter)
  "2026-03-29", // CEST DST-forward transition week (Europe/Madrid: 2026-03-29)
  "2026-10-25", // CET DST-back transition week (Europe/Madrid: 2026-10-25)
];
let mismatches = 0;
for (const dateStr of SAMPLE_DAYS) {
  for (let minutesOfDay = 0; minutesOfDay < 1440; minutesOfDay += 1) {
    const hh = String(Math.floor(minutesOfDay / 60)).padStart(2, "0");
    const mm = String(minutesOfDay % 60).padStart(2, "0");
    // Construct a real Date at this Madrid wall-clock instant via a fixed
    // known-offset noon anchor, then verify via madridParts-driven functions
    // rather than assuming the offset — resolveSchedule/businessDateFor/
    // resolveEconomicPeriod all derive minutesOfDay from Intl themselves, so
    // we just need *a* real Date whose Madrid wall-clock reads dateStr hh:mm.
    // Use a UTC-noon-anchored search is unnecessary — the schedule module's
    // own now() acceptance only needs Madrid wall time, achieved via `now`
    // constructed from the target Madrid local fields using an approximate
    // UTC offset then corrected by re-checking with madridParts.
    const now = madridWallClockToDate(dateStr, hh, mm);
    const real = resolveSchedule(now, DEFAULT_SCHEDULE);
    const realBusinessDate = businessDateFor(now, DEFAULT_SCHEDULE);
    const realPeriod = resolveEconomicPeriod(now, DEFAULT_SCHEDULE);
    const mirror = sqlMirror(minutesOfDay, dateStr);

    if (mirror.businessDate !== realBusinessDate
        || mirror.serviceKind !== realPeriod.serviceKind
        || mirror.canCreateNewOrder !== real.canCreateNewOrder) {
      mismatches++;
      if (mismatches <= 5) {
        console.log(`  FAIL  parity @ ${dateStr} ${hh}:${mm} -> mirror=${JSON.stringify(mirror)} real={businessDate:${realBusinessDate},serviceKind:${realPeriod.serviceKind},canCreateNewOrder:${real.canCreateNewOrder}}`);
      }
    }
  }
}
assert("A: zero mismatches across 4 full days (4*1440=5760 minute-samples, incl. both DST transition weeks)", mismatches === 0, `${mismatches} mismatches`);

// Resolve a Madrid local wall-clock time to a real Date, correcting for the
// actual UTC offset at that instant (handles DST without hardcoding it).
function madridWallClockToDate(dateStr, hh, mm) {
  let guess = new Date(`${dateStr}T${hh}:${mm}:00Z`);
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(guess).reduce((o, p) => (p.type !== "literal" && (o[p.type] = p.value), o), {});
    const observedMin = (Number(parts.hour) % 24) * 60 + Number(parts.minute);
    const observedDate = `${parts.year}-${parts.month}-${parts.day}`;
    const targetMin = Number(hh) * 60 + Number(mm);
    const dayDelta = observedDate === dateStr ? 0 : (observedDate < dateStr ? 1 : -1);
    const diffMin = (targetMin - observedMin) + dayDelta * 1440;
    if (diffMin === 0) break;
    guess = new Date(guess.getTime() + diffMin * 60000);
  }
  return guess;
}

console.log("\n== B. Static constant parity: SQL literal minutes vs. DEFAULT_SCHEDULE ==");
const SQL_RAW = fs.readFileSync(
  path.join(__dirname, "..", "migrations", "2026-08-23_o1_order_intake_buffer_removal.sql"),
  "utf8",
);
// Scoped to the two ACTUAL function bodies only (between $function$
// delimiters), excluding this file's own predecessor-guard and post-
// condition DO blocks, which legitimately reference both the OLD formula
// (as a drift check) and the NEW one (as a string literal to assert against
// prosrc) — a plain text scan of the whole file would false-positive on
// those checks themselves.
const FUNCTION_BODIES = (SQL_RAW.match(/AS \$function\$([\s\S]*?)\$function\$/g) || []).join("\n");
const SQL = FUNCTION_BODIES;
assert("B1: rolloverMin (04:00=240) appears as the < 240 businessDate boundary",
  DEFAULT_SCHEDULE.rolloverMin === 240 && /v_minutes_of_day < 240/.test(SQL));
assert("B2: lunchEnsureStartMin (08:00=480) appears as the canCreateNewOrder lower bound",
  DEFAULT_SCHEDULE.lunchEnsureStartMin === 480 && /v_can_create_order := \(v_minutes_of_day >= 480\)/.test(SQL));
assert("B3: lunchBoundaryMin (17:30=1050) still appears as the lunch/dinner classification split (unchanged by O-1)",
  DEFAULT_SCHEDULE.lunchBoundaryMin === 1050 && (SQL.match(/< 1050/g) || []).length >= 2);
assert("B4: dinnerEnsureStartMin (18:00=1080) is GONE from the intake formula — O-1's whole point",
  DEFAULT_SCHEDULE.dinnerEnsureStartMin === 1080 && !/v_can_create_order[^;]*1080/.test(SQL) && !/v_minutes_of_day >= 1080/.test(SQL));
assert("B5: both resolve_order_intake_context_v1 and get_order_intake_context_v1 contain the simplified formula",
  (SQL.match(/v_can_create_order := \(v_minutes_of_day >= 480\);/g) || []).length === 2);

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
