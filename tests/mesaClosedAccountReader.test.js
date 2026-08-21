'use strict';

// ===============================================================
// ACC-01 (2026-08-21 forensic audit) — a closed table's account must stay
// readable.
//
// `GET /floor` was the ONLY read route in the Mesa API (one read, twelve
// writes), and listFloorRows filters table_sessions to `status=eq.open`, then
// scopes orders/lines/transactions/allocations to those session ids. The moment
// an operator closed a table, its account, its comandas and its payment history
// had no surface left to appear on — buildFloor returns
// `status:'free', session:null` for it. The durable rows were always intact
// (closing a table mutates nothing but table_sessions); they were unreachable.
//
// The fixture is the REAL 2026-08-20 Mesa 4 session b490d667:
//
//   comanda 1  #999015  101.00  tarjeta 33.50 + bizum 20 + efectivo 30 + tarjeta 17.50
//   comanda 2  #999017   27.50  bizum 27.50            (the two extra pizzas)
//   ---------------------------------------------------------------
//   total 128.50 · paid 128.50 · outstanding 0.00 · closed 21:30:01
// ===============================================================

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createMesaService, buildFloor, buildClosedAccount, projectSessionAccount,
} = require('../src/tables/mesaService');

const ctx = (overrides = {}) => ({
  actor: 'owner', role: 'owner', workspaceId: 'ws-1',
  sessionVersion: 1, sid: 'high-entropy-session-id', ...overrides,
});

const SESSION_ID = 'b490d667-5747-485b-8821-fdbdb579446f';
const TABLE_ID = '11111111-2222-4333-8444-555555555555';

const closedSession = (overrides = {}) => ({
  id: SESSION_ID, workspace_id: 'ws-1', table_id: TABLE_ID,
  service_session_id: '480eca89-33cd-43ba-ac7f-5ed0a0473639',
  table_ref: 'Mesa 4', status: 'closed', assigned_waiter_actor: null,
  covers_total: 4, next_command_number: 3,
  opened_at: '2026-08-20T19:11:02Z', settled_at: '2026-08-20T19:30:01Z',
  closed_at: '2026-08-20T19:30:01Z', updated_at: '2026-08-20T19:30:01Z',
  updated_by: 'owner', ...overrides,
});

const MESA_4_ROWS = {
  orders: [
    { id: '#999015', table_session_id: SESSION_ID, table_command_number: 1, service_order_number: 3,
      estado: 'RETIRADO', totale: 101, items: [], hora: '21:13', nota: null, ts: 1 },
    { id: '#999017', table_session_id: SESSION_ID, table_command_number: 2, service_order_number: 5,
      estado: 'RETIRADO', totale: 27.5, items: [], hora: '21:27', nota: null, ts: 2 },
  ],
  lines: [
    { id: 'l1', table_session_id: SESSION_ID, order_id: '#999015', source_line_index: 1, unit_index: 1,
      description: 'El Divino Codino', product_snapshot: {}, net_amount: 101 },
    { id: 'l4', table_session_id: SESSION_ID, order_id: '#999017', source_line_index: 1, unit_index: 1,
      description: 'La Pulga', product_snapshot: {}, net_amount: 13 },
    { id: 'l5', table_session_id: SESSION_ID, order_id: '#999017', source_line_index: 2, unit_index: 1,
      description: 'Il Tulipano Nero', product_snapshot: {}, net_amount: 14.5 },
  ],
  transactions: [
    { id: 'tx1', table_session_id: SESSION_ID, kind: 'payment', mode: 'item_selection', amount: 33.5, payment_method: 'tarjeta', covers_settled: 1, by_actor: 'owner', created_at: '2026-08-20T19:23:34Z' },
    { id: 'tx2', table_session_id: SESSION_ID, kind: 'payment', mode: 'custom_amount', amount: 20, payment_method: 'bizum', covers_settled: 1, by_actor: 'owner', created_at: '2026-08-20T19:24:09Z' },
    { id: 'tx3', table_session_id: SESSION_ID, kind: 'payment', mode: 'custom_amount', amount: 30, payment_method: 'efectivo', covers_settled: 1, by_actor: 'owner', created_at: '2026-08-20T19:25:12Z' },
    { id: 'tx4', table_session_id: SESSION_ID, kind: 'payment', mode: 'full', amount: 17.5, payment_method: 'tarjeta', covers_settled: 1, by_actor: 'owner', created_at: '2026-08-20T19:25:23Z' },
    { id: 'tx5', table_session_id: SESSION_ID, kind: 'payment', mode: 'full', amount: 27.5, payment_method: 'bizum', covers_settled: 0, by_actor: 'owner', created_at: '2026-08-20T19:29:54Z' },
  ],
  allocations: [
    { payment_transaction_id: 'tx1', table_order_line_id: 'l1', amount: 33.5 },
    { payment_transaction_id: 'tx2', table_order_line_id: 'l1', amount: 20 },
    { payment_transaction_id: 'tx3', table_order_line_id: 'l1', amount: 30 },
    { payment_transaction_id: 'tx4', table_order_line_id: 'l1', amount: 17.5 },
    { payment_transaction_id: 'tx5', table_order_line_id: 'l4', amount: 13 },
    { payment_transaction_id: 'tx5', table_order_line_id: 'l5', amount: 14.5 },
  ],
};

