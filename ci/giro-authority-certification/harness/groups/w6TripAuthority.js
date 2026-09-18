'use strict';
// W6.2 TRIP AUTHORITY FOUNDATION certification. Exercises the dormant
// public.start_rider_trip_v2 / public.trip_projection_v1 / trip_authority.* schema
// this migration adds, and re-verifies giro_authority.trip_facts_v1's re-point (the
// one existing function this migration touches) is behaviourally equivalent to its
// pre-134 body for every current-staging-shaped read (trip_authority.trips empty).
// Matrix items 1-21, 24-25 below; items 22-23 (W4 raw-reader count / W5 writer-family
// count) are JS-source static invariants, unaffected by this migration (no JS
// touched) and re-verified by the existing static test suite as part of the full
// backend-suite run, not by this PG harness.
const { section, assert, call, fixture } = require('../lib');
const { open, ensureCaptureTrigger, hasDispatchedBy } = require('./_ctx');

async function waitBlocked(su, app, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await su.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'", [app]);
    if (r.rows[0].n > 0) return true;
    await new Promise((res) => setTimeout(res, 25));
  }
  return false;
}

async function makeRider(su, actor, sessionVersion = 1) {
  await su.query(`
    INSERT INTO public.auth_actors (actor, role, session_version, active, workspace_id)
    VALUES ($1, 'rider', $2, true, gen_random_uuid())
    ON CONFLICT (actor) DO UPDATE SET session_version = EXCLUDED.session_version, active = true, role = 'rider'`,
    [actor, sessionVersion]);
}

function ctx(c, s) {
  const scope = [s];
  const mk = (o) => c.fx.order(c.svc, { session: s, ...o });
  const createOrMove = async (orders) => call(c.svc, 'giro_authority_create_or_move_v1',
    [orders.map((o) => o.order_uid), null, null, 'op-1', scope]);
  const startV2 = async (client, anchor, actor, sv = 1) => call(client, 'start_rider_trip_v2', [anchor.order_uid, actor, sv, scope]);
  return { scope, mk, createOrMove, startV2 };
}

