// src/core/delivery/operationalScopePort.js
// ===============================================================
// OperationalScopePort — read-only boundary for "which service sessions /
// which Business Day is the planner allowed to reason about right now"
// (TB-2 §10, semantic follow-up to the local-only fix in 0b615fc).
//
// 0b615fc scoped the legacy previewOrderTiming read correctly, but on ANY
// resolution failure it fell back to `activeOrders = []`, which downstream
// reads as "no active deliveries" -> "no conflict" — a silent false-clean
// result indistinguishable from a genuinely quiet board. This port fixes
// that failure mode instead of copying it: a resolution failure comes back
// as `{ available: false }`, which timingAssessmentV3 turns into
// `degraded: true` + SCOPE_UNAVAILABLE — visibly untrustworthy, never a
// quiet NONE.
//
// Reuses the existing operational-session authority (getOperationalSessionIds)
// and the existing planner Business Day clock (plannerClock.plannerBusinessDate)
// — no new raw reader, no new writer, no session-management change.
// ===============================================================
"use strict";

async function resolveOperationalScope({ getOperationalSessionIds, select, now, plannerBusinessDate } = {}) {
  if (typeof getOperationalSessionIds !== "function" || typeof plannerBusinessDate !== "function") {
    return { available: false };
  }

  let serviceSessionIds;
  try {
    serviceSessionIds = await getOperationalSessionIds({ select });
  } catch (_) {
    return { available: false };
  }
  if (!Array.isArray(serviceSessionIds)) {
    return { available: false };
  }

  let businessDate;
  try {
    businessDate = plannerBusinessDate(now instanceof Date ? now : new Date(now || Date.now()));
  } catch (_) {
    return { available: false };
  }
  if (!businessDate) return { available: false };

  return { available: true, serviceSessionIds, businessDate };
}

module.exports = { resolveOperationalScope };
