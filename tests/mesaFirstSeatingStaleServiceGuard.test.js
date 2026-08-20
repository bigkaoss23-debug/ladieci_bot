'use strict';
// ===============================================================
// MESA FIRST-SEATING STALE SERVICE GUARD — behavioural + static tests.
//
// Covers the required matrix:
//   A  current-day walk-in            -> plain seat, zero recovery
//   A2 current-day reservation        -> plain seat, zero recovery
//   B  stale-day walk-in              -> recover once, retry once, land on B
//   C  stale-day reservation          -> same, optimistic version preserved
//   D  race loser (already recovered) -> converges, still lands on B
//   E  recovery/resolution failure    -> typed refusal, zero seat
//   F  same-day second service        -> never triggers forgotten-close
// plus the budget invariants (max 1 recovery, max 2 seat attempts) and the
// fail-closed parsing of partial contract matches.
// ===============================================================

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { createMesaService, MesaServiceError } = require('../src/tables/mesaService');

const STALE_ID = 'b6cd0470-218b-425d-a2d8-e80b7e24df52';
const SUCCESSOR_ID = '4f260f1e-8e1c-46f2-9db5-86f3446ff759';

const ctx = (overrides = {}) => ({
  actor: 'operator_primary', role: 'operator', workspaceId: 'ws-1',
  sessionVersion: 1, sid: 'high-entropy-session-id', ...overrides,
});

// The exact structured triple the DB raises, as PostgREST surfaces it.
function staleServiceError(staleId = STALE_ID) {
  const error = new Error('Mesa RPC failed');
  error.code = 'FORGOTTEN_CLOSE_REQUIRED';
  error.status = 400;
  error.pgError = { code: 'P0001', message: 'FORGOTTEN_CLOSE_REQUIRED', details: staleId };
  return error;
}

// Builds a service whose DB refuses the stale id exactly once, then accepts
// whatever id the retry pins itself to.
function staleThenHealthy({ recoveryResult = { success: true }, resolved, seatKey = 'openSession' } = {}) {
  const calls = { seats: [], recoveries: [], resolutions: [] };
  const seat = async (args) => {
    calls.seats.push(args);
    if (args.serviceSessionId === STALE_ID) throw staleServiceError();
    return { ok: true, sessionId: `table-session-${calls.seats.length}` };
  };
  const service = createMesaService({
    dao: { [seatKey]: seat },
    lifecycle: {
      currentCloseout: async () => ({ ok: true, session: { id: STALE_ID, status: 'open' } }),
      resolveOperationalContext: async (args) => {
        calls.resolutions.push(args);
        return resolved !== undefined
          ? resolved
          : { ok: true, code: 'RESOLVED', periodId: SUCCESSOR_ID, businessDayId: 'bd-today' };
      },
    },
    forgottenCloseRecovery: {
      parseForgottenCloseRequired: require('../src/serviceSessions/forgottenCloseRecovery').parseForgottenCloseRequired,
      recoverForgottenService: async (args) => { calls.recoveries.push(args); return recoveryResult; },
    },
  });
  return { service, calls };
}

// ── CASE A — current-day walk-in: nothing changes ─────────────────────────
test('CASE A: a current-day walk-in seats directly, with zero recovery and zero resolver call', async () => {
  const calls = { seats: [], recoveries: [], resolutions: [] };
  const service = createMesaService({
    dao: { openSession: async (args) => { calls.seats.push(args); return { ok: true, sessionId: 's1' }; } },
    lifecycle: {
      currentCloseout: async () => ({ ok: true, session: { id: SUCCESSOR_ID, status: 'open' } }),
      resolveOperationalContext: async () => { calls.resolutions.push(1); return { ok: true, periodId: 'never' }; },
    },
    forgottenCloseRecovery: {
      parseForgottenCloseRequired: () => null,
      recoverForgottenService: async () => { calls.recoveries.push(1); return { success: true }; },
    },
  });

  const result = await service.open({ context: ctx(), tableId: 'table-1' });

  assert.equal(result.sessionId, 's1');
  assert.equal(calls.seats.length, 1, 'exactly one seat attempt');
  assert.equal(calls.seats[0].serviceSessionId, SUCCESSOR_ID);
  assert.equal(calls.recoveries.length, 0, 'no forgotten-close recovery on the happy path');
  assert.equal(calls.resolutions.length, 0, 'no Business Day advance on the happy path');
});

