"use strict";
// ===============================================================
// explicitReopenServiceSession.js — F-9, explicit same-Business-Day reopen.
//
// The ONLY JS call site anywhere in this repo allowed to pass
// 'explicit_reopen' to open_operational_service_v1 (F-6). It resolves the
// current lifecycle state itself, server-side, from ensure_service_session's
// own read-only discriminator (REUSED / NO_OPEN_SERVICE / REOPEN_REQUIRED —
// F-7) — the exact business_day_id-scoped "has this Business Day ever had a
// service" check already installed and certified. This module never
// re-derives that check in JS, never trusts recent_closed_session_id as
// sole authority (it may name a session from an EARLIER Business Day; F-7's
// discriminator does not), and never accepts a client-supplied
// open_reason/businessDayId/serviceSessionId — actor/source are the only
// inputs, both server-verified identity, never client lifecycle assertions.
//
// Routing (frozen F-9 brief):
//   REUSED           -> an active service already exists; return it, no write.
//   NO_OPEN_SERVICE  -> no current Business Day, OR the current one has NEVER
//                       had a service -> NOT a reopen; typed reject,
//                       zero creation (the lazy first-open path belongs to
//                       resolve_order_intake_context_v1 alone, never here).
//   REOPEN_REQUIRED  -> the ONE case this module calls
//                       open_operational_service_v1(actor, 'explicit_reopen',
//                       source) — BUT ONLY after F-9.1's staleness check
//                       below passes. The primitive's own advisory lock + its
//                       has_any_service/REUSED checks make two overlapping
//                       callers converge on one Service B, never a
//                       duplicate (F-6, live concurrency-proven) — that
//                       protects against a RACE, not against a genuinely
//                       STALE pointer, which is a different failure mode
//                       entirely (see below).
// Every other ensure_service_session code (SERVICE_SESSION_CLOSING,
// MULTIPLE_ACTIVE_SERVICE_SESSIONS, SERVICE_SESSION_STATE_CORRUPT,
// INVALID_ACTOR) is a pre-existing defensive read, passed through verbatim —
// this module invents no new meaning for any of them, and performs no
// rollover/recovery of its own (that pre-check is S2-7D6F/P0-C1's, already
// run unconditionally by the silent page-load ensure before an operator can
// ever reach this action's UI trigger — see CurrentNightCloseoutPage.jsx).
//
// F-9.1 — STALE BUSINESS DAY GUARD. open_operational_service_v1 trusts
// business_day_lifecycle_state.current_business_day_id AS-IS; it has no
// notion of "stale." Found during F-9 certification: the canonical pointer
// can sit unmoved on an OLD Business Day for days after its service closed,
// because nothing but a real order (resolve_order_intake_context_v1, inside
// the ordenes-insert trigger) ever advances it — R-DAY3's own comment
// documents this is the ONLY mutating path. "Explicit Reopen" means
// same-Business-Day reopen, never "reopen whichever historical Business Day
// the pointer happens to still reference" (owner-frozen F-9.1 contract).
//
// Chosen architecture: REFUSE, never RECONCILE. This module has exactly one
// new read, added to the REOPEN_REQUIRED branch only: fetchOrderIntakeContext
// (orderIntakePolicy.js, unmodified, already the live order-intake preflight)
// wraps get_order_intake_context_v1() — a STABLE, side-effect-free RPC that
// mirrors resolve_order_intake_context_v1's own overnight-safe businessDate
// computation constant-for-constant (parity-proven, tests/rDay3ScheduleParity
// .test.js). Comparing its businessDate against the businessDate
// ensure_service_session's REOPEN_REQUIRED response already carries (both are
// the same `date` SQL type through the same jsonb_build_object shape, safe to
// compare as strings) answers "is the pointer's Business Day still the
// currently-valid one" using the SAME single canonical rule the rest of the
// system already trusts — never a second, ad-hoc calendar clock, and no
// naive `= CURRENT_DATE` (the 04:00 overnight cutoff is inherited for free).
// open_business_day_v1 (R-DAY1) was deliberately NOT reused here: read fresh
// this session, its own date computation omits that exact cutoff and it has
// no live caller anywhere — reusing it would import a second, inconsistent
// rule rather than the one the order-intake path actually runs on.
// A stale pointer refuses with zero creation and zero mutation of any kind;
// Business Day advancement remains exclusively resolve_order_intake_context_
// v1's job, triggered by the next real order — this module never reconciles,
// never writes business_day_lifecycle_state, never touches ticket_epoch.
// A failure of the freshness READ itself fails CLOSED (refuses), the inverse
// of orderIntakePolicy.js's own fail-OPEN posture for ordinary orders — that
// module can fail open because the in-transaction DB resolver is still a
// backstop; this module's check IS the backstop, since open_operational_
// service_v1 itself has no staleness notion at all.
// ===============================================================

