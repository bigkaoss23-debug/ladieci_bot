"use strict";
// ===============================================================
// sessionRolloverClassification.js — SERVICE CLOSEOUT V2 / Slice 3
//
// Fixes RC-1 (PRIOR_DAY_STALE_SESSION_BLOCKED_BY_CURRENT_DAY_SCHEDULE_GATE):
// closeEligibility(kind, now) answers "is THIS kind's own daily window open
// right now", which is a question about the CLOCK, never about which day the
// session in front of it actually belongs to. A PRANZO session opened
// yesterday, evaluated today before 17:30, gets exactly the same
// PRANZO_CLOSE_TOO_EARLY answer a genuinely fresh, on-time lunch would — the
// session's own business_date is never consulted. classifySessionForRollover
// is the missing precedence check: it compares session.business_date against
// TODAY's effective business date FIRST, and only asks closeEligibility once
// it already knows the session belongs to today.
//
// Pure: same (session, now, schedule) in, same classification out. No DB, no
// clock read beyond the `now` handed in.
// ===============================================================

const { DEFAULT_SCHEDULE, resolveSchedule, closeEligibility } = require("../schedule/serviceSchedule");

const ROLLOVER_CLASSIFICATION = Object.freeze({
  CURRENT_VALID: "CURRENT_VALID",
  SAME_DAY_TRANSITION_DUE: "SAME_DAY_TRANSITION_DUE",
  PRIOR_DAY_STALE: "PRIOR_DAY_STALE",
  FUTURE_DATED_INVALID: "FUTURE_DATED_INVALID",
  MISSING: "MISSING",
  INTEGRITY_ERROR: "INTEGRITY_ERROR",
});

// classifySessionForRollover — the ONLY place business-date precedence is
// decided. Every caller that needs to know "is this session due for
// automatic/required rollover" asks this FIRST, before ever touching
// closeEligibility directly on a possibly-stale session.
//
//   PRIOR_DAY_STALE     — session.business_date < today's effective business
//                          date. NEVER consults closeEligibility: today's
//                          schedule window is irrelevant to whether yesterday
//                          (or any earlier day) is stale. Always due.
//   FUTURE_DATED_INVALID — session.business_date > today's effective business
//                          date. Should not occur in normal operation
//                          (ensure_service_session derives business_date from
//                          the clock, never from a caller); reported as its
//                          own classification rather than silently folded
//                          into "current valid" so an integrity problem is
//                          never mistaken for a healthy session.
//   SAME_DAY_TRANSITION_DUE — same business date, and this kind's OWN
//                          closeEligibility window has arrived (e.g. a PRANZO
//                          session once 17:30 has passed). Due.
//   CURRENT_VALID        — same business date, still inside this kind's
//                          normal operating window. Not due.
//   MISSING              — no session at all.
//   INTEGRITY_ERROR       — a session exists but is missing business_date or
//                          service_kind, so no classification is possible.
function classifySessionForRollover(session, now = new Date(), schedule = DEFAULT_SCHEDULE) {
  if (!session) {
    return { type: ROLLOVER_CLASSIFICATION.MISSING };
  }
  if (!session.business_date || !session.service_kind) {
    return {
      type: ROLLOVER_CLASSIFICATION.INTEGRITY_ERROR,
      reason: "session missing business_date or service_kind",
    };
  }

  const when = resolveSchedule(now, schedule);
  const effectiveBusinessDate = when.businessDate;

  if (session.business_date > effectiveBusinessDate) {
    return {
      type: ROLLOVER_CLASSIFICATION.FUTURE_DATED_INVALID,
      sessionBusinessDate: session.business_date,
      effectiveBusinessDate,
    };
  }
  if (session.business_date < effectiveBusinessDate) {
    // Deliberately does NOT call closeEligibility — see file header.
    return {
      type: ROLLOVER_CLASSIFICATION.PRIOR_DAY_STALE,
      sessionBusinessDate: session.business_date,
      effectiveBusinessDate,
    };
  }

  const gate = closeEligibility(session.service_kind, now, schedule);
  if (gate.eligible) {
    return {
      type: ROLLOVER_CLASSIFICATION.SAME_DAY_TRANSITION_DUE,
      sessionBusinessDate: session.business_date,
      effectiveBusinessDate,
      gate,
    };
  }
  return {
    type: ROLLOVER_CLASSIFICATION.CURRENT_VALID,
    sessionBusinessDate: session.business_date,
    effectiveBusinessDate,
    gate,
  };
}

// Convenience the two call sites (autoCloseDecision.js, ensureServiceSession.js)
// both need: is a rollover attempt due AT ALL, regardless of pending activity?
function isRolloverDue(classification) {
  return !!classification
    && (classification.type === ROLLOVER_CLASSIFICATION.PRIOR_DAY_STALE
      || classification.type === ROLLOVER_CLASSIFICATION.SAME_DAY_TRANSITION_DUE);
}

module.exports = { ROLLOVER_CLASSIFICATION, classifySessionForRollover, isRolloverDue };
