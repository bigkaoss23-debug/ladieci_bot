'use strict';

// R2 (Economy 147) — the Mesa session account reader on the CANONICAL obligation.
//
// Migration 147 put mesa_post_refund_v1 on order_canonical_obligation_v1, the same basis
// mesa_post_payment_v1 and mesa_close_session_v1 already used. The floor / closed-account
// reader (projectSessionAccount) still summed table_order_lines, which a commercial
// adjustment never touches: after pay 100 -> adjust 80 -> refund 20 it read total 100 /
// outstanding 20 while every writer said settled, and an adjustment below what was
// collected hid the over-collection behind outstanding 0.
//
// Contract pinned here: session total = sum of the commands' CURRENT canonical obligation
// (latest order_obligations revision, else the legacy ordenes.totale basis, 0 for a
// cancelled command), over the commands the Mesa writers count (order_uid present and a
// revision or a line of this session). netCollected stays payments - refunds from
// payment_transactions; outstanding / overCollected are the two one-sided differences.
// Rows are shaped exactly as mesaDao.listFloorRows / listSessionAccountRows return them.

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildFloor, buildClosedAccount } = require('../src/tables/mesaService');

const SESSION = 's-r2';
const UID_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const UID_B = 'bbbbbbbb-0000-4000-8000-00000000000b';

let seq = 0;
const order = (id, uid, totale, o = {}) => ({
  id, order_uid: uid, table_session_id: SESSION, table_command_number: 1, estado: 'EN_COCINA', totale, items: [], ts: ++seq, ...o,
});
const line = (id, orderId, net) => ({
  id, table_session_id: SESSION, order_id: orderId, source_line_index: 1, unit_index: 1, description: id, product_snapshot: {}, net_amount: net,
});
const revision = (uid, rev, gross) => ({ order_uid: uid, revision: rev, gross_amount: gross, source: rev === 1 ? 'order_create_v1' : 'order_commercial_adjustment_v1' });
const tx = (id, kind, amount, method = 'efectivo', reverses = null) => ({
  id, table_session_id: SESSION, kind, mode: kind === 'refund' ? 'refund' : 'full', amount, payment_method: method, covers_settled: 0, reverses_transaction_id: reverses,
});
const alloc = (txId, lineId, amount) => ({ payment_transaction_id: txId, table_order_line_id: lineId, amount });

function floorAccount(rows) {
  const [table] = buildFloor({
    tables: [{ id: 't1', table_number: 1, display_name: 'Mesa 1', active: true }],
    sessions: [{ id: SESSION, table_id: 't1', service_session_id: 'svc', status: 'open', covers_total: 2 }],
    allocations: [], transactions: [], obligations: [], ...rows,
  });
  return table.session;
}
function closedAccount(rows) {
  return buildClosedAccount({ id: SESSION, status: 'closed', covers_total: 2 },
    { allocations: [], transactions: [], obligations: [], ...rows }, null).account;
}
function money(account) {
  return { total: account.total, paid: account.paid, outstanding: account.outstanding, overCollected: account.overCollected };
}
function both(rows, expected) {
  const open = floorAccount(rows);
  assert.deepEqual(money(open), expected, 'floor reader');
  assert.deepEqual(money(closedAccount(rows)), expected, 'closed-account reader is the same projection');
  return open;
}
const adjusted = (gross) => ({
  orders: [order('#A', UID_A, 100)],
  lines: [line('lA', '#A', 100)],
  obligations: [revision(UID_A, 1, 100), revision(UID_A, 2, gross)],
});

test('A: obligation 100, pay 100, adjust 80, refund 20 -> total 80, net 80, outstanding 0, overCollected 0', () => {
  const account = both({
    ...adjusted(80),
    transactions: [tx('p1', 'payment', 100), tx('r1', 'refund', 20, 'efectivo', 'p1')],
    allocations: [alloc('p1', 'lA', 100), alloc('r1', 'lA', 20)],
  }, { total: 80, paid: 80, outstanding: 0, overCollected: 0 });
  assert.equal(account.nextEqualShare, 0);
  assert.equal(account.commands[0].financial.currentObligation, 80);
});

test('A0: adjustment below what was collected, no refund -> the over-collection is published, not hidden', () => {
  both({ ...adjusted(80), transactions: [tx('p1', 'payment', 100)], allocations: [alloc('p1', 'lA', 100)] },
    { total: 80, paid: 100, outstanding: 0, overCollected: 20 });
});

test('B: obligation 100, pay 100, adjust 80, refund 10 -> total 80, net 90, outstanding 0, overCollected 10', () => {
  both({
    ...adjusted(80),
    transactions: [tx('p1', 'payment', 100), tx('r1', 'refund', 10, 'efectivo', 'p1')],
    allocations: [alloc('p1', 'lA', 100), alloc('r1', 'lA', 10)],
  }, { total: 80, paid: 90, outstanding: 0, overCollected: 10 });
});

