'use strict';
// W6.1 LOCK-ORDER UNIFICATION certification. Proves the new L0 (pg_advisory_xact_lock(
// hashtext('LA_DIECI_DRIVER_STATO'))) acquisition in the five live Giro Authority
// commands genuinely serializes against the REAL public.start_rider_trip -- which
// already takes the same lock as its own first step -- closing the TOCTOU window
// migration 130's own header flagged ("The dispatch lock ... is never taken").
//
// Every departure scenario below calls the REAL start_rider_trip verbatim (installed
// by pgRuntime.buildFixtureDb's TRIP_SOURCES for every fixture db), not a stand-in --
// unlike concurrency.js's fixture_w4 fixture, which stands in for a DIFFERENT,
// never-built hypothetical W4 lock order (giro row first). This group tests the real
// production function, in both directions, against each of the five live commands
// that changed, plus a no-deadlock stress mix and a static source-text proof.
const { section, assert, call } = require('../lib');
const { open, ensureCaptureTrigger } = require('./_ctx');

// Lock-order-only stand-in for public.rider_collect_and_complete_stop: reproduces
// ONLY its real lock sequence (L0 first, then the DRIVER_STATO row, then the ordenes
// update) -- never its money path, which lives entirely outside giro_authority and is
// out of this migration's scope (see the migration's own "WHAT IT NEVER DOES"). The
// real function's own source is separately proven (below, statically) to already take
// L0 first and to never reference manual_giros, so this double only needs to prove
// that a transaction taking L0-then-ordenes genuinely cross-serializes with the five
// Giro commands -- exactly the same proof concurrency.js's fixture_w4 already
// established for a hypothetical start_rider_trip variant, applied here to the real
// rider-collect lock shape instead.
const RIDER_COLLECT_LOCK_DOUBLE = `
CREATE SCHEMA fixture_w6;
CREATE FUNCTION fixture_w6.rider_collect_contract_v1(p_order_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
DECLARE v_ds jsonb; v_active jsonb; v_updated int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('LA_DIECI_DRIVER_STATO'));
  SELECT COALESCE(NULLIF(valore,'')::jsonb, '{}'::jsonb) INTO v_ds
    FROM public.config WHERE chiave = 'DRIVER_STATO' FOR UPDATE;
  v_active := NULLIF(v_ds->'active_trip', 'null'::jsonb);
  IF v_active IS NULL OR (v_active->>'status') <> 'ACTIVE' OR NOT (v_active->'order_ids' ? p_order_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NON_MEMBER');
  END IF;
  UPDATE public.ordenes SET estado = 'RETIRADO' WHERE id = p_order_id AND estado = 'EN_ENTREGA';
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 0 THEN RETURN jsonb_build_object('ok', false, 'code', 'INVALID_STATE'); END IF;
  RETURN jsonb_build_object('ok', true, 'code', 'OK', 'order_id', p_order_id);
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

// Static proof: every one of the five live commands' own pg_get_functiondef() output
// carries exactly one L0 acquisition, textually before its first trip_facts_v1() call
// (which, by inspection, is always downstream of every L1/L2/L3/L4 acquisition in each
// of the five) -- an independent re-check of the same invariant the migration's own
// post-condition DO block already enforces at apply time.
async function staticProofL0First(c) {
  section('W6.1 STATIC PROOF -- all five live Giro commands acquire L0 before any Giro lock / trip-facts read');
  const targets = [
    ['giro_authority_create_or_move_v1', 'public.giro_authority_create_or_move_v1(uuid[],text,uuid,text,uuid[])'],
    ['giro_authority_attach_or_move_v1', 'public.giro_authority_attach_or_move_v1(text,uuid,text,uuid[])'],
    ['giro_authority_detach_v1', 'public.giro_authority_detach_v1(uuid,text,uuid[])'],
    ['giro_authority_dissolve_v1', 'public.giro_authority_dissolve_v1(text,text,uuid[])'],
    ['giro_authority_consume_intent_v1', 'public.giro_authority_consume_intent_v1(uuid,text,uuid[])'],
  ];
  for (const [name, sig] of targets) {
    const r = await c.su.query('SELECT pg_get_functiondef($1::regprocedure) AS def', [sig]);
    const src = r.rows[0].def;
    const l0 = src.indexOf("LA_DIECI_DRIVER_STATO");
    const trip = src.indexOf('trip_facts_v1(');
    assert(`${name}: source contains the L0 lock call`, l0 >= 0, { name });
    assert(`${name}: L0 textually precedes the first trip_facts_v1() call`, l0 >= 0 && trip >= 0 && l0 < trip, { name, l0, trip });
    const occurrences = src.split('LA_DIECI_DRIVER_STATO').length - 1;
    assert(`${name}: exactly one L0 acquisition (no duplicate)`, occurrences === 1, { name, occurrences });
  }

  // rider_collect_and_complete_stop / start_rider_trip: untouched by this migration,
  // independently re-verified to already satisfy the same shape (L0 first; the rider
  // contract never locks manual_giros at all, so it can never invert L1-before-L0).
  const rc = (await c.su.query(
    `SELECT pg_get_functiondef('public.rider_collect_and_complete_stop(text,text,text,integer,text,jsonb,text)'::regprocedure) AS def`
  )).rows[0].def;
  assert('rider_collect_and_complete_stop: already carries L0', rc.includes('LA_DIECI_DRIVER_STATO'));
  assert('rider_collect_and_complete_stop: never references manual_giros (no L1 inversion possible)', !rc.includes('manual_giros'));

  const st = (await c.su.query(
    `SELECT pg_get_functiondef('public.start_rider_trip(text)'::regprocedure) AS def`
  )).rows[0].def;
  const stL0 = st.indexOf('LA_DIECI_DRIVER_STATO');
  const stMg = st.indexOf('manual_giros');
  assert('start_rider_trip: already carries L0', stL0 >= 0);
  assert('start_rider_trip: any manual_giros reference is after L0 is already held (plain read, no lock)',
    stMg === -1 || stL0 < stMg, { stL0, stMg });
}

async function run(env) {
  {
    const c = await open(env, 'w6staticproof');
    try { await staticProofL0First(c); } finally { await c.close(); }
  }

  section('W6.1 DEPARTURE RACE -- attach_or_move_v1 vs the real start_rider_trip');
  {
    const c = await open(env, 'w6attach');
    try {
      await ensureCaptureTrigger(c.su);
      const s = await c.fx.day('2026-09-15');
      const scope = [s];
      const mk = (o) => c.fx.order(c.svc, { session: s, ...o });
      const createOrMove = async (orders) => call(c.svc, 'giro_authority_create_or_move_v1',
        [orders.map((o) => o.order_uid), null, null, 'op-1', scope]);
      const t1 = await c.client('service_role', 'w6-attach-t1');
      const t2 = await c.client('service_role', 'w6-attach-t2');

      // Direction 1: departure holds L0 first (real start_rider_trip, held open),
      // attach_or_move blocked, then unblocks and correctly sees GIRO_DEPARTED.
      const A = await mk({ estado: 'LISTO' });
      const B = await mk({ estado: 'LISTO' });
      const C1 = await mk({});
      const G1 = await createOrMove([A, B]);
      await t1.query('BEGIN');
      await t1.query('SELECT public.start_rider_trip($1)', [A.id]);
      const pendingAttach = call(t2, 'giro_authority_attach_or_move_v1',
        [G1.giro_id, C1.order_uid, 'op-2', scope]);
      assert('D1: attach_or_move waits on L0 while the real departure is held open', await waitBlocked(c.su, 'w6-attach-t2'));
      await t1.query('COMMIT');
      const r1 = await pendingAttach;
      assert('D1: departure winning first -> attach_or_move correctly refuses GIRO_DEPARTED', r1.code === 'GIRO_DEPARTED', r1);
      await c.fx.setEstado(A.id, 'RETIRADO');
      await c.svc.query('SELECT public.close_rider_trip(NULL)');

      // Direction 2: the Giro mutation holds L0 first, departure blocked, then
      // unblocks and completes normally afterward (never spuriously refused).
      const D = await mk({ estado: 'LISTO' });
      const E = await mk({ estado: 'LISTO' });
      const F1 = await mk({});
      const G2 = await createOrMove([D, E]);
      await t1.query('BEGIN');
      const held = await call(t1, 'giro_authority_attach_or_move_v1', [G2.giro_id, F1.order_uid, 'op-1', scope]);
      const pendingTrip = t2.query('SELECT public.start_rider_trip($1) AS r', [D.id]);
      assert('D2: the real start_rider_trip waits on L0 while attach_or_move is held open', await waitBlocked(c.su, 'w6-attach-t2'));
      await t1.query('COMMIT');
      const trip2 = (await pendingTrip).rows[0].r;
      assert('D2: Giro mutation winning first -> attach_or_move OK', held.code === 'OK', held);
      assert('D2: departure then proceeds normally (no deadlock, no spurious refusal)', trip2.ok === true, trip2);
      await c.fx.setEstado(D.id, 'RETIRADO');
      await c.svc.query('SELECT public.close_rider_trip(NULL)');
    } finally { await c.close(); }
  }

  section('W6.1 DEPARTURE RACE -- detach_v1 vs the real start_rider_trip');
  {
    const c = await open(env, 'w6detach');
    try {
      await ensureCaptureTrigger(c.su);
      const s = await c.fx.day('2026-09-15');
      const scope = [s];
      const mk = (o) => c.fx.order(c.svc, { session: s, ...o });
      const createOrMove = async (orders) => call(c.svc, 'giro_authority_create_or_move_v1',
        [orders.map((o) => o.order_uid), null, null, 'op-1', scope]);
      const t1 = await c.client('service_role', 'w6-detach-t1');
      const t2 = await c.client('service_role', 'w6-detach-t2');

      // Direction 1: departure commits first -> detach then correctly refuses.
      const A = await mk({ estado: 'LISTO' });
      const B = await mk({ estado: 'LISTO' });
      await createOrMove([A, B]);
      await t1.query('BEGIN');
      await t1.query('SELECT public.start_rider_trip($1)', [A.id]);
      const pendingDetach = call(t2, 'giro_authority_detach_v1', [A.order_uid, 'op-2', scope]);
      assert('D1: detach waits on L0 while the real departure is held open', await waitBlocked(c.su, 'w6-detach-t2'));
      await t1.query('COMMIT');
      const r1 = await pendingDetach;
      assert('D1: departure winning first -> detach correctly refuses GIRO_DEPARTED', r1.code === 'GIRO_DEPARTED', r1);
      await c.fx.setEstado(A.id, 'RETIRADO');
      await c.svc.query('SELECT public.close_rider_trip(NULL)');

      // Direction 2: detach commits first -> departure then proceeds normally.
      const D = await mk({ estado: 'LISTO' });
      const E = await mk({ estado: 'LISTO' });
      await createOrMove([D, E]);
      await t1.query('BEGIN');
      const held = await call(t1, 'giro_authority_detach_v1', [D.order_uid, 'op-1', scope]);
      const pendingTrip = t2.query('SELECT public.start_rider_trip($1) AS r', [D.id]);
      assert('D2: the real start_rider_trip waits on L0 while detach is held open', await waitBlocked(c.su, 'w6-detach-t2'));
      await t1.query('COMMIT');
      const trip2 = (await pendingTrip).rows[0].r;
      assert('D2: Giro mutation winning first -> detach OK', held.code === 'OK', held);
      assert('D2: departure then proceeds normally (no deadlock, no spurious refusal)', trip2.ok === true, trip2);
      await c.fx.setEstado(D.id, 'RETIRADO');
      await c.svc.query('SELECT public.close_rider_trip(NULL)');
    } finally { await c.close(); }
  }

  section('W6.1 DEPARTURE RACE -- dissolve_v1 vs the real start_rider_trip');
  {
    const c = await open(env, 'w6dissolve');
    try {
      await ensureCaptureTrigger(c.su);
      const s = await c.fx.day('2026-09-15');
      const scope = [s];
      const mk = (o) => c.fx.order(c.svc, { session: s, ...o });
      const createOrMove = async (orders) => call(c.svc, 'giro_authority_create_or_move_v1',
        [orders.map((o) => o.order_uid), null, null, 'op-1', scope]);
      const t1 = await c.client('service_role', 'w6-dissolve-t1');
      const t2 = await c.client('service_role', 'w6-dissolve-t2');

      // Direction 1: departure commits first -> dissolve then correctly refuses
      // GIRO_DEPARTED (a departed giro can no longer be explicitly dissolved).
      const A = await mk({ estado: 'LISTO' });
      const B = await mk({ estado: 'LISTO' });
      const G1 = await createOrMove([A, B]);
      await t1.query('BEGIN');
      await t1.query('SELECT public.start_rider_trip($1)', [A.id]);
      const pendingDissolve = call(t2, 'giro_authority_dissolve_v1', [G1.giro_id, 'op-2', scope]);
      assert('D1: dissolve waits on L0 while the real departure is held open', await waitBlocked(c.su, 'w6-dissolve-t2'));
      await t1.query('COMMIT');
      const r1 = await pendingDissolve;
      assert('D1: departure winning first -> dissolve correctly refuses GIRO_DEPARTED', r1.code === 'GIRO_DEPARTED', r1);
      await c.fx.setEstado(A.id, 'RETIRADO');
      await c.svc.query('SELECT public.close_rider_trip(NULL)');

      // Direction 2: dissolve commits first -> departure then proceeds normally
      // (the anchor order itself was never a member requirement for start_rider_trip).
      const D = await mk({ estado: 'LISTO' });
      const E = await mk({ estado: 'LISTO' });
      const G2 = await createOrMove([D, E]);
      await t1.query('BEGIN');
      const held = await call(t1, 'giro_authority_dissolve_v1', [G2.giro_id, 'op-1', scope]);
      const pendingTrip = t2.query('SELECT public.start_rider_trip($1) AS r', [D.id]);
      assert('D2: the real start_rider_trip waits on L0 while dissolve is held open', await waitBlocked(c.su, 'w6-dissolve-t2'));
      await t1.query('COMMIT');
      const trip2 = (await pendingTrip).rows[0].r;
      assert('D2: Giro mutation winning first -> dissolve OK', held.code === 'OK', held);
      assert('D2: departure then proceeds normally (no deadlock, no spurious refusal)', trip2.ok === true, trip2);
      await c.fx.setEstado(D.id, 'RETIRADO');
      await c.svc.query('SELECT public.close_rider_trip(NULL)');
    } finally { await c.close(); }
  }

  section('W6.1 DEPARTURE RACE -- consume_intent_v1 vs the real start_rider_trip');
  {
    const c = await open(env, 'w6consume');
    try {
      await ensureCaptureTrigger(c.su);
      const s = await c.fx.day('2026-09-15');
      const scope = [s];
      const mk = (o) => c.fx.order(c.svc, { session: s, ...o });
      const createOrMove = async (orders) => call(c.svc, 'giro_authority_create_or_move_v1',
        [orders.map((o) => o.order_uid), null, null, 'op-1', scope]);
      const t1 = await c.client('service_role', 'w6-consume-t1');
      const t2 = await c.client('service_role', 'w6-consume-t2');

      // Direction 1: the target giro departs first -> the pending consume then
      // correctly refuses TARGET_DEPARTED instead of blindly attaching.
      const A = await mk({ estado: 'LISTO' });
      const B = await mk({ estado: 'LISTO' });
      const TG1 = await createOrMove([A, B]);
      const X1 = await mk({ estado: 'POR_CONFIRMAR', intent: { v: 1, source: 'operator_http', actor: 'op', sv: 1, target_kind: 'GIRO', target_ref: TG1.giro_id } });
      await c.fx.setEstado(X1.id, 'EN_COCINA');
      await t1.query('BEGIN');
      await t1.query('SELECT public.start_rider_trip($1)', [A.id]);
      const pendingConsume = call(t2, 'giro_authority_consume_intent_v1', [X1.order_uid, 'op', scope]);
      assert('D1: consume_intent waits on L0 while the real departure is held open', await waitBlocked(c.su, 'w6-consume-t2'));
      await t1.query('COMMIT');
      const r1 = await pendingConsume;
      assert('D1: departure winning first -> consume correctly refuses TARGET_DEPARTED', r1.resolution_code === 'TARGET_DEPARTED', r1);
      await c.fx.setEstado(A.id, 'RETIRADO');
      await c.svc.query('SELECT public.close_rider_trip(NULL)');

      // Direction 2: the consume commits first (the giro was still PLANNED) ->
      // departure of an unrelated member then proceeds normally afterward.
      const D = await mk({ estado: 'LISTO' });
      const E = await mk({ estado: 'LISTO' });
      const TG2 = await createOrMove([D, E]);
      const X2 = await mk({ estado: 'POR_CONFIRMAR', intent: { v: 1, source: 'operator_http', actor: 'op', sv: 1, target_kind: 'GIRO', target_ref: TG2.giro_id } });
      await c.fx.setEstado(X2.id, 'EN_COCINA');
      await t1.query('BEGIN');
      const held = await call(t1, 'giro_authority_consume_intent_v1', [X2.order_uid, 'op', scope]);
      const pendingTrip = t2.query('SELECT public.start_rider_trip($1) AS r', [D.id]);
      assert('D2: the real start_rider_trip waits on L0 while consume_intent is held open', await waitBlocked(c.su, 'w6-consume-t2'));
      await t1.query('COMMIT');
      const trip2 = (await pendingTrip).rows[0].r;
      assert('D2: Giro mutation winning first -> consume ATTACHED', held.resolution_code === 'ATTACHED', held);
      assert('D2: departure then proceeds normally (no deadlock, no spurious refusal)', trip2.ok === true, trip2);
      await c.fx.setEstado(D.id, 'RETIRADO');
      await c.svc.query('SELECT public.close_rider_trip(NULL)');
    } finally { await c.close(); }
  }

  section('W6.1 RIDER-COLLECT LOCK ORDER -- fixture_w6 double (lock shape only) vs a live Giro command');
  {
    const c = await open(env, 'w6ridercollect');
    try {
      await ensureCaptureTrigger(c.su);
      await c.su.query(RIDER_COLLECT_LOCK_DOUBLE);
      await c.su.query('GRANT USAGE ON SCHEMA fixture_w6 TO service_role; GRANT EXECUTE ON FUNCTION fixture_w6.rider_collect_contract_v1(text) TO service_role');
      const s = await c.fx.day('2026-09-15');
      const scope = [s];
      const mk = (o) => c.fx.order(c.svc, { session: s, ...o });
      const createOrMove = async (orders) => call(c.svc, 'giro_authority_create_or_move_v1',
        [orders.map((o) => o.order_uid), null, null, 'op-1', scope]);
      const t1 = await c.client('service_role', 'w6-rc-t1');
      const t2 = await c.client('service_role', 'w6-rc-t2');

      // Direction 1: a real departure hands the order to EN_ENTREGA and stays open
      // (holding L0); the rider-collect double waits, then completes after commit.
      const A = await mk({ estado: 'LISTO' });
      const B = await mk({ estado: 'LISTO' });
      await createOrMove([A, B]);
      await t1.query('BEGIN');
      await t1.query('SELECT public.start_rider_trip($1)', [A.id]);
      const pendingCollect = c.svc.query('SELECT fixture_w6.rider_collect_contract_v1($1) AS r', [A.id]).then((r) => r.rows[0].r);
      assert('D1: rider-collect double waits on L0 while the real departure is held open', await waitBlocked(c.su, 'w3-svc-w6ridercollect'));
      await t1.query('COMMIT');
      const rc1 = await pendingCollect;
      assert('D1: rider-collect double completes correctly once the held departure commits', rc1.ok === true && rc1.code === 'OK', rc1);
      await c.svc.query('SELECT public.close_rider_trip(NULL)');

      // Direction 2: a live Giro command (detach) holds L0 first on an unrelated
      // giro; the rider-collect double (unrelated order) waits, then proceeds.
      const D = await mk({ estado: 'LISTO' });
      const E = await mk({ estado: 'LISTO' });
      await createOrMove([D, E]);
      await t2.query('SELECT public.start_rider_trip($1)', [D.id]);
      await t1.query('BEGIN');
      const held = await call(t1, 'giro_authority_detach_v1', [D.order_uid, 'op-1', scope]);
      const pendingCollect2 = c.svc.query('SELECT fixture_w6.rider_collect_contract_v1($1) AS r', [D.id]);
      assert('D2: rider-collect double waits on L0 while a live Giro command is held open', await waitBlocked(c.su, 'w3-svc-w6ridercollect'));
      await t1.query('COMMIT');
      const rc2 = (await pendingCollect2).rows[0].r;
      assert('D2: Giro command winning first -> detach OK (GIRO_DEPARTED already reflected, still succeeds as a no-op on an already-departed effective set or OK)',
        held.code === 'OK' || held.code === 'GIRO_DEPARTED', held);
      assert('D2: rider-collect double then proceeds normally (no deadlock)', rc2.ok === true, rc2);
      await c.svc.query('SELECT public.close_rider_trip(NULL)');
    } finally { await c.close(); }
  }

  section('W6.1 NO-DEADLOCK STRESS -- mixed real departures and live Giro commands, many rounds');
  {
    const c = await open(env, 'w6deadlock');
    try {
      await ensureCaptureTrigger(c.su);
      const s = await c.fx.day('2026-09-15');
      const scope = [s];
      const mk = (o) => c.fx.order(c.svc, { session: s, ...o });
      const createOrMove = async (orders) => call(c.svc, 'giro_authority_create_or_move_v1',
        [orders.map((o) => o.order_uid), null, null, 'op-1', scope]);
      const pool = [];
      for (let i = 0; i < 4; i++) pool.push(await c.client('service_role', `w6-dl-pool-${i}`));

      let deadlocks = 0;
      let settled = 0;
      const ROUNDS = 12;
      for (let i = 0; i < ROUNDS; i++) {
        const A = await mk({ estado: 'LISTO' });
        const B = await mk({ estado: 'LISTO' });
        const P1 = await mk({});
        const G = await createOrMove([A, B]);
        const res = await Promise.allSettled([
          pool[0].query('SELECT public.start_rider_trip($1) AS r', [A.id]),
          call(pool[1], 'giro_authority_attach_or_move_v1', [G.giro_id, P1.order_uid, 'op-2', scope]),
        ]);
        for (const x of res) {
          if (x.status === 'rejected' && x.reason && x.reason.code === '40P01') deadlocks++;
          else if (x.status === 'fulfilled') settled++;
        }
        await c.fx.setEstado(A.id, 'RETIRADO');
        await c.svc.query('SELECT public.close_rider_trip(NULL)');
      }
      assert(`${ROUNDS} rounds of mixed real-departure + live-attach: zero deadlocks, everything settles`,
        deadlocks === 0 && settled === ROUNDS * 2, { deadlocks, settled, expected: ROUNDS * 2 });
    } finally { await c.close(); }
  }
}

module.exports = { run };