const TABLE_ROW = { id: TABLE_ID, table_number: 4, display_name: 'Mesa 4', capacity: 4 };

const readOnlyDao = (overrides = {}) => ({
  getSessionWithCloseFields: async () => closedSession(),
  listSessionAccountRows: async () => MESA_4_ROWS,
  getTableById: async () => TABLE_ROW,
  listRecentClosedSessions: async () => [closedSession()],
  ...overrides,
});

// ── the defect this fixes ──────────────────────────────────────

test('ACC-01 regression: buildFloor still hides a closed session, which is why the reader exists', () => {
  const tables = buildFloor({
    tables: [{ id: TABLE_ID, table_number: 4, display_name: 'Mesa 4', capacity: 4, active: true }],
    sessions: [closedSession()],
    reservations: [], ...MESA_4_ROWS,
  });
  assert.equal(tables[0].status, 'free');
  assert.equal(tables[0].session, null);
});

// ── the account itself ─────────────────────────────────────────

test('the closed Mesa 4 account is fully reconstructable: 128.50 total, 128.50 paid, 0 pending', async () => {
  const service = createMesaService({ dao: readOnlyDao() });
  const res = await service.sessionAccount({ context: ctx(), tableSessionId: SESSION_ID });

  assert.equal(res.ok, true);
  assert.equal(res.tableSessionId, SESSION_ID);
  assert.equal(res.status, 'closed');
  assert.equal(res.closedAt, '2026-08-20T19:30:01Z');
  assert.equal(res.closedBy, 'owner');
  assert.equal(res.table.number, 4);

  assert.equal(res.account.total, 128.5);
  assert.equal(res.account.paid, 128.5);
  assert.equal(res.account.outstanding, 0);
  assert.equal(res.account.coversTotal, 4);
  assert.equal(res.account.openedAt, '2026-08-20T19:11:02Z');
});

test('both comandas are visible, with their own numbers and totals', async () => {
  const service = createMesaService({ dao: readOnlyDao() });
  const { account } = await service.sessionAccount({ context: ctx(), tableSessionId: SESSION_ID });

  const ids = account.commands.map((c) => c.id);
  assert.deepEqual(ids, ['#999015', '#999017']);
  const byId = Object.fromEntries(account.commands.map((c) => [c.id, c]));
  assert.equal(byId['#999015'].commandNumber, 1);
  assert.equal(byId['#999015'].total, 101);
  assert.equal(byId['#999017'].commandNumber, 2);
  assert.equal(byId['#999017'].total, 27.5);
  // the post-settlement comanda is the whole point — it must not be dropped
  assert.ok(ids.includes('#999017'), 'the comanda added after the table was settled must survive close');
});