const { lifecycle } = require("./serviceSessionLifecycle");
const { fetchOrderIntakeContext } = require("./orderIntakePolicy");

const CODE = Object.freeze({
  REUSED: "REUSED",
  CREATED: "CREATED",
  FIRST_OPEN_NOT_REOPENABLE: "FIRST_OPEN_NOT_REOPENABLE",
  SERVICE_SESSION_CLOSING: "SERVICE_SESSION_CLOSING",
  MULTIPLE_ACTIVE_SERVICE_SESSIONS: "MULTIPLE_ACTIVE_SERVICE_SESSIONS",
  SERVICE_SESSION_STATE_CORRUPT: "SERVICE_SESSION_STATE_CORRUPT",
  INVALID_ACTOR: "INVALID_ACTOR",
  NO_PRIOR_SERVICE_TO_REOPEN: "NO_PRIOR_SERVICE_TO_REOPEN",
  ACTIVE_SERVICE_BUSINESS_DAY_MISMATCH: "ACTIVE_SERVICE_BUSINESS_DAY_MISMATCH",
  NO_CURRENT_BUSINESS_DAY: "NO_CURRENT_BUSINESS_DAY",
  BUSINESS_DAY_NOT_FOUND: "BUSINESS_DAY_NOT_FOUND",
  EXPLICIT_REOPEN_FAILED: "EXPLICIT_REOPEN_FAILED",
  ENSURE_READ_FAILED: "ENSURE_READ_FAILED",
  // F-9.1
  STALE_BUSINESS_DAY_REOPEN: "STALE_BUSINESS_DAY_REOPEN",
  BUSINESS_DAY_VALIDITY_CHECK_FAILED: "BUSINESS_DAY_VALIDITY_CHECK_FAILED",
});

// Typed codes the F-6 primitive itself can return that are honest,
// surfaceable pass-throughs (never guessed at, never swallowed into a
// generic 500).
const PRIMITIVE_PASSTHROUGH_CODES = new Set([
  CODE.NO_PRIOR_SERVICE_TO_REOPEN,
  CODE.ACTIVE_SERVICE_BUSINESS_DAY_MISMATCH,
  CODE.NO_CURRENT_BUSINESS_DAY,
  CODE.BUSINESS_DAY_NOT_FOUND,
  CODE.INVALID_ACTOR,
]);

// ensure_service_session codes that are pre-existing defensive reads, not
// reopen decisions — surfaced verbatim, unchanged meaning.
const ENSURE_PASSTHROUGH_CODES = new Set([
  CODE.SERVICE_SESSION_CLOSING,
  CODE.MULTIPLE_ACTIVE_SERVICE_SESSIONS,
  CODE.SERVICE_SESSION_STATE_CORRUPT,
  CODE.INVALID_ACTOR,
]);

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

