"use strict";
// ===============================================================
// staleServiceRecovery.js — STALE SERVICE PROTECTION V1 (backend JS half)
//
// The read-only audit (REPORT_STALE_SERVICE_LIFECYCLE_AUDIT_2026-09-06.md)
// established: O-3/O-4 removed the upper bound on an open Operational
// Service's continuity, and the replacement recovery surface was deferred
// and never built. Migration 120 is the SQL half — it makes
// resolve_order_intake_context_v1 / ensure_service_session FAIL CLOSED with
// PREVIOUS_SERVICE_PENDING the moment an open operational_service_v1 row's
// own business_date is older than the canonical Business Day. This module is
// the JS half — the REMEDIATION layer.
//
// ─── THE ONE THING THIS DOES ──────────────────────────────────────────────
// Given the current lifecycle pointer, decide one of:
//
//   NO_STALE_SERVICE          — nothing open, or the open service's
//                               business_date is still the canonical
//                               Business Day. Nothing to do.
//   AUTO_RECOVERY_PERFORMED   — the open service is stale AND passes the
//                               AUTO_CLOSE_SAFE predicate (built entirely
//                               from existing canonical facts): it was
//                               finalized through the ONE V3 close authority
//                               (serviceCloseAuthority -> serviceLifecycle
//                               Engine). No second close implementation.
//   PREVIOUS_SERVICE_PENDING  — the open service is stale but NOT safe to
//                               auto-finalize (operational blockers, unpaid
//                               exposure, over-collection, a reconciliation
//                               it cannot even build, or a lifecycle
//                               anomaly). Return the typed state + the
//                               blocker facts. The operator resolves it and
//                               uses the EXISTING manual Finalizar flow.
//
// ─── FAIL-CLOSED OUTCOMES (ok:false — the caller must NOT continue) ───────
//   LIFECYCLE_UNRESOLVED / <the corrupt pointer's own code, e.g.
//   MULTIPLE_ACTIVE_SERVICE_SESSIONS / SERVICE_SESSION_STATE_CORRUPT> —
//                               the lifecycle pointer could not be read or is
//                               corrupt. Not this module's job to reconcile.
//   CANONICAL_BUSINESS_DATE_UNAVAILABLE — the canonical Business Day could
//                               not be resolved, so staleness cannot be
//                               judged at all.
//   ACTIVE_SERVICE_BUSINESS_DAY_MISMATCH — the open service's business_date
//                               is AHEAD of the canonical Business Day (a
//                               future-dated service: corruption / clock
//                               skew). This is NOT a "previous" service and
//                               has NO recovery path — never auto-closed,
//                               never reclassified. Same canonical code
//                               open_operational_service_v1 uses.
//
// ─── WHAT IT NEVER DOES ───────────────────────────────────────────────────
// No fake payment/refund, no obligation rewrite, no automatic order
// cancellation, no netting unpaid against overCollected, no fabricated cash
// count, no table force-close, no blocker deletion, no business_date
// rewrite, no direct service_sessions/service_session_state mutation (the V3
// engine owns every lifecycle write), no new persistent DB status. It reads
// canonical facts, runs a conservative predicate, and either calls the one
// close authority or reports.
//
// ─── STALENESS AUTHORITY ──────────────────────────────────────────────────
// The canonical Business Day comes from get_order_intake_context_v1()
// (04:00 Madrid rollover, STABLE, side-effect-free) via
// orderIntakePolicy.fetchOrderIntakeContext — NEVER a JS Date computation.
// "stale" is exactly: session.business_date < canonicalBusinessDate;
// session.business_date > canonicalBusinessDate is the future-dated anomaly
// above. The same three-way rule migration 120 applies in SQL, so the two
// halves agree.
// ===============================================================

const { lifecycle } = require("./serviceSessionLifecycle");
const { closeServiceSessionV3 } = require("./serviceCloseAuthority");
const { fetchOrderIntakeContext } = require("./orderIntakePolicy");
// language-guard: allow-legacy the pre-close scan's existing export name is aliased here so the rest of this file reads in Spanish, not new vocabulary
const scanPreClose = require("../utils/servizio").scanServizio;
const { closeoutReconciliation } = require("../economy/closeoutReconciliation");