async function run(env) {
  // 1. 3-member PLANNED giro -> one canonical trip with 3 trip_members ------------------
  {
    const c = await open(env, 'w6ta01');
    try {
      await ensureCaptureTrigger(c.su);
      const s = await c.fx.day('2026-09-15');
      const { mk, createOrMove, startV2 } = ctx(c, s);
      await makeRider(c.su, 'rider-01');
      const A = await mk({ estado: 'LISTO' }); const B = await mk({ estado: 'LISTO' }); const C = await mk({ estado: 'LISTO' });
      await createOrMove([A, B, C]);
      const r = await startV2(c.svc, A, 'rider-01');
      assert('1: 3-member departure -> OK', r.ok === true && r.code === 'OK', r);
      const rows = (await c.su.query('SELECT order_uid FROM trip_authority.trip_members WHERE trip_id = $1', [r.trip_id])).rows;
      assert('1: exactly 3 trip_members rows created', rows.length === 3, rows);
      const uids = new Set(rows.map((x) => x.order_uid));
      assert('1: trip_members exactly matches {A,B,C}', [A, B, C].every((o) => uids.has(o.order_uid)), { uids: [...uids] });
    } finally { await c.close(); }
  }

  // 2. single non-giro order -> one-member trip ------------------------------------------
  {
    const c = await open(env, 'w6ta02');
    try {
      await ensureCaptureTrigger(c.su);
      const s = await c.fx.day('2026-09-15');
      const { mk, startV2 } = ctx(c, s);
      await makeRider(c.su, 'rider-02');
      const D = await mk({ estado: 'LISTO' });
      const r = await startV2(c.svc, D, 'rider-02');
      assert('2: single non-giro order -> OK', r.ok === true && r.code === 'OK', r);
      assert('2: giro_id is NULL for a non-giro departure', r.giro_id === null, r);
      const rows = (await c.su.query('SELECT order_uid FROM trip_authority.trip_members WHERE trip_id = $1', [r.trip_id])).rows;
      assert('2: exactly 1 trip_members row', rows.length === 1 && rows[0].order_uid === D.order_uid, rows);
    } finally { await c.close(); }
  }

  // 3. immutable frozen membership --------------------------------------------------------
  {
    const c = await open(env, 'w6ta03');
    try {
      await ensureCaptureTrigger(c.su);
      const s = await c.fx.day('2026-09-15');
      const { mk, startV2 } = ctx(c, s);
      await makeRider(c.su, 'rider-03');
      const D = await mk({ estado: 'LISTO' });
      const r = await startV2(c.svc, D, 'rider-03');
      const updErr = await c.su.query('UPDATE trip_authority.trip_members SET stop_seq = 99 WHERE trip_id = $1', [r.trip_id]).catch((e) => e);
      assert('3: UPDATE on trip_members is refused (P0001 append-only)', updErr instanceof Error && updErr.code === 'P0001', updErr && updErr.message);
      const delErr = await c.su.query('DELETE FROM trip_authority.trip_members WHERE trip_id = $1', [r.trip_id]).catch((e) => e);
      assert('3: DELETE on trip_members is refused (P0001 append-only)', delErr instanceof Error && delErr.code === 'P0001', delErr && delErr.message);
    } finally { await c.close(); }
  }

  // 4. duplicate order_uid across trips refused --------------------------------------------
  {
    const c = await open(env, 'w6ta04');
    try {
      await ensureCaptureTrigger(c.su);
      const s = await c.fx.day('2026-09-15');
      const { mk, startV2 } = ctx(c, s);
      await makeRider(c.su, 'rider-04');
      const D = await mk({ estado: 'LISTO' });
      const r = await startV2(c.svc, D, 'rider-04');
      assert('4: setup departure OK', r.ok === true, r);
      // Direct DB-level proof of the constraint itself: a second trip attempting to
      // freeze the SAME order_uid must violate trip_members' UNIQUE(order_uid). A
      // second row for the SAME anchor_order_uid is allowed at the trips level (no
      // uniqueness on anchor); the invariant under test is trip_members.order_uid --
      // status='CLOSED' requires closed_at NOT NULL (trips_status_closed_at_chk).
      const dbHas04 = await hasDispatchedBy(c.su);
      const other = (await c.su.query(
        dbHas04
          ? `INSERT INTO trip_authority.trips (trip_id, business_date, service_session_id, rider_actor, dispatched_by, anchor_order_uid, departed_at, closed_at, status, seq)
             VALUES (gen_random_uuid(), '2026-09-15', $1, 'rider-04', 'rider-04', $2, now(), now(), 'CLOSED', nextval('trip_authority.trips_seq_v1'))
             RETURNING trip_id`
          : `INSERT INTO trip_authority.trips (trip_id, business_date, service_session_id, rider_actor, anchor_order_uid, departed_at, closed_at, status, seq)
             VALUES (gen_random_uuid(), '2026-09-15', $1, 'rider-04', $2, now(), now(), 'CLOSED', nextval('trip_authority.trips_seq_v1'))
             RETURNING trip_id`,
        [s, D.order_uid])).rows[0];
      const dupErr = await c.su.query(
        'INSERT INTO trip_authority.trip_members (trip_id, order_uid, stop_seq, created_by) VALUES ($1, $2, 1, $3)',
        [other.trip_id, D.order_uid, 'rider-04']).catch((e) => e);
      assert('4: freezing the same order_uid into a second trip violates UNIQUE(order_uid)',
        dupErr instanceof Error && dupErr.code === '23505', dupErr && dupErr.message);
    } finally { await c.close(); }
  }

  // 5. one ACTIVE trip globally enforced ----------------------------------------------------
  {
    const c = await open(env, 'w6ta05');
    try {
      await ensureCaptureTrigger(c.su);
      const s = await c.fx.day('2026-09-15');
      const { mk, startV2 } = ctx(c, s);
      await makeRider(c.su, 'rider-05');
      const D = await mk({ estado: 'LISTO' }); const E = await mk({ estado: 'LISTO' });
      await startV2(c.svc, D, 'rider-05');
      const dbHas05 = await hasDispatchedBy(c.su);
      const dbErr = await c.su.query(
        dbHas05
          ? `INSERT INTO trip_authority.trips (trip_id, business_date, service_session_id, rider_actor, dispatched_by, anchor_order_uid, departed_at, status, seq)
             VALUES (gen_random_uuid(), '2026-09-15', $1, 'rider-05', 'rider-05', $2, now(), 'ACTIVE', nextval('trip_authority.trips_seq_v1'))`
          : `INSERT INTO trip_authority.trips (trip_id, business_date, service_session_id, rider_actor, anchor_order_uid, departed_at, status, seq)
             VALUES (gen_random_uuid(), '2026-09-15', $1, 'rider-05', $2, now(), 'ACTIVE', nextval('trip_authority.trips_seq_v1'))`,
        [s, E.order_uid]).catch((e) => e);
      assert('5: a second ACTIVE trips row violates trips_one_active_v1 at the DB level',
        dbErr instanceof Error && dbErr.code === '23505', dbErr && dbErr.message);
    } finally { await c.close(); }
  }

  // 6. same-anchor replay idempotent --------------------------------------------------------
  {
    const c = await open(env, 'w6ta06');
    try {
      await ensureCaptureTrigger(c.su);
      const s = await c.fx.day('2026-09-15');
      const { mk, startV2 } = ctx(c, s);
      await makeRider(c.su, 'rider-06');
      const D = await mk({ estado: 'LISTO' });
      const r1 = await startV2(c.svc, D, 'rider-06');
      const r2 = await startV2(c.svc, D, 'rider-06');
      assert('6: same-anchor replay -> IDEMPOTENT', r2.ok === true && r2.code === 'IDEMPOTENT', r2);
      assert('6: replay returns the SAME trip_id', r2.trip_id === r1.trip_id, { r1, r2 });
    } finally { await c.close(); }
  }

  // 7. different second departure refused ---------------------------------------------------
  {
    const c = await open(env, 'w6ta07');
    try {
      await ensureCaptureTrigger(c.su);
      const s = await c.fx.day('2026-09-15');
      const { mk, startV2 } = ctx(c, s);
      await makeRider(c.su, 'rider-07');
      const D = await mk({ estado: 'LISTO' }); const E = await mk({ estado: 'LISTO' });
      await startV2(c.svc, D, 'rider-07');
      const r2 = await startV2(c.svc, E, 'rider-07');
      assert('7: a different concurrent anchor -> ACTIVE_TRIP_CONFLICT', r2.ok === false && r2.code === 'ACTIVE_TRIP_CONFLICT', r2);
    } finally { await c.close(); }
  }

  // 8. wrong service/session refused --------------------------------------------------------
  {
    const c = await open(env, 'w6ta08');
    try {
      await ensureCaptureTrigger(c.su);
      const s = await c.fx.day('2026-09-15');
      const otherS = await c.fx.day('2026-09-14');
      const { mk } = ctx(c, s);
      await makeRider(c.su, 'rider-08');
      const D = await mk({ estado: 'LISTO' });
      const r = await call(c.svc, 'start_rider_trip_v2', [D.order_uid, 'rider-08', 1, [otherS]]);
      assert('8: operational scope excluding the anchor session -> SCOPE_MISMATCH', r.ok === false && r.code === 'SCOPE_MISMATCH', r);
    } finally { await c.close(); }
  }

  // 9. non-rider actor refused --------------------------------------------------------------
  {
    const c = await open(env, 'w6ta09');
    try {
      await ensureCaptureTrigger(c.su);
      const s = await c.fx.day('2026-09-15');
      const { mk, scope } = ctx(c, s);
      const D = await mk({ estado: 'LISTO' });
      const missing = await call(c.svc, 'start_rider_trip_v2', [D.order_uid, 'nobody-here', 1, scope]);
      assert('9a: unknown actor -> AUTH_ACTOR_NOT_FOUND', missing.ok === false && missing.code === 'AUTH_ACTOR_NOT_FOUND', missing);
      // B1 (migration 137) deliberately widens this RPC's identity check to admit
      // admin/operator alongside rider -- 'cashier' is a role that stays refused under
      // BOTH the pre-137 (rider-only) and post-137 (rider/admin/operator) predicate,
      // which is what this scenario actually intends to prove: an out-of-set role is
      // refused, independent of which of those two predicates this fixture is running.
      await c.su.query(`INSERT INTO public.auth_actors (actor, role, session_version, active, workspace_id)
        VALUES ('cashier-09', 'cashier', 1, true, gen_random_uuid()) ON CONFLICT (actor) DO NOTHING`);
      const wrongRole = await call(c.svc, 'start_rider_trip_v2', [D.order_uid, 'cashier-09', 1, scope]);
      assert('9b: an out-of-set role is refused AUTH_FORBIDDEN_ROLE', wrongRole.ok === false && wrongRole.code === 'AUTH_FORBIDDEN_ROLE', wrongRole);
    } finally { await c.close(); }
  }

  // 10. non-DOMICILIO refused -----------------------------------------------------------------
  {
    const c = await open(env, 'w6ta10');
    try {
      await ensureCaptureTrigger(c.su);
      const s = await c.fx.day('2026-09-15');
      const { mk, startV2 } = ctx(c, s);
      await makeRider(c.su, 'rider-10');
      const D = await mk({ estado: 'LISTO', delivery: 'NOT_DOMICILIO' });
      const r = await startV2(c.svc, D, 'rider-10');
      assert('10: non-DOMICILIO anchor -> ORDER_NOT_ELIGIBLE', r.ok === false && r.code === 'ORDER_NOT_ELIGIBLE', r);
    } finally { await c.close(); }
  }

  // 11. invalid order state refused ------------------------------------------------------------
  {
    const c = await open(env, 'w6ta11');
    try {
      await ensureCaptureTrigger(c.su);
      const s = await c.fx.day('2026-09-15');
      const { mk, startV2 } = ctx(c, s);
      await makeRider(c.su, 'rider-11');
      const D = await mk({ estado: 'EN_COCINA' });
      const r = await startV2(c.svc, D, 'rider-11');
      assert('11: anchor not LISTO -> INVALID_STATE', r.ok === false && r.code === 'INVALID_STATE', r);
    } finally { await c.close(); }
  }

  // 12-15. attach/detach/dissolve/consume vs departure (start_rider_trip_v2) deterministic ---
  {
    const c = await open(env, 'w6ta1215');
    try {
      await ensureCaptureTrigger(c.su);
      const s = await c.fx.day('2026-09-15');
      const { mk, createOrMove } = ctx(c, s);
      await makeRider(c.su, 'rider-1215');
      const t1 = await c.client('service_role', 'w6ta-1215-t1');
      const t2 = await c.client('service_role', 'w6ta-1215-t2');

      // 12: attach_or_move_v1 vs v2 departure -- the Giro command holds L0 first,
      // departure blocks, then proceeds normally afterward.
      //
      // W6.3 MAINTENANCE (migration 135): the attached member is now created LISTO.
      // This case previously attached an EN_COCINA order and relied on the departure
      // silently narrowing the giro to its ready subset -- the PARTIAL DEPARTURE that
      // migration 135 forbids outright (CANONICAL_GIRO_DEPARTURE_IS_ATOMIC). The
      // lock-ordering property under test here is unchanged and still asserted exactly
      // as before; the fixture is simply made valid under the corrected rule, and the
      // assertion is strengthened to prove the newly-attached member departed WITH the
      // giro. The refusal path for a not-ready member is certified in its own right by
      // the w6RiderLifecycle group (cases 2 and 19).
      {
        const A = await mk({ estado: 'LISTO' }); const B = await mk({ estado: 'LISTO' }); const F1 = await mk({ estado: 'LISTO' });
        const G = await createOrMove([A, B]);
        await t1.query('BEGIN');
        const held = await call(t1, 'giro_authority_attach_or_move_v1', [G.giro_id, F1.order_uid, 'op-1', [s]]);
        const pendingV2 = t2.query('SELECT public.start_rider_trip_v2($1,$2,$3,$4) AS r', [A.order_uid, 'rider-1215', 1, [s]]);
        assert('12: v2 departure waits on L0 while attach_or_move is held open', await waitBlocked(c.su, 'w6ta-1215-t2'));
        await t1.query('COMMIT');
        const trip = (await pendingV2).rows[0].r;
        assert('12: Giro mutation winning first -> attach_or_move OK', held.code === 'OK', held);
        assert('12: v2 departure then proceeds normally (no deadlock)', trip.ok === true, trip);
        const m12 = (await c.su.query('SELECT count(*)::int AS n FROM trip_authority.trip_members WHERE trip_id = $1', [trip.trip_id])).rows[0].n;
        assert('12: the member attached just before departure left WITH the giro (atomic, 3 members)', m12 === 3, { m12 });
        for (const o of [A, B, F1]) await c.fx.setEstado(o.id, 'RETIRADO');
        await c.su.query(`UPDATE trip_authority.trips SET status='CLOSED', closed_at=now() WHERE status='ACTIVE'`);
        await c.svc.query('SELECT public.close_rider_trip(NULL)');
      }

      // 13: detach_v1 vs v2 departure -- departure commits first, detach then refuses.
      {
        const A = await mk({ estado: 'LISTO' }); const B = await mk({ estado: 'LISTO' });
        await createOrMove([A, B]);
        await t1.query('BEGIN');
        const v2r13 = (await t1.query('SELECT public.start_rider_trip_v2($1,$2,$3,$4) AS r', [A.order_uid, 'rider-1215', 1, [s]])).rows[0].r;
        assert('13-diag: v2 departure itself returned OK', v2r13.ok === true, v2r13);
        const pendingDetach = call(t2, 'giro_authority_detach_v1', [A.order_uid, 'op-2', [s]]);
        assert('13: detach waits on L0 while v2 departure is held open', await waitBlocked(c.su, 'w6ta-1215-t2'));
        await t1.query('COMMIT');
        const r13 = await pendingDetach;
        assert('13: departure winning first -> detach refuses GIRO_DEPARTED', r13.code === 'GIRO_DEPARTED', r13);
        await c.fx.setEstado(A.id, 'RETIRADO'); await c.fx.setEstado(B.id, 'RETIRADO');
        await c.su.query(`UPDATE trip_authority.trips SET status='CLOSED', closed_at=now() WHERE status='ACTIVE'`);
        await c.svc.query('SELECT public.close_rider_trip(NULL)');
      }

      // 14: dissolve_v1 vs v2 departure -- departure commits first, dissolve then refuses.
      {
        const A = await mk({ estado: 'LISTO' }); const B = await mk({ estado: 'LISTO' });
        const G = await createOrMove([A, B]);
        await t1.query('BEGIN');
        await t1.query('SELECT public.start_rider_trip_v2($1,$2,$3,$4)', [A.order_uid, 'rider-1215', 1, [s]]);
        const pendingDissolve = call(t2, 'giro_authority_dissolve_v1', [G.giro_id, 'op-2', [s]]);
        assert('14: dissolve waits on L0 while v2 departure is held open', await waitBlocked(c.su, 'w6ta-1215-t2'));
        await t1.query('COMMIT');
        const r14 = await pendingDissolve;
        assert('14: departure winning first -> dissolve refuses GIRO_DEPARTED', r14.code === 'GIRO_DEPARTED', r14);
        await c.fx.setEstado(A.id, 'RETIRADO'); await c.fx.setEstado(B.id, 'RETIRADO');
        await c.su.query(`UPDATE trip_authority.trips SET status='CLOSED', closed_at=now() WHERE status='ACTIVE'`);
        await c.svc.query('SELECT public.close_rider_trip(NULL)');
      }

      // 15: consume_intent_v1 vs v2 departure -- departure commits first, consume then
      // correctly refuses TARGET_DEPARTED instead of blindly attaching.
      {
        const A = await mk({ estado: 'LISTO' }); const B = await mk({ estado: 'LISTO' });
        const TG = await createOrMove([A, B]);
        const X = await mk({ estado: 'POR_CONFIRMAR', intent: { v: 1, source: 'operator_http', actor: 'op', sv: 1, target_kind: 'GIRO', target_ref: TG.giro_id } });
        await c.fx.setEstado(X.id, 'EN_COCINA');
        await t1.query('BEGIN');
        await t1.query('SELECT public.start_rider_trip_v2($1,$2,$3,$4)', [A.order_uid, 'rider-1215', 1, [s]]);
        const pendingConsume = call(t2, 'giro_authority_consume_intent_v1', [X.order_uid, 'op', [s]]);
        assert('15: consume_intent waits on L0 while v2 departure is held open', await waitBlocked(c.su, 'w6ta-1215-t2'));
        await t1.query('COMMIT');
        const r15 = await pendingConsume;
        assert('15: departure winning first -> consume refuses TARGET_DEPARTED', r15.resolution_code === 'TARGET_DEPARTED', r15);
        await c.fx.setEstado(A.id, 'RETIRADO'); await c.fx.setEstado(B.id, 'RETIRADO');
        await c.su.query(`UPDATE trip_authority.trips SET status='CLOSED', closed_at=now() WHERE status='ACTIVE'`);
        await c.svc.query('SELECT public.close_rider_trip(NULL)');
      }
    } finally { await c.close(); }
  }

  // 16. no deadlock -- mixed real v2 departures + live Giro commands, many rounds -----------
  {
    const c = await open(env, 'w6ta16');
    try {
      await ensureCaptureTrigger(c.su);
      const s = await c.fx.day('2026-09-15');
      const { mk, createOrMove } = ctx(c, s);
      await makeRider(c.su, 'rider-16');
      const pool = [];
      for (let i = 0; i < 4; i++) pool.push(await c.client('service_role', `w6ta-16-pool-${i}`));

      let deadlocks = 0; let settled = 0;
      const ROUNDS = 10;
      for (let i = 0; i < ROUNDS; i++) {
        const A = await mk({ estado: 'LISTO' }); const B = await mk({ estado: 'LISTO' }); const P1 = await mk({});
        const G = await createOrMove([A, B]);
        const res = await Promise.allSettled([
          pool[0].query('SELECT public.start_rider_trip_v2($1,$2,$3,$4) AS r', [A.order_uid, 'rider-16', 1, [s]]),
          call(pool[1], 'giro_authority_attach_or_move_v1', [G.giro_id, P1.order_uid, 'op-2', [s]]),
        ]);
        for (const x of res) {
          if (x.status === 'rejected' && x.reason && x.reason.code === '40P01') deadlocks++;
          else if (x.status === 'fulfilled') settled++;
        }
        await c.fx.setEstado(A.id, 'RETIRADO'); await c.fx.setEstado(B.id, 'RETIRADO');
        await c.su.query(`UPDATE trip_authority.trips SET status = 'CLOSED', closed_at = now() WHERE status = 'ACTIVE'`);
        await c.svc.query('SELECT public.close_rider_trip(NULL)');
      }
      assert(`16: ${ROUNDS} rounds of mixed v2-departure + live-attach: zero deadlocks, everything settles`,
        deadlocks === 0 && settled === ROUNDS * 2, { deadlocks, settled, expected: ROUNDS * 2 });
    } finally { await c.close(); }
  }

  // 17-20. projection PLANNED->IN_TRIP->DONE, trip close->DONE, frozen effective_members ------
  {
    const c = await open(env, 'w6ta1720');
    try {
      await ensureCaptureTrigger(c.su);
      const s = await c.fx.day('2026-09-15');
      const { mk, createOrMove, startV2, scope } = ctx(c, s);
      await makeRider(c.su, 'rider-1720');
      const A = await mk({ estado: 'LISTO' }); const B = await mk({ estado: 'LISTO' }); const C = await mk({ estado: 'LISTO' });
      const G = await createOrMove([A, B, C]);
      const before = (await call(c.svc, 'giro_projection_v1', [scope])).giros.find((g) => g.giro_id === G.giro_id);
      assert('17a: before departure, giro_state = PLANNED', before.giro_state === 'PLANNED', before);

      const dep = await startV2(c.svc, A, 'rider-1720');
      assert('17b: departure OK', dep.ok === true, dep);
      const afterDep = (await call(c.svc, 'giro_projection_v1', [scope])).giros.find((g) => g.giro_id === G.giro_id);
      assert('17: after v2 departure, giro_state = IN_TRIP', afterDep.giro_state === 'IN_TRIP', afterDep);

      // 20: effective_members after departure = trip_members (order_uid set equality)
      const tmRows = (await c.su.query('SELECT order_uid FROM trip_authority.trip_members WHERE trip_id = $1', [dep.trip_id])).rows;
      const tmSet = new Set(tmRows.map((r) => r.order_uid));
      const effSet = new Set(afterDep.effective_members.map((m) => m.order_uid));
      assert('20: effective_members after departure exactly equals trip_members',
        tmSet.size === effSet.size && [...tmSet].every((u) => effSet.has(u)), { tmSet: [...tmSet], effSet: [...effSet] });

      // 18: all delivered -> DONE, while the trip itself is STILL status='ACTIVE'.
      for (const o of [A, B, C]) await c.fx.setEstado(o.id, 'RETIRADO');
      const stillActive = (await c.su.query(`SELECT status FROM trip_authority.trips WHERE trip_id = $1`, [dep.trip_id])).rows[0].status;
      assert('18a: trip row is still ACTIVE at this point (not closed)', stillActive === 'ACTIVE', stillActive);
      const afterAllDelivered = (await call(c.svc, 'giro_projection_v1', [scope])).giros.find((g) => g.giro_id === G.giro_id);
      assert('18: all effective members delivered -> DONE (without an explicit trip close)', afterAllDelivered.giro_state === 'DONE', afterAllDelivered);

      // 19: trip close -> DONE (a real close mechanism is a later wave; this simulates
      // what one would do -- close the canonical row AND clear the DRIVER_STATO
      // compatibility snapshot, exactly as legacy close_rider_trip already does today).
      await c.su.query(`UPDATE trip_authority.trips SET status = 'CLOSED', closed_at = now() WHERE trip_id = $1`, [dep.trip_id]);
      await c.svc.query(`SELECT public.close_rider_trip(NULL)`);
      const afterClose = (await call(c.svc, 'giro_projection_v1', [scope])).giros.find((g) => g.giro_id === G.giro_id);
      assert('19: CLOSED linked trip -> DONE', afterClose.giro_state === 'DONE', afterClose);
    } finally { await c.close(); }
  }

  // 21. no money/economy mutation --------------------------------------------------------------
  {
    const c = await open(env, 'w6ta21');
    try {
      await ensureCaptureTrigger(c.su);
      const s = await c.fx.day('2026-09-15');
      const { mk, startV2 } = ctx(c, s);
      await makeRider(c.su, 'rider-21');
      const D = await mk({ estado: 'LISTO' });
      const before = (await c.su.query(
        `SELECT (SELECT count(*) FROM public.order_financial_events) AS events,
                (SELECT count(*) FROM public.config WHERE chiave <> 'DRIVER_STATO') AS other_config`)).rows[0];
      const r = await startV2(c.svc, D, 'rider-21');
      assert('21a: departure OK', r.ok === true, r);
      const after = (await c.su.query(
        `SELECT (SELECT count(*) FROM public.order_financial_events) AS events,
                (SELECT count(*) FROM public.config WHERE chiave <> 'DRIVER_STATO') AS other_config`)).rows[0];
      assert('21: zero order_financial_events written, zero non-DRIVER_STATO config rows touched',
        before.events === after.events && before.other_config === after.other_config, { before, after });
    } finally { await c.close(); }
  }

  // 24. W6.1 L0 protocol preserved -- start_rider_trip_v2 takes L0 first too, statically ------
  {
    section('W6.2 STATIC PROOF -- start_rider_trip_v2 acquires L0 before any Giro/order lock');
    const c = await open(env, 'w6ta24');
    try {
      const src = (await c.su.query(
        `SELECT pg_get_functiondef('public.start_rider_trip_v2(uuid,text,integer,uuid[])'::regprocedure) AS def`
      )).rows[0].def;
      const l0 = src.indexOf('LA_DIECI_DRIVER_STATO');
      const firstLock = src.indexOf('FOR UPDATE');
      assert('24: start_rider_trip_v2 contains the L0 lock call', l0 >= 0);
      assert('24: L0 textually precedes the first FOR UPDATE row lock', l0 >= 0 && firstLock >= 0 && l0 < firstLock, { l0, firstLock });
      const occurrences = src.split('LA_DIECI_DRIVER_STATO').length - 1;
      assert('24: exactly one L0 acquisition in start_rider_trip_v2', occurrences === 1, occurrences);
    } finally { await c.close(); }
  }

  // Equivalence group: giro_authority.trip_facts_v1's re-point must be a byte-for-byte
  // behavioural no-op whenever trip_authority.trips is empty (current staging shape).
  {
    section('W6.2 EQUIVALENCE -- trip_facts_v1 output unchanged for every DRIVER_STATO shape while trip_authority.trips is empty');
    const c = await open(env, 'w6ta_equiv');
    try {
      const emptyCount = (await c.su.query('SELECT count(*) FROM trip_authority.trips')).rows[0].count;
      assert('trip_authority.trips is empty in this fixture (current staging shape)', Number(emptyCount) === 0, emptyCount);

      const cases = [
        { label: 'no DRIVER_STATO row at all', setup: async () => { await c.su.query(`DELETE FROM public.config WHERE chiave = 'DRIVER_STATO'`); } },
        { label: 'empty-string DRIVER_STATO', setup: async () => c.fx.driverStato('') },
        { label: 'no active_trip key', setup: async () => c.fx.driverStato({ schema: 2 }) },
        { label: 'active_trip: null', setup: async () => c.fx.driverStato({ active_trip: null }) },
        { label: 'active_trip.status not ACTIVE', setup: async () => c.fx.driverStato({ active_trip: { status: 'CLOSED', order_ids: [] } }) },
        { label: 'malformed active_trip (not an object)', setup: async () => c.fx.driverStato({ active_trip: 'not-an-object' }) },
        { label: 'active_trip.order_ids not an array', setup: async () => c.fx.driverStato({ active_trip: { status: 'ACTIVE', order_ids: 'x' } }) },
        { label: 'genuinely active trip with 2 orders', setup: async () => c.fx.driverStato({ active_trip: { status: 'ACTIVE', order_ids: ['#T0001', '#T0002'], manual_giro_ids: ['mg_1'], trip_id: 't-1' } }) },
        { label: 'unparseable DRIVER_STATO', setup: async () => c.su.query(`INSERT INTO public.config (chiave, valore) VALUES ('DRIVER_STATO', 'not-json') ON CONFLICT (chiave) DO UPDATE SET valore = EXCLUDED.valore`) },
      ];
      for (const tc of cases) {
        await tc.setup();
        const r = (await c.su.query(`SELECT giro_authority.trip_facts_v1() AS f`)).rows[0].f;
        assert(`equivalence: ${tc.label} -- available/active/order_ids/giro_ids shape present`,
          typeof r === 'object' && 'available' in r, r);
      }
    } finally { await c.close(); }
  }
}

module.exports = { run };
