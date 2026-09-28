'use strict';

// R2 (Economy 147) — the Mesa PER-COMMAND total on the canonical obligation.
//
// After R2B the session total summed the commands' current canonical obligation, but each
// command still published `total: ordenes.totale` — the pre-adjustment gross, and still the
// full amount for a cancelled command. The floor showed "Total comanda 100" beside a session
// total of 80. Contract pinned here:
//   * commands[].total          = financial.currentObligation (latest order_obligations
//     revision, else the legacy ordenes.totale basis, 0 for a cancelled command) — the same
//     figure cashService.buildCheckAccount publishes as a check's total;
//   * financial.originalObligation keeps the original figure, unchanged;
//   * the counted commands' totals add up to session.total, in the floor AND the closed account;
//   * a live command never adjusted keeps exactly the number it had.
// Rows are shaped exactly as mesaDao.listFloorRows / listSessionAccountRows return them.

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildFloor, buildClosedAccount } = require('../src/tables/mesaService');

const SESSION = 's-r2c';
const UID_A = 'aaaaaaaa-0000-4000-8000-0000000000ca';
const UID_B = 'bbbbbbbb-0000-4000-8000-0000000000cb';

let seq = 0;
const order = (id, uid, totale, o = {}) => ({
  id, order_uid: uid, table_session_id: SESSION, table_command_number: ++seq, estado: 'EN_COCINA', totale, items: [], ts: seq, ...o,
});
const line = (id, orderId, net) => ({
  id, table_session_id: SESSION, order_id: orderId, source_line_index: 1, unit_index: 1, description: id, product_snapshot: {}, net_amount: net,
});
const revision = (uid, rev, gross, source = rev === 1 ? 'order_create_v1' : 'order_commercial_adjustment_v1') => ({ order_uid: uid, revision: rev, gross_amount: gross, source });
const tx = (id, kind, amount, method = 'efectivo') => ({ id, table_session_id: SESSION, kind, mode: 'full', amount, payment_method: method, covers_settled: 0 });
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
const cents = (v) => Math.round(Number(v) * 100);
function assertCommands(rows, expectedTotals, sessionTotal) {
  for (const account of accounts(rows)) {
    const byId = Object.fromEntries(account.commands.map((c) => [c.id, c]));
    for (const [id, total] of Object.entries(expectedTotals)) {
      assert.equal(byId[id].total, total, `${id}.total`);
      assert.equal(byId[id].total, byId[id].financial.currentObligation, `${id}.total == financial.currentObligation`);
    }
    assert.equal(account.total, sessionTotal, 'session.total');
    assert.equal(account.commands.reduce((sum, c) => sum + cents(c.total), 0), cents(account.total), 'sum of command totals == session.total');
  }
}

test('A: 100 -> pay 100 -> adjust 80 -> refund 20: the command reads 80 (original 100 kept in financial)', () => {
  const rows = {
    orders: [order('#A', UID_A, 100)], lines: [line('lA', '#A', 100)],
    obligations: [revision(UID_A, 1, 100), revision(UID_A, 2, 80)],
    transactions: [tx('p1', 'payment', 100), tx('r1', 'refund', 20)],
    allocations: [alloc('p1', 'lA', '#A', 100), alloc('r1', 'lA', '#A', 20)],
  };
  assertCommands(rows, { '#A': 80 }, 80);
  const [floor] = accounts(rows);
  assert.equal(floor.commands[0].financial.originalObligation, 100);
  assert.equal(floor.commands[0].financial.commercialAdjustment, -20);
});

test('D: an adjustment below what was collected -> the command reads the new obligation (40), not 100', () => {
  assertCommands({
    orders: [order('#A', UID_A, 100)], lines: [line('lA', '#A', 100)],
    obligations: [revision(UID_A, 1, 100), revision(UID_A, 2, 40)],
    transactions: [tx('p1', 'payment', 50)], allocations: [alloc('p1', 'lA', '#A', 50)],
  }, { '#A': 40 }, 40);
});

test('E: multiple adjustments -> only the latest revision, whatever order the rows arrive in', () => {
  assertCommands({
    orders: [order('#A', UID_A, 100)], lines: [line('lA', '#A', 100)],
    obligations: [revision(UID_A, 3, 70), revision(UID_A, 1, 100), revision(UID_A, 2, 90)],
  }, { '#A': 70 }, 70);
});

test('F: two commands, adjustment only on A -> A 80, B keeps 30, and they add up to the session', () => {
  assertCommands({
    orders: [order('#A', UID_A, 100), order('#B', UID_B, 30)],
    lines: [line('lA', '#A', 100), line('lB', '#B', 30)],
    obligations: [revision(UID_A, 1, 100), revision(UID_A, 2, 80), revision(UID_B, 1, 30)],
  }, { '#A': 80, '#B': 30 }, 110);
});

test('G: a cancelled command owes 0 -- with its cancellation revision, and as a legacy command with none', () => {
  assertCommands({
    orders: [order('#A', UID_A, 50), order('#X', UID_B, 30, { estado: 'CANCELADO' })],
    lines: [line('lA', '#A', 50), line('lX', '#X', 30)],
    obligations: [revision(UID_A, 1, 50), revision(UID_B, 1, 30), revision(UID_B, 2, 0, 'order_cancel_v1')],
  }, { '#A': 50, '#X': 0 }, 50);
  assertCommands({
    orders: [order('#A', UID_A, 50), order('#X', UID_B, 30, { estado: 'ANULADO' })],
    lines: [line('lA', '#A', 50), line('lX', '#X', 30)],
  }, { '#A': 50, '#X': 0 }, 50);
});

test('H: no adjustment -> every command keeps exactly ordenes.totale, with or without its revision-1 row', () => {
  const rows = {
    orders: [order('#A', UID_A, 25.5), order('#B', UID_B, 100)],
    lines: [line('a1', '#A', 10.25), line('a2', '#A', 10.25), line('a3', '#A', 5), line('b1', '#B', 100)],
  };
  assertCommands({ ...rows, obligations: [revision(UID_A, 1, 25.5), revision(UID_B, 1, 100)] }, { '#A': 25.5, '#B': 100 }, 125.5);
  assertCommands(rows, { '#A': 25.5, '#B': 100 }, 125.5);
});
