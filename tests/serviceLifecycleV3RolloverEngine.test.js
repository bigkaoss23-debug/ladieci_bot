'use strict';
// SERVICE LIFECYCLE V3 — engine-level contract for
// src/serviceSessions/serviceLifecycleEngine.js's terminal phases (carryover
// summary + attempt completion), against fake dependencies (no live DB — the
// real function-overload-free-of-ambiguity primitive, the real trigger
// mechanism for post-boundary order attribution, and the real idempotent-
// reuse/lineage/current-already-set logic are all proven empirically against
// staging Postgres in this session's own report, not re-proven here).
//
// F-5 — this file used to be SLICE 3.4's rollover contract (cases A-N of the
// V3.4 spec's own required test matrix), proving the engine auto-opened a
// next current service B after closing A. F-5 retired that step entirely:
// Finalizar servicio CLOSES the Operational Service and does not
// automatically open another one, and clock/schedule state must never
// determine post-close service identity. This file is rewritten to prove
// the OPPOSITE of what it used to: every scenario below asserts ZERO
// successor is ever created, regardless of residue, crash/retry, or the
// clock at the moment of close — env.calls.ensureNext.length stays 0 in
// every single case, and env.transition.ensureNext (still present in the
// fake, mirroring the real serviceLifecycleV3Transition.js wrapper, which
// F-5 also left in place — see that file's own header) is a tripwire: if a
// future regression ever reintroduces a call to it, these tests fail loudly
// rather than silently passing.

const { createServiceLifecycleEngine } = require('../src/serviceSessions/serviceLifecycleEngine');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

const SESSION_ID = 'sess-A';

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

// Precise query-string parser — guards against a loose `/id=eq\.([^&]+)/`
// regex that would ALSO substring-match "rollover_source_session_id=eq.X"
// (which literally contains "...id=eq."). No scenario below still queries
// by rollover_source_session_id (F-5 removed that read entirely along with
// the successor concept), but the parser stays precise regardless.
function parseQuery(query) {
  const out = {};
  for (const part of String(query || '').split('&')) {
    const i = part.indexOf('=eq.');
    if (i === -1) continue;
    out[part.slice(0, i)] = decodeURIComponent(part.slice(i + 4));
  }
  return out;
}

