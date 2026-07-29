'use strict';
// Access Control V3 — Block V3-C: transitional role semantics (FOUNDATION ONLY,
// UNWIRED). Pure logic, no env, no I/O, no DB. Separates the DATABASE role
// (auth_actors.role — whatever auth_actors_role_chk currently accepts) from the
// CANONICAL V3 role (roleRegistry.ROLE_CODES) the eventual Gestión de accesos UI and
// V3-D APIs reason about.
//
// This is a READ-TIME mapping only — it never writes auth_actors.role. The actual
// per-row CONVERSION (an explicit owner decision) is what auth_change_actor_role_v3
// performs; this module only tells you what a given database value MEANS today.

const { ROLE_SET } = require('./roleRegistry');

// admin/operator are the two legacy database values NOT in roleRegistry's 7 V3 codes.
// Every other accepted database value (the 7 V3 codes themselves, since V3-A's CHECK
// widened to their union) already IS its own canonical form — mapped to itself, not
// reinterpreted. 'operator' maps to 'legacy_operator', NEVER to 'cashier' or 'waiter':
// which specific V3 role an operator becomes is exclusively an explicit owner decision
// via auth_change_actor_role_v3, never an automatic inference from the legacy value.
const DB_TO_CANONICAL = Object.freeze({
  admin: 'owner',
  operator: 'legacy_operator',
  rider: 'rider',
  owner: 'owner',
  cashier: 'cashier',
  waiter: 'waiter',
  kitchen: 'kitchen',
  shift_manager: 'shift_manager',
  legacy_operator: 'legacy_operator',
});

// canonicalRoleForDbRole(dbRole) -> one of roleRegistry.ROLE_CODES, or null.
// Unknown/unrecognized database values fail closed (null), never a guess.
function canonicalRoleForDbRole(dbRole) {
  if (typeof dbRole !== 'string' || dbRole.length === 0) return null;
  const mapped = DB_TO_CANONICAL[dbRole];
  if (!mapped) return null;
  if (!ROLE_SET.has(mapped)) return null; // defensive: mapped value must be a real V3 code
  return mapped;
}

// The ONLY roles auth_change_actor_role_v3 may assign. Deliberately excludes:
//   admin, operator   — legacy database values, never a write target;
//   owner             — a distinct, non-assignable surface (never via this RPC);
//   legacy_operator   — a transitional READ label, not something you assign TO; an
//                       actor becomes legacy_operator only by starting there (mapped
//                       from a pre-existing 'operator' row), never by explicit choice.
const ASSIGNABLE_ROLES = Object.freeze(['cashier', 'waiter', 'kitchen', 'rider', 'shift_manager']);
const ASSIGNABLE_ROLE_SET = new Set(ASSIGNABLE_ROLES);

function isAssignableRole(role) {
  return typeof role === 'string' && ASSIGNABLE_ROLE_SET.has(role);
}

module.exports = {
  DB_TO_CANONICAL, ASSIGNABLE_ROLES,
  canonicalRoleForDbRole, isAssignableRole,
};