const RECOVERY_CODE = Object.freeze({
  NO_STALE_SERVICE: "NO_STALE_SERVICE",
  AUTO_RECOVERY_PERFORMED: "AUTO_RECOVERY_PERFORMED",
  PREVIOUS_SERVICE_PENDING: "PREVIOUS_SERVICE_PENDING",
  // Fail-closed outcomes — recovery cannot proceed and must not guess.
  LIFECYCLE_UNRESOLVED: "LIFECYCLE_UNRESOLVED",
  CANONICAL_BUSINESS_DATE_UNAVAILABLE: "CANONICAL_BUSINESS_DATE_UNAVAILABLE",
  // REVIEW FIX — a FUTURE-dated open service (business_date AHEAD of the
  // canonical Business Day) is a lifecycle anomaly, never a "previous"
  // service. Fail closed with the SAME canonical code open_operational_
  // service_v1 already returns for an active service under a non-canonical
  // business day. No auto-close, no reclassification.
  ACTIVE_SERVICE_BUSINESS_DAY_MISMATCH: "ACTIVE_SERVICE_BUSINESS_DAY_MISMATCH",
});

// A stale service is auto-finalizable only when EVERY canonical fact says
// "no human judgement is required". Any doubt -> not safe -> pending.
// Inputs are the exact facts the manual Finalizar preflight already uses:
//   the pre-close scan's `blocking`  — operational blockers (non-terminal
//                            orders, open table sessions), scoped to this
//                            service.
//   closeoutReconciliation.build() — the service's own economy; must build,
//                            and must show zero unpaid and zero
//                            over-collection.
function evaluateAutoCloseSafe({ session, scan, recon }) {
  const blockers = {
    orders: scan && scan.blocking && Number.isFinite(scan.blocking.orders) ? scan.blocking.orders : null,
    tables: scan && scan.blocking && Number.isFinite(scan.blocking.tables) ? scan.blocking.tables : null,
    unpaid: recon && recon.ok === true && recon.service ? Number(recon.service.unpaid) : null,
    overCollected: recon && recon.ok === true && recon.service ? Number(recon.service.overCollected) : null,
    reconciliationError: recon && recon.__error ? recon.__error : null,
  };

  const safe =
    session.status === "open" &&
    blockers.orders === 0 &&
    blockers.tables === 0 &&
    recon && recon.ok === true && !recon.__error &&
    blockers.unpaid === 0 &&
    blockers.overCollected === 0;

  return { safe: !!safe, blockers };
}

