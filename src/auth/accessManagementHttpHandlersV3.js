'use strict';
// Access Control V3 -- Block V3-F: owner access-management HTTP boundary (ISOLATED,
// UNWIRED). Not imported by index.js, login.js, adminAccessService.js, legacyAuthGuard.js,
// legacyActionRoles.js, or any current route -- nothing in the running application calls
// this file. It orchestrates the already-built, already-tested V3-B/C/D/E services over
// nine owner-only REST routes; it never talks to Supabase/PostgREST directly except
// through accessManagementHttpDaoV3 (the one new read/write this phase needed -- DB-fresh
// identity+workspace resolution, and setAccessUserPin's own idempotency, since
// the canonical v3 PIN-rotation orchestration deliberately implements none itself).
//
// Boundary (handlers NEVER call a DAO or Supabase directly, except the one HTTP-owned
// idempotency read/write inside setAccessUserPin):
//   owner-auth middleware (DB-fresh, workspace-resolving) → [write routes: step-up
//   verification] → handler → operation-specific sanitized body → V3 service → V3 DAO →
//   one RPC (reads: one safe SELECT).
//
// Guarantees:
//  * acting identity, role, workspace, sid and auth_method ONLY from the DB-fresh
//    req.ownerContext -- never from the request body, even if the body supplies a field
//    with the same name;
//  * ownership decided ONLY by DB-fresh role (isOwnerCredentialRole), never by an actor id
//    literal;
//  * every write route requires step-up verified via jwt.verifyStepUpProof (the ONE
//    existing canonical proof verifier -- no second one is created here) BEFORE any
//    service/DAO call;
//  * every write route requires a client_request_id, validated at this boundary before
//    the underlying service/RPC is ever reached;
//  * deactivateAccessUser fails closed for a canonical-role 'waiter' target -- V3-G's
//    real DB-transactional table guard does not exist yet, so this route refuses rather
//    than risk deactivating a waiter mid-service; reactivate/clearCredential do not carry
//    this restriction;
//  * every failure -> sanitized { ok:false, code } at the centrally-mapped status
//    (accessManagementHttpErrorsV3.js); never SQL text, PostgREST body, proof, hash, or
//    stack trace.

const jwt = require('./jwt');
const accessManagementHttpDao = require('./accessManagementHttpDaoV3');
const { isOwnerCredentialRole } = require('./ownerCredentialRole');
const { isAssignableRole, canonicalRoleForDbRole } = require('./roleTransition');
const { normalizeDisplayName } = require('./accessUserDisplayName');
const { sidHash } = require('./sidHash');
const { computeSetAccessUserPinRequestHash } = require('./accessUserPinRequestHash');
const {
  statusForCode, UNAUTHENTICATED, INTERNAL_ERROR_CODE,
} = require('./accessManagementHttpErrorsV3');

const DEFAULT_PREFIX = '/api/auth/v3';
// Inherited application body-parser limit (express.json() default), same documentation
// convention as financialHttpHandlers.js's JSON_BODY_LIMIT.
const JSON_BODY_LIMIT = '100kb';
const MAX_CLIENT_REQUEST_ID_LEN = 128; // matches every V3 RPC's own p_client_request_id bound
const SET_PIN_ACTION = 'set_access_user_pin_v3';

// Ordered route table -- explicit, never client-selected. `stepUp: true` marks every
// write route (all but the two reads).
const ROUTES = Object.freeze([
  { method: 'get', path: '/access-users', handler: 'listAccessUsers', stepUp: false },
  { method: 'get', path: '/access-users/:actor', handler: 'getAccessUser', stepUp: false },
  { method: 'post', path: '/access-users', handler: 'createAccessUser', stepUp: true },
  { method: 'patch', path: '/access-users/:actor/display-name', handler: 'renameAccessUser', stepUp: true },
  { method: 'patch', path: '/access-users/:actor/role', handler: 'changeAccessUserRole', stepUp: true },
  { method: 'put', path: '/access-users/:actor/pin', handler: 'setAccessUserPin', stepUp: true },
  { method: 'delete', path: '/access-users/:actor/pin', handler: 'clearAccessUserCredential', stepUp: true },
  { method: 'post', path: '/access-users/:actor/deactivate', handler: 'deactivateAccessUser', stepUp: true },
  { method: 'post', path: '/access-users/:actor/reactivate', handler: 'reactivateAccessUser', stepUp: true },
]);