test('CASE A2: a current-day reservation seats directly, with zero recovery', async () => {
  const calls = { seats: [], recoveries: [] };
  const service = createMesaService({
    dao: { openReservation: async (args) => { calls.seats.push(args); return { ok: true, sessionId: 's2' }; } },
    lifecycle: {
      currentCloseout: async () => ({ ok: true, session: { id: SUCCESSOR_ID, status: 'open' } }),
      resolveOperationalContext: async () => { throw new Error('must not resolve'); },
    },
    forgottenCloseRecovery: {
      parseForgottenCloseRequired: () => null,
      recoverForgottenService: async () => { calls.recoveries.push(1); return { success: true }; },
    },
  });

  const result = await service.openReservation({ context: ctx(), reservationId: 'r1', expectedVersion: 5 });

  assert.equal(result.sessionId, 's2');
  assert.equal(calls.seats.length, 1);
  assert.equal(calls.seats[0].serviceSessionId, SUCCESSOR_ID);
  assert.equal(calls.seats[0].expectedVersion, 5);
  assert.equal(calls.recoveries.length, 0);
});

// ── CASE B — stale previous-day walk-in ───────────────────────────────────
test('CASE B: a stale previous-day walk-in recovers once and lands the table on the successor', async () => {
  const { service, calls } = staleThenHealthy();

  const result = await service.open({ context: ctx(), tableId: 'table-1' });

  assert.equal(result.sessionId, 'table-session-2');
  assert.equal(calls.seats.length, 2, 'exactly two seat attempts: original + one retry');
  assert.equal(calls.seats[0].serviceSessionId, STALE_ID, 'first attempt used the stale pointer');
  assert.equal(calls.seats[1].serviceSessionId, SUCCESSOR_ID, 'retry pinned to the resolver-confirmed successor');
  assert.equal(calls.recoveries.length, 1, 'exactly one recovery');
  assert.deepEqual(calls.recoveries[0], { staleServiceSessionId: STALE_ID },
    'stale identity taken from the DB DETAIL field, never from the caller');
  assert.equal(calls.resolutions.length, 1, 'exactly one Business Day advance');
  assert.equal(calls.resolutions[0].actor, 'operator_primary');
  // Zero table sessions were created against the stale service: the only
  // attempt against it threw before any row existed.
  assert.equal(calls.seats.filter((s) => s.serviceSessionId === STALE_ID).length, 1);
});

// ── CASE C — stale previous-day reservation ───────────────────────────────
test('CASE C: a stale previous-day reservation recovers and re-seats with the SAME expected version', async () => {
  const { service, calls } = staleThenHealthy({ seatKey: 'openReservation' });

  const result = await service.openReservation({
    context: ctx({ actor: 'waiter-1', role: 'waiter' }), reservationId: 'r1', expectedVersion: 5,
  });

  assert.equal(result.sessionId, 'table-session-2');
  assert.equal(calls.seats.length, 2);
  assert.equal(calls.seats[1].serviceSessionId, SUCCESSOR_ID);
  // The refused attempt rolled back whole, so the optimistic-lock version is
  // untouched and the retry must present the caller's original value.
  assert.equal(calls.seats[0].expectedVersion, 5);
  assert.equal(calls.seats[1].expectedVersion, 5);
  assert.equal(calls.seats[1].reservationId, 'r1');
  assert.equal(calls.recoveries.length, 1);
});

