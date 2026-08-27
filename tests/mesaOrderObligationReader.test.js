'use strict';

// ===============================================================
// AJUSTE COMERCIAL V1 -- READER GAP (PREREQUISITE A).
//
// The manual commercial-adjustment HTTP route (POST /sessions/:id/adjustments ->
// mesa_post_commercial_adjustment_v1) has been live since ledger 118, but the Mesa
// account reader never exposed WHICH order a comanda is (order_uid) nor its canonical
// obligation, so the frontend had no safe target. This slice makes the Mesa DAO select
// order_uid and read order_obligations, and projectSessionAccount derives an additive
// per-command `financial` shape:
//
//   commands[].orderUid                      -- the PERMANENT identity (never #NNN)
//   commands[].financial = {
//     orderUid,
//     originalObligation,   -- revision-1 gross, or the legacy basis if no revisions
//     currentObligation,    -- latest revision gross, or the legacy basis
//     commercialAdjustment, -- currentObligation - originalObligation  (<= 0)
//     obligationRevision,   -- latest revision number, or 0
//     adjustable            -- order-level hint (never session status)
//   }
//
// The legacy basis is the SAME one order_canonical_obligation_v1 uses: ordenes.totale,
// zeroed for a genuinely cancelled order. READ ONLY -- the reader never materialises a
// revision row.
//
// Run: node tests/mesaOrderObligationReader.test.js
// ===============================================================

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createMesaService, buildFloor, buildClosedAccount, projectSessionAccount,
} = require('../src/tables/mesaService');

const UID_A = 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa';
const UID_B = 'bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb';
const SESSION_ID = '11111111-2222-4333-8444-555555555555';
const TABLE_ID = '99999999-8888-4777-8666-555555555555';

const ctx = (o = {}) => ({
  actor: 'owner', role: 'owner', workspaceId: 'ws-1', sessionVersion: 1, sid: 'high-entropy-sid', ...o,
});

const openSession = (o = {}) => ({
  id: SESSION_ID, workspace_id: 'ws-1', table_id: TABLE_ID, service_session_id: 'svc-1',
  table_ref: 'Mesa 9', status: 'open', covers_total: 2, opened_at: '2026-08-27T18:00:00Z', ...o,
});
const closedSession = (o = {}) => openSession({
  status: 'closed', settled_at: '2026-08-27T20:00:00Z', closed_at: '2026-08-27T20:00:00Z',
  updated_by: 'owner', ...o,
});

const order = (o = {}) => ({
  id: '#001', order_uid: UID_A, table_session_id: SESSION_ID, table_command_number: 1,
  service_order_number: 1, estado: 'RETIRADO', items: [], hora: '19:10', nota: null,
  // language-guard: allow-legacy nota_cucina is the existing ordenes column name the DAO already selects and projectSessionAccount maps to kitchenNote, mirrored here in the fixture, not new vocabulary
  nota_cucina: null, totale: 30, ts: 1, ...o,
});
const obligation = (o = {}) => ({
  order_uid: UID_A, order_id: '#001', revision: 1, gross_amount: 30,
  source: 'order_create_v1', cause: null, created_at: '2026-08-27T19:10:00Z', ...o,
});

const fin = (account, orderId = '#001') => account.commands.find((c) => c.id === orderId).financial;

// ── A. legacy order, no obligation rows -> original 30 / current 30 / adj 0, uid exposed ──
test('A: legacy order with no order_obligations rows -> original 30, current 30, adjustment 0, stable orderUid', () => {
  const account = projectSessionAccount(openSession(), {
    orders: [order({ totale: 30 })],
    lines: [{ id: 'l1', table_session_id: SESSION_ID, order_id: '#001', net_amount: 30 }],
    transactions: [],
    obligations: [],
  });
  const f = fin(account);
  assert.equal(f.orderUid, UID_A);
  assert.equal(account.commands[0].orderUid, UID_A, 'orderUid mirrored at command level');
  assert.equal(f.originalObligation, 30);
  assert.equal(f.currentObligation, 30);
  assert.equal(f.commercialAdjustment, 0);
  assert.equal(f.obligationRevision, 0);
  assert.equal(f.adjustable, true);
});

