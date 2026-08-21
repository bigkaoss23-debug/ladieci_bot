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
  entry('ordenes', KIND.TABLE, ['GET', 'POST', 'PATCH', 'DELETE'], SENSITIVITY.PII,
    'agentOrdini.js, readActions.js, index.js (updateEstado/marcarLlegado/setUiOffset),'
    + ' servizio.js close (DELETE after archive/backup verification)'),
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
  // I-1 — GET and POST only, deliberately. The table is append-only: no call
  // site performs PATCH or DELETE, the backend service exposes neither, and
  // the database refuses both by privilege AND by trigger. Registering those
  // methods here would be the first crack in that.
  entry('cash_counts', KIND.TABLE, ['GET', 'POST'], SENSITIVITY.FINANCIAL,
    'economy/cashCountService.js — GET for the idempotency lookup and the history'
    + ' list, POST to append one physical cash count'),
  // J-1 — GET only. The table itself grants SELECT to service_role and nothing
  // else; every write goes through the RPC below, exactly as service_closeouts
  // is written only by create_service_closeout.
  entry('service_closeout_reconciliations', KIND.TABLE, ['GET'], SENSITIVITY.FINANCIAL,
    'economy/closeoutReconciliation.js getBySessionId — reads the economic context'
    + ' a close was made under; the RPC below is the sole writer'),
  entry('orden_estado_logs', KIND.TABLE, ['POST'], SENSITIVITY.AUDIT,
    'utils/orderStateLogger.js appends sanitized order lifecycle transitions'),
  entry('archivio_conv', KIND.TABLE, ['GET', 'POST'], SENSITIVITY.WHATSAPP_CONTENT,
    'servizio.js chiudiServizio archive step'),
  entry('backup_serata', KIND.TABLE, ['POST'], SENSITIVITY.FINANCIAL,
    'servizio.js backupSerata (owner-only action per legacyActionRoles.js)'),
  entry('serata_summary', KIND.TABLE, ['GET', 'POST', 'PATCH', 'DELETE'], SENSITIVITY.FINANCIAL,
    'servizio.js close/rollback lifecycle'),
  entry('service_session_state', KIND.TABLE, ['GET'], SENSITIVITY.INTERNAL_OPERATIONAL,
    'serviceSessions/orderIntakePolicy.js reads the current service pointer before every new order'),
  entry('service_sessions', KIND.TABLE, ['GET'], SENSITIVITY.INTERNAL_OPERATIONAL,
    'serviceSessions/orderIntakePolicy.js validates the active service kind/date/status before every new order'),
  // R-DAY4 — fail-closed workspace resolution for consolidateServicePeriod
  // (JS-side mirror of the SQL layer's own mesa_singleton_workspace_v1()
  // check; index.js refuses with WORKSPACE_AMBIGUOUS unless exactly 1 row).
  entry('workspaces', KIND.TABLE, ['GET'], SENSITIVITY.INTERNAL_OPERATIONAL,
    'index.js consolidateServicePeriod action'),
  // SERVICE CLOSEOUT V2 / SLICE 4A — only readActions.js's getServiceIncidents
  // hits these two literally as "safeSelect(...)" (the scanner this registry
  // feeds only sees the literal sbSelect/safeSelect/sbRpc call-site pattern —
  // src/closeout/closeoutSnapshots.js, closeoutAttempts.js, incidents/
  // serviceIncidents.js and previousCloseoutIncidentSummary.js all reach the
  // same tables through an injected `select`/`rpc` parameter, invisible to
  // that literal-string scan, exactly like every other DI-based module here).
  entry('service_incidents', KIND.TABLE, ['GET'], SENSITIVITY.AUDIT,
    'readActions.js getServiceIncidents (Admin "Incidencias" backlog, admin-only, read-only)'),
  // SLICE 3.2.1 — closeoutAttempts.js's getByCorrelationId() (plain SELECT,
  // same DI-invisible pattern as the snapshot/closeout readers below) is now
  // also called by serviceLifecycleEngine.js's retry-lineage check. GET was
  // already granted for readActions.js; no method change needed.
  entry('service_closeout_attempts', KIND.TABLE, ['GET'], SENSITIVITY.INTERNAL_OPERATIONAL,
    'readActions.js getServiceIncidents attempt-status enrichment (read-only); '
    + 'closeoutAttempts.js getByCorrelationId(), called by serviceLifecycleEngine.js\'s retry-lineage check (SLICE 3.2.1)'),
  // SLICE 4C.2A — closeoutSnapshots.js's getByCorrelationId()/listBySession()
  // (both plain SELECTs) are exercised by performIncidentSafeRollover on
  // EVERY invocation, including the very first — it checks "does this attempt
  // already own a snapshot" before deciding whether to capture one. GET only:
  // this module never mutates the table directly, only via the RPC below.
  entry('service_closeout_snapshots', KIND.TABLE, ['GET'], SENSITIVITY.AUDIT,
    'closeoutSnapshots.js getByCorrelationId/listBySession, read-only, called from incidentSafeRollover.js'),
  entry('ladieci_schema_migrations', KIND.TABLE, ['GET'], SENSITIVITY.AUDIT,
    'migrationAuthority.js getMigrationStatus (S4 /status migration-authority block), read-only'),

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
    'tableSessionAssignmentDaoV3.js and tables/mesaDao.js read active table sessions'),
  entry('restaurant_tables', KIND.TABLE, ['GET'], SENSITIVITY.INTERNAL_OPERATIONAL,
    'tables/mesaDao.js reads the persisted floor; writes are RPC-only'),
  entry('table_order_lines', KIND.TABLE, ['GET'], SENSITIVITY.FINANCIAL,
    'tables/mesaDao.js reads immutable per-unit bill charges; writes are trigger-only'),
  entry('payment_transactions', KIND.TABLE, ['GET'], SENSITIVITY.FINANCIAL,
    'tables/mesaDao.js reads posted Mesa money movements; writes are RPC-only'),
  entry('payment_allocations', KIND.TABLE, ['GET'], SENSITIVITY.FINANCIAL,
    'tables/mesaDao.js reads transaction-to-charge allocations; writes are RPC-only'),
  entry('table_reservations', KIND.TABLE, ['GET'], SENSITIVITY.PII,
    'tables/mesaDao.js reads active Mesa reservations; writes are RPC-only'),

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
  // F-9 — the canonical opener (F-6), now given its first real caller:
  // serviceSessionLifecycle.js's openOperational(), reachable only from
  // explicitReopenServiceSession.js's own single 'explicit_reopen' call site.
  entry('rpc/open_operational_service_v1', KIND.RPC, ['POST'], SENSITIVITY.INTERNAL_OPERATIONAL, 'serviceSessions/serviceSessionLifecycle.js'),
  // R-DAY3 — read-only intake-schedule preflight mirror.
  entry('rpc/get_order_intake_context_v1', KIND.RPC, ['POST'], SENSITIVITY.INTERNAL_OPERATIONAL, 'serviceSessions/orderIntakePolicy.js'),
  // The canonical order-intake resolver. R-DAY3's comment here used to assert
  // it was "called ONLY from inside the service_session_assign_order() DB
  // trigger, never via sbRpc from this backend, so it deliberately has no
  // registry entry" -- that stopped being true when the Mesa first-seating
  // stale-service guard (ledger 95) gave it a JS caller,
  // serviceSessionLifecycle.js's resolveOperationalContext(). Nothing caught
  // it, because that caller only ran on the forgotten-close recovery-retry
  // path, which never executed in production. G-1 (ledger 96) made the same
  // call the normal route for the first seating after a Finalizar, and it
  // failed instantly and correctly: the transport refuses an unregistered
  // resource BEFORE the network, so the request never happened and Mesa
  // surfaced MESA_INTERNAL_ERROR. Registered here, POST-only, same
  // sensitivity class as open_operational_service_v1 which it calls.
  // tests/serviceSessionLifecycleResourceRegistration.test.js is the gate
  // that now keeps this registry and that wrapper in step.
  entry('rpc/resolve_order_intake_context_v1', KIND.RPC, ['POST'], SENSITIVITY.INTERNAL_OPERATIONAL,
    'serviceSessions/serviceSessionLifecycle.js resolveOperationalContext() — Mesa first-seating recovery (ledger 95) and G-1 first-activity resume (ledger 96)'),

  // R-DAY4 — explicit, immutable Service Period consolidation checkpoint.
  // Structurally independent of order-intake authority (period ASSIGNMENT
  // stays resolveEconomicPeriod()'s alone) -- same SENSITIVITY class as
  // capture_closeout_snapshot below, which it calls internally.
  entry('rpc/consolidate_period_v1', KIND.RPC, ['POST'], SENSITIVITY.AUDIT, 'serviceSessions/periodConsolidation.js'),

  // ── SERVICE CLOSEOUT V2 lifecycle RPCs — SLICE 4C.2A, extended 4C.2C.
  // Minimal set actually exercised by performIncidentSafeRollover
  // (src/serviceSessions/incidentSafeRollover.js) via closeoutAttempts.js/
  // closeoutSnapshots.js/serviceIncidents.js's `rpc` DI parameter (sbRpc
  // default — invisible to a literal-string scan, exactly like
  // service_incidents/service_closeout_attempts above).
  //
  // SLICE 4C.2C added rpc/resolve_service_incident: a real staging run proved
  // create_service_incident recording an auto-release incident as
  // "resolved" BEFORE the release RPC call even ran was a genuine
  // data-integrity bug (see incidentSafeRollover.js's safe-auto-actions
  // loop). The fix moved resolution to AFTER confirmed success, via
  // serviceIncidents.js's resolve() — the SAME RPC an eventual admin HTTP
  // resolution action would use, but today called ONLY by this internal
  // orchestrator, with a hardcoded role:'admin' literal (never a caller
  // field — see serviceIncidents.js's own trust-boundary header) and no
  // HTTP route anywhere (tests/serviceCloseoutIncidentsFoundation.static.
  // test.js §10d3-10d5 assert index.js is not, and never becomes, part of
  // the allowed-caller set for this pattern).
  //
  // The post-close financial-resolution RPC from the same two migrations
  // (see archivedOrderFinancialResolutions.js's own wrapper) remains
  // deliberately excluded — never named literally here on purpose:
  // tests/archivedOrderFinancialResolutionsFoundation.static.test.js §9d
  // asserts that RPC's name appears NOWHERE in the codebase yet (proving
  // post-close financial resolution still has no caller at all); spelling it
  // out even in a comment here would be a false positive against that exact
  // invariant. Its wrapper exists but is called by nothing — see its own
  // header ("NOT wired into ... any HTTP action"). Least privilege: register
  // it when a real caller exists, not before.
  entry('rpc/acquire_closeout_attempt', KIND.RPC, ['POST'], SENSITIVITY.INTERNAL_OPERATIONAL,
    'closeoutAttempts.js acquire(), called by incidentSafeRollover.js'),
  entry('rpc/capture_closeout_snapshot', KIND.RPC, ['POST'], SENSITIVITY.AUDIT,
    'closeoutSnapshots.js capture(), called by incidentSafeRollover.js'),
  entry('rpc/create_service_incident', KIND.RPC, ['POST'], SENSITIVITY.AUDIT,
    'serviceIncidents.js report(), called by incidentSafeRollover.js'),
  entry('rpc/supersede_closeout_attempt', KIND.RPC, ['POST'], SENSITIVITY.INTERNAL_OPERATIONAL,
    'closeoutAttempts.js supersede(), called by incidentSafeRollover.js on a state-drift retry'),
  entry('rpc/complete_closeout_attempt', KIND.RPC, ['POST'], SENSITIVITY.INTERNAL_OPERATIONAL,
    'closeoutAttempts.js complete(), called by incidentSafeRollover.js after a successful close'),
  entry('rpc/resolve_service_incident', KIND.RPC, ['POST'], SENSITIVITY.AUDIT,
    'serviceIncidents.js resolve(), called by incidentSafeRollover.js ONLY after a safe auto-action (empty-table release) confirms success — never before, never from any HTTP action'),
  // SLICE 4C.2C — trusted-system counterpart to rpc/mesa_release_empty_session_v1
  // (below, unchanged, still the real human/Mesa-UI path). No p_by_actor: the
  // automatic orchestrator has no human actor and must not impersonate one —
  // see migrations/2026-08-09_service_closeout_cross_service_table_policy.sql.
  entry('rpc/mesa_release_empty_session_auto_v1', KIND.RPC, ['POST'], SENSITIVITY.INTERNAL_OPERATIONAL,
    'mesaDao.js releaseEmptySessionAuto(), called by incidentSafeRollover.js'),

  // ── SERVICE LIFECYCLE V3 / SLICE 3.2 — the NEW close engine. Deliberately
  // its own block, not merged into the SERVICE CLOSEOUT V2 block above: this
  // is a separate engine (src/serviceSessions/serviceLifecycleEngine.js),
  // reusing the V2 attempt/snapshot foundation above but never calling
  // language-guard: allow-legacy chiudiServizio/begin_service_session_close are named here only to state what this new engine does NOT call, not new vocabulary
  // chiudiServizio/begin_service_session_close. Invisible to the literal-
  // string scanner (check #17) — reached only via closeoutCreation.js /
  // serviceLifecycleV3Transition.js's `rpc` DI default (sbRpc), same as every
  // other closeout-lifecycle RPC above.
  entry('rpc/create_service_closeout', KIND.RPC, ['POST'], SENSITIVITY.AUDIT,
    'serviceCloseoutCreation.js create(), called by serviceLifecycleEngine.js — the only writer of service_closeouts'),
  entry('rpc/close_service_session_v3', KIND.RPC, ['POST'], SENSITIVITY.INTERNAL_OPERATIONAL,
    'serviceLifecycleV3Transition.js close(), called by serviceLifecycleEngine.js — the V3-native terminal transition'),
  // J-1 — the ONLY writer of service_closeout_reconciliations. Called by the
  // V3 close engine between Phase D (closeout persisted) and Phase E (terminal
  // transition), so a failure leaves the service open rather than closed
  // without the context this slice promised it would carry.
  entry('rpc/create_service_closeout_reconciliation_v1', KIND.RPC, ['POST'], SENSITIVITY.FINANCIAL,
    'serviceLifecycleEngine.js Phase D.2 via economy/closeoutReconciliation.js persist()'),
  // F-5 — SLICE 3.4's next-service-opening primitive. serviceLifecycleEngine.js
  // no longer calls this (the auto-successor step was retired, not adapted
  // to operational_service_v1 — see the F-5 report). serviceLifecycleV3
  // Transition.js's ensureNext() wrapper still exists and still names this
  // RPC literally, so the entry stays registered rather than orphaned;
  // classified LEGACY_PRIMITIVE_PENDING_DB_RETIREMENT in the F-5 retirement
  // inventory, not physically dropped here.
  entry('rpc/ensure_next_service_session_v3', KIND.RPC, ['POST'], SENSITIVITY.INTERNAL_OPERATIONAL,
    'serviceLifecycleV3Transition.js ensureNext() — no remaining caller after F-5; kept registered pending the mandatory legacy-retirement slice'),

  // ── P0-C2 — the non-destructive intraday economic-boundary primitive.
  // Deliberately its own entry, not merged into the V3 block above: reuses
  // the V3 closeout-attempt/snapshot/creation foundation but never calls
  // close_service_session_v3 (see the migration's own header for why —
  // guard_service_session_closed_v1's SERVICE_ACTIVE_ORDERS_NOT_RESOLVED
  // check would hard-block an ordinary intraday close with real non-terminal
  // orders). Reached only via economicBoundaryEngine.js's `rpc` DI default
  // (sbRpc), same pattern as every other closeout-lifecycle RPC above.
  entry('rpc/roll_service_session_economic_v1', KIND.RPC, ['POST'], SENSITIVITY.INTERNAL_OPERATIONAL,
    // language-guard: allow-legacy PRANZO is the existing service_kind enum value, named here only to describe this RPC's purpose, not new vocabulary
    'economicBoundaryEngine.js rollEconomicPeriod() — atomically settles A (status->rolled_over, never touches ordenes/table_sessions) and opens B, the non-destructive intraday PRANZO->SERA transition'),
  // SLICE 3.2.1 — serviceCloseouts.js's getBySessionId() (plain SELECT, same
  // DI-invisible pattern as service_closeout_snapshots/service_closeout_
  // attempts above) existed since V3.1 as a read-only DAO for reports/tests
  // but had no real runtime caller until now: serviceLifecycleEngine.js's
  // retry-lineage check reads it on every close attempt, BEFORE deciding
  // whether to acquire a new closeout attempt, to prove V3 ownership without
  // ever inferring it from order count. GET only — service_closeouts has no
  // UPDATE/DELETE path at all (append-only, enforced by create_service_
  // closeout being its sole writer).
  entry('service_closeouts', KIND.TABLE, ['GET'], SENSITIVITY.FINANCIAL,
    'serviceCloseouts.js getBySessionId(), called by serviceLifecycleEngine.js\'s retry-lineage check (SLICE 3.2.1)'),

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
  entry('rpc/mesa_open_session_v1', KIND.RPC, ['POST'], SENSITIVITY.INTERNAL_OPERATIONAL, 'tables/mesaDao.js'),
  entry('rpc/mesa_release_empty_session_v1', KIND.RPC, ['POST'], SENSITIVITY.INTERNAL_OPERATIONAL, 'tables/mesaDao.js'),
  entry('rpc/mesa_close_session_v1', KIND.RPC, ['POST'], SENSITIVITY.INTERNAL_OPERATIONAL, 'tables/mesaDao.js'),
  entry('rpc/mesa_save_table_v1', KIND.RPC, ['POST'], SENSITIVITY.INTERNAL_OPERATIONAL, 'tables/mesaDao.js'),
  entry('rpc/mesa_post_payment_v1', KIND.RPC, ['POST'], SENSITIVITY.FINANCIAL, 'tables/mesaDao.js'),
  entry('rpc/mesa_save_reservation_v1', KIND.RPC, ['POST'], SENSITIVITY.PII, 'tables/mesaDao.js'),
  entry('rpc/mesa_set_reservation_status_v1', KIND.RPC, ['POST'], SENSITIVITY.PII, 'tables/mesaDao.js'),
  entry('rpc/mesa_open_reservation_v1', KIND.RPC, ['POST'], SENSITIVITY.INTERNAL_OPERATIONAL, 'tables/mesaDao.js'),
  // MESA_SEND_TO_KITCHEN_P0_FIX (2026-08-14) -- missed at implementation time,
  // caught by live UI UAT: mesaDao.setCovers() called rpc('mesa_set_session_
  // covers_v1', ...) but this registry gate sits below the DAO, so every real
  // request was rejected with SUPABASE_RESOURCE_NOT_ALLOWED before reaching
  // Supabase at all (surfaced to the operator as MESA_DATA_WRITE_FAILED).
  entry('rpc/mesa_set_session_covers_v1', KIND.RPC, ['POST'], SENSITIVITY.INTERNAL_OPERATIONAL, 'tables/mesaDao.js'),

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
