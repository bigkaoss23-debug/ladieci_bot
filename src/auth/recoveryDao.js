'use strict';
// Access Control V2 — Block B5: recovery/bootstrap DAO. service_role only.
// Thin wrappers over the two atomic SQL RPCs (auth_register_recovery_window,
// auth_consume_recovery_window). All controlled RAISE markers are mapped to a
// single GENERIC error — the caller cannot tell which check failed (no oracle).
// Never logs, never prints, never returns a secret/PIN/hash.

const { AuthDaoError, sbRest } = require('./audit');

// Every failure surface maps to one opaque code. Internal markers are NOT echoed.
async function callRpc(fn, args) {
  const r = await sbRest('POST', `rpc/${fn}`, { body: args });
  if (!r.ok) throw new AuthDaoError('RECOVERY_FAILED', 'operation failed');
  return r.body;
}

// Idempotent registration of an immutable descriptor (server enforces the
// 15-minute ceiling, already-expired rejection, and exact-match-or-fail).
function registerRecoveryWindow({ windowId, purpose, actor, secretDigest, expiresAt, meta = {} }) {
  return callRpc('auth_register_recovery_window', {
    p_window_id: windowId,
    p_purpose: purpose,
    p_actor: actor,
    p_secret_digest: secretDigest,
    p_expires_at: expiresAt,
    p_meta: meta,
  });
}

// Atomic one-shot consumption: window consume + admin PIN replacement + audit in
// ONE transaction (see the SQL function). p_new_hash is the B1 scrypt hash.
// S2-7D2: consumeRecoveryWindow was REMOVED — auth_consume_recovery_window is fail-closed by
// the writer cutover (it wrote pin_hash AND active=true outside the canonical workspace lock).
// Emergency operational recovery returns in a later block, rebuilt on that lock.
module.exports = { registerRecoveryWindow };