// ── B. canonical: rev1 30, rev2 20 -> original 30 / current 20 / adjustment -10 ──
test('B: revisions rev1=30 rev2=20 -> original 30, current 20, adjustment -10, revision 2', () => {
  const account = projectSessionAccount(openSession(), {
    orders: [order({ totale: 30 })],
    lines: [{ id: 'l1', table_session_id: SESSION_ID, order_id: '#001', net_amount: 30 }],
    transactions: [],
    obligations: [
      obligation({ revision: 1, gross_amount: 30, source: 'order_create_v1' }),
      obligation({ revision: 2, gross_amount: 20, source: 'order_commercial_adjustment_v1', cause: 'manual' }),
    ],
  });
  const f = fin(account);
  assert.equal(f.originalObligation, 30);
  assert.equal(f.currentObligation, 20);
  assert.equal(f.commercialAdjustment, -10);
  assert.equal(f.obligationRevision, 2);
  assert.equal(f.adjustable, true, 'still 20 owed -> still adjustable');
});

// ── C. full adjustment 30 -> 0 ──
test('C: full adjustment 30 -> 0 -> current 0, adjustment -30, no longer adjustable', () => {
  const account = projectSessionAccount(openSession(), {
    orders: [order({ totale: 30 })],
    lines: [{ id: 'l1', table_session_id: SESSION_ID, order_id: '#001', net_amount: 30 }],
    transactions: [],
    obligations: [
      obligation({ revision: 1, gross_amount: 30 }),
      obligation({ revision: 2, gross_amount: 0, source: 'order_commercial_adjustment_v1', cause: 'manual' }),
    ],
  });
  const f = fin(account);
  assert.equal(f.originalObligation, 30);
  assert.equal(f.currentObligation, 0);
  assert.equal(f.commercialAdjustment, -30);
  assert.equal(f.obligationRevision, 2);
  assert.equal(f.adjustable, false, 'nothing left to reduce');
});

// ── D. open-table reader preserves the fields (buildFloor -> shared projection) ──
test('D: the OPEN floor reader exposes orderUid + financial through the shared projection', () => {
  const rows = {
    tables: [{ id: TABLE_ID, table_number: 9, display_name: 'Mesa 9', capacity: 4, active: true }],
    sessions: [openSession()],
    reservations: [],
    orders: [order({ totale: 30 })],
    lines: [{ id: 'l1', table_session_id: SESSION_ID, order_id: '#001', net_amount: 30 }],
    transactions: [],
    allocations: [],
    obligations: [obligation({ revision: 1, gross_amount: 30 }), obligation({ revision: 2, gross_amount: 25, source: 'order_commercial_adjustment_v1', cause: 'manual' })],
  };
  const table = buildFloor(rows)[0];
  assert.equal(table.status, 'open');
  const f = table.session.commands[0].financial;
  assert.equal(f.orderUid, UID_A);
  assert.equal(f.originalObligation, 30);
  assert.equal(f.currentObligation, 25);
  assert.equal(f.commercialAdjustment, -5);
  assert.equal(f.obligationRevision, 2);
  assert.equal(f.adjustable, true);
});

// ── E. closed-table reader preserves the fields, and reading never reopens ──
test('E: the CLOSED reader exposes the SAME financial shape, and a closed table is not adjustability-blocked here', async () => {
  const rows = {
    orders: [order({ totale: 30, estado: 'RETIRADO' })],
    lines: [{ id: 'l1', table_session_id: SESSION_ID, order_id: '#001', net_amount: 30 }],
    transactions: [{ id: 'p1', table_session_id: SESSION_ID, kind: 'payment', amount: 30, payment_method: 'efectivo' }],
    allocations: [{ payment_transaction_id: 'p1', table_order_line_id: 'l1', amount: 30 }],
    obligations: [obligation({ revision: 1, gross_amount: 30 })],
  };
  const service = createMesaService({
    dao: {
      getSessionWithCloseFields: async () => closedSession(),
      listSessionAccountRows: async () => rows,
      getTableById: async () => ({ id: TABLE_ID, table_number: 9, display_name: 'Mesa 9', capacity: 4 }),
    },
  });
  const res = await service.sessionAccount({ context: ctx(), tableSessionId: SESSION_ID });
  assert.equal(res.status, 'closed');
  const f = res.account.commands[0].financial;
  assert.equal(f.orderUid, UID_A);
  assert.equal(f.originalObligation, 30);
  assert.equal(f.currentObligation, 30);
  assert.equal(f.commercialAdjustment, 0);
  // adjustable is an ORDER-level hint -- the RPC (like Refund V1) accepts a closed
  // session and never reopens it, so the reader does not couple this to status.
  assert.equal(f.adjustable, true);
});

