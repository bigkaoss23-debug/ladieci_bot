'use strict';

// CORRECTIVE SLICE 150 (#5) — one settlement per Mesa table session.
//
// A comanda paid by products and then adjusted down kept its payment allocated to it, while another comanda of the
// same table stayed short by the same amount: the per-comanda projection (safeTicket / aggregate, the closeout, the V3
// incidents) reported a phantom over-collection AND a phantom UNPAID_BALANCE_AT_CLOSE on a table the writer itself
// considered settled. The netting covers the debt of a comanda with the over-collection of the others, inside the table
// session only, without moving any money.

const assert = require('node:assert/strict');
const test = require('node:test');
const { netTableSettlement } = require('../src/tables/tableSettlementNetting');
const { aggregate } = require('../src/closeout/currentServiceCloseout');
const { classifyForV3Close } = require('../src/serviceSessions/v3IncidentPolicy');

const SID = 'svc-150';
const session = { id: SID, status: 'open', business_date: '2026-09-26', lifecycle_semantics: 'operational_service_v1', opened_at: '2026-09-26T18:00:00Z' };
const ord = (id, totale, o = {}) => ({ id, orden_id: id, service_session_id: SID, estado: 'EN_COCINA', totale, hora: '20:00', cobrado: false, ya_pagado: false, metodo_pago: '', ...o });
const obl = (order_id, revision, gross_amount) => ({ order_id, service_session_id: SID, revision, gross_amount });
const pay = (order_id, amount, type = 'payment') => ({ order_id, service_session_id: SID, type, amount, payment_method: 'efectivo', created_at: '2026-09-26T20:00:00Z' });

test('netTableSettlement: exact totals per table session, command order, other sessions and non-table orders untouched', () => {
  const out = netTableSettlement([
    { key: 'a', tableSessionId: 't1', commandNumber: 1, id: '#A', owedCents: 0, overCents: 3000 },
    { key: 'b', tableSessionId: 't1', commandNumber: 2, id: '#B', owedCents: 2000, overCents: 0 },
    { key: 'c', tableSessionId: 't1', commandNumber: 3, id: '#C', owedCents: 2000, overCents: 0 },
    { key: 'd', tableSessionId: 't2', commandNumber: 1, id: '#D', owedCents: 500, overCents: 0 },
    { key: 'e', tableSessionId: null, commandNumber: null, id: '#E', owedCents: 0, overCents: 900 },
  ]);
  assert.deepEqual(out.get('a'), { owedCents: 0, overCents: 0, coveredCents: 0, appliedOverCents: 3000 });
  assert.deepEqual(out.get('b'), { owedCents: 0, overCents: 0, coveredCents: 2000, appliedOverCents: 0 });
  assert.deepEqual(out.get('c'), { owedCents: 1000, overCents: 0, coveredCents: 1000, appliedOverCents: 0 });
  assert.deepEqual(out.get('d'), { owedCents: 500, overCents: 0, coveredCents: 0, appliedOverCents: 0 }, 'another table never covers this one');
  assert.deepEqual(out.get('e'), { owedCents: 0, overCents: 900, coveredCents: 0, appliedOverCents: 0 }, 'an order without a table session is untouched');
});

test('netTableSettlement: real over-collection is kept (sum over > sum owed)', () => {
  const out = netTableSettlement([
    { key: 'a', tableSessionId: 't1', commandNumber: 1, id: '#A', owedCents: 0, overCents: 3000 },
    { key: 'b', tableSessionId: 't1', commandNumber: 2, id: '#B', owedCents: 1000, overCents: 0 },
  ]);
  assert.equal(out.get('a').overCents, 2000);
  assert.equal(out.get('b').owedCents, 0);
});

// the original case F, carried to the closeout: #A 100 paid, adjusted to 80 (over 20); #B 30 paid 10 (owes 20)
const caseF = () => ({
  orders: [ord('#A', 100, { table_session_id: 'ts-F', table_command_number: 1 }), ord('#B', 30, { table_session_id: 'ts-F', table_command_number: 2 })],
  events: [pay('#A', 100), pay('#B', 10)],
  obligations: [obl('#A', 1, 100), obl('#A', 2, 80), obl('#B', 1, 30)],
});

