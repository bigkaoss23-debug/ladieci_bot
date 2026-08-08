"use strict";
// ===============================================================
// rolloverClassifier.js — SERVICE CLOSEOUT V2 / Slice 3
//
// Fixes RC-2 (the OTHER half): "a previous service with unresolved
// non-hard-blocking anomalies must not indefinitely prevent the next service
// from becoming operational." This module is the MINIMUM classifier that
// turns "what does this session's live data actually look like right now"
// into a single, authoritative decision: what (if anything) is a true hard
// blocker, and what is merely a fact that must survive as a persisted
// incident while the rollover proceeds anyway.
//
// Pure: given the already-read rows for one session, produces a
// classification. No DB access, no RPC calls — read once (by the caller),
// classify once (here), act once (the orchestrator, incidentSafeRollover.js).
// This is deliberately the ONLY place that decides "what kind of anomaly is
// this" — per the plan's Step 4, independent subsystems must not each decide
// separately whether a rollover may proceed.
//
// TRUE HARD BLOCKERS ARE RARE BY DESIGN. Per the plan: a rollover may fail
// closed only when proceeding could create two current sessions, lose/corrupt
// authoritative data, lose financial evidence, or leave closeout state
// ambiguous. A forgotten open table, pending kitchen work, an unpaid balance,
// a stale operational order — NONE of these are hard blockers here; they all
// become incidents instead, and the existing archive engine (chiudiServizio,
// called with deleteAttivi=true by every automatic rollover path) already
// safely force-archives whatever is still non-terminal. This module's only
// job is to make sure that force-archival leaves a paper trail instead of
// silently vanishing the fact that something was still in flight.
//
// Vocabulary note: incident_type is free text at the DB layer (see
// migrations/2026-08-08_service_closeout_incidents_foundation.sql) with no
// established values anywhere else in this codebase yet — this module is the
// first real consumer and is the source of truth for the incident_type
// strings used below.
// ===============================================================

const crypto = require("crypto");
const { aggregate: aggregateCloseout } = require("../closeout/currentServiceCloseout");

// Mirrors chiudiServizio's own PASSO 3 / active-order-gate terminal-state set
// (src/utils/servizio.js) exactly — "still needs archiving as force-closed"
// here means precisely the same thing it means there.
const TERMINAL_ORDER_STATES = new Set([
  "RETIRADO", "COMPLETADO", "COMPLETATO", "CANCELADO",
  "CANCELLED", "ANULADO", "CHIUSO_FORZATO",
]);

// Non-terminal estado -> incident_type. Anything non-terminal not listed here
// (an unrecognized/null state) still gets an incident — it just falls
// through to the generic ORDER_STATE_UNRESOLVED_AT_CLOSE below, never
// silently skipped.
const OPERATIONAL_INCIDENT_TYPE_BY_STATE = Object.freeze({
  POR_CONFIRMAR: "ORDER_UNCONFIRMED_AT_CLOSE",
  NUEVO: "ORDER_UNCONFIRMED_AT_CLOSE",
  EN_COCINA: "KITCHEN_WORK_PENDING_AT_CLOSE",
  LISTO: "ORDER_READY_NOT_FINALIZED_AT_CLOSE",
  EN_ENTREGA: "DELIVERY_ACTIVE_AT_CLOSE",
});

// info for the two "hasn't really started yet" states, warning for anything
// that represents real kitchen/delivery work already committed.
const INFO_SEVERITY_STATES = new Set(["POR_CONFIRMAR", "NUEVO"]);

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