test('E2: open and closed projections agree field-for-field for the same rows (one shared path)', () => {
  const rows = {
    orders: [order({ totale: 42 })],
    lines: [{ id: 'l1', table_session_id: SESSION_ID, order_id: '#001', net_amount: 42 }],
    transactions: [],
    allocations: [],
    obligations: [obligation({ revision: 1, gross_amount: 42 })],
  };
  const asOpen = buildClosedAccount(openSession(), rows, null).account;
  const asClosed = buildClosedAccount(closedSession(), rows, null).account;
  assert.deepEqual(asOpen.commands[0].financial, asClosed.commands[0].financial);
});

// ── F. recycled display number -> the stable orderUid stays authoritative ──
test('F: two orders share the recycled display id #001 -> each keeps its OWN order_uid and obligation', () => {
  const rows = {
    orders: [
      order({ id: '#001', order_uid: UID_A, table_command_number: 1, totale: 30, ts: 1 }),
      order({ id: '#001', order_uid: UID_B, table_command_number: 2, totale: 50, ts: 2 }),
    ],
    lines: [
      { id: 'l1', table_session_id: SESSION_ID, order_id: '#001', net_amount: 30 },
    ],
    transactions: [],
    allocations: [],
    obligations: [
      obligation({ order_uid: UID_A, order_id: '#001', revision: 1, gross_amount: 30 }),
      obligation({ order_uid: UID_A, order_id: '#001', revision: 2, gross_amount: 12, source: 'order_commercial_adjustment_v1', cause: 'manual' }),
      obligation({ order_uid: UID_B, order_id: '#001', revision: 1, gross_amount: 50 }),
    ],
  };
  const account = buildClosedAccount(openSession(), rows, null).account;
  const a = account.commands.find((c) => c.orderUid === UID_A).financial;
  const b = account.commands.find((c) => c.orderUid === UID_B).financial;
  assert.equal(a.currentObligation, 12, 'UID_A got its own adjusted obligation');
  assert.equal(a.originalObligation, 30);
  assert.equal(a.obligationRevision, 2);
  assert.equal(b.currentObligation, 50, 'UID_B untouched, not cross-contaminated by the shared #001');
  assert.equal(b.originalObligation, 50);
  assert.equal(b.obligationRevision, 0 + 1);
});

test('F2: an order with NO order_uid (Class B) fails closed -> adjustable:false, orderUid:null', () => {
  const account = projectSessionAccount(openSession(), {
    orders: [order({ id: '#369', order_uid: null, totale: 20 })],
    lines: [{ id: 'l1', table_session_id: SESSION_ID, order_id: '#369', net_amount: 20 }],
    transactions: [],
    obligations: [],
  });
  const f = account.commands[0].financial;
  assert.equal(f.orderUid, null);
  assert.equal(account.commands[0].orderUid, null);
  assert.equal(f.adjustable, false, 'no stable identity -> never adjustable, never guessed');
  // the displayed numbers still reflect the legacy basis so the UI is not lying about totals
  assert.equal(f.currentObligation, 20);
  assert.equal(f.originalObligation, 20);
});

test('F3: a genuinely cancelled order -> obligation basis 0, not adjustable', () => {
  const account = projectSessionAccount(openSession(), {
    orders: [order({ estado: 'CANCELADO', totale: 30 })],
    lines: [],
    transactions: [],
    obligations: [],
  });
  const f = account.commands[0].financial;
  assert.equal(f.currentObligation, 0, 'mirrors order_canonical_obligation_v1 fallback: cancelled -> 0');
  assert.equal(f.originalObligation, 0);
  assert.equal(f.adjustable, false);
});

