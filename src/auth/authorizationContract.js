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
  'getDeliveryLogs', 'getSuggerimenti', 'getConversacionesActivas', 'getClienteByTelefono',
  'getWaMessageById', 'getOrdenById', 'getConvByWaId', 'getConvChats', 'cambiaStato',
  'creaOrdine', 'modificaOrdine', 'aggiornaRispostaBot', 'setConfig', 'rispondiWA',
  'updateWaStato', 'updateOrden', 'updateEstado', 'marcarEnEntrega', 'marcarEntregado',
  'asignarRepartidor', 'registrarSalidaDriver', 'chiudiGiro', 'marcarLlegado', 'setUiOffset',
  'resolveAddress', 'previewOrderTiming', 'createOrden', 'updateNotaCucina', 'eliminaOrdine',
  'eliminaConversazione', 'upsertCliente', 'parseOrdineDaRisposta', 'createManualGiro',
  'addOrderToManualGiro', 'removeOrderFromManualGiro', 'dissolveManualGiro',
  'getAuthActors', 'setActorPin', 'verifyOwnPin', 'openServiceSession', 'ensureCurrentServiceSession',
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
  'getDeliveryLogs', 'getSuggerimenti',
  'setConfig', 'eliminaOrdine', 'eliminaConversazione',
  'getAuthActors', 'setActorPin', 'verifyOwnPin',
]);
const ADMIN_ONLY_SET = Object.freeze(new Set(ADMIN_ONLY_ACTIONS));

// rider-enabled (7): admin+operator+rider; service denied. Rider invocation
// additionally requires a B7 resource/state predicate (see RIDER_PREDICATES).
const RIDER_ENABLED_ACTIONS = Object.freeze([
  'getDriverStatus', 'updateEstado', 'marcarEnEntrega', 'marcarEntregado',
  'registrarSalidaDriver', 'chiudiGiro', 'marcarLlegado',
]);
const RIDER_ENABLED_SET = Object.freeze(new Set(RIDER_ENABLED_ACTIONS));

// fresh-auth: EXPLICIT metadata — never inferred from admin-only status,
// action name, mutation/read class, or substrings.
const FRESH_AUTH_ACTIONS = Object.freeze([
  'getConfig', 'rigeneraSuggerimenti', 'approvaSuggerimento', 'getClientes', 'getStorico',
  'getOrdenesArchivio', 'getEconomiaLedger', 'getDeliveryLogs', 'setConfig', 'eliminaOrdine',
  'eliminaConversazione', 'getSuggerimenti',
  'getAuthActors', 'setActorPin', 'verifyOwnPin', 'getCurrentServiceCloseout', 'openServiceSession',
  // S2-7D6B — the automatic ensure runs on every Servicio entry, so it must NOT be
  // fresh-auth: it is the silent path, not a privileged one-off.
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
  const allowed = [];
  if (machineOnly) {
    allowed.push('service'); // service-only: humans explicitly excluded
  } else {
    allowed.push('admin'); // admin: every non-service-only action
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
// execute THIS action. Only a rider caller on a rider-enabled action carries a
// predicate. Returns null when the call is denied, when the principal is not a
// rider, or when no predicate applies. Never returns a truthy "pass" — B4 does
// not evaluate predicates. Enforcement without an evaluator must fail closed.
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
