// src/core/delivery/plannerClock.js
// ===============================================================
// PORT-55 — the planner preview actions' clock, expressed in the Mesa line's
// OWN calendar.
//
// WHY THIS FILE EXISTS. The premium planner actions were written against the
// V1 planner line, where `src/utils/servizio.js` exported `nowMadridHHMM` and
// `serviceDateMadrid`. Neither export survives on this line: the Lifecycle/V3
// refactor moved every "what day is it, operationally" question into
// `src/schedule/serviceSchedule.js`, whose `businessDateFor()` is the SAME
// authority the DB uses for `service_sessions.business_date`.
//
// The two calendars are NOT the same. The old `serviceDateMadrid` shifted the
// clock back six hours, i.e. it rolled the service day at 06:00 Madrid. This
// line's Business Day rolls at 04:00 (`DEFAULT_SCHEDULE.rolloverMin`), and that
// boundary is enforced in the database, not just in JS.
//
// Restoring the old 06:00 shift here would have planted a SECOND, conflicting
// definition of "which day is this order on" inside a system whose whole
// economic model depends on there being exactly one. So the port deliberately
// adopts the 04:00 authority instead of the donor's 06:00 one. The only window
// where the two disagree is 04:00-05:59 Madrid, when the restaurant is closed.
//
// Pure: no Date.now(), no hidden clock. Callers pass the instant or accept
// `new Date()` at the boundary, exactly as the donor helpers did.

"use strict";

const { madridParts, businessDateFor, DEFAULT_SCHEDULE } = require("../../schedule/serviceSchedule");

// Current Madrid wall clock as "HH:MM" (h23 — never "24:00"). Null if Intl is
// unavailable, matching the donor helper's contract, which several planner
// modules branch on.
function nowMadridHHMM(d = new Date(), schedule = DEFAULT_SCHEDULE) {
  try {
    const p = madridParts(d instanceof Date ? d : new Date(d), schedule.timezone);
    if (p == null || p.hour == null || p.minute == null) return null;
    return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  } catch (_) {
    return null;
  }
}

// The operational date the planner snapshot should be read for — this line's
// Business Day (04:00 rollover), NOT the donor's 06:00 service day.
function plannerBusinessDate(d = new Date(), schedule = DEFAULT_SCHEDULE) {
  return businessDateFor(d instanceof Date ? d : new Date(d), schedule);
}

module.exports = { nowMadridHHMM, plannerBusinessDate };
