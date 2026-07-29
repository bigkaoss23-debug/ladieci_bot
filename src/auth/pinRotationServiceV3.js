'use strict';
// Access Control V3 — Block V3-B: canonical PIN-rotation orchestration, v3 (ISOLATED,
// UNWIRED). Not imported by index.js, login.js, adminAccessService.js, or the current
// pinRotationService.js — nothing in the running application calls this file. It exists
// so the eventual route wiring (V3-D) has a complete, tested starting point.
//
// Extends the v2 orchestration (src/auth/pinRotationService.js) with exactly three things:
//   1. Distinguishes PIN_RESERVED (the candidate collides with the OWNER credential)
//      from PIN_DUPLICATE (collides with any other actor). Checked by ROLE
//      (isOwnerCredentialRole — 'admin' or 'owner'), never by the actor id literal
//      'owner', so a future owner row with an opaque UUID actor id still classifies
//      correctly, and an unrelated actor that merely happens to be named 'owner' never
//      gains owner semantics it doesn't have.
//   2. Verifies the candidate against every other PIN-CONFIGURED actor in the
//      workspace regardless of active state — a deactivated actor keeps its pin_hash
//      and fingerprint rows and keeps that PIN reserved, exactly like
//      fingerprintKeyRetirement.js's retirement precondition already treats inactive
//      configured actors as live reservations. Only pin_hash === null (never
//      configured) is excluded, plus the target actor itself.
//   3. Derives fingerprints for every accepted key (current, and previous when a
//      graceful rotation window is open) BEFORE calling the RPC — the RPC never
//      receives a plaintext PIN, exactly like it never receives one for the hash.
//
// Everything else — six-digit policy, IP hash, constant-work verification (no early
// exit), target-only session_version increment, single generic external failure shape
// — is unchanged from the accepted v2 discipline.
//
// Workspace scoping: unlike v2 (which reads the whole auth_actors table and filters by
// workspace in Node), the v3 duplicate-check snapshot is read through
// listWorkspaceActorsForVerify_SENSITIVE(workspaceId) — filtered by workspace_id IN THE
// QUERY ITSELF. workspaceId is therefore REQUIRED here for both caller kinds, supplied
// by this service's own authoritative caller (a verified session context), never taken
// from a client request body. Another workspace's pin_hash rows never reach this
// process, let alone the slow-hash comparison loop.
//
// Step-up: this service does NOT verify an owner step-up proof itself — that
// enforcement belongs at the future HTTP route boundary (mirrors how v2's
// adminAccessService.setActorPin verifies the proof BEFORE ever calling
// pinRotationService.rotate, not inside it). Any future caller of this service MUST
// verify step-up first; this module has no way to know if that happened and does not
// pretend to.
//
// Idempotency: deliberately NOT implemented here. The access_management_idempotency
// foundation (V3-A) is designed to be consulted at the route layer — authenticate,
// resolve role, validate step-up, THEN evaluate idempotency, THEN execute-or-replay —
// before this function is ever called. Wiring that orchestration into this service
// would either duplicate the route layer's job or do it unsafely out of order; V3-B
// leaves it to whichever future phase builds the route.

const { isOwnerCredentialRole } = require('./ownerCredentialRole');

const FAILED = Object.freeze({ ok: false, error: 'rotation_failed' });
const DUPLICATE = Object.freeze({ ok: false, error: 'pin_duplicate' });
const RESERVED = Object.freeze({ ok: false, error: 'pin_reserved' });
const IP_HASH_MAX = 64;
// Legacy account-path target restriction ONLY (an account_owner caller may rotate
// nothing but the 'owner' actor row) — unrelated to PIN_RESERVED classification, which
// is decided by role via isOwnerCredentialRole, never by this literal.
const OWNER_ACTOR = 'owner';

