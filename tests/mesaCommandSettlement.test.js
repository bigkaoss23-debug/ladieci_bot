'use strict';

// R2 (Economy 147) — per-command SETTLEMENT on the Mesa account (additive field).
//
// The floor UI rebuilt each comanda's paid state from its historical lines, which a
// commercial adjustment never touches: after 100 -> pay 100 -> adjust 80 -> refund 20 the
// line still owes 20 and the comanda read "Pendiente". commands[].settlement carries the
// canonical fact instead:
//   currentObligation  financial.currentObligation (latest order_obligations revision)
//   netCollected       this session's payment_allocations for the command, payments minus
//                      refunds (the base of mesa_post_payment_v1's per-order cap)
//   outstanding / overCollected   the two one-sided differences (outstanding == v_order_caps)
//   payState           the writers' rule: net <= 0 unpaid, net >= obligation paid, else partial
//   payableByLines     the command's lines owe exactly what it owes, so an item_selection over
//                      them can never exceed the writer's per-order cap
// Rows are shaped exactly as mesaDao.listFloorRows / listSessionAccountRows return them.

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildFloor, buildClosedAccount } = require('../src/tables/mesaService');

const SESSION = 's-r2d';
const uid = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
let seq = 0;
const order = (id, n, totale, o = {}) => ({ id, order_uid: uid(n), table_session_id: SESSION, table_command_number: ++seq, estado: 'EN_COCINA', totale, items: [], ts: seq, ...o });
const line = (id, orderId, net) => ({ id, table_session_id: SESSION, order_id: orderId, source_line_index: 1, unit_index: 1, description: id, product_snapshot: {}, net_amount: net });
const rev = (n, r, gross) => ({ order_uid: uid(n), revision: r, gross_amount: gross });
const tx = (id, kind, amount, session = SESSION) => ({ id, table_session_id: session, kind, mode: 'full', amount, payment_method: 'efectivo', covers_settled: 0 });
const alloc = (txId, lineId, orderId, amount) => ({ payment_transaction_id: txId, table_order_line_id: lineId, order_id: orderId, amount });

function accounts(rows) {
  const base = { allocations: [], transactions: [], obligations: [], ...rows };
  const [table] = buildFloor({
    tables: [{ id: 't1', table_number: 1, display_name: 'Mesa 1', active: true }],
    sessions: [{ id: SESSION, table_id: 't1', service_session_id: 'svc', status: 'open', covers_total: 2 }],
    ...base,
  });
  return [table.session, buildClosedAccount({ id: SESSION, status: 'closed', covers_total: 2 }, base, null).account];
}
function assertSettlement(rows, expected) {
  for (const account of accounts(rows)) {
    for (const [id, want] of Object.entries(expected)) {
      const cmd = account.commands.find((c) => c.id === id);
      assert.deepEqual(cmd.settlement, want, `${id}.settlement`);
      assert.equal(cmd.settlement.currentObligation, cmd.financial.currentObligation);
    }
  }
}
// coveredByTable (corrective slice 150, #5): the part of a comanda's debt the table's over-collection on its other
// comandas covers -- one settlement per table session (src/tables/tableSettlementNetting.js).
const S = (currentObligation, netCollected, outstanding, overCollected, payState, payableByLines, coveredByTable = 0) =>
  ({ currentObligation, netCollected, outstanding, overCollected, coveredByTable, payState, payableByLines });

test('A: 100 -> pay 100 -> adjust 80 -> refund 20: paid, nothing outstanding, not payable by lines (the line still owes 20)', () => {
  assertSettlement({
    orders: [order('#A', 1, 100)], lines: [line('lA', '#A', 100)], obligations: [rev(1, 1, 100), rev(1, 2, 80)],
    transactions: [tx('p1', 'payment', 100), tx('r1', 'refund', 20)],
    allocations: [alloc('p1', 'lA', '#A', 100), alloc('r1', 'lA', '#A', 20)],
  }, { '#A': S(80, 80, 0, 0, 'paid', false) });
});

