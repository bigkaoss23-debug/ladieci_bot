"use strict";
// ===============================================================
// ensureServiceSession.js — S2-7D6B, recovery pre-check S2-7D6F
//
// The service session is an INVISIBLE operational and accounting container. The
// operator should never have to open one by hand on a normal day: the first
// authorised admin or operator who enters Servicio inside a valid window causes
// the correct session to exist, exactly once, and walks straight in.
//
// This module owns the decision "which kind, and may we create it?". The SQL
// function owns atomicity and the invariants. Neither owns the schedule — that
// is serviceSchedule.js, the single source of truth.
//
// The client NEVER supplies the kind. It is derived here from server time, for
// the same reason ordenes.service_session_id is trigger-assigned: a caller that
// can name its own service can misfile takings.
//
// S2-7D6F — a REAL, still-open session must never be shadowed by a window-only
// refusal. Before S2-7D6F, BETWEEN_SERVICES/AFTER_ORDER_CUTOFF/OUTSIDE_WINDOWS
// short-circuited with session:null WITHOUT ever checking whether a session was
// genuinely still open — so a lunch lingering into the 17:30-18:00 buffer, or a
// dinner still running at 05:00, could dead-end an operator with zero access
// even though the RPC's own kind-mismatch conflict (LUNCH_SESSION_STILL_ACTIVE)
// already handles the exact same situation correctly inside the ensure-eligible
// windows. This module runs ONE recovery pre-check, in every window, before
// ever consulting canEnsureSession:
//   1. read the actual current session (open/closing), regardless of window;
//   2. if it is genuinely due for rollover (classifySessionForRollover says
//      PRIOR_DAY_STALE or SAME_DAY_TRANSITION_DUE) -> run the incident-safe
//      rollover (performIncidentSafeRollover), REGARDLESS of pending
//      operational activity. SERVICE CLOSEOUT V2 / SLICE 3 — this replaces
//      the original S2-7D6F contract's step 2 ("pending activity -> hand it
//      back, full access, whatever the clock says — never force-closed"),
//      which is exactly RC-2 (PENDING_ACTIVITY_GLOBAL_BLOCK): pending orders
//      no longer keep a DUE session current forever. Pending work becomes a
//      persisted incident instead (see rolloverClassifier.js); the session
//      still closes, via the SAME engine (chiudiServizio) this always used;
//   3. if the rollover succeeds -> re-enter the window logic from a clean
//      slate — never auto-open a NEW session outside an allowed window just
//      because the old one just closed (unchanged from before);
//   4. if the rollover is deferred (e.g. an active rider trip) or fails for a
//      real reason -> hand back the still-open session rather than dead-end
//      the operator (unchanged from before);
//   5. only when no recoverable session exists, or it is not yet due, does
//      the ordinary window-typed refusal apply.
// No logic is duplicated: step 2 reuses classifySessionForRollover and
// performIncidentSafeRollover, which itself reuses chiudiServizio — exactly
// as cron/boot/external now do too (see index.js).
// ===============================================================

const { lifecycle } = require("./serviceSessionLifecycle");
const { DEFAULT_SCHEDULE, SCHEDULE_STATE, resolveSchedule } = require("../schedule/serviceSchedule");
const { classifySessionForRollover, isRolloverDue } = require("./sessionRolloverClassification");
const { performIncidentSafeRollover } = require("./incidentSafeRollover");

// Typed non-success states. None of these is an error in the crash sense — each
// is a legitimate answer that the UI renders differently.
const ENSURE_CODE = Object.freeze({
  CREATED: "CREATED",
  REUSED: "REUSED",
  BETWEEN_SERVICES: "BETWEEN_SERVICES",
  OUTSIDE_WINDOWS: "OUTSIDE_WINDOWS",
  AFTER_ORDER_CUTOFF: "AFTER_ORDER_CUTOFF",
  LUNCH_SESSION_STILL_ACTIVE: "LUNCH_SESSION_STILL_ACTIVE",
  OTHER_SERVICE_STILL_ACTIVE: "OTHER_SERVICE_STILL_ACTIVE",
  SERVICE_SESSION_CLOSING: "SERVICE_SESSION_CLOSING",
  SERVICE_ALREADY_COMPLETED_TODAY: "SERVICE_ALREADY_COMPLETED_TODAY",
  INVALID_ACTOR: "INVALID_ACTOR",
  ENSURE_FAILED: "ENSURE_FAILED",
});

function publicSession(row) {
  if (!row || typeof row !== "object") return null;
  return {
    id: row.id,
    serviceKind: row.service_kind || null,
    businessDate: row.business_date || null,
    status: row.status || null,
    openedAt: row.opened_at || null,
  };
}