function bodyOf(req) {
  return req && req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
}

// Server-managed client IP only -- same discipline as financialHttpHandlers.extractClientIp.
function extractClientIp(req) {
  if (req && typeof req.ip === 'string' && req.ip) return req.ip;
  if (req && req.socket && typeof req.socket.remoteAddress === 'string') return req.socket.remoteAddress;
  return null;
}

function extractClientRequestId(b) {
  const v = b && b.clientRequestId;
  if (typeof v !== 'string') return null;
  if (v.length === 0 || v.length > MAX_CLIENT_REQUEST_ID_LEN) return null;
  return v;
}

function sendError(res, code) {
  const c = typeof code === 'string' ? code : INTERNAL_ERROR_CODE;
  return res.status(statusForCode(c)).json({ ok: false, code: c });
}
const send401 = (res) => res.status(statusForCode(UNAUTHENTICATED)).json({ ok: false, code: UNAUTHENTICATED });

// Every V3-B/C/D/E service collapses many distinct internal reasons into ONE generic
// external error string (accepted discipline -- identity/state never leaks through error
// granularity). This is the one place that turns each of those strings into an HTTP class.
const SERVICE_ERROR_CODE = Object.freeze({
  access_user_failed: 'AUTH_INVALID_REQUEST',
  idempotency_conflict: 'AUTH_IDEMPOTENCY_CONFLICT',
  not_found: 'AUTH_TARGET_NOT_FOUND',
  role_change_failed: 'AUTH_INVALID_REQUEST',
  access_user_lifecycle_failed: 'AUTH_INVALID_REQUEST',
  rotation_failed: 'AUTH_INVALID_REQUEST',
  pin_duplicate: 'AUTH_PIN_DUPLICATE',
  pin_reserved: 'AUTH_PIN_RESERVED',
});
function mapServiceError(errorString) {
  return SERVICE_ERROR_CODE[errorString] || INTERNAL_ERROR_CODE;
}

// Verify the Bearer JWT with the accepted B3 verifier, THEN prove the session is current
// against DB-authoritative actor state (role/active/session_version) AND resolve the
// caller's workspace_id -- the one read no existing route/DAO already provides (dao.js's
// SAFE_COLS omits workspace_id; the dynamic-access-user workspace-scoped reads require
// workspaceId to already be known). Ownership is decided ONLY by DB-fresh role
// (isOwnerCredentialRole) -- never by checking payload.sub === 'owner'. Effective order:
//   Bearer extraction → JWT signature/expiry → DB actor/workspace freshness → owner-role
//   check → trusted context attach → handler.
function createOwnerAuthContextMiddleware(deps = {}) {
  const jwtMod = deps.jwt || jwt;
  const verifyToken = typeof deps.verifyToken === 'function' ? deps.verifyToken : jwtMod.verifyToken;
  const httpDao = deps.accessManagementHttpDao || accessManagementHttpDao;
  const getAuthoritativeActor = typeof deps.getAuthoritativeActor === 'function'
    ? deps.getAuthoritativeActor
    : httpDao.getAuthoritativeActor;
  return async function ownerAuthContextMiddleware(req, res, next) {
    const raw = req && req.headers ? (req.headers.authorization || req.headers.Authorization) : null;
    const m = typeof raw === 'string' ? raw.match(/^Bearer (.+)$/) : null;
    const payload = m ? verifyToken(m[1]) : null;
    if (!payload || typeof payload.sub !== 'string' || typeof payload.role !== 'string' || !Number.isInteger(payload.sv)) {
      return send401(res); // missing / invalid / unverifiable token
    }
    let row;
    try { row = await getAuthoritativeActor(payload.sub); }
    catch (_) {
      return sendError(res, INTERNAL_ERROR_CODE); // ambiguous DB failure -> sanitized 500, never a credential verdict
    }
    if (!row || typeof row.session_version !== 'number' || typeof row.role !== 'string'
        || typeof row.workspace_id !== 'string' || row.workspace_id.length === 0) {
      return send401(res); // actor missing / unusable identity / no resolvable workspace
    }
    if (row.active !== true) return sendError(res, 'AUTH_INITIATOR_INACTIVE');
    if (row.role !== payload.role) return sendError(res, 'AUTH_FORBIDDEN_ROLE'); // DB role != token role
    if (row.session_version !== payload.sv) return send401(res); // stale session_version
    // ── owner semantics decided by DB-FRESH ROLE, never the actor id literal ──────
    if (!isOwnerCredentialRole(row.role)) return sendError(res, 'AUTH_FORBIDDEN_ROLE');
    req.ownerContext = Object.freeze({
      actor: payload.sub,
      role: row.role,
      sv: row.session_version,
      sid: payload.sid || null,
      authMethod: payload.am || null,
      workspaceId: row.workspace_id,
    });
    return next();
  };
}

