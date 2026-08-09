"use strict";
// ===============================================================
// incidentSafeRollover.js — SERVICE CLOSEOUT V2 / Slice 3, hardened in
// SLICE 3.1 (attempt ownership).
//
// THE authoritative closeout-attempt orchestrator. Connects the already-built
// foundations (service_closeout_snapshots / service_incidents from Slice 1,
// service_closeout_attempts from Slice 3.1, the classifier from
// rolloverClassifier.js, business-date precedence from
// sessionRolloverClassification.js) to the EXISTING, unmodified close engine
// (chiudiServizio, src/utils/servizio.js) — it does not reimplement or
// replace any of chiudiServizio's own archive/verify/delete contract.
//
// Product invariant this exists to enforce: closing a service session does
// NOT mean "everything belonging to it was resolved" — it means "the
// operational period ended and its unresolved facts were safely persisted."
// A non-hard-blocking anomaly (pending kitchen work, an unpaid balance, a
// forgotten empty table) must never keep the OLD session current forever; it
// must become a persistent incident while the rollover proceeds anyway.
//
// SLICE 3.1 HARDENING — why Slice 3's original attempt discovery wasn't
// enough: Slice 3 found "the" attempt by SELECTing service_closeout_snapshots
// newest-first for this session and reusing whatever it found, forever. That
// had two real defects:
//   (a) CONCURRENCY — two truly concurrent callers with no existing snapshot
//       yet could each mint their own closeout_correlation_id and both
//       succeed at capture (idempotent only on their OWN id, never on
//       service_session_id), producing two snapshots for one session.
//   (b) STALE-FOREVER REPLAY — once ANY snapshot existed, every future call
//       replayed its frozen classification unconditionally, even if the
//       operator had since collected the unpaid balance / finished the
//       pending kitchen work / fixed exactly what the snapshot complained
//       about. A genuinely corrected service could never get a second,
//       accurate closeout attempt.
// Both are fixed by service_closeout_attempts (migrations/2026-08-08_
// service_closeout_attempt_ownership.sql): a DB-enforced invariant that at
// most one ACTIVE attempt exists per session (fixes (a)), plus a state
// fingerprint comparison on every retry that decides whether to replay the
// active attempt's frozen classification or supersede it and acquire a
// genuinely new one (fixes (b)).
//
// SLICE 3.2 HARDENING — one active attempt does not mean only one caller
// ever reaches step 2's "first real work" branch for it: two callers can
// BOTH legitimately acquire() the SAME active attempt (that is what the
// invariant is FOR) and both still find no snapshot yet, race each other to
// read/classify/capture. The database's UNIQUE(closeout_correlation_id)
// still lets only one capture() actually insert a row — but Slice 3.1, as
// first written, only checked capture().success, never .created, so the
// LOSER would silently go on to persist incidents from its OWN locally-
// derived classification instead of the WINNER's — the exact snapshot/
// incident incoherence Slice 3's Critical Check 2 exists to prevent, just
// reintroduced at the "first capture" moment instead of on a retry. Fixed by
// treating captureResult.created === false here exactly like a same-attempt
// retry already is: discard the local classification, use the persisted
// winner's (getClassificationFromSnapshot below) instead. Slice 3.2 also
// makes supersede_closeout_attempt() atomically transition a superseded
// attempt's still-pending/acknowledged incidents to resolution_status=
// 'superseded' (see the migration) — pure DB-side behavior, invisible to
// this file's control flow, but why an attempt's incidents stop reading as
// ordinary actionable alarms once it's no longer the one that will close
// the session.
//
// ORDER OF OPERATIONS (deliberate — do not reorder):
//   1. acquire() THE active attempt for this session — race-safe, DB-backed
//      (service_closeout_attempts_active_uq). Never mints a correlation id
//      itself; acquire_closeout_attempt() is the only minter.
//   2. does that attempt already own a snapshot?
//      NO  -> first real work under this attempt: read live state once,
//             classify (pure), capture the immutable snapshot WITH the
//             classification AND a state fingerprint embedded in its
//             payload, so any later retry can either replay it (state
//             unchanged) or detect drift (state changed) — see step 3.
//      YES -> this is a retry. Read live state once, compute its
//             fingerprint, compare against the snapshot's frozen one:
//               MATCH    -> replay the frozen classification verbatim
//                            (skip re-classifying) — snapshot and every
//                            incident tagged with this correlation id keep
//                            describing the exact same read no matter how
//                            many times or how much later this re-enters.
//               MISMATCH -> live state has genuinely moved on since this
//                            attempt was captured; supersede() it (DB-backed,
//                            idempotent) and go back to step 1 — acquire()
//                            now creates a fresh active attempt, which (by
//                            construction) owns no snapshot yet, so it falls
//                            into the "first real work" branch above using
//                            the SAME state already read for the mismatch
//                            check. Bounded at one supersession per call.
//   3. any classifier-level hard blocker (integrity only) stops here, before
//      any incident is persisted and before chiudiServizio is called.
//   4. persist EVERY classified incident, tagged with this attempt's
//      correlation id and snapshot id. If ANY persistence call fails, stop —
//      "fail to persist required incidents" is itself a hard blocker: we
//      must never let chiudiServizio force-archive/delete an order whose
//      incident record didn't durably land first. A retry re-enters this
//      same function, converges on the SAME active attempt (state hasn't
//      changed — the failure was in incident persistence, not business
//      state), and serviceIncidents.report()'s own idempotency means
//      already-persisted incidents are not duplicated.
//   5. ONLY once every incident is durably persisted, apply the classifier's
//      safe auto-actions (currently: releasing a truly-empty Mesa table via
//      the EXISTING mesa_release_empty_session_v1 RPC — no new Mesa code).
//      Best-effort: a failed release simply leaves that table for the
//      existing MESA_TABLES_NOT_RELEASED gate to catch, unchanged.
//   6. delegate the actual close/archive/delete to chiudiServizio, UNCHANGED,
//      always with deleteAttivi=true.
//   7. only on a SUCCESSFUL close, mark this attempt completed (terminal —
//      never reused as active again, enforced independently by the DB
//      trigger) and attempt to establish the next current session
//      (ensure_service_session), only inside a valid ensure window, exactly
//      preserving S2-7D6F's own invariant of never inventing one outside it.
//   8. return chiudiServizio's own result, unchanged in shape, plus the
//      attempt's correlation id, snapshot id, persisted incidents, a
//      ROLLED_OVER / ROLLED_OVER_WITH_INCIDENTS code, and the new session if
//      one was established — so every existing caller that only reads
//      result.success/.deferred/.reason/.summary keeps working exactly as
//      before, and a new caller can additionally read the incident summary.
// ===============================================================

