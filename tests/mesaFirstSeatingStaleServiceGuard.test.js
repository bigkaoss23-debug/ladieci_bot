'use strict';
// ===============================================================
// MESA FIRST-SEATING STALE SERVICE GUARD — behavioural + static tests.
//
// O-4 (ledger 108) — the stale-service recovery cases this file used to cover
// (B/C/D/E: seat -> DB raises FORGOTTEN_CLOSE_REQUIRED -> one recovery -> one
// pinned retry, plus the fail-closed partial-match parsing) are DELETED, not
// updated: O-3 (ledger 107) made an open operational_service_v1 unconditional
// continuity regardless of Business Day, so mesa_open_session_v1 /
// mesa_open_reservation_v1 can no longer raise that condition for any
// session the canonical resolver hands back, and O-4 removed the raise
// itself from resolve_order_intake_context_v1, plus the recovery module
// (forgottenCloseRecovery.js) and both its callers, as dead code. What
// remains here is the still-live matrix:
//   A  current-day walk-in            -> plain seat, zero resolver call
//   A2 current-day reservation        -> plain seat, zero resolver call
//   F  same-day second service        -> plain seat, resolver never called
// plus G-1's "seating is legitimate first activity" cases (the canonical
// resolver opens/converges on the current service when nothing is open), and
// the static checks against the HISTORICAL migration file
// 2026-08-20_mesa_first_seating_stale_service_guard.sql, which this session
// does not touch (migration history is immutable) — those checks verify that
// frozen file's own text, not live runtime behaviour.
// ===============================================================

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { createMesaService, MesaServiceError } = require('../src/tables/mesaService');

const SUCCESSOR_ID = '4f260f1e-8e1c-46f2-9db5-86f3446ff759';

const ctx = (overrides = {}) => ({
  actor: 'operator_primary', role: 'operator', workspaceId: 'ws-1',
  sessionVersion: 1, sid: 'high-entropy-session-id', ...overrides,
});

// ── CASE A — current-day walk-in: nothing changes ─────────────────────────
test('CASE A: a current-day walk-in seats directly, with zero resolver call', async () => {
  const calls = { seats: [], resolutions: [] };
  const service = createMesaService({
    dao: { openSession: async (args) => { calls.seats.push(args); return { ok: true, sessionId: 's1' }; } },
    lifecycle: {
      currentCloseout: async () => ({ ok: true, session: { id: SUCCESSOR_ID, status: 'open' } }),
      resolveOperationalContext: async () => { calls.resolutions.push(1); return { ok: true, periodId: 'never' }; },
    },
  });

  const result = await service.open({ context: ctx(), tableId: 'table-1' });

  assert.equal(result.sessionId, 's1');
  assert.equal(calls.seats.length, 1, 'exactly one seat attempt');
  assert.equal(calls.seats[0].serviceSessionId, SUCCESSOR_ID);
  assert.equal(calls.resolutions.length, 0, 'no Business Day advance on the happy path');
});

test('CASE A2: a current-day reservation seats directly, with zero resolver call', async () => {
  const calls = { seats: [] };
  const service = createMesaService({
    dao: { openReservation: async (args) => { calls.seats.push(args); return { ok: true, sessionId: 's2' }; } },
    lifecycle: {
      currentCloseout: async () => ({ ok: true, session: { id: SUCCESSOR_ID, status: 'open' } }),
      resolveOperationalContext: async () => { throw new Error('must not resolve'); },
    },
  });

  const result = await service.openReservation({ context: ctx(), reservationId: 'r1', expectedVersion: 5 });

  assert.equal(result.sessionId, 's2');
  assert.equal(calls.seats.length, 1);
  assert.equal(calls.seats[0].serviceSessionId, SUCCESSOR_ID);
  assert.equal(calls.seats[0].expectedVersion, 5);
});

// ── G-1 — SEATING IS LEGITIMATE FIRST ACTIVITY ────────────────────────────
// Before G-1 every one of these states dead-ended the waiter with
// MESA_SERVICE_NOT_OPEN and required a human to press "Abrir nuevo servicio".
// Now the canonical resolver opens (or converges on) the current Operational
// Service and the seat lands on it.
const RESUMED_ID = 'a1b2c3d4-0000-4000-8000-00000000beef';
const STALE_ID = 'b6cd0470-218b-425d-a2d8-e80b7e24df52';

