"use strict";
// ===============================================================
// serviceLifecycleEngine.js — SERVICE LIFECYCLE V3 / Slice 3.2
//
// The authoritative V3 close engine. NEW ENGINE, NO LEGACY
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
//   deterministic close facts from CANONICAL live data -> classify non-hard
//   anomalies into incidents -> persist every required incident -> apply safe
//   auto-actions (only after every incident is durable) -> persist the
//   authoritative service_closeout -> mark the service closed -> mark the
//   attempt completed.
//
// SLICE 3.3 — a non-terminal order or unpaid exposure no longer stops the
// engine (the old V3_CLOSE_UNSUPPORTED_NON_HAPPY_PATH gate is gone): each
// becomes a persisted service_incidents row via v3IncidentPolicy.js's single
// classification/policy authority, and the service still closes. ONLY a true
// integrity failure remains a hard blocker: a reconciliation mismatch
// (unchanged from Slice 3.2), an invalid lineage (unchanged from Slice
// 3.2.1), or a failure to durably persist a REQUIRED incident (Slice 3.3).
// DELIVERY x ECONOMY DECOUPLING (migration 139): a rider trip is NOT a close
// blocker. Whether a driver has left, is back, or which status a trip has is an
// operational (Delivery) fact; it must never decide whether the economic
// service can be finalized. An order still EN_ENTREGA at the close is handled
// by the incident policy below ("Finalizar con pendientes"): the delivery stays
// to be confirmed, the unpaid amount stays a pending, both stay recoverable,
// and the departed trip stays visible and completable. The database keeps only
// the other half of the invariant: a NEW trip can never depart for a service
// that is no longer open (start_rider_trip_v2 -> SERVICE_NOT_OPEN).
//
// F-5 — SLICE 3.4's "ensure/reuse the next current service B" step has been
// RETIRED from this engine (not adapted, not made operational_service_v1-
// aware). Finalizar servicio CLOSES the Operational Service; it does not
// automatically open another one.
// -- language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values, named here only to describe the design principle, not new vocabulary
// Clock/schedule state (PRANZO/SERA) must never determine post-close
// service identity — a second Operational
// Service in the same Business Day exists only after genuine termination
// plus an intentional, explicit reopen (a future contract, not this file's
// job). v3NextServiceIdentity.js (the clock-derived successor-identity rule)
// -- language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values, named here only to describe the retired DB primitive, not new vocabulary
// and its use of ensure_next_service_session_v3 (the PRANZO/SERA-only DB
// primitive) are gone from this path; see the F-5 report for the full
// writer-inventory/retirement disposition. The engine now ends at Phase E:
// acquire -> snapshot -> reconcile -> classify/persist incidents -> safe
// actions -> closeout A -> close A -> carryover summary -> complete the
// attempt. Carryover itself remains a NON-EVENT by design: an open table
// keeps its immutable origin (table_sessions.service_session_id still =
// A — never rewritten, see V3.1) and A's financial/incident facts are frozen
// and never touched here; this file no longer creates or reuses any B for a
// new order to be attributed to in the first place.
// ===============================================================

const { sbSelect } = require("../utils/supabase");
const { closeoutAttempts } = require("../closeout/closeoutAttempts");
const { closeoutSnapshots } = require("../closeout/closeoutSnapshots");
const { closeoutRpcArgs } = require("../closeout/serviceCloseoutCreation");
const { serviceCloseouts, publicCloseout } = require("../closeout/serviceCloseouts");
const { serviceLifecycleV3Transition, publicSession } = require("./serviceLifecycleV3Transition");
const { aggregate } = require("../closeout/currentServiceCloseout");
const { serviceIncidents } = require("../incidents/serviceIncidents");
const { classifyForV3Close } = require("./v3IncidentPolicy");
const mesaDao = require("../tables/mesaDao");
const { closeoutReconciliation } = require("../economy/closeoutReconciliation");

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

// CORRECTIVE SLICE 150 — the terminal step judged a round's evidence stale;
// a module-private marker, never part of any response.
const EVIDENCE_STALE = Symbol("V3_CLOSE_EVIDENCE_STALE_ROUND");
// A service that keeps changing under every round is refused rather than
// chased forever; each round that lost the race left nothing committed.
const MAX_EVIDENCE_ROUNDS = 3;

function toCents(euros) {
  return Math.round((Number(euros) || 0) * 100);
}