const { sbSelect } = require("../utils/supabase");
const { lifecycle: sessionLifecycle } = require("./serviceSessionLifecycle");
const { chiudiServizio } = require("../utils/servizio");
const { closeoutSnapshots } = require("../closeout/closeoutSnapshots");
const { closeoutAttempts } = require("../closeout/closeoutAttempts");
const { serviceIncidents } = require("../incidents/serviceIncidents");
const { classifyForIncidentSafeRollover, computeStateFingerprint } = require("./rolloverClassifier");
const { DEFAULT_SCHEDULE, resolveSchedule } = require("../schedule/serviceSchedule");
const mesaDao = require("../tables/mesaDao");

// At most one supersession per call: acquire -> (mismatch) -> supersede ->
// acquire again. A second consecutive mismatch inside the SAME invocation
// would mean state drifted twice within one function call, which is not a
// scenario this orchestrator needs to loop indefinitely to handle — it fails
// closed instead (ROLLOVER_ATTEMPT_CONVERGENCE_FAILED) rather than risk an
// unbounded loop.
const MAX_ATTEMPT_ACQUISITIONS = 2;

function createIncidentSafeRollover({
  select = sbSelect,
  snapshots = closeoutSnapshots,
  attempts = closeoutAttempts,
  incidents = serviceIncidents,
  closeSession = chiudiServizio,
  releaseEmptyTableSession = mesaDao.releaseEmptySession,
  sessionLifecycleImpl = sessionLifecycle,
  now = () => new Date(),
  schedule = DEFAULT_SCHEDULE,
} = {}) {
  return async function performIncidentSafeRollover({ session, actor = "system", source = "rollover" } = {}) {
    if (!session || !session.id) {
      return { success: false, error: "ROLLOVER_INVALID_SESSION" };
    }
    const serviceSessionId = session.id;
    const sessionFilter = `service_session_id=eq.${encodeURIComponent(serviceSessionId)}`;

    async function readLiveState() {
      const orders = await select("ordenes", sessionFilter);
      const tableSessions = await select("table_sessions", `${sessionFilter}&status=eq.open`);
      const financialEvents = await select("order_financial_events", sessionFilter);
      if (!Array.isArray(orders) || !Array.isArray(tableSessions) || !Array.isArray(financialEvents)) {
        throw new Error("unexpected read shape from one of ordenes/table_sessions/order_financial_events");
      }
      return { orders, tableSessions, financialEvents };
    }

    let closeoutCorrelationId;
    let classification;
    let snapshotId;

    // ── STEPS 1-2 — acquire the active attempt, converge on ONE classification ─
    for (let iteration = 0; iteration < MAX_ATTEMPT_ACQUISITIONS; iteration++) {
      let acquireResult;
      try {
        acquireResult = await attempts.acquire({ serviceSessionId, actor });
      } catch (e) {
        return { success: false, error: "ROLLOVER_ATTEMPT_ACQUIRE_FAILED", detail: String((e && e.message) || e) };
      }
      if (!acquireResult.success) {
        return { success: false, error: "ROLLOVER_ATTEMPT_ACQUIRE_FAILED", code: acquireResult.code };
      }
      closeoutCorrelationId = acquireResult.attempt.closeoutCorrelationId;

      let existingSnapshot;
      try {
        existingSnapshot = await snapshots.getByCorrelationId({ closeoutCorrelationId });
      } catch (e) {
        return { success: false, error: "ROLLOVER_ATTEMPT_IDENTITY_LOOKUP_FAILED", closeoutCorrelationId, detail: String((e && e.message) || e) };
      }

      let state;
      try {
        state = await readLiveState();
      } catch (e) {
        return { success: false, error: "ROLLOVER_STATE_READ_FAILED", closeoutCorrelationId, detail: String((e && e.message) || e) };
      }

      if (!existingSnapshot) {
        // First real work under this (possibly freshly-acquired) attempt —
        // but "first" from THIS caller's point of view only. Another caller
        // sharing the SAME active attempt may be doing the exact same thing
        // concurrently; only one capture() can actually win the row.
        const localClassification = classifyForIncidentSafeRollover({ session, ...state });
        const fingerprint = computeStateFingerprint(state);

        const captureResult = await snapshots.capture({
          serviceSessionId,
          closeoutCorrelationId,
          capturedBy: actor,
          source,
          payload: {
            ...localClassification.snapshotPayload,
            classification: {
              hardBlockers: localClassification.hardBlockers,
              informationalIncidents: localClassification.informationalIncidents,
              operationalIncidents: localClassification.operationalIncidents,
              financialIncidents: localClassification.financialIncidents,
              safeAutoActions: localClassification.safeAutoActions,
            },
          },
          payloadSha256: fingerprint,
        });
        if (!captureResult.success) {
          return { success: false, error: "ROLLOVER_SNAPSHOT_CAPTURE_FAILED", code: captureResult.code, closeoutCorrelationId };
        }
        snapshotId = captureResult.snapshot ? captureResult.snapshot.id : null;

        if (captureResult.created === false) {
          // SLICE 3.2 — lost the capture race: another concurrent caller's
          // capture() landed first for this SAME closeout_correlation_id.
          // THEIR persisted snapshot is authoritative, not our local read —
          // discard localClassification entirely and use the winner's,
          // exactly as a same-attempt retry already does below.
          classification = captureResult.snapshot && captureResult.snapshot.payload && captureResult.snapshot.payload.classification;
          if (!classification) {
            return { success: false, error: "ROLLOVER_SNAPSHOT_MISSING_CLASSIFICATION", closeoutCorrelationId, snapshotId };
          }
        } else {
          classification = localClassification;
        }
        break;
      }

      // A retry of this attempt. Coherence check (Slice 3's Critical Check 2,
      // extended in 3.1): does live state still match what was frozen?
      const currentFingerprint = computeStateFingerprint(state);
      if (currentFingerprint === existingSnapshot.payloadSha256) {
        classification = existingSnapshot.payload && existingSnapshot.payload.classification;
        snapshotId = existingSnapshot.id;
        if (!classification) {
          // A snapshot exists for this attempt but carries no embedded
          // classification (cannot happen for any attempt this module ever
          // captured) — fail closed rather than silently reclassify against
          // a snapshot whose coherence we can no longer prove.
          return { success: false, error: "ROLLOVER_SNAPSHOT_MISSING_CLASSIFICATION", closeoutCorrelationId, snapshotId };
        }
        break;
      }

      // MISMATCH — this active attempt no longer describes reality (plan
      // STEP 7): the operator corrected exactly what it complained about, or
      // new activity landed. Supersede it and loop to acquire a fresh one.
      const supersedeResult = await attempts.supersede({
        closeoutCorrelationId, actor, reason: "state_drift_detected",
      });
      if (!supersedeResult.success) {
        return { success: false, error: "ROLLOVER_ATTEMPT_SUPERSESSION_FAILED", code: supersedeResult.code, closeoutCorrelationId };
      }
      // continue: next iteration's acquire() creates the fresh active attempt.
    }

    if (!classification) {
      return { success: false, error: "ROLLOVER_ATTEMPT_CONVERGENCE_FAILED", closeoutCorrelationId };
    }

    // ── hard blockers (integrity only) ──────────────────────────────────────
    if (classification.hardBlockers.length > 0) {
      return {
        success: false,
        error: "ROLLOVER_HARD_BLOCKED",
        hardBlockers: classification.hardBlockers,
        closeoutCorrelationId,
        snapshotId,
      };
    }

    // ── persist every incident BEFORE anything is force-archived ───────────
    const allIncidentDescriptors = [
      ...classification.informationalIncidents,
      ...classification.operationalIncidents,
      ...classification.financialIncidents,
    ];
    const persistedIncidents = [];
    for (const descriptor of allIncidentDescriptors) {
      const res = await incidents.report({
        serviceSessionId,
        closeoutCorrelationId,
        snapshotId,
        detectedBy: actor,
        incidentType: descriptor.incidentType,
        category: descriptor.category,
        severity: descriptor.severity,
        entityType: descriptor.entityType || null,
        entityId: descriptor.entityId || null,
        orderId: descriptor.orderId || null,
        tableSessionId: descriptor.tableSessionId || null,
        financialExposureCents: descriptor.financialExposureCents ?? null,
        autoResolve: descriptor.autoResolve === true,
        autoResolutionType: descriptor.autoResolutionType || null,
        autoResolutionNote: descriptor.autoResolutionNote || null,
      });
      if (!res.success) {
        // Hard blocker: the close must not proceed while a required incident
        // failed to persist. Nothing has been mutated yet (chiudiServizio has
        // not been called) — the session is untouched, and a retry converges
        // on the SAME active attempt (business state is unaffected by an
        // incident-persistence transport failure), re-persisting only the
        // incidents that did not already land (idempotent, never duplicated).
        return {
          success: false,
          error: "ROLLOVER_INCIDENT_PERSISTENCE_FAILED",
          code: res.code,
          closeoutCorrelationId,
          snapshotId,
          incidents: persistedIncidents,
        };
      }
      persistedIncidents.push(res.incident);
    }

    // ── safe auto-actions, only after every incident is durable ────────────
    for (const action of classification.safeAutoActions) {
      if (action.type === "RELEASE_EMPTY_TABLE") {
        try {
          await releaseEmptyTableSession({
            workspaceId: action.workspaceId,
            byActor: actor,
            tableSessionId: action.tableSessionId,
          });
        } catch (e) {
          console.warn(
            "[incidentSafeRollover] empty-table auto-release failed (non-fatal — the existing mesa gate will still catch it if truly needed):",
            e && e.message || e,
          );
        }
      }
    }

    // ── delegate to the EXISTING close engine ───────────────────────────────
    // SLICE 4C.1 — allowOpenTablesAcrossBoundary:true is set ONLY here, never
    // by the manual "chiudiServizio" HTTP action or the S2-1G deferred-close
    // retry. Accepted cross-service Mesa contract: a table_session may
    // legitimately span PRANZO -> SERA (or a date boundary); its
    // service_session_id is historical "where it was opened" metadata, never
    // rewritten at close, and an occupied table is therefore not itself a
    // reason to keep the OLD session open. chiudiServizio never reads or
    // writes table_sessions again once this flag lets it past the gate — see
    // its own comment at the mesa_tables_not_released check.
    const closeResult = await closeSession(true, source, actor, { allowOpenTablesAcrossBoundary: true });

    // ── on success: mark this attempt terminal, then try the next session ──
    let newSession = null;
    if (closeResult && closeResult.success === true) {
      try {
        await attempts.complete({ closeoutCorrelationId, actor });
      } catch (e) {
        console.warn("[incidentSafeRollover] marking the attempt completed failed (non-fatal — the session itself is already closed and will never be looked up for rollover again):", e && e.message || e);
      }
      try {
        const when = resolveSchedule(now(), schedule);
        if (when.canEnsureSession) {
          const ensureRes = await sessionLifecycleImpl.ensure({ actor, serviceKind: when.serviceKind, source });
          if (ensureRes && ensureRes.ok === true) newSession = ensureRes.session;
        }
      } catch (e) {
        console.warn("[incidentSafeRollover] post-close ensure-next-session failed (non-fatal, a later entry point will retry):", e && e.message || e);
      }
    }

    // ── return chiudiServizio's own shape, plus the incident story ─────────
    return {
      ...closeResult,
      closeoutCorrelationId,
      snapshotId,
      incidents: persistedIncidents,
      code: closeResult && closeResult.success
        ? (persistedIncidents.length > 0 ? "ROLLED_OVER_WITH_INCIDENTS" : "ROLLED_OVER")
        : closeResult && closeResult.code,
      newSession,
    };
  };
}

const performIncidentSafeRollover = createIncidentSafeRollover();

module.exports = { createIncidentSafeRollover, performIncidentSafeRollover };
