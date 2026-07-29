'use strict';
// Access Control V3 — Block V3-A: fingerprint key retirement/compromise contract
// (FOUNDATION ONLY, UNWIRED). Pure logic, no env, no I/O, no DB, no secrets. Expresses
// the retirement precondition and the compromised-vs-graceful key eligibility rules as
// executable code so they can be unit-tested now, ahead of the real HMAC/DB wiring in a
// later phase. This module makes NO production behavior change in V3-A — nothing calls
// it, no runtime login/rotation path is affected.

// A key's lifecycle state. 'compromised' is deliberately NOT a variant of 'previous' —
// it must never be treated as gracefully-accepted-but-deprecated.
const KEY_STATUSES = Object.freeze(['current', 'previous_accepted', 'compromised', 'retired']);

// keyEligibility(status) -> { lookup, write }
//   lookup: may this key be used to resolve a login candidate?
//   write : may this key receive a NEW or refreshed fingerprint row (dual-write during a
//           graceful rotation, or the sole write target when current)?
// A compromised key returns { lookup:false, write:false } — both flip to false
// IMMEDIATELY, unlike 'previous_accepted' which keeps lookup:true (fallback) and
// write:true (dual-write) for as long as it is still gracefully accepted.
function keyEligibility(status) {
  switch (status) {
    case 'current': return Object.freeze({ lookup: true, write: true });
    case 'previous_accepted': return Object.freeze({ lookup: true, write: true });
    case 'compromised': return Object.freeze({ lookup: false, write: false });
    case 'retired': return Object.freeze({ lookup: false, write: false });
    default: return Object.freeze({ lookup: false, write: false }); // unknown status -> fail closed
  }
}

// canRetireKey({actors, keyId}) -> boolean
//   actors: [{ actor, active, pinConfigured, fingerprintKeyIds: [keyId, ...] }]
//   A key may retire ONLY when EVERY actor with a configured PIN (pinHash present) —
//   ACTIVE OR INACTIVE, including the owner, including a still-unresolved
//   legacy_operator row — already holds a fingerprint under the key being retired.
//   There is NO active-only filter: an inactive actor's reserved PIN still counts,
//   because the workspace-wide (not partial-active) fingerprint uniqueness constraint
//   means their row is still a real, live reservation.
function canRetireKey({ actors, keyId } = {}) {
  if (!Array.isArray(actors) || typeof keyId !== 'string' || keyId.length === 0) return false;
  const configured = actors.filter((a) => a && a.pinConfigured === true);
  if (configured.length === 0) return true; // nothing to cover -> vacuously retirable
  return configured.every((a) => Array.isArray(a.fingerprintKeyIds) && a.fingerprintKeyIds.includes(keyId));
}

// Convenience: the actors still blocking retirement, for a progress/migration report.
function actorsBlockingRetirement({ actors, keyId } = {}) {
  if (!Array.isArray(actors) || typeof keyId !== 'string') return Object.freeze([]);
  return Object.freeze(
    actors
      .filter((a) => a && a.pinConfigured === true)
      .filter((a) => !Array.isArray(a.fingerprintKeyIds) || !a.fingerprintKeyIds.includes(keyId))
      .map((a) => a.actor)
  );
}

module.exports = { KEY_STATUSES, keyEligibility, canRetireKey, actorsBlockingRetirement };
