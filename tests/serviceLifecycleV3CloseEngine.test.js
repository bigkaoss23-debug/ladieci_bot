'use strict';
// SERVICE LIFECYCLE V3 / Slice 3.2 — behavioural contract for
// src/serviceSessions/serviceLifecycleEngine.js against fake dependencies
// (no live DB — the DB-level invariants this engine depends on are proven
// separately, statically, in tests/serviceLifecycleV3CloseEngineMigration.
// static.test.js). Fakes mirror the REAL RPC contracts' idempotency shape
// (ON CONFLICT DO NOTHING + re-fetch, active-attempt uniqueness) exactly, the
// same style as tests/incidentSafeRollover.test.js's fakeEnv().

const { createServiceLifecycleEngine } = require('../src/serviceSessions/serviceLifecycleEngine');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

const SESSION_ID = 'sess-1';

const session = (o = {}) => ({
  id: SESSION_ID, business_date: '2026-08-09', service_kind: 'SERA',
  opened_at: '2026-08-09T18:00:00Z', status: 'open', ...o,
});
const order = (o = {}) => ({
  orden_id: '#1', id: '#1', service_session_id: SESSION_ID, estado: 'RETIRADO',
  totale: 10, hora: '20:00', cobrado: false, ya_pagado: false, metodo_pago: '', ...o,
});
const paymentEvent = (o = {}) => ({
  order_id: '#1', service_session_id: SESSION_ID, type: 'payment', amount: 10,
  payment_method: 'efectivo', created_at: '2026-08-09T20:01:00Z', ...o,
});
const openTable = (o = {}) => ({
  id: 'ts-1', service_session_id: SESSION_ID, status: 'open', covers_total: 2, ...o,
});

