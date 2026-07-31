'use strict';
// Access Control V3 -- Block V3-G.1: role-change-safety tests for the waiter/open-
// table-session role-change guard, at the Node service/DAO orchestration layer.
// Run: node tests/roleChangeWaiterGuardV3.test.js
//
// The real RPC decision logic (locking, exact SQL guard placement, replay correctness)
// is proven separately by the real disposable-PostgreSQL rehearsal. This suite proves
// that roleChangeDaoV3's marker-based error mapping and roleChangeServiceV3's catch
// branch correctly turn the RPC's AUTH_WAITER_HAS_OPEN_TABLES marker into a
// distinguishable, non-generic result -- the same discipline already proven for
// AUTH_IDEMPOTENCY_CONFLICT and for the active-state lifecycle guard.
let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

const { createRoleChangeV3, FAILED, CONFLICT, WAITER_HAS_OPEN_TABLES } = require('../src/auth/roleChangeServiceV3');
const { AuthDaoError } = require('../src/auth/audit');

const sidHash = (sid) => (typeof sid === 'string' && sid.length > 0 ? 'h:' + sid : null);
const WID = 'ws-44444444-4444-4444-8444-444444444444';

function baseArgs(overrides = {}) {
  return {
    workspaceId: WID, byActor: 'owner', targetActor: 'waiter-1',
    expectedRole: 'waiter', requestedRole: 'cashier', sid: 'sid-1', clientRequestId: 'cr-1',
    stepUp: { sub: 'owner', sid: 'sid-1' },
    ...overrides,
  };
}