// Every shape of "nothing is currently open" the lifecycle read can return.
const NO_OPEN_SERVICE_READS = {
  'a freshly finalized service (recent_closed_session_id)':
    { ok: true, code: 'OK', session: { id: STALE_ID, status: 'closed' } },
  'no service session at all (virgin Business Day)':
    { ok: true, code: 'NO_SERVICE_SESSION' },
  'a null session':
    { ok: true, session: null },
  'an unreadable lifecycle state':
    { ok: false, code: 'SERVICE_SESSION_STATE_CORRUPT' },
};

function resumeService({ seatKey = 'openSession', resolved } = {}) {
  const calls = { seats: [], resolutions: [] };
  const service = createMesaService({
    dao: {
      [seatKey]: async (args) => { calls.seats.push(args); return { ok: true, sessionId: 'ts-resumed' }; },
    },
    lifecycle: {
      currentCloseout: async () => calls.read,
      resolveOperationalContext: async (args) => {
        calls.resolutions.push(args);
        return resolved !== undefined
          ? resolved
          : { ok: true, code: 'RESOLVED', periodId: RESUMED_ID, businessDayId: 'bd-today' };
      },
    },
  });
  return { service, calls };
}

for (const [label, read] of Object.entries(NO_OPEN_SERVICE_READS)) {
  test(`G-1: a walk-in seats after ${label} — the resolver opens the service, no manual step`, async () => {
    const { service, calls } = resumeService();
    calls.read = read;

    const result = await service.open({ context: ctx(), tableId: 'table-1' });

    assert.equal(result.sessionId, 'ts-resumed');
    assert.equal(calls.resolutions.length, 1, 'the canonical resolver is consulted exactly once');
    assert.deepEqual(calls.resolutions[0], { actor: 'operator_primary', source: 'mesa_first_seating' },
      'server-verified actor and the seating source, never a client-supplied identity');
    assert.equal(calls.seats.length, 1, 'exactly one seat attempt');
    assert.equal(calls.seats[0].serviceSessionId, RESUMED_ID, 'pinned to the resolver verdict, never a re-read pointer');
  });
}

test('G-1: a reservation seats after a finalized service through the same one path', async () => {
  const { service, calls } = resumeService({ seatKey: 'openReservation' });
  calls.read = NO_OPEN_SERVICE_READS['a freshly finalized service (recent_closed_session_id)'];

  const result = await service.openReservation({ context: ctx(), reservationId: 'r-9', expectedVersion: 3 });

  assert.equal(result.sessionId, 'ts-resumed');
  assert.equal(calls.resolutions.length, 1);
  assert.equal(calls.seats.length, 1);
  assert.equal(calls.seats[0].serviceSessionId, RESUMED_ID);
  assert.equal(calls.seats[0].expectedVersion, 3, 'the optimistic version is carried through untouched');
});

test('G-1: an honest resolver refusal is surfaced, never overridden — no service is forced open', async () => {
  for (const refusal of [
    { ok: false, code: 'ORDER_INTAKE_CLOSED' },
    { ok: false, code: 'BUSINESS_DAY_UNRESOLVED' },
    { ok: false, code: 'OPEN_OPERATIONAL_SERVICE_FAILED', reason: 'NO_CURRENT_BUSINESS_DAY' },
    { ok: true, code: 'RESOLVED' },            // ok but no periodId — never trusted
    null,
  ]) {
    const { service, calls } = resumeService({ resolved: refusal });
    calls.read = NO_OPEN_SERVICE_READS['a null session'];

    await assert.rejects(
      () => service.open({ context: ctx(), tableId: 'table-1' }),
      (error) => error instanceof MesaServiceError && error.code === 'MESA_SERVICE_NOT_OPEN' && error.status === 409,
      `refusal ${JSON.stringify(refusal)}`,
    );
    assert.equal(calls.seats.length, 0, 'zero seat attempts against an unresolved service');
  }
});

// ── CASE F — Business Day 1:N is preserved ────────────────────────────────
test('CASE F: a second service on the SAME Business Day is a plain seat, resolver never called', async () => {
  const calls = { seats: [] };
  const service = createMesaService({
    dao: { openSession: async (args) => { calls.seats.push(args); return { ok: true, sessionId: 's-second' }; } },
    lifecycle: {
      currentCloseout: async () => ({ ok: true, session: { id: 'second-service-same-day', status: 'open' } }),
      resolveOperationalContext: async () => { throw new Error('must not advance the Business Day'); },
    },
  });

  const result = await service.open({ context: ctx(), tableId: 'table-9' });

  assert.equal(result.sessionId, 's-second');
  assert.equal(calls.seats.length, 1);
});

