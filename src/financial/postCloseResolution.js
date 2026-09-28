'use strict';
// POST-ASTRA F1 -- the backend adapter of the POST-CLOSE ECONOMIC RESOLUTION FACT (migration 152,
// order_post_close_obligation_resolution_v1).
//
// Migration 151 refuses every obligation revision of an order whose service is no longer open (ORDER_ECONOMIC_SERVICE_CLOSED): a closed
// service's closeout is frozen and its sale facts must not be rewritten. The legitimate business events that still happen after the close --
// a delivery that outlived Finalizar and failed, a pickup nobody collected, a complaint refunded the next day -- are recorded HERE, as an
// append-only, typed post-close fact (source order_post_close_resolution_v1, with its own cause / reason / actor / request id and the
// service open when it was recorded), never as a rewrite. The database only accepts it for an order whose service is no longer open, so the
// ordinary 151 path is never bypassed: callers reach this module ONLY after that path refused with ORDER_ECONOMIC_SERVICE_CLOSED, with the
// SAME client request id and request hash (a retry of either path is idempotent on that key).

const { sbRpc } = require('../utils/supabase');

const POST_CLOSE_RPC = 'order_post_close_obligation_resolution_v1';
const TRANSPORT_FAILURE = 'ORDER_POST_CLOSE_WRITE_FAILED';

function codeFromBody(body) {
  const raw = body && typeof body.message === 'string' ? body.message.trim() : '';
  return /^(MESA|ORDER|AUTH)_[A-Z0-9_]+$/.test(raw) ? raw : TRANSPORT_FAILURE;
}

// Cancellation after the close: the obligation goes to 0 and estado to the cancel state, in ONE transaction.
async function resolvePostCloseCancellation({ orderUid, byActor, reason, clientRequestId, requestHash, targetEstado } = {}) {
  if (!orderUid || !byActor || !clientRequestId || !requestHash) return { ok: false, code: 'ORDER_POST_CLOSE_INVALID' };
  let response;
  try {
    response = await sbRpc(POST_CLOSE_RPC, {
      p_order_uid: orderUid,
      p_by_actor: byActor,
      p_new_gross: 0,
      p_cause: 'order_cancellation',
      p_reason: reason,
      p_client_request_id: clientRequestId,
      p_request_hash: requestHash,
      p_target_estado: targetEstado,
    });
  } catch (e) {
    console.warn('[postCloseResolution] transport failure:', e?.message || e);
    return { ok: false, code: TRANSPORT_FAILURE };
  }
  if (!response || !response.ok || !response.body || response.body.ok !== true) {
    return { ok: false, code: codeFromBody(response && response.body) };
  }
  return { ok: true, result: response.body };
}

module.exports = { POST_CLOSE_RPC, resolvePostCloseCancellation, codeFromBody };