test('B: ... refund 10 -> paid with 10 over-collected', () => {
  assertSettlement({
    orders: [order('#A', 1, 100)], lines: [line('lA', '#A', 100)], obligations: [rev(1, 1, 100), rev(1, 2, 80)],
    transactions: [tx('p1', 'payment', 100), tx('r1', 'refund', 10)],
    allocations: [alloc('p1', 'lA', '#A', 100), alloc('r1', 'lA', '#A', 10)],
  }, { '#A': S(80, 90, 0, 10, 'paid', false) });
});

test('C / D: pay 50 then adjust to 80 (owes 30) or to 40 (paid, 10 over)', () => {
  const base = { orders: [order('#A', 1, 100)], lines: [line('lA', '#A', 100)], transactions: [tx('p1', 'payment', 50)], allocations: [alloc('p1', 'lA', '#A', 50)] };
  assertSettlement({ ...base, obligations: [rev(1, 1, 100), rev(1, 2, 80)] }, { '#A': S(80, 50, 30, 0, 'partially_paid', false) });
  assertSettlement({ ...base, obligations: [rev(1, 1, 100), rev(1, 2, 40)] }, { '#A': S(40, 50, 0, 10, 'paid', false) });
});

test('F + J (150 #5): the over-collection of #A covers #B inside the table -- #B owes only the table outstanding (10), charged by amount, never by lines', () => {
  assertSettlement({
    orders: [order('#A', 1, 100), order('#B', 2, 30)],
    lines: [line('lA', '#A', 100), line('lB', '#B', 30)],
    obligations: [rev(1, 1, 100), rev(1, 2, 80), rev(2, 1, 30)],
    transactions: [tx('p1', 'payment', 100)], allocations: [alloc('p1', 'lA', '#A', 100)],
  }, { '#A': S(80, 100, 0, 0, 'paid', false), '#B': S(30, 0, 10, 0, 'unpaid', false, 20) });
});

test('G: a cancelled command (obligation 0) that kept its payment -> paid, all of it over-collected', () => {
  assertSettlement({
    orders: [order('#A', 1, 50), order('#X', 2, 30, { estado: 'CANCELADO' })],
    lines: [line('lA', '#A', 50), line('lX', '#X', 30)],
    obligations: [rev(1, 1, 50), rev(2, 1, 30), rev(2, 2, 0)],
    transactions: [tx('p1', 'payment', 80)], allocations: [alloc('p1', 'lA', '#A', 50), alloc('p1', 'lX', '#X', 30)],
  }, { '#A': S(50, 50, 0, 0, 'paid', false), '#X': S(0, 30, 0, 30, 'paid', false) });
});

test('H: no adjustment -> payable by lines exactly when something is owed', () => {
  assertSettlement({
    orders: [order('#A', 1, 25.5)],
    lines: [line('a1', '#A', 10.25), line('a2', '#A', 10.25), line('a3', '#A', 5)],
    obligations: [rev(1, 1, 25.5)],
    transactions: [tx('p1', 'payment', 10.25)], allocations: [alloc('p1', 'a1', '#A', 10.25)],
  }, { '#A': S(25.5, 10.25, 15.25, 0, 'partially_paid', true) });
});

test('K: refund after a by-product payment and an adjustment -> owes 30 while its lines owe 60: not payable by lines', () => {
  assertSettlement({
    orders: [order('#A', 1, 100)], lines: [line('a1', '#A', 60), line('a2', '#A', 40)],
    obligations: [rev(1, 1, 100), rev(1, 2, 70)],
    transactions: [tx('p1', 'payment', 60), tx('r1', 'refund', 20)],
    allocations: [alloc('p1', 'a1', '#A', 60), alloc('r1', 'a1', '#A', 20)],
  }, { '#A': S(70, 40, 30, 0, 'partially_paid', false) });
});

