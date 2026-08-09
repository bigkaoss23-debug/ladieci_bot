"use strict";
// ===============================================================
// v3NextServiceIdentity.js — SERVICE LIFECYCLE V3 / Slice 3.4
//
// THE single deterministic rule for "given a closed service A, what should
// the next current service B be, right now?" Pure: same `now`, same
// schedule, same answer, no DB access.
//
// Deliberately thin — the actual calendar/window authority is
// src/schedule/serviceSchedule.js's resolveSchedule() (already the
// project-wide single source of truth for "which service is it now?", see
// that file's own header). This module does not duplicate a single window
// boundary; it only translates that answer into the yes/no + identity shape
// the V3 rollover engine needs.
//
// THE POLICY (Step 12 of the V3.4 spec): "what should B be" is always
// "whatever the schedule says should be current AT THE ACTUAL CURRENT WALL-
// CLOCK TIME" — never a missed-boundary catch-up loop, never a guess at what
// SHOULD have happened while A sat stale. If `now` falls in a window where
// no service should be current (the 17:30-18:00 buffer, the 00:00-08:00
// overnight span), the correct next service is NONE — shouldEnsure:false is
// a complete, legitimate outcome, not a deferred failure. This is also
// exactly what already happens today the instant close_service_session_v3
// runs (it unconditionally sets current_session_id = NULL) — this function
// only decides whether anything should immediately replace that NULL.
// ===============================================================

const { resolveSchedule, DEFAULT_SCHEDULE } = require("../schedule/serviceSchedule");

// deriveNextServiceIdentity(now, schedule) -> { shouldEnsure, serviceKind, businessDate }
// shouldEnsure:false means "correctly, nothing should be opened right now" —
// serviceKind is null in that case; businessDate is still returned (the
// schedule always knows the operational date, even between services).
function deriveNextServiceIdentity(now = new Date(), schedule = DEFAULT_SCHEDULE) {
  const resolved = resolveSchedule(now, schedule);
  if (!resolved.canEnsureSession || !resolved.expectedServiceKind) {
    return { shouldEnsure: false, serviceKind: null, businessDate: resolved.businessDate };
  }
  return { shouldEnsure: true, serviceKind: resolved.expectedServiceKind, businessDate: resolved.businessDate };
}

module.exports = { deriveNextServiceIdentity };
