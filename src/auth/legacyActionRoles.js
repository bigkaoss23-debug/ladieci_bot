// legacyActionRoles.js — canonical authorization map for the legacy /api dispatcher.
//
// S2-1B: the legacy `/api?action=...` surface historically trusted only the shared
// X-Api-Key. This module is the single authoritative source of "which role may call
// which legacy action, and does it require a fresh session". The Netlify proxy keeps a
// narrower rider allow-list purely as defense-in-depth; THIS map is authoritative.
//
// Principals (from auth_actors.role): 'admin', 'operator', 'rider'.
//   owner            -> admin
//   operator_primary -> operator   (equal permissions...)
//   operator_backup  -> operator   (...to operator_primary — no reduced role)
//   rider            -> rider
//
// Every authenticated legacy action requires a current session_version (fresh = true).
// Unknown actions are denied by default (getActionRule -> null -> caller returns 404).

"use strict";

// Exact rider allow-list (S2-1A2/A3): only the proven rider workflow actions.
// Rider transition/membership predicates are enforced transactionally in the RPC
// layer (src/agents/riderTrip.js); this map only gates the role.
const RIDER_ALLOWED = Object.freeze([
  "getOrdenes",
  "getManualGiros",
  "getDriverStatus",
  "marcarEnEntrega",
  "registrarSalidaDriver",
  // marcarEntregado: this HTTP-level grant also nominally admits admin/operator (it is
  // not in ADMIN_ONLY below). That is a DOCUMENTED, TESTED, INTENTIONALLY INERT grant,
  // not a live authority — the canonical RPC it routes to (rider_collect_and_complete_
  // stop, money collection) refuses admin/operator unconditionally and always has (see
  // src/auth/authorizationContract.js's RIDER_ONLY_ACTIONS, reclassified 2026-09-18,
  // POST_OPUS_REVIEW_REMEDIATION Scope A). Unlike marcarEnEntrega/start_rider_trip_v2
  // (migration 137, which widened the CANONICAL layer to match this HTTP grant), the
  // correct fix here was the opposite direction: keep the RPC rider-exclusive (only the
  // physical rider can know a delivery actually happened) and stop the operator UI from
  // ever attempting this call — TabEntregas.jsx's "Driver de vuelta" control now calls
  // close_rider_trip instead. Proven end to end (real RPC calls, not just static text) by
  // ci/giro-authority-certification/harness/groups/b1RiderDispatchOperatorParity.js.
  "marcarEntregado",
  "chiudiGiro",
  // Planner W6.6 — canonical Trip Authority read (trip_state, frozen
  // membership, progress, ETA). Same class as getDriverStatus/getManualGiros:
  // the rider needs it for the same self-service delivery workflow.
  "getTripOperationalState",
]);

// Admin-only legacy actions (operator + rider denied). Configuration and dev/parse
// tooling. B7 financial/Auth administration is NOT here — it lives on separate
// protected routes (/api/financial/*, /api/auth/v2/login) and never reaches this map.
const ADMIN_ONLY = Object.freeze([
  "getConfig",
  "getStorico",
  "getOrdenesArchivio",
  "getEconomiaLedger",
  "getServiceIncidents",
  "resolveServiceIncident",
  "getDeliveryLogs",
  "getSuggerimenti",
  "rigeneraSuggerimenti",
  "approvaSuggerimento",
  "setConfig",
  "debugInterpreta",
  "debugMenuShadow",
  "parseOrdineDaRisposta",
  "getAuthActors",
  "setActorPin",
  "verifyOwnPin",
]);

