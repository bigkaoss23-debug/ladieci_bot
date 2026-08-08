"use strict";
// ===============================================================
// incidentSafeRollover.js — SERVICE CLOSEOUT V2 / Slice 3
//
// THE authoritative closeout-attempt orchestrator. Connects the already-built
// foundations (service_closeout_snapshots / service_incidents from Slice 1,
// the classifier from rolloverClassifier.js, business-date precedence from
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
// ORDER OF OPERATIONS (deliberate — do not reorder):
//   1. mint or reuse ONE closeout_correlation_id for this session's attempt
//      (never service_session_id itself — see closeoutSnapshots.js header).
//      Reused via lookup-by-session: while a session is still open/closing,
//      a later call is a retry of the SAME technical attempt (chiudiServizio
//      itself only ever fully closes a session once); once the session is
//      genuinely closed, no later call will ever see it again, so there is no
//      ambiguity risk in this simple lookup.
//   1b. COHERENCE (Critical Check 2): if that lookup found an existing
//      snapshot, this is a RETRY of an incomplete attempt, not a fresh one.
//      The snapshot table is append-only/immutable (UNIQUE on
//      closeout_correlation_id, ON CONFLICT DO NOTHING) — a second capture()
//      call with the same id silently returns the ORIGINAL row, unchanged.
//      Live business state (orders, tables, payments) may have moved on since
//      attempt 1. If this function re-read and re-classified live state on
//      every retry, the incidents it persists could describe a LATER moment
//      than the snapshot claims to be the authoritative pre-close picture of
//      — internally inconsistent evidence for the same attempt. So the
//      classification itself (not just the raw payload) is embedded in the
//      snapshot at first capture, and a retry REPLAYS that frozen
//      classification verbatim (skipping steps 2/3 entirely) instead of
//      deriving a new one. Snapshot and every incident tagged with this
//      correlation id therefore always describe the exact same read, no
//      matter how many times or how much later this re-enters.
//   2. (first attempt only) read the session's CURRENT raw state (orders,
//      open table sessions, financial events) — once, read-only, before
//      anything is mutated.
//   3. (first attempt only) classify (rolloverClassifier.js) — pure, no side
//      effects yet.
//   4. (first attempt only) capture the immutable pre-close snapshot from
//      that SAME read, with the classification embedded in its payload so a
//      retry can replay it (see 1b). Capture failure is a HARD BLOCKER (plan
//      Step 2) — nothing below this line runs.
//   5. any classifier-level hard blocker (integrity only) also stops here,
//      before any incident is persisted and before chiudiServizio is called.
//   6. persist EVERY classified incident, tagged with this attempt's
//      correlation id and snapshot id. If ANY persistence call fails, stop —
//      "fail to persist required incidents" is itself a hard blocker (plan
//      Step 1/12): we must never let chiudiServizio force-archive/delete an
//      order whose incident record didn't durably land first. A retry
//      re-enters this same function, reuses the same correlation id, and
//      serviceIncidents.report()'s own idempotency means already-persisted
//      incidents are not duplicated — only the missing ones are retried.
//   7. ONLY once every incident is durably persisted, apply the classifier's
//      safe auto-actions (currently: releasing a truly-empty Mesa table via
//      the EXISTING mesa_release_empty_session_v1 RPC — no new Mesa code).
//      Best-effort: a failed release simply leaves that table for the
//      existing MESA_TABLES_NOT_RELEASED gate to catch, unchanged.
//   8. delegate the actual close/archive/delete to chiudiServizio, UNCHANGED,
//      always with deleteAttivi=true (every automatic/required rollover path
//      already called it this way before this module existed — the only
//      thing that changes is that pending activity no longer prevents this
//      call from ever being reached).
//   9. only after a SUCCESSFUL close, attempt to establish the next current
//      session (ensure_service_session) for whatever kind the schedule says
//      right now — but only inside a valid ensure window, exactly preserving
//      S2-7D6F's own invariant of never inventing a session outside one.
//  10. return chiudiServizio's own result, unchanged in shape, plus the
//      attempt's correlation id, snapshot id, persisted incidents, a
//      ROLLED_OVER / ROLLED_OVER_WITH_INCIDENTS code, and the new session if
//      one was established — so every existing caller that only reads
//      result.success/.deferred/.reason/.summary keeps working exactly as
//      before, and a new caller can additionally read the incident summary.
// ===============================================================

