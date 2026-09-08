'use strict';

// UNIFIED_CASH_UI_SURFACE_V1 — BLOCCO 1.
//
// attachOrderFinancial adds a canonical `financial` block (projectOrderFinancial)
// to raw `ordenes` rows, in ONE batched order_obligations read, for the two
// operator order-list actions (getOrdenes / getOrdenesArchivadosSesion).
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
  attachOrderFinancial, orderUidInFilter,
} = require('../src/tables/orderObligationProjection');

const UID_A = 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa';
const UID_B = 'bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb';

const rawOrder = (o = {}) => ({
  id: '#101', order_uid: UID_A, table_session_id: null, service_session_id: 'svc-1',
  estado: 'RETIRADO', items: [], nota: null, hora: '19:10', totale: 30, ts: 1,
  metodo_pago: 'efectivo', ya_pagado: true, cobrado: true, ...o,
});

// A fake sbSelect: records every call, answers order_obligations from a map.
function fakeSelect(revisionsByUid = {}) {
  const calls = [];
  const select = async (table, query) => {
    calls.push({ table, query });
    if (table !== 'order_obligations') {
      throw new Error(`unexpected table read: ${table}`);
    }
    // flatten every configured revision; the real endpoint filters server-side,
    // the module then buckets by order_uid itself.
    return Object.values(revisionsByUid).flat();
  };
  return { select, calls };
}

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
    ['adjustable', 'commercialAdjustment', 'currentObligation', 'obligationRevision', 'orderUid', 'originalObligation'],
    'exactly projectOrderFinancial shape — no invented fields',
  );
  // input object itself is not mutated
  assert.equal(input.financial, undefined, 'source row not mutated');
});

test('3: ONE batched order_obligations read for N orders — no N+1', async () => {
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
  assert.equal(calls.length, 1, 'exactly one read regardless of order count');
  assert.equal(calls[0].table, 'order_obligations');
  assert.match(calls[0].query, /order_uid=in\.\(/, 'batched in.(...) filter');
  // both uids in the single filter, each once
  assert.match(calls[0].query, new RegExp(UID_A));
  assert.match(calls[0].query, new RegExp(UID_B));
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

test('7: no write path — the module only ever receives a read `select`, and only reads order_obligations', async () => {
  const seenTables = new Set();
  const select = async (table) => { seenTables.add(table); return []; };
  await attachOrderFinancial([rawOrder(), rawOrder({ id: '#102', order_uid: UID_B })], { select });
  assert.deepEqual([...seenTables], ['order_obligations'], 'reads nothing but order_obligations');
});

test('8: Class B (order_uid null) keeps projectOrderFinancial legacy semantics — no crash, adjustable:false', async () => {
  const { select, calls } = fakeSelect({});
  const [out] = await attachOrderFinancial([rawOrder({ order_uid: null, totale: 25 })], { select });
  assert.equal(out.financial.orderUid, null);
  assert.equal(out.financial.originalObligation, 25, 'legacy basis = ordenes.totale');
  assert.equal(out.financial.currentObligation, 25);
  assert.equal(out.financial.adjustable, false, 'Class B fail-closed, unchanged');
  // a list of ONLY Class B rows needs no order_obligations read at all
  assert.equal(calls.length, 0, 'no query when there is no valid order_uid to filter by');
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
