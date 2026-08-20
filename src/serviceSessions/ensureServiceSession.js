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
// LEGACY WRITER HARDENING — THIS MODULE NO LONGER MUTATES ANYTHING.
//
// Until now, the silent page-load ensure carried the S2-7D6F "recovery
// pre-check": if the current session looked due for rollover it ran
// language-guard: allow-legacy chiudiServizio is the existing legacy close function (src/utils/servizio.js), named here only to state what this module no longer calls, not new vocabulary
// performIncidentSafeRollover -> chiudiServizio, i.e. a real, mutating CLOSE,
// attributed to whichever operator's browser happened to be open. It sat
// behind LEGACY_AUTOMATIC_LIFECYCLE_ENABLED, which staging has held at
// "false" for weeks -- so the invariant "APP_RELOAD_MUTATES_SERVICE = NO"
// was true only by environment variable, not by construction. One unset env
// var in one deploy and a page load could close a live service again.
// close_source 'ensure_reconcile' in the live data is that path having fired
// for real, once.
//
// The call site is now GONE, not gated. This module reads and returns; it
// cannot close, roll, or create under any configuration. The two legitimate
// jobs the pre-check used to cover are already owned elsewhere, by certified
// code that this module must never duplicate:
//   * a forgotten cross-day service -> F-10, from the order/seating intake
//     boundary (forgottenCloseRecovery.js), never from a page load;
//   * a stale canonical Business Day pointer -> F-11, inside
//     ensure_service_session's own read-only classification.
// Nothing else was ever recovered here.
// ===============================================================


const { lifecycle } = require("./serviceSessionLifecycle");

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

// The factory keeps only the seams a test actually needs. `schedule`, `now`,
// `performRollover` and `automaticLifecycleEnabled` are all gone: with the
// mutating branch deleted there is no clock to inject, no rollover to stub and
// no flag to flip -- which is the point. A future reviewer cannot re-enable a
// page-load close by setting an env var, because there is nothing left to
// enable.
function createEnsureCurrentServiceSession({ sessionLifecycle = lifecycle } = {}) {
  return async function ensureCurrentServiceSession({ actor, source = "auto_entry" } = {}) {
    if (!actor || typeof actor !== "string" || !actor.trim()) {
      return { success: false, created: false, code: ENSURE_CODE.INVALID_ACTOR, session: null };
    }

    // One read, to answer "is a service currently active". A session mid-close
    // is surfaced as its own typed state rather than waited on or acted upon.
    let current = null;
    try {
      const identity = await sessionLifecycle.currentCloseout();
      if (identity && identity.ok && identity.session && identity.session.status !== "closed") {
        current = identity.session;
      }
    } catch (_) {
      // A read failure must not make ensure() itself fail -- fall through to
      // the read-only discriminator below, exactly as before.
      current = null;
    }

    if (current) {
      if (current.status === "closing") {
        return {
          success: false, created: false, code: ENSURE_CODE.SERVICE_SESSION_CLOSING,
          session: publicSession(current),
        };
      }
      return {
        success: true, created: false, code: ENSURE_CODE.REUSED,
        session: publicSession(current),
      };
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
