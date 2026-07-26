"use strict";
// ===============================================================
// ensureServiceSession.js — S2-7D6B
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
// ===============================================================

const { lifecycle } = require("./serviceSessionLifecycle");
const {
  DEFAULT_SCHEDULE, SCHEDULE_STATE, resolveSchedule,
} = require("../schedule/serviceSchedule");

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
} = {}) {
  return async function ensureCurrentServiceSession({ actor, source = "auto_entry" } = {}) {
    if (!actor || typeof actor !== "string" || !actor.trim()) {
      return { success: false, created: false, code: ENSURE_CODE.INVALID_ACTOR, session: null };
    }

    const when = resolveSchedule(now(), schedule);

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
