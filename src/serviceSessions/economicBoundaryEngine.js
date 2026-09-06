"use strict";
// language-guard: allow-legacy chiudiServizio/servizio.js/PRANZO/COMPLETATO/CHIUSO_FORZATO are the existing identifiers/enum-value/terminal-state literals this file names for audit context or reuses verbatim in its own TERMINAL_ORDER_STATES set (identical to serviceLifecycleEngine.js's own, per that file's own established discipline), not new vocabulary
// ===============================================================
// economicBoundaryEngine.js — SERVICE LIFECYCLE / P0-C2
//
// THE non-destructive intraday economic-boundary orchestrator. Reuses the
// SAME V3 closeout-attempt/snapshot/creation primitives serviceLifecycleEngine.js
// (V3's own close engine, still unreachable from any live entry point — see
// that file's own header) already established, wired here against
// roll_service_session_economic_v1 (2026-08-10_service_lifecycle_economic_
// boundary_v1.sql) instead of close_service_session_v3 — the one part of
// V3's own engine this deliberately does NOT reuse, because
// close_service_session_v3 sets status='closed', which guard_service_
// session_closed_v1's unconditional SERVICE_ACTIVE_ORDERS_NOT_RESOLVED check
// would then hard-block for any session with real non-terminal orders — the
// language-guard: allow-legacy PRANZO is the existing service_kind enum value, named here only to describe the boundary, not new vocabulary
// ordinary, expected case for an intraday PRANZO->SERA boundary (see
// SERVICE_LIFECYCLE_ECONOMIC_BOUNDARY_AUDIT_REPORT.md and
// P0_C2_INTRADAY_ECONOMIC_BOUNDARY_REPORT.md §2/§4 for the full audit).
//
// INCIDENT SEMANTICS — deliberately minimal for the ROLL ITSELF, per the
// clarified product contract: a non-terminal order, an open table, an unpaid
// balance, or an in-progress delivery crossing an intraday (SAME business_
// date) boundary is NORMAL CARRYOVER, not an anomaly, and Phases A-F never
// persist a service_incidents row for it — v3IncidentPolicy.js's
// classification exists for V3's own (still unreachable) close path and is
// deliberately NOT reused here: reusing it would incorrectly turn ordinary
// carryover into noise ("These are NOT incidents merely because they cross
// the cutoff" — P0-C2 brief, verbatim). The one thing Phases A-F still treat
// as a hard integrity failure is a reconciliation mismatch (paid amount vs.
// the ledger's own collected total) — the same check serviceLifecycleEngine.
// js already performs before ever persisting a closeout. Non-terminal/
// occupied-table counts are still recorded on the closeout row itself
// (openOrdersAtClose/occupiedTablesAtClose) for reporting — captured as
// fact, never as alarm.
//
// P0-C3 ADDS Phase G — the SAME non-terminal-order/open-table facts DO
// become an incident once they cross a business_date, never merely a same-
// day service_kind change (see previousBusinessDayResidue.js): "ordinary
// intraday carryover" and "previous-business-day operational residue" are
// deliberately different classifications for the same underlying data,
// selected purely by which boundary was actually crossed.
//
// NO SCHEDULER WIRED HERE. This engine is a pure, callable, idempotent
// primitive — see index.js's "rollEconomicPeriod" HTTP action (admin-only,
// explicit) for the one deliberate call site this slice adds. Whether a
// future slice wires this into an always-on trigger is a distinct, separate
// decision (P0_C2 report §7) — matching P0-C1's own "build the primitive,
// prove it independently" precedent.
// ===============================================================

const { sbSelect, sbRpc } = require("../utils/supabase");
const { closeoutAttempts } = require("../closeout/closeoutAttempts");
const { closeoutSnapshots } = require("../closeout/closeoutSnapshots");
const { serviceCloseoutCreation } = require("../closeout/serviceCloseoutCreation");
const { aggregate } = require("../closeout/currentServiceCloseout");
const { resolveEconomicPeriod, DEFAULT_SCHEDULE } = require("../schedule/serviceSchedule");
const { lifecycle } = require("./serviceSessionLifecycle");
const { reconcilePreviousBusinessDayResidue } = require("./previousBusinessDayResidue");

// Identical literal to serviceLifecycleEngine.js's own TERMINAL_ORDER_STATES /
// v3IncidentPolicy.js / guard_service_session_closed_v1 (SQL). Kept as its
// own literal (not imported) for the same "zero module coupling" discipline
// serviceLifecycleEngine.js's own header already established.
// language-guard: allow-legacy COMPLETATO/CHIUSO_FORZATO are the existing terminal-state literals, identical to the same set already used repo-wide (serviceLifecycleEngine.js, v3IncidentPolicy.js), not new vocabulary
const TERMINAL_ORDER_STATES = new Set([
  "RETIRADO", "COMPLETADO", "COMPLETATO",
  "CANCELADO", "CANCELLED", "ANULADO", "CHIUSO_FORZATO",
]);

