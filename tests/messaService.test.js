'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createMessaService, MessaServiceError, buildFloor } = require('../src/tables/messaService');

const ctx = (overrides = {}) => ({
  actor: 'operator_primary', role: 'operator', workspaceId: 'ws-1',
  sessionVersion: 1, sid: 'high-entropy-session-id', ...overrides,
});

test('floor exposes exact partial balance, mixed methods and remaining covers', () => {
  const rows = {
    tables: [{ id: 't1', table_number: 1, display_name: 'Mesa 1', capacity: 4, position_x: 15, position_y: 18, shape: 'round', active: true }],
    sessions: [{ id: 's1', table_id: 't1', service_session_id: 'service', status: 'open', covers_total: 5, opened_at: 'now' }],
    orders: [{ id: 'o1', table_session_id: 's1', table_command_number: 1, estado: 'EN_COCINA', totale: 50, items: [] }],
    lines: [
      { id: 'l1', table_session_id: 's1', order_id: 'o1', source_line_id: 'g1', source_line_index: 1, unit_index: 1, description: 'Pizza', product_snapshot: {}, net_amount: 20 },
      { id: 'l2', table_session_id: 's1', order_id: 'o1', source_line_id: 'g2', source_line_index: 2, unit_index: 1, description: 'Bibita', product_snapshot: {}, net_amount: 30 },
    ],
    transactions: [
      { id: 'p1', table_session_id: 's1', kind: 'payment', mode: 'item_selection', amount: 12, payment_method: 'efectivo', covers_settled: 1 },
      { id: 'p2', table_session_id: 's1', kind: 'payment', mode: 'custom_amount', amount: 8, payment_method: 'tarjeta', covers_settled: 0 },
    ],
    allocations: [
      { payment_transaction_id: 'p1', table_order_line_id: 'l1', amount: 12 },
      { payment_transaction_id: 'p2', table_order_line_id: 'l2', amount: 8 },
    ],
  };
  const table = buildFloor(rows)[0];
  assert.equal(table.name, 'Mesa 1');
  assert.equal(table.session.total, 50);
  assert.equal(table.session.paid, 20);
  assert.equal(table.session.outstanding, 30);
  assert.equal(table.session.coversRemaining, 4);
  assert.equal(table.session.nextEqualShare, 7.5);
  assert.deepEqual(table.session.paymentTotals, { efectivo: 12, tarjeta: 8 });
  assert.equal(table.session.lines[0].remaining, 8);
  assert.equal(table.session.lines[1].remaining, 22);
  assert.deepEqual(table.reservations, []);
});

test('floor keeps reservation identity separate from the open/free account state', () => {
  const [table] = buildFloor({
    tables: [{ id: 't1', table_number: 5, display_name: 'Mesa 5', capacity: 4, position_x: 50, position_y: 50, shape: 'square', active: true }],
    reservations: [{
      id: 'r1', table_id: 't1', table_session_id: null, status: 'booked',
      guest_name: 'Antonio', guest_phone: '600123123', covers_total: 4,
      reserved_at: '2026-08-01T18:00:00.000Z', duration_minutes: 120,
      note: 'Cumpleaños', version: 3, created_by: 'operator_primary', updated_by: 'waiter-1',
    }],
    sessions: [], orders: [], lines: [], transactions: [], allocations: [],
  });
  assert.equal(table.status, 'free');
  assert.equal(table.session, null);
  assert.deepEqual(table.reservations[0], {
    id: 'r1', tableId: 't1', tableSessionId: null, status: 'booked',
    guestName: 'Antonio', guestPhone: '600123123', coversTotal: 4,
    reservedAt: '2026-08-01T18:00:00.000Z', durationMinutes: 120,
    note: 'Cumpleaños', version: 3, createdAt: undefined, updatedAt: undefined,
    createdBy: 'operator_primary', updatedBy: 'waiter-1',
  });
});

test('a table without a session is free', () => {
  const [table] = buildFloor({
    tables: [{ id: 't1', table_number: 1, display_name: 'Mesa 1', position_x: 0, position_y: 0, shape: 'round', active: true }],
    sessions: [], orders: [], lines: [], transactions: [], allocations: [],
  });
  assert.equal(table.status, 'free');
  assert.equal(table.session, null);
});

test('a fully paid account disappears from the floor and the table is free', () => {
  const [table] = buildFloor({
    tables: [{ id: 't1', table_number: 3, display_name: 'Mesa 3', position_x: 0, position_y: 0, shape: 'round', active: true }],
    sessions: [{ id: 'closed', table_id: 't1', status: 'closed', covers_total: 2 }],
    orders: [], lines: [], transactions: [], allocations: [],
  });
  assert.equal(table.status, 'free');
  assert.equal(table.session, null);
});

