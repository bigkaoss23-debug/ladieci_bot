'use strict';
// SERVICE LIFECYCLE V3 / Slice 3.2 — proves the RESOURCE-POLICY LAYER (not the
// SQL business logic, already covered by the fake-rpc contract tests in
// tests/serviceLifecycleV3CloseEngine.test.js) lets the V3.2 close engine's
// real dependency chain reach the network. Same rationale and pattern as
// tests/closeoutLifecycleResourcePolicyIntegration.test.js (the V2 sibling of
// this file, born from the exact same class of staging failure: a DAO's
// default `rpc = sbRpc` is invisible to the literal-string scanner in
// tests/supabaseResourcePolicy.test.js check #17, so only a real-transport
// test like this one actually proves the registry entry works).

process.env.SUPABASE_URL = 'http://mock.local';
process.env.SUPABASE_KEY = 'mock-service-role-v3-close-engine';

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

delete require.cache[require.resolve('../src/utils/supabaseResourcePolicy')];
delete require.cache[require.resolve('../src/utils/supabaseTransport')];
delete require.cache[require.resolve('../src/utils/supabase')];
delete require.cache[require.resolve('../src/closeout/serviceCloseoutCreation')];
delete require.cache[require.resolve('../src/serviceSessions/serviceLifecycleV3Transition')];
delete require.cache[require.resolve('../src/closeout/serviceCloseouts')];
delete require.cache[require.resolve('../src/closeout/closeoutAttempts')];

const { serviceCloseoutCreation } = require('../src/closeout/serviceCloseoutCreation');
const { serviceLifecycleV3Transition } = require('../src/serviceSessions/serviceLifecycleV3Transition');
// SLICE 3.2.1 — the retry-lineage check's two real (non-DI) GET readers.
const { serviceCloseouts } = require('../src/closeout/serviceCloseouts');
const { closeoutAttempts } = require('../src/closeout/closeoutAttempts');

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

global.fetch = async (url, opts) => {
  const method = opts.method;
  if (url.includes('/rpc/create_service_closeout')) {
    return jsonResponse(200, {
      ok: true, code: 'CREATED', created: true,
      closeout: {
        id: 'co-1', service_session_id: 'sess-1', closeout_correlation_id: 'attempt-1',
        business_date: '2026-08-09', service_kind: 'SERA',
        opened_at: '2026-08-09T18:00:00Z', closed_at: new Date().toISOString(),
        close_source: 'test', close_reason: null, closed_by: 'system',
        gross_sales_cents: 1000, net_sales_cents: 1000, total_discounts_cents: 0, total_refunds_cents: 0, total_void_cents: 0,
        paid_amount_cents: 1000, unpaid_exposure_cents: 0, order_count: 1,
        cash_amount_cents: 1000, card_amount_cents: 0, bizum_amount_cents: 0, other_amount_cents: 0,
        open_orders_at_close: 0, occupied_tables_at_close: 0, kitchen_pending_count: 0, listo_count: 0,
        delivery_pending_count: 0, incident_count: 0, critical_incident_count: 0,
        created_at: new Date().toISOString(),
      },
    });
  }
  if (url.includes('/rpc/close_service_session_v3')) {
    return jsonResponse(200, {
      ok: true, code: 'V3_CLOSED', idempotent: false,
      session: {
        id: 'sess-1', business_date: '2026-08-09', status: 'closed', service_kind: 'SERA',
        opened_at: '2026-08-09T18:00:00Z', closed_at: new Date().toISOString(),
        opened_by: 'system', closed_by: 'system', open_source: 'auto_entry', close_source: 'test', close_reason: null,
      },
    });
  }
  // SLICE 3.2.1 — the retry-lineage check's two real GET readers, plain
  // PostgREST table SELECTs (not RPCs) — see src/utils/supabase.js's
  // sbSelect(): GET {base}/rest/v1/{table}?select=*&{query}.
  if (method === 'GET' && url.includes('/rest/v1/service_closeouts')) {
    return jsonResponse(200, [{
      id: 'co-1', service_session_id: 'sess-1', closeout_correlation_id: 'attempt-1',
      business_date: '2026-08-09', service_kind: 'SERA',
      opened_at: '2026-08-09T18:00:00Z', closed_at: new Date().toISOString(),
      close_source: 'test', close_reason: null, closed_by: 'system',
      gross_sales_cents: 1000, net_sales_cents: 1000, total_discounts_cents: 0, total_refunds_cents: 0, total_void_cents: 0,
      paid_amount_cents: 1000, unpaid_exposure_cents: 0, order_count: 1,
      cash_amount_cents: 1000, card_amount_cents: 0, bizum_amount_cents: 0, other_amount_cents: 0,
      open_orders_at_close: 0, occupied_tables_at_close: 0, kitchen_pending_count: 0, listo_count: 0,
      delivery_pending_count: 0, incident_count: 0, critical_incident_count: 0,
      created_at: new Date().toISOString(),
    }]);
  }
  if (method === 'GET' && url.includes('/rest/v1/service_closeout_attempts')) {
    return jsonResponse(200, [{
      closeout_correlation_id: 'attempt-1', service_session_id: 'sess-1', status: 'completed',
      started_at: '2026-08-09T22:00:00Z', completed_at: '2026-08-09T23:00:00Z',
      superseded_at: null, supersession_reason: null, created_by: 'system',
    }]);
  }
  throw new Error('UNEXPECTED_FETCH_CALL: ' + method + ' ' + url);
};

