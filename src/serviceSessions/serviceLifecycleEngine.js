"use strict";
// ===============================================================
// serviceLifecycleEngine.js — SERVICE LIFECYCLE V3 / Slice 3.2
//
// The authoritative V3 close engine — HAPPY PATH ONLY. NEW ENGINE, NO LEGACY
// language-guard: allow-legacy chiudiServizio/servizio.js/storico/serata_summary are named here only to state what this file does NOT reference, not new vocabulary
// CLOSEOUT: this file never requires src/utils/servizio.js (chiudiServizio),
// language-guard: allow-legacy storico/serata_summary are named here only to state what this file does NOT reference, not new vocabulary
// never references storico/serata_summary, and never calls
// begin_service_session_close (see tests/serviceLifecycleV3EngineLegacyNon
// Interference.static.test.js, which proves exactly that).
//
// Flow (mirrors src/serviceSessions/incidentSafeRollover.js's orchestration
// style — DI factory, discriminated {success,code,...} results — but is a
// SEPARATE engine, not an extension of it):
//   acquire/resume close attempt -> capture immutable snapshot -> reconcile
//   deterministic close facts from CANONICAL live data -> persist the
//   authoritative service_closeout -> mark the service closed -> mark the
//   attempt completed.
//
// Any anomaly (a non-terminal order, any unpaid exposure) stops the engine
// BEFORE any mutation and returns V3_CLOSE_UNSUPPORTED_NON_HAPPY_PATH — no
// incident classification, no auto-resolution, no fallback to the legacy
// engine. That is V3.3's job. Opening the next service is also out of scope
// for this slice; the engine ends once the current service is closed.
// ===============================================================

const { sbSelect } = require("../utils/supabase");
const { closeoutAttempts } = require("../closeout/closeoutAttempts");
const { closeoutSnapshots } = require("../closeout/closeoutSnapshots");
const { serviceCloseoutCreation } = require("../closeout/serviceCloseoutCreation");
const { serviceLifecycleV3Transition } = require("./serviceLifecycleV3Transition");
const { aggregate } = require("../closeout/currentServiceCloseout");

// language-guard: allow-legacy servizio.js is named here only as a cross-reference to where the same literal terminal-state set also lives, not new vocabulary
// Identical set to guard_service_session_closed_v1 (SQL) / servizio.js /
// rolloverClassifier.js (JS) — see migrations/2026-08-09_service_lifecycle_v3_
// close_engine.sql PART 3 and src/serviceSessions/rolloverClassifier.js:44-47.
// Kept as its own literal here (not imported) so this engine has zero module
// coupling to any legacy-adjacent file — see the non-interference test.
const TERMINAL_ORDER_STATES = new Set([
  // language-guard: allow-legacy COMPLETATO is the existing terminal-state literal, identical to the same set already used repo-wide, not new vocabulary
  "RETIRADO", "COMPLETADO", "COMPLETATO",
  // language-guard: allow-legacy CHIUSO_FORZATO is the same existing terminal-state literal, restated for the same reason
  "CANCELADO", "CANCELLED", "ANULADO", "CHIUSO_FORZATO",
]);

function toCents(euros) {
  return Math.round((Number(euros) || 0) * 100);
}