// ── Static: the DB really carried the invariant (HISTORICAL migration) ────
const MIGRATION = path.join(__dirname, '..', 'migrations', '2026-08-20_mesa_first_seating_stale_service_guard.sql');

// Executable SQL only. The header comments legitimately NAME the things the
// guard must not do ("no CURRENT_DATE", "no second calendar"), so scanning raw
// text would flag the very documentation that promises the invariant.
const sqlCode = (file) => fs.readFileSync(file, 'utf8')
  .split(/\r?\n/)
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n');

test('the HISTORICAL migration installed the guard in BOTH seating primitives (frozen file, not live behaviour)', () => {
  const sql = sqlCode(MIGRATION);
  for (const fn of ['mesa_open_session_v1', 'mesa_open_reservation_v1']) {
    assert.ok(sql.includes(`CREATE OR REPLACE FUNCTION public.${fn}`), `${fn} redefined`);
  }
  // Exactly two raises of the typed contract — one per primitive. O-3 later
  // removed this raise from the LIVE bodies of both functions; this migration
  // file itself is historical and unchanged.
  assert.equal((sql.match(/RAISE EXCEPTION 'FORGOTTEN_CLOSE_REQUIRED'/g) || []).length, 2);
  assert.equal((sql.match(/DETAIL = v_service\.id::text/g) || []).length, 2);
  // Canonical authority reused, never re-derived.
  assert.equal((sql.match(/get_order_intake_context_v1\(\)->>'businessDate'/g) || []).length, 2);
  assert.ok(!/Europe\/Madrid/.test(sql), 'the guard must not carry its own clock rule');
  assert.ok(!/CURRENT_DATE/.test(sql), 'the guard must not invent a second calendar');
  // Legacy-era services must NOT be handed the forgotten-close contract.
  assert.equal((sql.match(/MESA_SERVICE_NOT_CURRENT/g) || []).length, 2);
  assert.ok(sql.includes("v_service.lifecycle_semantics = 'operational_service_v1'"));
});

test('the HISTORICAL migration ships a paired rollback that removes the guard and is PONR-guarded', () => {
  const rollback = MIGRATION.replace(/\.sql$/, '.ROLLBACK.sql');
  const sql = sqlCode(rollback);
  assert.ok(!sql.includes('FORGOTTEN_CLOSE_REQUIRED'), 'rollback removes the seating contract');
  assert.ok(sql.includes('PONR:'), 'rollback refuses while tables are open');
  for (const fn of ['mesa_open_session_v1', 'mesa_open_reservation_v1']) {
    assert.ok(sql.includes(`CREATE OR REPLACE FUNCTION public.${fn}`), `${fn} restored`);
  }
});

test('neither F-10 nor F-11 was redefined by this HISTORICAL migration', () => {
  const sql = sqlCode(MIGRATION);
  for (const frozen of [
    'CREATE OR REPLACE FUNCTION public.resolve_order_intake_context_v1',
    'CREATE OR REPLACE FUNCTION public.ensure_service_session',
    'CREATE OR REPLACE FUNCTION public.get_order_intake_context_v1',
    'CREATE OR REPLACE FUNCTION public.open_operational_service_v1',
  ]) {
    assert.ok(!sql.includes(frozen), `${frozen} must stay frozen`);
  }
});

test('O-4: the seating path no longer imports the retired recovery executor, and still never reaches the V3 engine or computes a business date', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'tables', 'mesaService.js'), 'utf8');
  assert.ok(!source.includes("require('../serviceSessions/forgottenCloseRecovery')"),
    'forgottenCloseRecovery.js is deleted — mesaService.js must not require it any more');
  assert.ok(!source.includes('serviceCloseAuthority'), 'Mesa must not reach past the shared executor');
  assert.ok(!source.includes('serviceLifecycleEngine'), 'Mesa must never import the V3 engine directly');
  // No clock or date arithmetic was added to the seating decision.
  assert.ok(!/businessDate/.test(source), 'Mesa must not compute or compare a business date in JS');
});
