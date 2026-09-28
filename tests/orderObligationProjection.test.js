'use strict';

// UNIFIED_CASH_UI_SURFACE_V1 — BLOCCO 1.
//
// attachOrderFinancial adds a canonical `financial` block (projectOrderFinancial)
// to raw `ordenes` rows, in ONE batched order_obligations read, for the two
// operator order-list actions (getOrdenes / getOrdenesArchivadosSesion).
//
// STALE PAYMENT MIRROR (H1/H2) extends the block with the canonical settlement
// (netCollected / outstanding / overCollected / payState / legacyPaymentConflict)
// from ONE more batched order_financial_events read: two reads for any list
// length, never one per order (tests 3, S1-S9).
//
// This proves: additive shape, no N+1, no-adjustment vs adjusted parity, that
// ordenes.totale is never touched, Class B fallback stays projectOrderFinancial's
// existing behaviour, and no DB write path is reachable (the module is handed
// ONLY a read `select`).
//
// Run: node tests/orderObligationProjection.test.js

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  attachOrderFinancial, orderUidInFilter, projectOrderSettlement,
} = require('../src/tables/orderObligationProjection');

const UID_A = 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa';
const UID_B = 'bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb';

const rawOrder = (o = {}) => ({
  id: '#101', order_uid: UID_A, table_session_id: null, service_session_id: 'svc-1',
  estado: 'RETIRADO', items: [], nota: null, hora: '19:10', totale: 30, ts: 1,
  metodo_pago: 'efectivo', ya_pagado: true, cobrado: true, ...o,
});

// A fake sbSelect: records every call, answers order_obligations from a map and
// order_financial_events from a flat list.
function fakeSelect(revisionsByUid = {}, events = []) {
  const calls = [];
  const select = async (table, query) => {
    calls.push({ table, query });
    if (table === 'order_financial_events') return events;
    if (table !== 'order_obligations') {
      throw new Error(`unexpected table read: ${table}`);
    }
    // flatten every configured revision; the real endpoint filters server-side,
    // the module then buckets by order_uid itself.
    return Object.values(revisionsByUid).flat();
  };
  return { select, calls };
}
const obligationCalls = (calls) => calls.filter((c) => c.table === 'order_obligations');
const ev = (type, amount, o = {}) => ({ order_id: '#101', service_session_id: 'svc-1', type, amount, ...o });
const SETTLEMENT_KEYS = ['legacyPaymentConflict', 'netCollected', 'outstanding', 'overCollected', 'payState'];

const rev = (uid, revision, gross, o = {}) => ({
  order_uid: uid, order_id: '#101', revision, gross_amount: gross,
  source: revision === 1 ? 'order_create_v1' : 'order_commercial_adjustment_v1',
  cause: revision === 1 ? null : 'manual', created_at: '2026-09-07T19:10:00Z', ...o,
});

test('1+2: returns each order with an additive `financial` block, all original fields preserved', async () => {
  const { select } = fakeSelect({ [UID_A]: [rev(UID_A, 1, 30)] });
  const input = rawOrder();
  const [out] = await attachOrderFinancial([input], { select });

  // additive: every original key still present and equal
  for (const k of Object.keys(input)) assert.deepEqual(out[k], input[k], `field ${k} preserved`);
  assert.ok(out.financial && typeof out.financial === 'object', 'financial block added');
  assert.deepEqual(
    Object.keys(out.financial).sort(),
    ['adjustable', 'commercialAdjustment', 'currentObligation', 'obligationRevision', 'orderUid', 'originalObligation']
      .concat(SETTLEMENT_KEYS).sort(),
    'exactly projectOrderFinancial shape plus the canonical settlement — no other invented fields',
  );
  // input object itself is not mutated
  assert.equal(input.financial, undefined, 'source row not mutated');
});

