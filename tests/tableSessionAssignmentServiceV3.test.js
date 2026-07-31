'use strict';
// Access Control V3 -- Block V3-G: assignment-safety tests for
// tableSessionAssignmentServiceV3.js / tableSessionAssignmentDaoV3.js (FOUNDATION,
// UNWIRED). Run: node tests/tableSessionAssignmentServiceV3.test.js
//
// The fake DAO mirrors auth_assign_table_session_waiter_v3's real SQL decision logic
// (workspace check, actor-set lock/re-read, exact role='waiter' eligibility, session
// open/workspace check, stale-snapshot check, no-op-vs-real-change, one history row per
// real change) so the service is exercised against realistic RPC semantics -- the same
// discipline used by every other V3 service test in this suite. Concurrency itself is
// proven separately by the real disposable-PostgreSQL rehearsal.

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

const { createTableSessionAssignmentV3Service, FAILED, CONFLICT, STALE, NOT_OPEN, TARGET_ROLE_INELIGIBLE } = require('../src/auth/tableSessionAssignmentServiceV3');
const { AuthDaoError } = require('../src/auth/audit');

const WID = 'ws-22222222-2222-4222-8222-222222222222';
const OTHER_WID = 'ws-33333333-3333-4333-8333-333333333333';
const sidHash = (sid) => (typeof sid === 'string' && sid.length > 0 ? 'h:' + sid : null);
const notExpired = Math.floor(Date.now() / 1000) + 600;

function baseArgs(overrides = {}) {
  return {
    workspaceId: WID, byActor: 'owner', actingRole: 'admin',
    tableSessionId: 'sess-1', expectedAssignedWaiterActor: null, requestedWaiterActor: 'waiter-1',
    sid: 'sid-1', clientRequestId: 'cr-1', stepUp: { sub: 'owner', sid: 'sid-1', exp: notExpired },
    ...overrides,
  };
}

// ── faithful fake DAO, mirroring the real RPC's decision logic ─────────────────────
function makeDb() {
  const actors = {
    owner: { role: 'admin', active: true, workspace_id: WID },
    'waiter-1': { role: 'waiter', active: true, workspace_id: WID },
    'waiter-2': { role: 'waiter', active: true, workspace_id: WID },
    'inactive-waiter': { role: 'waiter', active: false, workspace_id: WID },
    'cashier-1': { role: 'cashier', active: true, workspace_id: WID },
    'foreign-waiter': { role: 'waiter', active: true, workspace_id: OTHER_WID },
  };
  const sessions = {
    'sess-1': { workspace_id: WID, status: 'open', assigned_waiter_actor: null },
    'sess-closed': { workspace_id: WID, status: 'closed', assigned_waiter_actor: null },
    'sess-foreign': { workspace_id: OTHER_WID, status: 'open', assigned_waiter_actor: null },
  };
  const idempotency = new Map();
  const history = [];
  let assignCalls = 0;

  const dao = {
    assignCalls: 0,
    async assignTableSessionWaiterV3(args) {
      dao.assignCalls++;
      const key = [args.workspaceId, args.byActor, args.bySidHash, 'assign_table_session_waiter_v3', args.clientRequestId].join('|');
      const by = actors[args.byActor];
      if (!by || by.workspace_id !== args.workspaceId || !by.active || !['admin', 'owner'].includes(by.role)) {
        throw new AuthDaoError('TABLE_SESSION_ASSIGN_FAILED', 'not owner');
      }
      if (args.requestedWaiterActor !== null) {
        const req = actors[args.requestedWaiterActor];
        if (!req) throw new AuthDaoError('TABLE_SESSION_ASSIGN_FAILED', 'actor not found');
        if (req.workspace_id !== args.workspaceId) throw new AuthDaoError('TABLE_SESSION_ASSIGN_FAILED', 'cross workspace waiter');
        if (!req.active) throw new AuthDaoError('TABLE_SESSION_ASSIGN_FAILED', 'inactive waiter');
        if (req.role !== 'waiter') throw new AuthDaoError('TABLE_SESSION_TARGET_ROLE_INELIGIBLE', 'not a waiter');
      }
      const sess = sessions[args.tableSessionId];
      if (!sess) throw new AuthDaoError('TABLE_SESSION_ASSIGN_FAILED', 'session not found');
      if (sess.workspace_id !== args.workspaceId) throw new AuthDaoError('TABLE_SESSION_ASSIGN_FAILED', 'cross workspace session');
      if (sess.status !== 'open') throw new AuthDaoError('TABLE_SESSION_NOT_OPEN', 'not open');

      if (idempotency.has(key)) {
        const rec = idempotency.get(key);
        if (rec.requestHash === args.requestHash) return rec.response;
        throw new AuthDaoError('TABLE_SESSION_ASSIGN_CONFLICT', 'idempotency conflict');
      }

      if (sess.assigned_waiter_actor !== args.expectedAssignedWaiterActor) {
        throw new AuthDaoError('TABLE_SESSION_ASSIGN_STALE', 'stale assignment');
      }

      const changed = sess.assigned_waiter_actor !== args.requestedWaiterActor;
      if (changed) {
        history.push({ session: args.tableSessionId, from: sess.assigned_waiter_actor, to: args.requestedWaiterActor });
        sess.assigned_waiter_actor = args.requestedWaiterActor;
      }
      const response = { table_session_id: args.tableSessionId, assigned_waiter_actor: sess.assigned_waiter_actor, status: sess.status, updated_at: 't', updated_by: args.byActor };
      idempotency.set(key, { requestHash: args.requestHash, response });
      return response;
    },
    async listOpenTableSessionsForWaiter(workspaceId, waiterActor) {
      return Object.entries(sessions)
        .filter(([, s]) => s.workspace_id === workspaceId && s.status === 'open' && s.assigned_waiter_actor === waiterActor)
        .map(([id, s]) => ({ id, table_ref: id, status: s.status, opened_at: 't', updated_at: 't' }));
    },
  };
  return { dao, actors, sessions, history, getAssignCalls: () => dao.assignCalls };
}