test('the full payment history survives, in order, with its real methods', async () => {
  const service = createMesaService({ dao: readOnlyDao() });
  const { account } = await service.sessionAccount({ context: ctx(), tableSessionId: SESSION_ID });

  assert.equal(account.payments.length, 5);
  assert.deepEqual(account.payments.map((p) => p.amount), [33.5, 20, 30, 17.5, 27.5]);
  assert.deepEqual(account.payments.map((p) => p.method),
    ['tarjeta', 'bizum', 'efectivo', 'tarjeta', 'bizum']);
  assert.equal(account.payments.reduce((s, p) => s + p.amount, 0), 128.5);
});

test('per-method receipts match the certified split', async () => {
  const service = createMesaService({ dao: readOnlyDao() });
  const { account } = await service.sessionAccount({ context: ctx(), tableSessionId: SESSION_ID });
  assert.equal(account.paymentTotals.tarjeta, 51);   // 33.50 + 17.50
  assert.equal(account.paymentTotals.bizum, 47.5);   // 20.00 + 27.50
  assert.equal(account.paymentTotals.efectivo, 30);
  const sum = Object.values(account.paymentTotals).reduce((s, v) => s + v, 0);
  assert.equal(sum, 128.5);
});

test('every line is present and fully allocated', async () => {
  const service = createMesaService({ dao: readOnlyDao() });
  const { account } = await service.sessionAccount({ context: ctx(), tableSessionId: SESSION_ID });
  assert.equal(account.lines.length, 3);
  assert.deepEqual(account.lines.map((l) => l.description),
    ['El Divino Codino', 'La Pulga', 'Il Tulipano Nero']);
  for (const line of account.lines) assert.equal(line.remaining, 0);
});

// ── it is the SAME arithmetic as the open floor ────────────────

test('the closed reader and the open floor share one projection, so they cannot disagree', () => {
  const openSession = closedSession({ status: 'open', closed_at: null, settled_at: null });
  const floorTable = buildFloor({
    tables: [{ id: TABLE_ID, table_number: 4, display_name: 'Mesa 4', capacity: 4, active: true }],
    sessions: [openSession], reservations: [], ...MESA_4_ROWS,
  })[0];
  const closed = buildClosedAccount(openSession, MESA_4_ROWS, TABLE_ROW);

  // same session row in, same economic object out — field for field
  assert.deepEqual(closed.account, floorTable.session);
});

test('projectSessionAccount reads no status at all — that is why it can serve both', () => {
  const base = { lines: [], transactions: [], orders: [] };
  const asOpen = projectSessionAccount(closedSession({ status: 'open' }), base);
  const asClosed = projectSessionAccount(closedSession({ status: 'closed' }), base);
  assert.deepEqual(asOpen, asClosed);
});

// ── read-only, by construction ─────────────────────────────────

test('reading a closed account performs ZERO writes and never reopens the table', async () => {
  const calls = [];
  const spy = new Proxy(readOnlyDao(), {
    get(target, prop) {
      calls.push(prop);
      return target[prop];
    },
  });
  const service = createMesaService({ dao: spy });
  const res = await service.sessionAccount({ context: ctx(), tableSessionId: SESSION_ID });

  // only the three read helpers are ever touched
  assert.deepEqual([...new Set(calls)].sort(),
    ['getSessionWithCloseFields', 'getTableById', 'listSessionAccountRows']);
  for (const forbidden of ['openSession', 'closeSession', 'postPayment', 'setCovers', 'releaseEmptySession', 'saveTable']) {
    assert.ok(!calls.includes(forbidden), `${forbidden} must never be reached by a read`);
  }
  // and the session it reports is still closed
  assert.equal(res.status, 'closed');
});

test('the service module exposes no write path from either new reader', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'tables', 'mesaService.js'), 'utf8');
  const start = src.indexOf('async recentClosedSessions(');
  const end = src.indexOf('async open(', start);
  assert.ok(start > -1 && end > start, 'both readers must be locatable in source');
  const readerBody = src.slice(start, end);
  for (const forbidden of ['dao.openSession', 'dao.closeSession', 'dao.postPayment', 'dao.setCovers', 'dao.saveTable', 'rpc(']) {
    assert.ok(!readerBody.includes(forbidden), `readers must not call ${forbidden}`);
  }
});

