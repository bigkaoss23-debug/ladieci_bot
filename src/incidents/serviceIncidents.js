"use strict";
// ===============================================================
// serviceIncidents.js — SERVICE CLOSEOUT V2 / Slice 1
//
// Thin wrapper over create_service_incident / resolve_service_incident (see
// migrations/2026-08-08_service_closeout_incidents_foundation.sql), mirroring
// ../serviceSessions/serviceSessionLifecycle.js's style.
//
// report() is NOT a classifier — nothing here decides WHEN an incident
// exists (economicBoundaryEngine.js's own Phase C explicitly does NOT call
// it for ordinary intraday carryover; previousBusinessDayResidue.js, P0-C3,
// is the first real caller, for cross-business-date residue only). This
// module only records and resolves incidents a caller has already decided
// to report.
//
// Authorization is enforced twice, deliberately, matching the house pattern
// already used for order_financial_events (ofe_by_role_chk /
// ofe_actor_role_map_chk): once here in JS (fail fast, no round trip for an
// obviously-unauthorized caller), and again inside resolve_service_incident
// itself.
//
// TRUST BOUNDARY (Slice 1.1, resolved P0-C3): NEITHER check is real
// authorization proof by itself — both compare against a `role` string this
// module receives as a plain argument. A caller-supplied "admin" string is
// NEVER, by itself, valid proof of admin-ness. index.js's "resolveServiceIncident"
// action (P0-C3, the only live HTTP caller of resolve()) follows exactly the
// rule this comment always required: `role` is `req.authCtx.role`, a role
// claim derived server-side from the verified actor identity (src/auth/jwt.js)
// via the action's own entry in authorizationContract.js/legacyActionRoles.js
// — never read from `req.body`/`req.query`. Any future caller of resolve()
// MUST follow the same rule.
// ===============================================================

const { sbRpc, sbSelect } = require("../utils/supabase");

const RESOLVER_ROLE = "admin"; // only role allowed to resolve, matches the SQL-side check

function normalize(rpcResult, transportCode) {
  if (!rpcResult || rpcResult.ok !== true || !rpcResult.body || typeof rpcResult.body !== "object") {
    return { ok: false, code: transportCode };
  }
  return rpcResult.body;
}

function publicIncident(row) {
  if (!row || typeof row !== "object") return null;
  return {
    id: row.id,
    serviceSessionId: row.service_session_id,
    businessDate: row.business_date,
    serviceKind: row.service_kind,
    closeoutCorrelationId: row.closeout_correlation_id,
    snapshotId: row.snapshot_id || null,
    incidentType: row.incident_type,
    category: row.category,
    severity: row.severity,
    entityType: row.entity_type || null,
    entityId: row.entity_id || null,
    orderId: row.order_id || null,
    tableSessionId: row.table_session_id || null,
    giroId: row.giro_id || null,
    riderId: row.rider_id || null,
    financialExposureCents: row.financial_exposure_cents ?? null,
    detectedAt: row.detected_at,
    detectedBy: row.detected_by,
    autoResolved: row.auto_resolved === true,
    resolutionStatus: row.resolution_status,
    resolutionType: row.resolution_type || null,
    resolvedAt: row.resolved_at || null,
    resolvedBy: row.resolved_by || null,
    resolutionNote: row.resolution_note || null,
  };
}

function createServiceIncidents({ rpc = sbRpc, select = sbSelect } = {}) {
  return Object.freeze({
    // Idempotent: same (closeoutCorrelationId, incidentType, entityType,
    // entityId) returns the existing incident, created:false. A different
    // entity or a different closeout attempt always creates a separate row —
    // never silently merged.
    async report({
      serviceSessionId,
      closeoutCorrelationId,
      incidentType,
      category,
      severity,
      detectedBy,
      entityType = null,
      entityId = null,
      orderId = null,
      tableSessionId = null,
      giroId = null,
      riderId = null,
      financialExposureCents = null,
      snapshotId = null,
      autoResolve = false,
      autoResolutionType = null,
      autoResolutionNote = null,
    }) {
      const res = normalize(await rpc("create_service_incident", {
        p_service_session_id: serviceSessionId,
        p_closeout_correlation_id: closeoutCorrelationId,
        p_incident_type: incidentType,
        p_category: category,
        p_severity: severity,
        p_detected_by: detectedBy,
        p_entity_type: entityType,
        p_entity_id: entityId,
        p_order_id: orderId,
        p_table_session_id: tableSessionId,
        p_giro_id: giroId,
        p_rider_id: riderId,
        p_financial_exposure_cents: financialExposureCents,
        p_snapshot_id: snapshotId,
        p_auto_resolve: autoResolve,
        p_auto_resolution_type: autoResolutionType,
        p_auto_resolution_note: autoResolutionNote,
      }), "SERVICE_INCIDENT_TRANSPORT_ERROR");

      if (res.ok !== true) {
        return { success: false, created: false, code: res.code || "SERVICE_INCIDENT_REPORT_FAILED", incident: null };
      }
      return { success: true, created: res.created === true, code: res.code, incident: publicIncident(res.incident) };
    },

    // Backend-enforced: rejects anything but role === 'admin' before ever
    // reaching the DB (the DB enforces the same rule independently — see
    // migration header). Operators/waiters cannot resolve incidents through
    // this module no matter what a caller claims.
    async resolve({
      incidentId,
      resolvedBy,
      role,
      resolutionType,
      resolutionStatus = "resolved",
      resolutionNote = null,
    }) {
      if (role !== RESOLVER_ROLE) {
        return { success: false, code: "INCIDENT_RESOLUTION_FORBIDDEN", incident: null };
      }
      const res = normalize(await rpc("resolve_service_incident", {
        p_incident_id: incidentId,
        p_resolved_by: resolvedBy,
        p_actor_role: role,
        p_resolution_type: resolutionType,
        p_resolution_status: resolutionStatus,
        p_resolution_note: resolutionNote,
      }), "SERVICE_INCIDENT_TRANSPORT_ERROR");

      if (res.ok !== true) {
        return { success: false, code: res.code || "SERVICE_INCIDENT_RESOLVE_FAILED", incident: null };
      }
      return { success: true, idempotent: res.idempotent === true, code: res.code, incident: publicIncident(res.incident) };
    },

    // Queryable by service_session_id (plan §3 requirement), read-only SELECT.
    async listBySession({ serviceSessionId }) {
      const rows = await select(
        "service_incidents",
        `service_session_id=eq.${encodeURIComponent(serviceSessionId)}&order=detected_at.desc`
      );
      if (!Array.isArray(rows)) return [];
      return rows.map(publicIncident);
    },
  });
}

const serviceIncidents = createServiceIncidents();

module.exports = { createServiceIncidents, serviceIncidents, publicIncident, RESOLVER_ROLE };