// deps: { dao, hashPin, verifyPin, pinPolicy, ipHash, fingerprintKeyConfig, deriveForAcceptedKeys }
//   dao: { listWorkspaceActorsForVerify_SENSITIVE, setActorPinV3 }
//   fingerprintKeyConfig: the object pinFingerprintKeyConfig.getConfig() returns —
//     { current: {id, secret}, previous: {id, secret}|null } — or null if unconfigured.
//   deriveForAcceptedKeys: pinFingerprint.deriveForAcceptedKeys — injected, not required
//     directly, so this module stays testable without real crypto material.
function createPinRotationV3(deps = {}) {
  const { dao, hashPin, verifyPin, pinPolicy, ipHash, fingerprintKeyConfig, deriveForAcceptedKeys } = deps;

  function resolveIpHash(trustedClientIp) {
    if (typeof ipHash !== 'function') return null;
    let h;
    try { h = ipHash(trustedClientIp); } catch (_) { return null; }
    if (typeof h !== 'string') return null;
    const t = h.trim();
    if (t.length === 0 || t.length > IP_HASH_MAX) return null;
    return h;
  }

  // Returns { ok:true, actor, role, sessionVersion, event, onboardingCompleted }
  //      or { ok:false, error:'pin_duplicate' | 'pin_reserved' | 'rotation_failed' }
  async function rotate({
    targetActor, newPin, trustedClientIp, callerKind,
    userId = null, workspaceId = null, byActor = null, confirm = null,
  } = {}) {
    try {
      if (callerKind !== 'account_owner' && callerKind !== 'operational_admin') return FAILED;
      if (typeof targetActor !== 'string' || targetActor.length === 0) return FAILED;
      if (callerKind === 'account_owner' && targetActor !== OWNER_ACTOR) return FAILED;
      // Workspace context is required for BOTH caller kinds: it is what scopes the
      // duplicate-check read at the database layer. It must come from this service's
      // own authoritative caller (a verified session), never from a client body.
      if (typeof workspaceId !== 'string' || workspaceId.length === 0) return FAILED;

      if (!pinPolicy || typeof pinPolicy.validateNewPinFormat !== 'function') return FAILED;
      if (!pinPolicy.validateNewPinFormat(newPin).ok) return FAILED;

      const ipH = resolveIpHash(trustedClientIp);
      if (!ipH) return FAILED;

      if (!dao || typeof dao.listWorkspaceActorsForVerify_SENSITIVE !== 'function'
          || typeof dao.setActorPinV3 !== 'function' || typeof verifyPin !== 'function'
          || typeof hashPin !== 'function' || typeof deriveForAcceptedKeys !== 'function') return FAILED;
      if (!fingerprintKeyConfig || !fingerprintKeyConfig.current) return FAILED; // fingerprint config must be ready

      // Already workspace-scoped BY THE QUERY — never an unscoped table read filtered
      // in Node. Cross-workspace pin_hash rows never reach this process.
      let all;
      try { all = await dao.listWorkspaceActorsForVerify_SENSITIVE(workspaceId); }
      catch (_) { return FAILED; }
      if (!Array.isArray(all)) return FAILED;

      const target = all.find((a) => a && a.actor === targetActor);
      // Defense in depth: re-verify the resolved target really belongs to the
      // workspace that scoped the read, even though the query already guarantees it.
      if (!target || target.workspace_id !== workspaceId) return FAILED;
      if (typeof target.role !== 'string') return FAILED;

      // Every OTHER actor already in this workspace, exactly as read.
      const others = all.filter((a) => a && a.actor !== targetActor);
      const seen = others.map((a) => ({
        actor: a.actor, active: a.active === true, pin_hash: a.pin_hash ?? null,
      }));

      // Uniqueness: every PIN-configured actor in the workspace, ACTIVE OR INACTIVE —
      // a deactivated actor keeps its pin_hash and that PIN stays reserved. Constant
      // work, no early exit; classify by ROLE (owner vs everyone else), never by the
      // matched actor's id, and let an owner-credential match win over a staff match
      // regardless of iteration order.
      let reservedMatch = false;
      let duplicateMatch = false;
      for (const a of others) {
        if (!a || !a.pin_hash) continue;
        let matched = false;
        try { matched = await verifyPin(newPin, a.pin_hash); } catch (_) { matched = false; }
        if (matched) {
          if (isOwnerCredentialRole(a.role)) reservedMatch = true;
          else duplicateMatch = true;
        } // no break — constant work preserved
      }
      if (reservedMatch) return RESERVED;
      if (duplicateMatch) return DUPLICATE;

      let pinHash;
      try { pinHash = await hashPin(newPin); } catch (_) { return FAILED; }
      if (typeof pinHash !== 'string' || pinHash.slice(0, 7) !== 'scrypt$') return FAILED;

      // Fingerprints for every accepted key — derived BEFORE the RPC call, exactly
      // like the scrypt hash above. The RPC never sees the plaintext PIN.
      const fps = deriveForAcceptedKeys(fingerprintKeyConfig, newPin);
      if (!Array.isArray(fps) || fps.length === 0) { pinHash = null; return FAILED; }
      const fpCurrent = fps.find((f) => f.keyId === fingerprintKeyConfig.current.id);
      if (!fpCurrent) { pinHash = null; return FAILED; }
      const fpPrevious = fingerprintKeyConfig.previous
        ? fps.find((f) => f.keyId === fingerprintKeyConfig.previous.id)
        : null;
      if (fingerprintKeyConfig.previous && !fpPrevious) { pinHash = null; return FAILED; } // fail-closed: never a partial dual-write

      let result;
      try {
        result = await dao.setActorPinV3({
          targetActor,
          expectedRole: target.role,
          pinHash, ipHash: ipH, seen, callerKind,
          keyIdCurrent: fpCurrent.keyId, fingerprintCurrent: fpCurrent.fingerprint,
          keyIdPrevious: fpPrevious ? fpPrevious.keyId : null,
          fingerprintPrevious: fpPrevious ? fpPrevious.fingerprint : null,
          userId, workspaceId: callerKind === 'account_owner' ? target.workspace_id : null,
          byActor, confirm, meta: {},
        });
      } catch (_) { return FAILED; } // includes AUTH_ROTATION_STALE → no write
      pinHash = null;

      if (!result || result.actor !== targetActor || !Number.isInteger(result.session_version)) return FAILED;
      return Object.freeze({
        ok: true,
        actor: result.actor,
        role: result.role,
        active: result.active,
        sessionVersion: result.session_version,
        failedCount: result.failed_count,
        lockedUntil: result.locked_until,
        updatedAt: result.updated_at,
        updatedBy: result.updated_by,
        changed: true,
        event: result.event,
        onboardingCompleted: result.onboarding_completed === true,
      });
    } catch (_) { return FAILED; }
  }

  return { rotate };
}

module.exports = { createPinRotationV3, FAILED, DUPLICATE, RESERVED };
