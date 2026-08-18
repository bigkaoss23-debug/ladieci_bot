"use strict";
// ===============================================================
// ensureServiceSession.js — S2-7D6B, recovery pre-check S2-7D6F,
// F-7 opening authority cutover
//
// The service session is an INVISIBLE operational and accounting container. The
// operator should never have to open one by hand on a normal day: the first
// authorised admin or operator who enters Servicio inside a valid window causes
// the correct session to exist, exactly once, and walks straight in.
//
// F-7 — this module no longer decides "which kind, and may we create it?"
// (there is no longer a kind to decide, and it never creates at all). Once
// no active session remains, it answers purely from DB state, read-only:
// NO_OPEN_SERVICE (the current Business Day has never had a service) or
// REOPEN_REQUIRED (it has, but nothing is active right now). Page load
// observes state. Page load does not create lifecycle. The FIRST-EVER
// creation for a Business Day happens lazily on the first real order,
// inside resolve_order_intake_context_v1 (see that RPC's own header) —
// never from here.
//
// S2-7D6F — a REAL, still-open session must never be shadowed by a window-only
// refusal. Before S2-7D6F, BETWEEN_SERVICES/AFTER_ORDER_CUTOFF/OUTSIDE_WINDOWS
// short-circuited with session:null WITHOUT ever checking whether a session was
// genuinely still open — so a lunch lingering into the 17:30-18:00 buffer, or a
// dinner still running at 05:00, could dead-end an operator with zero access
// even though the RPC's own kind-mismatch conflict (LUNCH_SESSION_STILL_ACTIVE)
// already handles the exact same situation correctly inside the ensure-eligible
// windows. This module runs ONE recovery pre-check, unconditionally, before
// ever consulting the read-only discriminator below — UNCHANGED by F-7, this
// is orthogonal to opening authority: it closes a DUE, still-grandfathered
// legacy session, it never creates one:
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
//   3. if the rollover succeeds -> re-enter the discriminator below from a
//      clean slate — never auto-open a NEW session just because the old one
//      just closed (unchanged from before);
//   4. if the rollover is deferred (e.g. an active rider trip) or fails for a
//      real reason -> hand back the still-open session rather than dead-end
//      the operator (unchanged from before);
//   5. only when no recoverable session exists, or it is not yet due, does
//      the ordinary read-only discriminator apply.
// No logic is duplicated: step 2 reuses classifySessionForRollover and
// performIncidentSafeRollover, which itself reuses chiudiServizio — exactly
// as cron/boot/external now do too (see index.js).
// ===============================================================

const { lifecycle } = require("./serviceSessionLifecycle");
const { DEFAULT_SCHEDULE } = require("../schedule/serviceSchedule");
const { classifySessionForRollover, isRolloverDue } = require("./sessionRolloverClassification");
const { performIncidentSafeRollover } = require("./incidentSafeRollover");

// Typed non-success states. None of these is an error in the crash sense — each
// is a legitimate answer that the UI renders differently.
const ENSURE_CODE = Object.freeze({
  REUSED: "REUSED",
  NO_OPEN_SERVICE: "NO_OPEN_SERVICE",
  REOPEN_REQUIRED: "REOPEN_REQUIRED",
  SERVICE_SESSION_CLOSING: "SERVICE_SESSION_CLOSING",
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
// default-true semantics) so the rollover call below stays under the SAME
// single safety switch, never a new mechanism. When disabled, "due for
// rollover" degrades to the SAME safe fallback already used for a deferred
// rollover: hand back the still-open, still-usable session. Only an
// explicit, human-initiated close (index.js action "chiudiServizio") remains
// reachable while automatic lifecycle is frozen. This gate governs ONLY the
// legacy rollover-of-an-existing-session step — it has never governed, and
// still does not govern, whether this module may CREATE anything (it never
// could create outside a window before F-7 either; after F-7 it can never
// create at all, window or no window).
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

    // ── S2-7D6F recovery pre-check — runs unconditionally, before ever
    // consulting the read-only discriminator below ──
    let current = null;
    try {
      const identity = await sessionLifecycle.currentCloseout();
      if (identity && identity.ok && identity.session && identity.session.status !== "closed") {
        current = identity.session;
      }
    } catch (_) {
      // A read failure here must not make ensure() itself fail — it only means
      // the recovery pre-check is unavailable this attempt; fall through to the
      // ordinary discriminator below exactly as before S2-7D6F.
      current = null;
    }

    if (current) {
      if (current.status === "closing") {
        return {
          success: false, created: false, code: ENSURE_CODE.SERVICE_SESSION_CLOSING,
          session: publicSession(current),
        };
      }

      // status === "open" — steps 2/3/4 of the S2-7D6F contract, UNCHANGED
      // by F-7: this closes a DUE legacy session, it never creates one.
      const classification = classifySessionForRollover(current, nowDate, schedule);
      if (isRolloverDue(classification) && automaticLifecycleEnabled()) {
        let rolloverResult;
        try { rolloverResult = await performRollover({ session: current, actor, source: "ensure_reconcile" }); }
        catch (e) { rolloverResult = { success: false, error: String((e && e.message) || e) }; }

        if (rolloverResult && rolloverResult.success === true) {
          // Rolled over (with or without incidents). Re-enter the
          // discriminator below from a clean slate — never auto-open a new
          // session just because this one just closed.
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
          session: publicSession(current),
        };
      }
    }

    // F-7 — no active session remains. Read-only discriminator: never
    // creates, never infers PRANZO/SERA identity, never rolls anything, // language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values, named here only to describe identity logic this discriminator never performs, not new vocabulary
    // never calls open_operational_service_v1. ensure_service_session
    // itself answers REUSED / NO_OPEN_SERVICE / REOPEN_REQUIRED purely from
    // DB state.
    const res = await sessionLifecycle.ensure({ actor, source });

    if (res && res.ok === true) {
      return {
        success: true, created: false, code: ENSURE_CODE.REUSED,
        session: publicSession(res.session),
      };
    }

    const code = (res && res.code) || ENSURE_CODE.ENSURE_FAILED;
    return {
      success: false,
      created: false,
      code,
      session: publicSession(res && res.session),
      businessDate: (res && res.businessDate) || null,
    };
  };
}

const ensureCurrentServiceSession = createEnsureCurrentServiceSession();

module.exports = {
  ENSURE_CODE, publicSession, createEnsureCurrentServiceSession, ensureCurrentServiceSession,
};