// P0-C1 — RUNTIME LIFECYCLE AUTHORITY + AVAILABILITY CONTAINMENT.
// ensureCurrentServiceSession runs on every Servicio page load
// (useSilentServiceEnsure.js, zero user action) and was the one reachable
// trigger of performIncidentSafeRollover NOT gated by index.js's
// LEGACY_AUTOMATIC_LIFECYCLE_ENABLED (the other three — close-tick, boot
// catch-up, triggerCloseIfNeeded — are gated in index.js itself). A session
// crossing its own close-eligibility boundary while any authenticated
// operator's browser had Servicio open would silently fire a real, mutating
// rollover attempt with that operator recorded as its initiator — this is
// exactly what produced the stuck PRANZO of 2026-08-10 15:37 UTC (see
// SERVICE_LIFECYCLE_ECONOMIC_BOUNDARY_AUDIT_REPORT.md §7).
// automaticLifecycleEnabled() mirrors index.js's own flag (same env var, same
// default-true semantics) so the rollover call below becomes the FOURTH path
// under the SAME single safety switch, never a new mechanism. When disabled,
// "due for rollover" degrades to the SAME safe fallback already used for a
// deferred rollover: hand back the still-open, still-usable session. Only an
// explicit, human-initiated close (index.js action "chiudiServizio") remains
// reachable while automatic lifecycle is frozen. Safe/idempotent session
// creation (the ensure() call further below, for when NO session exists at
// all yet) is untouched — that was never an implicit close/rollover and stays
// available regardless of this flag.
function createEnsureCurrentServiceSession({
  sessionLifecycle = lifecycle,
  schedule = DEFAULT_SCHEDULE,
  now = () => new Date(),
  performRollover = performIncidentSafeRollover,
  automaticLifecycleEnabled = () => process.env.LEGACY_AUTOMATIC_LIFECYCLE_ENABLED !== "false",
} = {}) {
  return async function ensureCurrentServiceSession({ actor, source = "auto_entry" } = {}) {
    if (!actor || typeof actor !== "string" || !actor.trim()) {
      return { success: false, created: false, code: ENSURE_CODE.INVALID_ACTOR, session: null };
    }

    const nowDate = now();
    const when = resolveSchedule(nowDate, schedule);

    // ── S2-7D6F recovery pre-check — runs in EVERY window, before canEnsureSession ──
    let current = null;
    try {
      const identity = await sessionLifecycle.currentCloseout();
      if (identity && identity.ok && identity.session && identity.session.status !== "closed") {
        current = identity.session;
      }
    } catch (_) {
      // A read failure here must not make ensure() itself fail — it only means
      // the recovery pre-check is unavailable this attempt; fall through to the
      // ordinary window logic below exactly as before S2-7D6F.
      current = null;
    }

    if (current) {
      if (current.status === "closing") {
        return {
          success: false, created: false, code: ENSURE_CODE.SERVICE_SESSION_CLOSING,
          session: publicSession(current), scheduleState: when.state, businessDate: when.businessDate,
        };
      }

      // status === "open" — steps 2/3/4 of the contract. P0-C1: the rollover
      // attempt itself is gated by automaticLifecycleEnabled() — see this
      // file's header. A due-but-ungated session falls through to "grant
      // access to the still-open session" below, exactly like a deferred
      // rollover already does — never a silent mutation from a page load.
      const classification = classifySessionForRollover(current, nowDate, schedule);
      if (isRolloverDue(classification) && automaticLifecycleEnabled()) {
        let rolloverResult;
        try { rolloverResult = await performRollover({ session: current, actor, source: "ensure_reconcile" }); }
        catch (e) { rolloverResult = { success: false, error: String((e && e.message) || e) }; }

        if (rolloverResult && rolloverResult.success === true) {
          // Rolled over (with or without incidents). Re-enter the window logic
          // from a clean slate — never auto-open a new session outside an
          // allowed window just because this one just closed.
          current = null;
        } else if (rolloverResult && rolloverResult.deferred) {
          // An active rider trip (or similar mechanical defer inside
          // chiudiServizio) appeared between the read above and the rollover
          // attempt. Same outcome as before: grant access to the still-open
          // session, nothing was force-closed.
        } else {
          // A genuine hard-blocker or close error. Never dead-end the
          // operator over a background reconciliation failure: the session is
          // still open by chiudiServizio's own contract, so grant access to it
          // and only track the error server-side.
          console.error("[ensure] incident-safe rollover failed — granting access to the still-open session instead of a dead end:", rolloverResult);
        }
      }

      if (current) {
        return {
          success: true, created: false, code: ENSURE_CODE.REUSED,
          session: publicSession(current), scheduleState: when.state, businessDate: when.businessDate,
        };
      }
    }

    // Outside a creation window we must NOT invent a service. Returning a typed
    // state (rather than silently picking a kind) is what keeps a 03:00 or a
    // 17:45 arrival from minting a phantom session.
    if (!when.canEnsureSession) {
      const code =
        when.state === SCHEDULE_STATE.BETWEEN_SERVICES ? ENSURE_CODE.BETWEEN_SERVICES
        : when.state === SCHEDULE_STATE.AFTER_ORDER_CUTOFF ? ENSURE_CODE.AFTER_ORDER_CUTOFF
        : ENSURE_CODE.OUTSIDE_WINDOWS;
      return {
        success: false, created: false, code, session: null,
        scheduleState: when.state, businessDate: when.businessDate,
      };
    }

    const res = await sessionLifecycle.ensure({
      actor, serviceKind: when.serviceKind, source,
    });

    if (res && res.ok === true) {
      return {
        success: true,
        created: res.created === true,
        code: res.created === true ? ENSURE_CODE.CREATED : ENSURE_CODE.REUSED,
        session: publicSession(res.session),
        scheduleState: when.state,
      };
    }

    const code = (res && res.code) || ENSURE_CODE.ENSURE_FAILED;
    return {
      success: false,
      created: false,
      code,
      session: publicSession(res && res.session),
      scheduleState: when.state,
      businessDate: when.businessDate,
    };
  };
}

const ensureCurrentServiceSession = createEnsureCurrentServiceSession();

module.exports = {
  ENSURE_CODE, publicSession, createEnsureCurrentServiceSession, ensureCurrentServiceSession,
};