function createServiceLifecycleEngine({
  select = sbSelect,
  attempts = closeoutAttempts,
  snapshots = closeoutSnapshots,
  closeouts = serviceCloseouts,
  transition = serviceLifecycleV3Transition,
  aggregateCloseout = aggregate,
  incidents = serviceIncidents,
  releaseEmptyTable = mesaDao.releaseEmptySessionAuto,
  classify = classifyForV3Close,
  // J-1 — the economic context this close is made under. Injected like every
  // other collaborator so the engine stays unit-testable without a database,
  // and so a test can prove the close FAILS CLOSED when this cannot persist.
  reconciliation = closeoutReconciliation,
  now = () => new Date(),
} = {}) {
  // SLICE 3.4 — the carryover summary: which tables are STILL open, with
  // their origin STILL this session (table_sessions.service_session_id is
  // never rewritten at close — see V3.1). Read fresh, AFTER close, so a
  // table released by an earlier Phase C.2 safe-action is correctly
  // excluded. Read-only — carryover is a non-event, never a mutation.
  async function computeCarryoverSummary(serviceSessionId) {
    try {
      const rows = await select("table_sessions", `service_session_id=eq.${encodeURIComponent(serviceSessionId)}`);
      const open = (Array.isArray(rows) ? rows : []).filter((t) => t.status === "open");
      return { openTablesCarried: open.length, openTableSessionIds: open.map((t) => t.id), readFailed: false };
    } catch (e) {
      return { openTablesCarried: null, openTableSessionIds: [], readFailed: true, detail: String((e && e.message) || e) };
    }
  }

  const projectRecon = (row) => (typeof reconciliation.projectReconciliation === "function" ? reconciliation.projectReconciliation(row) : row);

  // CORRECTIVE SLICE 150 — the receipts attributed to this service (its cash
  // drawer: payment_transactions.service_session_id), read BEFORE the
  // reconciliation is built. The terminal step re-reads the same set under the
  // close's lock prefix and refuses the close (CLOSE_EVIDENCE_STALE) unless it is
  // unchanged, so the persisted reconciliation can never miss a receipt that
  // committed after it was computed.
  async function readReceiptIds(serviceSessionId) {
    const rows = await select("payment_transactions", `service_session_id=eq.${encodeURIComponent(serviceSessionId)}&select=id`);
    if (!Array.isArray(rows)) throw new Error("payment_transactions read did not return rows");
    return rows.map((r) => String(r.id));
  }

  // R4 — CASE D proof. Reads (never writes, never re-derives) this session's
  // OWN close facts under the attempt's correlation: its snapshot, its
  // closeout and its reconciliation, and checks they were made in the order
  // the V3 close makes them (Phase B -> D -> D.2 -> E), so a session closed by
  // something else BEFORE this closeout existed is never taken as proof.
  // Nothing here reads the current-service pointer or any other service.
  // Every fact is append-only or terminal (closed is terminal; snapshots,
  // closeouts and reconciliations are append-only), so once proven it cannot
  // be invalidated before the attempt is completed.
  async function proveRealizedClose({ session, closeout, attempt }) {
    const closeoutCorrelationId = attempt.closeoutCorrelationId;
    let snapshot, context;
    try {
      snapshot = await snapshots.getByCorrelationId({ closeoutCorrelationId });
      context = await reconciliation.getBySessionId({ serviceSessionId: session.id });
    } catch (e) {
      return { ok: false, code: "V3_CLOSE_LINEAGE_READ_FAILED", detail: String((e && e.message) || e) };
    }
    const missing = [];
    if (!snapshot || snapshot.serviceSessionId !== session.id || snapshot.closeoutCorrelationId !== closeoutCorrelationId) {
      missing.push("snapshot");
    }
    if (!context || context.serviceSessionId !== session.id || context.closeoutCorrelationId !== closeoutCorrelationId) {
      missing.push("reconciliation");
    }
    if (!session.closed_at) missing.push("session_closed_at");
    if (missing.length === 0) {
      // service_closeouts.closed_at is the closeout row's own write time.
      const order = [snapshot.capturedAt, closeout.closedAt, context.createdAt, session.closed_at].map((v) => Date.parse(v));
      if (order.some((t) => Number.isNaN(t)) || order[0] > order[1] || order[1] > order[2] || order[2] > order[3]) {
        missing.push("close_order");
      }
    }
    if (missing.length > 0) return { ok: false, code: "V3_CLOSE_RESUME_EVIDENCE_INCOMPLETE", missing };
    return { ok: true, reconciliation: context };
  }

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
    // this engine) is decided below by explicit V3 lineage, never by order
    // count (SLICE 3.2.1 — see the lineage block immediately below).
    const alreadyClosed = session.status === "closed";
    if (!alreadyClosed && !["open", "closing"].includes(session.status)) {
      return { success: false, code: "V3_CLOSE_SESSION_NOT_OPEN", sessionStatus: session.status };
    }

    // ── SLICE 3.2.1 — explicit V3 ownership/retry lineage, BEFORE Phase A ──
    // Ownership of a session's close is proven ONLY by matching, linked rows
    // in service_closeouts / service_closeout_attempts — NEVER by how many
    // canonical orders the session has (a legitimate service can have zero).
    // This MUST run before attempts.acquire(): acquire() mints a BRAND NEW
    // attempt (new correlation id) whenever no ACTIVE attempt exists for the
    // session — including when the only prior attempt is already 'completed'
    // — so calling it unconditionally on a retry of an already-finished V3
    // close would orphan the new attempt from the existing closeout and, in
    // the real schema, collide with service_closeouts_session_uq on Phase D.
    let existingCloseout;
    try {
      existingCloseout = await closeouts.getBySessionId({ serviceSessionId });
    } catch (e) {
      return { success: false, code: "V3_CLOSE_LINEAGE_READ_FAILED", detail: String((e && e.message) || e) };
    }

    if (existingCloseout) {
      // The closeout's own service_session_id must match (service_closeouts_
      // session_uq means getBySessionId can only ever return a row that
      // already agrees, but this is never assumed — see "never rely on
      // incidental business data").
      if (existingCloseout.serviceSessionId !== session.id) {
        return { success: false, code: "V3_CLOSE_LINEAGE_INVALID" };
      }

      let existingAttempt;
      try {
        existingAttempt = await attempts.getByCorrelationId({
          closeoutCorrelationId: existingCloseout.closeoutCorrelationId,
        });
      } catch (e) {
        return {
          success: false, code: "V3_CLOSE_LINEAGE_READ_FAILED",
          closeoutCorrelationId: existingCloseout.closeoutCorrelationId, detail: String((e && e.message) || e),
        };
      }
      // service_closeouts.closeout_correlation_id REFERENCES service_closeout_
      // attempts(closeout_correlation_id) — a dangling reference cannot exist
      // in the real schema. A missing or session-mismatched attempt here is a
      // genuine data inconsistency, not a business outcome: fail closed
      // rather than guess which session actually owns it.
      if (!existingAttempt || existingAttempt.serviceSessionId !== session.id) {
        return {
          success: false, code: "V3_CLOSE_LINEAGE_INVALID",
          closeoutCorrelationId: existingCloseout.closeoutCorrelationId,
        };
      }

      if (existingAttempt.status === "completed") {
        // CASE C — exact idempotent success. This exact (session, attempt,
        // closeout) triple already reached its V3 terminal state; the session
        // MUST already be closed (create_service_closeout only ever runs
        // under an attempt that close_service_session_v3 later completes
        // against — a completed attempt with a still-open session is exactly
        // the same "impossible" lineage as above). No RPC call, no mutation.
        if (!alreadyClosed) {
          return {
            success: false, code: "V3_CLOSE_LINEAGE_INVALID",
            closeoutCorrelationId: existingAttempt.closeoutCorrelationId,
          };
        }
        return {
          success: true, code: "V3_CLOSED", idempotent: true,
          closeoutCorrelationId: existingAttempt.closeoutCorrelationId,
          closeout: existingCloseout,
          occupiedTablesAtClose: existingCloseout.operational.occupiedTablesAtClose,
        };
      }

      if (existingAttempt.status === "active" && alreadyClosed) {
        // CASE D (R4) — service already closed: the terminal transition
        // (Phase E) committed, but the attempt was never marked completed (a
        // crash before Phase G, or Phase G's own call failing — possible only
        // for closes made before migration 149, which commits both together
        // and refuses to commit one without the other). Nothing is
        // left to transition, so no transition is asked for:
        // close_service_session_v3 answers ALREADY_CLOSED only while this
        // session is still the recent-closed one with no current service, so
        // once the next service opened, a resume through it got
        // SESSION_CLOSE_IDENTITY_MISMATCH forever and the attempt stayed
        // active. The attempt is completed instead on proof from this
        // session's own close facts (proveRealizedClose), without re-running
        // the reconciliation (a missing one is never recreated from a
        // Business Day that may now hold the next service). Fails closed on
        // any missing or out-of-order fact. The completion RPC (via
        // attempts.complete) re-checks the attempt's status under its row
        // lock (idempotent, refuses a superseded attempt), so concurrent
        // resumes complete it exactly once. Success is returned only once
        // completion is confirmed.
        const proof = await proveRealizedClose({ session, closeout: existingCloseout, attempt: existingAttempt });
        if (!proof.ok) {
          return {
            success: false, code: proof.code, missing: proof.missing, detail: proof.detail,
            closeoutCorrelationId: existingAttempt.closeoutCorrelationId, closeout: existingCloseout,
          };
        }
        let completion;
        try {
          completion = await attempts.complete({ closeoutCorrelationId: existingAttempt.closeoutCorrelationId, actor });
        } catch (e) {
          completion = { success: false, detail: String((e && e.message) || e) };
        }
        if (!completion || completion.success !== true) {
          return {
            success: false, code: (completion && completion.code) || "V3_CLOSE_ATTEMPT_COMPLETE_FAILED",
            detail: completion && completion.detail,
            closeoutCorrelationId: existingAttempt.closeoutCorrelationId, closeout: existingCloseout,
          };
        }
        const carryoverSummary = await computeCarryoverSummary(serviceSessionId);
        return {
          success: true, code: "V3_CLOSED", idempotent: true,
          closeoutCorrelationId: existingAttempt.closeoutCorrelationId,
          closeout: existingCloseout,
          reconciliation: proof.reconciliation,
          session: publicSession(session),
          occupiedTablesAtClose: existingCloseout.operational.occupiedTablesAtClose,
          carryoverSummary,
        };
      }

      if (existingAttempt.status === "active") {
        // CASE B: service still open/closing — crash happened after Phase D
        // (closeout persisted) but before Phase E (terminal transition). The
        // resume finishes the transition and the bookkeeping, and NEVER
        // creates a second closeout (Phase D is never reached here). CASE D
        // (already closed) is handled just above.
        // CORRECTIVE SLICE 150 — this state (a closeout committed while the
        // service stayed open) can only come from BEFORE migration 150: since
        // then a closeout commits only together with the terminal close
        // (service_closeouts_terminal_close_v1). The closeout is permanent
        // (service_closeouts_session_uq, append-only), so the resume may use it
        // ONLY if it still describes the service: the terminal step re-judges
        // the attempt's snapshot against the live facts (and the receipts
        // against the reconciliation) under the close's lock prefix. Stale ->
        // a typed refusal, NEVER a success from frozen evidence; the service
        // stays open for an operator decision (it cannot be corrected here).
        // A missing reconciliation is built now and persisted by the same
        // terminal transaction (J-1 context, still before the transition).
        let resumeReceiptIds, resumeReconciliation;
        try {
          resumeReceiptIds = await readReceiptIds(serviceSessionId);
        } catch (e) {
          return {
            success: false, code: "V3_CLOSE_LIVE_STATE_READ_FAILED", detail: String((e && e.message) || e),
            closeoutCorrelationId: existingAttempt.closeoutCorrelationId, closeout: existingCloseout,
          };
        }
        // POST-ASTRA F2 (154): the day window's digest is read before the build and judged by the terminal step.
        resumeReconciliation = await reconciliation.buildRpcArgs({
          serviceSessionId, closeoutCorrelationId: existingAttempt.closeoutCorrelationId, actor, withDayEvidence: true,
        });
        if (!resumeReconciliation.success) {
          return {
            success: false,
            code: resumeReconciliation.code || "V3_CLOSE_RECONCILIATION_PERSIST_FAILED",
            closeoutCorrelationId: existingAttempt.closeoutCorrelationId,
            closeout: existingCloseout,
          };
        }

        // R4B + 150 — the reconciliation, the terminal transition and the
        // attempt completion commit together, so a resume never leaves a
        // closed session with an active attempt, and success means all happened.
        const transitionResult = await transition.closeWithEvidence({
          serviceSessionId, closeoutCorrelationId: existingAttempt.closeoutCorrelationId, actor, source,
          closeout: null, reconciliation: resumeReconciliation.args, receiptIds: resumeReceiptIds,
        });
        if (!transitionResult.success) {
          return {
            success: false,
            code: transitionResult.code === "CLOSE_EVIDENCE_STALE" ? "V3_CLOSE_COMMITTED_EVIDENCE_STALE" : (transitionResult.code || "V3_CLOSE_TRANSITION_FAILED"),
            missing: transitionResult.missing, stale: transitionResult.stale,
            closeoutCorrelationId: existingAttempt.closeoutCorrelationId, closeout: existingCloseout,
          };
        }

        // F-5 — the old "resume Phase F0" (ensure/reuse B) step is retired;
        // resume now goes straight from the terminal transition to the
        // carryover summary, exactly like the main happy path below.
        const carryoverSummary = await computeCarryoverSummary(serviceSessionId);
        return {
          success: true, code: "V3_CLOSED", idempotent: true,
          closeoutCorrelationId: existingAttempt.closeoutCorrelationId,
          closeout: existingCloseout,
          reconciliation: projectRecon(transitionResult.reconciliationRow),
          session: transitionResult.session,
          occupiedTablesAtClose: existingCloseout.operational.occupiedTablesAtClose,
          carryoverSummary,
        };
      }

      // existingAttempt.status === "superseded" — a V3 closeout exists but
      // its OWN owning attempt was later superseded. create_service_closeout
      // requires an ACTIVE attempt at INSERT time (ATTEMPT_NOT_ACTIVE
      // otherwise) and nothing in this engine ever supersedes an attempt
      // after that point, so this should be unreachable. Refuse rather than
      // guess — never fabricate ownership over an inconsistent lineage.
      return {
        success: false, code: "V3_CLOSE_LINEAGE_INVALID",
        closeoutCorrelationId: existingAttempt.closeoutCorrelationId,
      };
    }

    if (alreadyClosed) {
      // CASE E — closed, with no provable V3 lineage at all: some other
      // mechanism closed this session (legacy engine, manual intervention,
      // or unknown). Never fabricate a closeout for a session this engine
      // did not itself close — regardless of order count. A zero-order
      // session is CASE F, not this: it falls through below like any other
      // happy-path close because no closeout exists YET for it.
      return { success: false, code: "V3_CLOSE_SESSION_ALREADY_CLOSED_NOT_RECOVERABLE" };
    }

    // CORRECTIVE SLICE 150 — a close is made from evidence that still
    // describes the service at the moment of the terminal commit, or not at
    // all. Each round acquires/resumes an attempt, captures (or re-reads) its
    // snapshot, classifies, and hands the closeout + reconciliation to the ONE
    // terminal step (close_service_session_with_evidence_v1), which judges the
    // evidence under the close's lock prefix. CLOSE_EVIDENCE_STALE (the service
    // kept trading after a terminal step that did not commit, or while this
    // round ran) -> the attempt is superseded through attempts.supersede (the
    // database retires its incidents with it) and a fresh round starts. Nothing of a stale
    // round was ever committed as a closeout or a reconciliation. Bounded: a
    // service that keeps changing under every round is refused, typed, never
    // closed from evidence that is already old.
    let lastStale = null;
    for (let round = 1; round <= MAX_EVIDENCE_ROUNDS; round += 1) {
      const outcome = await closeRound();
      if (!outcome || outcome[EVIDENCE_STALE] !== true) return outcome;
      lastStale = outcome;
      let superseded;
      try {
        superseded = await attempts.supersede({ closeoutCorrelationId: outcome.closeoutCorrelationId, actor, reason: "CLOSE_EVIDENCE_STALE" });
      } catch (e) {
        superseded = { success: false, detail: String((e && e.message) || e) };
      }
      if (!superseded || superseded.success !== true) {
        return {
          success: false, code: (superseded && superseded.code) || "V3_CLOSE_ATTEMPT_SUPERSEDE_FAILED",
          detail: superseded && superseded.detail, closeoutCorrelationId: outcome.closeoutCorrelationId,
        };
      }
    }
    return {
      success: false, code: "V3_CLOSE_EVIDENCE_STALE", stale: lastStale.stale, rounds: MAX_EVIDENCE_ROUNDS,
      closeoutCorrelationId: lastStale.closeoutCorrelationId,
    };

    // One evidence round (Phase A -> E). Returns the final result, or the
    // EVIDENCE_STALE marker when the terminal step judged its evidence stale.
    async function closeRound() {
    // CASE A (and CASE F, which is CASE A with zero orders — no special
    // handling: happy-path reconciliation below treats an empty service
    // exactly like any other). Phase A — acquire/resume the closeout
    // attempt. Idempotent: a retry for
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
    let orders, tableSessions, financialEvents, orderObligations;
    try {
      [orders, tableSessions, financialEvents, orderObligations] = await Promise.all([
        select("ordenes", sessionFilter),
        select("table_sessions", sessionFilter),
        select("order_financial_events", sessionFilter),
        // FINALIZAR V3 CANONICAL CLOSEOUT V1 — the canonical order_obligations
        // for this service, scoped and ordered exactly as the two already-
        // correct readers do (currentServiceCloseout.getCurrentServiceCloseout,
        // economiaLedgerAggregate.aggregateOneSession): service-scoped,
        // revision.asc so latestObligationsByOrder picks the top revision.
        // Without this the aggregate() call below fell back to ordenes.totale
        // (root cause LEGACY_GROSS_CLOSEOUT_WRITER).
        select("order_obligations", `${sessionFilter}&order=revision.asc`),
      ]);
    } catch (e) {
      return { success: false, code: "V3_CLOSE_LIVE_STATE_READ_FAILED", closeoutCorrelationId, detail: String((e && e.message) || e) };
    }
    if (!Array.isArray(orders) || !Array.isArray(tableSessions) || !Array.isArray(financialEvents) || !Array.isArray(orderObligations)) {
      return { success: false, code: "V3_CLOSE_LIVE_STATE_SHAPE_INVALID", closeoutCorrelationId };
    }
    // No order-count ownership check here (removed, SLICE 3.2.1): by this
    // point the lineage block above already proved there is no existing V3
    // closeout for this session AND the session is not already closed (CASE
    // E returns before Phase A is ever reached) — so `alreadyClosed` is
    // always false here, whether orders.length is 0 (CASE F) or not (CASE A).

    const captureResult = await snapshots.capture({
      serviceSessionId,
      closeoutCorrelationId,
      capturedBy: actor,
      source,
      // FINALIZAR V3 CANONICAL CLOSEOUT V1 — orderObligations added additively
      // to the immutable evidence payload so the close artifact alone can
      // reconstruct the current obligation at close (and hence unpaid /
      // over-collected), without a later temporal JOIN against the live
      // append-only order_obligations table. schema_version stays 1: the
      // snapshot RPC treats the payload as opaque jsonb (only jsonb_typeof =
      // 'object' is checked) and no reader parses its keys.
      payload: { session, orders, tableSessions, financialEvents, orderObligations },
    });
    if (!captureResult.success) {
      return { success: false, code: captureResult.code || "V3_CLOSE_SNAPSHOT_FAILED", closeoutCorrelationId };
    }
    // CORRECTIVE SLICE 150 — a resumed attempt already has its snapshot
    // (capture is idempotent per correlation: ALREADY_CAPTURED returns the
    // stored row). Its evidence IS that snapshot: the closeout and the
    // incidents are computed from it, never from newer reads, and the terminal
    // step decides whether it still describes the service.
    if (captureResult.created === false) {
      const frozen = captureResult.snapshot && captureResult.snapshot.payload;
      if (!frozen || !Array.isArray(frozen.orders) || !Array.isArray(frozen.tableSessions)
          || !Array.isArray(frozen.financialEvents) || !Array.isArray(frozen.orderObligations)) {
        return { success: false, code: "V3_CLOSE_SNAPSHOT_PAYLOAD_INVALID", closeoutCorrelationId };
      }
      ({ orders, tableSessions, financialEvents, orderObligations } = frozen);
    }

    // Phase C — deterministic reconciliation. `orders` is already scoped by
    // ordenes.service_session_id — the CURRENT-service assignment
    // ordenes_assign_service_session writes (V3.1's fix, 4252241), never
    // table_sessions' historical origin service — so a table that survived a
    // service boundary contributes its NEW orders to the session actually
    // being closed here, not to whatever session it opened under.
    // FINALIZAR V3 CANONICAL CLOSEOUT V1 — the 4th argument. With
    // orderObligations passed, safeTicket derives every ticket's amount /
    // unpaid / overCollected from the canonical latest obligation revision
    // instead of the legacy ordenes.totale fallback. safeTicket's formulas
    // are unchanged; only the input it receives is now canonical — the exact
    // same call shape currentServiceCloseout and economiaLedgerAggregate
    // already use.
    const closeout = aggregateCloseout(session, orders, financialEvents, orderObligations);

    const nonTerminalCount = orders.filter(
      (o) => !TERMINAL_ORDER_STATES.has(String((o && o.estado) || "").toUpperCase())
    ).length;
    // Canonical: Sigma max(0, currentObligation - netCollected) per ticket.
    const unpaidExposureCents = toCents(closeout.totals.unpaid);
    // FINALIZAR V3 CANONICAL CLOSEOUT V1 — the current canonical obligation at
    // close (Sigma latest obligation revision, non-cancelled). This is the
    // number Finalizar's preflight showed the operator as "Total".
    const currentObligationCents = toCents(closeout.totals.gross);
    // Canonical: Sigma max(0, netCollected - currentObligation) per ticket.
    // NEVER netted against unpaid (frozen over-collected invariant).
    const overCollectedCents = toCents(closeout.totals.overCollected);

    // gross_sales_cents keeps its frozen historical meaning — ORIGINAL ORDER
    // GROSS — so it is sourced from totals.originalGross (Sigma raw
    // ordenes.totale, non-cancelled), NOT totals.gross (which is now the
    // current obligation). net_sales_cents below therefore stays byte-
    // identical to its pre-canonical value.
    const grossSalesCents = toCents(closeout.totals.originalGross);
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
    // FINALIZAR V3 CANONICAL CLOSEOUT V1 — total_void_cents keeps its frozen
    // meaning: the ORIGINAL gross of cancelled orders. Sourced from
    // t.originalAmount (raw ordenes.totale) so it is byte-identical to its
    // pre-canonical value; t.amount for a cancelled ticket is now the
    // obligation-aware figure and is deliberately not used here.
    const voidCents = toCents(
      closeout.tickets.filter((t) => t.cancelled).reduce((sum, t) => sum + (Number(t.originalAmount) || 0), 0)
    );
    // Unchanged legacy/historical field: grossSalesCents is still ORIGINAL
    // gross, so this value does not move.
    const netSalesCents = Math.max(0, grossSalesCents - refundedCents);
    const occupiedTablesAtClose = tableSessions.filter((t) => t.status === "open").length;

    // Phase C.2 — SLICE 3.3: classify every non-hard anomaly (a non-terminal
    // order, an unpaid balance, a truly-empty open table) into an incident,
    // via the ONE classification/policy authority (v3IncidentPolicy.js).
    // Every classified incident here is, by construction, non-blocking — a
    // TRUE integrity failure never reaches this point (the reconciliation
    // mismatch above, and Slice 3.2.1's own lineage checks earlier, already
    // stop the engine before any mutation, including before this
    // classification step, for exactly that reason).
    // classify() throws only on its own internal fail-closed guard (an
    // incident type with no policy entry — a programming defect, never a
    // real business scenario; see v3IncidentPolicy.js's policyFor()). Caught
    // here so that defect still surfaces as this engine's normal
    // discriminated-result contract (Convention A) — a controlled hard
    // block, no mutation yet attempted — rather than an unhandled rejection.
    let classification;
    try {
      classification = classify({ orders, tableSessions, tickets: closeout.tickets });
    } catch (e) {
      return {
        success: false, code: "V3_CLOSE_CLASSIFICATION_FAILED",
        closeoutCorrelationId, detail: String((e && e.message) || e),
      };
    }
    const detectedSnapshotId = captureResult.snapshot ? captureResult.snapshot.id : null;

    // Persist EVERY classified incident BEFORE anything else is mutated.
    // Idempotent on (closeoutCorrelationId, incidentType, entityType,
    // entityId) — service_incidents_dedupe_uq — so a retry under the SAME
    // active attempt never duplicates an incident already durably recorded.
    // A failure to persist a REQUIRED incident is itself a hard blocker: V3
    // must never proceed to a successful closeout while a known anomaly
    // could not be durably recorded — the attempt stays active/recoverable,
    // and a retry re-persists only whatever did not already land.
    const persistedIncidents = [];
    for (const descriptor of classification.incidents) {
      let reportResult;
      try {
        reportResult = await incidents.report({
          serviceSessionId,
          closeoutCorrelationId,
          snapshotId: detectedSnapshotId,
          detectedBy: actor,
          incidentType: descriptor.incidentType,
          category: descriptor.category,
          severity: descriptor.severity,
          entityType: descriptor.entityType,
          entityId: descriptor.entityId,
          orderId: descriptor.orderId || null,
          tableSessionId: descriptor.tableSessionId || null,
          financialExposureCents: descriptor.financialExposureCents ?? null,
          // Always created pending, even for an incident this same pass will
          // go on to auto-resolve below — never persist a "resolved" fact
          // before the corresponding safe action has actually confirmed
          // success. Same discipline incidentSafeRollover.js's SLICE 4C.2C
          // already established, after a real staging run proved the
          // alternative (auto_resolve:true at creation time) unsafe: a
          // release RPC failure right after would leave a permanently false
          // "successfully released" record against a table still open.
          autoResolve: false,
          autoResolutionType: null,
          autoResolutionNote: null,
        });
      } catch (e) {
        return {
          success: false, code: "V3_CLOSE_INCIDENT_PERSISTENCE_FAILED",
          closeoutCorrelationId, detail: String((e && e.message) || e),
        };
      }
      if (!reportResult.success) {
        return {
          success: false, code: "V3_CLOSE_INCIDENT_PERSISTENCE_FAILED",
          closeoutCorrelationId, incidentCode: reportResult.code,
        };
      }
      persistedIncidents.push(reportResult.incident);
    }

    // Safe auto-actions — ONLY once every incident above is durable. Best
    // effort and non-fatal per action: a failed release leaves that table
    // harmlessly open (its incident stays pending/actionable, never falsely
    // resolved) — this never risks data integrity, so it is never itself a
    // reason to block the close.
    for (const action of classification.safeAutoActions) {
      if (action.type !== "RELEASE_EMPTY_TABLE") continue;
      const matchingIncident = persistedIncidents.find(
        (inc) => inc && inc.entityType === action.incidentEntityType && inc.entityId === action.incidentEntityId
      );
      try {
        await releaseEmptyTable({ workspaceId: action.workspaceId, tableSessionId: action.tableSessionId });
        if (matchingIncident) {
          const resolveResult = await incidents.resolve({
            incidentId: matchingIncident.id,
            resolvedBy: actor,
            role: "admin",
            resolutionType: "auto_released_empty_table",
            resolutionNote: "Table session had zero activity (covers_total IS NULL) at service close; automatically released.",
          });
          if (resolveResult.success && resolveResult.incident) {
            matchingIncident.resolutionStatus = resolveResult.incident.resolutionStatus;
            matchingIncident.resolutionType = resolveResult.incident.resolutionType;
          } else {
            console.warn(
              "[serviceLifecycleEngine] empty table released but marking its incident resolved failed (non-fatal — it stays visible as pending/actionable):",
              resolveResult.code
            );
          }
        }
      } catch (e) {
        console.warn(
          "[serviceLifecycleEngine] empty-table auto-release failed (non-fatal — the incident stays pending/actionable, the table stays harmlessly open):",
          (e && e.message) || e
        );
      }
    }

    const incidentCount = persistedIncidents.length;
    const criticalIncidentCount = persistedIncidents.filter((i) => i && i.severity === "critical").length;

    // Phase D — the ONE authoritative service_closeouts row, built here and
    // committed ONLY by the terminal step below (CORRECTIVE SLICE 150).
    const closeoutArgs = closeoutRpcArgs({
      serviceSessionId,
      closeoutCorrelationId,
      closedBy: actor,
      source,
      grossSalesCents,
      netSalesCents,
      totalRefundsCents: refundedCents,
      totalVoidCents: voidCents,
      paidAmountCents,
      unpaidExposureCents,
      orderCount: closeout.counts.tickets,
      cashAmountCents,
      cardAmountCents,
      bizumAmountCents,
      otherAmountCents,
      openOrdersAtClose: nonTerminalCount,
      occupiedTablesAtClose,
      kitchenPendingCount: classification.kitchenPendingCount,
      listoCount: classification.listoCount,
      deliveryPendingCount: classification.deliveryPendingCount,
      incidentCount,
      criticalIncidentCount,
      // FINALIZAR V3 CANONICAL CLOSEOUT V1 — the obligation-aware engine
      // always persists both, non-null (DB pairing CHECK). gross_sales_cents
      // above stays ORIGINAL gross; these two are the canonical facts.
      currentObligationCents,
      overCollectedCents,
    });

    // Phase D.2 (J-1) — the ECONOMIC CONTEXT this close is made under: the
    // Business Day window of THIS service, its snapshot totals, and the
    // physical cash count if (and only if) one exists for exactly that window.
    // Built here, persisted by the terminal step in the same transaction as
    // the closeout and the close (CORRECTIVE SLICE 150), so a failure leaves
    // the service OPEN, the attempt ACTIVE and NO frozen reconciliation. The
    // service's receipts are read FIRST: the terminal step refuses the close
    // unless they are still exactly these, so the reconciliation cannot miss
    // a receipt that committed after it was computed.
    let receiptIds;
    try {
      receiptIds = await readReceiptIds(serviceSessionId);
    } catch (e) {
      return { success: false, code: "V3_CLOSE_LIVE_STATE_READ_FAILED", closeoutCorrelationId, detail: String((e && e.message) || e) };
    }
    // POST-ASTRA F2 (154): the Business Day window's digest is read BEFORE the build (inside buildRpcArgs) and
    // travels in the reconciliation payload; the terminal step recomputes it under its lock prefix.
    const reconciliationArgs = await reconciliation.buildRpcArgs({ serviceSessionId, closeoutCorrelationId, actor, withDayEvidence: true });
    if (!reconciliationArgs.success) {
      return {
        success: false,
        code: reconciliationArgs.code || "V3_CLOSE_RECONCILIATION_PERSIST_FAILED",
        closeoutCorrelationId,
      };
    }

    // Phase E + G (R4B, migration 149) + evidence judgement (migration 150) —
    // closeout, reconciliation, terminal transition and attempt completion in
    // ONE transaction, after the database re-checked that this attempt's
    // snapshot and the service's receipts still describe the service.
    // occupiedTablesAtClose > 0 does NOT block this (migration 149 PART 3).
    const transitionResult = await transition.closeWithEvidence({
      serviceSessionId, closeoutCorrelationId, actor, source,
      closeout: closeoutArgs, reconciliation: reconciliationArgs.args, receiptIds,
    });
    if (!transitionResult.success) {
      if (transitionResult.code === "CLOSE_EVIDENCE_STALE" && transitionResult.closeoutCommitted !== true) {
        return { [EVIDENCE_STALE]: true, closeoutCorrelationId, stale: transitionResult.stale };
      }
      return {
        success: false,
        code: transitionResult.code || "V3_CLOSE_TRANSITION_FAILED",
        missing: transitionResult.missing,
        stale: transitionResult.stale,
        closeoutCorrelationId,
      };
    }
    const createResult = { closeout: publicCloseout(transitionResult.closeoutRow) };
    const reconciliationResult = { reconciliation: projectRecon(transitionResult.reconciliationRow) };

    // Phase F — carryover is a non-event by construction (no mutation
    // happens here — see this file's own header); this only summarizes what
    // already, structurally, carried over. F-5 retired the old Phase F0
    // ("ensure/reuse the next current service B") that used to sit here.
    const carryoverSummary = await computeCarryoverSummary(serviceSessionId);

    return {
      success: true,
      code: "V3_CLOSED",
      closeoutCorrelationId,
      closeout: createResult.closeout,
      reconciliation: reconciliationResult.reconciliation,
      session: transitionResult.session,
      occupiedTablesAtClose,
      incidents: persistedIncidents,
      carryoverSummary,
    };
    }
  };
}

const closeServiceV3 = createServiceLifecycleEngine();

module.exports = { createServiceLifecycleEngine, closeServiceV3 };