test('C + D: two commands, adjustment only on A (100 -> 80), B 20 untouched -> session total 100', () => {
  const account = both({
    orders: [order('#A', UID_A, 100), order('#B', UID_B, 20)],
    lines: [line('lA', '#A', 100), line('lB', '#B', 20)],
    obligations: [revision(UID_A, 1, 100), revision(UID_A, 2, 80), revision(UID_B, 1, 20)],
  }, { total: 100, paid: 0, outstanding: 100, overCollected: 0 });
  const byId = Object.fromEntries(account.commands.map((c) => [c.id, c.financial]));
  assert.equal(byId['#A'].currentObligation, 80);
  assert.equal(byId['#B'].currentObligation, 20);
  assert.equal(byId['#B'].commercialAdjustment, 0);
});

test('E: a command cancelled after payment (revision to 0) owes nothing; the kept money is over-collection', () => {
  both({
    orders: [order('#A', UID_A, 50), order('#X', UID_B, 30, { estado: 'CANCELADO' })],
    lines: [line('lA', '#A', 50), line('lX', '#X', 30)],
    obligations: [revision(UID_A, 1, 50), revision(UID_B, 1, 30), { ...revision(UID_B, 2, 0), source: 'order_cancel_v1' }],
    transactions: [tx('p1', 'payment', 80)],
    allocations: [alloc('p1', 'lA', 50), alloc('p1', 'lX', 30)],
  }, { total: 50, paid: 80, outstanding: 0, overCollected: 30 });
});

test('E: a cancelled legacy command with no revision falls back to the canonical legacy basis 0', () => {
  both({
    orders: [order('#A', UID_A, 50), order('#X', UID_B, 30, { estado: 'ANULADO' })],
    lines: [line('lA', '#A', 50), line('lX', '#X', 30)],
  }, { total: 50, paid: 0, outstanding: 50, overCollected: 0 });
});

test('F: partial payment after an adjustment -> outstanding is measured against the current obligation', () => {
  both({ ...adjusted(80), transactions: [tx('p1', 'payment', 40)], allocations: [alloc('p1', 'lA', 40)] },
    { total: 80, paid: 40, outstanding: 40, overCollected: 0 });
});

test('G: multi-tender -> per-method totals unchanged, balance on the current obligation', () => {
  const account = both({
    ...adjusted(90),
    transactions: [tx('p1', 'payment', 30, 'efectivo'), tx('p2', 'payment', 50, 'tarjeta'), tx('p3', 'payment', 10, 'bizum')],
    allocations: [alloc('p1', 'lA', 30), alloc('p2', 'lA', 50), alloc('p3', 'lA', 10)],
  }, { total: 90, paid: 90, outstanding: 0, overCollected: 0 });
  assert.deepEqual(account.paymentTotals, { efectivo: 30, tarjeta: 50, bizum: 10 });
});

test('H: no adjustment -> the canonical total equals the line sum the reader used before', () => {
  const rows = {
    orders: [order('#A', UID_A, 25.5), order('#B', UID_B, 100)],
    lines: [line('a1', '#A', 10.25), line('a2', '#A', 10.25), line('a3', '#A', 5), line('b1', '#B', 100)],
    obligations: [revision(UID_A, 1, 25.5), revision(UID_B, 1, 100)],
    transactions: [tx('p1', 'payment', 60)],
    allocations: [alloc('p1', 'a1', 10.25), alloc('p1', 'b1', 49.75)],
  };
  const account = both(rows, { total: 125.5, paid: 60, outstanding: 65.5, overCollected: 0 });
  const lineSum = account.lines.reduce((sum, l) => sum + Math.round(l.amount * 100), 0) / 100;
  assert.equal(account.total, lineSum);
  // and a legacy command with no revision yet reads its ordenes.totale basis, same number
  const legacy = floorAccount({ ...rows, obligations: [] });
  assert.deepEqual(money(legacy), money(account));
});

test('I: multiple adjustments -> ONLY the latest revision counts, whatever order the rows arrive in', () => {
  both({
    orders: [order('#A', UID_A, 100)],
    lines: [line('lA', '#A', 100)],
    obligations: [revision(UID_A, 3, 70), revision(UID_A, 1, 100), revision(UID_A, 2, 90)],
    transactions: [tx('p1', 'payment', 50), tx('p2', 'payment', 20)],
    allocations: [alloc('p1', 'lA', 50), alloc('p2', 'lA', 20)],
  }, { total: 70, paid: 70, outstanding: 0, overCollected: 0 });
});

test('inclusion is the Mesa writers\' rule: no order_uid, or neither a revision nor a line of this session -> not counted', () => {
  both({
    orders: [order('#A', UID_A, 40), order('#N', null, 15), order('#E', UID_B, 25)],
    lines: [line('lA', '#A', 40), line('lN', '#N', 15)],
  }, { total: 40, paid: 0, outstanding: 40, overCollected: 0 });
});

test('another session\'s revisions and lines never leak into this session\'s total', () => {
  const account = floorAccount({
    orders: [order('#A', UID_A, 100), order('#Z', UID_B, 999, { table_session_id: 'other' })],
    lines: [line('lA', '#A', 100), { ...line('lZ', '#Z', 999), table_session_id: 'other' }],
    obligations: [revision(UID_A, 1, 100), revision(UID_A, 2, 80), revision(UID_B, 1, 999)],
  });
  assert.deepEqual(money(account), { total: 80, paid: 0, outstanding: 80, overCollected: 0 });
});