test('3: ONE batched order_obligations read (and ONE order_financial_events read) for N orders — no N+1', async () => {
  const { select, calls } = fakeSelect({
    [UID_A]: [rev(UID_A, 1, 30)],
    [UID_B]: [rev(UID_B, 1, 18)],
  });
  const orders = [
    rawOrder({ id: '#101', order_uid: UID_A }),
    rawOrder({ id: '#102', order_uid: UID_B }),
    rawOrder({ id: '#103', order_uid: UID_A }),
  ];
  await attachOrderFinancial(orders, { select });
  assert.equal(calls.length, 2, 'exactly two reads regardless of order count');
  const [obl] = obligationCalls(calls);
  assert.equal(obligationCalls(calls).length, 1);
  assert.match(obl.query, /order_uid=in\.\(/, 'batched in.(...) filter');
  // both uids in the single filter, each once
  assert.match(obl.query, new RegExp(UID_A));
  assert.match(obl.query, new RegExp(UID_B));
  assert.equal(calls.filter((c) => c.table === 'order_financial_events').length, 1);
});

test('4: order with no adjustment -> currentObligation == originalObligation', async () => {
  const { select } = fakeSelect({ [UID_A]: [rev(UID_A, 1, 30)] });
  const [out] = await attachOrderFinancial([rawOrder({ totale: 30 })], { select });
  assert.equal(out.financial.originalObligation, 30);
  assert.equal(out.financial.currentObligation, 30);
  assert.equal(out.financial.commercialAdjustment, 0);
  assert.equal(out.financial.obligationRevision, 1, 'the single create revision');
});

test('5: adjusted order -> currentObligation != originalObligation, BOTH returned', async () => {
  const { select } = fakeSelect({ [UID_A]: [rev(UID_A, 1, 30), rev(UID_A, 2, 22)] });
  const [out] = await attachOrderFinancial([rawOrder({ totale: 30 })], { select });
  assert.equal(out.financial.originalObligation, 30, 'original still recoverable');
  assert.equal(out.financial.currentObligation, 22, 'current is the latest revision');
  assert.equal(out.financial.commercialAdjustment, -8);
  assert.equal(out.financial.obligationRevision, 2);
  assert.notEqual(out.financial.originalObligation, out.financial.currentObligation);
});

test('6: ordenes.totale is never modified by the projection', async () => {
  const { select } = fakeSelect({ [UID_A]: [rev(UID_A, 1, 30), rev(UID_A, 2, 10)] });
  const input = rawOrder({ totale: 30 });
  const [out] = await attachOrderFinancial([input], { select });
  assert.equal(out.totale, 30, 'projected row keeps the raw legacy totale');
  assert.equal(input.totale, 30, 'source row untouched');
  // and the canonical current obligation is a SEPARATE fact, not written back
  assert.equal(out.financial.currentObligation, 10);
});

test('7: no write path — the module only ever receives a read `select`, and only reads order_obligations + order_financial_events', async () => {
  const seenTables = new Set();
  const select = async (table) => { seenTables.add(table); return []; };
  await attachOrderFinancial([rawOrder(), rawOrder({ id: '#102', order_uid: UID_B })], { select });
  assert.deepEqual([...seenTables].sort(), ['order_financial_events', 'order_obligations'], 'reads nothing but the obligation and its ledger');
});

test('8: Class B (order_uid null) keeps projectOrderFinancial legacy semantics — no crash, adjustable:false', async () => {
  const { select, calls } = fakeSelect({});
  const [out] = await attachOrderFinancial([rawOrder({ order_uid: null, totale: 25 })], { select });
  assert.equal(out.financial.orderUid, null);
  assert.equal(out.financial.originalObligation, 25, 'legacy basis = ordenes.totale');
  assert.equal(out.financial.currentObligation, 25);
  assert.equal(out.financial.adjustable, false, 'Class B fail-closed, unchanged');
  // a list of ONLY Class B rows needs no order_obligations read at all
  assert.equal(obligationCalls(calls).length, 0, 'no order_obligations query when there is no valid order_uid to filter by');
});

test('8b: cancelled order keeps projectOrderFinancial zeroing (legacy basis path)', async () => {
  const { select } = fakeSelect({});
  const [out] = await attachOrderFinancial([rawOrder({ estado: 'ANULADO', order_uid: UID_A, totale: 30 })], { select });
  assert.equal(out.financial.currentObligation, 0, 'cancelled legacy order -> 0, unchanged behaviour');
  assert.equal(out.financial.adjustable, false);
});

test('9: empty list -> returns [] with ZERO reads (short-circuit for the "no open session" case)', async () => {
  const { select, calls } = fakeSelect({});
  const out = await attachOrderFinancial([], { select });
  assert.deepEqual(out, []);
  assert.equal(calls.length, 0);
});

test('10: additive shape is safe for a consumer that ignores `financial` (spread preserves identity of values)', async () => {
  const { select } = fakeSelect({ [UID_A]: [rev(UID_A, 1, 30)] });
  const input = rawOrder({ items: [{ n: 'Margherita', q: 1, p: 8 }] });
  const [out] = await attachOrderFinancial([input], { select });
  assert.deepEqual(out.items, input.items, 'nested arrays passed through by reference, unchanged');
  assert.equal(out.estado, 'RETIRADO');
});

test('orderUidInFilter: dedupes, drops null/empty, encodes', () => {
  assert.equal(orderUidInFilter([]), null);
  assert.equal(orderUidInFilter([{ order_uid: null }, { order_uid: '' }]), null);
  const f = orderUidInFilter([{ order_uid: UID_A }, { order_uid: UID_A }, { order_uid: UID_B }]);
  assert.match(f, /^in\.\(/);
  assert.equal((f.match(new RegExp(UID_A, 'g')) || []).length, 1, 'deduped');
});

// ── STALE PAYMENT MIRROR (H1/H2): the canonical settlement ────────────────────
// Oracle: the writer's arithmetic (order_post_payment_v1): net = payment +
// payment_imported − refund of the order's own (service, order id);
// outstanding = max(0, obligation − net); overCollected = max(0, net − obligation);
// payState = net<=0 ? unpaid : net>=obligation ? paid : partially_paid.
const settle = async (revisions, events, o = {}) => {
  const { select } = fakeSelect({ [UID_A]: revisions }, events);
  const [out] = await attachOrderFinancial([rawOrder({ cobrado: false, ya_pagado: false, ...o })], { select });
  return out.financial;
};

test('S1: 100 -> pay 60 -> adjust 60 : settled, mirror false is ignored', async () => {
  const f = await settle([rev(UID_A, 1, 100), rev(UID_A, 2, 60)], [ev('payment', 60)]);
  assert.deepEqual({ c: f.currentObligation, n: f.netCollected, o: f.outstanding, x: f.overCollected, p: f.payState, l: f.legacyPaymentConflict },
    { c: 60, n: 60, o: 0, x: 0, p: 'paid', l: false });
});

test('S2: 100 -> pay 60 -> adjust 40 : over-collected 20, never outstanding', async () => {
  const f = await settle([rev(UID_A, 1, 100), rev(UID_A, 2, 40)], [ev('payment', 60)]);
  assert.deepEqual([f.outstanding, f.overCollected, f.payState], [0, 20, 'paid']);
});

test('S3: 100 -> pay 40 -> adjust 60 : outstanding 20, not the historical total', async () => {
  const f = await settle([rev(UID_A, 1, 100), rev(UID_A, 2, 60)], [ev('payment', 40)]);
  assert.deepEqual([f.currentObligation, f.netCollected, f.outstanding, f.payState], [60, 40, 20, 'partially_paid']);
});

test('S4: unpaid / partial / fully paid / imported / refunded', async () => {
  assert.deepEqual([(await settle([rev(UID_A, 1, 100)], [])).outstanding, (await settle([rev(UID_A, 1, 100)], [])).payState], [100, 'unpaid']);
  assert.equal((await settle([rev(UID_A, 1, 100)], [ev('payment', 30)])).payState, 'partially_paid');
  assert.equal((await settle([rev(UID_A, 1, 100)], [ev('payment', 100)])).outstanding, 0);
  assert.equal((await settle([rev(UID_A, 1, 100)], [ev('payment_imported', 100)])).payState, 'paid');
  const r = await settle([rev(UID_A, 1, 100)], [ev('payment', 100), ev('refund', 30)]);
  assert.deepEqual([r.netCollected, r.outstanding, r.payState], [70, 30, 'partially_paid']);
});

test('S5: only the order\'s OWN (service, id) events count — a recycled display id in another service is ignored', async () => {
  const f = await settle([rev(UID_A, 1, 100)], [ev('payment', 100, { service_session_id: 'svc-OTHER' }), ev('payment', 100, { order_id: '#999' })]);
  assert.deepEqual([f.netCollected, f.outstanding, f.payState], [0, 100, 'unpaid']);
});

test('S6: legacy paid mirror with no ledger -> NOT paid: canonical outstanding + legacyPaymentConflict (the 148 predicate)', async () => {
  const f = await settle([rev(UID_A, 1, 100)], [], { cobrado: true, ya_pagado: true });
  assert.deepEqual([f.outstanding, f.payState, f.legacyPaymentConflict], [100, 'unpaid', true]);
  const settled = await settle([rev(UID_A, 1, 100)], [ev('payment_imported', 100)], { cobrado: true, ya_pagado: true });
  assert.equal(settled.legacyPaymentConflict, false, 'the mirror agrees with the ledger once imported');
});

test('S7: legacy basis (no revision) and cancelled order follow projectOrderFinancial', async () => {
  const legacy = await settle([], [ev('payment', 10)], { totale: 25 });
  assert.deepEqual([legacy.currentObligation, legacy.outstanding], [25, 15]);
  const cancelled = await settle([], [ev('payment', 25)], { estado: 'CANCELADO', totale: 25 });
  assert.deepEqual([cancelled.currentObligation, cancelled.outstanding, cancelled.overCollected], [0, 0, 25]);
});

test('S8: events query is batched over the rows\' services and ids, scoped to settlement types', async () => {
  const { select, calls } = fakeSelect({}, []);
  await attachOrderFinancial([
    rawOrder({ id: '#1', service_session_id: 'svc-1' }), rawOrder({ id: '#2', service_session_id: 'svc-2' }), rawOrder({ id: '#3', service_session_id: null }),
  ], { select });
  const q = calls.find((c) => c.table === 'order_financial_events').query;
  assert.match(q, /service_session_id=in\.\(svc-1,svc-2\)/);
  assert.match(q, /order_id=in\.\(%231,%232\)/, 'only rows WITH a service are looked up (the writer matches NULL to nothing)');
  assert.match(q, /type=in\.\(payment,payment_imported,refund\)/);
});

test('S9: projectOrderSettlement is pure and ignores non-settlement event types', () => {
  const f = projectOrderSettlement({ cobrado: false }, { currentObligation: 50 }, [{ type: 'void', amount: 50 }, { type: 'payment', amount: 20 }]);
  assert.deepEqual(f, { netCollected: 20, outstanding: 30, overCollected: 0, payState: 'partially_paid', legacyPaymentConflict: false });
});
