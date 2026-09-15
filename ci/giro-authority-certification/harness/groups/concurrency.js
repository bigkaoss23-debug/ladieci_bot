'use strict';
// N06 and the TB-1 section C races, with REAL concurrent transactions. Interleavings
// are forced by holding a transaction open and proving (pg_stat_activity) that the
// other side is waiting on a lock, so each ordering is deterministic.
const { section, assert, call } = require('../lib');
const { open, ensureCaptureTrigger } = require('./_ctx');

const W4_CONTRACT_FIXTURE = `
CREATE SCHEMA fixture_w4;
-- Test-only stand-in for W4's start_rider_trip lock order (TB-1A amendment 7): the giro
-- row FIRST, then the dispatch lock, members from the ONE derivation. Not product code.
CREATE FUNCTION fixture_w4.start_trip_contract_v1(p_giro_id text, p_scope uuid[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
DECLARE d record; v_ids text[];
BEGIN
  PERFORM 1 FROM public.manual_giros WHERE id = p_giro_id FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtext('LA_DIECI_DRIVER_STATO'));
  SELECT * INTO d FROM giro_authority.derive_giros_v1(ARRAY[p_giro_id], p_scope, giro_authority.trip_facts_v1());
  IF d.giro_state <> 'PLANNED' THEN RETURN jsonb_build_object('ok', false, 'code', d.giro_state); END IF;
  SELECT array_agg(o.id ORDER BY o.id) INTO v_ids FROM public.ordenes o
   WHERE o.order_uid = ANY (d.effective_order_uids) AND o.estado = 'LISTO';
  UPDATE public.ordenes SET estado = 'EN_ENTREGA' WHERE id = ANY (v_ids);
  INSERT INTO public.config (chiave, valore)
  VALUES ('DRIVER_STATO', jsonb_build_object('active_trip', jsonb_build_object('status', 'ACTIVE',
          'order_ids', to_jsonb(v_ids), 'manual_giro_ids', jsonb_build_array(p_giro_id)))::text)
  ON CONFLICT (chiave) DO UPDATE SET valore = EXCLUDED.valore;
  RETURN jsonb_build_object('ok', true, 'order_ids', to_jsonb(v_ids));
END $f$;`;

async function waitBlocked(su, app, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await su.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'", [app]);
    if (r.rows[0].n > 0) return true;
    await new Promise((res) => setTimeout(res, 25));
  }
  return false;
}

async function invariantN06(c, scope) {
  const p = await call(c.svc, 'giro_projection_v1', [scope]);
  const raw = (await c.su.query("SELECT valore FROM public.config WHERE chiave = 'DRIVER_STATO'")).rows[0];
  const ds = raw && raw.valore ? JSON.parse(raw.valore) : {};
  const snap = new Set(ds.active_trip && ds.active_trip.status === 'ACTIVE' ? ds.active_trip.order_ids : []);
  const est = new Map((await c.su.query('SELECT id, estado FROM public.ordenes')).rows.map((r) => [r.id, r.estado]));
  const done = new Set(['RETIRADO', 'COMPLETADO']);
  return p.giros.filter((g) => g.giro_state === 'IN_TRIP')
    .every((g) => g.effective_members.every((m) => snap.has(m.order_id) || done.has(est.get(m.order_id))));
}