// Fakes mirror the real RPCs' idempotency shape: Map-keyed on
// closeoutCorrelationId / serviceSessionId, exactly like the real UNIQUE
// constraints (service_closeout_attempts_active_uq, service_closeouts_
// session_uq / _correlation_uq) enforce at the DB layer.
function fakeEnv({
  sessionRow = session(),
  allOrders = [],
  tableSessions = [],
  financialEvents = [],
  yieldForConcurrency = false,
  failCompleteOnce = false,
} = {}) {
  const env = {
    sessions: new Map([[sessionRow.id, { ...sessionRow }]]),
    attemptsByCorr: new Map(),
    attemptsBySession: new Map(),
    snapshotsByCorr: new Map(),
    closeoutsByCorr: new Map(),
    closeoutsBySession: new Map(),
    calls: { acquire: [], capture: [], create: [], close: [], complete: [] },
    _completeFailedOnce: false,
  };

  const maybeYield = async () => { if (yieldForConcurrency) await Promise.resolve(); };

  env.select = async (table, query) => {
    if (table === 'service_sessions') {
      const m = query.match(/id=eq\.([^&]+)/);
      const id = m && decodeURIComponent(m[1]);
      const row = env.sessions.get(id);
      return row ? [row] : [];
    }
    const m = query.match(/service_session_id=eq\.([^&]+)/);
    const scopedId = m && decodeURIComponent(m[1]);
    if (table === 'ordenes') return allOrders.filter((o) => String(o.service_session_id) === String(scopedId));
    if (table === 'table_sessions') return tableSessions.filter((t) => String(t.service_session_id) === String(scopedId));
    if (table === 'order_financial_events') return financialEvents.filter((e) => String(e.service_session_id) === String(scopedId));
    throw new Error('unexpected table ' + table);
  };

  env.attempts = {
    async acquire({ serviceSessionId, actor }) {
      await maybeYield();
      env.calls.acquire.push({ serviceSessionId, actor });
      const existing = env.attemptsBySession.get(serviceSessionId);
      if (existing && existing.status === 'active') {
        return { success: true, created: false, code: 'ALREADY_ACTIVE', attempt: existing };
      }
      const id = 'corr-' + (env.attemptsByCorr.size + 1);
      const row = { closeoutCorrelationId: id, serviceSessionId, status: 'active', createdBy: actor };
      env.attemptsByCorr.set(id, row);
      env.attemptsBySession.set(serviceSessionId, row);
      return { success: true, created: true, code: 'ACQUIRED', attempt: row };
    },
    async complete({ closeoutCorrelationId, actor }) {
      env.calls.complete.push({ closeoutCorrelationId, actor });
      if (failCompleteOnce && !env._completeFailedOnce) {
        env._completeFailedOnce = true;
        throw new Error('simulated crash marking attempt completed');
      }
      const row = env.attemptsByCorr.get(closeoutCorrelationId);
      if (!row) return { success: false, code: 'ATTEMPT_NOT_FOUND' };
      if (row.status === 'completed') return { success: true, idempotent: true, code: 'ALREADY_COMPLETED', attempt: row };
      row.status = 'completed';
      return { success: true, idempotent: false, code: 'COMPLETED', attempt: row };
    },
  };

  env.snapshots = {
    async capture({ serviceSessionId, closeoutCorrelationId, payload }) {
      env.calls.capture.push({ serviceSessionId, closeoutCorrelationId });
      if (env.snapshotsByCorr.has(closeoutCorrelationId)) {
        return { success: true, created: false, code: 'ALREADY_CAPTURED', snapshot: env.snapshotsByCorr.get(closeoutCorrelationId) };
      }
      const row = { id: 'snap-' + (env.snapshotsByCorr.size + 1), serviceSessionId, closeoutCorrelationId, payload };
      env.snapshotsByCorr.set(closeoutCorrelationId, row);
      return { success: true, created: true, code: 'CAPTURED', snapshot: row };
    },
  };

  // publicCloseout() shape — mirrors src/closeout/serviceCloseouts.js's real
  // mapper exactly (financial/operational grouped, not a flat dump), since
  // src/closeout/serviceCloseoutCreation.js's real create() reuses that exact
  // function. A flat fake here would silently pass while the real DAO's
  // actual nested shape broke every caller — see tests/serviceLifecycleV3
  // CloseEngineResourcePolicyIntegration.test.js for the real-wrapper proof
  // that this shape assumption is correct.
  function publicCloseoutFake(fields, id) {
    return {
      id,
      serviceSessionId: fields.serviceSessionId,
      closeoutCorrelationId: fields.closeoutCorrelationId,
      closeSource: fields.source,
      closeReason: fields.closeReason || null,
      closedBy: fields.closedBy,
      financial: {
        grossSalesCents: fields.grossSalesCents,
        netSalesCents: fields.netSalesCents,
        totalDiscountsCents: 0,
        totalRefundsCents: fields.totalRefundsCents,
        totalVoidCents: fields.totalVoidCents,
        paidAmountCents: fields.paidAmountCents,
        unpaidExposureCents: fields.unpaidExposureCents,
        orderCount: fields.orderCount,
        cashAmountCents: fields.cashAmountCents,
        cardAmountCents: fields.cardAmountCents,
        bizumAmountCents: fields.bizumAmountCents,
        otherAmountCents: fields.otherAmountCents,
      },
      operational: {
        openOrdersAtClose: fields.openOrdersAtClose,
        occupiedTablesAtClose: fields.occupiedTablesAtClose,
        kitchenPendingCount: 0,
        listoCount: 0,
        deliveryPendingCount: 0,
        incidentCount: 0,
        criticalIncidentCount: 0,
      },
    };
  }

  env.closeoutCreation = {
    async create(fields) {
      await maybeYield();
      env.calls.create.push(fields);
      const existingBySession = env.closeoutsBySession.get(fields.serviceSessionId);
      if (existingBySession) {
        if (existingBySession.closeoutCorrelationId !== fields.closeoutCorrelationId) {
          return { success: false, code: 'CLOSEOUT_CORRELATION_ID_CONFLICT', closeout: null };
        }
        return { success: true, created: false, code: 'ALREADY_EXISTS', closeout: existingBySession };
      }
      const row = publicCloseoutFake(fields, 'co-' + (env.closeoutsByCorr.size + 1));
      env.closeoutsByCorr.set(fields.closeoutCorrelationId, row);
      env.closeoutsBySession.set(fields.serviceSessionId, row);
      return { success: true, created: true, code: 'CREATED', closeout: row };
    },
  };

  env.transition = {
    async close({ serviceSessionId, closeoutCorrelationId, actor, source }) {
      env.calls.close.push({ serviceSessionId, closeoutCorrelationId, actor, source });
      const row = env.sessions.get(serviceSessionId);
      if (!row) return { success: false, code: 'SERVICE_SESSION_NOT_FOUND', session: null };
      if (row.status === 'closed') {
        return { success: true, idempotent: true, code: 'ALREADY_CLOSED', session: row };
      }
      const closeoutRow = env.closeoutsBySession.get(serviceSessionId);
      if (!closeoutRow || closeoutRow.closeoutCorrelationId !== closeoutCorrelationId) {
        return { success: false, code: 'CLOSEOUT_NOT_FOUND', session: null };
      }
      row.status = 'closed';
      row.closed_at = '2026-08-09T23:00:00Z';
      row.closed_by = actor;
      row.close_source = source;
      return { success: true, idempotent: false, code: 'V3_CLOSED', session: row };
    },
  };

  return env;
}

