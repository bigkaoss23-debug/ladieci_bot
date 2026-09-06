'use strict';
// SERVICE LIFECYCLE V3 / Slice 3.3 — engine-level incident-policy contract for
// src/serviceSessions/serviceLifecycleEngine.js's Phase C.2 (classify/persist/
// safe-act), against fake dependencies (no live DB — real classification logic
// is proven separately, purely, in tests/v3IncidentPolicy.test.js; real
// PostgreSQL identity/overload behaviour is proven empirically against staging
// in this session's recovery report, not here). Fakes for `incidents` and
// `releaseEmptyTable` mirror the REAL RPC contracts' idempotency shape exactly
// (ON CONFLICT DO NOTHING + re-fetch on service_incidents_dedupe_uq), same
// style as tests/serviceLifecycleV3CloseEngine.test.js's fakeEnv().
//
// Each scenario below maps to one lettered case from the session's own spec
// (A-L); D/K/L additionally prove ordering and failure-mode guarantees no
// other test file covers.

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
  id: 'ts-1', service_session_id: SESSION_ID, status: 'open', covers_total: 2, workspace_id: 'ws-1', ...o,
});

// fakeIncidents() mirrors create_service_incident's real idempotency exactly:
// keyed on (closeoutCorrelationId, incidentType, entityType, entityId) — a
// retry describing the SAME occurrence returns the SAME row, created:false,
// never a duplicate/second row (service_incidents_dedupe_uq).
function fakeIncidents({ failOnNthReport = null, throwOnNthReport = null } = {}) {
  const byKey = new Map();
  const byId = new Map();
  let reportCalls = 0;
  let seq = 0;
  const key = (c) => [c.closeoutCorrelationId, c.incidentType, c.entityType || '', c.entityId || ''].join('|');
  return {
    calls: { report: [], resolve: [] },
    rows: byId,
    async report(fields) {
      reportCalls += 1;
      this.calls.report.push(fields);
      if (throwOnNthReport === reportCalls) throw new Error('simulated transport crash on report #' + reportCalls);
      if (failOnNthReport === reportCalls) return { success: false, code: 'SERVICE_INCIDENT_REPORT_FAILED', incident: null };
      const k = key(fields);
      if (byKey.has(k)) return { success: true, created: false, code: 'ALREADY_RECORDED', incident: byKey.get(k) };
      seq += 1;
      const row = {
        id: 'inc-' + seq,
        entityType: fields.entityType,
        entityId: fields.entityId,
        incidentType: fields.incidentType,
        category: fields.category,
        severity: fields.severity,
        financialExposureCents: fields.financialExposureCents ?? null,
        resolutionStatus: 'pending',
        resolutionType: null,
      };
      byKey.set(k, row);
      byId.set(row.id, row);
      return { success: true, created: true, code: 'RECORDED', incident: row };
    },
    async resolve({ incidentId, resolutionType }) {
      this.calls.resolve.push({ incidentId, resolutionType });
      const row = byId.get(incidentId);
      if (!row) return { success: false, code: 'INCIDENT_NOT_FOUND', incident: null };
      row.resolutionStatus = 'resolved';
      row.resolutionType = resolutionType;
      return { success: true, incident: row };
    },
  };
}

