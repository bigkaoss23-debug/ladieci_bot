'use strict';
// Access Control V2 — Block B4: backend authorization contract (UNWIRED).
//
// This module is the EXECUTABLE SOURCE OF TRUTH for the finalized B4 contract.
// It is pure: no env, no I/O, no logging, no DB. It is NOT wired into index.js
// or any handler — it makes no runtime authorization decision yet. Enforcement
// (transport, middleware, service-token, B7 predicate evaluation) is deferred.
//
// Canonical human-readable mirror: docs/access-control/B4_AUTHORIZATION_CONTRACT.md
// (that document is generated/mirrored from the frozen tables below — changing
// the contract here REQUIRES updating the tests and the document together).
//
// Fail-closed everywhere: unknown principal, unknown action, malformed input,
// human→machine-only, service→human action, and unresolved predicates never
// imply permission. There is NO implicit "admin allows everything" default —
// `triggerCloseIfNeeded` explicitly denies admin, and every action's resolved
// principal set is asserted per-action in tests/authorizationContract.test.js.

// ── Principals ───────────────────────────────────────────────────────────────
// Human JWT principals (B3): admin, operator, rider. `service` is machine-only
// and must NEVER be produced by a human login (see src/auth/login.js / jwt.js).
const PRINCIPALS = Object.freeze(['admin', 'operator', 'rider', 'service']);
const HUMAN_PRINCIPALS = Object.freeze(['admin', 'operator', 'rider']);

// ── Canonical routed-action set (57) ─────────────────────────────────────────
// Authoritative classification input. The live router (index.js) is extracted
// dynamically and proven set-equal to this list (no matrix-only / router-only).
const CANONICAL_ACTIONS = Object.freeze([
  'getOrdenes', 'getWaMsgs', 'getConfig', 'chiudiServizio', 'triggerCloseIfNeeded',
  'scanServizio', 'backupSerata', 'rigeneraSuggerimenti', 'approvaSuggerimento',
  'getConvThread', 'generaRispostaIA', 'getClientes', 'debugInterpreta', 'debugMenuShadow', 'getManualGiros', 'getMenu', 'getCurrentServiceCloseout',
  'getDriverStatus', 'getOrdenesRecent', 'getWaMessages', 'getStorico', 'getOrdenesArchivio',
  'getEconomiaLedger',
  // SERVICE CLOSEOUT V2 / SLICE 4A — getServiceIncidents added: the Admin
  // "Incidencias" backlog read (filterable list + single-incident detail).
  // Same class as getStorico/getEconomiaLedger: admin-only, fresh-auth,
  // sensitive financial/operational history.
  'getServiceIncidents',
  // P0-C3 — resolveServiceIncident added: the first live mutation route for
  // service_incidents (getServiceIncidents above stays read-only). Thin
  // wrapper over the already-built incident-resolution primitive (already
  // admin-gated at the DB layer since 2026-08-08) — same class, same
  // sensitivity, same fresh-auth requirement as getServiceIncidents.
  'resolveServiceIncident',
  // LISTOS_ARCHIVADOS_V1 — session-scoped terminal-orders sibling of getOrdenes.
  // Same admin+operator access as getOrdenes' non-rider consumers; deliberately
  // NOT rider-enabled (getOrdenes' rider path goes through a separate intercept
  // -- riderReads.getRiderOrdenes() -- that this action does not have).
  'getOrdenesArchivadosSesion',
  'getDeliveryLogs', 'getSuggerimenti', 'getConversacionesActivas', 'getClienteByTelefono',
  'getWaMessageById', 'getOrdenById', 'getConvByWaId', 'getConvChats', 'cambiaStato',
  'creaOrdine', 'modificaOrdine', 'aggiornaRispostaBot', 'setConfig', 'rispondiWA',
  'updateWaStato', 'updateOrden', 'updateEstado', 'marcarEnEntrega', 'marcarEntregado',
  'asignarRepartidor', 'registrarSalidaDriver', 'chiudiGiro', 'marcarLlegado', 'setUiOffset',
  'resolveAddress', 'previewOrderTiming', 'createOrden', 'updateNotaCucina', 'eliminaOrdine',
  // PORT-55 — premium planner previews (read-only, operator_shared).
  'previewOrderPlanner', 'previewStrategicOpportunities', 'previewManualGiroRoute',
  'eliminaConversazione', 'upsertCliente', 'parseOrdineDaRisposta', 'createManualGiro',
  'addOrderToManualGiro', 'removeOrderFromManualGiro', 'dissolveManualGiro',
  'getAuthActors', 'setActorPin', 'verifyOwnPin', 'openServiceSession', 'ensureCurrentServiceSession',
  'rollEconomicPeriod',
  // R-DAY4 — explicit Service Period consolidation checkpoint. Same admin+
  // operator class as rollEconomicPeriod (not admin-only, not rider-enabled).
  'consolidateServicePeriod',
  // Planner W6.6 — canonical Trip Authority wire bridge. Classified here as
  // admin+operator only (NOT added to RIDER_ENABLED_ACTIONS below), exactly
  // like this draft already classifies getOrdenes/getManualGiros: this B4
  // matrix is a known, documented, unwired draft that already diverges from
  // legacyActionRoles.js (the LIVE guard) on those two rider-reachable
  // actions — see actionPolicyRegistry.js's own discrepancy notes. The LIVE
  // guard does grant rider access (same class as getDriverStatus).
  'getTripOperationalState',
]);
const CANONICAL_SET = Object.freeze(new Set(CANONICAL_ACTIONS));