// ── G. every previous account field is unchanged / purely additive ──
test('G: financial + orderUid are purely additive -- all pre-existing command/account fields survive', () => {
  const base = {
    orders: [order({ totale: 30 })],
    lines: [{ id: 'l1', table_session_id: SESSION_ID, order_id: '#001', net_amount: 30 }],
    transactions: [{ id: 'p1', table_session_id: SESSION_ID, kind: 'payment', amount: 30, payment_method: 'bizum' }],
  };
  const before = projectSessionAccount(openSession(), base); // no `obligations` key at all -> defaults []
  const after = projectSessionAccount(openSession(), { ...base, obligations: [obligation()] });

  // account-level fields identical
  for (const k of ['total', 'paid', 'outstanding', 'overCollected', 'coversTotal', 'paymentTotals']) {
    assert.deepEqual(after[k], before[k], `account.${k} unchanged`);
  }
  // the pre-existing command fields identical
  const stripNew = (c) => { const { orderUid, financial, ...rest } = c; return rest; };
  assert.deepEqual(after.commands.map(stripNew), before.commands.map(stripNew));
  // ...and calling WITHOUT the obligations key still yields a well-formed financial block
  assert.equal(before.commands[0].financial.currentObligation, 30);
  assert.equal(before.commands[0].financial.adjustable, true);
});

// ── H. the refund payment history is untouched by the obligation projection ──
test('H: Refund V1 payment history (reversesTransactionId, order, amounts) is unchanged by this slice', () => {
  const account = projectSessionAccount(openSession(), {
    orders: [order({ totale: 30 })],
    lines: [{ id: 'l1', table_session_id: SESSION_ID, order_id: '#001', net_amount: 30 }],
    transactions: [
      { id: 'p1', table_session_id: SESSION_ID, kind: 'payment', mode: 'full', amount: 30, payment_method: 'tarjeta', by_actor: 'owner', created_at: 't1' },
      { id: 'r1', table_session_id: SESSION_ID, kind: 'refund', mode: 'refund', amount: 10, payment_method: 'tarjeta', by_actor: 'owner', created_at: 't2', reverses_transaction_id: 'p1' },
    ],
    obligations: [obligation({ revision: 1, gross_amount: 30 }), obligation({ revision: 2, gross_amount: 5, source: 'order_commercial_adjustment_v1', cause: 'manual' })],
  });
  assert.equal(account.payments.length, 2);
  assert.deepEqual(account.payments.map((p) => p.amount), [30, 10]);
  assert.equal(account.payments.find((p) => p.id === 'r1').reversesTransactionId, 'p1');
  assert.equal(account.payments.find((p) => p.id === 'p1').reversesTransactionId, null);
  // netCollected still money truth (30 - 10), unaffected by the obligation dropping to 5
  assert.equal(account.paid, 20);
  // and the obligation projection still reports the reduced obligation independently
  assert.equal(account.commands[0].financial.currentObligation, 5);
});

// ── the DAO issues the right reads (static) ─────────────────────────────
test('the Mesa DAO selects order_uid and reads order_obligations, on BOTH readers, GET-only', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'tables', 'mesaDao.js'), 'utf8');
  for (const fn of ['listFloorRows', 'listSessionAccountRows']) {
    const start = src.indexOf(`async function ${fn}`);
    const end = src.indexOf('\n}\n', start);
    const body = src.slice(start, end);
    assert.ok(/select=id,order_uid,/.test(body), `${fn} must select order_uid from ordenes`);
    assert.ok(body.includes('listObligationsForOrders(orders)'), `${fn} must read obligations`);
    assert.ok(body.includes('obligations }'), `${fn} must return obligations`);
    assert.ok(!body.includes("rpc('"), `${fn} stays GET-only`);
  }
  const helper = src.slice(src.indexOf('async function listObligationsForOrders'));
  assert.ok(/select\('order_obligations'/.test(helper), 'the shared helper reads order_obligations');
  assert.ok(/order_uid=\$\{uidFilter\}/.test(helper), 'scoped by order_uid IN (...), the globally-unique key');
  assert.ok(!helper.includes('service_session_id='), 'never scoped by service_session_id (would pull other tables)');
});
