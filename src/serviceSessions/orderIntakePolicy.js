"use strict";
// ===============================================================
// orderIntakePolicy.js — S2-7D6B2 / S2-7D6B3
//
// THE authoritative decision for "may a brand-new commercial order be created
// right now?". A service session being open does NOT by itself mean intake is
// open: a SERA session may (and should) keep running deliveries, payments and
// closing well past midnight, but no brand-new order may be created from
// 00:00 Europe/Madrid onward. This module owns exactly that boundary and
// nothing else — it never touches an already-existing order.
//
// S2-7D6B3 — this module holds NO independent allow/deny list for
// PRANZO_WINDOW / BETWEEN_SERVICES / SERA_WINDOW / AFTER_ORDER_CUTOFF /
// OUTSIDE_WINDOWS. It reads the canonical `canCreateNewOrder` (and
// `serviceKind`) straight off serviceSchedule.js's resolveSchedule() result.
// Moving a boundary — e.g. widening SERA_WINDOW — is a one-file change to
// serviceSchedule.js; this file never needs to be touched for that. Its own
// responsibility is layered strictly ON TOP of that verdict: active-session
// existence, status and kind.
//
// It never trusts a client-supplied clock, service kind or session id: `now`
// comes from the server clock and `activeSession` from a server-side read of
// service_session_state / service_sessions (the same tables the ensure/close
// lifecycle already owns). The Postgres trigger ordenes_assign_service_session
// remains the final fail-closed defence — this module only lets the backend
// return a typed, human-safe rejection BEFORE attempting the insert instead of
// surfacing an opaque DB error.
// ===============================================================

const { sbSelect } = require("../utils/supabase");
const { DEFAULT_SCHEDULE, resolveSchedule } = require("../schedule/serviceSchedule");

const INTAKE_CODE = Object.freeze({
  ORDER_INTAKE_CLOSED: "ORDER_INTAKE_CLOSED",
  NO_OPEN_SERVICE_SESSION: "NO_OPEN_SERVICE_SESSION",
  SERVICE_SESSION_NOT_ORDERABLE: "SERVICE_SESSION_NOT_ORDERABLE",
  STALE_SERVICE_SESSION: "STALE_SERVICE_SESSION",
  SERVICE_KIND_MISMATCH: "SERVICE_KIND_MISMATCH",
  LEGACY_SESSION_KIND_UNKNOWN: "LEGACY_SESSION_KIND_UNKNOWN",
});

const MESSAGES = Object.freeze({
  [INTAKE_CODE.ORDER_INTAKE_CLOSED]: "La recepción de nuevos pedidos está cerrada para este servicio.",
  [INTAKE_CODE.NO_OPEN_SERVICE_SESSION]: "No hay un servicio abierto para recibir nuevos pedidos.",
  [INTAKE_CODE.SERVICE_SESSION_NOT_ORDERABLE]: "El servicio activo ya no admite nuevos pedidos (en cierre).",
  [INTAKE_CODE.STALE_SERVICE_SESSION]: "El servicio activo pertenece a otra fecha operativa. Ciérralo antes de recibir nuevos pedidos.",
  [INTAKE_CODE.SERVICE_KIND_MISMATCH]: "El servicio activo no corresponde a la franja horaria actual.",
  [INTAKE_CODE.LEGACY_SESSION_KIND_UNKNOWN]: "El servicio activo no tiene un tipo de servicio reconocido.",
});

function rejection(code, when, sourceChannel) {
  return Object.freeze({
    allowed: false,
    code,
    detail: MESSAGES[code],
    scheduleState: when.state,
    serviceKind: when.serviceKind || null,
    businessDate: when.businessDate,
    sourceChannel: sourceChannel || null,
  });
}

// Pure. Same input, same output — provable offline with an injected clock and a
// fabricated session, no database, no deploy.
function evaluateNewOrderIntake({ now = new Date(), activeSession = null, sourceChannel = null, schedule = DEFAULT_SCHEDULE } = {}) {
  const when = resolveSchedule(now, schedule);

  if (!when.canCreateNewOrder) {
    return rejection(INTAKE_CODE.ORDER_INTAKE_CLOSED, when, sourceChannel);
  }
  // canCreateNewOrder is only ever true where the canonical resolver also sets
  // a concrete serviceKind (PRANZO_WINDOW / SERA_WINDOW today).
  if (!activeSession) {
    return rejection(INTAKE_CODE.NO_OPEN_SERVICE_SESSION, when, sourceChannel);
  }
  if (activeSession.status !== "open") {
    return rejection(INTAKE_CODE.SERVICE_SESSION_NOT_ORDERABLE, when, sourceChannel);
  }
  if (!activeSession.serviceKind) {
    return rejection(INTAKE_CODE.LEGACY_SESSION_KIND_UNKNOWN, when, sourceChannel);
  }
  if (!activeSession.businessDate || activeSession.businessDate !== when.businessDate) {
    return rejection(INTAKE_CODE.STALE_SERVICE_SESSION, when, sourceChannel);
  }
  if (activeSession.serviceKind !== when.serviceKind) {
    return rejection(INTAKE_CODE.SERVICE_KIND_MISMATCH, when, sourceChannel);
  }

  return Object.freeze({
    allowed: true,
    code: "ALLOWED",
    detail: null,
    scheduleState: when.state,
    serviceKind: when.serviceKind,
    businessDate: when.businessDate,
    sourceChannel: sourceChannel || null,
  });
}

// ── The active-session read ─────────────────────────────────────────────────
// Plain reads on the tables the ensure/close lifecycle already owns — no new RPC,
// no new SQL. Deliberately does NOT fall back to the "recently closed" session
// the closeout view uses: for intake purposes a closed/absent session is simply
// "no open service session".
async function fetchActiveServiceSession({ select = sbSelect } = {}) {
  const stateRows = await select("service_session_state", "singleton=eq.true&limit=1");
  const stateRow = Array.isArray(stateRows) ? stateRows[0] : null;
  const currentId = stateRow && stateRow.current_session_id;
  if (!currentId) return null;

  const sessionRows = await select("service_sessions", `id=eq.${encodeURIComponent(currentId)}&limit=1`);
  const row = Array.isArray(sessionRows) ? sessionRows[0] : null;
  if (!row) return null;

  return {
    id: row.id,
    status: row.status || null,
    serviceKind: row.service_kind || null,
    businessDate: row.business_date || null,
  };
}

// ── The async gate creaOrdine (and every other insert boundary) calls ──────────
function createGateNewOrderIntake({
  fetchActiveSession = fetchActiveServiceSession,
  schedule = DEFAULT_SCHEDULE,
  now = () => new Date(),
} = {}) {
  return async function gateNewOrderIntake({ sourceChannel = null } = {}) {
    let session = null;
    try {
      session = await fetchActiveSession();
    } catch (e) {
      // A transport/read failure must fail CLOSED, not silently allow a new order.
      session = null;
    }
    return evaluateNewOrderIntake({ now: now(), activeSession: session, sourceChannel, schedule });
  };
}

const gateNewOrderIntake = createGateNewOrderIntake();

module.exports = {
  INTAKE_CODE,
  evaluateNewOrderIntake,
  fetchActiveServiceSession,
  createGateNewOrderIntake,
  gateNewOrderIntake,
};
