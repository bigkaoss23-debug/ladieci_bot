'use strict';
// Access Control V3 — Block V3-D: dynamic access-user identity contract (FOUNDATION
// ONLY, UNWIRED). Pure logic, no env, no I/O, no DB.
//
// auth_actors.actor is valid for exactly two shapes after V3-D: one of the 4 fixed
// legacy identifiers (frozen forever — never reused for a dynamic user), or a canonical
// UUID text form generated server-side by gen_random_uuid()::text. The client never
// chooses or submits an actor id for a new user; this module only classifies/validates
// an id it is handed, it never generates one (generation happens in SQL).

const LEGACY_ACTOR_IDS = Object.freeze(['owner', 'operator_primary', 'operator_backup', 'rider']);
const LEGACY_ACTOR_ID_SET = new Set(LEGACY_ACTOR_IDS);

// Same canonical-lowercase-UUID pattern used elsewhere in this codebase
// (recoveryWindow.js, the pin-rotation V3 DAO) — matches exactly what
// gen_random_uuid()::text produces, nothing looser.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isLegacyActorId(actor) {
  return typeof actor === 'string' && LEGACY_ACTOR_ID_SET.has(actor);
}

function isDynamicActorId(actor) {
  return typeof actor === 'string' && UUID_RE.test(actor);
}

function isValidActorId(actor) {
  return isLegacyActorId(actor) || isDynamicActorId(actor);
}

module.exports = { LEGACY_ACTOR_IDS, UUID_RE, isLegacyActorId, isDynamicActorId, isValidActorId };
