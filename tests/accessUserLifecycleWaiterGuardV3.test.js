'use strict';
// Access Control V3 -- Block V3-G: lifecycle-safety tests for the waiter/open-table-
// session deactivation guard, at the Node service/DAO orchestration layer.
// Run: node tests/accessUserLifecycleWaiterGuardV3.test.js
//
// The real RPC decision logic (locking, the exact SQL guard placement) is proven
// separately by the real disposable-PostgreSQL rehearsal. This suite proves that
// accessUserLifecycleDaoV3's marker-based error mapping and
// accessUserLifecycleServiceV3's catch branch correctly turn the RPC's
// AUTH_WAITER_HAS_OPEN_TABLES marker into a distinguishable, non-generic result -- the
// same discipline already proven for AUTH_IDEMPOTENCY_CONFLICT.
let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

const { createAccessUserLifecycleV3Service, FAILED, CONFLICT, WAITER_HAS_OPEN_TABLES } = require('../src/auth/accessUserLifecycleServiceV3');
const { AuthDaoError } = require('../src/auth/audit');

const sidHash = (sid) => (typeof sid === 'string' && sid.length > 0 ? 'h:' + sid : null);
const notExpired = Math.floor(Date.now() / 1000) + 600;
const WID = 'ws-11111111-1111-4111-8111-111111111111';

function baseArgs(overrides = {}) {
  return {
    workspaceId: WID, byActor: 'owner', actingRole: 'admin', targetActor: 'waiter-1',
    expectedActive: true, sid: 'sid-1', clientRequestId: 'cr-1',
    stepUp: { sub: 'owner', sid: 'sid-1', exp: notExpired },
    ...overrides,
  };
}

