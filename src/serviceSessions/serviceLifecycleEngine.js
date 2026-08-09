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
//
// SLICE 3.4 — the engine no longer ends once the current service is closed:
// acquire -> snapshot -> reconcile -> classify/persist incidents -> safe
// actions -> closeout A -> close A -> ensure/reuse the next current service
// B (src/serviceSessions/v3NextServiceIdentity.js decides WHETHER one should
// exist right now; ensure_next_service_session_v3 is the atomic DB primitive
// that creates/reuses it) -> compute the carryover summary -> complete the
// rollover attempt. Carryover itself is a NON-EVENT by design: an open table
// keeps its immutable origin (table_sessions.service_session_id still =
// A — never rewritten, see V3.1), a NEW order on that table gets B because
// ordenes_assign_service_session (unmodified since V3.1) always assigns the
// CURRENT session, and A's financial/incident facts are frozen and never
// touched here. Opening B is never mandatory: outside a window where a
// service should be current (the 17:30-18:00 buffer, the overnight span),
// `nextService` is correctly null and current_session_id correctly stays
// NULL — that is a complete, successful rollover outcome, not a deferred one.
// ===============================================================

const { sbSelect } = require("../utils/supabase");
const { closeoutAttempts } = require("../closeout/closeoutAttempts");
const { closeoutSnapshots } = require("../closeout/closeoutSnapshots");
const { serviceCloseoutCreation } = require("../closeout/serviceCloseoutCreation");
const { serviceCloseouts } = require("../closeout/serviceCloseouts");
const { serviceLifecycleV3Transition } = require("./serviceLifecycleV3Transition");
const { aggregate } = require("../closeout/currentServiceCloseout");
const { serviceIncidents } = require("../incidents/serviceIncidents");
const { classifyForV3Close } = require("./v3IncidentPolicy");
const { deriveNextServiceIdentity } = require("./v3NextServiceIdentity");
const mesaDao = require("../tables/mesaDao");

