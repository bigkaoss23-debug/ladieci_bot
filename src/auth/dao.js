'use strict';
// Access Control V2 — Block B2: auth_actors DAO. service_role only (backend).
// Small, specific primitives — NOT generic CRUD. Safe reads never return
// pin_hash; the single sensitive read is clearly named. Atomic rate-limit and
// session-version operations go through SQL RPCs. Never logs; never prints.

const { AuthDaoError, sanitizeMeta, sbRest } = require('./audit');

// Columns safe to return to callers (NO pin_hash).
const SAFE_COLS = 'actor,role,active,session_version,failed_count,locked_until,updated_at,updated_by';
const ACTORS = Object.freeze(['owner', 'operator_primary', 'operator_backup', 'rider']);

// ── RPC helper: maps controlled RAISE markers → typed errors (no SQL leak) ────
async function callRpc(fn, args) {
  const r = await sbRest('POST', `rpc/${fn}`, { body: args });
  if (!r.ok) {
    const marker = r.body && typeof r.body.message === 'string' ? r.body.message : '';
    if (marker.includes('AUTH_ACTOR_NOT_FOUND')) throw new AuthDaoError('NOT_FOUND', 'actor not found');
    if (marker.includes('AUTH_META_')) throw new AuthDaoError('VALIDATION', 'invalid meta');
    throw new AuthDaoError('DB_ERROR', 'operation failed');
  }
  return r.body;
}

async function restSelect(query) {
  const r = await sbRest('GET', 'auth_actors', { query });
  if (!r.ok || !Array.isArray(r.body)) throw new AuthDaoError('DB_ERROR', 'read failed');
  return r.body;
}

// ── safe reads (never return pin_hash) ───────────────────────────────────────
async function getActor(actor) {
  const rows = await restSelect(`select=${SAFE_COLS}&actor=eq.${encodeURIComponent(actor)}&limit=1`);
  return rows[0] || null;
}

async function getActorsByRole(role) {
  return restSelect(`select=${SAFE_COLS}&role=eq.${encodeURIComponent(role)}&order=actor.asc`);
}

// Returns safe rows + has_pin. Reads pin_hash server-side ONLY to derive the
// boolean and NEVER returns it to the caller.
async function listActorsSafe() {
  const rows = await restSelect(`select=${SAFE_COLS},pin_hash&order=actor.asc`);
  return rows.map((r) => {
    const { pin_hash, ...safe } = r;
    return { ...safe, has_pin: pin_hash != null };
  });
}

// ── SENSITIVE read: includes pin_hash. For the login PIN check only (B3). ─────
async function getActorForVerify_SENSITIVE(actor) {
  const rows = await restSelect(
    `select=actor,role,active,session_version,pin_hash,failed_count,locked_until&actor=eq.${encodeURIComponent(actor)}&limit=1`);
  return rows[0] || null;
}

async function listActorsForVerify_SENSITIVE() {
  return restSelect(`select=actor,role,active,session_version,pin_hash,failed_count,locked_until&actor=in.(${ACTORS.join(',')})&order=actor.asc`);
}

// ── lock state (read-only, computed) ─────────────────────────────────────────
async function getLockState(actor) {
  const a = await getActor(actor);
  if (!a) throw new AuthDaoError('NOT_FOUND', 'actor not found');
  const until = a.locked_until ? new Date(a.locked_until) : null;
  const locked = !!(until && until.getTime() > Date.now());
  return {
    actor, locked,
    locked_until: a.locked_until || null,
    failed_count: a.failed_count,
    retryAfterSec: locked ? Math.ceil((until.getTime() - Date.now()) / 1000) : 0,
  };
}

// ── atomic mutations (via RPC) ───────────────────────────────────────────────
function recordFailedAttempt(actor) { return callRpc('auth_record_failed_attempt', { p_actor: actor }); }
function resetFailedAttempts(actor) { return callRpc('auth_reset_failed_attempts', { p_actor: actor }); }

function setActorPinHash({ actor, pinHash, byActor, meta = {} }) {
  const clean = sanitizeMeta(meta); // deep JS sanitize before the DB
  return callRpc('auth_set_pin_hash', { p_actor: actor, p_hash: pinHash, p_by: byActor, p_meta: clean });
}

function incrementSessionVersion({ actor, byActor, meta = {} }) {
  const clean = sanitizeMeta(meta);
  return callRpc('auth_bump_session_version', { p_actor: actor, p_by: byActor, p_meta: clean });
}

function setActorActive({ actor, active, byActor, meta = {} }) {
  const clean = sanitizeMeta(meta);
  return callRpc('auth_set_active', { p_actor: actor, p_active: active, p_by: byActor, p_meta: clean });
}

module.exports = {
  AuthDaoError, ACTORS,
  getActor, getActorsByRole, listActorsSafe, getActorForVerify_SENSITIVE, listActorsForVerify_SENSITIVE, getLockState,
  recordFailedAttempt, resetFailedAttempts,
  setActorPinHash, incrementSessionVersion, setActorActive,
};
