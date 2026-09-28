'use strict';
// SERVICE LIFECYCLE V3 / Slice 3.2.1 — explicit retry/ownership state machine.
// Proves the order-count heuristic removed from serviceLifecycleEngine.js is
// truly gone and replaced by lineage-only decisions (service_closeouts /
// service_closeout_attempts), against fake dependencies (no live DB — same
// rationale as tests/serviceLifecycleV3CloseEngine.test.js). Each scenario
// maps to one lettered case from the session's own spec:
//   A — open, no closeout, active/new attempt -> normal close flow
//   B — open, closeout exists, attempt active -> resume, no second closeout
//   C — closed, closeout exists, attempt completed -> exact idempotent success
//   D — closed, closeout exists, attempt still active -> finish bookkeeping only
//   E — closed, no V3 lineage at all -> refuse, never fabricate
//   F — zero orders -> behaves exactly like any other happy-path service
// Scenarios A and F's "closes normally" half are already covered by Scenario
// A in tests/serviceLifecycleV3CloseEngine.test.js; this file focuses on the
// RETRY/ownership decisions layered on top.

const { createServiceLifecycleEngine } = require('../src/serviceSessions/serviceLifecycleEngine');
const { withEvidenceTerminal } = require('./helpers/v3EvidenceTerminalFake');

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