test("another session's allocations never count, and an allocation without order_id follows its line", () => {
  assertSettlement({
    orders: [order('#A', 1, 100)], lines: [line('lA', '#A', 100)], obligations: [rev(1, 1, 100)],
    transactions: [tx('p1', 'payment', 40)],
    allocations: [alloc('p1', 'lA', null, 40), alloc('foreign', 'lZ', '#A', 999)],
  }, { '#A': S(100, 40, 60, 0, 'partially_paid', true) });
});

// ── corrective slice 150 (#5): one settlement per table session ─────────────────────────────────────────────
const F_ROWS = (extra = {}) => ({
  orders: [order('#A', 1, 100), order('#B', 2, 30)],
  lines: [line('lA', '#A', 100), line('lB', '#B', 30)],
  obligations: [rev(1, 1, 100), rev(1, 2, 80), rev(2, 1, 30)],
  ...extra,
});
test('150 #5 F settled: after the table pays its 10, no comanda owes anything and none is over-collected (no phantom pair)', () => {
  const rows = F_ROWS({ transactions: [tx('p1', 'payment', 100), tx('p2', 'payment', 10)], allocations: [alloc('p1', 'lA', '#A', 100), alloc('p2', 'lB', '#B', 10)] });
  assertSettlement(rows, { '#A': S(80, 100, 0, 0, 'paid', false), '#B': S(30, 10, 0, 0, 'paid', false, 20) });
  for (const account of accounts(rows)) assert.deepEqual([account.total, account.paid, account.outstanding, account.overCollected], [110, 110, 0, 0]);
});
test('150 #5 real over-collection stays over-collection: the table collected 20 more than it owes in total', () => {
  const rows = F_ROWS({ transactions: [tx('p1', 'payment', 100), tx('p2', 'payment', 30)], allocations: [alloc('p1', 'lA', '#A', 100), alloc('p2', 'lB', '#B', 30)] });
  assertSettlement(rows, { '#A': S(80, 100, 0, 20, 'paid', false), '#B': S(30, 30, 0, 0, 'paid', false) });
  for (const account of accounts(rows)) assert.deepEqual([account.outstanding, account.overCollected], [0, 20]);
});
test('150 #5 a refund of the excess on #A brings the real debt of #B back (no false compensation)', () => {
  const rows = F_ROWS({ transactions: [tx('p1', 'payment', 100), tx('r1', 'refund', 20)], allocations: [alloc('p1', 'lA', '#A', 100), alloc('r1', 'lA', '#A', 20)] });
  assertSettlement(rows, { '#A': S(80, 80, 0, 0, 'paid', false), '#B': S(30, 0, 30, 0, 'unpaid', true) });
});
test('150 #5 three comandas (one over-collected, one partially paid, one unpaid): the excess covers them in command order, totals exact', () => {
  const rows = {
    orders: [order('#A', 1, 100), order('#B', 2, 40), order('#C', 3, 30)],
    lines: [line('lA', '#A', 100), line('lB', '#B', 40), line('lC', '#C', 30)],
    obligations: [rev(1, 1, 100), rev(1, 2, 70), rev(2, 1, 40), rev(3, 1, 30)],
    transactions: [tx('p1', 'payment', 100), tx('p2', 'payment', 10)], allocations: [alloc('p1', 'lA', '#A', 100), alloc('p2', 'lB', '#B', 10)],
  };
  // over 30 on #A; #B owes 30, #C owes 30: the 30 covers #B (command 2) first, #C keeps its 30
  assertSettlement(rows, { '#A': S(70, 100, 0, 0, 'paid', false), '#B': S(40, 10, 0, 0, 'paid', false, 30), '#C': S(30, 0, 30, 0, 'unpaid', true) });
  for (const account of accounts(rows)) assert.deepEqual([account.total, account.paid, account.outstanding, account.overCollected], [140, 110, 30, 0]);
});