test('open derives the current service session server-side', async () => {
  let args;
  const service = createMessaService({
    dao: { openSession: async (value) => { args = value; return { ok: true }; } },
    lifecycle: { currentCloseout: async () => ({ ok: true, session: { id: 'service-1', status: 'open' } }) },
  });
  await service.open({ context: ctx(), tableId: 'table-1', coversTotal: 5 });
  assert.deepEqual(args, {
    workspaceId: 'ws-1', byActor: 'operator_primary', tableId: 'table-1',
    serviceSessionId: 'service-1', coversTotal: 5,
  });
});

test('every added course creates a new order linked to the same table session', async () => {
  const created = [];
  const service = createMessaService({
    dao: { getSession: async () => ({ id: 'session-1', table_ref: 'Mesa 1', status: 'open' }) },
    createOrder: async (payload) => { created.push(payload); return { success: true, id: `#00${created.length}` }; },
  });
  const base = { context: ctx(), tableSessionId: 'session-1', items: [{ n: 'Pizza', p: 10 }], clientRequestId: 'request-0001' };
  const first = await service.addCommand(base);
  const second = await service.addCommand({ ...base, clientRequestId: 'request-0002' });
  assert.equal(first.orderId, '#001');
  assert.equal(second.orderId, '#002');
  assert.equal(created.length, 2);
  assert.ok(created.every((payload) => payload.table_session_id === 'session-1'));
  assert.ok(created.every((payload) => payload.canal === 'BANCO' && payload.tipo_consegna === 'RITIRO'));
  assert.ok(created.every((payload) => payload.estado === 'EN_COCINA'));
});

test('waiter cannot add a command to somebody else assigned table', async () => {
  const service = createMessaService({
    dao: { getSession: async () => ({ id: 's1', status: 'open', assigned_waiter_actor: 'other' }) },
  });
  await assert.rejects(
    service.addCommand({ context: ctx({ actor: 'waiter-1', role: 'waiter' }), tableSessionId: 's1', items: [{}], clientRequestId: 'request-0001' }),
    (error) => error instanceof MessaServiceError && error.code === 'MESSA_WAITER_NOT_ASSIGNED'
  );
});

