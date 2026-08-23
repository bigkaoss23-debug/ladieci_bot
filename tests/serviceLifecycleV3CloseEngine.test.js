'use strict';
// SERVICE LIFECYCLE V3 / Slice 3.2 — behavioural contract for
// src/serviceSessions/serviceLifecycleEngine.js against fake dependencies
// (no live DB — the DB-level invariants this engine depends on are proven
// separately, statically, in tests/serviceLifecycleV3CloseEngineMigration.
// static.test.js). Fakes mirror the REAL RPC contracts' idempotency shape
// (ON CONFLICT DO NOTHING + re-fetch, active-attempt uniqueness) exactly, the
// same style as tests/incidentSafeRollover.test.js's fakeEnv().
//
// SLICE 3.3 note: Scenarios F/F2 originally proved the Slice-3.2-only
// "happy path only, anomaly -> V3_CLOSE_UNSUPPORTED_NON_HAPPY_PATH" refusal.
// That gate is gone (see serviceLifecycleEngine.js's own header) — an
// anomaly now classifies into a persisted incident and the close still
// succeeds. F/F2 below are updated to prove exactly that for THIS file's own
// scope (structural close behaviour); the full incident-policy contract
// (financial/operational/informational classification, persistence
// ordering, idempotent retry, safe-action success/failure) is proven
// separately in tests/v3IncidentPolicy.test.js and
// tests/serviceLifecycleV3IncidentPolicyEngine.test.js.

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
    // SLICE 3.2.1 — read-only lineage lookup, mirrors closeoutAttempts.js's
    // real getByCorrelationId() exactly (Map-keyed on closeoutCorrelationId,
    // same as the real PRIMARY KEY).
    async getByCorrelationId({ closeoutCorrelationId }) {
      env.calls.getAttemptByCorr = env.calls.getAttemptByCorr || [];
      env.calls.getAttemptByCorr.push({ closeoutCorrelationId });
      return env.attemptsByCorr.get(closeoutCorrelationId) || null;
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

  // SLICE 3.2.1 — read-only lineage lookup, mirrors serviceCloseouts.js's real
  // getBySessionId() exactly (Map-keyed on serviceSessionId, same as the real
  // service_closeouts_session_uq constraint).
  env.closeouts = {
    async getBySessionId({ serviceSessionId }) {
      env.calls.getCloseoutBySession = env.calls.getCloseoutBySession || [];
      env.calls.getCloseoutBySession.push({ serviceSessionId });
      return env.closeoutsBySession.get(serviceSessionId) || null;
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

  // SLICE 3.3 — minimal idempotent fakes for the engine's incident-policy
  // dependencies. Full contract coverage (idempotent dedupe, safe-action
  // success/failure ordering) lives in
  // tests/serviceLifecycleV3IncidentPolicyEngine.test.js; this file only
  // needs these two NOT to hit the real network, so Scenario A-E/G's
  // zero-incident happy paths keep proving exactly what they always did.
  env.incidents = {
    calls: { report: [], resolve: [] },
    async report(fields) {
      env.incidents.calls.report.push(fields);
      return { success: true, created: true, code: 'RECORDED', incident: { id: 'inc-' + (env.incidents.calls.report.length), ...fields, resolutionStatus: 'pending' } };
    },
    async resolve({ incidentId, resolutionType }) {
      env.incidents.calls.resolve.push({ incidentId, resolutionType });
      return { success: true, incident: { id: incidentId, resolutionStatus: 'resolved', resolutionType } };
    },
  };
  env.releaseEmptyTable = async () => ({ ok: true });

  return env;
}

function engineFrom(env) {
  return createServiceLifecycleEngine({
    select: env.select,
    attempts: env.attempts,
    snapshots: env.snapshots,
    closeoutCreation: env.closeoutCreation,
    closeouts: env.closeouts,
    transition: env.transition,
    incidents: env.incidents,
    releaseEmptyTable: env.releaseEmptyTable,
    // J-1 — the engine persists the close's economic context between Phase D
    // and Phase E. These are unit tests with no database, so inject a stub
    // that records the call. A test can override env.reconciliation to prove
    // the close FAILS CLOSED (service stays open) when context cannot persist.
    reconciliation: env.reconciliation || {
      persist: async ({ closeoutCorrelationId }) => ({
        success: true,
        created: true,
        reconciliation: { closeoutCorrelationId, stubbed: true },
      }),
    },
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
    // SLICE 3.2.1 — the retry now resumes via explicit lineage (CASE D: closed
    // + closeout exists + attempt still active) BEFORE ever reaching Phase A/D
    // again, so create() is called exactly ONCE total (first call only) and
    // acquire() is never called a second time either — the old design re-ran
    // the whole pipeline on every retry and relied on create_service_closeout's
    // OWN idempotency to no-op; this is stronger: the retry never even asks.
    assert('D5: create() was called only ONCE — the retry short-circuits via lineage detection, never reaching Phase D again', env.calls.create.length === 1, String(env.calls.create.length));
    assert('D6: transition.close() second call was idempotent (ALREADY_CLOSED)', env.calls.close.length === 2);
    assert('D7: attempt eventually completed once the retry succeeded', env.attemptsByCorr.get(first.closeoutCorrelationId).status === 'completed');
    assert('D8: attempts.acquire() was called only ONCE (first call) — the retry never mints/touches a new attempt', env.calls.acquire.length === 1, String(env.calls.acquire.length));
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

  console.log('\n── Scenario F: anomaly (unpaid order) — SLICE 3.3: classifies + closes, never refuses ──');
  {
    const orders = [order({ totale: 10 })]; // no payment event -> unpaid
    const env = fakeEnv({ allOrders: orders, financialEvents: [] });
    const closeServiceV3 = engineFrom(env);
    const result = await closeServiceV3({ serviceSessionId: SESSION_ID, actor: 'system', source: 'test' });
    assert('F1: success is true — an unpaid balance no longer blocks the close', result.success === true, JSON.stringify(result));
    assert('F2: code is V3_CLOSED', result.code === 'V3_CLOSED');
    assert('F3: exactly 1 financial incident, exposure 1000 cents', result.incidents.length === 1 && result.incidents[0].incidentType === 'UNPAID_BALANCE_AT_CLOSE');
    assert('F4: a closeout WAS created, unpaidExposureCents is 1000 (frozen, not zeroed)', env.closeoutsByCorr.size === 1 && result.closeout.financial.unpaidExposureCents === 1000);
    assert('F5: transition.close() WAS called — the close proceeds', env.calls.close.length === 1);
    assert('F6: attempt reaches completed', env.attemptsByCorr.get(result.closeoutCorrelationId).status === 'completed');
    assert('F7: session transitions to closed', env.sessions.get(SESSION_ID).status === 'closed');
  }

  console.log('\n── Scenario F2: anomaly (non-terminal order) — SLICE 3.3: same, classifies + closes ──');
  {
    const orders = [order({ totale: 10, estado: 'EN_COCINA' })];
    const events = [paymentEvent({ amount: 10 })];
    const env = fakeEnv({ allOrders: orders, financialEvents: events });
    const closeServiceV3 = engineFrom(env);
    const result = await closeServiceV3({ serviceSessionId: SESSION_ID, actor: 'system', source: 'test' });
    assert('F2a: success is true', result.success === true, JSON.stringify(result));
    assert('F2b: code is V3_CLOSED', result.code === 'V3_CLOSED');
    assert('F2c: exactly 1 operational (kitchen) incident', result.incidents.length === 1 && result.incidents[0].incidentType === 'KITCHEN_WORK_PENDING_AT_CLOSE');
    assert('F2d: a closeout WAS created', env.closeoutsByCorr.size === 1);
  }

  console.log('\n── P0-G: a paid force-closed-table order does not freeze into total_void_cents ──');
  {
    // Audit's own semantic verdict: the force-closed-table estado is
    // operational terminalization (kitchen never confirmed served), not
    // economic void — the order was fully paid. Before the P0 fix, this
    // order landed in totalVoidCents purely because of its estado, hiding
    // real revenue in every future closeout the same way it already had for
    // 7 of 9 real staging orders.
    const FORCE_CLOSED_TABLE_ESTADO = 'CHIUSO_FORZATO'; // language-guard: allow-legacy CHIUSO_FORZATO is the existing terminal-state literal under test here, not new vocabulary
    const orders = [order({ totale: 100, estado: FORCE_CLOSED_TABLE_ESTADO })];
    const events = [paymentEvent({ amount: 100, payment_method: 'efectivo' })];
    const env = fakeEnv({ allOrders: orders, financialEvents: events });
    const closeServiceV3 = engineFrom(env);
    const result = await closeServiceV3({ serviceSessionId: SESSION_ID, actor: 'system', source: 'test' });
    assert('G-P0-1: success is true', result.success === true, JSON.stringify(result));
    assert('G-P0-2: a closeout WAS created', env.closeoutsByCorr.size === 1);
    assert('G-P0-3: totalVoidCents is 0 — not frozen as void just for the estado', result.closeout.financial.totalVoidCents === 0, String(result.closeout.financial.totalVoidCents));
    assert('G-P0-4: grossSalesCents is the real 10000 (100.00 EUR), not excluded', result.closeout.financial.grossSalesCents === 10000, String(result.closeout.financial.grossSalesCents));
    assert('G-P0-5: paidAmountCents is the real 10000 collected, not zeroed', result.closeout.financial.paidAmountCents === 10000, String(result.closeout.financial.paidAmountCents));
    assert('G-P0-6: unpaidExposureCents is 0 (fully paid)', result.closeout.financial.unpaidExposureCents === 0, String(result.closeout.financial.unpaidExposureCents));
    assert('G-P0-7: cashAmountCents carries the real cash receipt', result.closeout.financial.cashAmountCents === 10000, String(result.closeout.financial.cashAmountCents));
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
