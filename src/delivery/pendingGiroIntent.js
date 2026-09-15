'use strict';
// S4 — Order Canonicalization operator-intent prerequisite (DORMANT).
//
// Builds the ephemeral `pending_giro_intent` payload the future W5 capture
// trigger (candidate SQL: ci/giro-authority-certification/candidate/
// giro_intent_capture_trigger_v1.W5_DORMANT.sql, not yet installed) will
// read from `ordenes.pending_giro_intent` on INSERT. This module only BUILDS
// language-guard: allow-legacy creaOrdine is the existing function name being cited, not new vocabulary
// that payload -- it never writes it: the call site in creaOrdine() (see
// language-guard: allow-legacy agentOrdini.js is the existing file name being cited, not new vocabulary
// agentOrdini.js) forces the real INSERT to pending_giro_intent:null until a
// later, separate, explicitly authorized packet installs the capture trigger.
//
// TRUST. `actor` and `sv` come from req.authCtx -- the DB-verified session
// identity the legacy auth guard builds -- and never from the request body,
// exactly the same rule and the same two fields src/financial/
// initialPaymentIntent.js already enforces for initial_payment_intent. `sv`
// here is the AUTH session_version (req.authCtx.sv) -- it has no relationship
// to GIRO_FACTS_SIGNAL and is never read from or compared against it.
//
// TARGET DISAMBIGUATION. The frontend candidate (body.pending_giro_intent)
// carries an explicit `isGiro` boolean set by the Planner itself (threaded
// through PremiumPlannerPopup.jsx from previewStrategicOpportunities.js's own
// anchor-vs-merged-giro distinction). This module trusts `isGiro` as the sole
// discriminator and never infers target_kind from shape alone: isGiro must be
// strictly true or strictly false, anything else (missing, null, non-boolean)
// is treated as non-actionable.
//
// FAIL OPEN, ALWAYS. Order creation must never depend on this module. There
// is no "refuse" outcome here (unlike buildInitialPaymentIntent, which CAN
// refuse a paid creation): anything uncertain, malformed, or unverifiable
// just normalizes to intent:null, and the whole function is wrapped so it
// can never throw regardless of what `body`/`authCtx` contain.

const MIN_TARGET_REF_LEN = 1;
const MAX_TARGET_REF_LEN = 64;

function isValidTargetRef(ref) {
  return typeof ref === 'string' && ref.length >= MIN_TARGET_REF_LEN && ref.length <= MAX_TARGET_REF_LEN;
}

// The frontend candidate shape: { giroId, anchorOrderId, isGiro, salidaRef, entregaRef }.
// salidaRef/entregaRef are UI-only and never reach the DB contract.
function normalizeCandidate(body) {
  const c = body && typeof body === 'object' && !Array.isArray(body) ? body.pending_giro_intent : null;
  return c && typeof c === 'object' && !Array.isArray(c) ? c : null;
}

// isGiro is advisory input from the Planner, not yet DB-verified -- the future
// capture trigger re-derives and authoritatively checks target existence
// itself. This function's only job is choosing WHICH kind of reference to
// send, never whether it will turn out to be valid.
function resolveTarget(candidate) {
  if (!candidate) return null;
  if (candidate.isGiro === true) {
    const raw = candidate.giroId;
    const ref = raw != null ? String(raw).trim() : '';
    return isValidTargetRef(ref) ? { target_kind: 'GIRO', target_ref: ref } : null;
  }
  if (candidate.isGiro === false) {
    const raw = candidate.anchorOrderId != null ? candidate.anchorOrderId : candidate.giroId;
    const ref = raw != null ? String(raw).trim() : '';
    return isValidTargetRef(ref) ? { target_kind: 'ANCHOR', target_ref: ref } : null;
  }
  // isGiro missing/null/non-boolean: no guessing, no fallback.
  return null;
}

// Builds the ephemeral V1 payload, or null. Never throws -- returns
// { intent: null } for any candidate/authCtx shape this cannot confidently
// build from, including hostile/malformed input.
//
// Returns: { intent: null } | { intent: {v,target_kind,target_ref,source,actor,sv} }
function buildPendingGiroIntentV1({ body, authCtx } = {}) {
  try {
    const target = resolveTarget(normalizeCandidate(body));
    if (!target) return Object.freeze({ intent: null });

    const actor = authCtx && typeof authCtx.actor === 'string' ? authCtx.actor.trim() : '';
    if (actor.length === 0) return Object.freeze({ intent: null });

    const sv = authCtx ? authCtx.sv : null;
    if (!Number.isInteger(sv) || sv < 1) return Object.freeze({ intent: null });

    return Object.freeze({
      intent: Object.freeze({
        v: 1,
        target_kind: target.target_kind,
        target_ref: target.target_ref,
        source: 'operator_http',
        actor,
        sv: String(sv),
      }),
    });
  } catch (_) {
    return Object.freeze({ intent: null });
  }
}

module.exports = { buildPendingGiroIntentV1 };