test('a ready table command is marked served without creating a legacy payment', async () => {
  let changed = null;
  const service = createMessaService({
    dao: {
      getSession: async () => ({ id: 's1', status: 'open' }),
      getOrderForSession: async () => ({ id: '#123', table_session_id: 's1', estado: 'LISTO' }),
    },
    changeOrderState: async (...args) => { changed = args; return { success: true }; },
  });
  const result = await service.markServed({ context: ctx(), tableSessionId: 's1', orderId: '#123' });
  assert.equal(result.state, 'RETIRADO');
  assert.equal(changed[0], '#123');
  assert.equal(changed[1], 'RETIRADO');
  assert.equal(Object.prototype.hasOwnProperty.call(changed[2], 'metodo_pago'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(changed[2], 'cobrado'), false);
});

test('a command cannot be served before Cocina marks it ready', async () => {
  const service = createMessaService({
    dao: {
      getSession: async () => ({ id: 's1', status: 'open' }),
      getOrderForSession: async () => ({ id: '#123', table_session_id: 's1', estado: 'EN_COCINA' }),
    },
  });
  await assert.rejects(
    service.markServed({ context: ctx(), tableSessionId: 's1', orderId: '#123' }),
    (error) => error instanceof MessaServiceError && error.code === 'MESSA_COMMAND_NOT_READY'
  );
});

test('payment hashes trusted session id and a canonical semantic request', async () => {
  let args;
  const service = createMessaService({
    dao: { postPayment: async (value) => { args = value; return { ok: true }; } },
    hashSid: () => 'a'.repeat(64),
  });
  await service.pay({
    context: ctx(), tableSessionId: 's1', paymentMethod: 'tarjeta', mode: 'item_selection',
    lineIds: ['b', 'a'], coversSettled: 1, clientRequestId: 'payment-0001',
  });
  assert.equal(args.bySidHash, 'a'.repeat(64));
  assert.match(args.requestHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(args.lineIds, ['a', 'b']);
  assert.deepEqual(args.meta, { source: 'messa_dashboard' });
});

test('waiter cannot post money even if assigned', async () => {
  const service = createMessaService({ dao: {} });
  await assert.rejects(
    service.pay({ context: ctx({ actor: 'waiter-1', role: 'waiter' }) }),
    (error) => error instanceof MessaServiceError && error.code === 'MESSA_FORBIDDEN'
  );
});

test('waiter can move a reservation without layout or payment authority', async () => {
  let args;
  const service = createMessaService({
    dao: { saveReservation: async (value) => { args = value; return { ok: true }; } },
  });
  await service.saveReservation({
    context: ctx({ actor: 'waiter-1', role: 'waiter' }),
    reservation: {
      reservationId: 'r1', tableId: 't4', guestName: 'Antonio', guestPhone: '600',
      coversTotal: 4, reservedLocalDate: '2026-08-02', reservedLocalTime: '20:00',
      note: '', expectedVersion: 2,
    },
  });
  assert.deepEqual(args, {
    workspaceId: 'ws-1', byActor: 'waiter-1',
    reservationId: 'r1', tableId: 't4', guestName: 'Antonio', guestPhone: '600',
    coversTotal: 4, reservedLocalDate: '2026-08-02', reservedLocalTime: '20:00',
    note: '', expectedVersion: 2,
  });
  await assert.rejects(
    service.saveTable({ context: ctx({ actor: 'waiter-1', role: 'waiter' }), table: {} }),
    (error) => error instanceof MessaServiceError && error.code === 'MESSA_FORBIDDEN'
  );
});

test('waiter can cancel a reservation', async () => {
  let args;
  const service = createMessaService({
    dao: { setReservationStatus: async (value) => { args = value; return { ok: true }; } },
  });
  await service.setReservationStatus({
    context: ctx({ actor: 'waiter-1', role: 'waiter' }),
    reservationId: 'r1', expectedVersion: 4, status: 'cancelled',
  });
  assert.deepEqual(args, {
    workspaceId: 'ws-1', byActor: 'waiter-1', reservationId: 'r1',
    expectedVersion: 4, status: 'cancelled',
  });
});

test('opening a reservation derives the service and forwards its version atomically', async () => {
  let args;
  const service = createMessaService({
    dao: { openReservation: async (value) => { args = value; return { ok: true, sessionId: 's2' }; } },
    lifecycle: { currentCloseout: async () => ({ ok: true, session: { id: 'service-2', status: 'open' } }) },
  });
  const result = await service.openReservation({
    context: ctx({ actor: 'waiter-1', role: 'waiter' }), reservationId: 'r1', expectedVersion: 5,
  });
  assert.equal(result.sessionId, 's2');
  assert.deepEqual(args, {
    workspaceId: 'ws-1', byActor: 'waiter-1', reservationId: 'r1',
    expectedVersion: 5, serviceSessionId: 'service-2',
  });
});

test('a reordered item after settlement opens a brand-new account id', async () => {
  let sequence = 0;
  const service = createMessaService({
    dao: { openSession: async () => ({ ok: true, sessionId: `new-session-${++sequence}` }) },
    lifecycle: { currentCloseout: async () => ({ ok: true, session: { id: 'service-1', status: 'open' } }) },
  });
  const first = await service.open({ context: ctx(), tableId: 'table-3', coversTotal: 2 });
  const second = await service.open({ context: ctx(), tableId: 'table-3', coversTotal: 2 });
  assert.notEqual(first.sessionId, second.sessionId);
  assert.deepEqual([first.sessionId, second.sessionId], ['new-session-1', 'new-session-2']);
});

test('a new account never inherits products or payments from the closed account', () => {
  const [table] = buildFloor({
    tables: [{ id: 't1', table_number: 3, display_name: 'Mesa 3', position_x: 0, position_y: 0, shape: 'round', active: true }],
    sessions: [{ id: 'new', table_id: 't1', service_session_id: 'service', status: 'open', covers_total: 2 }],
    orders: [
      { id: 'old-order', table_session_id: 'closed', table_command_number: 1, estado: 'RETIRADO', totale: 50, items: [] },
      { id: 'new-order', table_session_id: 'new', table_command_number: 1, estado: 'EN_COCINA', totale: 4, items: [] },
    ],
    lines: [
      { id: 'old-line', table_session_id: 'closed', order_id: 'old-order', description: 'Cuenta anterior', net_amount: 50 },
      { id: 'new-line', table_session_id: 'new', order_id: 'new-order', description: 'Café nuevo', net_amount: 4 },
    ],
    transactions: [{ id: 'old-payment', table_session_id: 'closed', kind: 'payment', amount: 50, payment_method: 'tarjeta', covers_settled: 2 }],
    allocations: [{ payment_transaction_id: 'old-payment', table_order_line_id: 'old-line', amount: 50 }],
  });
  assert.equal(table.session.id, 'new');
  assert.equal(table.session.total, 4);
  assert.equal(table.session.paid, 0);
  assert.equal(table.session.outstanding, 4);
  assert.deepEqual(table.session.paymentTotals, {});
  assert.deepEqual(table.session.lines.map((line) => line.description), ['Café nuevo']);
});