// Extract + verify the owner step-up proof for ONE write request. Reuses the existing
// canonical transport (request body field `stepUpProof`, exactly like the legacy
// setActorPin action) and the existing canonical verifier (jwt.verifyStepUpProof) -- no
// second proof format, no second verifier. Binds to the CURRENT session's sid/authMethod
// (from req.ownerContext, never the body) and to the DB-fresh actor/role/session_version
// captured in that same context, mirroring adminAccessService.setActorPin's exact
// sequencing (sid/authMethod presence -> verifyStepUpProof -> purpose/sub/role/sv match).
// Returns the verified proof object, or null (caller maps null -> 403 AUTH_STEP_UP_REQUIRED).
function verifyStepUpFromRequest(req, ctx, deps = {}) {
  const jwtMod = deps.jwt || jwt;
  const b = bodyOf(req);
  const proofStr = b.stepUpProof;
  if (typeof proofStr !== 'string' || proofStr.length === 0) return null;
  if (!ctx || typeof ctx.sid !== 'string' || ctx.sid.length === 0) return null;
  if (typeof jwtMod.isValidAuthMethod !== 'function' || !jwtMod.isValidAuthMethod(ctx.authMethod)) return null;
  if (typeof jwtMod.verifyStepUpProof !== 'function') return null;
  let proof;
  try { proof = jwtMod.verifyStepUpProof(proofStr, { sid: ctx.sid, authMethod: ctx.authMethod }); }
  catch (_) { proof = null; }
  if (!proof) return null;
  if (proof.purpose !== 'manage_pins') return null; // the ONE purpose jwt.signStepUpProof ever mints
  if (proof.sub !== ctx.actor || proof.role !== ctx.role || proof.sv !== ctx.sv) return null;
  return proof;
}

function stepUpToServiceArg(proof) {
  return { sub: proof.sub, sid: proof.sid, exp: proof.exp };
}

// ── safe response projections -- never pin_hash/fingerprint/failed_count/locked_until ──
function toWireUser(u) {
  if (!u) return null;
  return Object.freeze({
    actor: u.userId, displayName: u.displayName, dbRole: u.dbRole, canonicalRole: u.canonicalRole,
    active: u.active, hasPin: u.hasPin, sessionVersion: u.sessionVersion,
    createdAt: u.createdAt, updatedAt: u.updatedAt,
  });
}
function toWireCreateOrRenameResult(r) {
  return Object.freeze({
    actor: r.userId, displayName: r.displayName, dbRole: r.dbRole, canonicalRole: r.canonicalRole,
    active: r.active, sessionVersion: r.sessionVersion, createdAt: r.createdAt, updatedAt: r.updatedAt,
  });
}
function toWireRoleChangeResult(r) {
  return Object.freeze({
    actor: r.actor, oldRole: r.oldRole, role: r.role, sessionVersion: r.sessionVersion, changed: r.changed,
  });
}
function toWireLifecycleResult(r) {
  return Object.freeze({
    actor: r.userId, dbRole: r.dbRole, active: r.active, sessionVersion: r.sessionVersion, updatedAt: r.updatedAt,
  });
}
function toWirePinResult(r) {
  return Object.freeze({ actor: r.actor, active: r.active, sessionVersion: r.sessionVersion, hasPin: true });
}

// Intended sanitizing error middleware for the future staging mount. Converts inherited
// express.json()/body-parser transport errors into a stable envelope with NO stack, NO raw
// body: malformed/oversize JSON can never mutate and never reaches auth/service. Mount
// AFTER express.json() and BEFORE the access-management routes.
function accessManagementJsonErrorHandler(err, req, res, next) {
  if (!err) return next();
  const tooLarge = err.status === 413 || err.statusCode === 413 || err.type === 'entity.too.large';
  if (tooLarge) return res.status(413).json({ ok: false, code: 'AUTH_PAYLOAD_TOO_LARGE' });
  return res.status(400).json({ ok: false, code: 'AUTH_INVALID_REQUEST' });
}

