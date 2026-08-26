'use strict';

// AJUSTE COMERCIAL V1 (DB ledger 118) — canonical economic cancellation.
//
// Before this module, a genuine economic cancellation was a bare PostgREST PATCH from
// agentOrdini.cambiaStato: one row update, its own implicit transaction, and NO obligation  // language-guard: allow-legacy agentOrdini is the existing module filename being cross-referenced, not new vocabulary
// consequence at all. The order stopped counting because a reader filtered it out by
// `estado` — a mutable, unversioned, ungoverned column — which is precisely the mechanism
// the Over-Collected audit indicts.
//
// Cancellation now goes through public.order_cancel_v1, which performs the operational
// state change AND the mandatory obligation revision to 0 inside ONE database transaction.
// There is no intermediate state in which an order reads CANCELADO while still owing 30,
// or owes 0 while not actually cancelled.
//
// THE AUTHORITY DISTINCTION this module preserves: the caller never chooses the resulting
// obligation. There is no amount parameter anywhere in this file or in the RPC — the server
// derives 0 from the cancellation itself. An operator authorised to cancel therefore never
// gains the power to pick an arbitrary new obligation, which stays admin-only through
// mesaService.commercialAdjustment.
//
// IT NEVER CREATES A REFUND. Cancelling an order does not mean the bank returned the money;
// La Dieci controls no settlement rail. The resulting over-collection is NAMED
// (`overCollected`) and resolved later by a real, deliberate refund.

const { sbRpc } = require('../utils/supabase');
const crypto = require('crypto');

// The three states that are genuine ECONOMIC cancellations. CHIUSO_FORZATO is deliberately  // language-guard: allow-legacy CHIUSO_FORZATO is the existing terminal-state literal this slice deliberately keeps OUT of every economic filter, named here as evidence, not new vocabulary
// absent: it is operational ("the table's business ended"), never an economic void — N-1
// removed its only writer and Over-Collected Slice A removed it from every reader's
// cancelled set. Routing a force-close through a commercial adjustment would re-introduce
// exactly the bug this workstream closed.
const ECONOMIC_CANCEL_STATES = new Set(['CANCELADO', 'CANCELLED', 'ANULADO']);

function isEconomicCancellation(estado) {
  return ECONOMIC_CANCEL_STATES.has(String(estado || '').trim().toUpperCase());
}

// Deterministic per order, byte-compatible with buildIdemScopeKey's shape
// (`^[A-Za-z0-9_-]{8,128}$`). One order can only be cancelled once, so the natural
// idempotency scope is the order itself: a retry replays instead of appending a second
// obligation revision.
function buildCancelRequestId(orderId) {
  const cleaned = String(orderId == null ? '' : orderId).replace(/[^A-Za-z0-9_-]/g, '');
  if (cleaned.length === 0) return null;
  return `cancel-order-${cleaned}`.slice(0, 128);
}

function canonicalHash(value) {
  const stable = (input) => {
    if (Array.isArray(input)) return input.map(stable);
    if (input && typeof input === 'object') {
      return Object.fromEntries(Object.keys(input).sort().map((key) => [key, stable(input[key])]));
    }
    return input;
  };
  return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

// The operator's own justification when they gave one. When they did not, this records
// truthfully that the cancellation came from an operator surface without a stated reason —
// it never invents a business justification the operator did not give. `reason` is
// mandatory in the ledger (ofe_reason_chk's precedent, now mirrored on order_obligations)
// precisely so a later audit is never left guessing.
function resolveReason(extras, origin) {
  const supplied = typeof extras?.reason === 'string' ? extras.reason.trim() : '';
  if (supplied) return supplied.slice(0, 500);
  return `Cancelación operativa sin motivo indicado (${String(origin || 'dashboard').slice(0, 60)})`;
}

const RETRYABLE_TRANSPORT = 'ORDER_CANCEL_WRITE_FAILED';

function codeFromRpcBody(body) {
  const raw = body && typeof body.message === 'string' ? body.message.trim() : '';
  return /^(MESA|ORDER|AUTH)_[A-Z0-9_]+$/.test(raw) ? raw : RETRYABLE_TRANSPORT;
}

// Returns {ok:true, result} or {ok:false, code}. Never throws: cambiaStato's contract with
// its callers is a typed result object, and a cancellation that the DB refused must NOT be
// reported to the operator as a successful state change.
async function cancelOrderCanonical({ orderId, targetEstado, extras = {} } = {}) {
  const actor = typeof extras.actor_id === 'string' && extras.actor_id ? extras.actor_id : null;
  // FAIL CLOSED on an unattributable actor. This writer reduces what the restaurant is
  // owed; N-3 set the precedent that a context we cannot verify refuses the operation
  // outright rather than quietly producing a financial fact nobody can be held to.
  if (!actor) return { ok: false, code: 'ORDER_CANCEL_ACTOR_REQUIRED' };

  const clientRequestId = buildCancelRequestId(orderId);
  if (!clientRequestId) return { ok: false, code: 'ORDER_CANCEL_INVALID' };

  const target = String(targetEstado || '').trim().toUpperCase();
  const reason = resolveReason(extras, extras.origin);
  const requestHash = canonicalHash({ orderId: String(orderId), target, reason });

  let response;
  try {
    response = await sbRpc('order_cancel_v1', {
      p_order_id: String(orderId),
      p_by_actor: actor,
      p_reason: reason,
      p_client_request_id: clientRequestId,
      p_request_hash: requestHash,
      p_target_estado: target,
      p_meta: { origin: String(extras.origin || 'dashboard').slice(0, 60) },
    });
  } catch (e) {
    console.warn('[cancelOrderCanonical] transport failure:', e?.message || e);
    return { ok: false, code: RETRYABLE_TRANSPORT };
  }

  if (!response || !response.ok) return { ok: false, code: codeFromRpcBody(response && response.body) };
  return { ok: true, result: response.body || null };
}

module.exports = {
  ECONOMIC_CANCEL_STATES,
  isEconomicCancellation,
  buildCancelRequestId,
  cancelOrderCanonical,
};
