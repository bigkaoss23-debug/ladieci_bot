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
// windows. This module now runs ONE recovery pre-check, in every window, before
// ever consulting canEnsureSession:
//   1. read the actual current session (open/closing), regardless of window;
//   2. if it has pending operational activity -> hand it back, full access,
//      whatever the clock says — never force-closed, never duplicated;
//   3. if it is empty and past its own close boundary -> reconcile it through
//      the SAME engine cron/boot/external already share (computeAutoCloseDecision
//      + chiudiServizio, via pendingActivityGuard's terminal-state list) and
//      re-enter the window logic from a clean slate — never auto-open a NEW
//      session outside an allowed window just because the old one just closed;
//   4. only when no recoverable session exists does the ordinary window-typed
//      refusal apply.
// No logic is duplicated: step 2 reuses hasPendingOperationalActivity, step 3
// reuses chiudiServizio, exactly as cron/boot/external already do.
// ===============================================================

const { lifecycle } = require("./serviceSessionLifecycle");
const {
  DEFAULT_SCHEDULE, SCHEDULE_STATE, resolveSchedule, closeEligibility,
} = require("../schedule/serviceSchedule");
const { hasPendingOperationalActivity } = require("./pendingActivityGuard");
const { chiudiServizio } = require("../utils/servizio");

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

function createEnsureCurrentServiceSession({
  sessionLifecycle = lifecycle,
  schedule = DEFAULT_SCHEDULE,
  now = () => new Date(),
  hasPendingActivity = hasPendingOperationalActivity,
  closeSession = chiudiServizio,
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

      // status === "open" — step 2/3 of the contract.
      let pending = false;
      try { pending = (await hasPendingActivity({ sessionId: current.id })).pending === true; }
      catch (_) { pending = true; } // fail closed: never force-close on a read error.

      if (!pending) {
        const gate = closeEligibility(current.service_kind || null, nowDate, schedule);
        if (gate.eligible) {
          let closeResult;
          try { closeResult = await closeSession(true, "ensure_reconcile"); }
          catch (e) { closeResult = { success: false, error: String((e && e.message) || e) }; }

          if (closeResult && closeResult.success === true) {
            // Reconciled away. Re-enter the window logic from a clean slate —
            // never auto-open a new session outside an allowed window just
            // because this one just closed (step 3's second half).
            current = null;
          } else if (closeResult && closeResult.skipped && closeResult.deferred) {
            // A trip appeared concurrently between the read above and the close
            // attempt — chiudiServizio's own gate already refused to touch
            // anything. Same outcome as "pending", from the same session.
            pending = true;
          } else {
            // A genuine close error (or an unexpected skip). Never dead-end the
            // operator over a background reconciliation failure: the session is
            // still open by chiudiServizio's own contract, so grant access to it
            // and only track the error server-side.
            console.error("[ensure] recovery reconcile failed — granting access to the still-open session instead of a dead end:", closeResult);
            pending = true;
          }
        }
      }

      if (current && pending) {
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
