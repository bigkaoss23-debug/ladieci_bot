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
const { classifySessionForRollover, isRolloverDue } = require("./sessionRolloverClassification");
const { performIncidentSafeRollover } = require("./incidentSafeRollover");

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

// ── Self-healing read — RUNTIME LIFECYCLE AUTHORITY RECOVERY ───────────────
// The legacy no-human automatic family (index.js's close-tick timer, boot
// catch-up, external-cron endpoint) and ensureServiceSession.js's own
// page-load rollover are ALL gated behind LEGACY_AUTOMATIC_LIFECYCLE_ENABLED
// (false on staging since the 2026-08-09 freeze — and, since the 2026-08-10
// P0-C1 fix, that now covers the page-load path too, correctly closing the
// language-guard: allow-legacy — PRANZO is the existing service_kind enum value, named here only to describe the incident, not new vocabulary
// loophole that produced that day's stuck-PRANZO incident). The consequence,
// proven live on 2026-08-12 (see SERVICE_LIFECYCLE_RUNTIME_AUTHORITY_
// RECOVERY_REPORT.md): with all four frozen, a stale session now persists
// forever until a human explicitly closes it — order intake (Mesa, WhatsApp,
// Telefono, every channel; they all share this one gate, see
// orderIntakePolicy.test.js's own #19-23) fails with STALE_SERVICE_SESSION
// indefinitely, not just once.
//
// This is a NEW, narrowly-scoped safety net at a DIFFERENT trigger point —
// an actual new-order attempt, i.e. "an explicit operational mutation", not
// a page load — and is deliberately NOT gated by LEGACY_AUTOMATIC_LIFECYCLE_
// ENABLED: that flag exists to freeze the old no-human TIMER family, not to
// forbid reconciliation forever. It reuses the exact same already-hardened,
// concurrency-safe, incident-preserving engine every other caller already
// trusts (classifySessionForRollover + performIncidentSafeRollover — the
// same functions ensureServiceSession.js calls) — no new mutation logic, no
// new close/rollover implementation. Best-effort and fail-open-to-the-gate:
// a failed or deferred rollover simply returns the still-stale session, so
// evaluateNewOrderIntake's own STALE_SERVICE_SESSION rejection still applies
// exactly as it does today — this can only make intake succeed MORE often
// than before, never bypass or weaken the gate itself.
async function fetchActiveServiceSessionSelfHealing({
  select = sbSelect,
  actor = "system",
  source = "order_intake_reconcile",
  rollover = performIncidentSafeRollover,
  now = () => new Date(),
} = {}) {
  const session = await fetchActiveServiceSession({ select });
  if (!session) return session;

  const classification = classifySessionForRollover(
    { business_date: session.businessDate, service_kind: session.serviceKind },
    now(),
  );
  if (!isRolloverDue(classification)) return session;

  try {
    // performIncidentSafeRollover forwards this object into
    // rolloverClassifier.js's classifyForIncidentSafeRollover, which needs
    // business_date/service_kind (snake_case, matching the raw DB row shape
    // every other caller of this engine already passes) to classify at all
    // -- {id} alone hard-blocks with SESSION_IDENTITY_INVALID, proven live
    // against the real 2026-08-11 stale session before this fix.
    const result = await rollover({
      session: { id: session.id, business_date: session.businessDate, service_kind: session.serviceKind },
      actor, source,
    });
    if (result && result.success === true) {
      // Rolled over (possibly with incidents) — re-read so the caller sees
      // the fresh/newly-opened current session, not the one just closed.
      return await fetchActiveServiceSession({ select });
    }
  } catch (_) {
    // Never let a reconciliation failure crash order intake. Fall through —
    // the caller gets the still-stale session and the ordinary
    // STALE_SERVICE_SESSION rejection applies, unchanged from today.
  }
  return session;
}

// ── The async gate creaOrdine (and every other insert boundary) calls ──────────
function createGateNewOrderIntake({
  fetchActiveSession = fetchActiveServiceSessionSelfHealing,
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
  fetchActiveServiceSessionSelfHealing,
  createGateNewOrderIntake,
  gateNewOrderIntake,
};
