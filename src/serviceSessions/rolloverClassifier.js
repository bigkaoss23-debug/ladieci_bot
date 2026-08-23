"use strict";
// ===============================================================
// rolloverClassifier.js
//
// N-2 — the classifier/fingerprint pair this file used to hold
// (classifyForIncidentSafeRollover, computeStateFingerprint) was the
// incident-safe rollover orchestrator's own logic (incidentSafeRollover.js);
// both were deleted in the application-wide legacy/dead-code purge once that
// orchestrator was proven to have zero reachable production callers (V3's
// serviceLifecycleEngine.js + F-10's forgottenCloseRecovery.js never used
// them — both go through the V3 engine exclusively).
//
// What survives here is the one export other live modules still depend on:
// the terminal-order-state set, shared with currentOperationalSession.js so
// "is this order still operationally active" has a single definition.
// ===============================================================

// Mirrors the terminal estado set every close/read path in this codebase
// agrees on — "done, cancelled, or force-closed, one way or another" —
// language-guard: allow-legacy CHIUSO_FORZATO is the existing terminal-state literal this set already includes below, not new vocabulary
// including historical CHIUSO_FORZATO rows (required legacy read
// compatibility: old force-closed orders must still read as terminal).
const TERMINAL_ORDER_STATES = new Set([
  "RETIRADO", "COMPLETADO", "COMPLETATO", "CANCELADO",
  "CANCELLED", "ANULADO", "CHIUSO_FORZATO",
]);

module.exports = {
  TERMINAL_ORDER_STATES,
};
