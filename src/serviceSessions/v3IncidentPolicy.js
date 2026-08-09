"use strict";
// ===============================================================
// v3IncidentPolicy.js — SERVICE LIFECYCLE V3 / Slice 3.3
//
// THE single classification + policy authority for what V3.3's close engine
// (serviceLifecycleEngine.js) does with a non-hard anomaly. Pure: given
// already-read rows for one session (plus the SAME ledger-derived closeout
// tickets every other reader already computes), produces incident
// descriptors and safe-action descriptors. No DB access, no RPC calls — read
// once (the caller), classify once (here), act once (the caller).
//
// NEW ENGINE, NO LEGACY COUPLING: this file is V3-owned and imports nothing
// from src/serviceSessions/rolloverClassifier.js or incidentSafeRollover.js
// (V2's own classifier/orchestrator) — same "zero module coupling to any
// legacy-adjacent file" discipline serviceLifecycleEngine.js already
// established for TERMINAL_ORDER_STATES (see that file's own header). The
// INCIDENT TYPE VOCABULARY below is deliberately IDENTICAL to
// rolloverClassifier.js's (UNPAID_BALANCE_AT_CLOSE, KITCHEN_WORK_PENDING_AT_
// CLOSE, etc.) — reusing a proven, already-shipped vocabulary is not the same
// as reusing the module, and inventing a second, different vocabulary for the
// same real-world facts would be its own defect.
//
// ── CATEGORY / SEVERITY / BLOCKING ARE KEPT INDEPENDENT ─────────────────────
// INCIDENT_POLICY below is the ONE place that maps an incidentType to its
// (category, severity, blocking) triple. Nothing else in this file or in the
// engine hardcodes `category === "financial"` or derives `blocking` from a
// category string — every incident type is explicit about all three,
// independently, even though every V3.3 incident type today happens to
// resolve to blocking:false (a TRUE hard blocker is never represented as a
// service_incidents row at all — see the engine's own separate, pre-existing
// integrity checks: V3_CLOSE_RECONCILIATION_MISMATCH, the Slice 3.2.1 lineage
// checks, and this slice's new V3_CLOSE_INCIDENT_PERSISTENCE_FAILED). Adding a
// genuinely blocking incident type later is a one-line change here, not a
// restructuring.
// ===============================================================

// Identical set to serviceLifecycleEngine.js's own TERMINAL_ORDER_STATES /
// guard_service_session_closed_v1 (SQL) / rolloverClassifier.js (V2, JS).
// Kept as its own literal here (not imported from the engine) so this module
// has zero coupling to it and can be unit-tested in complete isolation.
const TERMINAL_ORDER_STATES = new Set([
  // language-guard: allow-legacy COMPLETATO is the existing terminal-state literal, identical to the same set already used repo-wide, not new vocabulary
  "RETIRADO", "COMPLETADO", "COMPLETATO",
  // language-guard: allow-legacy CHIUSO_FORZATO is the same existing terminal-state literal, restated for the same reason
  "CANCELADO", "CANCELLED", "ANULADO", "CHIUSO_FORZATO",
]);

// Non-terminal estado -> incident type. Deliberately the SAME vocabulary
// rolloverClassifier.js (V2) already established for the same real-world
// facts — see this file's header. Any non-terminal estado NOT listed here
// still gets an incident (ORDER_STATE_UNRESOLVED_AT_CLOSE below) — never
// silently skipped; this is what proves Test L (an unrecognized anomaly type
// fails closed at the classification boundary, not by being ignored).
const OPERATIONAL_INCIDENT_TYPE_BY_ORDER_STATE = Object.freeze({
  POR_CONFIRMAR: "ORDER_UNCONFIRMED_AT_CLOSE",
  NUEVO: "ORDER_UNCONFIRMED_AT_CLOSE",
  EN_COCINA: "KITCHEN_WORK_PENDING_AT_CLOSE",
  LISTO: "ORDER_READY_NOT_FINALIZED_AT_CLOSE",
  EN_ENTREGA: "DELIVERY_ACTIVE_AT_CLOSE",
});
const GENERIC_UNRESOLVED_ORDER_STATE_INCIDENT_TYPE = "ORDER_STATE_UNRESOLVED_AT_CLOSE";
const UNPAID_BALANCE_INCIDENT_TYPE = "UNPAID_BALANCE_AT_CLOSE";
const EMPTY_TABLE_INCIDENT_TYPE = "EMPTY_TABLE_LEFT_OPEN";