async function run(env) {
  section('CONCURRENCY — N06 attach vs departure (both orders), TB-1 section C races, no deadlock');
  const c = await open(env, 'concurrency');
  try {
    await ensureCaptureTrigger(c.su);
    await c.su.query(W4_CONTRACT_FIXTURE);
    await c.su.query('GRANT USAGE ON SCHEMA fixture_w4 TO service_role; GRANT EXECUTE ON FUNCTION fixture_w4.start_trip_contract_v1(text, uuid[]) TO service_role');
    const s = await c.fx.day('2026-09-14');
    const scope = [s];
    const mk = (o) => c.fx.order(c.svc, { session: s, ...o });
    const create = async (orders) =>
      (await call(c.svc, 'giro_authority_create_v1', [orders.map((o) => o.order_uid), null, null, 'op-1', scope])).giro_id;
    const t1 = await c.client('service_role', 'w3-t1');
    const t2 = await c.client('service_role', 'w3-t2');

    // N06a — the UNCHANGED real start_rider_trip (W3 world), attach held open first.
    const A = await mk({ estado: 'LISTO' });
    const B = await mk({ estado: 'LISTO' });
    const C1 = await mk({});
    const G = await create([A, B]);
    await t1.query('BEGIN');
    const held = await call(t1, 'giro_authority_attach_v1', [G, C1.order_uid, 'op-1', scope]);
    const trip = (await t2.query('SELECT public.start_rider_trip($1) AS r', [A.id])).rows[0].r;
    await t1.query('COMMIT');
    assert('N06a: attach (held) and the real start_rider_trip both complete', held.code === 'OK' && trip.ok === true, { held, trip });
    assert('N06a: invariant — every IN_TRIP effective member is in the snapshot (or delivered)', await invariantN06(c, scope));
    await c.fx.setEstado(A.id, 'RETIRADO');
    await c.svc.query('SELECT public.close_rider_trip(NULL)');
    const D1 = await mk({ estado: 'LISTO' });
    const E1 = await mk({ estado: 'LISTO' });
    const F1 = await mk({});
    const G2 = await create([D1, E1]);
    await t2.query('SELECT public.start_rider_trip($1)', [D1.id]);
    const late = await call(t1, 'giro_authority_attach_v1', [G2, F1.order_uid, 'op-1', scope]);
    assert('N06a reverse: departure committed first -> attach refused GIRO_DEPARTED', late.code === 'GIRO_DEPARTED', late);
    assert('N06a reverse: invariant still holds', await invariantN06(c, scope));
    await c.fx.setEstado(D1.id, 'RETIRADO');
    await c.svc.query('SELECT public.close_rider_trip(NULL)');

    // N06b — the frozen W4 lock order (giro row first), both orders, forced interleaving.
    const H = await mk({ estado: 'LISTO' });
    const I = await mk({ estado: 'LISTO' });
    const J = await mk({});
    const G3 = await create([H, I]);
    await t1.query('BEGIN');
    await call(t1, 'giro_authority_attach_v1', [G3, J.order_uid, 'op-1', scope]);
    const pendingTrip = t2.query('SELECT fixture_w4.start_trip_contract_v1($1, $2) AS r', [G3, scope]);
    assert('N06b: W4-order departure waits on the giro row held by attach', await waitBlocked(c.su, 'w3-t2'));
    await t1.query('COMMIT');
    const tr3 = (await pendingTrip).rows[0].r;
    assert('N06b: departure then takes only LISTO members; J (EN_COCINA) is released', tr3.ok &&
      JSON.stringify([...tr3.order_ids].sort()) === JSON.stringify([H.id, I.id].sort()), tr3);
    assert('N06b: invariant holds after attach-then-departure', await invariantN06(c, scope));
    for (const o of [H, I]) await c.fx.setEstado(o.id, 'RETIRADO');
    await c.fx.driverStato({});
    const K = await mk({ estado: 'LISTO' });
    const L = await mk({ estado: 'LISTO' });
    const M = await mk({});
    const G4 = await create([K, L]);
    await t2.query('BEGIN');
    await t2.query('SELECT fixture_w4.start_trip_contract_v1($1, $2)', [G4, scope]);
    const pendingAttach = call(t1, 'giro_authority_attach_v1', [G4, M.order_uid, 'op-1', scope]);
    assert('N06b reverse: attach waits on the giro row held by the departure', await waitBlocked(c.su, 'w3-t1'));
    await t2.query('COMMIT');
    const at4 = await pendingAttach;
    assert('N06b reverse: attach after departure -> GIRO_DEPARTED (never a member outside the snapshot)', at4.code === 'GIRO_DEPARTED', at4);
    assert('N06b reverse: invariant holds', await invariantN06(c, scope));
    for (const o of [K, L]) await c.fx.setEstado(o.id, 'RETIRADO');
    await c.fx.driverStato({});

    // Same order attached to two giros: serialized on the order lock, no split.
    const P1 = await mk({}); const P2 = await mk({}); const P3 = await mk({}); const P4 = await mk({}); const O = await mk({});
    const GA = await create([P1, P2]);
    const GB = await create([P3, P4]);
    await t1.query('BEGIN');
    await call(t1, 'giro_authority_attach_v1', [GA, O.order_uid, 'op-1', scope]);
    const pendingB = call(t2, 'giro_authority_attach_v1', [GB, O.order_uid, 'op-2', scope]);
    assert('same order to two giros: the second waits on the order lock', await waitBlocked(c.su, 'w3-t2'));
    await t1.query('COMMIT');
    const rb = await pendingB;
    assert('same order to two giros: second -> ORDER_ALREADY_IN_GIRO (no split)', rb.code === 'ORDER_ALREADY_IN_GIRO' && rb.giro_id === GA, rb);

    // Different orders attached to the same giro at the same time: serialized, both land.
    const Pa = await mk({});
    const Pb = await mk({});
    const bothAttach = await Promise.all([
      call(t1, 'giro_authority_attach_v1', [GA, Pa.order_uid, 'op-1', scope]),
      call(t2, 'giro_authority_attach_v1', [GA, Pb.order_uid, 'op-2', scope])]);
    const gaNow = (await call(c.svc, 'giro_projection_v1', [scope])).giros.find((g) => g.giro_id === GA);
    assert('concurrent attach of two different orders to one giro: both OK, both effective',
      bothAttach.every((x) => x.code === 'OK') && [Pa, Pb].every((o) => gaNow.effective_members.some((m) => m.order_uid === o.order_uid)), bothAttach);

    // Dissolve vs attach on the same giro.
    const Q = await mk({});
    await t1.query('BEGIN');
    await call(t1, 'giro_authority_dissolve_v1', [GB, 'op-1', scope]);
    const pendingQ = call(t2, 'giro_authority_attach_v1', [GB, Q.order_uid, 'op-2', scope]);
    assert('dissolve held: attach waits on the giro row', await waitBlocked(c.su, 'w3-t2'));
    await t1.query('COMMIT');
    assert('dissolve then attach -> GIRO_NOT_PLANNED', (await pendingQ).code === 'GIRO_NOT_PLANNED');

    // Move vs attach, both orders forced: never an attach into a giro the move just
    // dissolved, never one order in two giros.
    const mx1 = await mk({}); const mx2 = await mk({}); const my1 = await mk({}); const my2 = await mk({}); const mP = await mk({});
    const GM1 = await create([mx1, mx2]);
    const GM2 = await create([my1, my2]);
    await t1.query('BEGIN');
    await call(t1, 'giro_authority_move_v1', [mx1.order_uid, GM2, 'op-1', scope]);
    const pendAttach = call(t2, 'giro_authority_attach_v1', [GM1, mP.order_uid, 'op-2', scope]);
    assert('move held: attach into the source giro waits on its row', await waitBlocked(c.su, 'w3-t2'));
    await t1.query('COMMIT');
    const ra = await pendAttach;
    assert('move-then-attach: the move left the source with one member, so attach -> GIRO_NOT_PLANNED', ra.code === 'GIRO_NOT_PLANNED', ra);

    const nx1 = await mk({}); const nx2 = await mk({}); const ny1 = await mk({}); const ny2 = await mk({}); const nP = await mk({});
    const GN1 = await create([nx1, nx2]);
    const GN2 = await create([ny1, ny2]);
    await t1.query('BEGIN');
    await call(t1, 'giro_authority_attach_v1', [GN1, nP.order_uid, 'op-1', scope]);
    const pendMove = call(t2, 'giro_authority_move_v1', [nx1.order_uid, GN2, 'op-2', scope]);
    assert('attach held: the move out of that giro waits on its row', await waitBlocked(c.su, 'w3-t2'));
    await t1.query('COMMIT');
    const rm = await pendMove;
    const gn1 = (await call(c.svc, 'giro_projection_v1', [scope])).giros.find((g) => g.giro_id === GN1);
    assert('attach-then-move: both OK and the source stays PLANNED {x2, P}', rm.code === 'OK' && gn1.giro_state === 'PLANNED' &&
      JSON.stringify(gn1.effective_members.map((m) => m.order_uid).sort()) === JSON.stringify([nx2.order_uid, nP.order_uid].sort()), { rm, gn1 });

    const oO = await mk({}); const oO2 = await mk({}); const oO3 = await mk({});
    const q1 = await mk({}); const q2 = await mk({}); const w1 = await mk({}); const w2 = await mk({});
    await create([oO, oO2, oO3]);
    const GO2 = await create([q1, q2]);
    const GO3 = await create([w1, w2]);
    await t1.query('BEGIN');
    await call(t1, 'giro_authority_move_v1', [oO.order_uid, GO2, 'op-1', scope]);
    const pendSame = call(t2, 'giro_authority_attach_v1', [GO3, oO.order_uid, 'op-2', scope]);
    assert('same order: move held, attach to a third giro waits on the order lock', await waitBlocked(c.su, 'w3-t2'));
    await t1.query('COMMIT');
    const rs = await pendSame;
    assert('same order move vs attach: attach -> ORDER_ALREADY_IN_GIRO (now in the move target), no split',
      rs.code === 'ORDER_ALREADY_IN_GIRO' && rs.giro_id === GO2, rs);

    // Parallel races without forced ordering (8 clients).
    const pool = [];
    for (let i = 0; i < 8; i++) pool.push(await c.client('service_role', `w3-pool-${i}`));
    const r1 = await mk({}); const r2 = await mk({}); const r3 = await mk({});
    const both = await Promise.all([
      call(pool[0], 'giro_authority_create_v1', [[r1.order_uid, r2.order_uid], null, null, 'op-1', scope]),
      call(pool[1], 'giro_authority_create_v1', [[r2.order_uid, r3.order_uid], null, null, 'op-2', scope])]);
    assert('two creates sharing an order: one OK, one ORDER_ALREADY_IN_GIRO',
      both.filter((x) => x.code === 'OK').length === 1 && both.filter((x) => x.code === 'ORDER_ALREADY_IN_GIRO').length === 1, both);

    const pairs = [];
    for (let i = 0; i < 6; i++) pairs.push([await mk({}), await mk({})]);
    const made = await Promise.all(pairs.map((pr, i) =>
      call(pool[i], 'giro_authority_create_v1', [pr.map((o) => o.order_uid), null, null, 'op-1', scope])));
    const ids = made.map((m) => m.giro_id);
    assert('6 parallel creates on one Business Day -> 6 distinct ids / seqs', made.every((m) => m.code === 'OK') && new Set(ids).size === 6, made);

    const tg = await create([await mk({}), await mk({})]);
    const cons = [];
    for (let i = 0; i < 2; i++) cons.push(await mk({ estado: 'POR_CONFIRMAR', intent: { v: 1, source: 'operator_http', actor: 'op', sv: 1, target_kind: 'GIRO', target_ref: tg } }));
    for (const o of cons) await c.fx.setEstado(o.id, 'EN_COCINA');
    const cr = await Promise.all(cons.map((o, i) => call(pool[i], 'giro_authority_consume_intent_v1', [o.order_uid, 'op', scope])));
    assert('two consumes into the same giro in parallel: one ATTACHED, one TARGET_CHANGED (TB-1 C)',
      cr.filter((x) => x.resolution_code === 'ATTACHED').length === 1 && cr.filter((x) => x.resolution_code === 'TARGET_CHANGED').length === 1, cr);

    const anchor = await mk({});
    const ac = [];
    for (let i = 0; i < 2; i++) ac.push(await mk({ estado: 'POR_CONFIRMAR', intent: { v: 1, source: 'operator_http', actor: 'op', sv: 1, target_kind: 'ANCHOR', target_ref: anchor.id } }));
    for (const o of ac) await c.fx.setEstado(o.id, 'EN_COCINA');
    const ar = await Promise.all(ac.map((o, i) => call(pool[i], 'giro_authority_consume_intent_v1', [o.order_uid, 'op', scope])));
    assert('two consumes on the same ANCHOR in parallel: one GIRO_CREATED, one TARGET_CHANGED',
      ar.filter((x) => x.resolution_code === 'GIRO_CREATED').length === 1 && ar.filter((x) => x.resolution_code === 'TARGET_CHANGED').length === 1, ar);

    // Cross moves, repeated: sorted giro locks => never a deadlock (40P01). Three members
    // each, so neither giro drops below two (a 2-member giro would correctly dissolve).
    let deadlocks = 0;
    let moved = 0;
    for (let i = 0; i < 10; i++) {
      const x1 = await mk({}); const x2 = await mk({}); const x3 = await mk({});
      const y1 = await mk({}); const y2 = await mk({}); const y3 = await mk({});
      const GX = await create([x1, x2, x3]);
      const GY = await create([y1, y2, y3]);
      const res = await Promise.allSettled([
        call(pool[0], 'giro_authority_move_v1', [x1.order_uid, GY, 'op-1', scope]),
        call(pool[1], 'giro_authority_move_v1', [y1.order_uid, GX, 'op-2', scope])]);
      for (const x of res) {
        if (x.status === 'rejected' && x.reason && x.reason.code === '40P01') deadlocks++;
        if (x.status === 'fulfilled' && x.value.code === 'OK') moved++;
      }
    }
    assert('10 rounds of crossed moves: zero deadlocks, all 20 moves OK', deadlocks === 0 && moved === 20, { deadlocks, moved });
  } finally {
    await c.close();
  }
}

module.exports = { run };
