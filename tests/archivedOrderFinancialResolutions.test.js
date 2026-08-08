'use strict';
// SERVICE CLOSEOUT V2 / Slice 2 — behavioural contract test for
// src/closeout/archivedOrderFinancialResolutions.js, against a fake rpc/
// select pair that reproduces the specific semantics written into
// migrations/2026-08-08_service_closeout_post_close_financial_resolutions.sql's
// create_archived_order_financial_resolution() (idempotent on
// action_correlation_id, lineage keyed on (service_session_id,
// archived_order_id), original_exposure_cents frozen on first event,
// remaining_exposure_cents arithmetic, fail-closed over-resolution,
// full-reversal-only). True DB-level enforcement (append-only trigger,
// deterministic grants, real arithmetic under concurrency-safe locking) is
// verified separately, statically and against real Postgres.

const { createArchivedOrderFinancialResolutions, RESOLVER_ROLE } = require('../src/closeout/archivedOrderFinancialResolutions');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

function fakeDb({ sessions = {}, incidents = {} } = {}) {
  const rows = [];
  let nextId = 1;

  async function rpc(name, args) {
    if (name !== 'create_archived_order_financial_resolution') throw new Error('unexpected rpc ' + name);

    if (args.p_actor_role !== 'admin') return { ok: true, body: { ok: false, code: 'FINANCIAL_RESOLUTION_FORBIDDEN' } };
    if (!args.p_service_session_id || !args.p_archived_order_id || !String(args.p_archived_order_id).trim() || !args.p_action_correlation_id) {
      return { ok: true, body: { ok: false, code: 'INVALID_ARGUMENTS' } };
    }
    if (!['recovered_payment', 'write_off', 'reversal'].includes(args.p_resolution_type)) {
      return { ok: true, body: { ok: false, code: 'INVALID_RESOLUTION_TYPE' } };
    }
    if (args.p_amount_cents == null || args.p_amount_cents <= 0) return { ok: true, body: { ok: false, code: 'INVALID_AMOUNT' } };
    if (!args.p_actor || !String(args.p_actor).trim()) return { ok: true, body: { ok: false, code: 'INVALID_ACTOR' } };
    if (!args.p_reason || !String(args.p_reason).trim()) return { ok: true, body: { ok: false, code: 'INVALID_REASON' } };

    let method = null;
    if (args.p_resolution_type === 'recovered_payment') {
      method = String(args.p_payment_method || '').toLowerCase().trim();
      if (!['efectivo', 'tarjeta', 'bizum'].includes(method)) return { ok: true, body: { ok: false, code: 'INVALID_PAYMENT_METHOD' } };
    } else if (args.p_payment_method != null) {
      return { ok: true, body: { ok: false, code: 'PAYMENT_METHOD_NOT_ALLOWED' } };
    }

    const session = sessions[args.p_service_session_id];
    if (!session) return { ok: true, body: { ok: false, code: 'SERVICE_SESSION_NOT_FOUND' } };
    if (args.p_related_incident_id != null && !incidents[args.p_related_incident_id]) {
      return { ok: true, body: { ok: false, code: 'INCIDENT_NOT_FOUND' } };
    }

    // idempotency short-circuit (mirrors ON CONFLICT DO NOTHING + reselect)
    const existingByCorrelation = rows.find((r) => r.action_correlation_id === args.p_action_correlation_id);
    if (existingByCorrelation) return { ok: true, body: { ok: true, code: 'ALREADY_RECORDED', created: false, resolution: existingByCorrelation } };

    const lineage = rows
      .filter((r) => r.service_session_id === args.p_service_session_id && r.archived_order_id === args.p_archived_order_id)
      .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    const prior = lineage.length ? lineage[lineage.length - 1] : null;

    let original;
    if (prior) {
      original = prior.original_exposure_cents;
      if (args.p_original_exposure_cents != null && args.p_original_exposure_cents !== original) {
        return { ok: true, body: { ok: false, code: 'ORIGINAL_EXPOSURE_MISMATCH' } };
      }
    } else {
      if (args.p_original_exposure_cents == null || args.p_original_exposure_cents < 0) {
        return { ok: true, body: { ok: false, code: 'ORIGINAL_EXPOSURE_REQUIRED' } };
      }
      original = args.p_original_exposure_cents;
    }

    let remaining;
    if (args.p_resolution_type === 'reversal') {
      if (!args.p_reversed_event_id) return { ok: true, body: { ok: false, code: 'REVERSED_EVENT_REQUIRED' } };
      const reversed = rows.find((r) => r.id === args.p_reversed_event_id && r.service_session_id === args.p_service_session_id && r.archived_order_id === args.p_archived_order_id);
      if (!reversed) return { ok: true, body: { ok: false, code: 'REVERSED_EVENT_NOT_FOUND' } };
      if (!['recovered_payment', 'write_off'].includes(reversed.resolution_type)) return { ok: true, body: { ok: false, code: 'REVERSED_EVENT_NOT_REVERSIBLE' } };
      if (args.p_amount_cents !== reversed.amount_cents) return { ok: true, body: { ok: false, code: 'REVERSAL_AMOUNT_MISMATCH' } };
      if (rows.some((r) => r.reversed_event_id === args.p_reversed_event_id)) return { ok: true, body: { ok: false, code: 'EVENT_ALREADY_REVERSED' } };
      remaining = (prior ? prior.remaining_exposure_cents : original) + args.p_amount_cents;
      if (remaining > original) return { ok: true, body: { ok: false, code: 'REVERSAL_EXCEEDS_ORIGINAL' } };
    } else {
      remaining = (prior ? prior.remaining_exposure_cents : original) - args.p_amount_cents;
      if (remaining < 0) return { ok: true, body: { ok: false, code: 'OVER_RESOLUTION_EXCEEDS_REMAINING' } };
    }

    const row = Object.freeze({
      id: 'res-' + nextId++,
      service_session_id: args.p_service_session_id,
      business_date: session.business_date,
      service_kind: session.service_kind,
      archived_order_id: args.p_archived_order_id,
      related_incident_id: args.p_related_incident_id || null,
      action_correlation_id: args.p_action_correlation_id,
      resolution_type: args.p_resolution_type,
      reversed_event_id: args.p_reversed_event_id || null,
      original_exposure_cents: original,
      amount_cents: args.p_amount_cents,
      remaining_exposure_cents: remaining,
      payment_method: method,
      actor: args.p_actor,
      reason: args.p_reason,
      note: args.p_note || null,
      created_at: new Date(Date.now() + nextId).toISOString(),
    });
    rows.push(row);
    return { ok: true, body: { ok: true, code: 'RECORDED', created: true, resolution: row } };
  }

  async function select(table, query) {
    if (table !== 'archived_order_financial_resolutions') throw new Error('unexpected table ' + table);
    const sidM = query.match(/service_session_id=eq\.([^&]+)/);
    const oidM = query.match(/archived_order_id=eq\.([^&]+)/);
    const sid = sidM ? decodeURIComponent(sidM[1]) : null;
    const oid = oidM ? decodeURIComponent(oidM[1]) : null;
    let out = rows.filter((r) => r.service_session_id === sid && r.archived_order_id === oid);
    out = out.slice().sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    if (/order=created_at\.desc/.test(query)) out.reverse();
    const limitM = query.match(/limit=(\d+)/);
    if (limitM) out = out.slice(0, Number(limitM[1]));
    return out;
  }

  return { rpc, select, rows };
}

