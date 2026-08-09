'use strict';
// SERVICE CLOSEOUT V2 / SLICE 4C.2A — proves the RESOURCE-POLICY LAYER (not
// the SQL business logic, already covered by the fake-rpc contract tests in
// tests/closeoutSnapshots.test.js / tests/serviceIncidents.test.js) now lets
// performIncidentSafeRollover's real dependency chain reach the network.
//
// The bug this guards against: closeoutAttempts.js / closeoutSnapshots.js /
// serviceIncidents.js all call the REAL sbRpc/sbSelect by default (only their
// factory functions accept injected fakes, which every existing behavioural
// test uses instead) — so no test before this one ever actually exercised
// src/utils/supabaseResourcePolicy.js for these modules. That gap is exactly
// why the first live staging rollover failed with
// ROLLOVER_ATTEMPT_ACQUIRE_FAILED / "resource is not registered" despite every
// other test suite being green. This file uses the REAL exported singletons
// (closeoutAttempts, closeoutSnapshots, serviceIncidents — default rpc/select,
// i.e. sbRpc/sbSelect) with only global.fetch mocked, exactly like
// tests/supabaseResourcePolicy.test.js's own network boundary — so a
// regression here (someone renaming/removing a registry entry) fails loudly
// again before it ever reaches real staging.

process.env.SUPABASE_URL = 'http://mock.local';
process.env.SUPABASE_KEY = 'mock-service-role-closeout-lifecycle';

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

delete require.cache[require.resolve('../src/utils/supabaseResourcePolicy')];
delete require.cache[require.resolve('../src/utils/supabaseTransport')];
delete require.cache[require.resolve('../src/utils/supabase')];
delete require.cache[require.resolve('../src/closeout/closeoutAttempts')];
delete require.cache[require.resolve('../src/closeout/closeoutSnapshots')];
delete require.cache[require.resolve('../src/incidents/serviceIncidents')];

const { closeoutAttempts } = require('../src/closeout/closeoutAttempts');
const { closeoutSnapshots } = require('../src/closeout/closeoutSnapshots');
const { serviceIncidents } = require('../src/incidents/serviceIncidents');

// Minimal, realistic per-RPC/table response bodies — shape-matched to the
// actual SQL functions in migrations/2026-08-08_service_closeout_*.sql, just
// enough for the wrapper modules' own normalize()/publicX() to succeed. This
// file does not re-prove SQL semantics (idempotency, dedupe, etc.) — only
// that the request reaches this mocked network layer at all.
function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

global.fetch = async (url, opts) => {
  const method = opts.method;
  if (url.includes('/rpc/acquire_closeout_attempt')) {
    return jsonResponse(200, {
      ok: true, code: 'ACQUIRED', created: true,
      attempt: { closeout_correlation_id: 'attempt-1', service_session_id: 'sess-1', status: 'active', started_at: new Date().toISOString(), created_by: 'system' },
    });
  }
  if (url.includes('/rpc/capture_closeout_snapshot')) {
    return jsonResponse(200, {
      ok: true, code: 'CAPTURED', created: true,
      snapshot: { id: 'snap-1', service_session_id: 'sess-1', business_date: '2026-08-09', service_kind: 'PRANZO', closeout_correlation_id: 'attempt-1', schema_version: 1, captured_at: new Date().toISOString(), captured_by: 'system', source: 'test', payload: {}, payload_sha256: null },
    });
  }
  if (url.includes('/rpc/create_service_incident')) {
    return jsonResponse(200, {
      ok: true, code: 'RECORDED', created: true,
      incident: { id: 'inc-1', service_session_id: 'sess-1', business_date: '2026-08-09', service_kind: 'PRANZO', closeout_correlation_id: 'attempt-1', incident_type: 'UNPAID_BALANCE_AT_CLOSE', category: 'financial', severity: 'warning', detected_at: new Date().toISOString(), detected_by: 'system', resolution_status: 'pending' },
    });
  }
  if (url.includes('/rpc/supersede_closeout_attempt')) {
    return jsonResponse(200, {
      ok: true, code: 'SUPERSEDED', idempotent: false,
      attempt: { closeout_correlation_id: 'attempt-1', service_session_id: 'sess-1', status: 'superseded', started_at: new Date().toISOString(), superseded_at: new Date().toISOString(), created_by: 'system' },
    });
  }
  if (url.includes('/rpc/complete_closeout_attempt')) {
    return jsonResponse(200, {
      ok: true, code: 'COMPLETED', idempotent: false,
      attempt: { closeout_correlation_id: 'attempt-1', service_session_id: 'sess-1', status: 'completed', started_at: new Date().toISOString(), completed_at: new Date().toISOString(), created_by: 'system' },
    });
  }
  if (url.includes('/service_closeout_snapshots')) {
    return jsonResponse(200, []); // GET — no existing snapshot for this correlation id
  }
  // Any resource not mocked above (e.g. a resolve_service_incident call this
  // suite never expects to make) surfaces as a loud fetch-shape failure
  // rather than a silent false-positive pass.
  throw new Error('UNEXPECTED_FETCH_CALL: ' + method + ' ' + url);
};