function createExplicitReopenServiceSession({
  sessionLifecycle = lifecycle,
  fetchIntakeContext = fetchOrderIntakeContext,
} = {}) {
  return async function explicitReopenServiceSession({ actor, source = "manual_recovery" } = {}) {
    if (!actor || typeof actor !== "string" || !actor.trim()) {
      return { success: false, created: false, code: CODE.INVALID_ACTOR, session: null };
    }

    // Server-side, business_day_id-scoped read — never client-supplied.
    const read = await sessionLifecycle.ensure({ actor, source });
    if (!read || typeof read.ok !== "boolean") {
      return { success: false, created: false, code: CODE.ENSURE_READ_FAILED, session: null };
    }

    if (read.ok === true && read.code === "REUSED") {
      return { success: true, created: false, code: CODE.REUSED, session: publicSession(read.session) };
    }

    if (read.ok === false && ENSURE_PASSTHROUGH_CODES.has(read.code)) {
      return { success: false, created: false, code: read.code, session: publicSession(read.session) };
    }

    if (read.ok === false && read.code === "NO_OPEN_SERVICE") {
      return {
        success: false, created: false, code: CODE.FIRST_OPEN_NOT_REOPENABLE,
        businessDayId: read.businessDayId || null, businessDate: read.businessDate || null,
      };
    }

    if (read.ok === false && read.code === "REOPEN_REQUIRED") {
      // F-9.1 — the stale-pointer guard. A read-only, side-effect-free check
      // against the SAME canonical overnight-safe businessDate rule the real
      // order-intake resolver runs on (see this module's own header). Fails
      // CLOSED: an unreadable freshness check refuses the reopen, it never
      // silently proceeds.
      const intakeCtx = await fetchIntakeContext();
      if (!intakeCtx || typeof intakeCtx.businessDate !== "string") {
        return {
          success: false, created: false, code: CODE.BUSINESS_DAY_VALIDITY_CHECK_FAILED,
          businessDayId: read.businessDayId || null, businessDate: read.businessDate || null,
        };
      }
      if (intakeCtx.businessDate !== read.businessDate) {
        // The pointer's Business Day is not the currently-valid one. Zero
        // creation, zero mutation — Business Day advancement remains
        // exclusively resolve_order_intake_context_v1's job, on the next
        // real order.
        return {
          success: false, created: false, code: CODE.STALE_BUSINESS_DAY_REOPEN,
          businessDayId: read.businessDayId || null,
          staleBusinessDate: read.businessDate || null,
          currentBusinessDate: intakeCtx.businessDate,
        };
      }

      // The ONE call site allowed to pass 'explicit_reopen'. actor/source are
      // the server's own verified values — never a client-supplied
      // open_reason/businessDayId/serviceSessionId.
      const opened = await sessionLifecycle.openOperational({ actor, openReason: "explicit_reopen", source });
      if (!opened || typeof opened.ok !== "boolean") {
        return { success: false, created: false, code: CODE.EXPLICIT_REOPEN_FAILED, session: null };
      }
      if (opened.ok === true && opened.code === "CREATED") {
        return { success: true, created: true, code: CODE.CREATED, session: publicSession(opened.session) };
      }
      if (opened.ok === true && opened.code === "REUSED") {
        // A concurrent explicit reopen (or an unrelated first-ever lazy open
        // racing in from order intake) won the primitive's own advisory lock
        // first — converge on the SAME active service, never a duplicate.
        return { success: true, created: false, code: CODE.REUSED, session: publicSession(opened.session) };
      }
      if (opened.ok === false && PRIMITIVE_PASSTHROUGH_CODES.has(opened.code)) {
        return { success: false, created: false, code: opened.code, session: publicSession(opened.session) };
      }
      // Any other shape (a genuine race, or an unrecognized future code) is
      // surfaced honestly as a typed failure, never a silent success and
      // never a generic 500.
      return { success: false, created: false, code: CODE.EXPLICIT_REOPEN_FAILED, session: publicSession(opened.session) };
    }

    // An ensure_service_session code this module does not recognize — never
    // guessed at, never silently treated as success.
    return { success: false, created: false, code: CODE.EXPLICIT_REOPEN_FAILED, session: publicSession(read.session) };
  };
}

const explicitReopenServiceSession = createExplicitReopenServiceSession();

module.exports = {
  CODE, publicSession, createExplicitReopenServiceSession, explicitReopenServiceSession,
};
