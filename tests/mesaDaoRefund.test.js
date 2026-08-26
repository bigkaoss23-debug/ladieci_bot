'use strict';
// REFUND V1 SLICE A — mesaDao.postRefund wiring. Run: node tests/mesaDaoRefund.test.js
// OFFLINE: stubs global.fetch (same technique as tests/supabaseResourcePolicy.test.js).
// No DB, no network. Proves: (1) the RPC name and every parameter key/value map
// exactly onto mesa_post_refund_v1's committed signature, (2) amount:null survives
// (not dropped, not coerced to 0/undefined), (3) the resource is actually registered
// in supabaseResourcePolicy.js -- an unregistered resource fails closed with
// SUPABASE_RESOURCE_NOT_ALLOWED before ever reaching the network (see
// backend-new-table-h1b-registry-step).

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://stub.local';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'stub-service-role-key';

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

let lastRequest = null;
global.fetch = async (url, init) => {
  lastRequest = { url: String(url), method: (init && init.method) || 'GET', body: init && init.body ? JSON.parse(init.body) : null };
  return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, idempotent: false, refundTransactionId: 'rt-1' }) };
};

const dao = require('../src/tables/mesaDao');

(async () => {
  await dao.postRefund({
    workspaceId: 'ws-1', byActor: 'admin', bySidHash: 'a'.repeat(64),
    tableSessionId: 'ts-1', originalTransactionId: 'pt-1',
    amount: 10.5, reason: 'Error de importe',
    clientRequestId: 'refund-0001', requestHash: 'b'.repeat(64),
    meta: { source: 'mesa_dashboard' },
  });

  assert('calls rpc/mesa_post_refund_v1', /\/rpc\/mesa_post_refund_v1(\?|$)/.test(lastRequest.url), lastRequest.url);
  assert('POST method', lastRequest.method === 'POST');
  const body = lastRequest.body || {};
  assert('exact parameter key set (no drift from the committed SQL signature)',
    JSON.stringify(Object.keys(body).sort()) === JSON.stringify([
      'p_amount', 'p_by_actor', 'p_by_sid_hash', 'p_client_request_id', 'p_meta',
      'p_original_transaction_id', 'p_reason', 'p_request_hash', 'p_table_session_id', 'p_workspace_id',
    ].sort()),
    JSON.stringify(Object.keys(body).sort()));
  assert('p_workspace_id forwarded', body.p_workspace_id === 'ws-1');
  assert('p_by_actor forwarded', body.p_by_actor === 'admin');
  assert('p_by_sid_hash forwarded', body.p_by_sid_hash === 'a'.repeat(64));
  assert('p_table_session_id forwarded', body.p_table_session_id === 'ts-1');
  assert('p_original_transaction_id forwarded', body.p_original_transaction_id === 'pt-1');
  assert('p_amount forwarded as a number, not a string', body.p_amount === 10.5);
  assert('p_reason forwarded', body.p_reason === 'Error de importe');
  assert('p_client_request_id forwarded', body.p_client_request_id === 'refund-0001');
  assert('p_request_hash forwarded', body.p_request_hash === 'b'.repeat(64));
  assert('p_meta forwarded', JSON.stringify(body.p_meta) === JSON.stringify({ source: 'mesa_dashboard' }));
  // Deliberately absent from the signature (contract §8/§L) -- proves no drift
  // toward a payment-writer-shaped call.
  assert('no p_payment_method (method is forced from the original transaction, DB-side)', !('p_payment_method' in body));
  assert('no p_line_ids', !('p_line_ids' in body));
  assert('no p_covers_settled', !('p_covers_settled' in body));
  assert('no p_confirm_duplicate', !('p_confirm_duplicate' in body));

  // amount omitted entirely -> null (full refundable remainder), never dropped/undefined.
  await dao.postRefund({
    workspaceId: 'ws-1', byActor: 'admin', bySidHash: 'a'.repeat(64),
    tableSessionId: 'ts-1', originalTransactionId: 'pt-1',
    reason: 'Cobro duplicado', clientRequestId: 'refund-0002', requestHash: 'c'.repeat(64),
  });
  assert('omitted amount maps to explicit null', lastRequest.body.p_amount === null);
  assert('omitted meta defaults to {}', JSON.stringify(lastRequest.body.p_meta) === '{}');

  console.log('\nmesaDaoRefund: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})();
