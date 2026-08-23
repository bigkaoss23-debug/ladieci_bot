"use strict";
// ===============================================================
// serviceCloseAuthority.js — F-10.1B
//
// THE single direct import boundary for the V3 close engine.
//
// WHY THIS EXISTS. F-8 certified that exactly one application module may
// reach serviceLifecycleEngine.js, and enforced it statically
// (tests/lifecycleRuntimeAuthorityP0C1.static.test.js). F-10 legitimately
// added a SECOND close caller — forgotten-close recovery, invoked from the
// order-intake boundary rather than from index.js's Finalizar action — which
// is why this facade exists rather than index.js importing the engine
// directly: both callers went through this one module, so the invariant was
// stronger, not weaker, than allowlisting two direct importers.
//
// O-4 (ledger 108) retired that second caller: O-3 (ledger 107) made an open
// operational_service_v1 unconditional continuity regardless of Business
// Day, so the forgotten-close raise this facade's second caller existed to
// react to could no longer fire, and O-4 deleted forgottenCloseRecovery.js
// along with it. index.js (operator Finalizar) is the sole caller today;
// the facade itself stays, unchanged, so a future second caller can still
// be added here rather than importing the engine directly.
//
//   index.js --- serviceCloseAuthority --- serviceLifecycleEngine
//
// TRANSPORT, NOT A SECOND ENGINE. This module is deliberately transparent: it
// forwards its argument object to the engine untouched and returns the
// engine's result untouched. It holds NO policy of its own — it never chooses
// a close_source, never chooses an actor, never decides whether a service is
// stale, never picks a Business Day, never touches the database itself and
// never calls legacy lifecycle code. Every one of those decisions stays with
// the caller (index.js, for operator Finalizar).
//
// Adding any branching here would recreate the second lifecycle authority
// this whole program has been removing. Keep it boring.
// ===============================================================

const { closeServiceV3 } = require("./serviceLifecycleEngine");

function createServiceCloseAuthority({ engine = closeServiceV3 } = {}) {
  // Forwards the argument object verbatim — no defaults applied here, so the
  // engine's own parameter defaults remain the single source of truth and the
  // pre-F-10.1B call semantics are preserved byte-for-byte.
  return async function closeServiceSessionV3(args) {
    return engine(args);
  };
}

const closeServiceSessionV3 = createServiceCloseAuthority();

module.exports = { createServiceCloseAuthority, closeServiceSessionV3 };