async function main() {
  // ── DAO export sanity ────────────────────────────────────────────────────────────
  {
    const { changeActorRoleV3 } = require('../src/auth/roleChangeDaoV3');
    assert('changeActorRoleV3 is exported (sanity)', typeof changeActorRoleV3 === 'function');
  }

  // ── service-level: DAO throws the new marker code -> WAITER_HAS_OPEN_TABLES ───────
  {
    const dao = {
      async changeActorRoleV3() {
        throw new AuthDaoError('ROLE_CHANGE_WAITER_OPEN_TABLES', 'waiter has open table sessions');
      },
    };
    const svc = createRoleChangeV3({ dao, sidHash });
    const out = await svc.changeRole(baseArgs());
    assert('role change: DAO marker AUTH_WAITER_HAS_OPEN_TABLES -> service returns WAITER_HAS_OPEN_TABLES (not generic FAILED)',
      out === WAITER_HAS_OPEN_TABLES && out.error === 'waiter_has_open_tables');
    assert('WAITER_HAS_OPEN_TABLES is a DISTINCT shape from FAILED and CONFLICT',
      WAITER_HAS_OPEN_TABLES !== FAILED && WAITER_HAS_OPEN_TABLES !== CONFLICT
      && WAITER_HAS_OPEN_TABLES.error !== FAILED.error && WAITER_HAS_OPEN_TABLES.error !== CONFLICT.error);
    assert('conflict result exposes no target/session identifier -- only {ok, error}',
      JSON.stringify(Object.keys(out).sort()) === JSON.stringify(['error', 'ok']));
    // Same error string as the lifecycle service's equivalent -- proves the shared HTTP
    // error-code table will route both through the identical 409 mapping.
    const { WAITER_HAS_OPEN_TABLES: lifecycleConst } = require('../src/auth/accessUserLifecycleServiceV3');
    assert('role-change WAITER_HAS_OPEN_TABLES uses the SAME error string as the lifecycle guard\'s equivalent constant',
      out.error === lifecycleConst.error);
  }

  // ── an UNRELATED DAO error code still collapses into the generic FAILED shape ──────
  {
    const dao = { async changeActorRoleV3() { throw new AuthDaoError('ROLE_CHANGE_FAILED', 'operation failed'); } };
    const svc = createRoleChangeV3({ dao, sidHash });
    const out = await svc.changeRole(baseArgs());
    assert('role change: unrelated DAO failure still collapses to generic FAILED', out === FAILED);
  }

  // ── idempotency conflict marker still works (V3-C contract untouched) ──────────────
  {
    const dao = { async changeActorRoleV3() { throw new AuthDaoError('ROLE_CHANGE_CONFLICT', 'idempotency conflict'); } };
    const svc = createRoleChangeV3({ dao, sidHash });
    const out = await svc.changeRole(baseArgs());
    assert('role change: idempotency-conflict marker still maps to CONFLICT, distinct from WAITER_HAS_OPEN_TABLES', out === CONFLICT);
  }

  // ── waiter->cashier / kitchen / rider / shift_manager all reach the same guard path ──
  for (const requestedRole of ['cashier', 'kitchen', 'rider', 'shift_manager']) {
    const dao = {
      calls: 0,
      async changeActorRoleV3(args) {
        this.calls++;
        if (args.requestedRole === requestedRole) throw new AuthDaoError('ROLE_CHANGE_WAITER_OPEN_TABLES', 'open tables');
        return { actor: args.targetActor, old_role: 'waiter', role: args.requestedRole, session_version: 2, changed: true };
      },
    };
    const svc = createRoleChangeV3({ dao, sidHash });
    const out = await svc.changeRole(baseArgs({ requestedRole }));
    assert(`waiter->${requestedRole} with open sessions conflicts`, out === WAITER_HAS_OPEN_TABLES);
  }

  // ── waiter->waiter no-op remains safe (service never even needs the DAO to reject it;
  //    the DAO fake here proves the SERVICE still calls through normally for a no-op,
  //    exactly like any other role-change call -- the guard is a DATABASE decision) ──
  {
    const dao = {
      async changeActorRoleV3(args) {
        return { actor: args.targetActor, old_role: 'waiter', role: 'waiter', session_version: 5, changed: false };
      },
    };
    const svc = createRoleChangeV3({ dao, sidHash });
    const out = await svc.changeRole(baseArgs({ requestedRole: 'waiter' }));
    assert('waiter->waiter no-op remains safe at the service layer', out.ok === true && out.changed === false);
  }

  // ── waiter with zero/only-closed sessions changes role normally ────────────────────
  {
    const dao = { async changeActorRoleV3(args) { return { actor: args.targetActor, old_role: 'waiter', role: args.requestedRole, session_version: 2, changed: true }; } };
    const svc = createRoleChangeV3({ dao, sidHash });
    const out = await svc.changeRole(baseArgs());
    assert('waiter with no open assignments changes role normally', out.ok === true && out.role === 'cashier');
  }

  // ── cashier->waiter remains governed by normal V3-C rules (guard is one-directional:
  //    only applies when moving AWAY from waiter) ────────────────────────────────────
  {
    const dao = { async changeActorRoleV3(args) { return { actor: args.targetActor, old_role: 'cashier', role: 'waiter', session_version: 2, changed: true }; } };
    const svc = createRoleChangeV3({ dao, sidHash });
    const out = await svc.changeRole(baseArgs({ expectedRole: 'cashier', requestedRole: 'waiter' }));
    assert('cashier->waiter unaffected by the (one-directional) waiter guard', out.ok === true && out.role === 'waiter');
  }

  // ── non-waiter role changes remain entirely unchanged ───────────────────────────────
  {
    const dao = { async changeActorRoleV3(args) { return { actor: args.targetActor, old_role: 'cashier', role: 'kitchen', session_version: 2, changed: true }; } };
    const svc = createRoleChangeV3({ dao, sidHash });
    const out = await svc.changeRole(baseArgs({ expectedRole: 'cashier', requestedRole: 'kitchen' }));
    assert('non-waiter role change remains unchanged by V3-G.1', out.ok === true && out.role === 'kitchen');
  }

  // ── owner target remains forbidden (unchanged pre-existing service-level rule:
  //    byActor === targetActor is rejected; the RPC itself also rejects an owner
  //    target by role -- proven in the real rehearsal) ────────────────────────────────
  {
    const dao = { calls: 0, async changeActorRoleV3() { this.calls++; return {}; } };
    const svc = createRoleChangeV3({ dao, sidHash });
    const out = await svc.changeRole(baseArgs({ targetActor: 'owner', byActor: 'owner' }));
    assert('acting owner targeting themselves is rejected before any DAO call', out === FAILED && dao.calls === 0);
  }

  // ── malformed/unknown requested roles remain fail-closed ───────────────────────────
  {
    const dao = { calls: 0, async changeActorRoleV3() { this.calls++; return {}; } };
    const svc = createRoleChangeV3({ dao, sidHash });
    const out1 = await svc.changeRole(baseArgs({ requestedRole: 'admin' }));
    const out2 = await svc.changeRole(baseArgs({ requestedRole: 'owner' }));
    const out3 = await svc.changeRole(baseArgs({ requestedRole: 'legacy_operator' }));
    const out4 = await svc.changeRole(baseArgs({ requestedRole: 'superuser_unapproved' }));
    const out5 = await svc.changeRole(baseArgs({ requestedRole: null }));
    assert('requestedRole=admin rejected before any DAO call', out1 === FAILED);
    assert('requestedRole=owner rejected before any DAO call', out2 === FAILED);
    assert('requestedRole=legacy_operator rejected before any DAO call', out3 === FAILED);
    assert('unknown requestedRole rejected before any DAO call', out4 === FAILED);
    assert('null requestedRole rejected before any DAO call', out5 === FAILED);
    assert('none of the malformed-role attempts reached the DAO', dao.calls === 0);
  }

  // ── step-up required before any DAO call (V3-C contract preserved) ─────────────────
  {
    const dao = { calls: 0, async changeActorRoleV3() { this.calls++; return {}; } };
    const svc = createRoleChangeV3({ dao, sidHash });
    const out1 = await svc.changeRole(baseArgs({ stepUp: null }));
    const out2 = await svc.changeRole(baseArgs({ stepUp: { sub: 'someone-else', sid: 'sid-1' } }));
    const out3 = await svc.changeRole(baseArgs({ stepUp: { sub: 'owner', sid: 'wrong-sid' } }));
    assert('missing step-up rejected before any DAO call', out1 === FAILED);
    assert('wrong-actor step-up rejected before any DAO call', out2 === FAILED);
    assert('wrong-sid step-up rejected before any DAO call', out3 === FAILED);
    assert('none of the rejected step-up attempts reached the DAO', dao.calls === 0);
  }

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('TEST SCRIPT ERROR:', e); process.exit(1); });