// deps: { accessUserService, roleChangeService, lifecycleService, pinRotationService,
//         accessUserDao, accessManagementHttpDao?, pinPolicy, pinFingerprintKeyConfig,
//         deriveFingerprint, jwt?, sidHash?, logger? }
function createAccessManagementHandlers(deps = {}) {
  const {
    accessUserService, roleChangeService, lifecycleService, pinRotationService, accessUserDao,
    pinPolicy, pinFingerprintKeyConfig, deriveFingerprint,
  } = deps;
  const httpDao = deps.accessManagementHttpDao || accessManagementHttpDao;
  const jwtMod = deps.jwt || jwt;
  const sidHashFn = typeof deps.sidHash === 'function' ? deps.sidHash : sidHash;
  const logger = deps.logger || null;

  const mkLog = (op, req) => (outcome, status, code) => {
    if (!logger || typeof logger.info !== 'function') return;
    try {
      logger.info({
        op, status, outcome, code: code || null,
        actor: (req && req.ownerContext && req.ownerContext.actor) || null,
        target: (req && req.params && req.params.actor) || null,
        workspaceId: (req && req.ownerContext && req.ownerContext.workspaceId) || null,
      });
    } catch (_) { /* never throw from logging */ }
  };

  function ctxOf(req, res) {
    const ctx = req && req.ownerContext;
    if (!ctx || typeof ctx.actor !== 'string') { sendError(res, UNAUTHENTICATED); return null; }
    return ctx;
  }

  // ── READS -- owner-only, DB-fresh, NO step-up ──────────────────────────────────
  async function listAccessUsers(req, res) {
    const log = mkLog('list_access_users', req);
    const ctx = ctxOf(req, res); if (!ctx) return undefined;
    if (!accessUserService || typeof accessUserService.listAccessUsers !== 'function') {
      return sendError(res, 'AUTH_ACCESS_MANAGEMENT_UNAVAILABLE');
    }
    const out = await accessUserService.listAccessUsers({ workspaceId: ctx.workspaceId, byActor: ctx.actor });
    if (!out.ok) { const code = mapServiceError(out.error); log('fail', statusForCode(code), code); return sendError(res, code); }
    log('ok', 200, null);
    return res.status(200).json({ ok: true, users: out.users.map(toWireUser) });
  }

  async function getAccessUser(req, res) {
    const log = mkLog('get_access_user', req);
    const ctx = ctxOf(req, res); if (!ctx) return undefined;
    const targetActor = req.params && req.params.actor;
    if (typeof targetActor !== 'string' || targetActor.length === 0) return sendError(res, 'AUTH_INVALID_REQUEST');
    if (!accessUserService || typeof accessUserService.getAccessUser !== 'function') {
      return sendError(res, 'AUTH_ACCESS_MANAGEMENT_UNAVAILABLE');
    }
    const out = await accessUserService.getAccessUser({ workspaceId: ctx.workspaceId, byActor: ctx.actor, targetActor });
    if (!out.ok) { const code = mapServiceError(out.error); log('fail', statusForCode(code), code); return sendError(res, code); }
    log('ok', 200, null);
    return res.status(200).json({ ok: true, user: toWireUser(out.user) });
  }

  // ── WRITES -- owner-only, DB-fresh, step-up REQUIRED before any service call ───
  async function createAccessUser(req, res) {
    const log = mkLog('create_access_user', req);
    const ctx = ctxOf(req, res); if (!ctx) return undefined;
    const proof = verifyStepUpFromRequest(req, ctx, { jwt: jwtMod });
    if (!proof) { log('fail', 403, 'AUTH_STEP_UP_REQUIRED'); return sendError(res, 'AUTH_STEP_UP_REQUIRED'); }
    const b = bodyOf(req);
    const clientRequestId = extractClientRequestId(b);
    if (!clientRequestId) return sendError(res, 'AUTH_CLIENT_REQUEST_ID_INVALID');
    if (!isAssignableRole(b.role)) return sendError(res, 'AUTH_ROLE_INVALID');
    if (normalizeDisplayName(b.displayName) === null) return sendError(res, 'AUTH_DISPLAY_NAME_INVALID');
    if (!accessUserService || typeof accessUserService.createAccessUser !== 'function') {
      return sendError(res, 'AUTH_ACCESS_MANAGEMENT_UNAVAILABLE');
    }
    const out = await accessUserService.createAccessUser({
      workspaceId: ctx.workspaceId, byActor: ctx.actor, displayName: b.displayName, requestedRole: b.role,
      sid: ctx.sid, clientRequestId, stepUp: stepUpToServiceArg(proof),
    });
    if (!out.ok) { const code = mapServiceError(out.error); log('fail', statusForCode(code), code); return sendError(res, code); }
    log('ok', 200, null);
    return res.status(200).json({ ok: true, user: toWireCreateOrRenameResult(out) });
  }

  async function renameAccessUser(req, res) {
    const log = mkLog('rename_access_user', req);
    const ctx = ctxOf(req, res); if (!ctx) return undefined;
    const proof = verifyStepUpFromRequest(req, ctx, { jwt: jwtMod });
    if (!proof) { log('fail', 403, 'AUTH_STEP_UP_REQUIRED'); return sendError(res, 'AUTH_STEP_UP_REQUIRED'); }
    const targetActor = req.params && req.params.actor;
    if (typeof targetActor !== 'string' || targetActor.length === 0) return sendError(res, 'AUTH_INVALID_REQUEST');
    const b = bodyOf(req);
    const clientRequestId = extractClientRequestId(b);
    if (!clientRequestId) return sendError(res, 'AUTH_CLIENT_REQUEST_ID_INVALID');
    if (normalizeDisplayName(b.displayName) === null) return sendError(res, 'AUTH_DISPLAY_NAME_INVALID');
    if (!accessUserService || typeof accessUserService.renameAccessUser !== 'function') {
      return sendError(res, 'AUTH_ACCESS_MANAGEMENT_UNAVAILABLE');
    }
    const out = await accessUserService.renameAccessUser({
      workspaceId: ctx.workspaceId, byActor: ctx.actor, targetActor, newDisplayName: b.displayName,
      sid: ctx.sid, clientRequestId, stepUp: stepUpToServiceArg(proof),
    });
    if (!out.ok) { const code = mapServiceError(out.error); log('fail', statusForCode(code), code); return sendError(res, code); }
    log('ok', 200, null);
    return res.status(200).json({ ok: true, user: toWireCreateOrRenameResult(out) });
  }

  async function changeAccessUserRole(req, res) {
    const log = mkLog('change_access_user_role', req);
    const ctx = ctxOf(req, res); if (!ctx) return undefined;
    const proof = verifyStepUpFromRequest(req, ctx, { jwt: jwtMod });
    if (!proof) { log('fail', 403, 'AUTH_STEP_UP_REQUIRED'); return sendError(res, 'AUTH_STEP_UP_REQUIRED'); }
    const targetActor = req.params && req.params.actor;
    if (typeof targetActor !== 'string' || targetActor.length === 0) return sendError(res, 'AUTH_INVALID_REQUEST');
    const b = bodyOf(req);
    const clientRequestId = extractClientRequestId(b);
    if (!clientRequestId) return sendError(res, 'AUTH_CLIENT_REQUEST_ID_INVALID');
    if (typeof b.expectedRole !== 'string' || b.expectedRole.length === 0) return sendError(res, 'AUTH_INVALID_REQUEST');
    if (!isAssignableRole(b.requestedRole)) return sendError(res, 'AUTH_ROLE_INVALID');
    if (!roleChangeService || typeof roleChangeService.changeRole !== 'function') {
      return sendError(res, 'AUTH_ACCESS_MANAGEMENT_UNAVAILABLE');
    }
    const out = await roleChangeService.changeRole({
      workspaceId: ctx.workspaceId, byActor: ctx.actor, targetActor,
      expectedRole: b.expectedRole, requestedRole: b.requestedRole,
      sid: ctx.sid, clientRequestId, stepUp: stepUpToServiceArg(proof),
    });
    if (!out.ok) { const code = mapServiceError(out.error); log('fail', statusForCode(code), code); return sendError(res, code); }
    log('ok', 200, null);
    return res.status(200).json({ ok: true, user: toWireRoleChangeResult(out) });
  }

  // The one write that owns its OWN idempotency end to end (the canonical v3 PIN-rotation
  // orchestration deliberately implements none -- see that module's header). Authorization + step-up are
  // fully resolved BEFORE the idempotency lookup, and the idempotency lookup itself happens
  // BEFORE any mutation -- same ordering discipline as every V3-C/D/E RPC.
  async function setAccessUserPin(req, res) {
    const log = mkLog('set_access_user_pin', req);
    const ctx = ctxOf(req, res); if (!ctx) return undefined;
    const proof = verifyStepUpFromRequest(req, ctx, { jwt: jwtMod });
    if (!proof) { log('fail', 403, 'AUTH_STEP_UP_REQUIRED'); return sendError(res, 'AUTH_STEP_UP_REQUIRED'); }
    const targetActor = req.params && req.params.actor;
    if (typeof targetActor !== 'string' || targetActor.length === 0) return sendError(res, 'AUTH_INVALID_REQUEST');
    const b = bodyOf(req);
    const clientRequestId = extractClientRequestId(b);
    if (!clientRequestId) return sendError(res, 'AUTH_CLIENT_REQUEST_ID_INVALID');
    if (!pinPolicy || typeof pinPolicy.validateNewPinFormat !== 'function' || !pinPolicy.validateNewPinFormat(b.pin).ok) {
      return sendError(res, 'AUTH_PIN_FORMAT_INVALID');
    }
    if (!pinFingerprintKeyConfig || !pinFingerprintKeyConfig.current || typeof deriveFingerprint !== 'function') {
      return sendError(res, 'AUTH_ACCESS_MANAGEMENT_UNAVAILABLE');
    }
    const fp = deriveFingerprint(pinFingerprintKeyConfig.current, b.pin);
    if (!fp) return sendError(res, 'AUTH_PIN_FORMAT_INVALID');
    const requestHash = computeSetAccessUserPinRequestHash({ targetActor, pinFingerprint: fp.fingerprint });
    const bySidHash = sidHashFn(ctx.sid);
    if (!requestHash || !bySidHash) return sendError(res, 'AUTH_INVALID_REQUEST');

    let existing;
    try {
      existing = await httpDao.findAccessManagementIdempotency({
        workspaceId: ctx.workspaceId, byActor: ctx.actor, bySidHash, action: SET_PIN_ACTION, clientRequestId,
      });
    } catch (_) { return sendError(res, INTERNAL_ERROR_CODE); }
    if (existing) {
      if (existing.request_hash === requestHash) {
        log('ok_replay', existing.response_status, null);
        return res.status(existing.response_status).json(existing.response_body);
      }
      log('fail', 409, 'AUTH_IDEMPOTENCY_CONFLICT');
      return sendError(res, 'AUTH_IDEMPOTENCY_CONFLICT');
    }

    if (!pinRotationService || typeof pinRotationService.rotate !== 'function') {
      return sendError(res, 'AUTH_ACCESS_MANAGEMENT_UNAVAILABLE');
    }
    const out = await pinRotationService.rotate({
      targetActor, newPin: b.pin, trustedClientIp: extractClientIp(req),
      callerKind: 'operational_admin', byActor: ctx.actor, workspaceId: ctx.workspaceId,
      confirm: typeof b.confirmation === 'string' ? b.confirmation : null,
    });
    if (!out || out.ok !== true) {
      const code = mapServiceError(out && out.error);
      log('fail', statusForCode(code), code);
      return sendError(res, code);
    }

    const responseBody = { ok: true, user: toWirePinResult(out) };
    try {
      await httpDao.storeAccessManagementIdempotency({
        workspaceId: ctx.workspaceId, byActor: ctx.actor, bySidHash, action: SET_PIN_ACTION, clientRequestId,
        requestHash, responseStatus: 200, responseBody,
      });
    } catch (_) {
      // Best-effort: the mutation already succeeded for THIS request. A lost idempotency
      // row only risks a FUTURE replay re-running rotate() instead of returning a stored
      // response -- never surfaced as a failure of the request that just executed.
    }
    log('ok', 200, null);
    return res.status(200).json(responseBody);
  }

  async function clearAccessUserCredential(req, res) {
    const log = mkLog('clear_access_user_credential', req);
    const ctx = ctxOf(req, res); if (!ctx) return undefined;
    const proof = verifyStepUpFromRequest(req, ctx, { jwt: jwtMod });
    if (!proof) { log('fail', 403, 'AUTH_STEP_UP_REQUIRED'); return sendError(res, 'AUTH_STEP_UP_REQUIRED'); }
    const targetActor = req.params && req.params.actor;
    if (typeof targetActor !== 'string' || targetActor.length === 0) return sendError(res, 'AUTH_INVALID_REQUEST');
    const b = bodyOf(req);
    const clientRequestId = extractClientRequestId(b);
    if (!clientRequestId) return sendError(res, 'AUTH_CLIENT_REQUEST_ID_INVALID');
    if (!Number.isInteger(b.expectedSessionVersion) || b.expectedSessionVersion < 1) {
      return sendError(res, 'AUTH_INVALID_REQUEST');
    }
    if (!lifecycleService || typeof lifecycleService.clearAccessUserCredential !== 'function') {
      return sendError(res, 'AUTH_ACCESS_MANAGEMENT_UNAVAILABLE');
    }
    const out = await lifecycleService.clearAccessUserCredential({
      workspaceId: ctx.workspaceId, byActor: ctx.actor, actingRole: ctx.role, targetActor,
      expectedSessionVersion: b.expectedSessionVersion,
      sid: ctx.sid, clientRequestId, stepUp: stepUpToServiceArg(proof),
    });
    if (!out.ok) { const code = mapServiceError(out.error); log('fail', statusForCode(code), code); return sendError(res, code); }
    log('ok', 200, null);
    return res.status(200).json({ ok: true, user: toWireLifecycleResult(out) });
  }

  // V3-G has not yet implemented the DB-transactional open-table guard for waiters. Fail
  // CLOSED here -- read the target's DB-fresh canonical role and refuse before ANY call
  // into the lifecycle service/DAO/RPC if it is 'waiter'. This is a TEMPORARY route-level
  // safety block, not a substitute for the eventual real database guard.
  async function deactivateAccessUser(req, res) {
    const log = mkLog('deactivate_access_user', req);
    const ctx = ctxOf(req, res); if (!ctx) return undefined;
    const proof = verifyStepUpFromRequest(req, ctx, { jwt: jwtMod });
    if (!proof) { log('fail', 403, 'AUTH_STEP_UP_REQUIRED'); return sendError(res, 'AUTH_STEP_UP_REQUIRED'); }
    const targetActor = req.params && req.params.actor;
    if (typeof targetActor !== 'string' || targetActor.length === 0) return sendError(res, 'AUTH_INVALID_REQUEST');
    const b = bodyOf(req);
    const clientRequestId = extractClientRequestId(b);
    if (!clientRequestId) return sendError(res, 'AUTH_CLIENT_REQUEST_ID_INVALID');
    if (typeof b.expectedActive !== 'boolean') return sendError(res, 'AUTH_INVALID_REQUEST');
    if (!accessUserDao || typeof accessUserDao.getAccessUserForWorkspace !== 'function') {
      return sendError(res, 'AUTH_ACCESS_MANAGEMENT_UNAVAILABLE');
    }

    let target;
    try { target = await accessUserDao.getAccessUserForWorkspace(ctx.workspaceId, targetActor); }
    catch (_) { return sendError(res, INTERNAL_ERROR_CODE); }
    if (!target) { log('fail', 404, 'AUTH_TARGET_NOT_FOUND'); return sendError(res, 'AUTH_TARGET_NOT_FOUND'); }
    if (canonicalRoleForDbRole(target.role) === 'waiter') {
      log('fail', 409, 'AUTH_WAITER_DEACTIVATION_REQUIRES_TABLE_GUARD');
      return sendError(res, 'AUTH_WAITER_DEACTIVATION_REQUIRES_TABLE_GUARD');
    }

    if (!lifecycleService || typeof lifecycleService.deactivateAccessUser !== 'function') {
      return sendError(res, 'AUTH_ACCESS_MANAGEMENT_UNAVAILABLE');
    }
    const out = await lifecycleService.deactivateAccessUser({
      workspaceId: ctx.workspaceId, byActor: ctx.actor, actingRole: ctx.role, targetActor,
      expectedActive: b.expectedActive,
      sid: ctx.sid, clientRequestId, stepUp: stepUpToServiceArg(proof),
    });
    if (!out.ok) { const code = mapServiceError(out.error); log('fail', statusForCode(code), code); return sendError(res, code); }
    log('ok', 200, null);
    return res.status(200).json({ ok: true, user: toWireLifecycleResult(out) });
  }

  // No waiter/table-assignment safety claim -- reactivation never removes a worker from
  // an open table, only deactivation does.
  async function reactivateAccessUser(req, res) {
    const log = mkLog('reactivate_access_user', req);
    const ctx = ctxOf(req, res); if (!ctx) return undefined;
    const proof = verifyStepUpFromRequest(req, ctx, { jwt: jwtMod });
    if (!proof) { log('fail', 403, 'AUTH_STEP_UP_REQUIRED'); return sendError(res, 'AUTH_STEP_UP_REQUIRED'); }
    const targetActor = req.params && req.params.actor;
    if (typeof targetActor !== 'string' || targetActor.length === 0) return sendError(res, 'AUTH_INVALID_REQUEST');
    const b = bodyOf(req);
    const clientRequestId = extractClientRequestId(b);
    if (!clientRequestId) return sendError(res, 'AUTH_CLIENT_REQUEST_ID_INVALID');
    if (typeof b.expectedActive !== 'boolean') return sendError(res, 'AUTH_INVALID_REQUEST');
    if (!lifecycleService || typeof lifecycleService.reactivateAccessUser !== 'function') {
      return sendError(res, 'AUTH_ACCESS_MANAGEMENT_UNAVAILABLE');
    }
    const out = await lifecycleService.reactivateAccessUser({
      workspaceId: ctx.workspaceId, byActor: ctx.actor, actingRole: ctx.role, targetActor,
      expectedActive: b.expectedActive,
      sid: ctx.sid, clientRequestId, stepUp: stepUpToServiceArg(proof),
    });
    if (!out.ok) { const code = mapServiceError(out.error); log('fail', statusForCode(code), code); return sendError(res, code); }
    log('ok', 200, null);
    return res.status(200).json({ ok: true, user: toWireLifecycleResult(out) });
  }

  return {
    listAccessUsers, getAccessUser, createAccessUser, renameAccessUser, changeAccessUserRole,
    setAccessUserPin, clearAccessUserCredential, deactivateAccessUser, reactivateAccessUser,
  };
}

