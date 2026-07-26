"use strict";
// ===============================================================
// serviceSchedule.js — S2-7D6B
//
// THE authoritative runtime schedule for the restaurant's two services.
//
// Before this module the opening hours existed only as PROSE inside
// src/config.js INFO_RISTORANTE — a string fed to Claude — plus a scatter of
// hardcoded constants (a 22:00 close guard, a 23:50 cron, a 23:00 frontend
// cutoff, a literal "+02:00" offset in computeSummary). None of them agreed,
// none of them knew about lunch, and one of them silently broke outside CEST.
//
// Everything that needs to know "which service is it now?" must ask this
// module. INFO_RISTORANTE stays a PROMPT and must never be parsed at runtime.
//
// TIMEZONE. All reasoning happens in Europe/Madrid via Intl.DateTimeFormat,
// which is DST-correct by construction. No fixed offset appears anywhere here.
//
// OPERATIONAL DAY. The service day rolls over at 04:00 Madrid, not midnight: a
// dinner opened on day D keeps business_date = D even for orders taken at 01:30
// on D+1. This matches the frontend's SERVICE_ROLLOVER_CUTOFF_MIN (4h) and the
// backend's existing 00:00-06:00 catch-up window.
//
// FUTURE. resolveSchedule() takes the schedule as an argument and defaults to
// DEFAULT_SCHEDULE, so a later restaurant_profile row (or a config override) can
// supply a different one without touching a single caller. The commercial
// multi-tenant profile is deliberately NOT built here.
// ===============================================================

const TIMEZONE = "Europe/Madrid";

// Minutes from midnight. Half-open intervals [start, end).
const HM = (h, m = 0) => h * 60 + m;

const DEFAULT_SCHEDULE = Object.freeze({
  timezone: TIMEZONE,
  // Automatic ensure window for PRANZO.
  lunchEnsureStartMin: HM(8, 0),      // 08:00 inclusive
  lunchBoundaryMin: HM(17, 30),       // 17:30 exclusive — also lunch close-eligibility
  // 17:30-18:00 is the BUFFER: lunch may finish, dinner must not open over it.
  dinnerEnsureStartMin: HM(18, 0),    // 18:00 inclusive
  // Dinner intake ends at midnight; a 23:50 order is still perfectly valid.
  dinnerOrderCutoffMin: HM(24, 0),    // 00:00 (expressed as 1440 on the opening day)
  // Automatic close ATTEMPTS begin at the cutoff; they are attempts, not force.
  dinnerCloseAttemptMin: HM(24, 0),   // 00:00
  // The service day rolls over here. Also the escalation boundary: at 04:00 a
  // still-open dinner is an exception to raise, never a blind destructive close.
  rolloverMin: HM(4, 0),              // 04:00
  // Closed weekdays are NOT yet defined by the owner. An empty list means the
  // resolver never refuses on a weekday basis. Do not populate this by guessing.
  closedWeekdays: Object.freeze([]),
});

const SERVICE_KIND = Object.freeze({ PRANZO: "PRANZO", SERA: "SERA" });

const SCHEDULE_STATE = Object.freeze({
  PRANZO_WINDOW: "PRANZO_WINDOW",             // lunch may be ensured
  BETWEEN_SERVICES: "BETWEEN_SERVICES",       // 17:30-18:00 buffer — no new session
  SERA_WINDOW: "SERA_WINDOW",                 // dinner may be ensured, intake open
  AFTER_ORDER_CUTOFF: "AFTER_ORDER_CUTOFF",   // 00:00-04:00 — no new session, close attempts run
  OUTSIDE_WINDOWS: "OUTSIDE_WINDOWS",         // 04:00-08:00 — nothing automatic
});

// ── Madrid wall clock, DST-correct ──────────────────────────────────────────
const PARTS_FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIMEZONE,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  hour12: false, weekday: "short",
});

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function madridParts(now = new Date(), timezone = TIMEZONE) {
  const fmt = timezone === TIMEZONE ? PARTS_FMT : new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false, weekday: "short",
  });
  const out = {};
  for (const p of fmt.formatToParts(now instanceof Date ? now : new Date(now))) {
    if (p.type !== "literal") out[p.type] = p.value;
  }
  // Intl renders midnight as "24" in some en-GB/hourCycle combinations.
  const hour = Number(out.hour) % 24;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour,
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: WEEKDAY_INDEX[out.weekday] ?? null,
    dateStr: `${out.year}-${out.month}-${out.day}`,
    minutesOfDay: hour * 60 + Number(out.minute),
  };
}