// ── Alias map — FROZEN EMPTY ─────────────────────────────────────────────────
// The four look-alike pairs (creaOrdine/createOrden, cambiaStato/updateEstado,
// modificaOrdine/updateOrden, getWaMsgs/getWaMessages) are SEPARATE canonical
// actions, NOT aliases: separately routed, possibly different handler semantics.
// Any future alias must be added here AND to the contract doc/tests explicitly.
const ALIAS_MAP = Object.freeze(Object.create(null));

// ── Classification groups (frozen) ───────────────────────────────────────────
// service-only: machine principal, denied to every human.
const SERVICE_ONLY_ACTIONS = Object.freeze(['triggerCloseIfNeeded']);
const SERVICE_ONLY_SET = Object.freeze(new Set(SERVICE_ONLY_ACTIONS));

// admin-only: admin allowed; operator/rider/service denied.
const ADMIN_ONLY_ACTIONS = Object.freeze([
  'getConfig', 'rigeneraSuggerimenti', 'approvaSuggerimento', 'getClientes',
  'debugInterpreta', 'debugMenuShadow', 'getStorico', 'getOrdenesArchivio', 'getEconomiaLedger',
  'getServiceIncidents', 'resolveServiceIncident',
  'getDeliveryLogs', 'getSuggerimenti',
  'setConfig', 'eliminaOrdine', 'eliminaConversazione',
  'getAuthActors', 'setActorPin', 'verifyOwnPin',
]);
const ADMIN_ONLY_SET = Object.freeze(new Set(ADMIN_ONLY_ACTIONS));

// rider-enabled (6): admin+operator+rider; service denied. Rider invocation
// additionally requires a B7 resource/state predicate (see RIDER_PREDICATES).
//
// marcarEntregado moved OUT of this group on 2026-09-18 (POST_OPUS_REVIEW_REMEDIATION,
// Scope A) into RIDER_ONLY_ACTIONS below. It reaches rider_collect_and_complete_stop
// (money collection), whose own SQL header is explicit and absolute: "this contract
// never serves admin/operator, and never lets a rider borrow their authority" — migration
// 137 (which widened marcarEnEntrega's canonical RPC to admin/operator/rider) deliberately
// left this RPC untouched. Classifying marcarEntregado as admin+operator+rider here was a
// genuine contract/implementation drift, independent of and pre-dating migration 137: this
// draft's own "no rider predicate for admin/operator" rule never applied in practice
// because admin/operator could never reach OK on this action at the canonical layer — only
// a real rider ever could. The live HTTP guard (legacyActionRoles.js) still nominally
// grants admin/operator this legacy action name; that is now a documented, tested,
// intentionally-inert grant (see legacyActionRoles.js's own comment on RIDER_ALLOWED), not
// a contradiction of this contract — B4 describes the canonical decision, and the
// canonical decision has never been anything but rider-only for this specific action.
const RIDER_ENABLED_ACTIONS = Object.freeze([
  'getDriverStatus', 'updateEstado', 'marcarEnEntrega',
  'registrarSalidaDriver', 'chiudiGiro', 'marcarLlegado',
]);
const RIDER_ENABLED_SET = Object.freeze(new Set(RIDER_ENABLED_ACTIONS));