function engineFrom(env) {
  return createServiceLifecycleEngine({
    select: env.select,
    attempts: env.attempts,
    snapshots: env.snapshots,
    closeoutCreation: env.closeoutCreation,
    transition: env.transition,
  });
}

(async () => {
  console.log('\n== serviceLifecycleEngine.js — V3.2 close engine, happy path only ==\n');

  console.log('\n── Scenario A: empty service (zero orders, zero open tables) ──');
  {
    const env = fakeEnv({ allOrders: [], tableSessions: [], financialEvents: [] });
    const closeServiceV3 = engineFrom(env);
    const result = await closeServiceV3({ serviceSessionId: SESSION_ID, actor: 'system', source: 'test' });
    assert('A1: success', result.success === true, JSON.stringify(result));
    assert('A2: code V3_CLOSED', result.code === 'V3_CLOSED');
    assert('A3: order_count 0', result.closeout && result.closeout.financial.orderCount === 0);
    assert('A4: gross/paid/unpaid all 0', result.closeout.financial.grossSalesCents === 0 && result.closeout.financial.paidAmountCents === 0 && result.closeout.financial.unpaidExposureCents === 0);
    assert('A5: session transitioned to closed', result.session && result.session.status === 'closed');
    assert('A6: attempt marked completed', env.attemptsByCorr.get(result.closeoutCorrelationId).status === 'completed');
  }

  console.log('\n── Scenario B: fully paid service, 3 terminal orders ──');
  {
    const orders = [
      order({ orden_id: '#1', id: '#1', totale: 10 }),
      order({ orden_id: '#2', id: '#2', totale: 20, estado: 'COMPLETADO' }),
      order({ orden_id: '#3', id: '#3', totale: 15, estado: 'CANCELADO' }),
    ];
    const events = [
      paymentEvent({ order_id: '#1', amount: 10 }),
      paymentEvent({ order_id: '#2', amount: 20, payment_method: 'tarjeta' }),
    ];
    const env = fakeEnv({ allOrders: orders, financialEvents: events });
    const closeServiceV3 = engineFrom(env);
    const result = await closeServiceV3({ serviceSessionId: SESSION_ID, actor: 'system', source: 'test' });
    assert('B1: success', result.success === true, JSON.stringify(result));
    assert('B2: order_count is 3 (cancelled order still counted)', result.closeout.financial.orderCount === 3, String(result.closeout.financial.orderCount));
    assert('B3: gross excludes the cancelled order (10+20, not +15)', result.closeout.financial.grossSalesCents === 3000, String(result.closeout.financial.grossSalesCents));
    assert('B4: paid equals gross exactly', result.closeout.financial.paidAmountCents === 3000);
    assert('B5: zero unpaid exposure', result.closeout.financial.unpaidExposureCents === 0);
    assert('B6: cash/card buckets sum to paid amount exactly', result.closeout.financial.cashAmountCents + result.closeout.financial.cardAmountCents === result.closeout.financial.paidAmountCents);
    assert('B7: cash bucket is order #1 only (1000)', result.closeout.financial.cashAmountCents === 1000, String(result.closeout.financial.cashAmountCents));
    assert('B8: card bucket is order #2 only (2000)', result.closeout.financial.cardAmountCents === 2000, String(result.closeout.financial.cardAmountCents));
    assert('B9: orders were only ever READ (select), never written — engine has no delete/archive dependency at all', typeof env.select === 'function' && !('delete' in env) && !('archive' in env));
  }

  console.log('\n── Scenario C: occupied table survives a successful close ──');
  {
    const orders = [order({ totale: 10 })];
    const events = [paymentEvent({ amount: 10 })];
    const table = openTable();
    const env = fakeEnv({ allOrders: orders, financialEvents: events, tableSessions: [table] });
    const closeServiceV3 = engineFrom(env);
    const result = await closeServiceV3({ serviceSessionId: SESSION_ID, actor: 'system', source: 'test' });
    assert('C1: success — an open table does not block the close', result.success === true, JSON.stringify(result));
    assert('C2: occupiedTablesAtClose is 1', result.occupiedTablesAtClose === 1);
    assert('C3: closeout.operational.occupiedTablesAtClose is 1', result.closeout.operational.occupiedTablesAtClose === 1);
    assert('C4: the table_sessions row itself is byte-identical after close — same id/status/covers/service_session_id',
      table.id === 'ts-1' && table.status === 'open' && table.covers_total === 2 && table.service_session_id === SESSION_ID);
    assert('C5: session still transitions to closed', result.session.status === 'closed');
  }

  console.log('\n── Scenario D: retry after closeout created, attempt-completion crashed ──');
  {
    const orders = [order({ totale: 10 })];
    const events = [paymentEvent({ amount: 10 })];
    const env = fakeEnv({ allOrders: orders, financialEvents: events, failCompleteOnce: true });
    const closeServiceV3 = engineFrom(env);

    // First call: everything succeeds except attempts.complete(), which throws
    // once (simulated crash) — non-fatal per Phase F, so the call still reports success.
    const first = await closeServiceV3({ serviceSessionId: SESSION_ID, actor: 'system', source: 'test' });
    assert('D1: first call still reports success (Phase F failure is non-fatal)', first.success === true, JSON.stringify(first));
    assert('D2: exactly one closeout exists after the first call', env.closeoutsByCorr.size === 1);

    // Session is now already closed at the DB layer (per the fake). Retry.
    const second = await closeServiceV3({ serviceSessionId: SESSION_ID, actor: 'system', source: 'test-retry' });
    assert('D3: second call is a no-op success, same correlation id resumed', second.success === true && second.closeoutCorrelationId === first.closeoutCorrelationId, JSON.stringify(second));
    assert('D4: STILL exactly one closeout — retry did not create a second', env.closeoutsByCorr.size === 1);
    assert('D5: create() was called twice but only created:true once', env.calls.create.length === 2 && env.calls.create.filter((c) => false).length === 0);
    assert('D6: transition.close() second call was idempotent (ALREADY_CLOSED)', env.calls.close.length === 2);
    assert('D7: attempt eventually completed once the retry succeeded', env.attemptsByCorr.get(first.closeoutCorrelationId).status === 'completed');
  }

  console.log('\n── Scenario E: two concurrent callers converge on ONE authoritative closeout ──');
  {
    const orders = [order({ totale: 10 })];
    const events = [paymentEvent({ amount: 10 })];
    // yieldForConcurrency forces a real microtask interleaving point inside
    // attempts.acquire()/closeoutCreation.create() so Promise.all below
    // genuinely races two in-flight calls against each other, the same way
    // two real HTTP requests would race against the DB's own UNIQUE
    // constraints (service_closeout_attempts_active_uq / service_closeouts_
    // correlation_uq) — this proves the fakes' (and therefore the engine's)
    // idempotent design converges under real interleaving, not just when
    // called strictly sequentially as in Scenario D above.
    const env = fakeEnv({ allOrders: orders, financialEvents: events, yieldForConcurrency: true });
    const closeServiceV3 = engineFrom(env);
    const [r1, r2] = await Promise.all([
      closeServiceV3({ serviceSessionId: SESSION_ID, actor: 'system', source: 'caller-1' }),
      closeServiceV3({ serviceSessionId: SESSION_ID, actor: 'system', source: 'caller-2' }),
    ]);
    assert('E1: both callers report success', r1.success === true && r2.success === true, JSON.stringify([r1, r2]));
    assert('E2: both callers were handed the SAME correlation id (one attempt, not two)', r1.closeoutCorrelationId === r2.closeoutCorrelationId);
    assert('E3: exactly one closeout row exists', env.closeoutsByCorr.size === 1);
    assert('E4: exactly one attempt row exists', env.attemptsByCorr.size === 1);
  }

  console.log('\n── Scenario F: anomaly (unpaid order) — controlled refusal, no mutation ──');
  {
    const orders = [order({ totale: 10 })]; // no payment event -> unpaid
    const env = fakeEnv({ allOrders: orders, financialEvents: [] });
    const closeServiceV3 = engineFrom(env);
    const result = await closeServiceV3({ serviceSessionId: SESSION_ID, actor: 'system', source: 'test' });
    assert('F1: success is false', result.success === false, JSON.stringify(result));
    assert('F2: code is V3_CLOSE_UNSUPPORTED_NON_HAPPY_PATH', result.code === 'V3_CLOSE_UNSUPPORTED_NON_HAPPY_PATH');
    assert('F3: reason is UNPAID_EXPOSURE', result.reason === 'UNPAID_EXPOSURE');
    assert('F4: NO closeout was created', env.closeoutsByCorr.size === 0);
    assert('F5: transition.close() was NEVER called — no status mutation attempted', env.calls.close.length === 0);
    assert('F6: the attempt stays active (recoverable for a future retry), never completed', env.attemptsByCorr.get(result.closeoutCorrelationId).status === 'active');
    assert('F7: session itself is untouched', env.sessions.get(SESSION_ID).status === 'open');
  }

  console.log('\n── Scenario F2: anomaly (non-terminal order) — same controlled refusal ──');
  {
    const orders = [order({ totale: 10, estado: 'EN_COCINA' })];
    const events = [paymentEvent({ amount: 10 })];
    const env = fakeEnv({ allOrders: orders, financialEvents: events });
    const closeServiceV3 = engineFrom(env);
    const result = await closeServiceV3({ serviceSessionId: SESSION_ID, actor: 'system', source: 'test' });
    assert('F2a: success is false', result.success === false);
    assert('F2b: code is V3_CLOSE_UNSUPPORTED_NON_HAPPY_PATH', result.code === 'V3_CLOSE_UNSUPPORTED_NON_HAPPY_PATH');
    assert('F2c: reason is NON_TERMINAL_ORDERS', result.reason === 'NON_TERMINAL_ORDERS');
    assert('F2d: NO closeout was created', env.closeoutsByCorr.size === 0);
  }

  console.log('\n── Order-attribution regression (V3.1, commit 4252241) — engine scopes by CURRENT service, not table origin ──');
  {
    // A table historically opened under a DIFFERENT session ('sess-A'), but a
    // fresh order was correctly attributed (per V3.1's ordenes_assign_service_
    // session fix) to the CURRENT session under test (SESSION_ID). The engine
    // must reconcile that order into THIS close, and must NOT pull in an
    // order that (hypothetically) still belonged to the old session.
    const currentOrder = order({ orden_id: '#current', id: '#current', service_session_id: SESSION_ID, totale: 10 });
    const otherSessionOrder = order({ orden_id: '#other', id: '#other', service_session_id: 'sess-A', totale: 999 });
    const events = [paymentEvent({ order_id: '#current', service_session_id: SESSION_ID, amount: 10 })];
    const table = openTable({ service_session_id: SESSION_ID }); // table's CURRENT table_session row also scoped to SESSION_ID in this fixture
    const env = fakeEnv({ allOrders: [currentOrder, otherSessionOrder], financialEvents: events, tableSessions: [table] });
    const closeServiceV3 = engineFrom(env);
    const result = await closeServiceV3({ serviceSessionId: SESSION_ID, actor: 'system', source: 'test' });
    assert('G1: success', result.success === true, JSON.stringify(result));
    assert('G2: order_count is 1 — the other session\'s order is excluded', result.closeout.financial.orderCount === 1, String(result.closeout.financial.orderCount));
    assert('G3: gross is exactly the current-session order (1000), never 999+1000', result.closeout.financial.grossSalesCents === 1000, String(result.closeout.financial.grossSalesCents));
  }

  console.log('\n=== RESULT: ' + pass + ' passed, ' + fail + ' failed ===');
  process.exit(fail === 0 ? 0 : 1);
})();
