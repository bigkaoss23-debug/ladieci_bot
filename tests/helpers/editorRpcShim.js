'use strict';
// POST-ASTRA F5 (+ N1) test shim. Since migration 153 the order editor (agentOrdini writeOrderPatch) writes a patch that moves the
// economic basis through rpc/order_apply_editor_patch_v1 instead of a direct PATCH of ordenes. Unit tests that model the ordenes
// table with an sbUpdate mock keep asserting on the SAME patch through this shim: the RPC's contract for one row is "apply exactly
// this patch to that order, or refuse" -- the compare-and-set and the lock order are proven against the real function on
// PostgreSQL (lab T9 / T18), not here. A refusal body returned by the model is surfaced as the RPC's error body.
// language-guard: allow-legacy agentOrdini is the existing module filename being cross-referenced, not new vocabulary

function withEditorRpc(sbUpdate, fallback = null) {
  return async function sbRpc(fn, args) {
    if (fn !== 'order_apply_editor_patch_v1') {
      if (fallback) return fallback(fn, args);
      throw new Error(`editorRpcShim: unexpected rpc ${fn}`);
    }
    const r = await sbUpdate('ordenes', `id=eq.${encodeURIComponent(args.p_order_id)}`, args.p_patch);
    // The same failure test the backend applies to a direct PATCH result (paidOrderEconomicGuard.isDbWriteFailure).
    const failed = typeof r === 'string' ? r.trim() !== ''
      : Boolean(r && typeof r === 'object' && !Array.isArray(r) && (typeof r.message === 'string' || typeof r.code === 'string'));
    if (!failed) return { ok: true, httpStatus: 200, body: { ok: true, orderId: args.p_order_id, updated: Array.isArray(r) ? r.length : 1 } };
    return { ok: false, httpStatus: 400, body: r };
  };
}

module.exports = { withEditorRpc };