// ── THE central policy map (Step 3) ─────────────────────────────────────────
// category: matches service_incidents' own CHECK vocabulary exactly
//   (informational/operational/financial/integrity/security).
// severity: matches service_incidents' own CHECK vocabulary exactly
//   (info/warning/critical).
// blocking: whether THIS incident type, by itself, must stop the close. Every
//   entry here is false BY DESIGN for V3.3 — see header. A future slice that
//   needs a genuinely blocking incident type adds it here, not by scattering
//   a new `if (incidentType === ...)` somewhere else.
//
// DELIVERY_ACTIVE_AT_CLOSE is deliberately non-blocking, not "temporarily
// hard": src/agents/riderTrip.js and src/agents/manualGiros.js were both
// audited this session and neither references service_session_id/
// serviceSessionId anywhere — the rider-trip/giro workflow is structurally
// independent of which service session is current. Recording this incident
// is pure observability (the order itself is never touched), so there is no
// carryover risk to prove before allowing it — unlike, say, opening the next
// service (V3.4's job, explicitly out of scope here).
const INCIDENT_POLICY = Object.freeze({
  [UNPAID_BALANCE_INCIDENT_TYPE]: Object.freeze({ category: "financial", severity: "warning", blocking: false }),
  KITCHEN_WORK_PENDING_AT_CLOSE: Object.freeze({ category: "operational", severity: "warning", blocking: false }),
  ORDER_READY_NOT_FINALIZED_AT_CLOSE: Object.freeze({ category: "operational", severity: "warning", blocking: false }),
  DELIVERY_ACTIVE_AT_CLOSE: Object.freeze({ category: "operational", severity: "warning", blocking: false }),
  ORDER_UNCONFIRMED_AT_CLOSE: Object.freeze({ category: "operational", severity: "info", blocking: false }),
  [GENERIC_UNRESOLVED_ORDER_STATE_INCIDENT_TYPE]: Object.freeze({ category: "operational", severity: "warning", blocking: false }),
  [EMPTY_TABLE_INCIDENT_TYPE]: Object.freeze({ category: "informational", severity: "info", blocking: false }),
});

function policyFor(incidentType) {
  const entry = INCIDENT_POLICY[incidentType];
  if (!entry) {
    // Fail closed on a genuinely unknown incident TYPE (a programming defect
    // in this module, not a business scenario) — never silently treat an
    // un-policied type as safe-by-default.
    throw new Error(`v3IncidentPolicy: no policy entry for incident type "${incidentType}"`);
  }
  return entry;
}