function createStaleServiceRecovery({
  sessionLifecycle = lifecycle,
  closeAuthority = closeServiceSessionV3,
  fetchIntakeContext = fetchOrderIntakeContext,
  scan = scanPreClose,
  reconciliation = closeoutReconciliation,
} = {}) {

  async function canonicalBusinessDate() {
    try {
      const ctx = await fetchIntakeContext();
      const bd = ctx && typeof ctx.businessDate === "string" ? ctx.businessDate.slice(0, 10) : null;
      return bd && /^\d{4}-\d{2}-\d{2}$/.test(bd) ? bd : null;
    } catch (_) {
      return null;
    }
  }

  async function readReconciliation(serviceSessionId) {
    try {
      return await reconciliation.build({ serviceSessionId });
    } catch (e) {
      return { __error: (e && e.code) || "RECONCILIATION_BUILD_FAILED" };
    }
  }

  // recoverStaleService({ actor, source }) -> a discriminated result. It is
  // idempotent and safe to call from more than one lifecycle entry point:
  // the V3 engine + close RPC take the same advisory lock and re-validate
  // current_session_id under it, so a concurrent double-recovery converges
  // (the loser sees the service already gone).
  async function recoverStaleService({ actor = "system", source = "stale_service_auto_recovery" } = {}) {
    let identity;
    try {
      identity = await sessionLifecycle.currentCloseout();
    } catch (e) {
      return { ok: false, stale: false, code: RECOVERY_CODE.LIFECYCLE_UNRESOLVED, detail: String((e && e.message) || e) };
    }
    if (!identity || identity.ok !== true) {
      // MULTIPLE_ACTIVE_SERVICE_SESSIONS / SERVICE_SESSION_STATE_CORRUPT /
      // transport — a genuine integrity gap. Fail closed: not this module's
      // job to reconcile a corrupt pointer, and it must never guess.
      return { ok: false, stale: false, code: identity && identity.code ? identity.code : RECOVERY_CODE.LIFECYCLE_UNRESOLVED };
    }

    const session = identity.session;
    if (!session || !session.id || session.status === "closed" || session.status === "rolled_over") {
      return { ok: true, stale: false, code: RECOVERY_CODE.NO_STALE_SERVICE };
    }

    const currentBusinessDate = await canonicalBusinessDate();
    if (!currentBusinessDate) {
      return { ok: false, stale: false, code: RECOVERY_CODE.CANONICAL_BUSINESS_DATE_UNAVAILABLE };
    }

    const sessionBusinessDate = typeof session.business_date === "string" ? session.business_date.slice(0, 10) : null;

    // REVIEW FIX — FUTURE-dated open service: the pointed service belongs to a
    // Business Day that has not started yet. That is corruption / clock skew,
    // not a "previous" service, and there is no recovery path for it — this
    // module must never auto-close or reclassify it. Fail closed with the
    // canonical mismatch code. ('YYYY-MM-DD' strings compare lexicographically
    // exactly as dates.)
    if (!!sessionBusinessDate && sessionBusinessDate > currentBusinessDate) {
      return {
        ok: false,
        stale: false,
        code: RECOVERY_CODE.ACTIVE_SERVICE_BUSINESS_DAY_MISMATCH,
        serviceSessionId: session.id,
        serviceBusinessDate: sessionBusinessDate,
        currentBusinessDate,
      };
    }

    const stale = !!sessionBusinessDate && sessionBusinessDate < currentBusinessDate;
    if (!stale) {
      return {
        ok: true, stale: false, code: RECOVERY_CODE.NO_STALE_SERVICE,
        serviceSessionId: session.id, businessDate: sessionBusinessDate, currentBusinessDate,
      };
    }

    // ── Stale. Build the AUTO_CLOSE_SAFE predicate from canonical facts. ──
    let scanResult = null;
    try {
      scanResult = await scan({ resolveCurrentService: async () => session });
    } catch (_) {
      scanResult = null; // treated as "cannot prove safe" below
    }
    const recon = await readReconciliation(session.id);
    const { safe, blockers } = evaluateAutoCloseSafe({ session, scan: scanResult, recon });

    const pending = () => ({
      ok: true,
      stale: true,
      recovered: false,
      code: RECOVERY_CODE.PREVIOUS_SERVICE_PENDING,
      staleServiceSessionId: session.id,
      staleBusinessDate: sessionBusinessDate,
      currentBusinessDate,
      blockers,
    });

    if (!safe) {
      return pending();
    }

    // ── Safe -> finalize through the ONE V3 close authority. ─────────────
    let closed;
    try {
      closed = await closeAuthority({ serviceSessionId: session.id, source, actor });
    } catch (e) {
      return { ...pending(), blockers: { ...blockers, autoCloseError: String((e && e.message) || e) } };
    }

    if (closed && closed.success === true) {
      return {
        ok: true,
        stale: true,
        recovered: true,
        code: RECOVERY_CODE.AUTO_RECOVERY_PERFORMED,
        recoveredServiceSessionId: session.id,
        staleBusinessDate: sessionBusinessDate,
        currentBusinessDate,
        idempotent: closed.idempotent === true,
        closeoutCorrelationId: closed.closeoutCorrelationId || null,
      };
    }

    // The close did not succeed. Re-read the pointer once: a concurrent
    // recovery may already have finalized this exact service, in which case
    // the stale service is genuinely gone and this is an idempotent success.
    let after;
    try { after = await sessionLifecycle.currentCloseout(); } catch (_) { after = null; }
    const stillOpenSame =
      after && after.ok === true && after.session && after.session.id === session.id &&
      (after.session.status === "open" || after.session.status === "closing");
    if (!stillOpenSame) {
      return {
        ok: true, stale: true, recovered: true, code: RECOVERY_CODE.AUTO_RECOVERY_PERFORMED,
        recoveredServiceSessionId: session.id, staleBusinessDate: sessionBusinessDate, currentBusinessDate,
        idempotent: true, closeoutCorrelationId: (closed && closed.closeoutCorrelationId) || null,
      };
    }

    return { ...pending(), blockers: { ...blockers, autoCloseError: (closed && closed.code) || "V3_CLOSE_FAILED" } };
  }

  return { recoverStaleService, evaluateAutoCloseSafe, RECOVERY_CODE };
}

const staleServiceRecovery = createStaleServiceRecovery();

module.exports = {
  RECOVERY_CODE,
  createStaleServiceRecovery,
  staleServiceRecovery,
  recoverStaleService: staleServiceRecovery.recoverStaleService,
};