function createServiceLifecycleEngine({
  select = sbSelect,
  attempts = closeoutAttempts,
  snapshots = closeoutSnapshots,
  closeoutCreation = serviceCloseoutCreation,
  transition = serviceLifecycleV3Transition,
  aggregateCloseout = aggregate,
} = {}) {
  return async function closeServiceV3({ serviceSessionId, source = "v3_engine", actor = "system" } = {}) {
    if (!serviceSessionId) {
      return { success: false, code: "V3_CLOSE_INVALID_SESSION" };
    }

    const sessionFilter = `service_session_id=eq.${encodeURIComponent(serviceSessionId)}`;

    const sessionRows = await select("service_sessions", `id=eq.${encodeURIComponent(serviceSessionId)}`);
    const session = Array.isArray(sessionRows) ? sessionRows[0] : null;
    if (!session || !session.id) {
      return { success: false, code: "V3_CLOSE_SESSION_NOT_FOUND" };
    }
    // A 'closed' session is not rejected outright here: it may be a
    // legitimate retry of THIS engine's own prior run (Phase D/E already
    // succeeded, only Phase F — marking the attempt completed — crashed).
    // Genuinely invalid callers (any other status) are still rejected now;
    // the "closed but not recoverable" case (closed by something other than
    // this engine) is caught below, once canonical orders are actually read.
    const alreadyClosed = session.status === "closed";
    if (!alreadyClosed && !["open", "closing"].includes(session.status)) {
      return { success: false, code: "V3_CLOSE_SESSION_NOT_OPEN", sessionStatus: session.status };
    }

    // Phase A — acquire/resume the closeout attempt. Idempotent: a retry for
    // the same session resumes the SAME active attempt (ALREADY_ACTIVE),
    // never mints a second one (service_closeout_attempts_active_uq).
    let acquireResult;
    try {
      acquireResult = await attempts.acquire({ serviceSessionId, actor });
    } catch (e) {
      return { success: false, code: "V3_CLOSE_ATTEMPT_ACQUIRE_FAILED", detail: String((e && e.message) || e) };
    }
    if (!acquireResult.success) {
      return { success: false, code: acquireResult.code || "V3_CLOSE_ATTEMPT_ACQUIRE_FAILED" };
    }
    const closeoutCorrelationId = acquireResult.attempt.closeoutCorrelationId;

    // Phase B — read canonical live state and capture it as immutable
    // evidence BEFORE any mutation. The snapshot is recovery/audit evidence;
    // Phase C reconciles from these SAME canonical rows directly, never from
    // the frozen payload (the snapshot is not the reconciliation source).
    let orders, tableSessions, financialEvents;
    try {
      [orders, tableSessions, financialEvents] = await Promise.all([
        select("ordenes", sessionFilter),
        select("table_sessions", sessionFilter),
        select("order_financial_events", sessionFilter),
      ]);
    } catch (e) {
      return { success: false, code: "V3_CLOSE_LIVE_STATE_READ_FAILED", closeoutCorrelationId, detail: String((e && e.message) || e) };
    }
    if (!Array.isArray(orders) || !Array.isArray(tableSessions) || !Array.isArray(financialEvents)) {
      return { success: false, code: "V3_CLOSE_LIVE_STATE_SHAPE_INVALID", closeoutCorrelationId };
    }
    // The "closed by something other than this engine" case: this engine
    // never deletes/archives orders (NEW ENGINE, NO LEGACY CLOSEOUT), so a
    // session it genuinely closed always still has its real orders in
    // `ordenes`. A closed session with zero orders here was closed by a
    // different mechanism entirely (e.g. the legacy engine, which archives
    // them elsewhere) — reconciling that as an empty happy-path service would
    // fabricate a wrong closeout, so this refuses instead.
    if (alreadyClosed && orders.length === 0) {
      return { success: false, code: "V3_CLOSE_SESSION_ALREADY_CLOSED_NOT_RECOVERABLE", closeoutCorrelationId };
    }

    const captureResult = await snapshots.capture({
      serviceSessionId,
      closeoutCorrelationId,
      capturedBy: actor,
      source,
      payload: { session, orders, tableSessions, financialEvents },
    });
    if (!captureResult.success) {
      return { success: false, code: captureResult.code || "V3_CLOSE_SNAPSHOT_FAILED", closeoutCorrelationId };
    }

    // Phase C — deterministic reconciliation. `orders` is already scoped by
    // ordenes.service_session_id — the CURRENT-service assignment
    // ordenes_assign_service_session writes (V3.1's fix, 4252241), never
    // table_sessions' historical origin service — so a table that survived a
    // service boundary contributes its NEW orders to the session actually
    // being closed here, not to whatever session it opened under.
    const closeout = aggregateCloseout(session, orders, financialEvents);

    const nonTerminalCount = orders.filter(
      (o) => !TERMINAL_ORDER_STATES.has(String((o && o.estado) || "").toUpperCase())
    ).length;
    const unpaidExposureCents = toCents(closeout.totals.unpaid);

    // HAPPY PATH ONLY — no incident classification, no auto-resolution, no
    // fallback to the legacy engine. Stops here, before any mutation; the
    // attempt stays 'active' and recoverable for a future retry.
    if (nonTerminalCount > 0 || unpaidExposureCents !== 0) {
      return {
        success: false,
        code: "V3_CLOSE_UNSUPPORTED_NON_HAPPY_PATH",
        reason: nonTerminalCount > 0 ? "NON_TERMINAL_ORDERS" : "UNPAID_EXPOSURE",
        nonTerminalCount,
        unpaidExposureCents,
        closeoutCorrelationId,
      };
    }

    const grossSalesCents = toCents(closeout.totals.gross);
    const refundedCents = toCents(closeout.totals.refunded);
    const cashAmountCents = toCents(closeout.paymentTotals.efectivo);
    const cardAmountCents = toCents(closeout.paymentTotals.tarjeta);
    const bizumAmountCents = toCents(closeout.paymentTotals.bizum);
    const otherAmountCents = toCents(closeout.paymentTotals.other);
    // Constructed as the exact sum of the four buckets (never independently
    // rounded from totals.collected) so service_closeouts_payment_breakdown_
    // chk holds by definition, not by coincidence. If that construction ever
    // disagrees with the ledger's own collected total by more than one
    // rounding cent, that is treated as a genuine inconsistency, not silently
    // trusted either way.
    const paidAmountCents = cashAmountCents + cardAmountCents + bizumAmountCents + otherAmountCents;
    const collectedCentsFromLedger = toCents(closeout.totals.collected);
    if (Math.abs(paidAmountCents - collectedCentsFromLedger) > 1) {
      return { success: false, code: "V3_CLOSE_RECONCILIATION_MISMATCH", closeoutCorrelationId };
    }
    const voidCents = toCents(
      closeout.tickets.filter((t) => t.cancelled).reduce((sum, t) => sum + (Number(t.amount) || 0), 0)
    );
    const netSalesCents = Math.max(0, grossSalesCents - refundedCents);
    const occupiedTablesAtClose = tableSessions.filter((t) => t.status === "open").length;

    // Phase D — persist the ONE authoritative service_closeouts row.
    const createResult = await closeoutCreation.create({
      serviceSessionId,
      closeoutCorrelationId,
      closedBy: actor,
      source,
      grossSalesCents,
      netSalesCents,
      totalRefundsCents: refundedCents,
      totalVoidCents: voidCents,
      paidAmountCents,
      unpaidExposureCents: 0,
      orderCount: closeout.counts.tickets,
      cashAmountCents,
      cardAmountCents,
      bizumAmountCents,
      otherAmountCents,
      openOrdersAtClose: 0,
      occupiedTablesAtClose,
    });
    if (!createResult.success) {
      return { success: false, code: createResult.code || "V3_CLOSE_CLOSEOUT_PERSIST_FAILED", closeoutCorrelationId };
    }

    // Phase E — the V3-native terminal transition. occupiedTablesAtClose > 0
    // does NOT block this — see the migration's PART 3 for exactly why that
    // is safe (gated on the service_closeouts row Phase D just created).
    const transitionResult = await transition.close({ serviceSessionId, closeoutCorrelationId, actor, source });
    if (!transitionResult.success) {
      return {
        success: false,
        code: transitionResult.code || "V3_CLOSE_TRANSITION_FAILED",
        closeoutCorrelationId,
        closeout: createResult.closeout,
      };
    }

    // Phase F — mark the attempt completed. Non-fatal if this fails: the
    // session is already closed and the closeout already persisted, so a
    // failed completion is never retried into a duplicate (same pattern as
    // incidentSafeRollover.js's own final step).
    try {
      await attempts.complete({ closeoutCorrelationId, actor });
    } catch (e) {
      console.warn(
        "[serviceLifecycleEngine] marking the attempt completed failed (non-fatal — the session is already closed and the closeout already persisted):",
        (e && e.message) || e
      );
    }

    return {
      success: true,
      code: "V3_CLOSED",
      closeoutCorrelationId,
      closeout: createResult.closeout,
      session: transitionResult.session,
      occupiedTablesAtClose,
    };
  };
}

const closeServiceV3 = createServiceLifecycleEngine();

module.exports = { createServiceLifecycleEngine, closeServiceV3 };