test('aggregate (the closeout): a settled table has ZERO unpaid exposure and ZERO over-collection -- no phantom pair', () => {
  const { orders, events, obligations } = caseF();
  const c = aggregate(session, orders, events, obligations);
  assert.equal(c.totals.unpaid, 0);
  assert.equal(c.totals.overCollected, 0);
  assert.equal(c.totals.gross, 110);
  assert.equal(c.totals.collected, 110, 'the money is untouched');
  assert.deepEqual(c.paymentTotals, { efectivo: 110, tarjeta: 0, bizum: 0, other: 0 });
  const a = c.tickets.find((t) => t.id === '#A'); const b = c.tickets.find((t) => t.id === '#B');
  assert.deepEqual([a.overCollectedAmount, a.tableSettlementAppliedOverAmount, a.collectedAmount], [0, 20, 100]);
  assert.deepEqual([b.unpaidAmount, b.tableSettlementCoveredAmount, b.collectedAmount, b.paymentState], [0, 20, 10, 'paid']);
});

test('V3 classification: no UNPAID_BALANCE_AT_CLOSE incident on the settled table', () => {
  const { orders, events, obligations } = caseF();
  const c = aggregate(session, orders, events, obligations);
  const cls = classifyForV3Close({ orders, tableSessions: [], tickets: c.tickets });
  assert.equal(cls.incidents.filter((i) => i.incidentType === 'UNPAID_BALANCE_AT_CLOSE').length, 0);
});

test('aggregate: the unsettled table (only the 100 paid) owes exactly the table outstanding, 10, on #B -- and it IS an incident', () => {
  const { orders, obligations } = caseF();
  const c = aggregate(session, orders, [pay('#A', 100)], obligations);
  assert.equal(c.totals.unpaid, 10);
  assert.equal(c.totals.overCollected, 0);
  const cls = classifyForV3Close({ orders, tableSessions: [], tickets: c.tickets });
  const unpaid = cls.incidents.filter((i) => i.incidentType === 'UNPAID_BALANCE_AT_CLOSE');
  assert.equal(unpaid.length, 1);
  assert.equal(unpaid[0].entityId, '#B');
  assert.equal(unpaid[0].financialExposureCents, 1000);
});

test('aggregate: a refund of the excess on #A brings the real debt of #B back (20), no false compensation', () => {
  const { orders, obligations } = caseF();
  const c = aggregate(session, orders, [pay('#A', 100), pay('#A', 20, 'refund'), pay('#B', 10)], obligations);
  assert.equal(c.totals.unpaid, 20);
  assert.equal(c.totals.overCollected, 0);
});

test('aggregate: real over-collection of the table (paid 130 for 110) stays over-collection, 20', () => {
  const { orders, obligations } = caseF();
  const c = aggregate(session, orders, [pay('#A', 100), pay('#B', 30)], obligations);
  assert.equal(c.totals.unpaid, 0);
  assert.equal(c.totals.overCollected, 20);
});

test('aggregate: orders of DIFFERENT tables never compensate each other; non-table orders are untouched', () => {
  const orders = [ord('#A', 100, { table_session_id: 'ts-1', table_command_number: 1 }), ord('#B', 30, { table_session_id: 'ts-2', table_command_number: 1 }), ord('#D', 20)];
  const c = aggregate(session, orders, [pay('#A', 100), pay('#B', 10), pay('#D', 30)], [obl('#A', 1, 100), obl('#A', 2, 80), obl('#B', 1, 30), obl('#D', 1, 20)]);
  assert.equal(c.totals.unpaid, 20, '#B still owes its 20: #A is another table');
  assert.equal(c.totals.overCollected, 30, '#A 20 + delivery #D 10 stay over-collected');
});
