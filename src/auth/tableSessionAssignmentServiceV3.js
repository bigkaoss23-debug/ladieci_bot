'use strict';
// Access Control V3 -- Block V3-G: table-session waiter-assignment orchestration
// (ISOLATED, UNWIRED). Not imported by index.js, login.js, adminAccessService.js, or any
// current route -- nothing in the running application calls this file. It exists so a
// future assignment route wiring has a complete, tested starting point.
//
// Mirrors the access-user lifecycle V3 service's discipline exactly: workspace context
// and acting-owner identity come from THIS service's own authoritative caller, never a
// client body. Step-up is NOT cryptographically verified here (that belongs to the
// future HTTP route boundary) but a previously-verified, session-bound, non-expired
// result IS required and rejected outright if missing, expired, or bound to the wrong
// actor/session. The caller's acting role must ALSO already be a DB-fresh read (the
// future route's own auth middleware resolves it) -- this service rejects a non-owner
// role before ever touching the DAO, on top of the RPC's own authoritative re-check
// under lock.
//
// deps: { dao, sidHash }
//   dao: { assignTableSessionWaiterV3, listOpenTableSessionsForWaiter }
//   sidHash: src/auth/sidHash.js's sidHash -- injected, not required directly.

const { isOwnerCredentialRole } = require('./ownerCredentialRole');
const { computeAssignTableSessionWaiterRequestHash } = require('./tableSessionAssignmentRequestHash');

const FAILED = Object.freeze({ ok: false, error: 'table_session_assignment_failed' });
const CONFLICT = Object.freeze({ ok: false, error: 'idempotency_conflict' });
const STALE = Object.freeze({ ok: false, error: 'assignment_stale' });
const NOT_OPEN = Object.freeze({ ok: false, error: 'table_session_not_open' });
const TARGET_ROLE_INELIGIBLE = Object.freeze({ ok: false, error: 'target_role_ineligible' });

function createTableSessionAssignmentV3Service(deps = {}) {
  const { dao, sidHash } = deps;

  function stepUpValid(stepUp, byActor, sid) {
    if (!stepUp || typeof stepUp !== 'object') return false;
    if (stepUp.sub !== byActor) return false;
    if (stepUp.sid !== sid) return false;
    if (typeof stepUp.exp !== 'number' || !Number.isFinite(stepUp.exp)) return false;
    if (Math.floor(Date.now() / 1000) >= stepUp.exp) return false; // expired
    return true;
  }

  // assignWaiter({workspaceId, byActor, actingRole, tableSessionId, expectedAssignedWaiterActor,
  //   requestedWaiterActor, sid, clientRequestId, stepUp, meta})
  // requestedWaiterActor may be null (explicit clear).
  async function assignWaiter({
    workspaceId, byActor, actingRole, tableSessionId, expectedAssignedWaiterActor = null,
    requestedWaiterActor = null, sid, clientRequestId, stepUp, meta = {},
  } = {}) {
    try {
      if (typeof workspaceId !== 'string' || workspaceId.length === 0) return FAILED;
      if (typeof byActor !== 'string' || byActor.length === 0) return FAILED;
      if (!isOwnerCredentialRole(actingRole)) return FAILED; // non-owner acting role rejected here
      if (typeof tableSessionId !== 'string' || tableSessionId.length === 0) return FAILED;
      if (typeof clientRequestId !== 'string' || clientRequestId.length === 0) return FAILED;
      if (typeof sid !== 'string' || sid.length === 0) return FAILED;
      if (!stepUpValid(stepUp, byActor, sid)) return FAILED;
      if (!dao || typeof dao.assignTableSessionWaiterV3 !== 'function' || typeof sidHash !== 'function') return FAILED;

      const bySidHash = sidHash(sid);
      if (typeof bySidHash !== 'string' || bySidHash.length === 0) return FAILED;

      const requestHash = computeAssignTableSessionWaiterRequestHash({
        tableSessionId, expectedAssignedWaiterActor, requestedWaiterActor,
      });
      if (typeof requestHash !== 'string' || requestHash.length === 0) return FAILED;

      let result;
      try {
        result = await dao.assignTableSessionWaiterV3({
          workspaceId, byActor, tableSessionId, expectedAssignedWaiterActor, requestedWaiterActor,
          bySidHash, clientRequestId, requestHash, meta: {},
        });
      } catch (e) {
        if (e && e.code === 'TABLE_SESSION_ASSIGN_CONFLICT') return CONFLICT;
        if (e && e.code === 'TABLE_SESSION_ASSIGN_STALE') return STALE;
        if (e && e.code === 'TABLE_SESSION_NOT_OPEN') return NOT_OPEN;
        if (e && e.code === 'TABLE_SESSION_TARGET_ROLE_INELIGIBLE') return TARGET_ROLE_INELIGIBLE;
        return FAILED;
      }
      if (!result || result.table_session_id !== tableSessionId) return FAILED;

      return Object.freeze({
        ok: true,
        tableSessionId: result.table_session_id,
        assignedWaiterActor: result.assigned_waiter_actor,
        status: result.status,
        updatedAt: result.updated_at,
      });
    } catch (_) {
      return FAILED;
    }
  }

  // listOpenSessionsForWaiter({workspaceId, byActor, waiterActor}) -- read-only,
  // owner-authorized by the CALLER (route-layer auth middleware), no step-up.
  async function listOpenSessionsForWaiter({ workspaceId, waiterActor } = {}) {
    try {
      if (typeof workspaceId !== 'string' || workspaceId.length === 0) return FAILED;
      if (typeof waiterActor !== 'string' || waiterActor.length === 0) return FAILED;
      if (!dao || typeof dao.listOpenTableSessionsForWaiter !== 'function') return FAILED;

      let rows;
      try { rows = await dao.listOpenTableSessionsForWaiter(workspaceId, waiterActor); } catch (_) { return FAILED; }
      if (!Array.isArray(rows)) return FAILED;

      return Object.freeze({
        ok: true,
        sessions: Object.freeze(rows.map((r) => Object.freeze({
          id: r.id, tableRef: r.table_ref, status: r.status,
          openedAt: r.opened_at, updatedAt: r.updated_at,
        }))),
      });
    } catch (_) {
      return FAILED;
    }
  }

  return { assignWaiter, listOpenSessionsForWaiter };
}

module.exports = {
  createTableSessionAssignmentV3Service, FAILED, CONFLICT, STALE, NOT_OPEN, TARGET_ROLE_INELIGIBLE,
};
