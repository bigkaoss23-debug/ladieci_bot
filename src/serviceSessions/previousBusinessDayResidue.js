"use strict";
// ===============================================================
// previousBusinessDayResidue.js — SERVICE LIFECYCLE / P0-C3
//
// Detects non-terminal orders AND open table_sessions whose OWNING service
// session belongs to a business_date strictly older than the current
// operational business_date, and records each as a
// PREVIOUS_BUSINESS_DAY_OPERATIONAL_RESIDUE incident via the existing,
// already-idempotent create_service_incident (service_incidents_dedupe_uq on
// closeout_correlation_id+incident_type+entity_type+entity_id) — reused
// completely unmodified via serviceIncidents.js. No new table, no new
// dedupe mechanism.
//
// NOT ON READ. This is only ever invoked explicitly — as Phase G of
// economicBoundaryEngine.js's rollEconomicPeriod() when a roll actually
// language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values, named here only to describe the boundary this module detects across, not new vocabulary
// crosses a business_date (never on a same-day PRANZO->SERA rollover, which
// is ordinary carryover and must stay silent — P0-C2's own established
// rule), or as a standalone, deliberate catch-up call (same "explicit,
// non-silent, one-off invocation" precedent P0-C2 itself established for the
// economic boundary primitive, used once against the real already-missed
// 2026-08-10 transition — see P0_C3_END_OF_DAY_OPERATIONAL_VISIBILITY_
// REPORT.md §9/§22). No GET/read action anywhere calls this module.
//
// NEVER MUTATES canonical state. Only reads ordenes/table_sessions/
// service_sessions/service_closeouts (plus, for the scanned orders,
// order_obligations/order_financial_events) and writes service_incidents rows
// via serviceIncidents.report() — an order's estado, a table's status, and every
// financial fact are left exactly as they were.
//
// ECONOMIC vs OPERATIONAL RESIDUE (stale payment mirror, H1). Every order found
// here is operational residue by construction (a non-terminal estado left on a
// previous business date). Whether it is ALSO economic residue is decided by
// the canonical settlement — current obligation minus net collected, the same
// arithmetic order_post_payment_v1 uses (orderObligationProjection.js) — never
// by ya_pagado/cobrado (a commercial adjustment leaves them stale) nor by
// ordenes.totale (the pre-adjustment gross):
//   outstanding > 0   -> 'financial', exposure = outstanding (what is still owed)
//   otherwise         -> 'operational', no exposure
// financial_exposure_cents is a receivable (recovered payments and write-offs
// settle against it), so an over-collection — money owed BACK to the customer —
// is never written there; it stays visible in the returned `economic` facts and
// in the closeout / cash readers that already publish overCollected.
// A legacy row whose paid mirror contradicts the ledger (migration 148's
// ORDER_PAYMENT_LEGACY_IMPORT_REQUIRED predicate) is NOT treated as paid: the
// mirror is not money. It is reported 'financial' with the ledger outstanding
// and flagged legacyPaymentConflict, until the historical payment is imported
// or the obligation reconciled.
// ===============================================================

const { sbSelect } = require("../utils/supabase");
const { serviceIncidents } = require("../incidents/serviceIncidents");
const { getCurrentOperationalBusinessDate } = require("./currentOperationalSession");
const { readOrderFinancials } = require("../tables/orderObligationProjection");

const NON_TERMINAL_ORDER_STATES = "POR_CONFIRMAR,NUEVO,EN_COCINA,LISTO,EN_ENTREGA";
const RESIDUE_INCIDENT_TYPE = "PREVIOUS_BUSINESS_DAY_OPERATIONAL_RESIDUE";

function toCents(euros) {
  return Math.round((Number(euros) || 0) * 100);
}

// The economic side of one residue order, from its canonical settlement.
function economicResidueOf(financial) {
  const outstandingCents = toCents(financial.outstanding);
  return {
    residue: outstandingCents > 0 ? "RECEIVABLE" : (toCents(financial.overCollected) > 0 ? "OVER_COLLECTED" : "NONE"),
    currentObligation: financial.currentObligation,
    netCollected: financial.netCollected,
    outstanding: financial.outstanding,
    overCollected: financial.overCollected,
    payState: financial.payState,
    legacyPaymentConflict: financial.legacyPaymentConflict === true,
  };
}

async function safeReport(incidents, args) {
  try {
    return await incidents.report(args);
  } catch (e) {
    return { success: false, created: false, code: "SERVICE_INCIDENT_REPORT_THREW", detail: String((e && e.message) || e) };
  }
}

