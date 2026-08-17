'use strict';
// SERVICE CLOSEOUT V2 / Slice 2 (hardened in Slice 2.1) — behavioural
// contract test for src/closeout/archivedOrderFinancialResolutions.js,
// against a fake rpc/select pair that reproduces the specific semantics
// written into
// migrations/2026-08-08_service_closeout_post_close_financial_resolutions.sql's
// create_archived_order_financial_resolution() (idempotent on
// action_correlation_id, lineage keyed on (service_session_id,
// archived_order_id), original_exposure_cents derived server-side from the
// mandatory linked incident and frozen thereafter, remaining_exposure_cents
// arithmetic, fail-closed over-resolution, full-reversal-only,
// lineage_sequence as the sole accounting-order primitive). True DB-level
// enforcement (append-only trigger, deterministic grants, real arithmetic
// under concurrency-safe locking) is verified separately, statically and
// against real Postgres.

const { createArchivedOrderFinancialResolutions, RESOLVER_ROLE } = require('../src/closeout/archivedOrderFinancialResolutions');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

function fakeDb({ sessions = {}, incidents = {}, archivedOrders = new Set() } = {}) {
  const rows = [];
  let nextId = 1;

  async function rpc(name, args) {
    if (name !== 'create_archived_order_financial_resolution') throw new Error('unexpected rpc ' + name);

    if (args.p_actor_role !== 'admin') return { ok: true, body: { ok: false, code: 'FINANCIAL_RESOLUTION_FORBIDDEN' } };
    if (!args.p_service_session_id || !args.p_archived_order_id || !String(args.p_archived_order_id).trim() || !args.p_action_correlation_id) {
      return { ok: true, body: { ok: false, code: 'INVALID_ARGUMENTS' } };
    }
    if (args.p_related_incident_id == null) return { ok: true, body: { ok: false, code: 'INCIDENT_LINK_REQUIRED' } };
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
    // F-4C — era-aware: a missing lifecycle_semantics defaults to
    // 'economic_period_v1', mirroring the real column's own DEFAULT. Only a
    // NULL kind on an economic_period_v1 parent is rejected;
    // operational_service_v1 + NULL kind is valid by construction (S-B's own
    // CHECK already forbids any other combination from existing at all).
    const era = session.lifecycle_semantics || 'economic_period_v1';
    if (era === 'economic_period_v1' && session.service_kind == null) {
      return { ok: true, body: { ok: false, code: 'SERVICE_SESSION_MISSING_KIND' } };
    }

    // SLICE 2.1 — the archived order itself must exist, keyed on the same
    // (service_session_id, orden_id) pair storico is keyed on.
    if (!archivedOrders.has(args.p_service_session_id + '::' + args.p_archived_order_id)) {
      return { ok: true, body: { ok: false, code: 'ARCHIVED_ORDER_NOT_FOUND' } };
    }

    // SLICE 2.1 — mandatory incident linkage, validated on every dimension.
    const incident = incidents[args.p_related_incident_id];
    if (!incident) return { ok: true, body: { ok: false, code: 'INCIDENT_NOT_FOUND' } };
    if (incident.service_session_id !== args.p_service_session_id) return { ok: true, body: { ok: false, code: 'INCIDENT_SERVICE_MISMATCH' } };
    if (incident.category !== 'financial') return { ok: true, body: { ok: false, code: 'INCIDENT_NOT_FINANCIAL' } };
    if (incident.order_id !== args.p_archived_order_id) return { ok: true, body: { ok: false, code: 'INCIDENT_ORDER_MISMATCH' } };

    // SLICE 2.2 — idempotency is bound to the exact command, not just the
    // correlation id. A correlation id reused with a different amount/type/
    // order/session/incident/paymentMethod/reversedEventId is a conflict,
    // never a silent "already recorded" of somebody else's event.
    const existingByCorrelation = rows.find((r) => r.action_correlation_id === args.p_action_correlation_id);
    if (existingByCorrelation) {
      const incomingMethod = args.p_payment_method == null ? null : String(args.p_payment_method).toLowerCase().trim();
      const conflicts =
        existingByCorrelation.service_session_id !== args.p_service_session_id ||
        existingByCorrelation.archived_order_id !== args.p_archived_order_id ||
        existingByCorrelation.related_incident_id !== args.p_related_incident_id ||
        existingByCorrelation.resolution_type !== args.p_resolution_type ||
        existingByCorrelation.amount_cents !== args.p_amount_cents ||
        existingByCorrelation.payment_method !== incomingMethod ||
        (existingByCorrelation.reversed_event_id || null) !== (args.p_reversed_event_id || null);
      if (conflicts) return { ok: true, body: { ok: false, code: 'ACTION_CORRELATION_ID_CONFLICT' } };
      return { ok: true, body: { ok: true, code: 'ALREADY_RECORDED', created: false, resolution: existingByCorrelation } };
    }

    const lineage = rows
      .filter((r) => r.service_session_id === args.p_service_session_id && r.archived_order_id === args.p_archived_order_id)
      .sort((a, b) => a.lineage_sequence - b.lineage_sequence);
    const prior = lineage.length ? lineage[lineage.length - 1] : null;

    let original;
    let sequence;
    if (prior) {
      original = prior.original_exposure_cents;
      sequence = prior.lineage_sequence + 1;
      if (args.p_related_incident_id !== prior.related_incident_id) return { ok: true, body: { ok: false, code: 'INCIDENT_LINK_MISMATCH' } };
    } else {
      // First event: original exposure is DERIVED from the incident, never
      // caller-supplied — there is no p_original_exposure_cents parameter at
      // all in the SLICE 2.1 contract.
      original = incident.financial_exposure_cents;
      sequence = 1;
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
      lifecycle_semantics: era,
      archived_order_id: args.p_archived_order_id,
      related_incident_id: args.p_related_incident_id,
      action_correlation_id: args.p_action_correlation_id,
      resolution_type: args.p_resolution_type,
      reversed_event_id: args.p_reversed_event_id || null,
      original_exposure_cents: original,
      amount_cents: args.p_amount_cents,
      remaining_exposure_cents: remaining,
      lineage_sequence: sequence,
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
    out = out.slice().sort((a, b) => a.lineage_sequence - b.lineage_sequence);
    if (/order=lineage_sequence\.desc/.test(query)) out.reverse();
    const limitM = query.match(/limit=(\d+)/);
    if (limitM) out = out.slice(0, Number(limitM[1]));
    return out;
  }

  return { rpc, select, rows };
}

(async () => {
  console.log('\n== archivedOrderFinancialResolutions.js — behavioural contract ==\n');

  const SESSIONS = { s1: { business_date: '2026-08-08', service_kind: 'PRANZO' }, s2: { business_date: '2026-08-08', service_kind: 'SERA' } };
  // F-4C — era-aware fixtures. s1/s2 above omit lifecycle_semantics
  // entirely, matching every pre-F-4C session in this suite; the fakeDb
  // defaults a missing lifecycle_semantics to 'economic_period_v1',
  // mirroring the real column's own DEFAULT.
  SESSIONS.s3 = { business_date: '2026-08-17', service_kind: null, lifecycle_semantics: 'operational_service_v1' };
  SESSIONS.s4 = { business_date: '2026-08-17', service_kind: null, lifecycle_semantics: 'economic_period_v1' };
  // One financial incident per archived order used across the suite, keyed
  // (session, order) exactly like the RPC validates it.
  const INCIDENTS = {
    'inc-42': { service_session_id: 's1', category: 'financial', order_id: 'ORD-42', financial_exposure_cents: 6250 },
    'inc-1': { service_session_id: 's1', category: 'financial', order_id: 'ORD-1', financial_exposure_cents: 6250 },
    'inc-2': { service_session_id: 's1', category: 'financial', order_id: 'ORD-2', financial_exposure_cents: 6250 },
    'inc-3': { service_session_id: 's1', category: 'financial', order_id: 'ORD-3', financial_exposure_cents: 2500 },
    'inc-4': { service_session_id: 's1', category: 'financial', order_id: 'ORD-4', financial_exposure_cents: 5000 },
    'inc-5': { service_session_id: 's1', category: 'financial', order_id: 'ORD-5', financial_exposure_cents: 6250 },
    'inc-6': { service_session_id: 's1', category: 'financial', order_id: 'ORD-6', financial_exposure_cents: 5000 },
    'inc-7': { service_session_id: 's1', category: 'financial', order_id: 'ORD-7', financial_exposure_cents: 4000 },
    'inc-7b': { service_session_id: 's1', category: 'financial', order_id: 'ORD-7', financial_exposure_cents: 4000 },
    'inc-8': { service_session_id: 's1', category: 'financial', order_id: 'ORD-8', financial_exposure_cents: 100 },
    'inc-9': { service_session_id: 's1', category: 'financial', order_id: 'ORD-9', financial_exposure_cents: 100 },
    'inc-10': { service_session_id: 's1', category: 'financial', order_id: 'ORD-10', financial_exposure_cents: 100 },
    'inc-13': { service_session_id: 's1', category: 'financial', order_id: 'ORD-13', financial_exposure_cents: 3000 },
    'inc-op': { service_session_id: 's1', category: 'operational', order_id: 'ORD-OP', financial_exposure_cents: null },
    'inc-other-session': { service_session_id: 's2', category: 'financial', order_id: 'ORD-42', financial_exposure_cents: 6250 },
    'inc-wrong-order': { service_session_id: 's1', category: 'financial', order_id: 'ORD-DIFFERENT', financial_exposure_cents: 6250 },
    // Slice 2.2 collision-test fixtures
    'inc-14': { service_session_id: 's1', category: 'financial', order_id: 'ORD-14', financial_exposure_cents: 9000 },
    'inc-14b': { service_session_id: 's1', category: 'financial', order_id: 'ORD-14', financial_exposure_cents: 9000 },
    'inc-15': { service_session_id: 's1', category: 'financial', order_id: 'ORD-15', financial_exposure_cents: 9000 },
    'inc-16': { service_session_id: 's2', category: 'financial', order_id: 'ORD-16', financial_exposure_cents: 9000 },
    // F-4C — era-aware fixtures.
    'inc-s3': { service_session_id: 's3', category: 'financial', order_id: 'ORD-S3', financial_exposure_cents: 4000 },
    'inc-s4': { service_session_id: 's4', category: 'financial', order_id: 'ORD-S4', financial_exposure_cents: 4000 },
  };
  const ARCHIVED_ORDERS = new Set([
    's1::ORD-42', 's1::ORD-1', 's1::ORD-2', 's1::ORD-3', 's1::ORD-4', 's1::ORD-5', 's1::ORD-6', 's1::ORD-7',
    's1::ORD-8', 's1::ORD-9', 's1::ORD-10', 's1::ORD-11', 's1::ORD-12', 's1::ORD-13', 's1::ORD-OP', 's2::ORD-42',
    's1::ORD-14', 's1::ORD-15', 's2::ORD-16',
    's3::ORD-S3', 's4::ORD-S4',
  ]);

  console.log('\n── 1. first event establishes the lineage baseline — exposure DERIVED from the incident, never caller-supplied ──');
  {
    const db = fakeDb({ sessions: SESSIONS, incidents: INCIDENTS, archivedOrders: ARCHIVED_ORDERS });
    const svc = createArchivedOrderFinancialResolutions(db);
    const r = await svc.record({
      serviceSessionId: 's1', archivedOrderId: 'ORD-42', relatedIncidentId: 'inc-42', actionCorrelationId: 'act-1',
      resolutionType: 'recovered_payment', amountCents: 2500, actor: 'owner', role: 'admin',
      reason: 'customer returned to settle', paymentMethod: 'efectivo',
    });
    assert('1a: first event created, original_exposure_cents derived from the incident (6250)', r.success && r.created && r.resolution.originalExposureCents === 6250, JSON.stringify(r));
    assert('1b: remaining computed correctly (6250 - 2500 = 3750)', r.resolution.remainingExposureCents === 3750, String(r.resolution.remainingExposureCents));
    assert('1c: lineage_sequence of the first event is 1', r.resolution.lineageSequence === 1, String(r.resolution.lineageSequence));

    console.log('\n── 1d. caller cannot pass originalExposureCents at all — record() throws synchronously ──');
    let threw = false;
    try {
      await svc.record({
        serviceSessionId: 's1', archivedOrderId: 'ORD-1', relatedIncidentId: 'inc-1', actionCorrelationId: 'act-forced-exposure',
        resolutionType: 'recovered_payment', amountCents: 100, actor: 'owner', role: 'admin', reason: 'x',
        originalExposureCents: 5000, paymentMethod: 'efectivo',
      });
    } catch (e) { threw = true; }
    assert('1d: a caller trying to force original_exposure_cents=5000 (when the incident says 6250) fails loudly, not silently', threw);
    assert('1e: the forced call never even reached the RPC (no row for ORD-1)', db.rows.filter((r) => r.archived_order_id === 'ORD-1').length === 0);
  }

  console.log('\n── 2. partial then full recovery ──');
  {
    const db = fakeDb({ sessions: SESSIONS, incidents: INCIDENTS, archivedOrders: ARCHIVED_ORDERS });
    const svc = createArchivedOrderFinancialResolutions(db);
    const first = await svc.record({
      serviceSessionId: 's1', archivedOrderId: 'ORD-1', relatedIncidentId: 'inc-1', actionCorrelationId: 'act-partial-1',
      resolutionType: 'recovered_payment', amountCents: 2500, actor: 'owner', role: 'admin',
      reason: 'partial cash payment', paymentMethod: 'efectivo',
    });
    assert('2a: partial recovery leaves 3750 remaining', first.resolution.remainingExposureCents === 3750);

    const second = await svc.record({
      serviceSessionId: 's1', archivedOrderId: 'ORD-1', relatedIncidentId: 'inc-1', actionCorrelationId: 'act-partial-2',
      resolutionType: 'recovered_payment', amountCents: 3750, actor: 'owner', role: 'admin',
      reason: 'remainder paid next day', paymentMethod: 'tarjeta',
    });
    assert('2b: second event inherits original_exposure_cents from the lineage (6250)', second.success && second.resolution.originalExposureCents === 6250, JSON.stringify(second));
    assert('2c: full recovery leaves exactly 0 remaining', second.resolution.remainingExposureCents === 0);
    assert('2d: sequence increments 1 -> 2', first.resolution.lineageSequence === 1 && second.resolution.lineageSequence === 2);
  }

  console.log('\n── 3. write-off reduces exposure but is distinguishable from collected revenue ──');
  {
    const db = fakeDb({ sessions: SESSIONS, incidents: INCIDENTS, archivedOrders: ARCHIVED_ORDERS });
    const svc = createArchivedOrderFinancialResolutions(db);
    const r = await svc.record({
      serviceSessionId: 's1', archivedOrderId: 'ORD-2', relatedIncidentId: 'inc-2', actionCorrelationId: 'act-writeoff-1',
      resolutionType: 'write_off', amountCents: 6250, actor: 'owner', role: 'admin',
      reason: 'customer unreachable, debt accepted as unrecoverable',
    });
    assert('3a: write-off succeeds and zeroes remaining exposure', r.success && r.resolution.remainingExposureCents === 0);
    assert('3b: write-off never carries a payment method — it never pretends cash was collected', r.resolution.paymentMethod === null);
    assert('3c: write-off resolutionType is distinct from recovered_payment (reporting can separate the two buckets)', r.resolution.resolutionType === 'write_off');
  }

  console.log('\n── 4. retry of the SAME action never duplicates and never consumes a new sequence number ──');
  {
    const db = fakeDb({ sessions: SESSIONS, incidents: INCIDENTS, archivedOrders: ARCHIVED_ORDERS });
    const svc = createArchivedOrderFinancialResolutions(db);
    const args = {
      serviceSessionId: 's1', archivedOrderId: 'ORD-3', relatedIncidentId: 'inc-3', actionCorrelationId: 'act-retry-1',
      resolutionType: 'recovered_payment', amountCents: 1000, actor: 'owner', role: 'admin',
      reason: 'cash', paymentMethod: 'efectivo',
    };
    const first = await svc.record(args);
    const retry1 = await svc.record(args);
    const retry2 = await svc.record(args);
    assert('4a: first attempt created:true, sequence 1', first.created === true && first.resolution.lineageSequence === 1);
    assert('4b: both retries created:false, same event id, same sequence', retry1.created === false && retry2.created === false && retry1.resolution.id === first.resolution.id && retry2.resolution.id === first.resolution.id && retry1.resolution.lineageSequence === 1);
    assert('4c: exactly one row exists', db.rows.length === 1, String(db.rows.length));

    const genuineNext = await svc.record({
      serviceSessionId: 's1', archivedOrderId: 'ORD-3', relatedIncidentId: 'inc-3', actionCorrelationId: 'act-retry-2',
      resolutionType: 'write_off', amountCents: 1000, actor: 'owner', role: 'admin', reason: 'write off the rest',
    });
    assert('4d: the next GENUINE event after retries gets sequence 2, not 4 or higher', genuineNext.success && genuineNext.resolution.lineageSequence === 2, String(genuineNext.resolution && genuineNext.resolution.lineageSequence));

    // SLICE 2.1 — real-Postgres validation caught this exact case: a retry of
    // an EARLIER event submitted AFTER the lineage has since fully resolved
    // must still return the original event, not be re-evaluated against the
    // now-fully-consumed remaining exposure (which would wrongly reject it
    // with OVER_RESOLUTION_EXCEEDS_REMAINING).
    const retryAfterLineageMovedOn = await svc.record(args);
    assert('4e: retrying event 1 AFTER event 2 already fully consumed the remaining exposure still returns the ORIGINAL event, not a fresh over-resolution rejection', retryAfterLineageMovedOn.success && retryAfterLineageMovedOn.created === false && retryAfterLineageMovedOn.resolution.id === first.resolution.id && retryAfterLineageMovedOn.resolution.lineageSequence === 1, JSON.stringify(retryAfterLineageMovedOn));
    assert('4f: still exactly two rows for this lineage (event1 + genuineNext), the late retry added nothing', db.rows.filter((r) => r.archived_order_id === 'ORD-3').length === 2);
  }

  console.log('\n── 5. two distinct legitimate actions, same order, same amount -> two separate events ──');
  {
    const db = fakeDb({ sessions: SESSIONS, incidents: INCIDENTS, archivedOrders: ARCHIVED_ORDERS });
    const svc = createArchivedOrderFinancialResolutions(db);
    const a = await svc.record({
      serviceSessionId: 's1', archivedOrderId: 'ORD-4', relatedIncidentId: 'inc-4', actionCorrelationId: 'act-distinct-1',
      resolutionType: 'recovered_payment', amountCents: 500, actor: 'owner', role: 'admin',
      reason: 'first partial payment', paymentMethod: 'efectivo',
    });
    const b = await svc.record({
      serviceSessionId: 's1', archivedOrderId: 'ORD-4', relatedIncidentId: 'inc-4', actionCorrelationId: 'act-distinct-2',
      resolutionType: 'recovered_payment', amountCents: 500, actor: 'owner', role: 'admin',
      reason: 'second, separate partial payment of the same amount', paymentMethod: 'efectivo',
    });
    assert('5a: same amount, different action id -> two distinct events, never merged', a.resolution.id !== b.resolution.id, JSON.stringify({ a, b }));
    assert('5b: remaining correctly reflects BOTH payments (5000 - 500 - 500 = 4000)', b.resolution.remainingExposureCents === 4000, String(b.resolution.remainingExposureCents));
    assert('5c: exactly two rows exist for this lineage', db.rows.filter((r) => r.archived_order_id === 'ORD-4').length === 2);
  }

  console.log('\n── 6. over-resolution fails closed ──');
  {
    const db = fakeDb({ sessions: SESSIONS, incidents: INCIDENTS, archivedOrders: ARCHIVED_ORDERS });
    const svc = createArchivedOrderFinancialResolutions(db);
    const r = await svc.record({
      serviceSessionId: 's1', archivedOrderId: 'ORD-5', relatedIncidentId: 'inc-5', actionCorrelationId: 'act-over-1',
      resolutionType: 'recovered_payment', amountCents: 9999, actor: 'owner', role: 'admin',
      reason: 'attempted over-recovery', paymentMethod: 'efectivo',
    });
    assert('6a: recovering more than remains is rejected, not silently clamped', r.success === false && r.code === 'OVER_RESOLUTION_EXCEEDS_REMAINING', JSON.stringify(r));
    assert('6b: no row was created', db.rows.filter((rr) => rr.archived_order_id === 'ORD-5').length === 0);
  }

  console.log('\n── 7. reversal — full-amount-only, undoes exactly one prior event, gets the NEXT sequence ──');
  {
    const db = fakeDb({ sessions: SESSIONS, incidents: INCIDENTS, archivedOrders: ARCHIVED_ORDERS });
    const svc = createArchivedOrderFinancialResolutions(db);
    const paid = await svc.record({
      serviceSessionId: 's1', archivedOrderId: 'ORD-6', relatedIncidentId: 'inc-6', actionCorrelationId: 'act-rev-1',
      resolutionType: 'recovered_payment', amountCents: 2000, actor: 'owner', role: 'admin',
      reason: 'cash payment', paymentMethod: 'efectivo',
    });
    assert('7a: setup payment recorded, remaining 3000, sequence 1', paid.resolution.remainingExposureCents === 3000 && paid.resolution.lineageSequence === 1);

    const badAmount = await svc.record({
      serviceSessionId: 's1', archivedOrderId: 'ORD-6', relatedIncidentId: 'inc-6', actionCorrelationId: 'act-rev-2',
      resolutionType: 'reversal', amountCents: 1000, actor: 'owner', role: 'admin',
      reason: 'wrong amount test', reversedEventId: paid.resolution.id,
    });
    assert('7b: partial-amount reversal is rejected (full reversal only)', badAmount.success === false && badAmount.code === 'REVERSAL_AMOUNT_MISMATCH', JSON.stringify(badAmount));

    const reversal = await svc.record({
      serviceSessionId: 's1', archivedOrderId: 'ORD-6', relatedIncidentId: 'inc-6', actionCorrelationId: 'act-rev-3',
      resolutionType: 'reversal', amountCents: 2000, actor: 'owner', role: 'admin',
      reason: 'payment was recorded against the wrong order', reversedEventId: paid.resolution.id,
    });
    assert('7c: full reversal restores remaining exposure to 5000', reversal.success && reversal.resolution.remainingExposureCents === 5000, JSON.stringify(reversal));
    assert('7d: reversal never carries a payment method', reversal.resolution.paymentMethod === null);
    assert('7e: reversal gets the NEXT sequence (2), not a new lineage', reversal.resolution.lineageSequence === 2);

    const doubleReversal = await svc.record({
      serviceSessionId: 's1', archivedOrderId: 'ORD-6', relatedIncidentId: 'inc-6', actionCorrelationId: 'act-rev-4',
      resolutionType: 'reversal', amountCents: 2000, actor: 'owner', role: 'admin',
      reason: 'attempted double reversal', reversedEventId: paid.resolution.id,
    });
    assert('7f: the same event cannot be reversed twice', doubleReversal.success === false && doubleReversal.code === 'EVENT_ALREADY_REVERSED', JSON.stringify(doubleReversal));
  }

  console.log('\n── 8. original exposure is frozen — a later event cannot change it by pointing at a different incident ──');
  {
    const db = fakeDb({ sessions: SESSIONS, incidents: INCIDENTS, archivedOrders: ARCHIVED_ORDERS });
    const svc = createArchivedOrderFinancialResolutions(db);
    await svc.record({
      serviceSessionId: 's1', archivedOrderId: 'ORD-7', relatedIncidentId: 'inc-7', actionCorrelationId: 'act-frozen-1',
      resolutionType: 'write_off', amountCents: 1000, actor: 'owner', role: 'admin',
      reason: 'setup',
    });
    const mismatched = await svc.record({
      serviceSessionId: 's1', archivedOrderId: 'ORD-7', relatedIncidentId: 'inc-7b', actionCorrelationId: 'act-frozen-2',
      resolutionType: 'write_off', amountCents: 500, actor: 'owner', role: 'admin',
      reason: 'attempted incident swap to a DIFFERENT (but otherwise equally valid: same session, same order, financial) incident row',
    });
    assert('8: a later event pointing at a DIFFERENT incident than the lineage was anchored to is rejected', mismatched.success === false && mismatched.code === 'INCIDENT_LINK_MISMATCH', JSON.stringify(mismatched));
  }

  console.log('\n── 9. write-off never accepts a payment method; recovered_payment always requires one ──');
  {
    const db = fakeDb({ sessions: SESSIONS, incidents: INCIDENTS, archivedOrders: ARCHIVED_ORDERS });
    const svc = createArchivedOrderFinancialResolutions(db);
    const withMethod = await svc.record({
      serviceSessionId: 's1', archivedOrderId: 'ORD-8', relatedIncidentId: 'inc-8', actionCorrelationId: 'act-wo-method',
      resolutionType: 'write_off', amountCents: 100, actor: 'owner', role: 'admin',
      reason: 'x', paymentMethod: 'efectivo',
    });
    assert('9a: write-off with a payment method attached is rejected', withMethod.success === false && withMethod.code === 'PAYMENT_METHOD_NOT_ALLOWED', JSON.stringify(withMethod));

    const noMethod = await svc.record({
      serviceSessionId: 's1', archivedOrderId: 'ORD-9', relatedIncidentId: 'inc-9', actionCorrelationId: 'act-rp-nomethod',
      resolutionType: 'recovered_payment', amountCents: 100, actor: 'owner', role: 'admin',
      reason: 'x',
    });
    assert('9b: recovered_payment without a payment method is rejected', noMethod.success === false && noMethod.code === 'INVALID_PAYMENT_METHOD', JSON.stringify(noMethod));
  }

  console.log('\n── 10. authorization — unauthorized operator/waiter cannot record a resolution ──');
  {
    const db = fakeDb({ sessions: SESSIONS, incidents: INCIDENTS, archivedOrders: ARCHIVED_ORDERS });
    const svc = createArchivedOrderFinancialResolutions(db);
    const asOperator = await svc.record({
      serviceSessionId: 's1', archivedOrderId: 'ORD-10', relatedIncidentId: 'inc-10', actionCorrelationId: 'act-auth-1',
      resolutionType: 'write_off', amountCents: 100, actor: 'operator_primary', role: 'operator',
      reason: 'x',
    });
    assert('10a: role=operator is rejected before any RPC round trip', asOperator.success === false && asOperator.code === 'FINANCIAL_RESOLUTION_FORBIDDEN');
    assert('10b: rejected client-side — the fake RPC never even saw the call, no row exists', db.rows.length === 0);
    assert('10c: RESOLVER_ROLE constant is admin, matching the SQL-side role=\'admin\' check', RESOLVER_ROLE === 'admin');
  }

  console.log('\n── 11. incident linkage is now MANDATORY and validated on every dimension ──');
  {
    const db = fakeDb({ sessions: SESSIONS, incidents: INCIDENTS, archivedOrders: ARCHIVED_ORDERS });
    const svc = createArchivedOrderFinancialResolutions(db);

    const missing = await svc.record({
      serviceSessionId: 's1', archivedOrderId: 'ORD-11', actionCorrelationId: 'act-linked-missing',
      resolutionType: 'recovered_payment', amountCents: 100, actor: 'owner', role: 'admin',
      reason: 'x', paymentMethod: 'efectivo',
    });
    assert('11a: omitting relatedIncidentId entirely is rejected, never treated as "no incident"', missing.success === false && missing.code === 'INCIDENT_LINK_REQUIRED', JSON.stringify(missing));

    const unknown = await svc.record({
      serviceSessionId: 's1', archivedOrderId: 'ORD-12', relatedIncidentId: 'inc-does-not-exist', actionCorrelationId: 'act-linked-unknown',
      resolutionType: 'recovered_payment', amountCents: 100, actor: 'owner', role: 'admin',
      reason: 'x', paymentMethod: 'efectivo',
    });
    assert('11b: an unknown incident id is rejected, never silently linked to nothing', unknown.success === false && unknown.code === 'INCIDENT_NOT_FOUND', JSON.stringify(unknown));

    const nonFinancial = await svc.record({
      serviceSessionId: 's1', archivedOrderId: 'ORD-OP', relatedIncidentId: 'inc-op', actionCorrelationId: 'act-linked-nonfin',
      resolutionType: 'write_off', amountCents: 100, actor: 'owner', role: 'admin', reason: 'x',
    });
    assert('11c: a non-financial incident (category=operational) is rejected', nonFinancial.success === false && nonFinancial.code === 'INCIDENT_NOT_FINANCIAL', JSON.stringify(nonFinancial));

    const wrongService = await svc.record({
      serviceSessionId: 's1', archivedOrderId: 'ORD-42', relatedIncidentId: 'inc-other-session', actionCorrelationId: 'act-linked-wrongsvc',
      resolutionType: 'write_off', amountCents: 100, actor: 'owner', role: 'admin', reason: 'x',
    });
    assert('11d: an incident belonging to a DIFFERENT service_session_id is rejected', wrongService.success === false && wrongService.code === 'INCIDENT_SERVICE_MISMATCH', JSON.stringify(wrongService));

    const wrongOrder = await svc.record({
      serviceSessionId: 's1', archivedOrderId: 'ORD-42', relatedIncidentId: 'inc-wrong-order', actionCorrelationId: 'act-linked-wrongorder',
      resolutionType: 'write_off', amountCents: 100, actor: 'owner', role: 'admin', reason: 'x',
    });
    assert('11e: an incident describing a DIFFERENT order is rejected', wrongOrder.success === false && wrongOrder.code === 'INCIDENT_ORDER_MISMATCH', JSON.stringify(wrongOrder));

    const valid = await svc.record({
      serviceSessionId: 's1', archivedOrderId: 'ORD-42', relatedIncidentId: 'inc-42', actionCorrelationId: 'act-linked-valid',
      resolutionType: 'write_off', amountCents: 100, actor: 'owner', role: 'admin', reason: 'x',
    });
    assert('11f: a valid same-session, same-order, financial incident is accepted and stored', valid.success && valid.resolution.relatedIncidentId === 'inc-42', JSON.stringify(valid));
  }

  console.log('\n── 12. archived-order identity — order numbers are reused across sessions, so identity is the PAIR ──');
  {
    const db = fakeDb({ sessions: SESSIONS, incidents: INCIDENTS, archivedOrders: ARCHIVED_ORDERS });
    const svc = createArchivedOrderFinancialResolutions(db);

    const noSuchOrder = await svc.record({
      serviceSessionId: 's1', archivedOrderId: 'ORD-NEVER-ARCHIVED', relatedIncidentId: 'inc-42', actionCorrelationId: 'act-noorder',
      resolutionType: 'write_off', amountCents: 100, actor: 'owner', role: 'admin', reason: 'x',
    });
    assert('12a: a resolution against an archived order that does not exist in storico is rejected', noSuchOrder.success === false && noSuchOrder.code === 'ARCHIVED_ORDER_NOT_FOUND', JSON.stringify(noSuchOrder));

    // ORD-42 IS archived under s1, but s2 also has an order numbered ORD-42
    // (order numbers are reused) — trying to resolve it under the WRONG
    // session must fail even though the (incident, order id) both "look"
    // valid in isolation.
    const wrongSessionSameOrderNumber = await svc.record({
      serviceSessionId: 's2', archivedOrderId: 'ORD-42', relatedIncidentId: 'inc-other-session', actionCorrelationId: 'act-wrong-session-same-number',
      resolutionType: 'write_off', amountCents: 100, actor: 'owner', role: 'admin', reason: 'x',
    });
    assert('12b: the same order NUMBER under a DIFFERENT (correct) session is a wholly separate lineage, unaffected by s1 ORD-42 history', wrongSessionSameOrderNumber.success && wrongSessionSameOrderNumber.resolution.lineageSequence === 1, JSON.stringify(wrongSessionSameOrderNumber));
  }

  console.log('\n── 13. read helpers order by lineage_sequence, never created_at ──');
  {
    const db = fakeDb({ sessions: SESSIONS, incidents: INCIDENTS, archivedOrders: ARCHIVED_ORDERS });
    const svc = createArchivedOrderFinancialResolutions(db);
    await svc.record({ serviceSessionId: 's1', archivedOrderId: 'ORD-13', relatedIncidentId: 'inc-13', actionCorrelationId: 'act-read-1', resolutionType: 'recovered_payment', amountCents: 1000, actor: 'owner', role: 'admin', reason: 'x', paymentMethod: 'efectivo' });
    await svc.record({ serviceSessionId: 's1', archivedOrderId: 'ORD-13', relatedIncidentId: 'inc-13', actionCorrelationId: 'act-read-2', resolutionType: 'recovered_payment', amountCents: 500, actor: 'owner', role: 'admin', reason: 'x', paymentMethod: 'tarjeta' });

    const list = await svc.listForArchivedOrder({ serviceSessionId: 's1', archivedOrderId: 'ORD-13' });
    assert('13a: listForArchivedOrder returns full history, oldest-first by lineage_sequence', list.length === 2 && list[0].actionCorrelationId === 'act-read-1' && list[1].actionCorrelationId === 'act-read-2', JSON.stringify(list.map((r) => r.actionCorrelationId)));
    assert('13b: sequences are 1 then 2', list[0].lineageSequence === 1 && list[1].lineageSequence === 2);

    const remaining = await svc.getRemainingExposureCents({ serviceSessionId: 's1', archivedOrderId: 'ORD-13' });
    assert('13c: getRemainingExposureCents returns the highest-lineage_sequence row remaining balance (3000 - 1000 - 500 = 1500)', remaining === 1500, String(remaining));

    const none = await svc.getRemainingExposureCents({ serviceSessionId: 's1', archivedOrderId: 'ORD-NEVER-TOUCHED' });
    assert('13d: an order with no resolution history returns null, not zero', none === null);
  }

  console.log('\n── 14. SLICE 2.2 — idempotency is bound to the exact command, not just the correlation id ──');
  {
    const db = fakeDb({ sessions: SESSIONS, incidents: INCIDENTS, archivedOrders: ARCHIVED_ORDERS });
    const svc = createArchivedOrderFinancialResolutions(db);

    const originalArgs = {
      serviceSessionId: 's1', archivedOrderId: 'ORD-14', relatedIncidentId: 'inc-14', actionCorrelationId: 'act-22-X',
      resolutionType: 'recovered_payment', amountCents: 2500, actor: 'owner', role: 'admin',
      reason: 'first partial payment', paymentMethod: 'efectivo',
    };
    const eventA = await svc.record(originalArgs);
    assert('14 setup: event A recorded, seq 1, remaining 6500', eventA.success && eventA.resolution.lineageSequence === 1 && eventA.resolution.remainingExposureCents === 6500);

    // A genuine, later event advances the lineage before any retry happens —
    // exactly the scenario that broke a naive "return existing row" check.
    const eventB = await svc.record({
      serviceSessionId: 's1', archivedOrderId: 'ORD-14', relatedIncidentId: 'inc-14', actionCorrelationId: 'act-22-B',
      resolutionType: 'write_off', amountCents: 1000, actor: 'owner', role: 'admin', reason: 'partial write-off',
    });
    assert('14 setup: event B recorded, seq 2, remaining 5500', eventB.success && eventB.resolution.lineageSequence === 2 && eventB.resolution.remainingExposureCents === 5500);

    console.log('\n  ── 14a. TRUE RETRY after the lineage has advanced — exact same payload succeeds idempotently ──');
    const trueRetry = await svc.record(originalArgs);
    assert('14a: exact retry of X after event B still returns event A, created:false', trueRetry.success && trueRetry.created === false && trueRetry.resolution.id === eventA.resolution.id && trueRetry.resolution.lineageSequence === 1, JSON.stringify(trueRetry));
    assert('14a: no new row was added and no OVER_RESOLUTION_EXCEEDS_REMAINING was raised', db.rows.filter((r) => r.archived_order_id === 'ORD-14').length === 2);

    console.log('\n  ── 14b. AMOUNT COLLISION — same X, different amount -> conflict, fails closed ──');
    const amountCollision = await svc.record({ ...originalArgs, amountCents: 3000 });
    assert('14b: amount collision is rejected as a correlation conflict, not silently accepted or merged', amountCollision.success === false && amountCollision.code === 'ACTION_CORRELATION_ID_CONFLICT', JSON.stringify(amountCollision));
    assert('14b: no new row was added', db.rows.filter((r) => r.archived_order_id === 'ORD-14').length === 2);

    console.log('\n  ── 14c. TYPE COLLISION — same X, recovered_payment replayed as write_off -> conflict ──');
    const typeCollision = await svc.record({ ...originalArgs, resolutionType: 'write_off', paymentMethod: undefined });
    assert('14c: resolution-type collision is rejected', typeCollision.success === false && typeCollision.code === 'ACTION_CORRELATION_ID_CONFLICT', JSON.stringify(typeCollision));

    console.log('\n  ── 14d. ORDER/SESSION COLLISION — same X against a different archived lineage -> conflict ──');
    const orderCollision = await svc.record({ ...originalArgs, archivedOrderId: 'ORD-15', relatedIncidentId: 'inc-15' });
    assert('14d: replaying X against a DIFFERENT archived order is rejected', orderCollision.success === false && orderCollision.code === 'ACTION_CORRELATION_ID_CONFLICT', JSON.stringify(orderCollision));
    const sessionCollision = await svc.record({ ...originalArgs, serviceSessionId: 's2', archivedOrderId: 'ORD-16', relatedIncidentId: 'inc-16' });
    assert('14d: replaying X against a DIFFERENT service_session_id is rejected', sessionCollision.success === false && sessionCollision.code === 'ACTION_CORRELATION_ID_CONFLICT', JSON.stringify(sessionCollision));

    console.log('\n  ── 14e. INCIDENT COLLISION — same X, different (but otherwise valid) linked incident -> conflict ──');
    const incidentCollision = await svc.record({ ...originalArgs, relatedIncidentId: 'inc-14b' });
    assert('14e: replaying X with a different related_incident_id is rejected', incidentCollision.success === false && incidentCollision.code === 'ACTION_CORRELATION_ID_CONFLICT', JSON.stringify(incidentCollision));

    console.log('\n  ── 14f. PAYMENT-METHOD COLLISION — same X, different payment method -> conflict ──');
    const methodCollision = await svc.record({ ...originalArgs, paymentMethod: 'tarjeta' });
    assert('14f: replaying X with a different payment method is rejected', methodCollision.success === false && methodCollision.code === 'ACTION_CORRELATION_ID_CONFLICT', JSON.stringify(methodCollision));

    console.log('\n  ── 14g. REVERSAL-TARGET COLLISION — same correlation, different reversed_event_id -> conflict ──');
    const eventC = await svc.record({
      serviceSessionId: 's1', archivedOrderId: 'ORD-14', relatedIncidentId: 'inc-14', actionCorrelationId: 'act-22-C',
      resolutionType: 'recovered_payment', amountCents: 500, actor: 'owner', role: 'admin', reason: 'second partial payment', paymentMethod: 'tarjeta',
    });
    assert('14g setup: event C recorded, seq 3', eventC.success && eventC.resolution.lineageSequence === 3);
    const reversalArgs = {
      serviceSessionId: 's1', archivedOrderId: 'ORD-14', relatedIncidentId: 'inc-14', actionCorrelationId: 'act-22-REV',
      resolutionType: 'reversal', amountCents: 1000, actor: 'owner', role: 'admin', reason: 'undo the write-off',
      reversedEventId: eventB.resolution.id,
    };
    const reversalOriginal = await svc.record(reversalArgs);
    assert('14g setup: reversal of B recorded, seq 4', reversalOriginal.success && reversalOriginal.resolution.lineageSequence === 4);
    const reversalTargetCollision = await svc.record({ ...reversalArgs, reversedEventId: eventC.resolution.id });
    assert('14g: replaying the SAME reversal correlation against a DIFFERENT reversed_event_id is rejected', reversalTargetCollision.success === false && reversalTargetCollision.code === 'ACTION_CORRELATION_ID_CONFLICT', JSON.stringify(reversalTargetCollision));

    console.log('\n  ── 14h. no collision ever consumes a lineage sequence ──');
    const finalRows = db.rows.filter((r) => r.archived_order_id === 'ORD-14' || r.archived_order_id === 'ORD-15' || r.archived_order_id === 'ORD-16');
    const ord14Rows = db.rows.filter((r) => r.archived_order_id === 'ORD-14');
    assert('14h: ORD-14 lineage has exactly 4 rows (A, B, C, reversal) — every collision attempt above added nothing', ord14Rows.length === 4, String(ord14Rows.length));
    assert('14h: no stray rows were created on ORD-15/ORD-16 by the rejected collision attempts', db.rows.filter((r) => r.archived_order_id === 'ORD-15').length === 0 && db.rows.filter((r) => r.archived_order_id === 'ORD-16').length === 0);
    const sequences = ord14Rows.slice().sort((a, b) => a.lineage_sequence - b.lineage_sequence).map((r) => r.lineage_sequence);
    assert('14h: sequences are exactly [1,2,3,4] — no gaps, no phantom allocations from any rejected collision', JSON.stringify(sequences) === JSON.stringify([1, 2, 3, 4]), JSON.stringify(sequences));
  }

  console.log('\n── 15. F-4C — era-aware: operational_service_v1 + NULL kind is VALID, never rejected ──');
  {
    const db = fakeDb({ sessions: SESSIONS, incidents: INCIDENTS, archivedOrders: ARCHIVED_ORDERS });
    const svc = createArchivedOrderFinancialResolutions(db);

    const legacyNull = await svc.record({
      serviceSessionId: 's4', archivedOrderId: 'ORD-S4', relatedIncidentId: 'inc-s4', actionCorrelationId: 'act-f4c-legacy-null',
      resolutionType: 'write_off', amountCents: 500, actor: 'owner', role: 'admin', reason: 'legacy session with a NULL kind must still be rejected',
    });
    assert('15a: an economic_period_v1 parent with a NULL kind is STILL rejected (F-4C did not loosen the legacy branch)', legacyNull.success === false && legacyNull.code === 'SERVICE_SESSION_MISSING_KIND', JSON.stringify(legacyNull));
    assert('15a: no row was created by the rejected legacy-NULL attempt', db.rows.filter((r) => r.service_session_id === 's4').length === 0);

    const newEra = await svc.record({
      serviceSessionId: 's3', archivedOrderId: 'ORD-S3', relatedIncidentId: 'inc-s3', actionCorrelationId: 'act-f4c-new-era',
      resolutionType: 'write_off', amountCents: 500, actor: 'owner', role: 'admin', reason: 'operational_service_v1 parent with NULL kind must now succeed',
    });
    assert('15b: an operational_service_v1 parent with a NULL kind is NOT rejected as SERVICE_SESSION_MISSING_KIND', newEra.success === true, JSON.stringify(newEra));
    assert('15c: serviceKind is honestly null on the returned resolution -- never fabricated, never guessed', newEra.resolution.serviceKind === null, JSON.stringify(newEra.resolution));
    assert('15d: businessDate is still derived from the session, exactly as for a legacy-era parent', newEra.resolution.businessDate === '2026-08-17', JSON.stringify(newEra.resolution));
    assert('15e: the stored row carries lifecycle_semantics=operational_service_v1 (self-describing evidence)', db.rows.find((r) => r.action_correlation_id === 'act-f4c-new-era').lifecycle_semantics === 'operational_service_v1');
    assert('15f: financial arithmetic is unaffected by a NULL top-level service_kind -- original/remaining exposure derived from the incident exactly as for a legacy-era parent', newEra.resolution.originalExposureCents === 4000 && newEra.resolution.remainingExposureCents === 3500, JSON.stringify(newEra.resolution));
  }

  console.log('\n=== RESULT: ' + pass + ' passed, ' + fail + ' failed ===');
  process.exit(fail === 0 ? 0 : 1);
})();