function toCents(euros) {
  return Math.round((Number(euros) || 0) * 100);
}

function createEconomicBoundaryEngine({
  select = sbSelect,
  rpc = sbRpc,
  attempts = closeoutAttempts,
  snapshots = closeoutSnapshots,
  closeoutCreation = serviceCloseoutCreation,
  aggregateCloseout = aggregate,
  sessionLifecycle = lifecycle,
  now = () => new Date(),
  schedule = DEFAULT_SCHEDULE,
  resolvePeriod = resolveEconomicPeriod,
  reconcileResidue = reconcilePreviousBusinessDayResidue,
} = {}) {
  return async function rollEconomicPeriod({ actor, source = "economic_boundary" } = {}) {
    if (!actor || typeof actor !== "string" || !actor.trim()) {
      return { success: false, code: "INVALID_ACTOR" };
    }

    // Read the current session via the SAME lifecycle-authoritative pointer
    // language-guard: allow-legacy chiudiServizio/servizio.js are the existing legacy identifiers named here only for audit context (this file never calls either), not new vocabulary
    // every other reader (getCurrentOperationalSession, chiudiServizio,
    // ensureCurrentServiceSession) already uses.
    let identity;
    try {
      identity = await sessionLifecycle.currentCloseout();
    } catch (e) {
      return { success: false, code: "SERVICE_SESSION_READ_FAILED", detail: String((e && e.message) || e) };
    }
    if (!identity || identity.ok !== true) {
      return { success: false, code: (identity && identity.code) || "SERVICE_SESSION_READ_FAILED" };
    }
    const session = identity.session;
    if (!session || !session.id) {
      return { success: false, code: "NO_SERVICE_SESSION" };
    }
    // Deliberately accepts 'closing' as well as 'open' — a legacy V2 attempt
    // stuck mid-close (session.status='closing') is exactly the case this
    // engine can also reconcile, since roll_service_session_economic_v1
    // itself accepts either (see the migration's own header for why).
    if (!["open", "closing"].includes(session.status)) {
      return { success: false, code: "INVALID_SESSION_STATUS", sessionStatus: session.status };
    }

    const target = resolvePeriod(now(), schedule);
    // Nothing due: the current session's own kind+date already match what the
    // clock says should be current right now. This is the ordinary, expected
    // answer for almost every call during a normal service — never an error,
    // never a mutation.
    if (session.service_kind === target.serviceKind && session.business_date === target.businessDate) {
      return { success: true, code: "NO_ROLLOVER_DUE", session };
    }

    const sessionFilter = `service_session_id=eq.${encodeURIComponent(session.id)}`;

    // Phase A — acquire/resume THE closeout attempt for this session. Same
    // RPC/DAO V2's incidentSafeRollover.js and V3's serviceLifecycleEngine.js
    // both already use — idempotent, resumes an existing ACTIVE attempt
    // regardless of which engine originally created it (acquire_closeout_
    // attempt is keyed by service_session_id alone, origin-agnostic).
    let acquireResult;
    try {
      acquireResult = await attempts.acquire({ serviceSessionId: session.id, actor });
    } catch (e) {
      return { success: false, code: "ECONOMIC_BOUNDARY_ATTEMPT_ACQUIRE_FAILED", detail: String((e && e.message) || e) };
    }
    if (!acquireResult.success) {
      return { success: false, code: acquireResult.code || "ECONOMIC_BOUNDARY_ATTEMPT_ACQUIRE_FAILED" };
    }
    const closeoutCorrelationId = acquireResult.attempt.closeoutCorrelationId;

    // Phase B — read canonical live state, capture immutable evidence BEFORE
    // any mutation (same discipline as serviceLifecycleEngine.js's own Phase B).
    let orders, tableSessions, financialEvents, orderObligations;
    try {
      [orders, tableSessions, financialEvents, orderObligations] = await Promise.all([
        select("ordenes", sessionFilter),
        select("table_sessions", sessionFilter),
        select("order_financial_events", sessionFilter),
        // FINALIZAR V3 CANONICAL CLOSEOUT V1 (fast-follow) — the canonical
        // order_obligations for this service, scoped and ordered exactly as
        // serviceLifecycleEngine.js's Phase B, currentServiceCloseout and
        // economiaLedgerAggregate all do (revision.asc so
        // latestObligationsByOrder picks the top revision). Without this the
        // aggregate() call below fell back to ordenes.totale — the same
        // LEGACY_GROSS_CLOSEOUT_WRITER root cause the Finalizar V3 writer had.
        select("order_obligations", `${sessionFilter}&order=revision.asc`),
      ]);
    } catch (e) {
      return { success: false, code: "ECONOMIC_BOUNDARY_LIVE_STATE_READ_FAILED", closeoutCorrelationId, detail: String((e && e.message) || e) };
    }
    if (!Array.isArray(orders) || !Array.isArray(tableSessions) || !Array.isArray(financialEvents) || !Array.isArray(orderObligations)) {
      return { success: false, code: "ECONOMIC_BOUNDARY_LIVE_STATE_SHAPE_INVALID", closeoutCorrelationId };
    }

    const captureResult = await snapshots.capture({
      serviceSessionId: session.id,
      closeoutCorrelationId,
      capturedBy: actor,
      source,
      // FINALIZAR V3 CANONICAL CLOSEOUT V1 (fast-follow) — orderObligations
      // added additively to the immutable evidence payload so the roll's close
      // artifact alone reconstructs the current obligation (and hence unpaid /
      // over-collected), same as serviceLifecycleEngine.js. schema_version
      // stays 1: the snapshot RPC treats the payload as opaque jsonb and no
      // reader parses its keys.
      payload: { session, orders, tableSessions, financialEvents, orderObligations },
    });
    if (!captureResult.success) {
      return { success: false, code: captureResult.code || "ECONOMIC_BOUNDARY_SNAPSHOT_FAILED", closeoutCorrelationId };
    }

    // Phase C — reconcile. Non-terminal orders/open tables/unpaid balances
    // are NOT hard blockers here (see header) — they simply carry forward,
    // recorded as facts on the closeout row, never as incidents.
    //
    // FINALIZAR V3 CANONICAL CLOSEOUT V1 (fast-follow) — the 4th argument.
    // With orderObligations passed, safeTicket derives every ticket's
    // amount / unpaid / overCollected from the canonical latest obligation
    // revision instead of the legacy ordenes.totale fallback. safeTicket's
    // formulas are unchanged; only the input is now canonical — the exact
    // same call shape serviceLifecycleEngine, currentServiceCloseout and
    // economiaLedgerAggregate all use.
    const closeout = aggregateCloseout(session, orders, financialEvents, orderObligations);
    const nonTerminalCount = orders.filter(
      (o) => !TERMINAL_ORDER_STATES.has(String((o && o.estado) || "").toUpperCase())
    ).length;
    const occupiedTablesAtClose = tableSessions.filter((t) => t.status === "open").length;

    // gross_sales_cents keeps its frozen historical meaning — ORIGINAL ORDER
    // GROSS — so it is sourced from totals.originalGross (Sigma raw
    // ordenes.totale, non-cancelled), NOT totals.gross (which is now the
    // current obligation). net_sales_cents below therefore stays byte-
    // identical to its pre-canonical value.
    const grossSalesCents = toCents(closeout.totals.originalGross);
    // FINALIZAR V3 CANONICAL CLOSEOUT V1 (fast-follow) — the current canonical
    // obligation at roll time (Sigma latest obligation revision, non-cancelled).
    const currentObligationCents = toCents(closeout.totals.gross);
    // Canonical: Sigma max(0, netCollected - currentObligation) per ticket.
    // NEVER netted against unpaid (frozen over-collected invariant).
    const overCollectedCents = toCents(closeout.totals.overCollected);
    const refundedCents = toCents(closeout.totals.refunded);
    const cashAmountCents = toCents(closeout.paymentTotals.efectivo);
    const cardAmountCents = toCents(closeout.paymentTotals.tarjeta);
    const bizumAmountCents = toCents(closeout.paymentTotals.bizum);
    const otherAmountCents = toCents(closeout.paymentTotals.other);
    const paidAmountCents = cashAmountCents + cardAmountCents + bizumAmountCents + otherAmountCents;
    const collectedCentsFromLedger = toCents(closeout.totals.collected);
    // THE one hard integrity check this engine keeps: a genuine
    // reconciliation mismatch is never ordinary carryover, and must never be
    // silently absorbed into a closeout snapshot.
    if (Math.abs(paidAmountCents - collectedCentsFromLedger) > 1) {
      return { success: false, code: "ECONOMIC_BOUNDARY_RECONCILIATION_MISMATCH", closeoutCorrelationId };
    }
    // Canonical: Sigma max(0, currentObligation - netCollected) per ticket.
    const unpaidExposureCents = toCents(closeout.totals.unpaid);
    // Unchanged legacy/historical field: grossSalesCents is still ORIGINAL
    // gross, so this value does not move.
    const netSalesCents = Math.max(0, grossSalesCents - refundedCents);
    // FINALIZAR V3 CANONICAL CLOSEOUT V1 (fast-follow) — total_void_cents keeps
    // its frozen meaning: the ORIGINAL gross of cancelled orders. Sourced from
    // t.originalAmount (raw ordenes.totale) so it is byte-identical to its
    // pre-canonical value; t.amount for a cancelled ticket is now obligation-
    // aware and is deliberately not used here.
    const voidCents = toCents(
      closeout.tickets.filter((t) => t.cancelled).reduce((sum, t) => sum + (Number(t.originalAmount) || 0), 0)
    );

    // Phase D — persist the ONE authoritative service_closeouts row for A.
    // Reuses create_service_closeout (25-parameter, migration 121); zero
    // incidents by design.
    const createResult = await closeoutCreation.create({
      serviceSessionId: session.id,
      closeoutCorrelationId,
      closedBy: actor,
      source,
      closeReason: "intraday_economic_boundary",
      grossSalesCents, netSalesCents,
      totalRefundsCents: refundedCents, totalVoidCents: voidCents,
      paidAmountCents, unpaidExposureCents,
      orderCount: closeout.counts.tickets,
      cashAmountCents, cardAmountCents, bizumAmountCents, otherAmountCents,
      openOrdersAtClose: nonTerminalCount, occupiedTablesAtClose,
      kitchenPendingCount: 0, listoCount: 0, deliveryPendingCount: 0,
      incidentCount: 0, criticalIncidentCount: 0,
      // FINALIZAR V3 CANONICAL CLOSEOUT V1 (fast-follow) — the obligation-aware
      // roll always persists both, non-null (DB pairing CHECK). gross_sales_cents
      // above stays ORIGINAL gross; these two are the canonical facts.
      currentObligationCents,
      overCollectedCents,
    });
    if (!createResult.success) {
      return { success: false, code: createResult.code || "ECONOMIC_BOUNDARY_CLOSEOUT_PERSIST_FAILED", closeoutCorrelationId };
    }

    // Phase E — the non-destructive transition + atomic B creation. Never
    // touches ordenes/table_sessions (see the RPC's own header).
    let rollResult;
    try {
      rollResult = await rpc("roll_service_session_economic_v1", {
        p_service_session_id: session.id,
        p_closeout_correlation_id: closeoutCorrelationId,
        p_actor: actor,
        p_source: source,
        p_next_service_kind: target.serviceKind,
        p_next_business_date: target.businessDate,
      });
    } catch (e) {
      return {
        success: false, code: "ECONOMIC_BOUNDARY_ROLL_FAILED",
        closeoutCorrelationId, closeout: createResult.closeout, detail: String((e && e.message) || e),
      };
    }
    const body = rollResult && rollResult.ok === true ? rollResult.body : null;
    if (!body || body.ok !== true) {
      return {
        success: false,
        code: (body && body.code) || "ECONOMIC_BOUNDARY_ROLL_TRANSPORT_ERROR",
        closeoutCorrelationId, closeout: createResult.closeout,
      };
    }

    // Phase F — mark the attempt completed. Non-fatal if this fails: A is
    // already rolled over, the closeout already persisted, B already exists
    // — a failed completion is never retried into a duplicate of any of
    // those (same pattern as serviceLifecycleEngine.js's own Phase G).
    try {
      await attempts.complete({ closeoutCorrelationId, actor });
    } catch (e) {
      console.warn(
        "[economicBoundaryEngine] marking the attempt completed failed (non-fatal — A is already rolled over and the closeout already persisted):",
        (e && e.message) || e
      );
    }

    // Phase G — P0-C3 previous-business-day residue reconciliation. Fires
    // ONLY when this roll actually crossed a business_date (never on a
    // language-guard: allow-legacy PRANZO is the existing service_kind enum value, named here only to describe the boundary, not new vocabulary
    // same-day PRANZO->SERA rollover, which stays silent/ordinary carryover
    // per P0-C2). Scans every session strictly older than the NEW current
    // business_date, not just the one just settled here, so a reconciliation
    // that was missed for several days still catches up in one call — see
    // previousBusinessDayResidue.js's own header. Non-fatal: a failure here
    // never unwinds the roll that already committed (same "already true,
    // don't retry into a duplicate" posture as Phase F above).
    let residue = null;
    if (target.businessDate !== session.business_date) {
      try {
        residue = await reconcileResidue({ actor, source, currentBusinessDate: target.businessDate });
      } catch (e) {
        console.warn(
          "[economicBoundaryEngine] previous-business-day residue reconciliation failed (non-fatal — the roll itself already committed):",
          (e && e.message) || e
        );
      }
    }

    return {
      success: true,
      code: body.code,
      idempotent: body.idempotent === true,
      closeoutCorrelationId,
      closeout: createResult.closeout,
      sessionA: body.sessionA,
      sessionB: body.sessionB,
      carryover: { nonTerminalOrders: nonTerminalCount, occupiedTables: occupiedTablesAtClose },
      residue,
    };
  };
}

const rollEconomicPeriod = createEconomicBoundaryEngine();

module.exports = { createEconomicBoundaryEngine, rollEconomicPeriod, TERMINAL_ORDER_STATES };