// SLICE 3.4 — maps a raw service_sessions row (select()'s own snake_case
// PostgREST shape) into the same public shape serviceLifecycleV3Transition.js's
// publicSession() already uses for the RPC-wrapper path, plus the one new
// V3.4 provenance field. Two mappers, not one shared export, because the two
// callers see two different raw shapes (RPC jsonb body vs a plain SELECT
// row) even though the columns are the same — see that file's own header.
function publicNextService(row) {
  if (!row || typeof row !== "object") return null;
  return {
    id: row.id,
    businessDate: row.business_date,
    status: row.status,
    serviceKind: row.service_kind,
    openedAt: row.opened_at,
    openedBy: row.opened_by,
    openSource: row.open_source,
    rolloverSourceSessionId: row.rollover_source_session_id || null,
  };
}

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
  closeouts = serviceCloseouts,
  transition = serviceLifecycleV3Transition,
  aggregateCloseout = aggregate,
  incidents = serviceIncidents,
  releaseEmptyTable = mesaDao.releaseEmptySessionAuto,
  classify = classifyForV3Close,
  now = () => new Date(),
  deriveNextService = deriveNextServiceIdentity,
} = {}) {
  // SLICE 3.4 — read-only lookup, safe to call from a fully-completed
  // (CASE C) lineage — NEVER creates anything. If a rollover already
  // finished and decided (at the time) that nothing should be ensured, this
  // must keep returning null forever for that record, never retroactively
  // open a session based on whatever the clock says on a LATER read.
  async function lookupNextService(serviceSessionId) {
    try {
      const rows = await select("service_sessions", `rollover_source_session_id=eq.${encodeURIComponent(serviceSessionId)}`);
      return Array.isArray(rows) && rows.length > 0 ? publicNextService(rows[0]) : null;
    } catch (_) {
      return null;
    }
  }

  // SLICE 3.4 — ensures/reuses the V3 rollover continuation of a just-closed
  // session. Checks for an already-ensured B FIRST, independent of the
  // clock — a retry must find a B a prior attempt already created even if
  // the schedule has since moved into a window where nothing NEW should be
  // ensured (see v3NextServiceIdentity.js's own header for why "nothing due
  // right now" is a complete, successful outcome, not a failure). Only ever
  // called from an active-attempt path (fresh or resuming) — never from
  // CASE C, which must stay strictly read-only (see lookupNextService above).
  async function ensureNextService(serviceSessionId, actor, source) {
    let existingRows;
    try {
      existingRows = await select("service_sessions", `rollover_source_session_id=eq.${encodeURIComponent(serviceSessionId)}`);
    } catch (e) {
      return { success: false, code: "V3_ROLLOVER_NEXT_SERVICE_READ_FAILED", detail: String((e && e.message) || e) };
    }
    if (Array.isArray(existingRows) && existingRows.length > 0) {
      return { success: true, nextService: publicNextService(existingRows[0]) };
    }
    const identity = deriveNextService(now());
    if (!identity.shouldEnsure) {
      return { success: true, nextService: null };
    }
    const ensureResult = await transition.ensureNext({
      sourceSessionId: serviceSessionId,
      serviceKind: identity.serviceKind,
      businessDate: identity.businessDate,
      actor, source,
    });
    if (!ensureResult.success) {
      return { success: false, code: ensureResult.code || "V3_ROLLOVER_ENSURE_NEXT_FAILED" };
    }
    return { success: true, nextService: ensureResult.session };
  }

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
        // SLICE 3.4 — strictly read-only: whatever the rollover decided WHEN
        // IT COMPLETED is the permanent answer for this record. Never
        // re-derive from today's clock here (see lookupNextService's header).
        const nextService = await lookupNextService(serviceSessionId);
        return {
          success: true, code: "V3_CLOSED", idempotent: true,
          closeoutCorrelationId: existingAttempt.closeoutCorrelationId,
          closeout: existingCloseout,
          occupiedTablesAtClose: existingCloseout.operational.occupiedTablesAtClose,
          nextService,
        };
      }

      if (existingAttempt.status === "active") {
        // CASES B and D converge here. CASE B: service still open/closing —
        // crash happened after Phase D (closeout persisted) but before Phase
        // E (terminal transition). CASE D: service already closed — crash
        // happened after Phase E succeeded but before Phase F (attempt
        // bookkeeping). transition.close() is idempotent (its real RPC
        // returns ALREADY_CLOSED when the session is already closed under
        // this exact identity — see close_service_session_v3), so the SAME
        // two calls safely finish whichever of B/D actually happened, and
        // NEVER create a second closeout (Phase D is never reached here).
        const transitionResult = await transition.close({
          serviceSessionId, closeoutCorrelationId: existingAttempt.closeoutCorrelationId, actor, source,
        });
        if (!transitionResult.success) {
          return {
            success: false, code: transitionResult.code || "V3_CLOSE_TRANSITION_FAILED",
            closeoutCorrelationId: existingAttempt.closeoutCorrelationId, closeout: existingCloseout,
          };
        }

        // SLICE 3.4 — resume Phase F0: ensure/reuse B before ever completing
        // the attempt. A REQUIRED step, same posture as incident persistence
        // — a failure here leaves the attempt active/recoverable rather than
        // silently skipping the rollover's own remaining half.
        const rolloverResult = await ensureNextService(serviceSessionId, actor, source);
        if (!rolloverResult.success) {
          return {
            success: false, code: rolloverResult.code || "V3_ROLLOVER_ENSURE_NEXT_FAILED",
            closeoutCorrelationId: existingAttempt.closeoutCorrelationId, closeout: existingCloseout,
            session: transitionResult.session,
          };
        }
        const carryoverSummary = await computeCarryoverSummary(serviceSessionId);

        // Non-fatal if this fails: the session is already closed, the
        // closeout already persisted, and B (if any) already ensured, so a
        // failed completion is never retried into a duplicate of any of
        // those — same discipline as Phase F below.
        try {
          await attempts.complete({ closeoutCorrelationId: existingAttempt.closeoutCorrelationId, actor });
        } catch (e) {
          console.warn(
            "[serviceLifecycleEngine] resume: marking the attempt completed failed (non-fatal — the session is already closed and the closeout already persisted):",
            (e && e.message) || e
          );
        }
        return {
          success: true, code: "V3_CLOSED", idempotent: true,
          closeoutCorrelationId: existingAttempt.closeoutCorrelationId,
          closeout: existingCloseout,
          session: transitionResult.session,
          occupiedTablesAtClose: existingCloseout.operational.occupiedTablesAtClose,
          nextService: rolloverResult.nextService,
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

    // Phase F0 — SLICE 3.4: ensure/reuse the next current service B, if the
    // schedule says one should exist right now. A REQUIRED step: a failure
    // here leaves the attempt active/recoverable, exactly like a required
    // incident-persistence failure — V3 must never mark a rollover complete
    // while its own "open B" half could not be durably resolved either way
    // (created, reused, or deliberately skipped).
    const rolloverResult = await ensureNextService(serviceSessionId, actor, source);
    if (!rolloverResult.success) {
      return {
        success: false,
        code: rolloverResult.code || "V3_ROLLOVER_ENSURE_NEXT_FAILED",
        closeoutCorrelationId,
        closeout: createResult.closeout,
        session: transitionResult.session,
      };
    }

    // Phase F1 — SLICE 3.4: carryover is a non-event by construction (no
    // mutation happens here — see this file's own header); this only
    // summarizes what already, structurally, carried over.
    const carryoverSummary = await computeCarryoverSummary(serviceSessionId);

    // Phase G — mark the rollover attempt completed. Non-fatal if this
    // fails: the session is already closed, the closeout already persisted,
    // and B (if any) already ensured, so a failed completion is never
    // retried into a duplicate of any of those (same pattern as
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
      incidents: persistedIncidents,
      nextService: rolloverResult.nextService,
      carryoverSummary,
    };
  };
}

const closeServiceV3 = createServiceLifecycleEngine();

module.exports = { createServiceLifecycleEngine, closeServiceV3 };