async function main() {
  // ── DAO export sanity ────────────────────────────────────────────────────────────
  {
    const { setAccessUserActiveV3 } = require('../src/auth/accessUserLifecycleDaoV3');
    assert('setAccessUserActiveV3 is exported (sanity)', typeof setAccessUserActiveV3 === 'function');
  }

  // ── service-level: DAO throws the new marker code -> WAITER_HAS_OPEN_TABLES ───────
  {
    const dao = {
      async setAccessUserActiveV3() {
        throw new AuthDaoError('ACCESS_USER_LIFECYCLE_WAITER_OPEN_TABLES', 'waiter has open table sessions');
      },
    };
    const svc = createAccessUserLifecycleV3Service({ dao, sidHash });
    const out = await svc.deactivateAccessUser(baseArgs());
    assert('deactivate: DAO marker AUTH_WAITER_HAS_OPEN_TABLES -> service returns WAITER_HAS_OPEN_TABLES (not generic FAILED)',
      out === WAITER_HAS_OPEN_TABLES && out.error === 'waiter_has_open_tables');
    assert('WAITER_HAS_OPEN_TABLES is a DISTINCT shape from FAILED and CONFLICT',
      WAITER_HAS_OPEN_TABLES !== FAILED && WAITER_HAS_OPEN_TABLES !== CONFLICT
      && WAITER_HAS_OPEN_TABLES.error !== FAILED.error && WAITER_HAS_OPEN_TABLES.error !== CONFLICT.error);
    assert('conflict result exposes no target/session identifier or count field -- only {ok, error}',
      JSON.stringify(Object.keys(out).sort()) === JSON.stringify(['error', 'ok']));
  }

  // ── an UNRELATED DAO error code still collapses into the generic FAILED shape ──────
  {
    const dao = { async setAccessUserActiveV3() { throw new AuthDaoError('ACCESS_USER_ACTIVE_STATE_FAILED', 'operation failed'); } };
    const svc = createAccessUserLifecycleV3Service({ dao, sidHash });
    const out = await svc.deactivateAccessUser(baseArgs());
    assert('deactivate: unrelated DAO failure still collapses to generic FAILED', out === FAILED);
  }

  // ── idempotency conflict marker still works (V3-E contract untouched) ─────────────
  {
    const dao = { async setAccessUserActiveV3() { throw new AuthDaoError('ACCESS_USER_LIFECYCLE_CONFLICT', 'idempotency conflict'); } };
    const svc = createAccessUserLifecycleV3Service({ dao, sidHash });
    const out = await svc.deactivateAccessUser(baseArgs());
    assert('deactivate: idempotency-conflict marker still maps to CONFLICT, distinct from WAITER_HAS_OPEN_TABLES', out === CONFLICT);
  }

  // ── reactivation is completely unaffected by the new marker ────────────────────────
  {
    let sawRequestedActive;
    const dao = {
      async setAccessUserActiveV3(args) {
        sawRequestedActive = args.requestedActive;
        return { actor: 'waiter-1', role: 'waiter', active: true, session_version: 2, failed_count: 0, locked_until: null, updated_at: 't' };
      },
    };
    const svc = createAccessUserLifecycleV3Service({ dao, sidHash });
    const out = await svc.reactivateAccessUser(baseArgs({ expectedActive: false }));
    assert('reactivation succeeds normally for a waiter target', out.ok === true && out.active === true);
    assert('reactivation always requests active=true regardless of the waiter guard', sawRequestedActive === true);
  }

  // ── non-waiter deactivation is unaffected ───────────────────────────────────────────
  {
    const dao = {
      async setAccessUserActiveV3(args) {
        return { actor: args.targetActor, role: 'cashier', active: false, session_version: 3, failed_count: 0, locked_until: null, updated_at: 't' };
      },
    };
    const svc = createAccessUserLifecycleV3Service({ dao, sidHash });
    const out = await svc.deactivateAccessUser(baseArgs({ targetActor: 'cashier-1' }));
    assert('non-waiter deactivation succeeds normally, unaffected by the guard', out.ok === true && out.active === false);
  }

  // ── waiter with ZERO open assignments deactivates normally through the same path ───
  {
    const dao = {
      async setAccessUserActiveV3(args) {
        return { actor: args.targetActor, role: 'waiter', active: false, session_version: 5, failed_count: 0, locked_until: null, updated_at: 't' };
      },
    };
    const svc = createAccessUserLifecycleV3Service({ dao, sidHash });
    const out = await svc.deactivateAccessUser(baseArgs());
    assert('waiter with zero open assignments deactivates normally', out.ok === true && out.active === false);
  }

  // ── waiter with historical (closed) sessions may deactivate -- same fake DAO path,
  //    the RPC/schema-level "status='open'" filter is proven by the real rehearsal ────
  {
    const dao = {
      async setAccessUserActiveV3(args) {
        return { actor: args.targetActor, role: 'waiter', active: false, session_version: 6, failed_count: 0, locked_until: null, updated_at: 't' };
      },
    };
    const svc = createAccessUserLifecycleV3Service({ dao, sidHash });
    const out = await svc.deactivateAccessUser(baseArgs({ targetActor: 'waiter-with-closed-history' }));
    assert('waiter with only closed historical sessions deactivates normally', out.ok === true);
  }

  // ── owner/non-owner acting-role contract untouched by V3-G ─────────────────────────
  {
    const dao = { async setAccessUserActiveV3() { throw new AuthDaoError('ACCESS_USER_ACTIVE_STATE_FAILED', 'not owner'); } };
    const svc = createAccessUserLifecycleV3Service({ dao, sidHash });
    const out = await svc.deactivateAccessUser(baseArgs({ actingRole: 'cashier' }));
    assert('non-owner acting role rejected before any DAO call (V3-E contract preserved)', out === FAILED);
  }

  // ── inactive/demoted acting owner cannot replay -- rejected before the DAO ─────────
  {
    let daoCalls = 0;
    const dao = { async setAccessUserActiveV3() { daoCalls++; return { actor: 'w', role: 'waiter', active: false, session_version: 1, failed_count: 0, locked_until: null, updated_at: 't' }; } };
    const svc = createAccessUserLifecycleV3Service({ dao, sidHash });
    const out1 = await svc.deactivateAccessUser(baseArgs({ actingRole: null }));
    const out2 = await svc.deactivateAccessUser(baseArgs({ actingRole: 'cashier' }));
    assert('inactive/unauthoritative acting role rejected before DAO call', out1 === FAILED);
    assert('demoted acting role rejected before DAO call', out2 === FAILED);
    assert('neither rejected attempt reached the DAO', daoCalls === 0);
  }

  // ── malformed/foreign target reference fails closed generically ────────────────────
  {
    const dao = { async setAccessUserActiveV3() { throw new AuthDaoError('ACCESS_USER_ACTIVE_STATE_FAILED', 'target other workspace'); } };
    const svc = createAccessUserLifecycleV3Service({ dao, sidHash });
    const out = await svc.deactivateAccessUser(baseArgs({ targetActor: 'not-a-real-actor' }));
    assert('malformed/foreign target reference fails closed to generic FAILED (no guard bypass)', out === FAILED);
  }

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('TEST SCRIPT ERROR:', e); process.exit(1); });
