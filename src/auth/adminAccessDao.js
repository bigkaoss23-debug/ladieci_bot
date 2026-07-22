'use strict';
// Access Control V2 — Block B6B: routine admin-access DAO (service_role only).
// Thin wrappers over the four B6A atomic RPCs (auth_admin_set_actor_pin,
// auth_admin_revoke_actor_sessions, auth_admin_set_actor_active,
// auth_admin_unlock_actor). Used only behind the Auth V2 admin boundary.
//
// Contract:
//  * passes the EXACT B6A parameter names; never a frozen B2 RPC substitute;
//  * never writes auth_actors / auth_audit directly;
//  * maps EVERY RPC failure to ONE generic error (no PostgREST body, no SQL text,
//    no oracle about which check failed);
//  * accepts/returns ONLY the sanitized B6A fields (pin_hash can never pass);
//  * rejects malformed RPC payloads fail-closed;
//  * performs NO automatic retry (single sbRest call per action).

const { AuthDaoError, sbRest } = require('./audit');

// Sanitized B6A return fields (NEVER pin_hash / raw ip / confirmation / meta).
const SAFE_RESULT_FIELDS = Object.freeze([
  'actor', 'role', 'active', 'session_version', 'failed_count', 'locked_until',
  'updated_at', 'updated_by', 'changed', 'event',
]);
// Safe read columns for the authoritative target-role lookup (NO pin_hash).
const SAFE_COLS = 'actor,role,active,session_version,failed_count,locked_until,updated_at,updated_by';

// One opaque failure for any RPC/transport error. Internal markers/bodies are
// NEVER echoed — the caller cannot distinguish initiator/target/role/confirm/
// state/SQL failures from one another.
async function callRpc(fn, args) {
  const r = await sbRest('POST', `rpc/${fn}`, { body: args }); // single call — no retry
  if (!r.ok) throw new AuthDaoError('ADMIN_ACTION_FAILED', 'operation failed');
  return r.body;
}

// Whitelist + shape-check the sanitized RPC payload. Rejects anything malformed
// fail-closed and strips any unexpected key (defense-in-depth against pin_hash).
function sanitizeResult(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new AuthDaoError('ADMIN_ACTION_FAILED', 'malformed response');
  }
  if (typeof body.actor !== 'string' || body.actor.length === 0) throw new AuthDaoError('ADMIN_ACTION_FAILED', 'malformed response');
  if (!Number.isInteger(body.session_version)) throw new AuthDaoError('ADMIN_ACTION_FAILED', 'malformed response');
  if (typeof body.changed !== 'boolean') throw new AuthDaoError('ADMIN_ACTION_FAILED', 'malformed response');
  if (!(body.event === null || typeof body.event === 'string')) throw new AuthDaoError('ADMIN_ACTION_FAILED', 'malformed response');
  const out = {};
  for (const k of SAFE_RESULT_FIELDS) if (k in body) out[k] = body[k];
  return Object.freeze(out);
}

async function restSelect(query) {
  const r = await sbRest('GET', 'auth_actors', { query });
  if (!r.ok || !Array.isArray(r.body)) throw new AuthDaoError('ADMIN_ACTION_FAILED', 'read failed');
  return r.body;
}

// ── authoritative target read (role/active), NEVER returns pin_hash ───────────
async function getActorSafe(actor) {
  const rows = await restSelect(`select=${SAFE_COLS}&actor=eq.${encodeURIComponent(actor)}&limit=1`);
  return rows[0] || null;
}

// ── four B6A mutation wrappers (exact param names) ───────────────────────────
async function adminSetActorPin({ byActor, targetActor, expectedRole, pinHash, ipHash, meta = {}, confirm = null }) {
  const body = await callRpc('auth_admin_set_actor_pin', {
    p_by_actor: byActor, p_target_actor: targetActor, p_expected_role: expectedRole,
    p_hash: pinHash, p_ip_hash: ipHash, p_meta: meta, p_confirm: confirm,
  });
  return sanitizeResult(body);
}

async function adminRevokeActorSessions({ byActor, targetActor, expectedRole, ipHash, meta = {}, confirm = null }) {
  const body = await callRpc('auth_admin_revoke_actor_sessions', {
    p_by_actor: byActor, p_target_actor: targetActor, p_expected_role: expectedRole,
    p_ip_hash: ipHash, p_meta: meta, p_confirm: confirm,
  });
  return sanitizeResult(body);
}

async function adminSetActorActive({ byActor, targetActor, expectedRole, active, ipHash, meta = {} }) {
  const body = await callRpc('auth_admin_set_actor_active', {
    p_by_actor: byActor, p_target_actor: targetActor, p_expected_role: expectedRole,
    p_active: active, p_ip_hash: ipHash, p_meta: meta,
  });
  return sanitizeResult(body);
}

async function adminUnlockActor({ byActor, targetActor, expectedRole, ipHash, meta = {} }) {
  const body = await callRpc('auth_admin_unlock_actor', {
    p_by_actor: byActor, p_target_actor: targetActor, p_expected_role: expectedRole,
    p_ip_hash: ipHash, p_meta: meta,
  });
  return sanitizeResult(body);
}

module.exports = {
  SAFE_RESULT_FIELDS, sanitizeResult, getActorSafe,
  adminSetActorPin, adminRevokeActorSessions, adminSetActorActive, adminUnlockActor,
};