// Additive registration: mounts EXACTLY the nine routes, each guarded by the owner-auth
// middleware placed BEFORE the handler so no route is reachable unauthenticated. No
// wildcard/generic/action route; route paths are static (never client-supplied).
function registerAccessManagementRoutes(app, deps = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function'
      || typeof app.patch !== 'function' || typeof app.put !== 'function' || typeof app.delete !== 'function') {
    throw new Error('registerAccessManagementRoutes: express app required');
  }
  const required = ['accessUserService', 'roleChangeService', 'lifecycleService', 'pinRotationService', 'accessUserDao'];
  for (const k of required) {
    if (!deps[k]) throw new Error(`registerAccessManagementRoutes: ${k} required`);
  }
  const prefix = typeof deps.prefix === 'string' && deps.prefix ? deps.prefix : DEFAULT_PREFIX;
  const auth = createOwnerAuthContextMiddleware(deps);
  const handlers = createAccessManagementHandlers(deps);
  const registered = [];
  for (const r of ROUTES) {
    app[r.method](prefix + r.path, auth, handlers[r.handler]);
    registered.push({ method: r.method.toUpperCase(), path: prefix + r.path, handler: r.handler });
  }
  return Object.freeze({ prefix, routes: Object.freeze(registered) });
}

module.exports = {
  DEFAULT_PREFIX, JSON_BODY_LIMIT, ROUTES, MAX_CLIENT_REQUEST_ID_LEN, SET_PIN_ACTION,
  bodyOf, extractClientIp, extractClientRequestId,
  createOwnerAuthContextMiddleware, verifyStepUpFromRequest, stepUpToServiceArg,
  createAccessManagementHandlers, registerAccessManagementRoutes,
  accessManagementJsonErrorHandler, mapServiceError,
  toWireUser, toWireCreateOrRenameResult, toWireRoleChangeResult, toWireLifecycleResult, toWirePinResult,
};