async function main() {
  // ── active same-workspace waiter can be assigned ──────────────────────────────────
  {
    const { dao, sessions } = makeDb();
    const svc = createTableSessionAssignmentV3Service({ dao, sidHash });
    const out = await svc.assignWaiter(baseArgs());
    assert('active same-workspace waiter can be assigned', out.ok === true && out.assignedWaiterActor === 'waiter-1');
    assert('session row actually shows the new assignment', sessions['sess-1'].assigned_waiter_actor === 'waiter-1');
  }

  // ── inactive waiter rejected ────────────────────────────────────────────────────────
  {
    const { dao } = makeDb();
    const svc = createTableSessionAssignmentV3Service({ dao, sidHash });
    const out = await svc.assignWaiter(baseArgs({ requestedWaiterActor: 'inactive-waiter' }));
    assert('inactive waiter rejected', out === FAILED);
  }

  // ── non-waiter role rejected (distinguishable) ──────────────────────────────────────
  {
    const { dao } = makeDb();
    const svc = createTableSessionAssignmentV3Service({ dao, sidHash });
    const out = await svc.assignWaiter(baseArgs({ requestedWaiterActor: 'cashier-1' }));
    assert('non-waiter role rejected with a distinguishable TARGET_ROLE_INELIGIBLE', out === TARGET_ROLE_INELIGIBLE);
  }

  // ── cross-workspace waiter rejected ─────────────────────────────────────────────────
  {
    const { dao } = makeDb();
    const svc = createTableSessionAssignmentV3Service({ dao, sidHash });
    const out = await svc.assignWaiter(baseArgs({ requestedWaiterActor: 'foreign-waiter' }));
    assert('cross-workspace waiter rejected', out === FAILED);
  }

  // ── closed session rejected (distinguishable) ───────────────────────────────────────
  {
    const { dao } = makeDb();
    const svc = createTableSessionAssignmentV3Service({ dao, sidHash });
    const out = await svc.assignWaiter(baseArgs({ tableSessionId: 'sess-closed' }));
    assert('closed session rejected with a distinguishable NOT_OPEN', out === NOT_OPEN);
  }

  // ── cross-workspace session rejected ────────────────────────────────────────────────
  {
    const { dao } = makeDb();
    const svc = createTableSessionAssignmentV3Service({ dao, sidHash });
    const out = await svc.assignWaiter(baseArgs({ tableSessionId: 'sess-foreign' }));
    assert('cross-workspace session rejected', out === FAILED);
  }

  // ── stale current-assignee snapshot rejected (distinguishable) ─────────────────────
  {
    const { dao } = makeDb();
    const svc = createTableSessionAssignmentV3Service({ dao, sidHash });
    const out = await svc.assignWaiter(baseArgs({ expectedAssignedWaiterActor: 'waiter-2' })); // real current is null
    assert('stale expected-assignee snapshot rejected with a distinguishable STALE', out === STALE);
  }

  // ── same assignment is a deterministic no-op (no new history row) ──────────────────
  {
    const { dao, history } = makeDb();
    const svc = createTableSessionAssignmentV3Service({ dao, sidHash });
    await svc.assignWaiter(baseArgs({ clientRequestId: 'cr-a' }));
    const before = history.length;
    const out = await svc.assignWaiter(baseArgs({ clientRequestId: 'cr-b', expectedAssignedWaiterActor: 'waiter-1', requestedWaiterActor: 'waiter-1' }));
    assert('assigning the SAME waiter again (different request) is a deterministic no-op', out.ok === true);
    assert('no-op does not append a new history row', history.length === before);
  }

  // ── real assignment writes exactly one history row ──────────────────────────────────
  {
    const { dao, history } = makeDb();
    const svc = createTableSessionAssignmentV3Service({ dao, sidHash });
    await svc.assignWaiter(baseArgs());
    assert('real assignment writes exactly one history row', history.length === 1 && history[0].to === 'waiter-1');
  }

  // ── replay (same key) writes no second history row ──────────────────────────────────
  {
    const { dao, history } = makeDb();
    const svc = createTableSessionAssignmentV3Service({ dao, sidHash });
    const args = baseArgs();
    await svc.assignWaiter(args);
    const before = history.length;
    const out = await svc.assignWaiter(args); // identical args -> identical request hash -> replay
    assert('replay with the SAME key + SAME payload returns the stored response', out.ok === true && out.assignedWaiterActor === 'waiter-1');
    assert('replay does not append a second history row', history.length === before);
    assert('replay does not call the DAO a third time beyond the two real invocations', dao.assignCalls === 2); // first real call + replay call both reach the DAO layer (DAO itself resolves the replay), consistent with every other V3 RPC's idempotency-at-the-RPC-layer design
  }

  // ── changed-payload replay conflicts ────────────────────────────────────────────────
  {
    const { dao } = makeDb();
    const svc = createTableSessionAssignmentV3Service({ dao, sidHash });
    await svc.assignWaiter(baseArgs({ clientRequestId: 'cr-same-key' }));
    const out = await svc.assignWaiter(baseArgs({ clientRequestId: 'cr-same-key', requestedWaiterActor: 'waiter-2', expectedAssignedWaiterActor: 'waiter-1' }));
    assert('same client_request_id with a DIFFERENT semantic payload conflicts', out === CONFLICT);
  }

  // ── history is append-only (no test path ever mutates a prior history entry) ───────
  {
    const { dao, history } = makeDb();
    const svc = createTableSessionAssignmentV3Service({ dao, sidHash });
    await svc.assignWaiter(baseArgs({ clientRequestId: 'cr-1' }));
    const snapshot = JSON.stringify(history);
    await svc.assignWaiter(baseArgs({ clientRequestId: 'cr-2', expectedAssignedWaiterActor: 'waiter-1', requestedWaiterActor: 'waiter-2' }));
    assert('the FIRST history row is never mutated by a later real change', JSON.stringify(history[0]) === JSON.stringify(JSON.parse(snapshot)[0]));
    assert('a real reassignment appends a SECOND row, does not rewrite the first', history.length === 2 && history[1].from === 'waiter-1' && history[1].to === 'waiter-2');
  }

  // ── unrelated sessions unchanged by an assignment to a different session ───────────
  {
    const { dao, sessions } = makeDb();
    const svc = createTableSessionAssignmentV3Service({ dao, sidHash });
    await svc.assignWaiter(baseArgs());
    assert('an unrelated closed session is untouched', sessions['sess-closed'].assigned_waiter_actor === null);
    assert('an unrelated foreign-workspace session is untouched', sessions['sess-foreign'].assigned_waiter_actor === null);
  }

  // ── explicit clear (requestedWaiterActor: null) ─────────────────────────────────────
  {
    const { dao, sessions, history } = makeDb();
    const svc = createTableSessionAssignmentV3Service({ dao, sidHash });
    await svc.assignWaiter(baseArgs({ clientRequestId: 'cr-1' }));
    const out = await svc.assignWaiter(baseArgs({ clientRequestId: 'cr-2', expectedAssignedWaiterActor: 'waiter-1', requestedWaiterActor: null }));
    assert('explicit clear succeeds', out.ok === true && out.assignedWaiterActor === null);
    assert('clear appends an action=cleared-equivalent history row (from waiter-1 to null)', history.some((h) => h.from === 'waiter-1' && h.to === null));
    assert('session row genuinely shows no assignment after clear', sessions['sess-1'].assigned_waiter_actor === null);
  }

  // ── authorization/step-up required before any DAO call ──────────────────────────────
  {
    const { dao } = makeDb();
    const svc = createTableSessionAssignmentV3Service({ dao, sidHash });
    const out1 = await svc.assignWaiter(baseArgs({ actingRole: 'cashier' })); // non-owner acting role
    const out2 = await svc.assignWaiter(baseArgs({ stepUp: null })); // missing step-up
    const out3 = await svc.assignWaiter(baseArgs({ stepUp: { sub: 'owner', sid: 'sid-1', exp: Math.floor(Date.now() / 1000) - 5 } })); // expired step-up
    assert('non-owner acting role rejected before any DAO call', out1 === FAILED);
    assert('missing step-up rejected before any DAO call', out2 === FAILED);
    assert('expired step-up rejected before any DAO call', out3 === FAILED);
    assert('none of the three rejected attempts reached the DAO', dao.assignCalls === 0);
  }

  // ── read: list open sessions for a waiter is workspace-scoped ──────────────────────
  {
    const { dao } = makeDb();
    const svc = createTableSessionAssignmentV3Service({ dao, sidHash });
    await svc.assignWaiter(baseArgs());
    const out = await svc.listOpenSessionsForWaiter({ workspaceId: WID, waiterActor: 'waiter-1' });
    assert('list open sessions succeeds and reflects the real assignment', out.ok === true && out.sessions.length === 1 && out.sessions[0].id === 'sess-1');
    const outOther = await svc.listOpenSessionsForWaiter({ workspaceId: OTHER_WID, waiterActor: 'waiter-1' });
    assert('list open sessions is workspace-scoped -- a different workspace sees nothing', outOther.ok === true && outOther.sessions.length === 0);
  }

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('TEST SCRIPT ERROR:', e); process.exit(1); });