const crypto = require("crypto");
const { sbSelect } = require("../utils/supabase");
const { lifecycle: sessionLifecycle } = require("./serviceSessionLifecycle");
const { chiudiServizio } = require("../utils/servizio");
const { closeoutSnapshots } = require("../closeout/closeoutSnapshots");
const { serviceIncidents } = require("../incidents/serviceIncidents");
const { classifyForIncidentSafeRollover } = require("./rolloverClassifier");
const { DEFAULT_SCHEDULE, resolveSchedule } = require("../schedule/serviceSchedule");
const mesaDao = require("../tables/mesaDao");

function createIncidentSafeRollover({
  select = sbSelect,
  snapshots = closeoutSnapshots,
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

    // ── STEP 1 — closeout attempt identity ──────────────────────────────────
    let closeoutCorrelationId;
    let existingSnapshot;
    try {
      const existing = await snapshots.listBySession({ serviceSessionId });
      existingSnapshot = (Array.isArray(existing) && existing[0]) || null;
      closeoutCorrelationId = (existingSnapshot && existingSnapshot.closeoutCorrelationId) || crypto.randomUUID();
    } catch (e) {
      return { success: false, error: "ROLLOVER_ATTEMPT_IDENTITY_LOOKUP_FAILED", detail: String((e && e.message) || e) };
    }

    // ── STEP 1b — coherence: replay a frozen classification on retry ───────
    const frozenClassification = existingSnapshot
      && existingSnapshot.payload
      && existingSnapshot.payload.classification;

    let classification;
    let captureResult;
    if (frozenClassification) {
      classification = frozenClassification;
      captureResult = { success: true, created: false, snapshot: existingSnapshot };
    } else {
      // ── STEP 2 — read current raw state, once, before anything mutates ───
      let orders, tableSessions, financialEvents;
      try {
        orders = await select("ordenes", sessionFilter);
        tableSessions = await select("table_sessions", `${sessionFilter}&status=eq.open`);
        financialEvents = await select("order_financial_events", sessionFilter);
        if (!Array.isArray(orders) || !Array.isArray(tableSessions) || !Array.isArray(financialEvents)) {
          throw new Error("unexpected read shape from one of ordenes/table_sessions/order_financial_events");
        }
      } catch (e) {
        return { success: false, error: "ROLLOVER_STATE_READ_FAILED", closeoutCorrelationId, detail: String((e && e.message) || e) };
      }

      // ── STEP 3 — classify (pure) ───────────────────────────────────────
      classification = classifyForIncidentSafeRollover({ session, orders, tableSessions, financialEvents });

      // ── STEP 4 — capture the immutable pre-close snapshot, WITH the
      // classification embedded so a retry can replay it verbatim instead of
      // re-deriving it from state that may have since changed (STEP 1b) ────
      captureResult = await snapshots.capture({
        serviceSessionId,
        closeoutCorrelationId,
        capturedBy: actor,
        source,
        payload: {
          ...classification.snapshotPayload,
          classification: {
            hardBlockers: classification.hardBlockers,
            informationalIncidents: classification.informationalIncidents,
            operationalIncidents: classification.operationalIncidents,
            financialIncidents: classification.financialIncidents,
            safeAutoActions: classification.safeAutoActions,
          },
        },
      });
      if (!captureResult.success) {
        return {
          success: false,
          error: "ROLLOVER_SNAPSHOT_CAPTURE_FAILED",
          code: captureResult.code,
          closeoutCorrelationId,
        };
      }
    }
    const snapshotId = captureResult.snapshot ? captureResult.snapshot.id : null;

    // ── STEP 5 — classifier-level hard blockers (integrity only) ────────────
    if (classification.hardBlockers.length > 0) {
      return {
        success: false,
        error: "ROLLOVER_HARD_BLOCKED",
        hardBlockers: classification.hardBlockers,
        closeoutCorrelationId,
        snapshotId,
      };
    }

    // ── STEP 6 — persist every incident BEFORE anything is force-archived ──
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
        // Hard blocker (plan Step 1/12): the close must not proceed while a
        // required incident failed to persist. Nothing has been mutated yet
        // (chiudiServizio has not been called) — the session is untouched,
        // and a retry reuses closeoutCorrelationId, re-persisting only the
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

    // ── STEP 7 — safe auto-actions, only after every incident is durable ───
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

    // ── STEP 8 — delegate to the EXISTING, unmodified close engine ─────────
    const closeResult = await closeSession(true, source, actor);

    // ── STEP 9 — establish the next current session, only inside a valid
    //             ensure window (never invent one outside it — S2-7D6F). ────
    let newSession = null;
    if (closeResult && closeResult.success === true) {
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

    // ── STEP 10 — return chiudiServizio's own shape, plus the incident story ─
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
