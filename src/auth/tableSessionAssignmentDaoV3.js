'use strict';
// Access Control V3 -- Block V3-G: table-session waiter-assignment DAO (ISOLATED,
// UNWIRED). service_role only.
//
// Calls auth_assign_table_session_waiter_v3
// (2026-07-31_v3g_waiter_table_assignment_safety.sql, draft, NOT applied to staging).
// Also provides workspace-scoped SAFE reads (no customer/order payload -- none exists on
// this table -- and no cross-workspace listing) for administrative projection. Nothing
// in index.js, login.js, adminAccessService.js, or any current route requires this file.

const { AuthDaoError, sbRest } = require('./audit');

const SAFE_RESULT_FIELDS = Object.freeze(['table_session_id', 'assigned_waiter_actor', 'status', 'updated_at', 'updated_by']);
const SAFE_LIST_COLS = 'id,table_ref,status,assigned_waiter_actor,opened_at,closed_at,created_at,updated_at';

function sanitizeAssignResult(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new AuthDaoError('TABLE_SESSION_ASSIGN_FAILED', 'malformed response');
  }
  if (typeof body.table_session_id !== 'string' || body.table_session_id.length === 0) {
    throw new AuthDaoError('TABLE_SESSION_ASSIGN_FAILED', 'malformed response');
  }
  const out = {};
  for (const k of SAFE_RESULT_FIELDS) if (k in body) out[k] = body[k];
  return Object.freeze(out);
}

// Same marker-based error mapping as every other V3 DAO: surface ONLY the known,
// non-sensitive markers distinctly; everything else collapses into the single generic
// failure shape. No SQL text or PostgREST body ever escapes.
function mapAssignError(r) {
  const marker = r.body && typeof r.body.message === 'string' ? r.body.message : '';
  if (marker.includes('AUTH_IDEMPOTENCY_CONFLICT')) throw new AuthDaoError('TABLE_SESSION_ASSIGN_CONFLICT', 'idempotency conflict');
  if (marker.includes('TABLE_SESSION_ASSIGNMENT_STALE')) throw new AuthDaoError('TABLE_SESSION_ASSIGN_STALE', 'stale assignment snapshot');
  if (marker.includes('TABLE_SESSION_NOT_OPEN')) throw new AuthDaoError('TABLE_SESSION_NOT_OPEN', 'session not open');
  if (marker.includes('AUTH_TARGET_ROLE_INELIGIBLE')) throw new AuthDaoError('TABLE_SESSION_TARGET_ROLE_INELIGIBLE', 'target role ineligible');
  throw new AuthDaoError('TABLE_SESSION_ASSIGN_FAILED', 'operation failed');
}

// Assigns, reassigns, or clears (requestedWaiterActor=null) the authoritative waiter of
// one open table session. Never receives a token, step-up proof, or raw sid -- only the
// pre-hashed bySidHash, the client-supplied clientRequestId, and the pre-computed
// semantic requestHash.
async function assignTableSessionWaiterV3({
  workspaceId, byActor, tableSessionId, expectedAssignedWaiterActor = null, requestedWaiterActor = null,
  bySidHash, clientRequestId, requestHash, meta = {},
}) {
  const r = await sbRest('POST', 'rpc/auth_assign_table_session_waiter_v3', {
    body: {
      p_workspace_id: workspaceId, p_by_actor: byActor, p_table_session_id: tableSessionId,
      p_expected_assigned_waiter_actor: expectedAssignedWaiterActor, p_requested_waiter_actor: requestedWaiterActor,
      p_by_sid_hash: bySidHash, p_client_request_id: clientRequestId, p_request_hash: requestHash, p_meta: meta,
    },
  }); // single call -- no retry; idempotency is the RPC's own job on a legitimate replay
  if (!r.ok) mapAssignError(r);
  return sanitizeAssignResult(r.body);
}

// SAFE read, workspace-scoped IN THE QUERY ITSELF -- lists every OPEN session currently
// assigned to one waiter (used for safe administrative projection only; never a
// business-authority decision -- that is exclusively the RPC's job under lock).
async function listOpenTableSessionsForWaiter(workspaceId, waiterActor) {
  if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
    throw new AuthDaoError('TABLE_SESSION_READ_FAILED', 'workspace required');
  }
  if (typeof waiterActor !== 'string' || waiterActor.length === 0) {
    throw new AuthDaoError('TABLE_SESSION_READ_FAILED', 'actor required');
  }
  const r = await sbRest('GET', 'table_sessions', {
    query: `select=${SAFE_LIST_COLS}&workspace_id=eq.${encodeURIComponent(workspaceId)}`
      + `&assigned_waiter_actor=eq.${encodeURIComponent(waiterActor)}&status=eq.open&order=opened_at.asc`,
  });
  if (!r.ok || !Array.isArray(r.body)) throw new AuthDaoError('TABLE_SESSION_READ_FAILED', 'read failed');
  return r.body;
}

module.exports = {
  SAFE_RESULT_FIELDS, SAFE_LIST_COLS, sanitizeAssignResult,
  assignTableSessionWaiterV3, listOpenTableSessionsForWaiter,
};