// The operational (business) date: the calendar date the CURRENT service day
// started on. Before the 04:00 rollover we still belong to yesterday's service.
function businessDateFor(now = new Date(), schedule = DEFAULT_SCHEDULE) {
  const p = madridParts(now, schedule.timezone);
  if (p.minutesOfDay >= schedule.rolloverMin) return p.dateStr;
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day));
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ── The resolver ────────────────────────────────────────────────────────────
// Returns a frozen, fully typed description of "now". Pure: same input, same
// output, no clock read beyond the `now` handed in.
//
// S2-7D6B3 — THE canonical result. Every consumer that needs to know "may X
// happen right now" reads one of the six named booleans below rather than
// re-deriving its own interpretation of `state`. They are six DISTINCT
// decisions (a future schedule change could decouple values that happen to
// coincide today) and are never collapsed into one flag:
//   canEnsureSession          — may ensureCurrentServiceSession open/reuse one?
//   canCreateNewOrder         — may a brand-new commercial order be created?
//   canAttemptClose           — is a close attempt for the matching kind due?
//   canContinueExistingOrders — may an ALREADY-EXISTING order keep moving
//                                (Cocina/rider/payment/refund/close)? This is
//                                never gated by the clock — the schedule module
//                                never blocks work already in flight — so it is
//                                `true` in every state, on record as such.
//   isEscalationBoundary      — has a still-open session crossed 04:00?
//   expectedServiceKind       — the kind an ensure would create right now, or
//                                null when none (mirrors expectedServiceKind()).
function resolveSchedule(now = new Date(), schedule = DEFAULT_SCHEDULE) {
  const p = madridParts(now, schedule.timezone);
  const min = p.minutesOfDay;
  const businessDate = businessDateFor(now, schedule);

  // 00:00-04:00 belongs to the dinner that opened YESTERDAY. No new session may
  // be created here: an operator arriving at 01:00 to a closed restaurant must
  // not silently mint a service. Existing dinner orders remain fully operational.
  if (min < schedule.rolloverMin) {
    return frozen({
      state: SCHEDULE_STATE.AFTER_ORDER_CUTOFF,
      serviceKind: SERVICE_KIND.SERA,
      canEnsureSession: false,
      canCreateNewOrder: false,
      canAttemptClose: true,
      canContinueExistingOrders: true,
      isEscalationBoundary: false,
      businessDate, madrid: p, schedule,
    });
  }
  if (min < schedule.lunchEnsureStartMin) {
    // 04:00-08:00. A dinner still open here has crossed the escalation boundary.
    return frozen({
      state: SCHEDULE_STATE.OUTSIDE_WINDOWS,
      serviceKind: null,
      canEnsureSession: false,
      canCreateNewOrder: false,
      canAttemptClose: true,
      canContinueExistingOrders: true,
      isEscalationBoundary: true,
      businessDate, madrid: p, schedule,
    });
  }
  if (min < schedule.lunchBoundaryMin) {
    return frozen({
      state: SCHEDULE_STATE.PRANZO_WINDOW,
      serviceKind: SERVICE_KIND.PRANZO,
      canEnsureSession: true,
      canCreateNewOrder: true,
      canAttemptClose: false,
      canContinueExistingOrders: true,
      isEscalationBoundary: false,
      businessDate, madrid: p, schedule,
    });
  }
  if (min < schedule.dinnerEnsureStartMin) {
    // The buffer. Lunch may finish and close safely; dinner must NOT open over
    // it. No brand-new order of EITHER kind is accepted here — an order already
    // created before 17:30 is not new intake and keeps moving normally under
    // canContinueExistingOrders, but nothing new may start in this gap.
    return frozen({
      state: SCHEDULE_STATE.BETWEEN_SERVICES,
      serviceKind: null,
      canEnsureSession: false,
      canCreateNewOrder: false,
      canAttemptClose: true,           // lunch is now close-eligible
      canContinueExistingOrders: true,
      isEscalationBoundary: false,
      businessDate, madrid: p, schedule,
    });
  }
  return frozen({
    state: SCHEDULE_STATE.SERA_WINDOW,
    serviceKind: SERVICE_KIND.SERA,
    canEnsureSession: true,
    canCreateNewOrder: true,            // 23:50 is still a normal order
    canAttemptClose: false,
    canContinueExistingOrders: true,
    isEscalationBoundary: false,
    businessDate, madrid: p, schedule,
  });
}

function frozen(o) {
  return Object.freeze({
    ...o,
    expectedServiceKind: o.canEnsureSession ? o.serviceKind : null,
    madrid: Object.freeze(o.madrid),
  });
}

// Convenience for callers that only need the kind an ensure would create.
// Kept as a standalone export (mirrors the canonical result's own
// `expectedServiceKind` field) for callers that don't need the full result.
function expectedServiceKind(now = new Date(), schedule = DEFAULT_SCHEDULE) {
  return resolveSchedule(now, schedule).expectedServiceKind;
}

// Is a manual/automatic close allowed to run for this kind right now? Replaces
// the flat "after 22:00" rule, which made a lunch close impossible.
function closeEligibility(serviceKind, now = new Date(), schedule = DEFAULT_SCHEDULE) {
  const r = resolveSchedule(now, schedule);
  if (serviceKind === SERVICE_KIND.PRANZO) {
    // Lunch closes from its boundary onward — including during dinner, because a
    // forgotten lunch must remain closable.
    const eligible = r.madrid.minutesOfDay >= schedule.lunchBoundaryMin
      || r.madrid.minutesOfDay < schedule.rolloverMin;
    return { eligible, reason: eligible ? null : "PRANZO_CLOSE_TOO_EARLY", boundary: "17:30" };
  }
  if (serviceKind === SERVICE_KIND.SERA) {
    const eligible = r.state === SCHEDULE_STATE.AFTER_ORDER_CUTOFF
      || r.state === SCHEDULE_STATE.OUTSIDE_WINDOWS;
    return { eligible, reason: eligible ? null : "SERA_CLOSE_TOO_EARLY", boundary: "00:00" };
  }
  // Unknown/legacy kind: fall back to the historical evening rule so a legacy
  // session can still be closed rather than becoming unclosable.
  const eligible = r.madrid.minutesOfDay >= HM(22, 0) || r.madrid.minutesOfDay < schedule.rolloverMin;
  return { eligible, reason: eligible ? null : "LEGACY_CLOSE_TOO_EARLY", boundary: "22:00" };
}

module.exports = {
  TIMEZONE, HM, DEFAULT_SCHEDULE, SERVICE_KIND, SCHEDULE_STATE,
  madridParts, businessDateFor, resolveSchedule, expectedServiceKind, closeEligibility,
};