// ── CASE D — convergence: the loser of a race the winner already fixed ────
test('CASE D: a race loser whose recovery reports failure still converges onto the successor', async () => {
  const { service, calls } = staleThenHealthy({
    recoveryResult: { success: false, code: 'V3_CLOSE_SESSION_ALREADY_CLOSED_NOT_RECOVERABLE' },
  });

  const result = await service.open({ context: ctx(), tableId: 'table-1' });

  assert.equal(result.sessionId, 'table-session-2', 'a non-fresh recovery outcome is not a failure');
  assert.equal(calls.recoveries.length, 1, 'still exactly one recovery attempt');
  assert.equal(calls.seats.length, 2, 'still exactly one retry');
  assert.equal(calls.seats[1].serviceSessionId, SUCCESSOR_ID);
});

// ── CASE E — genuine failure: no partial Mesa mutation, no loop ───────────
test('CASE E: an unresolvable successor refuses the seat with a typed error and never retries blindly', async () => {
  const { service, calls } = staleThenHealthy({ resolved: { ok: false, code: 'ORDER_INTAKE_CLOSED' } });

  await assert.rejects(
    () => service.open({ context: ctx(), tableId: 'table-1' }),
    (error) => error instanceof MesaServiceError && error.code === 'MESA_SERVICE_NOT_OPEN' && error.status === 409,
  );
  assert.equal(calls.seats.length, 1, 'no seat attempted against an unresolved service');
  assert.equal(calls.recoveries.length, 1);
});

test('CASE E: a service still stale after recovery + retry fails typed, never a third attempt', async () => {
  const calls = { seats: [], recoveries: [] };
  const service = createMesaService({
    dao: { openSession: async (args) => { calls.seats.push(args); throw staleServiceError(); } },
    lifecycle: {
      currentCloseout: async () => ({ ok: true, session: { id: STALE_ID, status: 'open' } }),
      resolveOperationalContext: async () => ({ ok: true, periodId: SUCCESSOR_ID }),
    },
    forgottenCloseRecovery: {
      parseForgottenCloseRequired: require('../src/serviceSessions/forgottenCloseRecovery').parseForgottenCloseRequired,
      recoverForgottenService: async (args) => { calls.recoveries.push(args); return { success: true }; },
    },
  });

  await assert.rejects(
    () => service.open({ context: ctx(), tableId: 'table-1' }),
    (error) => error instanceof MesaServiceError && error.code === 'MESA_SERVICE_STALE_UNRESOLVED' && error.status === 409,
  );
  assert.equal(calls.seats.length, 2, 'budget held: never a third seat attempt');
  assert.equal(calls.recoveries.length, 1, 'budget held: never a second recovery');
});

test('CASE E: a no-open-service pointer refuses before any seat is attempted', async () => {
  const calls = { seats: [] };
  const service = createMesaService({
    dao: { openSession: async (args) => { calls.seats.push(args); return { ok: true }; } },
    lifecycle: { currentCloseout: async () => ({ ok: true, session: null }) },
  });
  await assert.rejects(
    () => service.open({ context: ctx(), tableId: 'table-1' }),
    (error) => error instanceof MesaServiceError && error.code === 'MESA_SERVICE_NOT_OPEN',
  );
  assert.equal(calls.seats.length, 0);
});

// ── CASE F — Business Day 1:N is preserved ────────────────────────────────
test('CASE F: a second service on the SAME Business Day never triggers forgotten-close', async () => {
  // The DB only raises when the service belongs to a different Business Date;
  // a same-day successor is simply accepted, so the JS path is a plain seat.
  const calls = { seats: [], recoveries: [] };
  const service = createMesaService({
    dao: { openSession: async (args) => { calls.seats.push(args); return { ok: true, sessionId: 's-second' }; } },
    lifecycle: {
      currentCloseout: async () => ({ ok: true, session: { id: 'second-service-same-day', status: 'open' } }),
      resolveOperationalContext: async () => { throw new Error('must not advance the Business Day'); },
    },
    forgottenCloseRecovery: {
      parseForgottenCloseRequired: require('../src/serviceSessions/forgottenCloseRecovery').parseForgottenCloseRequired,
      recoverForgottenService: async () => { calls.recoveries.push(1); return { success: true }; },
    },
  });

  const result = await service.open({ context: ctx(), tableId: 'table-9' });

  assert.equal(result.sessionId, 's-second');
  assert.equal(calls.seats.length, 1);
  assert.equal(calls.recoveries.length, 0);
});

