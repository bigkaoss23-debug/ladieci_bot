'use strict';
// CHECK-CENTRIC UNIVERSAL CASH V1 — src/cash/cashDao.js wiring. Run:
// node tests/checkCentricCashDaoWiring.test.js
// OFFLINE: stubs global.fetch (same technique as tests/mesaDaoRefund.test.js).
// No DB, no network. Proves: (1) each RPC name and its exact parameter key set
// map onto the migration-122 committed signatures, (2) null survives (never
// dropped/coerced), (3) every resource this DAO touches is actually registered
// in supabaseResourcePolicy.js -- an unregistered resource fails closed with
// SUPABASE_RESOURCE_NOT_ALLOWED before ever reaching the network.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://stub.local';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'stub-service-role-key';

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };
const section = (t) => console.log('\n── ' + t + ' ──');

let lastRequest = null;
global.fetch = async (url, init) => {
  lastRequest = { url: String(url), method: (init && init.method) || 'GET', body: init && init.body ? JSON.parse(init.body) : null };
  return {
    ok: true, status: 200,
    text: async () => JSON.stringify(
      lastRequest.method === 'GET' ? [] : { ok: true, idempotent: false, transactionId: 'tx-1' },
    ),
  };
};

const dao = require('../src/cash/cashDao');

(async () => {
  section('order_post_payment_v1');
  await dao.postPayment({
    workspaceId: 'ws-1', byActor: 'operator_1', bySidHash: 'a'.repeat(64),
    orderUid: 'order-uid-1', paymentMethod: 'efectivo', mode: 'custom_amount', amount: 30,
    clientRequestId: 'pay-0001', requestHash: 'b'.repeat(64), meta: { source: 'servicio_dashboard' },
  });
  assert('calls rpc/order_post_payment_v1', /\/rpc\/order_post_payment_v1(\?|$)/.test(lastRequest.url), lastRequest.url);
  assert('POST method', lastRequest.method === 'POST');
  {
    const body = lastRequest.body || {};
    assert('exact parameter key set (no drift from the migration 122 signature)',
      JSON.stringify(Object.keys(body).sort()) === JSON.stringify([
        'p_workspace_id', 'p_by_actor', 'p_by_sid_hash', 'p_order_uid', 'p_payment_method',
        'p_mode', 'p_amount', 'p_client_request_id', 'p_request_hash', 'p_meta', 'p_confirm_duplicate',
      ].sort()), JSON.stringify(Object.keys(body).sort()));
    assert('p_order_uid forwarded (not table_session_id — this is check-centric)', body.p_order_uid === 'order-uid-1');
    assert('no p_table_session_id anywhere in the payload', !('p_table_session_id' in body));
    assert('no p_covers_settled / p_line_ids (no covers, no line selection for Servicio)',
      !('p_covers_settled' in body) && !('p_line_ids' in body));
    assert('p_amount forwarded as a number', body.p_amount === 30);
    assert('p_confirm_duplicate defaults to false, not dropped', body.p_confirm_duplicate === false);
  }

  section('order_post_payment_v1 — amount omitted (full mode) -> null, never dropped');
  await dao.postPayment({
    workspaceId: 'ws-1', byActor: 'operator_1', bySidHash: 'a'.repeat(64),
    orderUid: 'order-uid-1', paymentMethod: 'tarjeta', mode: 'full',
    clientRequestId: 'pay-0002', requestHash: 'c'.repeat(64), meta: {},
  });
  assert('p_amount is explicit null for full mode', lastRequest.body.p_amount === null);

  section('order_post_refund_v1');
  await dao.postRefund({
    workspaceId: 'ws-1', byActor: 'admin_1', bySidHash: 'a'.repeat(64),
    orderUid: 'order-uid-1', originalTransactionId: 'tx-1', reason: 'Error de cobro',
    amount: 10, clientRequestId: 'refund-0001', requestHash: 'd'.repeat(64), meta: {},
  });
  assert('calls rpc/order_post_refund_v1', /\/rpc\/order_post_refund_v1(\?|$)/.test(lastRequest.url), lastRequest.url);
  {
    const body = lastRequest.body || {};
    assert('exact parameter key set', JSON.stringify(Object.keys(body).sort()) === JSON.stringify([
      'p_workspace_id', 'p_by_actor', 'p_by_sid_hash', 'p_order_uid', 'p_original_transaction_id',
      'p_reason', 'p_client_request_id', 'p_request_hash', 'p_amount', 'p_meta',
    ].sort()), JSON.stringify(Object.keys(body).sort()));
    assert('no p_payment_method (method is FORCED from the original transaction, DB-side)', !('p_payment_method' in body));
    assert('no p_table_session_id', !('p_table_session_id' in body));
    assert('p_original_transaction_id forwarded', body.p_original_transaction_id === 'tx-1');
  }

  section('order_apply_commercial_adjustment_v1');
  await dao.postCommercialAdjustment({
    workspaceId: 'ws-1', byActor: 'admin_1', bySidHash: 'a'.repeat(64),
    orderUid: 'order-uid-1', newGross: 60, reason: 'descuento', expectedCurrentGross: 85,
    clientRequestId: 'adj-0001', requestHash: 'e'.repeat(64), meta: {},
  });
  assert('calls rpc/order_apply_commercial_adjustment_v1', /\/rpc\/order_apply_commercial_adjustment_v1(\?|$)/.test(lastRequest.url), lastRequest.url);
  {
    const body = lastRequest.body || {};
    assert('exact parameter key set', JSON.stringify(Object.keys(body).sort()) === JSON.stringify([
      'p_workspace_id', 'p_by_actor', 'p_by_sid_hash', 'p_order_uid', 'p_new_gross', 'p_reason',
      'p_client_request_id', 'p_request_hash', 'p_expected_current_gross', 'p_meta',
    ].sort()), JSON.stringify(Object.keys(body).sort()));
    assert('no p_table_session_id (check-centric, order-scoped only)', !('p_table_session_id' in body));
  }

  section('READ MODEL — every table this DAO reads is registered for GET');
  await dao.getOrderByUid('order-uid-1');
  assert('reads ordenes', /\/ordenes\?/.test(lastRequest.url));
  await dao.listObligations('order-uid-1');
  assert('reads order_obligations', /\/order_obligations\?/.test(lastRequest.url));
  await dao.listFinancialEvents('svc-1', '#1');
  assert('reads order_financial_events', /\/order_financial_events\?/.test(lastRequest.url));
  await dao.listCanonicalTransactions('order-uid-1');
  assert('reads payment_allocations scoped by order_uid', /\/payment_allocations\?.*order_uid=eq\./.test(lastRequest.url));

  section('H1B REGISTRY — no unregistered resource silently used');
  const policy = require('../src/utils/supabaseResourcePolicy');
  const need = [
    'rpc/order_post_payment_v1', 'rpc/order_post_refund_v1', 'rpc/order_apply_commercial_adjustment_v1',
    'ordenes', 'order_obligations', 'order_financial_events', 'payment_transactions', 'payment_allocations',
  ];
  for (const resource of need) {
    const found = policy.REGISTRY.find((e) => e.resource === resource);
    assert(resource + ' is registered', !!found, 'missing from REGISTRY');
    if (found && resource.startsWith('rpc/')) {
      assert(resource + ' allows POST only', JSON.stringify(found.allowedMethods) === JSON.stringify(['POST']));
      assert(resource + ' is FINANCIAL sensitivity', found.sensitivity === 'FINANCIAL');
    }
  }

  console.log('\n═══ RESULT: ' + pass + ' passed, ' + fail + ' failed ═══');
  process.exit(fail === 0 ? 0 : 1);
})();
