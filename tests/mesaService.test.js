'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createMesaService, MesaServiceError, buildFloor } = require('../src/tables/mesaService');

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

test('a table that was never positioned exposes null coordinates, not (0,0)', () => {
  const [table] = buildFloor({
    tables: [{ id: 't1', table_number: 7, display_name: 'Mesa 7', position_x: null, position_y: null, shape: 'round', active: true }],
    sessions: [], orders: [], lines: [], transactions: [], allocations: [],
  });
  // Number(null) === 0 would make this indistinguishable from a table
  // genuinely, deliberately saved at the top-left corner -- the regression
  // this test guards against.
  assert.equal(table.x, null);
  assert.equal(table.y, null);
});

test('a table genuinely saved at the origin keeps its real (0,0) coordinates', () => {
  const [table] = buildFloor({
    tables: [{ id: 't1', table_number: 8, display_name: 'Mesa 8', position_x: 0, position_y: 0, shape: 'round', active: true }],
    sessions: [], orders: [], lines: [], transactions: [], allocations: [],
  });
  assert.equal(table.x, 0);
  assert.equal(table.y, 0);
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

test('open derives the current service session server-side and never sends covers', async () => {
  let args;
  const service = createMesaService({
    dao: { openSession: async (value) => { args = value; return { ok: true }; } },
    lifecycle: { currentCloseout: async () => ({ ok: true, session: { id: 'service-1', status: 'open' } }) },
  });
  await service.open({ context: ctx(), tableId: 'table-1' });
  assert.deepEqual(args, {
    workspaceId: 'ws-1', byActor: 'operator_primary', tableId: 'table-1',
    serviceSessionId: 'service-1',
  });
});

test('every added course creates a new order linked to the same table session', async () => {
  const created = [];
  const service = createMesaService({
    dao: { getSession: async () => ({ id: 'session-1', table_ref: 'Mesa 1', status: 'open', covers_total: 4 }) },
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
  // Session already has covers -- a later comanda never needs (or forwards) them.
  assert.ok(created.every((payload) => payload.table_covers_total_input === null));
});

test('the first comanda on a walk-in table requires real covers and forwards them atomically', async () => {
  const created = [];
  const service = createMesaService({
    dao: { getSession: async () => ({ id: 'session-1', table_ref: 'Mesa 1', status: 'open', covers_total: null }) },
    createOrder: async (payload) => { created.push(payload); return { success: true, id: '#001' }; },
  });
  const base = { context: ctx(), tableSessionId: 'session-1', items: [{ n: 'Pizza', p: 10 }], clientRequestId: 'request-0001' };
  await assert.rejects(
    service.addCommand(base),
    (error) => error instanceof MesaServiceError && error.code === 'MESA_COVERS_REQUIRED'
  );
  await assert.rejects(
    service.addCommand({ ...base, coversTotal: 0 }),
    (error) => error instanceof MesaServiceError && error.code === 'MESA_COVERS_REQUIRED'
  );
  await service.addCommand({ ...base, coversTotal: 4 });
  assert.equal(created.length, 1);
  assert.equal(created[0].table_covers_total_input, 4);
});

// MESA_AMBIGUOUS_RETRY_IDEMPOTENT -- the real idempotency mechanism lives in
// agentOrdini.js's creaOrdine (a client_req_id lookup before any insert,
// unchanged by this P0 fix -- see its own "Idempotency check" comment: "Se
// il frontend passa client_req_id... copre il caso Railway ha creato
// l'ordine ma la risposta non è arrivata al client"). This proves
// mesaService.addCommand's OWN contract: it forwards the SAME
// clientRequestId on every call (so a retry is recognizable at all) and
// faithfully surfaces createOrder's idempotent flag rather than masking it.
test('addCommand forwards the identical clientRequestId on every call and surfaces an idempotent replay untouched', async () => {
  const seen = [];
  let callCount = 0;
  const service = createMesaService({
    dao: { getSession: async () => ({ id: 'session-1', status: 'open', covers_total: 4 }) },
    createOrder: async (payload) => {
      seen.push(payload.client_req_id);
      callCount += 1;
      // Simulate creaOrdine's real idempotency replay on the second call.
      if (callCount === 1) return { success: true, id: '#001' };
      return { success: true, id: '#001', idempotent: true };
    },
  });
  const base = { context: ctx(), tableSessionId: 'session-1', items: [{ n: 'Pizza', p: 10 }], clientRequestId: 'same-request-id-0001' };
  const first = await service.addCommand(base);
  const retry = await service.addCommand(base);
  assert.deepEqual(seen, ['same-request-id-0001', 'same-request-id-0001']);
  assert.equal(first.orderId, '#001');
  assert.equal(first.idempotent, false);
  assert.equal(retry.orderId, '#001');
  assert.equal(retry.idempotent, true);
});

test('a genuinely different retry (new clientRequestId) is never conflated with a prior one', async () => {
  const seen = [];
  const service = createMesaService({
    dao: { getSession: async () => ({ id: 'session-1', status: 'open', covers_total: 4 }) },
    createOrder: async (payload) => { seen.push(payload.client_req_id); return { success: true, id: `#00${seen.length}` }; },
  });
  const base = { context: ctx(), tableSessionId: 'session-1', items: [{ n: 'Pizza', p: 10 }] };
  await service.addCommand({ ...base, clientRequestId: 'request-a' });
  await service.addCommand({ ...base, clientRequestId: 'request-b' });
  assert.deepEqual(seen, ['request-a', 'request-b']);
});

test('waiter cannot add a command to somebody else assigned table', async () => {
  const service = createMesaService({
    dao: { getSession: async () => ({ id: 's1', status: 'open', assigned_waiter_actor: 'other' }) },
  });
  await assert.rejects(
    service.addCommand({ context: ctx({ actor: 'waiter-1', role: 'waiter' }), tableSessionId: 's1', items: [{}], clientRequestId: 'request-0001' }),
    (error) => error instanceof MesaServiceError && error.code === 'MESA_WAITER_NOT_ASSIGNED'
  );
});

// MESA_SEND_TO_KITCHEN_P0_FIX (2026-08-14) -- setCovers persists covers the
// moment the operator selects them, server-authoritative, instead of only
// ever landing as a side effect of the first comanda's own success. See
// mesaService.js's own setCovers comment and migrations/2026-08-14_mesa_
// covers_authoritative_on_selection.sql for the full root-cause note.
test('setCovers forwards a valid selection straight to the DAO on an open session', async () => {
  let args;
  const service = createMesaService({
    dao: {
      getSession: async () => ({ id: 'session-1', status: 'open', covers_total: null }),
      setCovers: async (value) => { args = value; return { ok: true, sessionId: 'session-1', coversTotal: value.coversTotal }; },
    },
  });
  const result = await service.setCovers({ context: ctx(), tableSessionId: 'session-1', coversTotal: 2 });
  assert.deepEqual(args, { workspaceId: 'ws-1', byActor: 'operator_primary', tableSessionId: 'session-1', coversTotal: 2 });
  assert.equal(result.coversTotal, 2);
});

test('setCovers rejects a non-integer / out-of-range value before ever touching the DAO', async () => {
  let called = false;
  const service = createMesaService({
    dao: {
      getSession: async () => ({ id: 'session-1', status: 'open', covers_total: null }),
      setCovers: async () => { called = true; return { ok: true }; },
    },
  });
  for (const bad of [0, -1, 100, 1.5, NaN, null, undefined]) {
    await assert.rejects(
      service.setCovers({ context: ctx(), tableSessionId: 'session-1', coversTotal: bad }),
      (error) => error instanceof MesaServiceError && error.code === 'MESA_INVALID_REQUEST' && error.status === 400
    );
  }
  assert.equal(called, false);
});

test('setCovers rejects a session that is no longer open -- the exact boundary that let 2026-08-14\'s draft vanish', async () => {
  const service = createMesaService({
    dao: { getSession: async () => ({ id: 'session-1', status: 'closed', covers_total: null }) },
  });
  await assert.rejects(
    service.setCovers({ context: ctx(), tableSessionId: 'session-1', coversTotal: 2 }),
    (error) => error instanceof MesaServiceError && error.code === 'MESA_SESSION_NOT_OPEN' && error.status === 409
  );
});

test('setCovers rejects an unknown session/table', async () => {
  const service = createMesaService({ dao: { getSession: async () => null } });
  await assert.rejects(
    service.setCovers({ context: ctx(), tableSessionId: 'ghost', coversTotal: 2 }),
    (error) => error instanceof MesaServiceError && error.code === 'MESA_SESSION_NOT_FOUND' && error.status === 404
  );
});

test('setCovers: a waiter cannot set covers on a table assigned to someone else', async () => {
  const service = createMesaService({
    dao: { getSession: async () => ({ id: 's1', status: 'open', covers_total: null, assigned_waiter_actor: 'other' }) },
  });
  await assert.rejects(
    service.setCovers({ context: ctx({ actor: 'waiter-1', role: 'waiter' }), tableSessionId: 's1', coversTotal: 2 }),
    (error) => error instanceof MesaServiceError && error.code === 'MESA_WAITER_NOT_ASSIGNED' && error.status === 403
  );
});

// FIRST_COMMAND_COVERS_PERSIST end-to-end at the service layer: covers set
// via setCovers are already durable by the time addCommand runs, so the
// first comanda's own atomic covers-requirement becomes a no-op (matching
// mesa_prepare_table_order_v1's own documented "later comanda" branch).
test('after setCovers, the first addCommand no longer needs (or forwards) coversTotal at all', async () => {
  const created = [];
  let sessionCovers = null;
  const service = createMesaService({
    dao: {
      getSession: async () => ({ id: 'session-1', table_ref: 'Mesa 1', status: 'open', covers_total: sessionCovers }),
      setCovers: async (value) => { sessionCovers = value.coversTotal; return { ok: true, coversTotal: sessionCovers }; },
    },
    createOrder: async (payload) => { created.push(payload); return { success: true, id: '#001' }; },
  });
  await service.setCovers({ context: ctx(), tableSessionId: 'session-1', coversTotal: 2 });
  await service.addCommand({ context: ctx(), tableSessionId: 'session-1', items: [{ n: 'Pizza', p: 10 }], clientRequestId: 'r1' });
  assert.equal(created.length, 1);
  assert.equal(created[0].table_covers_total_input, null);
});

test('addCommand rejects a session that is no longer open (e.g. already settling/closed)', async () => {
  const service = createMesaService({
    dao: { getSession: async () => ({ id: 's1', status: 'closed' }) },
  });
  await assert.rejects(
    service.addCommand({ context: ctx(), tableSessionId: 's1', items: [{ n: 'Pizza' }], clientRequestId: 'r1' }),
    (error) => error instanceof MesaServiceError && error.code === 'MESA_SESSION_NOT_OPEN' && error.status === 409
  );
});

test('addCommand rejects an empty/missing item list before ever touching the DAO', async () => {
  let createOrderCalled = false;
  const service = createMesaService({
    dao: { getSession: async () => ({ id: 's1', status: 'open', covers_total: 4 }) },
    createOrder: async () => { createOrderCalled = true; return { success: true, id: '#1' }; },
  });
  await assert.rejects(
    service.addCommand({ context: ctx(), tableSessionId: 's1', items: [], clientRequestId: 'r1' }),
    (error) => error instanceof MesaServiceError && error.code === 'MESA_ITEMS_REQUIRED' && error.status === 400
  );
  await assert.rejects(
    service.addCommand({ context: ctx(), tableSessionId: 's1', clientRequestId: 'r1' }),
    (error) => error instanceof MesaServiceError && error.code === 'MESA_ITEMS_REQUIRED'
  );
  assert.equal(createOrderCalled, false);
});

test('addCommand and markServed both reject a session/table that does not exist, rather than falling through to a generic error', async () => {
  const service = createMesaService({
    dao: { getSession: async () => null },
  });
  await assert.rejects(
    service.addCommand({ context: ctx(), tableSessionId: 'ghost', items: [{ n: 'Pizza' }], clientRequestId: 'r1' }),
    (error) => error instanceof MesaServiceError && error.code === 'MESA_SESSION_NOT_FOUND' && error.status === 404
  );
  await assert.rejects(
    service.markServed({ context: ctx(), tableSessionId: 'ghost', orderId: '#1' }),
    (error) => error instanceof MesaServiceError && error.code === 'MESA_SESSION_NOT_FOUND' && error.status === 404
  );
});

test('a ready table command is marked served without creating a legacy payment', async () => {
  let changed = null;
  const service = createMesaService({
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
  const service = createMesaService({
    dao: {
      getSession: async () => ({ id: 's1', status: 'open' }),
      getOrderForSession: async () => ({ id: '#123', table_session_id: 's1', estado: 'EN_COCINA' }),
    },
  });
  await assert.rejects(
    service.markServed({ context: ctx(), tableSessionId: 's1', orderId: '#123' }),
    (error) => error instanceof MesaServiceError && error.code === 'MESA_COMMAND_NOT_READY'
  );
});

test('payment hashes trusted session id and a canonical semantic request', async () => {
  let args;
  const service = createMesaService({
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
  assert.deepEqual(args.meta, { source: 'mesa_dashboard' });
});

test('waiter cannot post money even if assigned', async () => {
  const service = createMesaService({ dao: {} });
  await assert.rejects(
    service.pay({ context: ctx({ actor: 'waiter-1', role: 'waiter' }) }),
    (error) => error instanceof MesaServiceError && error.code === 'MESA_FORBIDDEN'
  );
});

test('waiter can move a reservation without layout or payment authority', async () => {
  let args;
  const service = createMesaService({
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
    (error) => error instanceof MesaServiceError && error.code === 'MESA_FORBIDDEN'
  );
});

test('waiter can cancel a reservation', async () => {
  let args;
  const service = createMesaService({
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
  const service = createMesaService({
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
  const service = createMesaService({
    dao: { openSession: async () => ({ ok: true, sessionId: `new-session-${++sequence}` }) },
    lifecycle: { currentCloseout: async () => ({ ok: true, session: { id: 'service-1', status: 'open' } }) },
  });
  const first = await service.open({ context: ctx(), tableId: 'table-3' });
  const second = await service.open({ context: ctx(), tableId: 'table-3' });
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

test('a freshly opened walk-in Mesa has no covers yet and nothing to pay', () => {
  const [table] = buildFloor({
    tables: [{ id: 't1', table_number: 6, display_name: 'Mesa 6', position_x: 0, position_y: 0, shape: 'square', active: true }],
    sessions: [{ id: 's1', table_id: 't1', service_session_id: 'service', status: 'open', covers_total: null }],
    orders: [], lines: [], transactions: [], allocations: [],
  });
  assert.equal(table.status, 'open');
  assert.equal(table.session.coversTotal, null);
  assert.equal(table.session.coversRemaining, 0);
  assert.equal(table.session.outstanding, 0);
  assert.equal(table.session.nextEqualShare, 0);
});

test('releasing an empty table forwards the session id through to the DAO', async () => {
  let args;
  const service = createMesaService({
    dao: { releaseEmptySession: async (value) => { args = value; return { ok: true, status: 'closed' }; } },
  });
  const result = await service.releaseEmptyTable({ context: ctx(), tableSessionId: 's1' });
  assert.deepEqual(args, { workspaceId: 'ws-1', byActor: 'operator_primary', tableSessionId: 's1' });
  assert.equal(result.status, 'closed');
});

test('a waiter can release their own accidentally-opened empty table', async () => {
  let args;
  const service = createMesaService({
    dao: { releaseEmptySession: async (value) => { args = value; return { ok: true }; } },
  });
  await service.releaseEmptyTable({ context: ctx({ actor: 'waiter-1', role: 'waiter' }), tableSessionId: 's1' });
  assert.equal(args.byActor, 'waiter-1');
});

// P0-B.1 — closeTable is the distinct, explicit "Cerrar mesa" action for an
// OCCUPIED table (releaseEmptyTable above stays scoped to the never-ordered
// case). These tests only prove the service layer forwards intent correctly
// -- the financial/kitchen-completeness decision itself lives in
// mesa_close_session_v1 and is covered by the migration's own static test.
test('closing a table forwards the session id through to the DAO, force defaulted false', async () => {
  let args;
  const service = createMesaService({
    dao: { closeSession: async (value) => { args = value; return { ok: true, status: 'closed', forced: false }; } },
  });
  const result = await service.closeTable({ context: ctx(), tableSessionId: 's1' });
  assert.deepEqual(args, { workspaceId: 'ws-1', byActor: 'operator_primary', tableSessionId: 's1', force: false });
  assert.equal(result.status, 'closed');
});

test('closeTable only forwards force=true when explicitly requested', async () => {
  let args;
  const service = createMesaService({
    dao: { closeSession: async (value) => { args = value; return { ok: true }; } },
  });
  await service.closeTable({ context: ctx(), tableSessionId: 's1', force: true });
  assert.equal(args.force, true);
});

test('a waiter can close a table they have been serving', async () => {
  let args;
  const service = createMesaService({
    dao: { closeSession: async (value) => { args = value; return { ok: true }; } },
  });
  await service.closeTable({ context: ctx({ actor: 'waiter-1', role: 'waiter' }), tableSessionId: 's1' });
  assert.equal(args.byActor, 'waiter-1');
});

test('closeTable propagates the RPC error code untouched (e.g. genuine pending kitchen work)', async () => {
  const service = createMesaService({
    dao: { closeSession: async () => { const e = new Error('MESA_TABLE_HAS_ACTIVE_ORDERS'); e.code = 'MESA_TABLE_HAS_ACTIVE_ORDERS'; throw e; } },
  });
  await assert.rejects(
    service.closeTable({ context: ctx(), tableSessionId: 's1' }),
    (error) => error.code === 'MESA_TABLE_HAS_ACTIVE_ORDERS'
  );
});
