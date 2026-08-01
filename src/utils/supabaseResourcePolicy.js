'use strict';
// H1B — Security Foundation Block: server-side registry of the Supabase/PostgREST
// resources this backend is allowed to touch.
//
// This is DATA only — no env, no I/O, no authorization decision about WHO can call
// an action (that stays exactly where it is today: legacyAuthGuard.js /
// legacyActionRoles.js). It only says WHAT this backend's own code is structurally
// allowed to ask Supabase for — resource name, HTTP method, timeout ceiling.
//
// PROVENANCE. Every entry below was derived by grepping the actual call sites in
// this repository (sbSelect/sbUpsert/sbUpdate/sbDelete/sbInsert/sbRpc in
// src/utils/supabase.js consumers, sbRest in src/auth/audit.js consumers,
// safeSelect in src/utils/readActions.js, readMenuTables in
// src/menu/menuRepository.js) as of the H1B audit — not invented, not copied from
// a prior design doc. `allowedMethods` lists exactly the methods a real call site
// uses today; adding a new method to a resource here without a demonstrated call
// site is itself a change this registry is meant to catch.
//
// Explicitly OUT of this registry: src/account/supabaseAccountAuthority.js's
// GET {SUPABASE_URL}/auth/v1/user — that is Supabase Auth (GoTrue), not PostgREST
// /rest/v1/, has its own dedicated transport/timeout, and stays separate by design.

const SENSITIVITY = Object.freeze({
  PUBLIC_OPERATIONAL: 'PUBLIC_OPERATIONAL',
  INTERNAL_OPERATIONAL: 'INTERNAL_OPERATIONAL',
  PII: 'PII',
  WHATSAPP_CONTENT: 'WHATSAPP_CONTENT',
  FINANCIAL: 'FINANCIAL',
  AUTH_SECURITY: 'AUTH_SECURITY',
  AUDIT: 'AUDIT',
  CONFIG: 'CONFIG',
  CACHE: 'CACHE',
});

const KIND = Object.freeze({ TABLE: 'table', RPC: 'rpc' });

const REGISTRY_DEFAULT_TIMEOUT_MS = 8000;
const REGISTRY_MAX_TIMEOUT_MS = 20000;

function entry(resource, kind, allowedMethods, sensitivity, provenance, overrides = {}) {
  return Object.freeze({
    resource,
    kind,
    allowedMethods: Object.freeze(allowedMethods.slice()),
    sensitivity,
    defaultTimeoutMs: overrides.defaultTimeoutMs || REGISTRY_DEFAULT_TIMEOUT_MS,
    maxTimeoutMs: overrides.maxTimeoutMs || REGISTRY_MAX_TIMEOUT_MS,
    allowEmptyResponse: overrides.allowEmptyResponse !== undefined ? overrides.allowEmptyResponse : true,
    // Not consumed by the transport — kept for auditability (Passo 11, item 18:
    // "nessuna risorsa registry inutilizzata senza commento").
    provenance,
  });
}