// classifyForIncidentSafeRollover — the single authoritative classification.
// Input rows are exactly what a plain PostgREST select over `ordenes`,
// `table_sessions` (status=open), and `order_financial_events`, filtered by
// this session's service_session_id, returns — no other shape is assumed.
function classifyForIncidentSafeRollover({ session, orders, tableSessions, financialEvents } = {}) {
  const hardBlockers = [];
  if (!session || !session.business_date || !session.service_kind) {
    hardBlockers.push({
      code: "SESSION_IDENTITY_INVALID",
      message: "session is missing business_date or service_kind — cannot safely classify or snapshot",
    });
  }

  const safeOrders = Array.isArray(orders) ? orders : [];
  const safeTableSessions = Array.isArray(tableSessions) ? tableSessions : [];
  const safeFinancialEvents = Array.isArray(financialEvents) ? financialEvents : [];

  const informationalIncidents = [];
  const operationalIncidents = [];
  const financialIncidents = [];
  const safeAutoActions = [];

  // ── OPERATIONAL — every non-terminal order becomes a fact, never a block ──
  for (const order of safeOrders) {
    const id = String(order.id != null ? order.id : order.orden_id != null ? order.orden_id : "");
    if (!id) continue;
    const state = String(order.estado || "").toUpperCase();
    if (TERMINAL_ORDER_STATES.has(state)) continue;
    const incidentType = OPERATIONAL_INCIDENT_TYPE_BY_STATE[state] || "ORDER_STATE_UNRESOLVED_AT_CLOSE";
    operationalIncidents.push({
      incidentType,
      category: "operational",
      severity: INFO_SEVERITY_STATES.has(state) ? "info" : "warning",
      entityType: "order",
      entityId: id,
      orderId: id,
    });
  }

  // ── FINANCIAL — reuse the SAME ledger-derived aggregator the live closeout
  // and the archived summary already share (currentServiceCloseout.aggregate),
  // never a second, weaker "unpaid" rule. financial_exposure_cents is the
  // authoritative figure future post-close resolution (Slice 2/2.1/2.2's
  // archived_order_financial_resolutions) will read against — it must be
  // derived here exactly once, from ledger truth, and never fabricated or
  // adjusted (this module never marks anything paid).
  const closeout = aggregateCloseout(session, safeOrders, safeFinancialEvents);
  for (const ticket of closeout.tickets) {
    if (ticket.cancelled) continue;
    if (ticket.unpaidAmount > 0) {
      financialIncidents.push({
        incidentType: "UNPAID_BALANCE_AT_CLOSE",
        category: "financial",
        severity: "warning",
        entityType: "order",
        entityId: ticket.id,
        orderId: ticket.id,
        financialExposureCents: Math.round(round2(ticket.unpaidAmount) * 100),
      });
    }
  }

  // ── INFORMATIONAL / AUTO-RESOLVABLE — a table left open with truly ZERO
  // activity (covers_total IS NULL is the existing, already-built proxy for
  // "nothing happened here" — see mesa_release_empty_session_v1 /
  // mesa_guard_covers_monotonic_v1). Only THIS exact case is safe to
  // auto-resolve; a table with any real covers/activity is left to the
  // existing MESA_TABLES_NOT_RELEASED gate, unchanged, because it represents
  // a real open tab, not a forgotten empty seat.
  for (const tableSession of safeTableSessions) {
    if (tableSession.status !== "open") continue;
    if (tableSession.covers_total !== null && tableSession.covers_total !== undefined) continue;
    const tableSessionId = tableSession.id;
    safeAutoActions.push({
      type: "RELEASE_EMPTY_TABLE",
      tableSessionId,
      workspaceId: tableSession.workspace_id,
    });
    informationalIncidents.push({
      incidentType: "EMPTY_TABLE_LEFT_OPEN",
      category: "informational",
      severity: "info",
      entityType: "table_session",
      entityId: String(tableSessionId),
      tableSessionId,
      autoResolve: true,
      autoResolutionType: "auto_released_empty_table",
      autoResolutionNote: "Table session had zero activity (covers_total IS NULL) at service close; automatically released.",
    });
  }

  const ordersByState = {};
  for (const order of safeOrders) {
    const state = String(order.estado || "UNKNOWN").toUpperCase();
    ordersByState[state] = (ordersByState[state] || 0) + 1;
  }

  const snapshotPayload = {
    businessDate: session?.business_date || null,
    serviceKind: session?.service_kind || null,
    ordersCount: safeOrders.length,
    ordersByState,
    openTableSessionsCount: safeTableSessions.filter((t) => t.status === "open").length,
    orders: safeOrders.map((o) => ({
      id: o.id != null ? o.id : o.orden_id,
      estado: o.estado || null,
      totale: o.totale != null ? Number(o.totale) : null,
      tipoConsegna: o.tipo_consegna || null,
      tableSessionId: o.table_session_id || null,
    })),
    tableSessions: safeTableSessions.map((t) => ({
      id: t.id,
      tableId: t.table_id,
      status: t.status,
      coversTotal: t.covers_total ?? null,
    })),
    financialTotals: {
      gross: closeout.totals.gross,
      collected: closeout.totals.collected,
      unpaid: closeout.totals.unpaid,
    },
  };

  return {
    hardBlockers,
    informationalIncidents,
    operationalIncidents,
    financialIncidents,
    safeAutoActions,
    snapshotPayload,
  };
}

// computeStateFingerprint — SLICE 3.1. A cheap, deterministic-enough digest
// of exactly the raw material classifyForIncidentSafeRollover reads (never
// its derived output), used by incidentSafeRollover.js to answer "has live
// state moved on since the active attempt's snapshot was captured?" without
// relying on elapsed time (plan STEP 7 explicitly rules that out) or on any
// field the codebase doesn't already read for this exact purpose. This is a
// change-detection heuristic, not a cryptographic commitment — rows are
// sorted by id first so two reads of genuinely identical state always hash
// identically regardless of the order PostgREST happens to return them in.
function computeStateFingerprint({ orders, tableSessions, financialEvents } = {}) {
  const canon = (rows) => (Array.isArray(rows) ? rows : []).slice().sort((a, b) => {
    const idA = String((a && a.id) != null ? a.id : "");
    const idB = String((b && b.id) != null ? b.id : "");
    return idA < idB ? -1 : idA > idB ? 1 : 0;
  });
  const material = JSON.stringify({
    orders: canon(orders),
    tableSessions: canon(tableSessions),
    financialEvents: canon(financialEvents),
  });
  return crypto.createHash("sha256").update(material).digest("hex");
}

module.exports = {
  TERMINAL_ORDER_STATES,
  OPERATIONAL_INCIDENT_TYPE_BY_STATE,
  classifyForIncidentSafeRollover,
  computeStateFingerprint,
};