// Same fake shape as tests/serviceLifecycleV3CloseEngine.test.js's fakeEnv()
// (Map-keyed on closeoutCorrelationId/serviceSessionId, mirroring the real
// UNIQUE constraints), but this file also allows a caller to directly SEED
// env.attemptsByCorr/closeoutsByCorr BEFORE the first closeServiceV3() call —
// simulating "a prior process already ran Phase D/E and then crashed" without
// needing to actually inject a throw into a fake dependency.
function fakeEnv({ sessionRow = session(), allOrders = [], tableSessions = [], financialEvents = [] } = {}) {
  const env = {
    sessions: new Map([[sessionRow.id, { ...sessionRow }]]),
    attemptsByCorr: new Map(),
    attemptsBySession: new Map(),
    snapshotsByCorr: new Map(),
    closeoutsByCorr: new Map(),
    closeoutsBySession: new Map(),
    calls: { acquire: [], capture: [], create: [], close: [], complete: [], getCloseoutBySession: [], getAttemptByCorr: [] },
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
      if (row.status === 'completed') return { success: true, idempotent: true, code: 'ALREADY_COMPLETED', attempt: row };
      row.status = 'completed';
      return { success: true, idempotent: false, code: 'COMPLETED', attempt: row };
    },
    async getByCorrelationId({ closeoutCorrelationId }) {
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
      const row = { id: 'snap-' + (env.snapshotsByCorr.size + 1), serviceSessionId, closeoutCorrelationId, payload, capturedAt: '2026-08-09T22:59:00Z' };
      env.snapshotsByCorr.set(closeoutCorrelationId, row);
      return { success: true, created: true, code: 'CAPTURED', snapshot: row };
    },
    // R4 — CASE D reads the snapshot back by correlation (closeoutSnapshots.js getByCorrelationId).
    async getByCorrelationId({ closeoutCorrelationId }) {
      return env.snapshotsByCorr.get(closeoutCorrelationId) || null;
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
      closedAt: fields.closedAt || '2026-08-09T22:59:30Z',
      financial: {
        grossSalesCents: fields.grossSalesCents, netSalesCents: fields.netSalesCents, totalDiscountsCents: 0,
        totalRefundsCents: fields.totalRefundsCents, totalVoidCents: fields.totalVoidCents,
        paidAmountCents: fields.paidAmountCents, unpaidExposureCents: fields.unpaidExposureCents, orderCount: fields.orderCount,
        cashAmountCents: fields.cashAmountCents, cardAmountCents: fields.cardAmountCents,
        bizumAmountCents: fields.bizumAmountCents, otherAmountCents: fields.otherAmountCents,
      },
      operational: {
        openOrdersAtClose: fields.openOrdersAtClose, occupiedTablesAtClose: fields.occupiedTablesAtClose,
        kitchenPendingCount: 0, listoCount: 0, deliveryPendingCount: 0, incidentCount: 0, criticalIncidentCount: 0,
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

  // Helper for tests that seed an intermediate crash state directly, rather
  // than injecting a throw and catching it — models "a prior, separate
  // process/request already got this far, then died" precisely and
  // deterministically (see file header).
  env.seedAttempt = (corrId, status, extra = {}) => {
    const row = { closeoutCorrelationId: corrId, serviceSessionId: SESSION_ID, status, createdBy: 'system', ...extra };
    env.attemptsByCorr.set(corrId, row);
    env.attemptsBySession.set(SESSION_ID, row);
    return row;
  };
  env.seedCloseout = (corrId, extra = {}) => {
    const row = publicCloseoutFake({
      serviceSessionId: SESSION_ID, closeoutCorrelationId: corrId, source: 'seed', closedBy: 'system',
      grossSalesCents: 1000, netSalesCents: 1000, totalRefundsCents: 0, totalVoidCents: 0,
      paidAmountCents: 1000, unpaidExposureCents: 0, orderCount: 1,
      cashAmountCents: 1000, cardAmountCents: 0, bizumAmountCents: 0, otherAmountCents: 0,
      openOrdersAtClose: 0, occupiedTablesAtClose: 0, ...extra,
    }, 'co-seed-' + corrId);
    env.closeoutsByCorr.set(corrId, row);
    env.closeoutsBySession.set(SESSION_ID, row);
    return row;
  };

  // R4 — CASE D's proof reads the snapshot and the reconciliation of the
  // SAME correlation, written in close order before the session's closed_at.
  env.reconciliationBySession = new Map();
  env.seedSnapshot = (corrId, extra = {}) => {
    const row = { id: 'snap-seed-' + corrId, serviceSessionId: SESSION_ID, closeoutCorrelationId: corrId, capturedAt: '2026-08-09T22:59:00Z', ...extra };
    env.snapshotsByCorr.set(corrId, row);
    return row;
  };
  env.seedReconciliation = (corrId, extra = {}) => {
    const row = { id: 'rec-seed-' + corrId, serviceSessionId: SESSION_ID, closeoutCorrelationId: corrId, createdAt: '2026-08-09T22:59:45Z', ...extra };
    env.reconciliationBySession.set(row.serviceSessionId, row);
    return row;
  };
  env.seedRealizedClose = (corrId) => { env.seedAttempt(corrId, 'active'); env.seedCloseout(corrId); env.seedSnapshot(corrId); env.seedReconciliation(corrId); };

  // R4B — migration 149's terminal step (the engine's only transition call):
  // this fake's own close and its own attempt completion, committed together
  // or not at all; ALREADY_CLOSED is a success only for a completed attempt.
  env.transition.closeAndCompleteAttempt = async (args) => {
    const row = env.sessions.get(args.serviceSessionId);
    const before = row ? { ...row } : null;
    const rollback = () => { if (row) { for (const k of Object.keys(row)) if (!(k in before)) delete row[k]; Object.assign(row, before); } };
    const closed = await env.transition.close(args);
    if (!closed.success) return closed;
    const attempt = env.attemptsByCorr.get(args.closeoutCorrelationId);
    if (closed.code === 'ALREADY_CLOSED') {
      return attempt && attempt.status === 'completed' ? { ...closed, attemptCompleted: true } : { success: false, code: 'CLOSED_ATTEMPT_NOT_COMPLETED', session: null };
    }
    let done;
    try { done = await env.attempts.complete({ closeoutCorrelationId: args.closeoutCorrelationId, actor: args.actor }); }
    catch (e) { rollback(); return { success: false, code: 'SERVICE_LIFECYCLE_V3_TRANSITION_TRANSPORT_ERROR', session: null }; }
    if (!done || done.success !== true || done.code !== 'COMPLETED') { rollback(); return { success: false, code: 'ATTEMPT_COMPLETION_REFUSED', session: null }; }
    return { ...closed, attemptCompleted: true };
  };

  return env;
}

function engineFrom(env) {
  // CORRECTIVE SLICE 150 — the terminal step is close_service_session_with_evidence_v1, modelled on its SQL over the
  // fakes above (tests/helpers/v3EvidenceTerminalFake.js): closeout + reconciliation + close + completion commit together.
  return createServiceLifecycleEngine(withEvidenceTerminal({
    // ACTIVE RIDER TRIP / SERVICE CLOSE GUARD — these unit tests model a service with no
    // rider trip; the guard's own behaviour is proven in tests/activeRiderTripServiceCloseGuard.test.js.
    activeRiderTrip: env.activeRiderTrip || (async () => ({ ok: true, active: false })),
    select: env.select, attempts: env.attempts, snapshots: env.snapshots,
    closeoutCreation: env.closeoutCreation, closeouts: env.closeouts, transition: env.transition,
    // J-1 — the engine persists the close's economic context between Phase D
    // and Phase E. These are unit tests with no database, so inject a stub
    // that records the call. A test can override env.reconciliation to prove
    // the close FAILS CLOSED (service stays open) when context cannot persist.
    // R4 — getBySessionId serves CASE D's read of the persisted context.
    reconciliation: env.reconciliation || {
      getBySessionId: async ({ serviceSessionId }) => env.reconciliationBySession.get(serviceSessionId) || null,
      persist: async ({ closeoutCorrelationId }) => ({
        success: true,
        created: true,
        reconciliation: { closeoutCorrelationId, stubbed: true },
      }),
    },
  }, {
    calls: env.calls,
    isClosed: (id) => { const row = env.sessions.get(id); return !!row && row.status === 'closed'; },
    isStale: (args) => (env.isStale ? env.isStale(args) : null),
    receipts: () => env.receipts || [],
    rollbackCloseout: (row) => { env.closeoutsByCorr.delete(row.closeoutCorrelationId); env.closeoutsBySession.delete(row.serviceSessionId); },
  }));
}

function noNewMutation(env) {
  return env.calls.acquire.length === 0 && env.calls.create.length === 0
    && env.calls.close.length === 0 && env.calls.complete.length === 0;
}

(async () => {
  console.log('\n== serviceLifecycleEngine.js — Slice 3.2.1 explicit retry/ownership state machine ==\n');

  console.log('\n── H: CASE F then CASE C — zero-order service closes normally, THEN retries as exact idempotent success ──');
  console.log('    (THE regression test: the removed order-count heuristic used to wrongly refuse exactly this retry)');
  {
    const env = fakeEnv({ allOrders: [], tableSessions: [], financialEvents: [] });
    const closeServiceV3 = engineFrom(env);

    const first = await closeServiceV3({ serviceSessionId: SESSION_ID, actor: 'system', source: 'test' });
    assert('H1: first call (zero orders) succeeds', first.success === true, JSON.stringify(first));
    assert('H2: order_count is 0', first.closeout.financial.orderCount === 0);
    assert('H3: attempt completed cleanly on the first call', env.attemptsByCorr.get(first.closeoutCorrelationId).status === 'completed');

    const callsBefore = JSON.parse(JSON.stringify({ acquire: env.calls.acquire.length, create: env.calls.create.length, close: env.calls.close.length, complete: env.calls.complete.length }));
    const second = await closeServiceV3({ serviceSessionId: SESSION_ID, actor: 'system', source: 'retry' });
    assert('H4: retry of a zero-order closed service SUCCEEDS (never V3_CLOSE_SESSION_ALREADY_CLOSED_NOT_RECOVERABLE)', second.success === true, JSON.stringify(second));
    assert('H5: retry resumes the SAME correlation id', second.closeoutCorrelationId === first.closeoutCorrelationId);
    assert('H6: retry is a pure read-only short-circuit — zero new acquire/create/close/complete calls', env.calls.acquire.length === callsBefore.acquire && env.calls.create.length === callsBefore.create && env.calls.close.length === callsBefore.close && env.calls.complete.length === callsBefore.complete, JSON.stringify(env.calls));
    assert('H7: still exactly one closeout — no fabrication, no duplicate', env.closeoutsByCorr.size === 1);
    assert('H8: getBySessionId (lineage check) WAS called on the retry — proves the decision is lineage-driven', env.calls.getCloseoutBySession.length === 2);
  }

  console.log('\n── I: CASE B — resume after crash between closeout persistence and terminal transition ──');
  {
    const env = fakeEnv({ allOrders: [order()], financialEvents: [paymentEvent()] });
    const corrId = 'corr-seed-1';
    env.seedAttempt(corrId, 'active');
    env.seedCloseout(corrId);
    // session left 'open' in env.sessions — Phase D succeeded, Phase E never ran.

    const closeServiceV3 = engineFrom(env);
    const result = await closeServiceV3({ serviceSessionId: SESSION_ID, actor: 'system', source: 'resume' });
    assert('I1: resume succeeds', result.success === true, JSON.stringify(result));
    assert('I2: resumes the seeded correlation id', result.closeoutCorrelationId === corrId);
    assert('I3: acquire() is NEVER called — the retry never mints/touches a new attempt', env.calls.acquire.length === 0);
    assert('I4: create() is NEVER called — no second closeout', env.calls.create.length === 0 && env.closeoutsByCorr.size === 1);
    assert('I5: transition.close() WAS called exactly once — the real, still-pending transition now happens', env.calls.close.length === 1);
    assert('I6: session is now actually closed', env.sessions.get(SESSION_ID).status === 'closed');
    assert('I7: attempts.complete() WAS called exactly once — bookkeeping finished', env.calls.complete.length === 1);
    assert('I8: attempt ends up completed', env.attemptsByCorr.get(corrId).status === 'completed');
  }

  console.log('\n── I-R4B: CASE B resume whose completion is refused — the close is rolled back with it, no success is reported ──');
  {
    const env = fakeEnv({ allOrders: [order()], financialEvents: [paymentEvent()] });
    const corrId = 'corr-seed-r4b';
    env.seedAttempt(corrId, 'active');
    env.seedCloseout(corrId);
    const realComplete = env.attempts.complete;
    env.attempts.complete = async (a) => { env.calls.complete.push(a); return { success: false, code: 'CANNOT_COMPLETE_SUPERSEDED_ATTEMPT' }; };
    const r1 = await engineFrom(env)({ serviceSessionId: SESSION_ID, actor: 'system', source: 'resume' });
    assert('I-R4B-1: refused, never V3_CLOSED', r1.success === false && r1.code === 'ATTEMPT_COMPLETION_REFUSED', JSON.stringify(r1));
    assert('I-R4B-2: the service is still open and the attempt still active (the close rolled back with the refused completion)', env.sessions.get(SESSION_ID).status === 'open' && env.attemptsByCorr.get(corrId).status === 'active');
    env.attempts.complete = realComplete;
    const r2 = await engineFrom(env)({ serviceSessionId: SESSION_ID, actor: 'system', source: 'resume' });
    assert('I-R4B-3: the next resume closes and completes together', r2.success === true && r2.closeoutCorrelationId === corrId && env.sessions.get(SESSION_ID).status === 'closed' && env.attemptsByCorr.get(corrId).status === 'completed', JSON.stringify(r2));
    assert('I-R4B-4: still one closeout, no acquire', env.closeoutsByCorr.size === 1 && env.calls.acquire.length === 0 && env.calls.create.length === 0);
  }

  console.log('\n── J: CASE D — resume after crash between terminal transition and attempt-complete bookkeeping ──');
  {
    const env = fakeEnv({ sessionRow: session({ status: 'closed', closed_at: '2026-08-09T23:00:00Z' }) });
    const corrId = 'corr-seed-2';
    env.seedRealizedClose(corrId);
    // session is ALREADY 'closed' in env.sessions — Phase E succeeded, Phase F never ran.

    const closeServiceV3 = engineFrom(env);
    const result = await closeServiceV3({ serviceSessionId: SESSION_ID, actor: 'system', source: 'resume' });
    assert('J1: resume succeeds', result.success === true, JSON.stringify(result));
    assert('J2: resumes the seeded correlation id', result.closeoutCorrelationId === corrId);
    assert('J3: acquire() is NEVER called', env.calls.acquire.length === 0);
    assert('J4: create() is NEVER called — no second closeout', env.calls.create.length === 0 && env.closeoutsByCorr.size === 1);
    assert('J5: transition.close() is NEVER called — the session is already terminal (R4: no pointer-dependent transition)', env.calls.close.length === 0);
    assert('J6: attempts.complete() WAS called exactly once — finishes the pending bookkeeping', env.calls.complete.length === 1);
    assert('J7: attempt ends up completed', env.attemptsByCorr.get(corrId).status === 'completed');
  }

  console.log('\n── R4: CASE D after the NEXT service opened — completion proven from the session\'s own facts, never from the pointer ──');
  const closedA = () => session({ status: 'closed', closed_at: '2026-08-09T23:00:00Z' });
  const pointerMovedOn = (env) => {
    // close_service_session_v3 as it answers once B is current: a closed A is no longer
    // (recent_closed = A AND current IS NULL), so every call would be an identity mismatch.
    env.transition.close = async (args) => { env.calls.close.push(args); return { success: false, code: 'SESSION_CLOSE_IDENTITY_MISMATCH', session: null }; };
  };
  {
    const env = fakeEnv({ sessionRow: closedA() });
    const corrId = 'corr-r4';
    env.seedRealizedClose(corrId);
    pointerMovedOn(env);
    const closeServiceV3 = engineFrom(env);
    const r1 = await closeServiceV3({ serviceSessionId: SESSION_ID, actor: 'system', source: 'resume' });
    assert('R4-1: resume succeeds although the pointer moved on', r1.success === true && r1.code === 'V3_CLOSED' && r1.idempotent === true, JSON.stringify(r1));
    assert('R4-2: same correlation, same closeout', r1.closeoutCorrelationId === corrId && r1.closeout.closeoutCorrelationId === corrId);
    assert('R4-3: no transition asked, no acquire, no create', env.calls.close.length === 0 && env.calls.acquire.length === 0 && env.calls.create.length === 0);
    assert('R4-4: attempt completed exactly once', env.calls.complete.length === 1 && env.attemptsByCorr.get(corrId).status === 'completed');
    assert('R4-5: result carries the closed session and the persisted reconciliation', r1.session && r1.session.status === 'closed' && r1.reconciliation && r1.reconciliation.closeoutCorrelationId === corrId);
    const r2 = await closeServiceV3({ serviceSessionId: SESSION_ID, actor: 'system', source: 'resume' });
    assert('R4-6: a later retry is CASE C — read-only idempotent success', r2.success === true && r2.idempotent === true && env.calls.complete.length === 1 && env.calls.close.length === 0, JSON.stringify(r2));
  }
  {
    const env = fakeEnv({ sessionRow: closedA() });
    env.seedRealizedClose('corr-r4c');
    const closeServiceV3 = engineFrom(env);
    const [a, b] = await Promise.all([
      closeServiceV3({ serviceSessionId: SESSION_ID, actor: 'system', source: 'caller-1' }),
      closeServiceV3({ serviceSessionId: SESSION_ID, actor: 'system', source: 'caller-2' }),
    ]);
    assert('R4-7: two concurrent resumes both succeed on the same correlation', a.success && b.success && a.closeoutCorrelationId === 'corr-r4c' && b.closeoutCorrelationId === 'corr-r4c', JSON.stringify([a, b]));
    assert('R4-8: the attempt ends completed; no closeout, transition or acquire', env.attemptsByCorr.get('corr-r4c').status === 'completed' && env.closeoutsByCorr.size === 1 && env.calls.close.length === 0 && env.calls.acquire.length === 0);
  }
  const refusedCase = async (label, prep, expectCode, expectMissing) => {
    const env = fakeEnv({ sessionRow: closedA() });
    const corrId = 'corr-neg';
    env.seedRealizedClose(corrId);
    prep(env, corrId);
    const closeServiceV3 = engineFrom(env);
    const r = await closeServiceV3({ serviceSessionId: SESSION_ID, actor: 'system', source: 'resume' });
    const status = env.attemptsByCorr.get(corrId) ? env.attemptsByCorr.get(corrId).status : null;
    assert(`${label}: refused (${expectCode})`, r.success === false && r.code === expectCode && (!expectMissing || (r.missing || []).includes(expectMissing)), JSON.stringify(r));
    assert(`${label}: attempt NOT completed, nothing written`, status !== 'completed' && env.calls.create.length === 0 && env.calls.close.length === 0 && env.calls.acquire.length === 0);
  };
  await refusedCase('R4-N1 snapshot missing', (env, c) => env.snapshotsByCorr.delete(c), 'V3_CLOSE_RESUME_EVIDENCE_INCOMPLETE', 'snapshot');
  await refusedCase('R4-N2 snapshot of another service', (env, c) => { env.snapshotsByCorr.get(c).serviceSessionId = 'sess-B'; }, 'V3_CLOSE_RESUME_EVIDENCE_INCOMPLETE', 'snapshot');
  await refusedCase('R4-N3 reconciliation missing (never recreated)', (env) => env.reconciliationBySession.clear(), 'V3_CLOSE_RESUME_EVIDENCE_INCOMPLETE', 'reconciliation');
  await refusedCase('R4-N4 reconciliation of another correlation', (env) => { env.seedReconciliation('corr-other'); }, 'V3_CLOSE_RESUME_EVIDENCE_INCOMPLETE', 'reconciliation');
  await refusedCase('R4-N5 session closed BEFORE the closeout existed', (env) => { env.sessions.get(SESSION_ID).closed_at = '2026-08-09T22:59:10Z'; }, 'V3_CLOSE_RESUME_EVIDENCE_INCOMPLETE', 'close_order');
  await refusedCase('R4-N6 closed session without closed_at', (env) => { env.sessions.get(SESSION_ID).closed_at = null; }, 'V3_CLOSE_RESUME_EVIDENCE_INCOMPLETE', 'session_closed_at');
  await refusedCase('R4-N7 completion refused by the RPC (superseded meanwhile)', (env) => { env.attempts.complete = async (a) => { env.calls.complete.push(a); return { success: false, code: 'CANNOT_COMPLETE_SUPERSEDED_ATTEMPT' }; }; }, 'CANNOT_COMPLETE_SUPERSEDED_ATTEMPT');
  await refusedCase('R4-N8 completion transport failure -> no success reported', (env) => { env.attempts.complete = async (a) => { env.calls.complete.push(a); throw new Error('network'); }; }, 'V3_CLOSE_ATTEMPT_COMPLETE_FAILED');
  {
    const env = fakeEnv({ sessionRow: closedA() });
    env.seedRealizedClose('corr-r4r');
    env.snapshots.getByCorrelationId = async () => { throw new Error('read failed'); };
    const r = await engineFrom(env)({ serviceSessionId: SESSION_ID, actor: 'system', source: 'resume' });
    assert('R4-N9: an evidence read failure fails closed', r.success === false && r.code === 'V3_CLOSE_LINEAGE_READ_FAILED' && env.calls.complete.length === 0, JSON.stringify(r));
  }

  console.log('\n── K: CASE C — exact idempotent success on an already fully-completed lineage (pure read-only) ──');
  {
    const env = fakeEnv({ sessionRow: session({ status: 'closed' }) });
    const corrId = 'corr-seed-3';
    env.seedAttempt(corrId, 'completed', { completedAt: '2026-08-09T23:05:00Z' });
    env.seedCloseout(corrId);

    const closeServiceV3 = engineFrom(env);
    const result = await closeServiceV3({ serviceSessionId: SESSION_ID, actor: 'system', source: 'retry' });
    assert('K1: exact retry succeeds', result.success === true, JSON.stringify(result));
    assert('K2: resumes the seeded correlation id', result.closeoutCorrelationId === corrId);
    assert('K3: idempotent flag is true', result.idempotent === true);
    assert('K4: ZERO calls to acquire/create/close/complete — pure read-only short-circuit', noNewMutation(env), JSON.stringify(env.calls));
    assert('K5: the lineage reads themselves DID happen (getBySessionId + getByCorrelationId), proving the decision was lineage-based, not skipped', env.calls.getCloseoutBySession.length === 1 && env.calls.getAttemptByCorr.length === 1);
  }

  console.log('\n── L: CASE E — externally/legacy-closed service, no V3 lineage at all — refused regardless of order count ──');
  {
    const envZero = fakeEnv({ sessionRow: session({ status: 'closed' }), allOrders: [] });
    const closeServiceV3Zero = engineFrom(envZero);
    const resultZero = await closeServiceV3Zero({ serviceSessionId: SESSION_ID, actor: 'system', source: 'test' });
    assert('L1: zero-order externally-closed session is refused', resultZero.success === false, JSON.stringify(resultZero));
    assert('L2: code is V3_CLOSE_SESSION_ALREADY_CLOSED_NOT_RECOVERABLE', resultZero.code === 'V3_CLOSE_SESSION_ALREADY_CLOSED_NOT_RECOVERABLE');
    assert('L3: no mutation attempted', noNewMutation(envZero));

    const envNonZero = fakeEnv({ sessionRow: session({ status: 'closed' }), allOrders: [order(), order({ orden_id: '#2', id: '#2' })] });
    const closeServiceV3NonZero = engineFrom(envNonZero);
    const resultNonZero = await closeServiceV3NonZero({ serviceSessionId: SESSION_ID, actor: 'system', source: 'test' });
    assert('L4: non-zero-order externally-closed session is ALSO refused — same code, order count is irrelevant now', resultNonZero.success === false && resultNonZero.code === 'V3_CLOSE_SESSION_ALREADY_CLOSED_NOT_RECOVERABLE', JSON.stringify(resultNonZero));
    assert('L5: no mutation attempted here either', noNewMutation(envNonZero));
    assert('L6: orders were never even read for either case — the lineage check refuses before Phase B', envZero.select === envZero.select /* sanity */ , '');
  }

  console.log('\n── M: CASE E variant — externally closed WITH an unrelated stray active attempt cannot fabricate a closeout ──');
  {
    const env = fakeEnv({ sessionRow: session({ status: 'closed' }) });
    // A stray attempt exists (e.g. abandoned, or created by some other
    // mechanism) but NO service_closeouts row was ever created for it.
    env.seedAttempt('corr-stray', 'active');

    const closeServiceV3 = engineFrom(env);
    const result = await closeServiceV3({ serviceSessionId: SESSION_ID, actor: 'system', source: 'test' });
    assert('M1: refused', result.success === false && result.code === 'V3_CLOSE_SESSION_ALREADY_CLOSED_NOT_RECOVERABLE', JSON.stringify(result));
    assert('M2: no closeout was fabricated', env.closeoutsByCorr.size === 0);
    assert('M3: the stray attempt was NEVER read/touched — the lineage check never reaches attempts when no closeout exists', env.calls.getAttemptByCorr.length === 0);
    assert('M4: the stray attempt is untouched, still active', env.attemptsByCorr.get('corr-stray').status === 'active');
    assert('M5: no mutation attempted', noNewMutation(env));
  }

  console.log('\n── N: concurrent retry — two concurrent callers converge when CASE B state already exists ──');
  {
    const env = fakeEnv({ allOrders: [order()], financialEvents: [paymentEvent()] });
    const corrId = 'corr-seed-4';
    env.seedAttempt(corrId, 'active');
    env.seedCloseout(corrId);

    const closeServiceV3 = engineFrom(env);
    const [r1, r2] = await Promise.all([
      closeServiceV3({ serviceSessionId: SESSION_ID, actor: 'system', source: 'caller-1' }),
      closeServiceV3({ serviceSessionId: SESSION_ID, actor: 'system', source: 'caller-2' }),
    ]);
    assert('N1: both concurrent retries succeed', r1.success === true && r2.success === true, JSON.stringify([r1, r2]));
    assert('N2: both resume the SAME correlation id', r1.closeoutCorrelationId === corrId && r2.closeoutCorrelationId === corrId);
    assert('N3: still exactly one closeout — no duplicate under concurrency', env.closeoutsByCorr.size === 1);
    assert('N4: session ends up closed exactly once', env.sessions.get(SESSION_ID).status === 'closed');
    assert('N5: neither caller ever called acquire() or create()', env.calls.acquire.length === 0 && env.calls.create.length === 0);
  }

  console.log('\n── O: fail-closed on an inconsistent lineage — never guess, never fabricate ──');
  {
    // A closeout row whose OWN serviceSessionId disagrees with the session it
    // was looked up under (should be structurally impossible under the real
    // service_closeouts_session_uq constraint — proves the engine does not
    // blindly trust it anyway).
    const env = fakeEnv({});
    env.closeoutsBySession.set(SESSION_ID, {
      serviceSessionId: 'SOME-OTHER-SESSION', closeoutCorrelationId: 'corr-mismatch',
      operational: { occupiedTablesAtClose: 0 },
    });
    const closeServiceV3 = engineFrom(env);
    const result = await closeServiceV3({ serviceSessionId: SESSION_ID, actor: 'system', source: 'test' });
    assert('O1: refused as LINEAGE_INVALID, not silently trusted', result.success === false && result.code === 'V3_CLOSE_LINEAGE_INVALID', JSON.stringify(result));
    assert('O2: no mutation attempted', noNewMutation(env));
  }
  {
    // A closeout exists and matches, but its attempt is missing entirely
    // (impossible under the real FK — proves fail-closed instead of a crash
    // or a guessed outcome).
    const env = fakeEnv({});
    const corrId = 'corr-dangling';
    env.seedCloseout(corrId); // creates the closeout only, deliberately no seedAttempt()
    const closeServiceV3 = engineFrom(env);
    const result = await closeServiceV3({ serviceSessionId: SESSION_ID, actor: 'system', source: 'test' });
    assert('O3: refused as LINEAGE_INVALID when the attempt row is missing', result.success === false && result.code === 'V3_CLOSE_LINEAGE_INVALID', JSON.stringify(result));
    assert('O4: no mutation attempted', noNewMutation(env));
  }
  {
    // A closeout's attempt is 'superseded' — structurally unreachable in the
    // real system (create_service_closeout requires ACTIVE at insert time),
    // but the engine must still refuse rather than guess.
    const env = fakeEnv({ sessionRow: session({ status: 'closed' }) });
    const corrId = 'corr-superseded';
    env.seedAttempt(corrId, 'superseded');
    env.seedCloseout(corrId);
    const closeServiceV3 = engineFrom(env);
    const result = await closeServiceV3({ serviceSessionId: SESSION_ID, actor: 'system', source: 'test' });
    assert('O5: refused as LINEAGE_INVALID for a superseded owning attempt', result.success === false && result.code === 'V3_CLOSE_LINEAGE_INVALID', JSON.stringify(result));
    assert('O6: no mutation attempted', noNewMutation(env));
  }

  console.log('\n=== RESULT: ' + pass + ' passed, ' + fail + ' failed ===');
  process.exit(fail === 0 ? 0 : 1);
})();