test('the DAO helpers issue GETs only — no rpc, no POST', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'tables', 'mesaDao.js'), 'utf8');
  for (const fn of ['listSessionAccountRows', 'listRecentClosedSessions', 'getSessionWithCloseFields', 'getTableById']) {
    const start = src.indexOf(`async function ${fn}`);
    assert.ok(start > -1, `${fn} must exist`);
    const body = src.slice(start, src.indexOf('\n}\n', start));
    assert.ok(!body.includes('rpc('), `${fn} must not call an RPC`);
    assert.ok(body.includes('select('), `${fn} must read through select()`);
  }
});

// ── scoping and refusals ───────────────────────────────────────

test('a malformed session id is refused before any query runs', async () => {
  let queried = false;
  const service = createMesaService({
    dao: readOnlyDao({ getSessionWithCloseFields: async () => { queried = true; return null; } }),
  });
  for (const bad of ['not-a-uuid', '', null, undefined, '../../etc/passwd', 42]) {
    await assert.rejects(
      service.sessionAccount({ context: ctx(), tableSessionId: bad }),
      (error) => error.code === 'MESA_INVALID_REQUEST' && error.status === 400
    );
  }
  assert.equal(queried, false, 'a malformed id must never reach the database');
});

test('an unknown session is a clean 404, not an empty account', async () => {
  const service = createMesaService({
    dao: readOnlyDao({ getSessionWithCloseFields: async () => null }),
  });
  await assert.rejects(
    service.sessionAccount({ context: ctx(), tableSessionId: SESSION_ID }),
    (error) => error.code === 'MESA_SESSION_NOT_FOUND' && error.status === 404
  );
});

test('the reader is workspace-scoped through the same context gate as the floor', async () => {
  const seen = [];
  const service = createMesaService({
    dao: readOnlyDao({
      getSessionWithCloseFields: async (workspaceId) => { seen.push(workspaceId); return closedSession(); },
    }),
  });
  await service.sessionAccount({ context: ctx({ workspaceId: 'ws-9' }), tableSessionId: SESSION_ID });
  assert.deepEqual(seen, ['ws-9']);
});

test('an unauthenticated or wrong-role caller gets nothing', async () => {
  const service = createMesaService({ dao: readOnlyDao() });
  await assert.rejects(
    service.sessionAccount({ context: null, tableSessionId: SESSION_ID }),
    (error) => error.code === 'MESA_UNAUTHENTICATED' && error.status === 401
  );
  await assert.rejects(
    service.sessionAccount({ context: ctx({ role: 'repartidor' }), tableSessionId: SESSION_ID }),
    (error) => error.code === 'MESA_FORBIDDEN' && error.status === 403
  );
  await assert.rejects(
    service.recentClosedSessions({ context: ctx({ role: 'repartidor' }) }),
    (error) => error.code === 'MESA_FORBIDDEN' && error.status === 403
  );
});

// ── the recent-closed list ─────────────────────────────────────

test('the recent-closed list is a short index, not a reporting surface', async () => {
  const limits = [];
  const service = createMesaService({
    dao: readOnlyDao({
      listRecentClosedSessions: async (_ws, limit) => { limits.push(limit); return [closedSession()]; },
    }),
  });
  const res = await service.recentClosedSessions({ context: ctx() });
  assert.equal(res.ok, true);
  assert.equal(res.sessions.length, 1);
  assert.equal(res.sessions[0].tableSessionId, SESSION_ID);
  assert.equal(res.sessions[0].tableRef, 'Mesa 4');
  assert.equal(res.sessions[0].closedAt, '2026-08-20T19:30:01Z');
  // it carries no money: the list is for choosing a session, the account is the
  // surface that reports one
  assert.equal(res.sessions[0].total, undefined);
  assert.equal(res.sessions[0].paid, undefined);

  await service.recentClosedSessions({ context: ctx(), limit: 5 });
  await service.recentClosedSessions({ context: ctx(), limit: 9999 });
  await service.recentClosedSessions({ context: ctx(), limit: -3 });
  await service.recentClosedSessions({ context: ctx(), limit: 'nonsense' });
  assert.deepEqual(limits, [10, 5, 25, 1, 10], 'limit is clamped to a sane bounded range');
});