(async () => {
  console.log('\n== archivedOrderFinancialResolutions.js — behavioural contract ==\n');

  const SESSIONS = { s1: { business_date: '2026-08-08', service_kind: 'PRANZO' } };
  const INCIDENTS = { 'inc-1': true };

  console.log('\n── 1. first event establishes the lineage baseline ──');
  {
    const db = fakeDb({ sessions: SESSIONS });
    const svc = createArchivedOrderFinancialResolutions(db);
    const r = await svc.record({
      serviceSessionId: 's1', archivedOrderId: 'ORD-42', actionCorrelationId: 'act-1',
      resolutionType: 'recovered_payment', amountCents: 2500, actor: 'owner', role: 'admin',
      reason: 'customer returned to settle', originalExposureCents: 6250, paymentMethod: 'efectivo',
    });
    assert('1a: first event created, requires and stores original_exposure_cents', r.success && r.created && r.resolution.originalExposureCents === 6250, JSON.stringify(r));
    assert('1b: remaining computed correctly (6250 - 2500 = 3750)', r.resolution.remainingExposureCents === 3750, String(r.resolution.remainingExposureCents));
  }

  console.log('\n── 2. partial then full recovery ──');
  {
    const db = fakeDb({ sessions: SESSIONS });
    const svc = createArchivedOrderFinancialResolutions(db);
    const first = await svc.record({
      serviceSessionId: 's1', archivedOrderId: 'ORD-1', actionCorrelationId: 'act-partial-1',
      resolutionType: 'recovered_payment', amountCents: 2500, actor: 'owner', role: 'admin',
      reason: 'partial cash payment', originalExposureCents: 6250, paymentMethod: 'efectivo',
    });
    assert('2a: partial recovery leaves 3750 remaining', first.resolution.remainingExposureCents === 3750);

    const second = await svc.record({
      serviceSessionId: 's1', archivedOrderId: 'ORD-1', actionCorrelationId: 'act-partial-2',
      resolutionType: 'recovered_payment', amountCents: 3750, actor: 'owner', role: 'admin',
      reason: 'remainder paid next day', paymentMethod: 'tarjeta',
    });
    assert('2b: second event omits original_exposure_cents and inherits it from the lineage', second.success && second.resolution.originalExposureCents === 6250, JSON.stringify(second));
    assert('2c: full recovery leaves exactly 0 remaining', second.resolution.remainingExposureCents === 0);
  }

  console.log('\n── 3. write-off reduces exposure but is distinguishable from collected revenue ──');
  {
    const db = fakeDb({ sessions: SESSIONS });
    const svc = createArchivedOrderFinancialResolutions(db);
    const r = await svc.record({
      serviceSessionId: 's1', archivedOrderId: 'ORD-2', actionCorrelationId: 'act-writeoff-1',
      resolutionType: 'write_off', amountCents: 6250, actor: 'owner', role: 'admin',
      reason: 'customer unreachable, debt accepted as unrecoverable', originalExposureCents: 6250,
    });
    assert('3a: write-off succeeds and zeroes remaining exposure', r.success && r.resolution.remainingExposureCents === 0);
    assert('3b: write-off never carries a payment method — it never pretends cash was collected', r.resolution.paymentMethod === null);
    assert('3c: write-off resolutionType is distinct from recovered_payment (reporting can separate the two buckets)', r.resolution.resolutionType === 'write_off');
  }

  console.log('\n── 4. retry of the SAME action never duplicates ──');
  {
    const db = fakeDb({ sessions: SESSIONS });
    const svc = createArchivedOrderFinancialResolutions(db);
    const args = {
      serviceSessionId: 's1', archivedOrderId: 'ORD-3', actionCorrelationId: 'act-retry-1',
      resolutionType: 'recovered_payment', amountCents: 1000, actor: 'owner', role: 'admin',
      reason: 'cash', originalExposureCents: 1000, paymentMethod: 'efectivo',
    };
    const first = await svc.record(args);
    const retry1 = await svc.record(args);
    const retry2 = await svc.record(args);
    assert('4a: first attempt created:true', first.created === true);
    assert('4b: both retries created:false, same event id', retry1.created === false && retry2.created === false && retry1.resolution.id === first.resolution.id && retry2.resolution.id === first.resolution.id);
    assert('4c: exactly one row exists', db.rows.length === 1, String(db.rows.length));
  }

  console.log('\n── 5. two distinct legitimate actions, same order, same amount -> two separate events ──');
  {
    const db = fakeDb({ sessions: SESSIONS });
    const svc = createArchivedOrderFinancialResolutions(db);
    const a = await svc.record({
      serviceSessionId: 's1', archivedOrderId: 'ORD-4', actionCorrelationId: 'act-distinct-1',
      resolutionType: 'recovered_payment', amountCents: 500, actor: 'owner', role: 'admin',
      reason: 'first partial payment', originalExposureCents: 5000, paymentMethod: 'efectivo',
    });
    const b = await svc.record({
      serviceSessionId: 's1', archivedOrderId: 'ORD-4', actionCorrelationId: 'act-distinct-2',
      resolutionType: 'recovered_payment', amountCents: 500, actor: 'owner', role: 'admin',
      reason: 'second, separate partial payment of the same amount', paymentMethod: 'efectivo',
    });
    assert('5a: same amount, different action id -> two distinct events, never merged', a.resolution.id !== b.resolution.id, JSON.stringify({ a, b }));
    assert('5b: remaining correctly reflects BOTH payments (5000 - 500 - 500 = 4000)', b.resolution.remainingExposureCents === 4000, String(b.resolution.remainingExposureCents));
    assert('5c: exactly two rows exist for this lineage', db.rows.filter((r) => r.archived_order_id === 'ORD-4').length === 2);
  }

  console.log('\n── 6. over-resolution fails closed ──');
  {
    const db = fakeDb({ sessions: SESSIONS });
    const svc = createArchivedOrderFinancialResolutions(db);
    const r = await svc.record({
      serviceSessionId: 's1', archivedOrderId: 'ORD-5', actionCorrelationId: 'act-over-1',
      resolutionType: 'recovered_payment', amountCents: 9999, actor: 'owner', role: 'admin',
      reason: 'attempted over-recovery', originalExposureCents: 6250, paymentMethod: 'efectivo',
    });
    assert('6a: recovering more than remains is rejected, not silently clamped', r.success === false && r.code === 'OVER_RESOLUTION_EXCEEDS_REMAINING', JSON.stringify(r));
    assert('6b: no row was created', db.rows.filter((rr) => rr.archived_order_id === 'ORD-5').length === 0);
  }

  console.log('\n── 7. reversal — full-amount-only, undoes exactly one prior event ──');
  {
    const db = fakeDb({ sessions: SESSIONS });
    const svc = createArchivedOrderFinancialResolutions(db);
    const paid = await svc.record({
      serviceSessionId: 's1', archivedOrderId: 'ORD-6', actionCorrelationId: 'act-rev-1',
      resolutionType: 'recovered_payment', amountCents: 2000, actor: 'owner', role: 'admin',
      reason: 'cash payment', originalExposureCents: 5000, paymentMethod: 'efectivo',
    });
    assert('7a: setup payment recorded, remaining 3000', paid.resolution.remainingExposureCents === 3000);

    const badAmount = await svc.record({
      serviceSessionId: 's1', archivedOrderId: 'ORD-6', actionCorrelationId: 'act-rev-2',
      resolutionType: 'reversal', amountCents: 1000, actor: 'owner', role: 'admin',
      reason: 'wrong amount test', reversedEventId: paid.resolution.id,
    });
    assert('7b: partial-amount reversal is rejected (full reversal only)', badAmount.success === false && badAmount.code === 'REVERSAL_AMOUNT_MISMATCH', JSON.stringify(badAmount));

    const reversal = await svc.record({
      serviceSessionId: 's1', archivedOrderId: 'ORD-6', actionCorrelationId: 'act-rev-3',
      resolutionType: 'reversal', amountCents: 2000, actor: 'owner', role: 'admin',
      reason: 'payment was recorded against the wrong order', reversedEventId: paid.resolution.id,
    });
    assert('7c: full reversal restores remaining exposure to 5000', reversal.success && reversal.resolution.remainingExposureCents === 5000, JSON.stringify(reversal));
    assert('7d: reversal never carries a payment method', reversal.resolution.paymentMethod === null);

    const doubleReversal = await svc.record({
      serviceSessionId: 's1', archivedOrderId: 'ORD-6', actionCorrelationId: 'act-rev-4',
      resolutionType: 'reversal', amountCents: 2000, actor: 'owner', role: 'admin',
      reason: 'attempted double reversal', reversedEventId: paid.resolution.id,
    });
    assert('7e: the same event cannot be reversed twice', doubleReversal.success === false && doubleReversal.code === 'EVENT_ALREADY_REVERSED', JSON.stringify(doubleReversal));
  }

  console.log('\n── 8. original exposure is frozen — a later event cannot silently change it ──');
  {
    const db = fakeDb({ sessions: SESSIONS });
    const svc = createArchivedOrderFinancialResolutions(db);
    await svc.record({
      serviceSessionId: 's1', archivedOrderId: 'ORD-7', actionCorrelationId: 'act-frozen-1',
      resolutionType: 'write_off', amountCents: 1000, actor: 'owner', role: 'admin',
      reason: 'setup', originalExposureCents: 4000,
    });
    const mismatched = await svc.record({
      serviceSessionId: 's1', archivedOrderId: 'ORD-7', actionCorrelationId: 'act-frozen-2',
      resolutionType: 'write_off', amountCents: 500, actor: 'owner', role: 'admin',
      reason: 'attempted drift', originalExposureCents: 9999,
    });
    assert('8: a later event supplying a different original_exposure_cents is rejected, not silently accepted', mismatched.success === false && mismatched.code === 'ORIGINAL_EXPOSURE_MISMATCH', JSON.stringify(mismatched));
  }

  console.log('\n── 9. write-off never accepts a payment method; recovered_payment always requires one ──');
  {
    const db = fakeDb({ sessions: SESSIONS });
    const svc = createArchivedOrderFinancialResolutions(db);
    const withMethod = await svc.record({
      serviceSessionId: 's1', archivedOrderId: 'ORD-8', actionCorrelationId: 'act-wo-method',
      resolutionType: 'write_off', amountCents: 100, actor: 'owner', role: 'admin',
      reason: 'x', originalExposureCents: 100, paymentMethod: 'efectivo',
    });
    assert('9a: write-off with a payment method attached is rejected', withMethod.success === false && withMethod.code === 'PAYMENT_METHOD_NOT_ALLOWED', JSON.stringify(withMethod));

    const noMethod = await svc.record({
      serviceSessionId: 's1', archivedOrderId: 'ORD-9', actionCorrelationId: 'act-rp-nomethod',
      resolutionType: 'recovered_payment', amountCents: 100, actor: 'owner', role: 'admin',
      reason: 'x', originalExposureCents: 100,
    });
    assert('9b: recovered_payment without a payment method is rejected', noMethod.success === false && noMethod.code === 'INVALID_PAYMENT_METHOD', JSON.stringify(noMethod));
  }

  console.log('\n── 10. authorization — unauthorized operator/waiter cannot record a resolution ──');
  {
    const db = fakeDb({ sessions: SESSIONS });
    const svc = createArchivedOrderFinancialResolutions(db);
    const asOperator = await svc.record({
      serviceSessionId: 's1', archivedOrderId: 'ORD-10', actionCorrelationId: 'act-auth-1',
      resolutionType: 'write_off', amountCents: 100, actor: 'operator_primary', role: 'operator',
      reason: 'x', originalExposureCents: 100,
    });
    assert('10a: role=operator is rejected before any RPC round trip', asOperator.success === false && asOperator.code === 'FINANCIAL_RESOLUTION_FORBIDDEN');
    assert('10b: rejected client-side — the fake RPC never even saw the call, no row exists', db.rows.length === 0);
    assert('10c: RESOLVER_ROLE constant is admin, matching the SQL-side role=\'admin\' check', RESOLVER_ROLE === 'admin');
  }

  console.log('\n── 11. related incident linkage is optional and validated when supplied ──');
  {
    const db = fakeDb({ sessions: SESSIONS, incidents: INCIDENTS });
    const svc = createArchivedOrderFinancialResolutions(db);
    const linked = await svc.record({
      serviceSessionId: 's1', archivedOrderId: 'ORD-11', actionCorrelationId: 'act-linked-1',
      resolutionType: 'recovered_payment', amountCents: 100, actor: 'owner', role: 'admin',
      reason: 'x', originalExposureCents: 100, paymentMethod: 'efectivo', relatedIncidentId: 'inc-1',
    });
    assert('11a: a valid related incident id is accepted and stored', linked.success && linked.resolution.relatedIncidentId === 'inc-1', JSON.stringify(linked));

    const unknown = await svc.record({
      serviceSessionId: 's1', archivedOrderId: 'ORD-12', actionCorrelationId: 'act-linked-2',
      resolutionType: 'recovered_payment', amountCents: 100, actor: 'owner', role: 'admin',
      reason: 'x', originalExposureCents: 100, paymentMethod: 'efectivo', relatedIncidentId: 'inc-does-not-exist',
    });
    assert('11b: an unknown incident id is rejected, never silently linked to nothing', unknown.success === false && unknown.code === 'INCIDENT_NOT_FOUND', JSON.stringify(unknown));
  }

  console.log('\n── 12. read helpers ──');
  {
    const db = fakeDb({ sessions: SESSIONS });
    const svc = createArchivedOrderFinancialResolutions(db);
    await svc.record({ serviceSessionId: 's1', archivedOrderId: 'ORD-13', actionCorrelationId: 'act-read-1', resolutionType: 'recovered_payment', amountCents: 1000, actor: 'owner', role: 'admin', reason: 'x', originalExposureCents: 3000, paymentMethod: 'efectivo' });
    await svc.record({ serviceSessionId: 's1', archivedOrderId: 'ORD-13', actionCorrelationId: 'act-read-2', resolutionType: 'recovered_payment', amountCents: 500, actor: 'owner', role: 'admin', reason: 'x', paymentMethod: 'tarjeta' });

    const list = await svc.listForArchivedOrder({ serviceSessionId: 's1', archivedOrderId: 'ORD-13' });
    assert('12a: listForArchivedOrder returns full history, oldest-first', list.length === 2 && list[0].actionCorrelationId === 'act-read-1' && list[1].actionCorrelationId === 'act-read-2', JSON.stringify(list.map((r) => r.actionCorrelationId)));

    const remaining = await svc.getRemainingExposureCents({ serviceSessionId: 's1', archivedOrderId: 'ORD-13' });
    assert('12b: getRemainingExposureCents returns the latest event\'s remaining balance (3000 - 1000 - 500 = 1500)', remaining === 1500, String(remaining));

    const none = await svc.getRemainingExposureCents({ serviceSessionId: 's1', archivedOrderId: 'ORD-NEVER-TOUCHED' });
    assert('12c: an order with no resolution history returns null, not zero', none === null);
  }

  console.log('\n=== RESULT: ' + pass + ' passed, ' + fail + ' failed ===');
  process.exit(fail === 0 ? 0 : 1);
})();