// rider-only (1): rider EXCLUSIVELY; admin/operator/service all denied, with NO implicit
// admin-allows-everything shortcut. The one live money-collection action
// (rider_collect_and_complete_stop) — see the note above RIDER_ENABLED_ACTIONS.
const RIDER_ONLY_ACTIONS = Object.freeze(['marcarEntregado']);
const RIDER_ONLY_SET = Object.freeze(new Set(RIDER_ONLY_ACTIONS));

// fresh-auth: EXPLICIT metadata — never inferred from admin-only status,
// action name, mutation/read class, or substrings.
const FRESH_AUTH_ACTIONS = Object.freeze([
  'getConfig', 'rigeneraSuggerimenti', 'approvaSuggerimento', 'getClientes', 'getStorico',
  'getOrdenesArchivio', 'getEconomiaLedger', 'getServiceIncidents', 'getDeliveryLogs', 'setConfig', 'eliminaOrdine',
  'eliminaConversazione', 'getSuggerimenti',
  'getAuthActors', 'setActorPin', 'verifyOwnPin', 'getCurrentServiceCloseout', 'openServiceSession',
  // S2-7D6B — the automatic ensure runs on every Servicio entry, so it must NOT be
  // fresh-auth: it is the silent path, not a privileged one-off.
  // P0-C2 — rollEconomicPeriod mutates service-session lifecycle state (same
  // sensitivity class as openServiceSession, which is already fresh-auth
  // here) and, unlike ensureCurrentServiceSession, is never called silently.
  'rollEconomicPeriod',
  // P0-C3 — resolveServiceIncident mutates an audit/incident record; same
  // language-guard: allow-legacy eliminaOrdine is the existing action name, named here only for a sensitivity-class comparison, not new vocabulary
  // sensitivity class as eliminaOrdine/setActorPin, always an explicit,
  // one-off admin decision, never called silently.
  'resolveServiceIncident',
  // R-DAY4 — consolidateServicePeriod records an immutable economic
  // checkpoint; same class as rollEconomicPeriod immediately above (mutates
  // lifecycle-adjacent state, always an explicit one-off decision, never
  // called silently).
  'consolidateServicePeriod',
]);
const FRESH_AUTH_SET = Object.freeze(new Set(FRESH_AUTH_ACTIONS));

// B7 rider predicate identifiers (7). Metadata only — B4 stores IDs, never
// evaluates them. When enforcement is wired, a rider action bearing a predicate
// with no evaluator MUST fail closed. Admin/operator do not use these.
const RIDER_PREDICATES = Object.freeze({
  getDriverStatus:       'RIDER_OWN_DRIVER_STATUS',
  updateEstado:          'RIDER_UPDATE_ESTADO_SCOPE',
  marcarEnEntrega:       'RIDER_MARK_EN_ENTREGA_SCOPE',
  marcarEntregado:       'RIDER_MARK_ENTREGADO_SCOPE',
  registrarSalidaDriver: 'RIDER_REGISTER_SALIDA_SCOPE',
  chiudiGiro:            'RIDER_CLOSE_GIRO_SCOPE',
  marcarLlegado:         'RIDER_MARK_LLEGADO_SCOPE',
});

// ── Resolved, explicit per-action contract ───────────────────────────────────
// Generated from the frozen groups above, then frozen. The resolved `allowed`
// set is stored EXPLICITLY per action (no runtime "admin=*" shortcut). Tests
// assert the resolved 56×4 decision surface.
function buildContract(action) {
  const machineOnly = SERVICE_ONLY_SET.has(action);
  const riderOnly = RIDER_ONLY_SET.has(action);
  const allowed = [];
  if (machineOnly) {
    allowed.push('service'); // service-only: humans explicitly excluded
  } else if (riderOnly) {
    allowed.push('rider'); // rider-only: NOT even admin — see RIDER_ONLY_ACTIONS note
  } else {
    allowed.push('admin'); // admin: every non-service-only, non-rider-only action
    if (!ADMIN_ONLY_SET.has(action)) allowed.push('operator');
    if (RIDER_ENABLED_SET.has(action)) allowed.push('rider');
  }
  const predicate = Object.prototype.hasOwnProperty.call(RIDER_PREDICATES, action)
    ? RIDER_PREDICATES[action]
    : null;
  return Object.freeze({
    action,
    allowed: Object.freeze(allowed),
    freshAuth: FRESH_AUTH_SET.has(action),
    machineOnly,
    riderPredicate: predicate,
  });
}

const ACTION_CONTRACTS = Object.freeze(
  CANONICAL_ACTIONS.reduce((acc, action) => {
    acc[action] = buildContract(action);
    return acc;
  }, Object.create(null))
);

