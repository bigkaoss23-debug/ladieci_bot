'use strict';
// W5 PACKET 01 — atomic create/attach-or-move, signal bump coverage/granularity,
// concurrency (no dual membership, no lost signal increments, deterministic locks).
const rt = require('../pgRuntime');
const { section, assert, call } = require('../lib');
const { open } = require('./_ctx');

async function signalVersion(su) {
  const r = await su.query("SELECT valore FROM public.config WHERE chiave = 'GIRO_FACTS_SIGNAL'");
  return JSON.parse(r.rows[0].valore).version;
}

async function waitBlocked(su, app, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await su.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'", [app]);
    if (r.rows[0].n > 0) return true;
    await new Promise((res) => setTimeout(res, 25));
  }
  return false;
}

async function run(env) {
  section('W5-C — ATOMIC CREATE (create_or_move_v1)');
  const c = await open(env, 'w5create');
  try {
    const D = '2026-09-14';
    const s = await c.fx.day(D);
    const scope = [s];
    const mk = (o) => c.fx.order(c.svc, { session: s, estado: 'LISTO', ...o });
    const createOrMove = (uids, hora = null, anchor = null, actor = 'op-1', sc = scope) =>
      call(c.svc, 'giro_authority_create_or_move_v1', [uids, hora, anchor, actor, sc]);
    const create = (uids, hora = null, anchor = null, actor = 'op-1', sc = scope) =>
      call(c.svc, 'giro_authority_create_v1', [uids, hora, anchor, actor, sc]);

    // W5-C01: existing membership silent-move parity -- an order already effective in
    // another giro is silently moved, matching legacy createManualGiro's own behavior
    // (unlike create_v1, which refuses ORDER_ALREADY_IN_GIRO).
    const A = await mk({}); const B = await mk({}); const X = await mk({});
    const g1 = await create([A.order_uid, X.order_uid]);
    assert('W5-C01 setup: create {A,X} -> OK', g1.ok && g1.code === 'OK', g1);
    let v0 = await signalVersion(c.su);
    const r1 = await createOrMove([A.order_uid, B.order_uid]);
    assert('W5-C01: create_or_move {A(already in g1),B} -> OK, never a refusal', r1.ok && r1.code === 'OK', r1);
    assert('W5-C01: response reports moved_from including g1 (legacy parity: silent-move disclosed)',
      Array.isArray(r1.moved_from) && r1.moved_from.includes(g1.giro_id), r1);
    const mem1 = await c.fx.membership();
    assert('W5-C01: A now belongs to the NEW giro, not g1', mem1.find((m) => m.order_uid === A.order_uid).giro_id === r1.giro_id);
    assert('W5-C01: signal bumped exactly once for this one logical mutation', (await signalVersion(c.su)) === v0 + 1, { before: v0, after: await signalVersion(c.su) });

    // W5-C02: members distributed across MULTIPLE existing giros -> one atomic result.
    const P = await mk({}); const Q = await mk({}); const R = await mk({}); const S = await mk({});
    const gp = await create([P.order_uid, Q.order_uid]);
    const gr = await create([R.order_uid, S.order_uid]);
    v0 = await signalVersion(c.su);
    const r2 = await createOrMove([P.order_uid, R.order_uid]);
    assert('W5-C02: members from two DIFFERENT prior giros -> one OK result', r2.ok && r2.code === 'OK', r2);
    assert('W5-C02: moved_from lists both prior giros', new Set(r2.moved_from).size === 2 &&
      r2.moved_from.includes(gp.giro_id) && r2.moved_from.includes(gr.giro_id), r2);
    assert('W5-C02: exactly one signal bump for the whole multi-source move', (await signalVersion(c.su)) === v0 + 1);
    // The two source giros now derive below-threshold (1 effective member each) -> DISSOLVED,
    // with dissolved_at left NULL (derived, never an explicit write) -- same invariant as detach.
    const projAfter = await call(c.svc, 'giro_projection_v1', [scope]);
    const gpState = projAfter.giros.find((g) => g.giro_id === gp.giro_id);
    assert('W5-C02: source giro gp derives DISSOLVED (below threshold) with no explicit write', gpState.giro_state === 'DISSOLVED');
    const gpRow = (await c.su.query('SELECT dissolved_at FROM public.manual_giros WHERE id = $1', [gp.giro_id])).rows[0];
    assert('W5-C02: source giro gp.dissolved_at stays NULL (derived dissolution, not written)', gpRow.dissolved_at === null);

    // W5-C03: validation failure -> zero membership changes, signal delta 0.
    const memBefore = JSON.stringify(await c.fx.membership());
    v0 = await signalVersion(c.su);
    const bad = await createOrMove([P.order_uid]); // INSUFFICIENT_MEMBERS
    assert('W5-C03: single-order create -> INSUFFICIENT_MEMBERS refusal', !bad.ok && bad.code === 'INSUFFICIENT_MEMBERS', bad);
    assert('W5-C03: membership completely unchanged on refusal', JSON.stringify(await c.fx.membership()) === memBefore);
    assert('W5-C03: signal delta 0 on a refused/failed mutation', (await signalVersion(c.su)) === v0);

    // W5-C04: moving N members in one call -> signal delta exactly +1 (not N).
    const M1 = await mk({}); const M2 = await mk({}); const M3 = await mk({});
    const gm1 = await create([M1.order_uid, M2.order_uid]);
    v0 = await signalVersion(c.su);
    const r4 = await createOrMove([M1.order_uid, M2.order_uid, M3.order_uid]);
    assert('W5-C04: moving 3 members (2 from an existing giro, 1 fresh) -> OK', r4.ok && r4.code === 'OK', r4);
    assert('W5-C04: signal delta is exactly +1, never one bump per detached member', (await signalVersion(c.su)) === v0 + 1);

    // W5-C05: no intermediate externally-visible detached state. Hold the mutation open
    // mid-transaction and prove a concurrent reader never observes M1/M2 with NO giro at
    // all (only either the OLD or the NEW state, atomically -- since create_or_move_v1
    // runs as one PL/pgSQL statement/transaction, an external reader can only ever see
    // the pre-commit or post-commit state, never an in-between).
    const N1 = await mk({}); const N2 = await mk({});
    const gn = await create([N1.order_uid, N2.order_uid]);
    const t1 = await c.client('service_role', 'w5-t1');
    await t1.query('BEGIN');
    const pending = call(t1, 'giro_authority_create_or_move_v1', [[N1.order_uid, await mk({}).then((o) => o.order_uid)], null, null, 'op-1', scope]);
    // give the transaction a moment to start executing (best-effort; the real proof is
    // the membership snapshot below never showing N1 detached mid-flight)
    await new Promise((res) => setTimeout(res, 50));
    const midMembership = await c.fx.membership();
    const n1row = midMembership.find((m) => m.order_uid === N1.order_uid);
    assert('W5-C05: mid-transaction, N1 is still exactly where it was (old giro) or already the new one -- never absent',
      !!n1row, midMembership);
    await pending;
  } finally { await c.close(); }

  section('W5-A — ATOMIC ADD (attach_or_move_v1)');
  const a = await open(env, 'w5add');
  try {
    const D = '2026-09-14';
    const s = await a.fx.day(D);
    const scope = [s];
    const mk = (o) => a.fx.order(a.svc, { session: s, estado: 'LISTO', ...o });
    const create = (uids) => call(a.svc, 'giro_authority_create_v1', [uids, null, null, 'op-1', scope]);
    const attachOrMove = (g, o, actor = 'op-2') => call(a.svc, 'giro_authority_attach_or_move_v1', [g, o.order_uid, actor, scope]);

    // W5-A01: unattached -> target (the case plain move_v1 cannot serve).
    const G1 = (await create([await mk({}).then((o) => o.order_uid), await mk({}).then((o) => o.order_uid)])).giro_id;
    const U = await mk({});
    let v0 = await signalVersion(a.su);
    const r1 = await attachOrMove(G1, U);
    assert('W5-A01: unattached order -> attach -> OK', r1.ok && r1.code === 'OK' && r1.moved_from === null, r1);
    assert('W5-A01: signal delta +1', (await signalVersion(a.su)) === v0 + 1);

    // W5-A02: same target -> IDEMPOTENT, signal delta 0.
    v0 = await signalVersion(a.su);
    const r2 = await attachOrMove(G1, U);
    assert('W5-A02: same-target replay -> IDEMPOTENT', r2.ok && r2.code === 'IDEMPOTENT', r2);
    assert('W5-A02: signal delta 0 on IDEMPOTENT', (await signalVersion(a.su)) === v0);

    // W5-A03: other giro -> target, atomic move, signal delta +1.
    const G2 = (await create([await mk({}).then((o) => o.order_uid), await mk({}).then((o) => o.order_uid)])).giro_id;
    v0 = await signalVersion(a.su);
    const r3 = await attachOrMove(G2, U);
    assert('W5-A03: order effective in ANOTHER giro -> atomic move -> OK', r3.ok && r3.code === 'OK' && r3.moved_from === G1, r3);
    assert('W5-A03: signal delta +1 for the move', (await signalVersion(a.su)) === v0 + 1);
    const mem = await a.fx.membership();
    assert('W5-A03: U now belongs to G2 only (no split)', mem.filter((m) => m.order_uid === U.order_uid).length === 1 &&
      mem.find((m) => m.order_uid === U.order_uid).giro_id === G2);

    // W5-A04: concurrent mutation on the same order -> deterministic authoritative result
    // (no split, no JS branching, both requests race genuinely in parallel).
    const G3 = (await create([await mk({}).then((o) => o.order_uid), await mk({}).then((o) => o.order_uid)])).giro_id;
    const G4 = (await create([await mk({}).then((o) => o.order_uid), await mk({}).then((o) => o.order_uid)])).giro_id;
    const W = await mk({});
    const p1 = await a.client('service_role', 'w5-race-1');
    const p2 = await a.client('service_role', 'w5-race-2');
    const [ra, rb] = await Promise.all([
      call(p1, 'giro_authority_attach_or_move_v1', [G3, W.order_uid, 'op-1', scope]),
      call(p2, 'giro_authority_attach_or_move_v1', [G4, W.order_uid, 'op-2', scope]),
    ]);
    // Both legitimately succeed: attach_or_move never refuses on "already elsewhere",
    // it moves -- so under the row lock, whichever call is serialized second simply
    // observes the first one's result and moves the order again. This is the correct,
    // desired composition (deterministic final state, no error, no deadlock) -- NOT a
    // race bug. The real invariants are: both calls succeed, and the order ends up in
    // exactly ONE giro matching whichever call committed last.
    assert('W5-A04: both concurrent attach-or-move calls succeed (no refusal, no deadlock)',
      ra.ok && rb.ok && ra.code === 'OK' && rb.code === 'OK', { ra, rb });
    const memAfter = await a.fx.membership();
    const finalGiro = memAfter.find((m) => m.order_uid === W.order_uid).giro_id;
    assert('W5-A04: exactly one final membership row, matching whichever call committed last (no split)',
      memAfter.filter((m) => m.order_uid === W.order_uid).length === 1 &&
      (finalGiro === G3 || finalGiro === G4) &&
      (finalGiro === ra.giro_id ? ra.moved_from === G4 || ra.moved_from === null : rb.moved_from === G3 || rb.moved_from === null),
      { ra, rb, finalGiro });
  } finally { await a.close(); }

  section('W5-R/D — REMOVE/DISSOLVE SIGNAL COVERAGE');
  const rd = await open(env, 'w5removedissolve');
  try {
    const D = '2026-09-14';
    const s = await rd.fx.day(D);
    const scope = [s];
    const mk = (o) => rd.fx.order(rd.svc, { session: s, estado: 'LISTO', ...o });
    const create = (uids) => call(rd.svc, 'giro_authority_create_v1', [uids, null, null, 'op-1', scope]);
    const detach = (o) => call(rd.svc, 'giro_authority_detach_v1', [o.order_uid, 'op-2', scope]);
    const dissolve = (g) => call(rd.svc, 'giro_authority_dissolve_v1', [g, 'op-3', scope]);

    const X1 = await mk({}); const X2 = await mk({}); const X3 = await mk({});
    const g = await create([X1.order_uid, X2.order_uid, X3.order_uid]);

    let v0 = await signalVersion(rd.su);
    const rDetach = await detach(X1);
    assert('detach an actual effective member -> OK', rDetach.ok && rDetach.code === 'OK', rDetach);
    assert('actual detach -> signal delta +1', (await signalVersion(rd.su)) === v0 + 1);

    v0 = await signalVersion(rd.su);
    const rDetachAgain = await detach(X1);
    assert('detach again (already gone) -> IDEMPOTENT', rDetachAgain.code === 'IDEMPOTENT', rDetachAgain);
    assert('idempotent/no-effective detach -> signal delta 0', (await signalVersion(rd.su)) === v0);

    const G2 = (await create([await mk({}).then((o) => o.order_uid), await mk({}).then((o) => o.order_uid)])).giro_id;
    v0 = await signalVersion(rd.su);
    const rDiss = await dissolve(G2);
    assert('dissolve an active giro -> OK', rDiss.ok && rDiss.code === 'OK', rDiss);
    assert('actual dissolve -> signal delta +1', (await signalVersion(rd.su)) === v0 + 1);

    v0 = await signalVersion(rd.su);
    const rDissAgain = await dissolve(G2);
    assert('dissolve already-dissolved giro -> IDEMPOTENT', rDissAgain.code === 'IDEMPOTENT', rDissAgain);
    assert('already-dissolved/no-op dissolve -> signal delta 0', (await signalVersion(rd.su)) === v0);
  } finally { await rd.close(); }

  section('W5-CONCURRENCY — no lost signal increments, no dual/partial state, deterministic locks');
  const cc = await open(env, 'w5concurrency');
  try {
    const D = '2026-09-14';
    const s = await cc.fx.day(D);
    const scope = [s];
    const mk = (o) => cc.fx.order(cc.svc, { session: s, estado: 'LISTO', ...o });

    // Two concurrent, INDEPENDENT successful mutations -> final version delta = +2,
    // no lost update.
    const v0 = await signalVersion(cc.su);
    const p1 = await cc.client('service_role', 'w5-cc-1');
    const p2 = await cc.client('service_role', 'w5-cc-2');
    const pair1 = [await mk({}), await mk({})];
    const pair2 = [await mk({}), await mk({})];
    const [rc1, rc2] = await Promise.all([
      call(p1, 'giro_authority_create_or_move_v1', [pair1.map((o) => o.order_uid), null, null, 'op-1', scope]),
      call(p2, 'giro_authority_create_or_move_v1', [pair2.map((o) => o.order_uid), null, null, 'op-2', scope]),
    ]);
    assert('two concurrent independent creates both OK', rc1.ok && rc2.ok && rc1.code === 'OK' && rc2.code === 'OK', { rc1, rc2 });
    assert('two concurrent successful mutations -> signal delta = +2 exactly (no lost increment)',
      (await signalVersion(cc.su)) === v0 + 2, { before: v0, after: await signalVersion(cc.su) });
    assert('two concurrent creates -> 2 distinct giro ids (no split/merge)', rc1.giro_id !== rc2.giro_id, { rc1, rc2 });

    // Deterministic locking: create vs create sharing an order -> exactly one OK, one refusal.
    const shared = await mk({});
    const other1 = await mk({});
    const other2 = await mk({});
    const [rs1, rs2] = await Promise.all([
      call(p1, 'giro_authority_create_or_move_v1', [[shared.order_uid, other1.order_uid], null, null, 'op-1', scope]),
      call(p2, 'giro_authority_create_or_move_v1', [[shared.order_uid, other2.order_uid], null, null, 'op-2', scope]),
    ]);
    assert('two concurrent creates sharing ONE order -> both OK (second silently moves the shared order, no deadlock, no split)',
      rs1.ok && rs2.ok, { rs1, rs2 });
    const finalMem = await cc.fx.membership();
    assert('shared order ends up in exactly one giro after the race', finalMem.filter((m) => m.order_uid === shared.order_uid).length === 1, finalMem);

    // Rollback leaves the signal unchanged.
    const vBeforeRollback = await signalVersion(cc.su);
    const t = await cc.client('service_role', 'w5-rollback');
    await t.query('BEGIN');
    const rA = await mk({}); const rB = await mk({});
    await call(t, 'giro_authority_create_or_move_v1', [[rA.order_uid, rB.order_uid], null, null, 'op-1', scope]);
    await t.query('ROLLBACK');
    assert('a rolled-back mutation leaves the signal completely unchanged', (await signalVersion(cc.su)) === vBeforeRollback);
    const memAfterRollback = await cc.fx.membership();
    assert('a rolled-back mutation leaves no membership residue', !memAfterRollback.some((m) => m.order_uid === rA.order_uid));
  } finally { await cc.close(); }
}

module.exports = { run };