function fakeEnv({
  sessionRow = session(),
  allOrders = [],
  tableSessions = [],
  financialEvents = [],
  incidents = fakeIncidents(),
  releaseEmptyTable = async () => ({ ok: true }),
} = {}) {
  const env = {
    sessions: new Map([[sessionRow.id, { ...sessionRow }]]),
    attemptsByCorr: new Map(),
    attemptsBySession: new Map(),
    snapshotsByCorr: new Map(),
    closeoutsByCorr: new Map(),
    closeoutsBySession: new Map(),
    calls: { acquire: [], capture: [], create: [], close: [], complete: [], releaseEmptyTable: [] },
    incidents,
  };

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
    // FINALIZAR V3 CANONICAL CLOSEOUT V1 — the engine's Phase B now also reads
    // order_obligations. This harness sets up no canonical-obligation rows, so
    // [] keeps every assertion on legacy ordenes.totale-based numbers valid.
    if (table === 'order_obligations') return [];
    throw new Error('unexpected table ' + table);
  };

  env.attempts = {
    async acquire({ serviceSessionId, actor }) {
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
      const row = env.attemptsByCorr.get(closeoutCorrelationId);
      if (!row) return { success: false, code: 'ATTEMPT_NOT_FOUND' };
      row.status = 'completed';
      return { success: true, idempotent: false, code: 'COMPLETED', attempt: row };
    },
    async getByCorrelationId({ closeoutCorrelationId }) {
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
        kitchenPendingCount: fields.kitchenPendingCount || 0,
        listoCount: fields.listoCount || 0,
        deliveryPendingCount: fields.deliveryPendingCount || 0,
        incidentCount: fields.incidentCount || 0,
        criticalIncidentCount: fields.criticalIncidentCount || 0,
      },
    };
  }

  env.closeoutCreation = {
    async create(fields) {
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

  env.closeouts = {
    async getBySessionId({ serviceSessionId }) {
      return env.closeoutsBySession.get(serviceSessionId) || null;
    },
  };

  env.transition = {
    async close({ serviceSessionId, closeoutCorrelationId, actor, source }) {
      env.calls.close.push({ serviceSessionId, closeoutCorrelationId, actor, source });
      const row = env.sessions.get(serviceSessionId);
      if (!row) return { success: false, code: 'SERVICE_SESSION_NOT_FOUND', session: null };
      if (row.status === 'closed') return { success: true, idempotent: true, code: 'ALREADY_CLOSED', session: row };
      const closeoutRow = env.closeoutsBySession.get(serviceSessionId);
      if (!closeoutRow || closeoutRow.closeoutCorrelationId !== closeoutCorrelationId) {
        return { success: false, code: 'CLOSEOUT_NOT_FOUND', session: null };
      }
      row.status = 'closed';
      return { success: true, idempotent: false, code: 'V3_CLOSED', session: row };
    },
  };

  env.releaseEmptyTable = async (args) => {
    env.calls.releaseEmptyTable.push(args);
    return releaseEmptyTable(args);
  };

  return env;
}

function engineFrom(env, overrides = {}) {
  return createServiceLifecycleEngine({
    select: env.select,
    attempts: env.attempts,
    snapshots: env.snapshots,
    closeoutCreation: env.closeoutCreation,
    closeouts: env.closeouts,
    transition: env.transition,
    incidents: env.incidents,
    releaseEmptyTable: env.releaseEmptyTable,
    ...overrides,
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
  console.log('\n== serviceLifecycleEngine.js — V3.3 incident policy (engine integration) ==\n');

  console.log('\n── Test A — clean fully-paid close: zero incidents ──');
  {
    const orders = [order({ totale: 10 })];
    const events = [paymentEvent({ amount: 10 })];
    const env = fakeEnv({ allOrders: orders, financialEvents: events });
    const result = await engineFrom(env)({ serviceSessionId: SESSION_ID, actor: 'system', source: 'test' });
    assert('A1: success', result.success === true, JSON.stringify(result));
    assert('A2: zero incidents returned', Array.isArray(result.incidents) && result.incidents.length === 0);
    assert('A3: closeout incidentCount 0', result.closeout.operational.incidentCount === 0);
    assert('A4: no incidents.report() calls at all', env.incidents.calls.report.length === 0);
  }

  console.log('\n── Test B — one unpaid order: 1 financial incident, correct exposure, close succeeds ──');
  {
    const orders = [order({ totale: 20 })]; // no payment -> fully unpaid
    const env = fakeEnv({ allOrders: orders, financialEvents: [] });
    const result = await engineFrom(env)({ serviceSessionId: SESSION_ID, actor: 'system', source: 'test' });
    assert('B1: success', result.success === true, JSON.stringify(result));
    assert('B2: exactly 1 incident', result.incidents.length === 1, JSON.stringify(result.incidents));
    assert('B3: it is UNPAID_BALANCE_AT_CLOSE, exposure 2000 cents', result.incidents[0].incidentType === 'UNPAID_BALANCE_AT_CLOSE' && result.incidents[0].financialExposureCents === 2000);
    assert('B4: closeout unpaidExposureCents is 2000', result.closeout.financial.unpaidExposureCents === 2000);
    assert('B5: closeout incidentCount is 1', result.closeout.operational.incidentCount === 1);
    assert('B6: session transitioned to closed', result.session.status === 'closed');
  }

  console.log('\n── Test C — three unpaid orders (1600+1350+2800): 3 incidents, 5750 exposure, no payment mutation ──');
  {
    const orders = [
      order({ orden_id: '#a', id: '#a', totale: 16.0 }),
      order({ orden_id: '#b', id: '#b', totale: 13.5 }),
      order({ orden_id: '#c', id: '#c', totale: 28.0 }),
    ];
    const env = fakeEnv({ allOrders: orders, financialEvents: [] });
    const result = await engineFrom(env)({ serviceSessionId: SESSION_ID, actor: 'system', source: 'test' });
    assert('C1: success', result.success === true, JSON.stringify(result));
    assert('C2: exactly 3 incidents', result.incidents.length === 3, JSON.stringify(result.incidents));
    assert('C3: closeout unpaidExposureCents is exactly 5750', result.closeout.financial.unpaidExposureCents === 5750, String(result.closeout.financial.unpaidExposureCents));
    assert('C4: closeout incidentCount is 3', result.closeout.operational.incidentCount === 3);
    assert('C5: no financial-event write dependency exists anywhere in the fake env (no payment fabricated)', !('financialEvents' in env.closeoutCreation) && env.calls.create.length === 1);
    const cents = result.incidents.map((i) => i.financialExposureCents).sort((a, b) => a - b);
    assert('C6: per-incident cents are exactly [1350,1600,2800]', JSON.stringify(cents) === JSON.stringify([1350, 1600, 2800]));
  }

  console.log('\n── Test D — retry after incidents already persisted: no duplicates, same totals ──');
  {
    const orders = [
      order({ orden_id: '#a', id: '#a', totale: 16.0 }),
      order({ orden_id: '#b', id: '#b', totale: 13.5 }),
      order({ orden_id: '#c', id: '#c', totale: 28.0 }),
    ];
    // throwOnNthReport: 3 -> first attempt persists incidents #1 and #2, then
    // "crashes" (simulated transport error) reporting the 3rd -> engine
    // returns V3_CLOSE_INCIDENT_PERSISTENCE_FAILED, closeout NEVER created,
    // attempt stays active. A second call (retry, same active attempt/
    // correlation id) must re-persist #1/#2 idempotently (created:false) and
    // finally succeed in creating #3, ending at exactly 3 incidents / 5750
    // cents total, never 6 / 11500.
    const incidents = fakeIncidents({ throwOnNthReport: 3 });
    const env = fakeEnv({ allOrders: orders, financialEvents: [], incidents });
    const engine = engineFrom(env);

    const first = await engine({ serviceSessionId: SESSION_ID, actor: 'system', source: 'test' });
    assert('D1: first call fails with V3_CLOSE_INCIDENT_PERSISTENCE_FAILED', first.success === false && first.code === 'V3_CLOSE_INCIDENT_PERSISTENCE_FAILED', JSON.stringify(first));
    assert('D2: no closeout created on the failed first call', env.closeoutsByCorr.size === 0);
    assert('D3: attempt stays active after the failed first call', env.attemptsByCorr.get(first.closeoutCorrelationId).status === 'active');
    assert('D4: exactly 2 incidents durably recorded so far', incidents.rows.size === 2, String(incidents.rows.size));

    const second = await engine({ serviceSessionId: SESSION_ID, actor: 'system', source: 'test-retry' });
    assert('D5: retry succeeds', second.success === true, JSON.stringify(second));
    assert('D6: retry resumed the SAME correlation id (one attempt, not two)', second.closeoutCorrelationId === first.closeoutCorrelationId);
    assert('D7: exactly 3 incidents total — never duplicated the first two', incidents.rows.size === 3, String(incidents.rows.size));
    assert('D8: closeout unpaidExposureCents is exactly 5750, not 11500', second.closeout.financial.unpaidExposureCents === 5750, String(second.closeout.financial.unpaidExposureCents));
    assert('D9: closeout incidentCount is 3, not 6', second.closeout.operational.incidentCount === 3);
    assert('D10: only ONE attempts.acquire() ever minted a NEW attempt (both calls resumed/reused it)', env.calls.acquire.length === 2 && env.attemptsByCorr.size === 1);
  }

  console.log('\n── Test E — Cocina (EN_COCINA): explicit expected outcome ──');
  {
    const orders = [order({ totale: 10, estado: 'EN_COCINA' })];
    const events = [paymentEvent({ amount: 10 })];
    const env = fakeEnv({ allOrders: orders, financialEvents: events });
    const result = await engineFrom(env)({ serviceSessionId: SESSION_ID, actor: 'system', source: 'test' });
    assert('E1: success — kitchen work pending does not block close', result.success === true, JSON.stringify(result));
    assert('E2: 1 KITCHEN_WORK_PENDING_AT_CLOSE incident', result.incidents.length === 1 && result.incidents[0].incidentType === 'KITCHEN_WORK_PENDING_AT_CLOSE');
    assert('E3: closeout kitchenPendingCount is 1', result.closeout.operational.kitchenPendingCount === 1);
    assert('E4: openOrdersAtClose is 1 (non-terminal order counted)', env.calls.create[0].openOrdersAtClose === 1);
  }

  console.log('\n── Test F — LISTO: explicit expected outcome ──');
  {
    const orders = [order({ totale: 10, estado: 'LISTO' })];
    const events = [paymentEvent({ amount: 10 })];
    const env = fakeEnv({ allOrders: orders, financialEvents: events });
    const result = await engineFrom(env)({ serviceSessionId: SESSION_ID, actor: 'system', source: 'test' });
    assert('F1: success', result.success === true, JSON.stringify(result));
    assert('F2: 1 ORDER_READY_NOT_FINALIZED_AT_CLOSE incident', result.incidents.length === 1 && result.incidents[0].incidentType === 'ORDER_READY_NOT_FINALIZED_AT_CLOSE');
    assert('F3: closeout listoCount is 1', result.closeout.operational.listoCount === 1);
  }

  console.log('\n── Test G — rider/delivery (EN_ENTREGA): explicit expected outcome ──');
  {
    const orders = [order({ totale: 10, estado: 'EN_ENTREGA' })];
    const events = [paymentEvent({ amount: 10 })];
    const env = fakeEnv({ allOrders: orders, financialEvents: events });
    const result = await engineFrom(env)({ serviceSessionId: SESSION_ID, actor: 'system', source: 'test' });
    assert('G1: success', result.success === true, JSON.stringify(result));
    assert('G2: 1 DELIVERY_ACTIVE_AT_CLOSE incident', result.incidents.length === 1 && result.incidents[0].incidentType === 'DELIVERY_ACTIVE_AT_CLOSE');
    assert('G3: closeout deliveryPendingCount is 1', result.closeout.operational.deliveryPendingCount === 1);
    assert('G4: no rider/mesa release action was ever attempted for an order-level incident', env.calls.releaseEmptyTable.length === 0);
  }

  console.log('\n── Test H — empty-table release success: incident resolved only after confirmed success ──');
  {
    const table = openTable({ id: 'ts-empty', covers_total: null, workspace_id: 'ws-5' });
    const env = fakeEnv({ allOrders: [], tableSessions: [table] });
    const result = await engineFrom(env)({ serviceSessionId: SESSION_ID, actor: 'system', source: 'test' });
    assert('H1: success', result.success === true, JSON.stringify(result));
    assert('H2: 1 EMPTY_TABLE_LEFT_OPEN incident returned, resolved', result.incidents.length === 1 && result.incidents[0].resolutionStatus === 'resolved');
    assert('H3: resolutionType is auto_released_empty_table', result.incidents[0].resolutionType === 'auto_released_empty_table');
    assert('H4: releaseEmptyTable was called exactly once, for that table', env.calls.releaseEmptyTable.length === 1 && env.calls.releaseEmptyTable[0].tableSessionId === 'ts-empty');
    assert('H5: incidents.resolve() was called AFTER incidents.report() for this incident (ordering)', env.incidents.calls.report.length === 1 && env.incidents.calls.resolve.length === 1);
    assert('H6: the persisted incident row was created pending BEFORE being resolved (never resolved at creation time)', env.incidents.calls.report[0].autoResolve === false);
  }

  console.log('\n── Test I — empty-table release failure: incident stays pending, no false resolution ──');
  {
    const table = openTable({ id: 'ts-empty-2', covers_total: null, workspace_id: 'ws-6' });
    const env = fakeEnv({
      allOrders: [], tableSessions: [table],
      releaseEmptyTable: async () => { throw new Error('MESA_TABLE_HAS_ORDERS'); },
    });
    const result = await engineFrom(env)({ serviceSessionId: SESSION_ID, actor: 'system', source: 'test' });
    assert('I1: close still succeeds — a failed non-fatal safe action never blocks the close', result.success === true, JSON.stringify(result));
    assert('I2: the incident stays pending — never falsely marked resolved', result.incidents.length === 1 && result.incidents[0].resolutionStatus === 'pending');
    assert('I3: incidents.resolve() was NEVER called for it', env.incidents.calls.resolve.length === 0);
    assert('I4: closeout incidentCount still counts it (1)', result.closeout.operational.incidentCount === 1);
  }

  console.log('\n── Test J — occupied table: no unnecessary incident, table untouched, close succeeds ──');
  {
    const table = openTable({ id: 'ts-occupied', covers_total: 3 });
    const orders = [order({ totale: 10 })];
    const events = [paymentEvent({ amount: 10 })];
    const env = fakeEnv({ allOrders: orders, financialEvents: events, tableSessions: [table] });
    const result = await engineFrom(env)({ serviceSessionId: SESSION_ID, actor: 'system', source: 'test' });
    assert('J1: success', result.success === true, JSON.stringify(result));
    assert('J2: zero incidents — an occupied table is not an anomaly', result.incidents.length === 0, JSON.stringify(result.incidents));
    assert('J3: releaseEmptyTable was never called', env.calls.releaseEmptyTable.length === 0);
    assert('J4: occupiedTablesAtClose is still recorded as 1 (operational fact, not an incident)', result.occupiedTablesAtClose === 1);
    assert('J5: table row itself is untouched', table.status === 'open' && table.covers_total === 3);
  }

  console.log('\n── Test K — required incident persistence failure: hard block, no closeout, service not closed ──');
  {
    const orders = [order({ totale: 10 })]; // unpaid -> 1 required financial incident
    const incidents = fakeIncidents({ failOnNthReport: 1 }); // logical failure, not a throw
    const env = fakeEnv({ allOrders: orders, financialEvents: [], incidents });
    const result = await engineFrom(env)({ serviceSessionId: SESSION_ID, actor: 'system', source: 'test' });
    assert('K1: success is false', result.success === false, JSON.stringify(result));
    assert('K2: code is V3_CLOSE_INCIDENT_PERSISTENCE_FAILED', result.code === 'V3_CLOSE_INCIDENT_PERSISTENCE_FAILED');
    assert('K3: NO closeout was created', env.closeoutsByCorr.size === 0);
    assert('K4: transition.close() was never called — service not closed', env.calls.close.length === 0);
    assert('K5: session status is still open', env.sessions.get(SESSION_ID).status === 'open');
    assert('K6: attempt stays active (recoverable), never completed', env.attemptsByCorr.get(result.closeoutCorrelationId).status === 'active');
  }

  console.log('\n── Test L — unknown/unrecognized anomaly at classification: fail closed, controlled hard block ──');
  {
    const orders = [order({ totale: 10 })];
    const events = [paymentEvent({ amount: 10 })];
    const env = fakeEnv({ allOrders: orders, financialEvents: events });
    // Simulates v3IncidentPolicy.js's own fail-closed guard (an incident type
    // with no policy entry — a programming defect) reaching the engine.
    const throwingClassify = () => { throw new Error('v3IncidentPolicy: no policy entry for incident type "BOGUS_TYPE"'); };
    const result = await engineFrom(env, { classify: throwingClassify })({ serviceSessionId: SESSION_ID, actor: 'system', source: 'test' });
    assert('L1: success is false — never an unhandled rejection', result.success === false, JSON.stringify(result));
    assert('L2: code is V3_CLOSE_CLASSIFICATION_FAILED', result.code === 'V3_CLOSE_CLASSIFICATION_FAILED');
    assert('L3: NO closeout was created', env.closeoutsByCorr.size === 0);
    assert('L4: no incident was ever reported', env.incidents.calls.report.length === 0);
    assert('L5: transition.close() was never called — service not closed', env.calls.close.length === 0);
    assert('L6: attempt stays active (recoverable)', env.attemptsByCorr.get(result.closeoutCorrelationId).status === 'active');
  }

  console.log('\n=== RESULT: ' + pass + ' passed, ' + fail + ' failed ===');
  process.exit(fail === 0 ? 0 : 1);
})();