(async () => {
  console.log('\n== closeout lifecycle — real transport reaches the resource-policy-gated network ==\n');

  console.log('\n── the exact 5 RPCs performIncidentSafeRollover calls, via the REAL (non-injected) wrappers ──');
  {
    const acquireResult = await closeoutAttempts.acquire({ serviceSessionId: 'sess-1', actor: 'system' });
    assert('1a: closeoutAttempts.acquire() (real sbRpc) succeeds — was ROLLOVER_ATTEMPT_ACQUIRE_FAILED before this fix', acquireResult.success === true, JSON.stringify(acquireResult));
    assert('1b: acquire() returns the expected correlation id', acquireResult.attempt && acquireResult.attempt.closeoutCorrelationId === 'attempt-1');
  }
  {
    const existing = await closeoutSnapshots.getByCorrelationId({ closeoutCorrelationId: 'attempt-1' });
    assert('2a: closeoutSnapshots.getByCorrelationId() (real sbSelect) succeeds, no existing snapshot', existing === null);
  }
  {
    const captureResult = await closeoutSnapshots.capture({
      serviceSessionId: 'sess-1', closeoutCorrelationId: 'attempt-1', capturedBy: 'system', source: 'test', payload: {},
    });
    assert('3a: closeoutSnapshots.capture() (real sbRpc) succeeds', captureResult.success === true, JSON.stringify(captureResult));
  }
  {
    const reportResult = await serviceIncidents.report({
      serviceSessionId: 'sess-1', closeoutCorrelationId: 'attempt-1', incidentType: 'UNPAID_BALANCE_AT_CLOSE',
      category: 'financial', severity: 'warning', detectedBy: 'system', financialExposureCents: 5750,
    });
    assert('4a: serviceIncidents.report() (real sbRpc) succeeds', reportResult.success === true, JSON.stringify(reportResult));
  }
  {
    const supersedeResult = await closeoutAttempts.supersede({ closeoutCorrelationId: 'attempt-1', actor: 'system', reason: 'state_drift_detected' });
    assert('5a: closeoutAttempts.supersede() (real sbRpc) succeeds', supersedeResult.success === true, JSON.stringify(supersedeResult));
  }
  {
    const completeResult = await closeoutAttempts.complete({ closeoutCorrelationId: 'attempt-1', actor: 'system' });
    assert('6a: closeoutAttempts.complete() (real sbRpc) succeeds', completeResult.success === true, JSON.stringify(completeResult));
  }

  console.log('\n── resources deliberately left unregistered still fail, even through the real wrapper ──');
  // Neither wrapper catches the transport's thrown SupabaseTransportError
  // (normalize() only handles a resolved {ok,body} shape) — an unregistered
  // resource therefore surfaces as a REJECTED promise here, exactly the shape
  // performIncidentSafeRollover's own try/catch is written to convert into
  // its ROLLOVER_*_FAILED results. This mirrors the real failure observed on
  // staging, not a hypothetical one.
  {
    const { serviceIncidents: si } = require('../src/incidents/serviceIncidents');
    let threw = null;
    try { await si.resolve({ incidentId: 'inc-1', resolvedBy: 'admin', role: 'admin', resolutionType: 'manual_review' }); }
    catch (e) { threw = e; }
    assert('7a: serviceIncidents.resolve() (rpc/resolve_service_incident, not registered) throws resource-not-registered, never silently succeeds',
      threw && threw.code === 'SUPABASE_RESOURCE_NOT_ALLOWED', String(threw));
  }
  {
    const { archivedOrderFinancialResolutions } = require('../src/closeout/archivedOrderFinancialResolutions');
    let threw = null;
    try {
      await archivedOrderFinancialResolutions.record({
        serviceSessionId: 'sess-1', archivedOrderId: '#001', relatedIncidentId: 'inc-1', actionCorrelationId: 'action-1',
        resolutionType: 'write_off', amountCents: 1600, actor: 'admin', role: 'admin', reason: 'test',
      });
    } catch (e) { threw = e; }
    assert('7b: archivedOrderFinancialResolutions.record() (not registered) throws resource-not-registered, never silently succeeds',
      threw && threw.code === 'SUPABASE_RESOURCE_NOT_ALLOWED', String(threw));
  }

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  delete global.fetch;
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log('  FATAL  ' + (e && e.stack || e));
  delete global.fetch;
  process.exit(1);
});