// ── Fail-closed parsing: a look-alike error is NOT a recovery request ─────
test('a partial contract match is rethrown untouched and never triggers recovery', async () => {
  for (const pgError of [
    { code: 'P0001', message: 'FORGOTTEN_CLOSE_REQUIRED', details: null },       // no DETAIL
    { code: 'P0001', message: 'FORGOTTEN_CLOSE_REQUIRED', details: 'not-a-uuid' },
    { code: '55000', message: 'FORGOTTEN_CLOSE_REQUIRED', details: STALE_ID },   // wrong SQLSTATE
    { code: 'P0001', message: 'MESA_SERVICE_NOT_OPEN', details: STALE_ID },      // wrong message
    null,                                                                         // no body at all
  ]) {
    const calls = { recoveries: [] };
    const service = createMesaService({
      dao: {
        openSession: async () => {
          const error = new Error('Mesa RPC failed');
          error.code = 'MESA_SERVICE_NOT_OPEN';
          error.pgError = pgError;
          throw error;
        },
      },
      lifecycle: { currentCloseout: async () => ({ ok: true, session: { id: STALE_ID, status: 'open' } }) },
      forgottenCloseRecovery: {
        parseForgottenCloseRequired: require('../src/serviceSessions/forgottenCloseRecovery').parseForgottenCloseRequired,
        recoverForgottenService: async () => { calls.recoveries.push(1); return { success: true }; },
      },
    });
    await assert.rejects(() => service.open({ context: ctx(), tableId: 't' }),
      (error) => error.code === 'MESA_SERVICE_NOT_OPEN' && !(error instanceof MesaServiceError));
    assert.equal(calls.recoveries.length, 0, `no recovery for ${JSON.stringify(pgError)}`);
  }
});

// ── Static: the DB really carries the invariant ───────────────────────────
const MIGRATION = path.join(__dirname, '..', 'migrations', '2026-08-20_mesa_first_seating_stale_service_guard.sql');

// Executable SQL only. The header comments legitimately NAME the things the
// guard must not do ("no CURRENT_DATE", "no second calendar"), so scanning raw
// text would flag the very documentation that promises the invariant.
const sqlCode = (file) => fs.readFileSync(file, 'utf8')
  .split(/\r?\n/)
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n');

test('the migration installs the guard in BOTH seating primitives', () => {
  const sql = sqlCode(MIGRATION);
  for (const fn of ['mesa_open_session_v1', 'mesa_open_reservation_v1']) {
    assert.ok(sql.includes(`CREATE OR REPLACE FUNCTION public.${fn}`), `${fn} redefined`);
  }
  // Exactly two raises of the typed contract — one per primitive.
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

test('the migration ships a paired rollback that removes the guard and is PONR-guarded', () => {
  const rollback = MIGRATION.replace(/\.sql$/, '.ROLLBACK.sql');
  const sql = sqlCode(rollback);
  assert.ok(!sql.includes('FORGOTTEN_CLOSE_REQUIRED'), 'rollback removes the seating contract');
  assert.ok(sql.includes('PONR:'), 'rollback refuses while tables are open');
  for (const fn of ['mesa_open_session_v1', 'mesa_open_reservation_v1']) {
    assert.ok(sql.includes(`CREATE OR REPLACE FUNCTION public.${fn}`), `${fn} restored`);
  }
});

test('neither F-10 nor F-11 is redefined by this migration', () => {
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

test('the seating path reuses the ONE recovery executor and never imports the V3 engine', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'tables', 'mesaService.js'), 'utf8');
  assert.ok(source.includes("require('../serviceSessions/forgottenCloseRecovery')"));
  assert.ok(!source.includes('serviceCloseAuthority'), 'Mesa must not reach past the shared executor');
  assert.ok(!source.includes('serviceLifecycleEngine'), 'Mesa must never import the V3 engine directly');
  // No clock or date arithmetic was added to the seating decision.
  assert.ok(!/businessDate/.test(source), 'Mesa must not compute or compare a business date in JS');
});