function createResidueReconciler({
  select = sbSelect,
  incidents = serviceIncidents,
  resolveCurrentBusinessDate = getCurrentOperationalBusinessDate,
} = {}) {
  return async function reconcilePreviousBusinessDayResidue({
    actor, source = "residue_reconciliation", currentBusinessDate,
  } = {}) {
    if (!actor || typeof actor !== "string" || !actor.trim()) {
      return { success: false, code: "INVALID_ACTOR" };
    }

    const businessDate = currentBusinessDate || (await resolveCurrentBusinessDate());
    if (!businessDate) {
      return { success: false, code: "NO_CURRENT_BUSINESS_DATE" };
    }

    // Stale sessions: business_date strictly older than current, and NOT
    // already destructively closed — V2/V3's 'closed' already archived/
    // deleted everything, there is nothing left in ordenes/table_sessions to
    // reconcile there. 'rolled_over' is exactly the non-destructive status
    // that CAN still have real residue underneath it. At most a handful of
    // rows in any realistic backlog — this is a bounded reconciliation scan,
    // not an unbounded one (see the module header + report §9 for why this
    // can never grow into "all non-terminal work for all history").
    let staleSessions;
    try {
      staleSessions = await select(
        "service_sessions",
        `business_date=lt.${encodeURIComponent(businessDate)}&status=in.(open,closing,rolled_over)&select=id,business_date,service_kind`,
      );
    } catch (e) {
      return { success: false, code: "RESIDUE_SESSION_SCAN_FAILED", detail: String((e && e.message) || e) };
    }
    if (!Array.isArray(staleSessions) || staleSessions.length === 0) {
      return { success: true, code: "NO_RESIDUE", scannedSessions: 0, ordersReported: 0, tablesReported: 0, incidents: [] };
    }

    const reported = [];
    let scanErrors = 0;

    for (const session of staleSessions) {
      // Each stale session that reached rolled_over/closing already has at
      // least one service_closeouts row (Phase D of rollEconomicPeriod
      // always creates one before rolling) — reuse the MOST RECENT one's own
      // correlation id as the dedupe key, so a repeat reconciliation days
      // later still resolves to the SAME incident row via
      // service_incidents_dedupe_uq, never a duplicate, with zero new
      // bookkeeping. (A session could in principle carry more than one
      // closeout row across a superseded/retried attempt history — the
      // latest is the authoritative one.)
      let closeoutRows;
      try {
        closeoutRows = await select(
          "service_closeouts",
          `service_session_id=eq.${encodeURIComponent(session.id)}&select=closeout_correlation_id&order=created_at.desc&limit=1`,
        );
      } catch (e) {
        scanErrors++;
        continue; // non-fatal: skip this session, keep reconciling the rest
      }
      const closeoutCorrelationId = Array.isArray(closeoutRows) && closeoutRows[0]
        ? closeoutRows[0].closeout_correlation_id : null;
      if (!closeoutCorrelationId) {
        // No closeout row yet (e.g. a legacy V2 session stuck 'closing' that
        // never reached P0-C2's roll primitive) — nothing this module can
        // key a dedupe-safe incident to. Skip rather than guess/invent one.
        scanErrors++;
        continue;
      }

      let orders, tableSessions;
      try {
        [orders, tableSessions] = await Promise.all([
          select("ordenes", `service_session_id=eq.${encodeURIComponent(session.id)}&estado=in.(${NON_TERMINAL_ORDER_STATES})`),
          select("table_sessions", `service_session_id=eq.${encodeURIComponent(session.id)}&status=eq.open`),
        ]);
      } catch (e) {
        scanErrors++;
        continue;
      }

      // Canonical settlement of every scanned order: two batched reads for the
      // whole session, never one per order. Unreadable -> skip the session like
      // any other scan error (retried on the next reconciliation) rather than
      // record an immutable incident on a guessed category.
      let financialOf;
      try {
        financialOf = await readOrderFinancials(Array.isArray(orders) ? orders : [], { select });
      } catch (e) {
        scanErrors++;
        continue;
      }

      for (const order of (Array.isArray(orders) ? orders : [])) {
        // Financial separation (brief, verbatim): an order becoming stale
        // operationally does not settle money. Residue that still OWES money is
        // a 'financial' incident carrying the canonical outstanding; settled or
        // over-collected residue is 'operational' (no exposure — purely a loose
        // end, e.g. a paid pizza never marked delivered). Neither branch
        // touches ya_pagado/estado.
        const economic = economicResidueOf(financialOf(order));
        const receivable = economic.residue === "RECEIVABLE";
        const result = await safeReport(incidents, {
          serviceSessionId: session.id,
          closeoutCorrelationId,
          incidentType: RESIDUE_INCIDENT_TYPE,
          category: receivable ? "financial" : "operational",
          severity: "warning",
          detectedBy: actor,
          entityType: "order",
          entityId: order.id,
          orderId: order.id,
          tableSessionId: order.table_session_id || null,
          financialExposureCents: receivable ? toCents(economic.outstanding) : null,
        });
        reported.push({
          kind: "order", entityId: order.id, businessDate: session.business_date,
          economic, operational: { estado: order.estado }, ...result,
        });
      }

      for (const table of (Array.isArray(tableSessions) ? tableSessions : [])) {
        // A previous-business-date OPEN table is real physical residue
        // (brief: "suspicious operational residue, not a normal new-day
        // table") — flagged here, never silently closed. The Mesa floor view
        // itself is deliberately unchanged (P0_C3 report §11): it still
        // correctly shows a genuinely-open table as occupied regardless of
        // which day it originated, which is physical reality, not a bug.
        const result = await safeReport(incidents, {
          serviceSessionId: session.id,
          closeoutCorrelationId,
          incidentType: RESIDUE_INCIDENT_TYPE,
          category: "operational",
          severity: "warning",
          detectedBy: actor,
          entityType: "table_session",
          entityId: table.id,
          tableSessionId: table.id,
        });
        reported.push({ kind: "table_session", entityId: table.id, businessDate: session.business_date, ...result });
      }
    }

    return {
      success: true,
      code: "RECONCILED",
      scannedSessions: staleSessions.length,
      scanErrors,
      ordersReported: reported.filter((r) => r.kind === "order").length,
      tablesReported: reported.filter((r) => r.kind === "table_session").length,
      newIncidents: reported.filter((r) => r.created === true).length,
      alreadyRecorded: reported.filter((r) => r.success === true && r.created === false).length,
      failed: reported.filter((r) => r.success !== true).length,
      incidents: reported,
    };
  };
}

const reconcilePreviousBusinessDayResidue = createResidueReconciler();

module.exports = {
  createResidueReconciler,
  reconcilePreviousBusinessDayResidue,
  RESIDUE_INCIDENT_TYPE,
  NON_TERMINAL_ORDER_STATES,
};