const REGISTRY = Object.freeze([
  // ── operational tables — src/utils/supabase.js consumers (agentOrdini.js,
  // servizio.js, manualGiros.js, agenteMiglioramento.js, readActions.js, ecc.) ──
  entry('ordenes', KIND.TABLE, ['GET', 'POST', 'PATCH'], SENSITIVITY.PII,
    'agentOrdini.js, servizio.js, readActions.js, index.js (updateEstado/marcarLlegado/setUiOffset)'),
  entry('conv', KIND.TABLE, ['GET', 'POST', 'PATCH', 'DELETE'], SENSITIVITY.WHATSAPP_CONTENT,
    'App flow (orchestrator.js), servizio.js close (DELETE), readActions.js'),
  entry('wa_msgs', KIND.TABLE, ['GET', 'POST', 'PATCH', 'DELETE'], SENSITIVITY.WHATSAPP_CONTENT,
    'orchestrator.js, servizio.js close (DELETE), readActions.js'),
  entry('clientes', KIND.TABLE, ['GET', 'POST', 'PATCH'], SENSITIVITY.PII,
    'agentOrdini.js upsertCliente, readActions.js getClienteByTelefono'),
  entry('storico', KIND.TABLE, ['GET', 'POST', 'DELETE'], SENSITIVITY.FINANCIAL,
    'servizio.js chiudiServizio (POST/DELETE rollback), readActions.js getStorico'),
  entry('config', KIND.TABLE, ['GET', 'POST'], SENSITIVITY.CONFIG,
    'src/utils/supabase.js getConfig, index.js setConfig'),
  entry('geo_cache', KIND.TABLE, ['GET', 'POST', 'PATCH'], SENSITIVITY.CACHE,
    'geoResolver.js, agentOrdini.js'),
  entry('manual_giros', KIND.TABLE, ['GET', 'POST', 'PATCH', 'DELETE'], SENSITIVITY.INTERNAL_OPERATIONAL,
    'manualGiros.js full CRUD'),
  entry('delivery_logs', KIND.TABLE, ['GET'], SENSITIVITY.INTERNAL_OPERATIONAL,
    'readActions.js getDeliveryLogs (write path is driverTelemetry.js via sbInsert — table name'
    + ' literal there too; GET is the only method exercised through the shared read contract today)'),
  entry('suggerimenti', KIND.TABLE, ['GET', 'POST', 'PATCH', 'DELETE'], SENSITIVITY.INTERNAL_OPERATIONAL,
    'agenteMiglioramento.js rigeneraSuggerimenti/approvaSuggerimento, readActions.js'),
  entry('order_financial_events', KIND.TABLE, ['GET'], SENSITIVITY.FINANCIAL,
    'closeout/economiaLedgerAggregate.js (writes to this table happen exclusively via'
    + ' the financial RPCs below, never a direct sbInsert/sbUpsert)'),
  entry('archivio_conv', KIND.TABLE, ['GET', 'POST'], SENSITIVITY.WHATSAPP_CONTENT,
    'servizio.js chiudiServizio archive step'),
  entry('backup_serata', KIND.TABLE, ['POST'], SENSITIVITY.FINANCIAL,
    'servizio.js backupSerata (owner-only action per legacyActionRoles.js)'),
  entry('serata_summary', KIND.TABLE, ['GET', 'POST', 'PATCH', 'DELETE'], SENSITIVITY.FINANCIAL,
    'servizio.js close/rollback lifecycle'),

  // ── menu catalogue — src/menu/menuRepository.js, read-only ──
  entry('menu_categorias', KIND.TABLE, ['GET'], SENSITIVITY.PUBLIC_OPERATIONAL, 'menuRepository.js readMenuTables'),
  entry('menu_productos', KIND.TABLE, ['GET'], SENSITIVITY.PUBLIC_OPERATIONAL, 'menuRepository.js readMenuTables'),
  entry('menu_extras', KIND.TABLE, ['GET'], SENSITIVITY.PUBLIC_OPERATIONAL, 'menuRepository.js readMenuTables'),
  entry('menu_producto_extras', KIND.TABLE, ['GET'], SENSITIVITY.PUBLIC_OPERATIONAL, 'menuRepository.js readMenuTables'),
  entry('menu_aliases', KIND.TABLE, ['GET'], SENSITIVITY.PUBLIC_OPERATIONAL, 'menuRepository.js readMenuTables'),

  // ── auth domain tables — src/auth/audit.js sbRest consumers ──
  entry('auth_actors', KIND.TABLE, ['GET'], SENSITIVITY.AUTH_SECURITY,
    'dao.js, adminAccessDao.js, pinRotationDao.js (all read-only direct table access;'
    + ' writes are exclusively via the auth_* RPCs below)'),
  entry('auth_audit', KIND.TABLE, ['GET', 'POST'], SENSITIVITY.AUDIT,
    'audit.js writeAuthAudit (POST, append-only) / listAuthAudit (GET)'),
  entry('access_management_idempotency', KIND.TABLE, ['GET', 'POST'], SENSITIVITY.AUTH_SECURITY,
    'accessManagementHttpDaoV3.js replays and records owner access-management operations'),
  entry('table_sessions', KIND.TABLE, ['GET'], SENSITIVITY.INTERNAL_OPERATIONAL,
    'tableSessionAssignmentDaoV3.js and tables/messaDao.js read active table sessions'),
  entry('restaurant_tables', KIND.TABLE, ['GET'], SENSITIVITY.INTERNAL_OPERATIONAL,
    'tables/messaDao.js reads the persisted floor; writes are RPC-only'),
  entry('table_order_lines', KIND.TABLE, ['GET'], SENSITIVITY.FINANCIAL,
    'tables/messaDao.js reads immutable per-unit bill charges; writes are trigger-only'),
  entry('payment_transactions', KIND.TABLE, ['GET'], SENSITIVITY.FINANCIAL,
    'tables/messaDao.js reads posted Mesa money movements; writes are RPC-only'),
  entry('payment_allocations', KIND.TABLE, ['GET'], SENSITIVITY.FINANCIAL,
    'tables/messaDao.js reads transaction-to-charge allocations; writes are RPC-only'),
  entry('table_reservations', KIND.TABLE, ['GET'], SENSITIVITY.PII,
    'tables/messaDao.js reads active Mesa reservations; writes are RPC-only'),

  // ── account domain tables — src/account/accountHttpIntegration.js ──
  entry('user_profiles', KIND.TABLE, ['GET'], SENSITIVITY.PII, 'accountHttpIntegration.js selectProfile'),
  entry('workspace_memberships', KIND.TABLE, ['GET'], SENSITIVITY.AUTH_SECURITY,
    'accountHttpIntegration.js selectMemberships'),

  // ── operational RPCs — src/utils/supabase.js sbRpc consumers (riderTrip.js,
  // manualGiros.js, serviceSessions/*.js) ──
  entry('rpc/start_rider_trip', KIND.RPC, ['POST'], SENSITIVITY.INTERNAL_OPERATIONAL, 'riderTrip.js'),
  entry('rpc/rider_collect_and_complete_stop', KIND.RPC, ['POST'], SENSITIVITY.FINANCIAL, 'riderTrip.js'),
  entry('rpc/close_rider_trip', KIND.RPC, ['POST'], SENSITIVITY.INTERNAL_OPERATIONAL, 'riderTrip.js'),
  entry('rpc/delete_order_if_not_active', KIND.RPC, ['POST'], SENSITIVITY.INTERNAL_OPERATIONAL, 'riderTrip.js deleteOrder'),
  entry('rpc/delete_conversation_if_not_active', KIND.RPC, ['POST'], SENSITIVITY.WHATSAPP_CONTENT, 'riderTrip.js deleteConversation'),
  entry('rpc/begin_service_close_if_idle', KIND.RPC, ['POST'], SENSITIVITY.INTERNAL_OPERATIONAL, 'riderTrip.js'),
  entry('rpc/end_service_close', KIND.RPC, ['POST'], SENSITIVITY.INTERNAL_OPERATIONAL, 'riderTrip.js'),
  entry('rpc/ensure_service_session', KIND.RPC, ['POST'], SENSITIVITY.INTERNAL_OPERATIONAL, 'serviceSessions/serviceSessionLifecycle.js'),
  entry('rpc/open_service_session', KIND.RPC, ['POST'], SENSITIVITY.INTERNAL_OPERATIONAL, 'serviceSessions/serviceSessionLifecycle.js'),
  entry('rpc/begin_service_session_close', KIND.RPC, ['POST'], SENSITIVITY.INTERNAL_OPERATIONAL, 'serviceSessions/serviceSessionLifecycle.js'),
  entry('rpc/complete_service_session_close', KIND.RPC, ['POST'], SENSITIVITY.INTERNAL_OPERATIONAL, 'serviceSessions/serviceSessionLifecycle.js'),
  entry('rpc/get_current_service_closeout_session', KIND.RPC, ['POST'], SENSITIVITY.FINANCIAL, 'serviceSessions/serviceSessionLifecycle.js'),

  // ── auth RPCs — src/auth/audit.js sbRest consumers ──
  entry('rpc/auth_bump_session_version', KIND.RPC, ['POST'], SENSITIVITY.AUTH_SECURITY, 'dao.js incrementSessionVersion'),
  entry('rpc/auth_record_failed_attempt', KIND.RPC, ['POST'], SENSITIVITY.AUTH_SECURITY, 'dao.js recordFailedAttempt'),
  entry('rpc/auth_reset_failed_attempts', KIND.RPC, ['POST'], SENSITIVITY.AUTH_SECURITY, 'dao.js resetFailedAttempts'),
  entry('rpc/auth_admin_revoke_actor_sessions', KIND.RPC, ['POST'], SENSITIVITY.AUTH_SECURITY, 'adminAccessDao.js'),
  entry('rpc/auth_admin_unlock_actor', KIND.RPC, ['POST'], SENSITIVITY.AUTH_SECURITY, 'adminAccessDao.js'),
  entry('rpc/auth_register_recovery_window', KIND.RPC, ['POST'], SENSITIVITY.AUTH_SECURITY, 'recoveryDao.js'),
  entry('rpc/auth_set_actor_pin_v2', KIND.RPC, ['POST'], SENSITIVITY.AUTH_SECURITY, 'pinRotationDao.js'),
  entry('rpc/auth_set_actor_pin_v3', KIND.RPC, ['POST'], SENSITIVITY.AUTH_SECURITY, 'pinRotationDaoV3.js'),
  entry('rpc/auth_change_actor_role_v3', KIND.RPC, ['POST'], SENSITIVITY.AUTH_SECURITY, 'roleChangeDaoV3.js'),
  entry('rpc/auth_create_access_user_v3', KIND.RPC, ['POST'], SENSITIVITY.AUTH_SECURITY, 'accessUserDaoV3.js'),
  entry('rpc/auth_rename_access_user_v3', KIND.RPC, ['POST'], SENSITIVITY.AUTH_SECURITY, 'accessUserDaoV3.js'),
  entry('rpc/auth_set_access_user_active_v3', KIND.RPC, ['POST'], SENSITIVITY.AUTH_SECURITY,
    'accessUserLifecycleDaoV3.js'),
  entry('rpc/auth_clear_access_user_credential_v3', KIND.RPC, ['POST'], SENSITIVITY.AUTH_SECURITY,
    'accessUserLifecycleDaoV3.js'),
  entry('rpc/auth_assign_table_session_waiter_v3', KIND.RPC, ['POST'], SENSITIVITY.AUTH_SECURITY,
    'tableSessionAssignmentDaoV3.js'),

  // ── Mesa floor, table session and billing RPCs ──
  entry('rpc/messa_open_session_v1', KIND.RPC, ['POST'], SENSITIVITY.INTERNAL_OPERATIONAL, 'tables/messaDao.js'),
  entry('rpc/messa_release_table_v1', KIND.RPC, ['POST'], SENSITIVITY.INTERNAL_OPERATIONAL, 'tables/messaDao.js'),
  entry('rpc/messa_save_table_v1', KIND.RPC, ['POST'], SENSITIVITY.INTERNAL_OPERATIONAL, 'tables/messaDao.js'),
  entry('rpc/messa_post_payment_v1', KIND.RPC, ['POST'], SENSITIVITY.FINANCIAL, 'tables/messaDao.js'),
  entry('rpc/messa_save_reservation_v1', KIND.RPC, ['POST'], SENSITIVITY.PII, 'tables/messaDao.js'),
  entry('rpc/messa_set_reservation_status_v1', KIND.RPC, ['POST'], SENSITIVITY.PII, 'tables/messaDao.js'),
  entry('rpc/messa_open_reservation_v1', KIND.RPC, ['POST'], SENSITIVITY.INTERNAL_OPERATIONAL, 'tables/messaDao.js'),

  // ── account RPC ──
  entry('rpc/auth_account_claim_workspace', KIND.RPC, ['POST'], SENSITIVITY.AUTH_SECURITY, 'workspaceOwnerDao.js claimWorkspace'),

  // ── financial RPCs — src/auth/financialDao.js ──
  entry('rpc/order_mark_paid', KIND.RPC, ['POST'], SENSITIVITY.FINANCIAL, 'financialDao.js'),
  entry('rpc/order_import_legacy_payment', KIND.RPC, ['POST'], SENSITIVITY.FINANCIAL, 'financialDao.js'),
  entry('rpc/order_refund', KIND.RPC, ['POST'], SENSITIVITY.FINANCIAL, 'financialDao.js'),
  entry('rpc/order_void', KIND.RPC, ['POST'], SENSITIVITY.FINANCIAL, 'financialDao.js'),
]);

const BY_RESOURCE = new Map(REGISTRY.map((e) => [e.resource, e]));

function getResourcePolicy(resource) {
  if (typeof resource !== 'string') return null;
  return BY_RESOURCE.get(resource) || null;
}

function isMethodAllowed(resource, method) {
  const e = getResourcePolicy(resource);
  if (!e || typeof method !== 'string') return false;
  return e.allowedMethods.includes(method.toUpperCase());
}

function isTimeoutAllowed(resource, timeoutMs) {
  const e = getResourcePolicy(resource);
  if (!e) return false;
  const n = Number(timeoutMs);
  return Number.isFinite(n) && n > 0 && n <= e.maxTimeoutMs;
}

module.exports = {
  SENSITIVITY,
  KIND,
  REGISTRY,
  getResourcePolicy,
  isMethodAllowed,
  isTimeoutAllowed,
};
