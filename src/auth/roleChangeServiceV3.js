'use strict';
// Access Control V3 — Block V3-C: canonical role-change orchestration, v3 (ISOLATED,
// UNWIRED). Not imported by index.js, login.js, adminAccessService.js, or any current
// PIN route — nothing in the running application calls this file. It exists so the
// eventual changeAccessUserRole route wiring (V3-D) has a complete, tested starting
// point.
//
// Mirrors the pin-rotation V3 service's discipline (workspace context required from the
// caller, never a client body; the RPC does its own authoritative re-verification under
// lock) with the two things a role change specifically needs:
//   1. Step-up binding: this service does NOT perform the actual step-up cryptographic
//      verification itself — same as pin rotation, that belongs to the future HTTP route
//      boundary. What it DOES do is require the ALREADY-VERIFIED step-up result and
//      reject outright if it is missing, or if its bound actor/sid do not match the
//      caller-supplied byActor/sid for THIS call. A verified-elsewhere proof for the
//      wrong actor or the wrong session can never be used here.
//   2. Idempotency: bySidHash (sha256(sid), never the raw sid) and the normalized
//      semantic requestHash (target + expected role + requested role — never token,
//      proof, cookies, or any transient auth material) are computed here, before the
//      RPC is ever called, so the RPC receives exactly what access_management_idempotency
//      needs and nothing else.
//
// deps: { dao, sidHash }
//   dao: { changeActorRoleV3 }
//   sidHash: src/auth/sidHash.js's sidHash — injected, not required directly, so this
//     module stays testable without real crypto material.

const { isAssignableRole } = require('./roleTransition');
const { computeRoleChangeRequestHash } = require('./roleChangeRequestHash');

const FAILED = Object.freeze({ ok: false, error: 'role_change_failed' });
const CONFLICT = Object.freeze({ ok: false, error: 'idempotency_conflict' });
// V3-G.1 addition: distinguishes the database-authoritative "this waiter still has open
// table sessions" conflict from every other generic failure, mirroring exactly how
// CONFLICT above already distinguishes idempotency-key reuse, and using the SAME error
// string as the access-user lifecycle service's own equivalent constant so the HTTP
// boundary's existing generic error-code table (waiter_has_open_tables ->
// AUTH_WAITER_HAS_OPEN_TABLES -> 409) already routes it correctly with zero handler
// changes. Raised only by auth_change_actor_role_v3 for a role change away from
// role='waiter' while open table sessions remain assigned.
const WAITER_HAS_OPEN_TABLES = Object.freeze({ ok: false, error: 'waiter_has_open_tables' });

function createRoleChangeV3(deps = {}) {
  const { dao, sidHash } = deps;

  // Returns { ok:true, actor, oldRole, role, sessionVersion, changed }
  //      or { ok:false, error:'role_change_failed' | 'idempotency_conflict' }
  async function changeRole({
    workspaceId, byActor, targetActor, expectedRole, requestedRole,
    sid, clientRequestId, stepUp, meta = {},
  } = {}) {
    try {
      if (typeof workspaceId !== 'string' || workspaceId.length === 0) return FAILED;
      if (typeof byActor !== 'string' || byActor.length === 0) return FAILED;
      if (typeof targetActor !== 'string' || targetActor.length === 0) return FAILED;
      if (byActor === targetActor) return FAILED; // an owner never targets themselves here
      if (typeof expectedRole !== 'string' || expectedRole.length === 0) return FAILED;
      if (!isAssignableRole(requestedRole)) return FAILED;
      if (typeof clientRequestId !== 'string' || clientRequestId.length === 0) return FAILED;
      if (typeof sid !== 'string' || sid.length === 0) return FAILED;

      // Step-up: require a previously validated, session-bound result. Reject missing
      // or mismatched context BEFORE touching the DAO at all — no partial credit for an
      // almost-right proof.
      if (!stepUp || typeof stepUp !== 'object') return FAILED;
      if (stepUp.sub !== byActor) return FAILED;
      if (stepUp.sid !== sid) return FAILED;

      if (!dao || typeof dao.changeActorRoleV3 !== 'function' || typeof sidHash !== 'function') return FAILED;

      const bySidHash = sidHash(sid);
      if (typeof bySidHash !== 'string' || bySidHash.length === 0) return FAILED;

      const requestHash = computeRoleChangeRequestHash({ targetActor, expectedRole, requestedRole });
      if (typeof requestHash !== 'string' || requestHash.length === 0) return FAILED;

      let result;
      try {
        result = await dao.changeActorRoleV3({
          workspaceId, byActor, targetActor, expectedRole, requestedRole,
          bySidHash, clientRequestId, requestHash, meta: {},
        });
      } catch (e) {
        if (e && e.code === 'ROLE_CHANGE_CONFLICT') return CONFLICT;
        if (e && e.code === 'ROLE_CHANGE_WAITER_OPEN_TABLES') return WAITER_HAS_OPEN_TABLES;
        return FAILED;
      }
      if (!result || result.actor !== targetActor) return FAILED;

      return Object.freeze({
        ok: true,
        actor: result.actor,
        oldRole: result.old_role,
        role: result.role,
        sessionVersion: result.session_version,
        changed: result.changed === true,
      });
    } catch (_) {
      return FAILED;
    }
  }

  return { changeRole };
}

module.exports = { createRoleChangeV3, FAILED, CONFLICT, WAITER_HAS_OPEN_TABLES };
