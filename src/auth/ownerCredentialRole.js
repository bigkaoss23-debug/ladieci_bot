'use strict';
// Access Control V3 — Block V3-B: pure owner-credential classification (FOUNDATION
// ONLY, UNWIRED). No env, no I/O, no DB.
//
// The reserved-owner-PIN distinction (PIN_RESERVED vs PIN_DUPLICATE) must be decided by
// ROLE, never by the actor id literal 'owner' — a future owner row may carry an opaque
// UUID actor id, and 'owner' as an actor id is legacy data, not a security decision.
// Both codes below name the SAME reserved-credential concept across the transition:
//   'admin' — the transitional legacy role the owner row currently holds;
//   'owner' — the stable V3 role code (see roleRegistry.js) it migrates to.
const OWNER_CREDENTIAL_ROLES = Object.freeze(['admin', 'owner']);

function isOwnerCredentialRole(role) {
  return typeof role === 'string' && OWNER_CREDENTIAL_ROLES.includes(role);
}

module.exports = { OWNER_CREDENTIAL_ROLES, isOwnerCredentialRole };