(async () => {
  console.log('\n== V3.2 close engine — real transport reaches the resource-policy-gated network ==\n');

  console.log('\n── the exact 2 new RPCs serviceLifecycleEngine.js calls, via the REAL (non-injected) wrappers ──');
  {
    const createResult = await serviceCloseoutCreation.create({
      serviceSessionId: 'sess-1', closeoutCorrelationId: 'attempt-1', closedBy: 'system', source: 'test',
      grossSalesCents: 1000, netSalesCents: 1000, paidAmountCents: 1000, unpaidExposureCents: 0, orderCount: 1,
      cashAmountCents: 1000, occupiedTablesAtClose: 0,
    });
    assert('1a: serviceCloseoutCreation.create() (real sbRpc) succeeds', createResult.success === true, JSON.stringify(createResult));
    assert('1b: create() returns the expected correlation id', createResult.closeout && createResult.closeout.closeoutCorrelationId === 'attempt-1');
  }
  {
    const closeResult = await serviceLifecycleV3Transition.close({
      serviceSessionId: 'sess-1', closeoutCorrelationId: 'attempt-1', actor: 'system', source: 'test',
    });
    assert('2a: serviceLifecycleV3Transition.close() (real sbRpc) succeeds', closeResult.success === true, JSON.stringify(closeResult));
    assert('2b: close() returns the session as closed', closeResult.session && closeResult.session.status === 'closed');
  }

  console.log('\n── SLICE 3.2.1 — the retry-lineage check\'s two real (non-DI) GET readers ──');
  {
    const closeout = await serviceCloseouts.getBySessionId({ serviceSessionId: 'sess-1' });
    assert('3a: serviceCloseouts.getBySessionId() (real sbSelect) succeeds', closeout !== null, JSON.stringify(closeout));
    assert('3b: getBySessionId() returns the expected correlation id', closeout && closeout.closeoutCorrelationId === 'attempt-1');
  }
  {
    const attempt = await closeoutAttempts.getByCorrelationId({ closeoutCorrelationId: 'attempt-1' });
    assert('4a: closeoutAttempts.getByCorrelationId() (real sbSelect) succeeds', attempt !== null, JSON.stringify(attempt));
    assert('4b: getByCorrelationId() returns the expected status', attempt && attempt.status === 'completed');
  }

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  delete global.fetch;
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log('  FATAL  ' + ((e && e.stack) || e));
  delete global.fetch;
  process.exit(1);
});