// ── Public API (unwired) ─────────────────────────────────────────────────────
function isKnownPrincipal(principal) {
  return typeof principal === 'string' && PRINCIPALS.includes(principal);
}

function isCanonicalAction(action) {
  return typeof action === 'string' && CANONICAL_SET.has(action);
}

// Resolve an incoming action to its canonical name via the (currently empty)
// alias map, with cycle protection. Returns null (fail-closed) for non-strings,
// unknown actions, unresolved/cyclic aliases. Exact match only — no case or
// whitespace normalization.
function resolveCanonicalAction(action) {
  if (typeof action !== 'string') return null;
  if (CANONICAL_SET.has(action)) return action;
  const seen = new Set();
  let current = action;
  while (Object.prototype.hasOwnProperty.call(ALIAS_MAP, current)) {
    if (seen.has(current)) return null;       // cycle → fail closed
    seen.add(current);
    current = ALIAS_MAP[current];
    if (CANONICAL_SET.has(current)) return current;
  }
  return null; // unresolved alias or unknown action → fail closed
}

function getActionContract(action) {
  const canonical = resolveCanonicalAction(action);
  return canonical ? ACTION_CONTRACTS[canonical] : null;
}

// Core decision. Fail-closed for unknown principal/action/malformed input,
// human→machine-only, service→human action. No default allow.
function isAllowed(principal, action) {
  if (!isKnownPrincipal(principal)) return false;
  const canonical = resolveCanonicalAction(action);
  if (!canonical) return false;
  return ACTION_CONTRACTS[canonical].allowed.includes(principal);
}

function requiresFreshAuth(action) {
  const canonical = resolveCanonicalAction(action);
  return !!(canonical && ACTION_CONTRACTS[canonical].freshAuth);
}

function isMachineOnly(action) {
  const canonical = resolveCanonicalAction(action);
  return !!(canonical && ACTION_CONTRACTS[canonical].machineOnly);
}

// Rider resource/state predicate required for THIS principal to (eventually)
// execute THIS action. Only a rider caller on an action the rider is actually
// allowed (rider-enabled OR rider-only) carries a predicate. Returns null when
// the call is denied, when the principal is not a rider, or when no predicate
// applies. Never returns a truthy "pass" — B4 does not evaluate predicates.
// Enforcement without an evaluator must fail closed.
function getRequiredPredicate(principal, action) {
  if (!isAllowed(principal, action)) return null;
  if (principal !== 'rider') return null;
  const canonical = resolveCanonicalAction(action);
  return ACTION_CONTRACTS[canonical].riderPredicate || null;
}

// Pure set-equality check between the live router's dispatched action set and
// the canonical matrix. The caller supplies extracted router actions; this
// function performs no I/O. Returns a structured diff (fail-closed: ok only
// when both sides match exactly and there are no duplicates).
function assertContractCoversRouter(routerActions) {
  const list = Array.isArray(routerActions) ? routerActions : [];
  const seen = new Set();
  const duplicates = [];
  for (const a of list) {
    if (seen.has(a)) duplicates.push(a);
    seen.add(a);
  }
  const routerOnly = [...seen].filter((a) => !CANONICAL_SET.has(a)).sort();
  const matrixOnly = CANONICAL_ACTIONS.filter((a) => !seen.has(a)).sort();
  const ok = routerOnly.length === 0 && matrixOnly.length === 0 && duplicates.length === 0;
  return Object.freeze({
    ok,
    routerOnly: Object.freeze(routerOnly),
    matrixOnly: Object.freeze(matrixOnly),
    duplicates: Object.freeze([...new Set(duplicates)].sort()),
  });
}

module.exports = {
  // frozen data
  PRINCIPALS,
  HUMAN_PRINCIPALS,
  CANONICAL_ACTIONS,
  ALIAS_MAP,
  SERVICE_ONLY_ACTIONS,
  ADMIN_ONLY_ACTIONS,
  RIDER_ENABLED_ACTIONS,
  RIDER_ONLY_ACTIONS,
  FRESH_AUTH_ACTIONS,
  RIDER_PREDICATES,
  ACTION_CONTRACTS,
  // API
  isKnownPrincipal,
  isCanonicalAction,
  resolveCanonicalAction,
  getActionContract,
  isAllowed,
  requiresFreshAuth,
  isMachineOnly,
  getRequiredPredicate,
  assertContractCoversRouter,
};