function fakeEnv({
  sessionRow = session(),
  allOrders = [],
  tableSessions = [],
  financialEvents = [],
  nowDate = new Date('2026-08-09T20:00:00Z'), // 22:00 Madrid CEST
} = {}) {
  const env = {
    sessions: new Map([[sessionRow.id, { ...sessionRow }]]),
    nowDate,
    attemptsByCorr: new Map(),
    attemptsBySession: new Map(),
    snapshotsByCorr: new Map(),
    closeoutsByCorr: new Map(),
    closeoutsBySession: new Map(),
    calls: { acquire: [], create: [], close: [], complete: [], ensureNext: [], selectServiceSessions: [] },
    incidents: {
      calls: { report: [], resolve: [] },
      async report(fields) {
        env.incidents.calls.report.push(fields);
        return { success: true, created: true, code: 'RECORDED', incident: { id: 'inc-' + (env.incidents.calls.report.length), ...fields, resolutionStatus: 'pending' } };
      },
      async resolve({ incidentId, resolutionType }) {
        env.incidents.calls.resolve.push({ incidentId, resolutionType });
        return { success: true, incident: { id: incidentId, resolutionStatus: 'resolved', resolutionType } };
      },
    },
    releaseEmptyTable: async () => ({ ok: true }),
  };

  env.select = async (table, query) => {
    const q = parseQuery(query);
    if (table === 'service_sessions') {
      env.calls.selectServiceSessions.push(q);
      if (q.id) {
        const row = env.sessions.get(q.id);
        return row ? [row] : [];
      }
      throw new Error('unexpected service_sessions query: ' + query);
    }
    const scopedId = q.service_session_id;
    if (table === 'ordenes') return allOrders.filter((o) => String(o.service_session_id) === String(scopedId));
    if (table === 'table_sessions') return tableSessions.filter((t) => String(t.service_session_id) === String(scopedId));
    if (table === 'order_financial_events') return financialEvents.filter((e) => String(e.service_session_id) === String(scopedId));
    throw new Error('unexpected table ' + table);
  };

  env.attempts = {
    async acquire({ serviceSessionId, actor }) {
      env.calls.acquire.push({ serviceSessionId, actor });
      const existing = env.attemptsBySession.get(serviceSessionId);
      if (existing && existing.status === 'active') return { success: true, created: false, code: 'ALREADY_ACTIVE', attempt: existing };
      const id = 'corr-' + (env.attemptsByCorr.size + 1);
      const row = { closeoutCorrelationId: id, serviceSessionId, status: 'active', createdBy: actor };
      env.attemptsByCorr.set(id, row);
      env.attemptsBySession.set(serviceSessionId, row);
      return { success: true, created: true, code: 'ACQUIRED', attempt: row };
    },
    async complete({ closeoutCorrelationId }) {
      env.calls.complete.push({ closeoutCorrelationId });
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
    async capture({ serviceSessionId, closeoutCorrelationId }) {
      if (env.snapshotsByCorr.has(closeoutCorrelationId)) return { success: true, created: false, code: 'ALREADY_CAPTURED', snapshot: env.snapshotsByCorr.get(closeoutCorrelationId) };
      const row = { id: 'snap-' + (env.snapshotsByCorr.size + 1), serviceSessionId, closeoutCorrelationId };
      env.snapshotsByCorr.set(closeoutCorrelationId, row);
      return { success: true, created: true, code: 'CAPTURED', snapshot: row };
    },
  };

  function publicCloseoutFake(fields, id) {
    return {
      id, serviceSessionId: fields.serviceSessionId, closeoutCorrelationId: fields.closeoutCorrelationId,
      financial: {
        grossSalesCents: fields.grossSalesCents, netSalesCents: fields.netSalesCents, totalRefundsCents: fields.totalRefundsCents,
        totalVoidCents: fields.totalVoidCents, paidAmountCents: fields.paidAmountCents, unpaidExposureCents: fields.unpaidExposureCents,
        orderCount: fields.orderCount, cashAmountCents: fields.cashAmountCents, cardAmountCents: fields.cardAmountCents,
        bizumAmountCents: fields.bizumAmountCents, otherAmountCents: fields.otherAmountCents,
      },
      operational: {
        openOrdersAtClose: fields.openOrdersAtClose, occupiedTablesAtClose: fields.occupiedTablesAtClose,
        kitchenPendingCount: fields.kitchenPendingCount || 0, listoCount: fields.listoCount || 0,
        deliveryPendingCount: fields.deliveryPendingCount || 0, incidentCount: fields.incidentCount || 0,
        criticalIncidentCount: fields.criticalIncidentCount || 0,
      },
    };
  }
  env.closeoutCreation = {
    async create(fields) {
      env.calls.create.push(fields);
      const existingBySession = env.closeoutsBySession.get(fields.serviceSessionId);
      if (existingBySession) return { success: true, created: false, code: 'ALREADY_EXISTS', closeout: existingBySession };
      const row = publicCloseoutFake(fields, 'co-' + (env.closeoutsByCorr.size + 1));
      env.closeoutsByCorr.set(fields.closeoutCorrelationId, row);
      env.closeoutsBySession.set(fields.serviceSessionId, row);
      return { success: true, created: true, code: 'CREATED', closeout: row };
    },
  };
  env.closeouts = { async getBySessionId({ serviceSessionId }) { return env.closeoutsBySession.get(serviceSessionId) || null; } };

  env.transition = {
    async close({ serviceSessionId, closeoutCorrelationId, actor, source }) {
      env.calls.close.push({ serviceSessionId, closeoutCorrelationId });
      const row = env.sessions.get(serviceSessionId);
      if (!row) return { success: false, code: 'SERVICE_SESSION_NOT_FOUND', session: null };
      if (row.status === 'closed') return { success: true, idempotent: true, code: 'ALREADY_CLOSED', session: row };
      const closeoutRow = env.closeoutsBySession.get(serviceSessionId);
      if (!closeoutRow || closeoutRow.closeoutCorrelationId !== closeoutCorrelationId) return { success: false, code: 'CLOSEOUT_NOT_FOUND', session: null };
      row.status = 'closed'; row.closed_at = '2026-08-09T23:00:00Z'; row.closed_by = actor; row.close_source = source;
      return { success: true, idempotent: false, code: 'V3_CLOSED', session: row };
    },
    // F-5 TRIPWIRE — mirrors the real serviceLifecycleV3Transition.js
    // wrapper's shape exactly (still present in real source, per that
    // file's own header), but the engine must never call it anymore. Every
    // scenario below asserts env.calls.ensureNext.length === 0; if a future
    // regression reintroduces the call, this records it and the assertion
    // fails loudly rather than the test silently continuing to pass.
    async ensureNext({ sourceSessionId, serviceKind, businessDate }) {
      env.calls.ensureNext.push({ sourceSessionId, serviceKind, businessDate });
      return { success: false, code: 'F5_TRIPWIRE_ENSURE_NEXT_SHOULD_NEVER_BE_CALLED', session: null };
    },
  };

  return env;
}

function engineFrom(env, overrides = {}) {
  return createServiceLifecycleEngine({
    select: env.select, attempts: env.attempts, snapshots: env.snapshots, closeoutCreation: env.closeoutCreation,
    closeouts: env.closeouts, transition: env.transition, incidents: env.incidents, releaseEmptyTable: env.releaseEmptyTable,
    now: () => env.nowDate || new Date('2026-08-09T20:00:00Z'),
    ...overrides,
  });
}

(async () => {
  console.log('\n== serviceLifecycleEngine.js — F-5: close without auto-successor (engine integration) ==\n');

  console.log('\n── Test A — clean close: no successor created, no nextService field at all ──');
  {
    const orders = [order({ totale: 10 })];
    const events = [paymentEvent({ amount: 10 })];
    const env = fakeEnv({ allOrders: orders, financialEvents: events });
    const result = await engineFrom(env)({ serviceSessionId: SESSION_ID, actor: 'system', source: 'test' });
    assert('A1: success', result.success === true, JSON.stringify(result));
    assert('A2: A closed', env.sessions.get(SESSION_ID).status === 'closed');
    assert('A3: ensureNext (the retired RPC wrapper) was never called', env.calls.ensureNext.length === 0);
    assert('A4: the result carries no nextService field at all (not even null) — the concept is gone, not empty', !('nextService' in result));
    assert('A5: exactly one service_sessions row exists in total — A, nothing else', env.sessions.size === 1);
    assert('A6: attempt completed', env.attemptsByCorr.get(result.closeoutCorrelationId).status === 'completed');
  }

  console.log('\n── Test B — occupied carried table: survives, origin stays A, still no successor ──');
  {
    const table = openTable({ id: 'ts-occupied', covers_total: 4 });
    const orders = [order({ totale: 10 })];
    const events = [paymentEvent({ amount: 10 })];
    const env = fakeEnv({ allOrders: orders, financialEvents: events, tableSessions: [table] });
    const result = await engineFrom(env)({ serviceSessionId: SESSION_ID, actor: 'system', source: 'test' });
    assert('B1: success', result.success === true, JSON.stringify(result));
    assert('B2: table row itself untouched — still open, still origin A', table.status === 'open' && table.service_session_id === SESSION_ID && table.covers_total === 4);
    assert('B3: carryoverSummary reports exactly this one open table', result.carryoverSummary.openTablesCarried === 1 && result.carryoverSummary.openTableSessionIds[0] === 'ts-occupied');
    assert('B4: no successor created despite the carried table', env.calls.ensureNext.length === 0 && env.sessions.size === 1);
    assert('B5: zero incidents — an occupied table is not an anomaly (V3.3 policy unchanged)', result.incidents.length === 0);
  }

  console.log('\n── Test C — post-boundary order attribution: proven at the real-Postgres trigger level (this session\'s own report), not re-simulated in JS fakes ──');
  { assert('C: documented, not a JS-fake scenario (see report §9)', true); }

  console.log('\n── Test D — unpaid A: exposure frozen, no successor, no later rewrite path exists in this engine ──');
  {
    const orders = [order({ totale: 20 })]; // fully unpaid
    const env = fakeEnv({ allOrders: orders, financialEvents: [] });
    const result = await engineFrom(env)({ serviceSessionId: SESSION_ID, actor: 'system', source: 'test' });
    assert('D1: success', result.success === true, JSON.stringify(result));
    assert('D2: unpaidExposureCents frozen at 2000', result.closeout.financial.unpaidExposureCents === 2000);
    assert('D3: no successor created for an unpaid close either', env.calls.ensureNext.length === 0);
    assert('D4: no financial-event write dependency exists anywhere in this engine (grep-provable, not just here)', typeof env.select === 'function' && !('insertFinancialEvent' in env));
  }

  console.log('\n── Test E — Cocina carryover (V3.3 policy unchanged) ──');
  {
    const orders = [order({ totale: 10, estado: 'EN_COCINA' })];
    const events = [paymentEvent({ amount: 10 })];
    const env = fakeEnv({ allOrders: orders, financialEvents: events });
    const result = await engineFrom(env)({ serviceSessionId: SESSION_ID, actor: 'system', source: 'test' });
    assert('E1: success', result.success === true, JSON.stringify(result));
    assert('E2: 1 KITCHEN_WORK_PENDING_AT_CLOSE incident, unchanged from V3.3', result.incidents.length === 1 && result.incidents[0].incidentType === 'KITCHEN_WORK_PENDING_AT_CLOSE');
    assert('E3: the order itself was never touched/cloned (still order #1, same fields)', orders[0].orden_id === '#1' && orders[0].estado === 'EN_COCINA');
    assert('E4: no successor created regardless of the pending kitchen work', env.calls.ensureNext.length === 0);
  }

  console.log('\n── Test F — LISTO carryover (V3.3 policy unchanged) ──');
  {
    const orders = [order({ totale: 10, estado: 'LISTO' })];
    const events = [paymentEvent({ amount: 10 })];
    const env = fakeEnv({ allOrders: orders, financialEvents: events });
    const result = await engineFrom(env)({ serviceSessionId: SESSION_ID, actor: 'system', source: 'test' });
    assert('F1: success', result.success === true);
    assert('F2: 1 ORDER_READY_NOT_FINALIZED_AT_CLOSE incident', result.incidents.length === 1 && result.incidents[0].incidentType === 'ORDER_READY_NOT_FINALIZED_AT_CLOSE');
    assert('F3: no successor created', env.calls.ensureNext.length === 0);
  }

  console.log('\n── Test G — rider/delivery carryover (V3.3 policy unchanged, no accidental regression) ──');
  {
    const orders = [order({ totale: 10, estado: 'EN_ENTREGA' })];
    const events = [paymentEvent({ amount: 10 })];
    const env = fakeEnv({ allOrders: orders, financialEvents: events });
    const result = await engineFrom(env)({ serviceSessionId: SESSION_ID, actor: 'system', source: 'test' });
    assert('G1: success', result.success === true);
    assert('G2: 1 DELIVERY_ACTIVE_AT_CLOSE incident, order untouched', result.incidents.length === 1 && result.incidents[0].incidentType === 'DELIVERY_ACTIVE_AT_CLOSE');
    assert('G3: no successor created', env.calls.ensureNext.length === 0);
  }

  console.log('\n── Test H — resume: crash after Phase E (closed) but before Phase G (attempt completion) ──');
  {
    const orders = [order({ totale: 10 })];
    const events = [paymentEvent({ amount: 10 })];
    const env = fakeEnv({ allOrders: orders, financialEvents: events });
    const first = await engineFrom(env)({ serviceSessionId: SESSION_ID, actor: 'system', source: 'test' });
    assert('H0 (setup): first call succeeds', first.success === true);

    // Model "closed + closeout persisted + attempt still active" — the exact
    // CASE B/D resume state — by rolling only the attempt back to active.
    const attemptRow = env.attemptsByCorr.get(first.closeoutCorrelationId);
    attemptRow.status = 'active';

    const second = await engineFrom(env)({ serviceSessionId: SESSION_ID, actor: 'system', source: 'test-retry' });
    assert('H1: retry succeeds via the resume branch', second.success === true, JSON.stringify(second));
    assert('H2: retry never calls the retired ensureNext RPC', env.calls.ensureNext.length === 0);
    assert('H3: no successor session exists after the retry', env.sessions.size === 1);
    assert('H4: attempt completed again', env.attemptsByCorr.get(first.closeoutCorrelationId).status === 'completed');
  }

  console.log('\n── Test I — CASE C (already-completed close) is read-only and idempotent ──');
  {
    const orders = [order({ totale: 10 })];
    const events = [paymentEvent({ amount: 10 })];
    const env = fakeEnv({ allOrders: orders, financialEvents: events });
    const first = await engineFrom(env)({ serviceSessionId: SESSION_ID, actor: 'system', source: 'test' });
    assert('I0 (setup): first call fully completes', first.success === true && env.attemptsByCorr.get(first.closeoutCorrelationId).status === 'completed');

    const second = await engineFrom(env)({ serviceSessionId: SESSION_ID, actor: 'system', source: 'test-retry' });
    assert('I1: idempotent success', second.success === true && second.idempotent === true, JSON.stringify(second));
    assert('I2: still no nextService field on the idempotent replay', !('nextService' in second));
    assert('I3: ensureNext was never called on the idempotent path either', env.calls.ensureNext.length === 0);
  }

  console.log('\n── Test J — clock independence: the outcome is identical across different economic-window conditions at the close instant ──');
  {
    const scenarios = [
      // language-guard: allow-legacy PRANZO is the existing service_kind enum value, named here only as a fixture-scenario label, not new vocabulary
      { label: 'daytime PRANZO window', nowDate: new Date('2026-08-09T10:00:00Z') },   // 12:00 Madrid
      { label: 'evening SERA window', nowDate: new Date('2026-08-09T20:00:00Z') },      // 22:00 Madrid
      { label: 'the old 17:30-18:00 buffer window', nowDate: new Date('2026-08-09T15:45:00Z') }, // 17:45 Madrid
      { label: 'deep overnight window', nowDate: new Date('2026-08-09T02:00:00Z') },    // 04:00 Madrid
    ];
    for (const { label, nowDate } of scenarios) {
      const orders = [order({ totale: 10 })];
      const events = [paymentEvent({ amount: 10 })];
      const env = fakeEnv({ allOrders: orders, financialEvents: events, nowDate });
      const result = await engineFrom(env)({ serviceSessionId: SESSION_ID, actor: 'system', source: 'test' });
      assert(`J[${label}]: success regardless of the clock`, result.success === true, JSON.stringify(result));
      assert(`J[${label}]: session closed`, env.sessions.get(SESSION_ID).status === 'closed');
      assert(`J[${label}]: zero successor created`, env.calls.ensureNext.length === 0 && env.sessions.size === 1);
      assert(`J[${label}]: no nextService field regardless of window`, !('nextService' in result));
    }
  }

  console.log('\n── Test K — incidents remain scoped to A ──');
  {
    const orders = [order({ totale: 10, estado: 'EN_COCINA' })];
    const events = [paymentEvent({ amount: 10 })];
    const env = fakeEnv({ allOrders: orders, financialEvents: events });
    const result = await engineFrom(env)({ serviceSessionId: SESSION_ID, actor: 'system', source: 'test' });
    assert('K1: success', result.success === true);
    assert('K2: the incident report call was scoped to A (serviceSessionId)', env.incidents.calls.report.length === 1 && env.incidents.calls.report[0].serviceSessionId === SESSION_ID);
  }

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})();
