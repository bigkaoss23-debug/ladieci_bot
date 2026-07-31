'use strict';
// Access Control V3 -- Block V3-F: HTTP-boundary-owned reads/writes (ISOLATED, UNWIRED).
// service_role only. Not imported by index.js or any current route.
//
// Two responsibilities neither the legacy (B2) dao nor any V3-B/C/D/E dao already covers:
//   1. getAuthoritativeActor(actor) -- a DB-fresh identity read that includes
//      workspace_id. dao.js's SAFE_COLS deliberately omits workspace_id (the legacy
//      4-actor system never needed it); the dynamic-access-user V3-D workspace-scoped
//      read requires workspaceId to already be known. This is the missing first read
//      that resolves "who is this session, and which workspace do they act in" -- the
//      one thing every V3-F route needs before it can call any workspace-scoped V3
//      service.
//   2. Direct access_management_idempotency read/write -- needed ONLY for
//      setAccessUserPin, because the canonical v3 PIN-rotation orchestration
//      deliberately implements no idempotency of its own (see that module's header:
//      "left to whichever future phase builds the route" -- this is that phase). Every
//      other V3-F write delegates idempotency entirely to its RPC and never touches
//      this table directly.

const { AuthDaoError, sbRest } = require('./audit');

const IDENTITY_SAFE_COLS = 'actor,role,active,session_version,workspace_id';

// DB-fresh identity read, including workspace_id. Never returns pin_hash.
async function getAuthoritativeActor(actor) {
  if (typeof actor !== 'string' || actor.length === 0) return null;
  const r = await sbRest('GET', 'auth_actors', {
    query: `select=${IDENTITY_SAFE_COLS}&actor=eq.${encodeURIComponent(actor)}&limit=1`,
  });
  if (!r.ok || !Array.isArray(r.body)) return null;
  return r.body[0] || null;
}

// findAccessManagementIdempotency({workspaceId, byActor, bySidHash, action, clientRequestId})
// -> { request_hash, response_status, response_body } | null
async function findAccessManagementIdempotency({
  workspaceId, byActor, bySidHash, action, clientRequestId,
} = {}) {
  if (typeof workspaceId !== 'string' || workspaceId.length === 0
      || typeof byActor !== 'string' || byActor.length === 0
      || typeof bySidHash !== 'string' || bySidHash.length === 0
      || typeof action !== 'string' || action.length === 0
      || typeof clientRequestId !== 'string' || clientRequestId.length === 0) {
    throw new AuthDaoError('ACCESS_MANAGEMENT_IDEMPOTENCY_READ_FAILED', 'invalid lookup key');
  }
  const query = `select=request_hash,response_status,response_body`
    + `&workspace_id=eq.${encodeURIComponent(workspaceId)}`
    + `&by_actor=eq.${encodeURIComponent(byActor)}`
    + `&by_sid_hash=eq.${encodeURIComponent(bySidHash)}`
    + `&action=eq.${encodeURIComponent(action)}`
    + `&client_request_id=eq.${encodeURIComponent(clientRequestId)}&limit=1`;
  const r = await sbRest('GET', 'access_management_idempotency', { query });
  if (!r.ok || !Array.isArray(r.body)) throw new AuthDaoError('ACCESS_MANAGEMENT_IDEMPOTENCY_READ_FAILED', 'read failed');
  return r.body[0] || null;
}

// storeAccessManagementIdempotency({workspaceId, byActor, bySidHash, action, clientRequestId,
//   requestHash, responseStatus, responseBody}) -> { ok, conflict }
// A 409 (primary-key conflict, another concurrent request already stored this exact key)
// is NOT surfaced as a failure to the caller -- the mutation this call was protecting has
// already happened by the time this insert runs, and the caller's own response is already
// correct for the request that just executed. Any other failure throws.
async function storeAccessManagementIdempotency({
  workspaceId, byActor, bySidHash, action, clientRequestId, requestHash, responseStatus, responseBody,
} = {}) {
  const r = await sbRest('POST', 'access_management_idempotency', {
    body: {
      workspace_id: workspaceId, by_actor: byActor, by_sid_hash: bySidHash, action,
      client_request_id: clientRequestId, request_hash: requestHash,
      response_status: responseStatus, response_body: responseBody,
    },
    prefer: 'return=minimal',
  });
  if (!r.ok) {
    if (r.status === 409) return { ok: false, conflict: true };
    throw new AuthDaoError('ACCESS_MANAGEMENT_IDEMPOTENCY_WRITE_FAILED', 'write failed');
  }
  return { ok: true, conflict: false };
}

module.exports = {
  IDENTITY_SAFE_COLS,
  getAuthoritativeActor,
  findAccessManagementIdempotency,
  storeAccessManagementIdempotency,
};