// classifyForV3Close — the single authoritative classification for the V3.3
// close engine. Input is exactly what serviceLifecycleEngine.js already has
// in scope after its own Phase B (read) and Phase C (reconcile): the raw
// `orders`/`tableSessions` rows, and `closeout.tickets` — the SAME
// ledger-derived per-order facts (id, unpaidAmount, cancelled) every other
// closeout reader already computes via currentServiceCloseout.js's
// aggregate(). This function never re-derives financial truth itself.
function classifyForV3Close({ orders, tableSessions, tickets } = {}) {
  const safeOrders = Array.isArray(orders) ? orders : [];
  const safeTableSessions = Array.isArray(tableSessions) ? tableSessions : [];
  const safeTickets = Array.isArray(tickets) ? tickets : [];

  const incidents = [];
  const safeAutoActions = [];
  let nonTerminalCount = 0;
  let kitchenPendingCount = 0;
  let listoCount = 0;
  let deliveryPendingCount = 0;

  // ── OPERATIONAL — every non-terminal order becomes a fact, never a block ──
  for (const order of safeOrders) {
    const id = String(order.id != null ? order.id : order.orden_id != null ? order.orden_id : "");
    if (!id) continue;
    const state = String(order.estado || "").toUpperCase();
    if (TERMINAL_ORDER_STATES.has(state)) continue;

    nonTerminalCount += 1;
    if (state === "EN_COCINA") kitchenPendingCount += 1;
    else if (state === "LISTO") listoCount += 1;
    else if (state === "EN_ENTREGA") deliveryPendingCount += 1;

    const incidentType = OPERATIONAL_INCIDENT_TYPE_BY_ORDER_STATE[state] || GENERIC_UNRESOLVED_ORDER_STATE_INCIDENT_TYPE;
    const policy = policyFor(incidentType);
    incidents.push({
      incidentType,
      category: policy.category,
      severity: policy.severity,
      blocking: policy.blocking,
      entityType: "order",
      entityId: id,
      orderId: id,
    });
  }

  // ── FINANCIAL — reuse the SAME ledger-derived ticket facts the caller
  // already computed (currentServiceCloseout.js's aggregate()), never a
  // second, independent "unpaid" rule. financial_exposure_cents is derived
  // here exactly once, from ledger truth, and never fabricated or adjusted —
  // this module never marks anything paid. Deliberately does NOT also return
  // an aggregate unpaid total: the caller already computes
  // toCents(closeout.totals.unpaid) (sum-then-round) for the closeout row's
  // own unpaid_exposure_cents, and summing these per-ticket rounded cents
  // here instead could drift from that by a rounding cent — one authoritative
  // aggregate computation, not two.
  for (const ticket of safeTickets) {
    if (ticket.cancelled) continue;
    const unpaidCents = Math.round((Number(ticket.unpaidAmount) || 0) * 100);
    if (unpaidCents <= 0) continue;
    const policy = policyFor(UNPAID_BALANCE_INCIDENT_TYPE);
    incidents.push({
      incidentType: UNPAID_BALANCE_INCIDENT_TYPE,
      category: policy.category,
      severity: policy.severity,
      blocking: policy.blocking,
      entityType: "order",
      entityId: ticket.id,
      orderId: ticket.id,
      financialExposureCents: unpaidCents,
    });
  }

  // ── INFORMATIONAL / AUTO-RESOLVABLE — a table left open with truly ZERO
  // activity (covers_total IS NULL — the existing, already-built proxy for
  // "nothing happened here", same as mesa_release_empty_session_v1/
  // mesa_guard_covers_monotonic_v1). A table that IS occupied with real
  // activity is NOT an incident at all — it is the accepted, expected
  // cross-service-boundary state V3.2.1's occupied-table authorization
  // already exists to allow; it is recorded only in the closeout's existing
  // occupiedTablesAtClose operational fact, never here.
  let emptyTablesLeftOpen = 0;
  for (const tableSession of safeTableSessions) {
    if (tableSession.status !== "open") continue;
    if (tableSession.covers_total !== null && tableSession.covers_total !== undefined) continue;
    emptyTablesLeftOpen += 1;
    const policy = policyFor(EMPTY_TABLE_INCIDENT_TYPE);
    const tableSessionId = tableSession.id;
    incidents.push({
      incidentType: EMPTY_TABLE_INCIDENT_TYPE,
      category: policy.category,
      severity: policy.severity,
      blocking: policy.blocking,
      entityType: "table_session",
      entityId: String(tableSessionId),
      tableSessionId,
    });
    safeAutoActions.push({
      type: "RELEASE_EMPTY_TABLE",
      tableSessionId,
      workspaceId: tableSession.workspace_id,
      // Ties a safe action back to the exact incident it may resolve, using
      // the SAME (entityType, entityId) dedupe key the incident-creation RPC
      // (service_incidents_dedupe_uq) already keys on — never a separate,
      // looser matching rule.
      incidentEntityType: "table_session",
      incidentEntityId: String(tableSessionId),
    });
  }

  return {
    incidents,
    safeAutoActions,
    nonTerminalCount,
    kitchenPendingCount,
    listoCount,
    deliveryPendingCount,
    emptyTablesLeftOpen,
  };
}

module.exports = {
  TERMINAL_ORDER_STATES,
  OPERATIONAL_INCIDENT_TYPE_BY_ORDER_STATE,
  GENERIC_UNRESOLVED_ORDER_STATE_INCIDENT_TYPE,
  UNPAID_BALANCE_INCIDENT_TYPE,
  EMPTY_TABLE_INCIDENT_TYPE,
  INCIDENT_POLICY,
  policyFor,
  classifyForV3Close,
};
