"use strict";
// ===============================================================
// orderIntakePolicy.js — R-DAY3 RETARGET
//
// POST-R-DAY3 ROLE: ADVISORY UX PREFLIGHT ONLY. Zero permission authority
// over Service Period. The canonical, authoritative order-intake decision is
// made by public.resolve_order_intake_context_v1(), called from the
// service_session_assign_order() trigger INSIDE the order INSERT's own
// transaction (migrations/2026-08-16_r_day3_business_day_intake_authority.sql).
// This module's only remaining job is to give the caller a typed, human-
// readable rejection BEFORE attempting the insert. A race between this
// preflight and the DB resolver can only make the DB MORE strict, never
// looser — the forbidden state ("JS says YES, DB says NO on a different
// model") is structurally unreachable, because this module no longer has an
// independent Service-Period model to disagree with.
//
// REMOVED in this retarget (R_DAY3_INTAKE_AUTHORITY_AMENDMENT_V1_2026-08-16.md
// §5/§20, and its Sonnet-implementation follow-up): fetchActiveServiceSession,
// fetchActiveServiceSessionSelfHealing, and every Service-Period permission
// branch this module used to own (NO_OPEN_SERVICE_SESSION,
// SERVICE_SESSION_NOT_ORDERABLE, STALE_SERVICE_SESSION, SERVICE_KIND_
// MISMATCH, LEGACY_SESSION_KIND_UNKNOWN). This module no longer reads
// service_session_state/service_sessions and no longer calls
// classifySessionForRollover / performIncidentSafeRollover — those, and
// sessionRolloverClassification.js / incidentSafeRollover.js themselves, are
// retired from the order-intake critical path entirely (still reachable for
// unrelated manual/admin recovery, never for a brand-new order's permission).
//
// The one remaining product rule — the intake schedule window — is
// DB-canonical (owner erratum 2, this R-DAY3 pass): get_order_intake_
// context_v1() computes the exact same business_date / service_kind /
// canCreateNewOrder facts the in-transaction resolver itself computes,
// mirrored constant-for-constant from src/schedule/serviceSchedule.js's
// DEFAULT_SCHEDULE (parity proof: tests/rDay3ScheduleParity.test.js). This
// module only surfaces that read-only result as a friendly typed message; it
// never decides on its own, and a read failure here fails OPEN (the DB
// backstop remains authoritative either way — see evaluateNewOrderIntake).
// ===============================================================

const { sbRpc } = require("../utils/supabase");

const INTAKE_CODE = Object.freeze({
  ORDER_INTAKE_CLOSED: "ORDER_INTAKE_CLOSED",
});

const MESSAGES = Object.freeze({
  [INTAKE_CODE.ORDER_INTAKE_CLOSED]: "La recepción de nuevos pedidos está cerrada para este servicio.",
});

function rejection(code, ctx, sourceChannel) {
  return Object.freeze({
    allowed: false,
    code,
    detail: MESSAGES[code] || null,
    scheduleState: code,
    serviceKind: (ctx && ctx.serviceKind) || null,
    businessDate: (ctx && ctx.businessDate) || null,
    sourceChannel: sourceChannel || null,
  });
}

function allowedResult(ctx, sourceChannel) {
  return Object.freeze({
    allowed: true,
    code: "ALLOWED",
    detail: null,
    scheduleState: "OPEN",
    serviceKind: (ctx && ctx.serviceKind) || null,
    businessDate: (ctx && ctx.businessDate) || null,
    sourceChannel: sourceChannel || null,
  });
}

// Pure given an already-resolved context — provable offline with a
// fabricated ctx, no database, no deploy.
function evaluateNewOrderIntake({ ctx = null, sourceChannel = null } = {}) {
  if (!ctx) {
    // Preflight read failure (transport error, RPC unavailable, etc). FAILS
    // OPEN deliberately: the DB resolver inside the INSERT transaction is
    // the sole final authority regardless of this preflight's own health. If
    // the schedule window really is closed, the caller instead sees the DB's
    // own ORDER_INTAKE_CLOSED rejection surfaced from the insert attempt —
    // never a silent bypass, just a less friendly error path.
    return allowedResult(null, sourceChannel);
  }
  // O-2 — canCreateNewOrder is the pure overnight-floor clock fact;
  // hasValidCurrentService is the continuity fact (a service already open
  // for TODAY's business date may keep taking orders straight through
  // 00:00-08:00). Either one is enough. A stale read here can only make the
  // DB-canonical resolve_order_intake_context_v1 MORE strict, never looser —
  // it re-derives both facts from scratch under its own lock.
  if (ctx.canCreateNewOrder !== true && ctx.hasValidCurrentService !== true) {
    return rejection(INTAKE_CODE.ORDER_INTAKE_CLOSED, ctx, sourceChannel);
  }
  return allowedResult(ctx, sourceChannel);
}

// ── The read — DB-canonical, read-only, no lock, no lifecycle mutation ─────
async function fetchOrderIntakeContext({ rpc = sbRpc } = {}) {
  try {
    const r = await rpc("get_order_intake_context_v1", {});
    if (!r || r.ok !== true || !r.body || typeof r.body !== "object") return null;
    return r.body;
  } catch (_) {
    return null;
  }
}

// ── The async gate creaOrdine (and every other insert boundary) calls ──────
function createGateNewOrderIntake({ fetchContext = fetchOrderIntakeContext } = {}) {
  return async function gateNewOrderIntake({ sourceChannel = null } = {}) {
    const ctx = await fetchContext();
    return evaluateNewOrderIntake({ ctx, sourceChannel });
  };
}

const gateNewOrderIntake = createGateNewOrderIntake();

module.exports = {
  INTAKE_CODE,
  evaluateNewOrderIntake,
  fetchOrderIntakeContext,
  createGateNewOrderIntake,
  gateNewOrderIntake,
};