// The complete set of legacy actions handled by the index.js dispatcher (GET + POST),
// plus the special REST path /api/delivery/shadow-preview represented as "shadowPreview".
// This list MUST stay in sync with the dispatcher; legacyActionRoleMapCompleteness.test.js
// parses index.js and fails if any dispatcher action is missing here.
const ALL_ACTIONS = Object.freeze([
  // ── GET reads ──
  "getOrdenes", "getWaMsgs", "getConfig", "chiudiServizio", "triggerCloseIfNeeded",
  "scanServizio", "backupSerata", "rigeneraSuggerimenti", "approvaSuggerimento",
  "getConvThread", "generaRispostaIA", "getClientes", "debugInterpreta", "debugMenuShadow",
  "getManualGiros", "getDriverStatus", "getMenu", "getCurrentServiceCloseout", "getOrdenesRecent", "getOrdenesArchivadosSesion", "getWaMessages",
  "getTripOperationalState",
  "getStorico", "getOrdenesArchivio", "getEconomiaLedger", "getServiceIncidents", "getDeliveryLogs", "getSuggerimenti",
  "getAuthActors",
  "getConversacionesActivas", "getClienteByTelefono", "getWaMessageById",
  "getOrdenById", "getConvByWaId", "getConvChats",
  // ── POST writes ──
  "cambiaStato", "creaOrdine", "modificaOrdine", "aggiornaRispostaBot", "setConfig",
  "rispondiWA", "updateWaStato", "updateOrden", "updateEstado", "marcarEnEntrega",
  "marcarEntregado", "asignarRepartidor", "registrarSalidaDriver", "chiudiGiro",
  "marcarLlegado", "setUiOffset", "resolveAddress", "previewOrderTiming",
  // PORT-55 — premium planner previews. Read-only siblings of previewOrderTiming:
  // admin + operator, never rider, never admin-only. No write reaches the DB.
  "previewOrderPlanner", "previewStrategicOpportunities", "previewManualGiroRoute",
  "createOrden", "updateNotaCucina", "eliminaOrdine", "eliminaConversazione",
  "upsertCliente", "parseOrdineDaRisposta", "createManualGiro", "addOrderToManualGiro",
  "removeOrderFromManualGiro", "dissolveManualGiro",
  "setActorPin", "verifyOwnPin", "openServiceSession", "ensureCurrentServiceSession",
  "rollEconomicPeriod", "resolveServiceIncident", "consolidateServicePeriod",
  // ── special REST path ──
  "shadowPreview",
]);

const RIDER_SET = new Set(RIDER_ALLOWED);
const ADMIN_ONLY_SET = new Set(ADMIN_ONLY);

// Rider actions that must be routed through the transactional trip primitives
// (src/agents/riderTrip.js) rather than the generic legacy handler.
const RIDER_TRIP_ACTIONS = Object.freeze(new Set([
  "marcarEnEntrega", "registrarSalidaDriver", "marcarEntregado", "chiudiGiro",
]));

// Build the allowed-principals set for an action.
function allowedRolesFor(action) {
  const roles = new Set(["admin"]); // admin may perform every valid legacy action
  if (!ADMIN_ONLY_SET.has(action)) roles.add("operator");
  if (RIDER_SET.has(action)) roles.add("rider");
  return roles;
}

// getActionRule(action) -> { action, roles:Set, fresh:true, rider:boolean, tripPrimitive:boolean }
// or null when the action is unknown (caller MUST return a normalized 404).
function getActionRule(action) {
  if (typeof action !== "string" || !ALL_ACTIONS.includes(action)) return null;
  return {
    action,
    roles: allowedRolesFor(action),
    fresh: true, // every authenticated legacy action requires a current session_version
    rider: RIDER_SET.has(action),
    tripPrimitive: RIDER_TRIP_ACTIONS.has(action),
  };
}

function isKnownAction(action) {
  return typeof action === "string" && ALL_ACTIONS.includes(action);
}

// isAllowed(role, action) — pure decision helper (no I/O).
function isAllowed(role, action) {
  const rule = getActionRule(action);
  if (!rule) return false;
  return rule.roles.has(role);
}

module.exports = {
  ALL_ACTIONS,
  RIDER_ALLOWED,
  ADMIN_ONLY,
  RIDER_TRIP_ACTIONS,
  getActionRule,
  isKnownAction,
  isAllowed,
  allowedRolesFor,
};
