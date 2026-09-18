'use strict';
// W6.3 + W6.4 CANONICAL RIDER LIFECYCLE + GIRO PROJECTION CUTOVER certification.
// Exercises the migration-135 delta end to end on real PostgreSQL: atomic canonical
// giro departure, canonical-aware collect and close, the legacy in-flight fallback,
// frozen membership through every projection phase, real-departure salida, the
// post-departure Giro mutation guards (ACTIVE *and* CLOSED trips), the lock-order /
// deadlock properties of the activated path, and the money/economy boundary.
const { section, assert, call } = require('../lib');
const { open, ensureCaptureTrigger, hasDispatchedBy } = require('./_ctx');

const META = JSON.stringify({});

async function waitBlocked(su, app, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await su.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'", [app]);
    if (r.rows[0].n > 0) return true;
    await new Promise((res) => setTimeout(res, 25));
  }
  return false;
}

async function makeActor(su, actor, role = 'rider', sessionVersion = 1, active = true) {
  await su.query(`
    INSERT INTO public.auth_actors (actor, role, session_version, active, workspace_id)
    VALUES ($1, $2, $3, $4, gen_random_uuid())
    ON CONFLICT (actor) DO UPDATE SET session_version = EXCLUDED.session_version,
                                      active = EXCLUDED.active, role = EXCLUDED.role`,
    [actor, role, sessionVersion, active]);
}

function ctx(c, s) {
  const scope = [s];
  const mk = (o) => c.fx.order(c.svc, { session: s, ...o });
  const createOrMove = async (orders, horaRef = null) => call(c.svc, 'giro_authority_create_or_move_v1',
    [orders.map((o) => o.order_uid), horaRef, null, 'op-1', scope]);
  const startV2 = async (client, anchor, actor, sv = 1, sc = scope) =>
    call(client, 'start_rider_trip_v2', [anchor.order_uid, actor, sv, sc]);
  const collect = async (client, orderId, actor, { method = '', sv = 1, idem = null } = {}) =>
    call(client, 'rider_collect_and_complete_stop',
      [orderId, method, actor, sv, 'iphash', META, idem == null ? `idem-${orderId}` : idem]);
  const close = async (client = c.svc, trigger = null) => call(client, 'close_rider_trip', [trigger]);
  const projection = async () => call(c.svc, 'giro_projection_v1', [scope]);
  const giroOf = async (gid) => (await projection()).giros.find((g) => g.giro_id === gid);
  const counts = async () => (await c.su.query(`
    SELECT (SELECT count(*)::int FROM trip_authority.trips) AS trips,
           (SELECT count(*)::int FROM trip_authority.trips WHERE status='ACTIVE') AS active_trips,
           (SELECT count(*)::int FROM trip_authority.trip_members) AS members,
           (SELECT count(*)::int FROM public.order_financial_events) AS fin,
           (SELECT count(*)::int FROM public.order_obligations) AS obl,
           (SELECT count(*)::int FROM public.payment_transactions) AS pay`)).rows[0];
  const estado = async (id) => (await c.su.query('SELECT estado FROM public.ordenes WHERE id = $1', [id])).rows[0].estado;
  return { scope, mk, createOrMove, startV2, collect, close, projection, giroOf, counts, estado };
}

async function run(env) {
  // ── 1-2. ATOMIC CANONICAL GIRO DEPARTURE ────────────────────────────────────────────────
  section('W6.3 departure -- CANONICAL_GIRO_DEPARTURE_IS_ATOMIC');
  {
    const c = await open(env, 'w6rl01');
    try {
      await ensureCaptureTrigger(c.su);
      const s = await c.fx.day('2026-09-15');
      const { mk, createOrMove, startV2, counts, estado } = ctx(c, s);
      await makeActor(c.su, 'rider-01');
      const A = await mk({ estado: 'LISTO' }); const B = await mk({ estado: 'LISTO' }); const C = await mk({ estado: 'LISTO' });
      const G = await createOrMove([A, B, C]);
      const r = await startV2(c.svc, A, 'rider-01');
      assert('1: 3-member all-LISTO giro departs -> OK', r.ok === true && r.code === 'OK', r);
      assert('1: trip is linked to the giro', r.giro_id === G.giro_id, r);
      const rows = (await c.su.query('SELECT order_uid FROM trip_authority.trip_members WHERE trip_id = $1', [r.trip_id])).rows;
      const uids = new Set(rows.map((x) => x.order_uid));
      assert('1: exactly the 3 giro members are frozen', rows.length === 3 && [A, B, C].every((o) => uids.has(o.order_uid)), rows);
      for (const o of [A, B, C]) assert(`1: ${o.id} moved to EN_ENTREGA`, (await estado(o.id)) === 'EN_ENTREGA');
      const n = await counts();
      assert('1: exactly one trip exists', n.trips === 1 && n.active_trips === 1, n);
    } finally { await c.close(); }
  }
  {
    const c = await open(env, 'w6rl02');
    try {
      await ensureCaptureTrigger(c.su);
      const s = await c.fx.day('2026-09-15');
      const { mk, createOrMove, startV2, counts, estado } = ctx(c, s);
      await makeActor(c.su, 'rider-02');
      const A = await mk({ estado: 'LISTO' }); const B = await mk({ estado: 'LISTO' }); const C = await mk({ estado: 'EN_COCINA' });
      await createOrMove([A, B, C]);
      const r = await startV2(c.svc, A, 'rider-02');
      assert('2: 2 LISTO + 1 EN_COCINA -> departure REFUSED with the existing INVALID_STATE code',
        r.ok === false && r.code === 'INVALID_STATE', r);
      assert('2: the refusal names the member that was not ready', r.order_uid === C.order_uid && r.estado === 'EN_COCINA', r);
      const n = await counts();
      assert('2: ZERO trip rows created', n.trips === 0, n);
      assert('2: ZERO trip_members created', n.members === 0, n);
      for (const o of [A, B]) assert(`2: ${o.id} did NOT transition (still LISTO)`, (await estado(o.id)) === 'LISTO');
      assert('2: the non-ready member is untouched', (await estado(C.id)) === 'EN_COCINA');
      // Same fixture, once the last member is ready: the WHOLE giro departs.
      await c.fx.setEstado(C.id, 'LISTO');
      const r2 = await startV2(c.svc, A, 'rider-02');
      assert('2: once every member is LISTO the complete giro departs', r2.ok === true && r2.code === 'OK', r2);
      const rows = (await c.su.query('SELECT count(*)::int AS n FROM trip_authority.trip_members WHERE trip_id = $1', [r2.trip_id])).rows[0];
      assert('2: all 3 members frozen on the retry', rows.n === 3, rows);
    } finally { await c.close(); }
  }

  // ── 3-8. DEPARTURE CONTRACT ─────────────────────────────────────────────────────────────
  section('W6.3 departure -- single order, idempotency, conflicts, scope, identity, one-trip-per-giro');
  {
    const c = await open(env, 'w6rl0308');
    try {
      await ensureCaptureTrigger(c.su);
      const s = await c.fx.day('2026-09-15');
      const s2 = await c.fx.day('2026-09-15');
      const { mk, createOrMove, startV2, counts } = ctx(c, s);
      await makeActor(c.su, 'rider-03');
      await makeActor(c.su, 'op-03', 'operator');
      // B1 (migration 137) deliberately widens this RPC to admit admin/operator
      // alongside rider, so 'op-03' can no longer stand in for "a non-rider actor" --
      // 'cashier-03' stays refused under BOTH the pre-137 (rider-only) and post-137
      // (rider/admin/operator) predicate, which is what test 8 below actually intends
      // to prove: identity is refused on its own terms, never masked by the active-trip
      // conflict set up in test 5.
      await makeActor(c.su, 'cashier-03', 'cashier');

      // 3: single non-giro LISTO order
      const D = await mk({ estado: 'LISTO' });
      const r3 = await startV2(c.svc, D, 'rider-03');
      assert('3: single non-giro LISTO order -> one-member canonical trip', r3.ok === true && r3.giro_id === null, r3);
      const m3 = (await c.su.query('SELECT order_uid FROM trip_authority.trip_members WHERE trip_id = $1', [r3.trip_id])).rows;
      assert('3: exactly one frozen member', m3.length === 1 && m3[0].order_uid === D.order_uid, m3);

      // 4: duplicate departure, same anchor -> idempotent, SAME trip
      const r4 = await startV2(c.svc, D, 'rider-03');
      assert('4: replay of the same anchor is IDEMPOTENT on the same trip',
        r4.ok === true && r4.code === 'IDEMPOTENT' && r4.trip_id === r3.trip_id, r4);
      assert('4: no second trip was created', (await counts()).trips === 1);

      // 5: a genuinely different departure while one is ACTIVE
      const E = await mk({ estado: 'LISTO' });
      const r5 = await startV2(c.svc, E, 'rider-03');
      assert('5: a different anchor while a trip is ACTIVE -> ACTIVE_TRIP_CONFLICT',
        r5.ok === false && r5.code === 'ACTIVE_TRIP_CONFLICT', r5);
      assert('5: still exactly one trip', (await counts()).trips === 1);

      // 7/8 refusals are evaluated against the SAME active trip deliberately: identity and
      // scope must be refused on their own terms, never masked by the conflict above.
      const r8a = await startV2(c.svc, E, 'cashier-03');
      assert('8: an out-of-set-role actor is refused AUTH_FORBIDDEN_ROLE', r8a.ok === false && r8a.code === 'AUTH_FORBIDDEN_ROLE', r8a);
      const r8b = await startV2(c.svc, E, 'rider-03', 99);
      assert('8: a stale session_version is refused AUTH_SESSION_STALE', r8b.ok === false && r8b.code === 'AUTH_SESSION_STALE', r8b);
      const r8c = await startV2(c.svc, E, 'ghost-rider');
      assert('8: an unknown actor is refused AUTH_ACTOR_NOT_FOUND', r8c.ok === false && r8c.code === 'AUTH_ACTOR_NOT_FOUND', r8c);

      // Close the active trip so scope can be tested on a clean board.
      await c.fx.setEstado(D.id, 'RETIRADO');
      const closed = await call(c.svc, 'close_rider_trip', [null]);
      assert('3: the single-order trip closes cleanly', closed.ok === true && closed.code === 'OK', closed);

      // 7: wrong service scope
      const r7 = await startV2(c.svc, E, 'rider-03', 1, [s2]);
      assert('7: an order outside the supplied operational scope -> SCOPE_MISMATCH',
        r7.ok === false && r7.code === 'SCOPE_MISMATCH', r7);

      // 6: ONE TRIP PER GIRO, at the DB level
      const F = await mk({ estado: 'LISTO' }); const H = await mk({ estado: 'LISTO' });
      const G = await createOrMove([F, H]);
      const r6 = await startV2(c.svc, F, 'rider-03');
      assert('6: the giro departs once', r6.ok === true && r6.giro_id === G.giro_id, r6);
      const dbHas6 = await hasDispatchedBy(c.su);
      const dupErr = await c.su.query(
        dbHas6
          ? `INSERT INTO trip_authority.trips (trip_id, business_date, service_session_id, rider_actor, dispatched_by, anchor_order_uid, giro_id, departed_at, closed_at, status, seq)
             VALUES (gen_random_uuid(), '2026-09-15', $1, 'rider-03', 'rider-03', $2, $3, now(), now(), 'CLOSED', nextval('trip_authority.trips_seq_v1'))`
          : `INSERT INTO trip_authority.trips (trip_id, business_date, service_session_id, rider_actor, anchor_order_uid, giro_id, departed_at, closed_at, status, seq)
             VALUES (gen_random_uuid(), '2026-09-15', $1, 'rider-03', $2, $3, now(), now(), 'CLOSED', nextval('trip_authority.trips_seq_v1'))`,
        [s, F.order_uid, G.giro_id]).catch((e) => e);
      assert('6: a SECOND trip referencing the same giro_id violates trips_one_trip_per_giro_v1',
        dupErr instanceof Error && dupErr.code === '23505', dupErr && dupErr.message);
    } finally { await c.close(); }
  }

  // ── SERVICE_CLOSING gate (restored in 135) ──────────────────────────────────────────────
  section('W6.3 departure -- the S2-1H service-close gate is live on the activated path');
  {
    const c = await open(env, 'w6rlsc');
    try {
      await ensureCaptureTrigger(c.su);
      const s = await c.fx.day('2026-09-15');
      const { mk, startV2, counts } = ctx(c, s);
      await makeActor(c.su, 'rider-sc');
      const D = await mk({ estado: 'LISTO' });
      await c.fx.driverStato({ schema: 2, stato: 'LIBERO', active_trip: null, service_closing: { close_id: 'cid-1' } });
      const r = await startV2(c.svc, D, 'rider-sc');
      assert('SC: a departure during service close is refused SERVICE_CLOSING', r.ok === false && r.code === 'SERVICE_CLOSING', r);
      assert('SC: no trip row was created', (await counts()).trips === 0);
      await c.fx.driverStato({ schema: 2, stato: 'LIBERO', active_trip: null });
      const r2 = await startV2(c.svc, D, 'rider-sc');
      assert('SC: once the marker is cleared the same departure succeeds', r2.ok === true && r2.code === 'OK', r2);
    } finally { await c.close(); }
  }

  // ── 9-12. CANONICAL COLLECT ─────────────────────────────────────────────────────────────
  section('W6.3 collect -- canonical membership authority, money semantics preserved');
  {
    const c = await open(env, 'w6rl0912');
    try {
      await ensureCaptureTrigger(c.su);
      const s = await c.fx.day('2026-09-15');
      const { mk, createOrMove, startV2, collect, counts, estado } = ctx(c, s);
      await makeActor(c.su, 'rider-09');
      const A = await mk({ estado: 'LISTO' }); const B = await mk({ estado: 'LISTO' });
      const OUT = await mk({ estado: 'LISTO' });               // never a member
      await createOrMove([A, B]);
      const dep = await startV2(c.svc, A, 'rider-09');
      assert('9: setup departure OK', dep.ok === true, dep);

      // 9: a canonical member collects normally, money recorded exactly once
      const before = await counts();
      const r9 = await collect(c.svc, A.id, 'rider-09', { method: 'efectivo' });
      assert('9: collect on a canonical member -> OK', r9.ok === true && r9.code === 'OK' && r9.order_id === A.id, r9);
      assert('9: the order is RETIRADO', (await estado(A.id)) === 'RETIRADO');
      const after9 = await counts();
      assert('9: exactly one ledger event was written', after9.fin === before.fin + 1, { before, after9 });
      assert('9: no obligation/payment_transaction row was invented',
        after9.obl === before.obl && after9.pay === before.pay, { before, after9 });

      // 11: replay is idempotent (and may still reconcile the money)
      const r11 = await collect(c.svc, A.id, 'rider-09', { method: 'efectivo' });
      assert('11: replay of a completed stop -> IDEMPOTENT', r11.ok === true && r11.code === 'IDEMPOTENT', r11);

      // 10: a NON-member is refused and mutates nothing
      const pre10 = await counts();
      const r10 = await collect(c.svc, OUT.id, 'rider-09', { method: 'efectivo' });
      assert('10: collect on a non-member -> NON_MEMBER', r10.ok === false && r10.error === undefined && r10.code === 'NON_MEMBER', r10);
      const post10 = await counts();
      assert('10: NO financial mutation on a NON_MEMBER refusal', post10.fin === pre10.fin, { pre10, post10 });
      assert('10: the non-member order is untouched', (await estado(OUT.id)) === 'LISTO');

      // A no-money stop still completes and writes nothing to the ledger.
      const preB = await counts();
      const rB = await collect(c.svc, B.id, 'rider-09', { method: '' });
      assert('9b: a no-method (prepaid) stop completes without claiming money', rB.ok === true && rB.code === 'OK', rB);
      assert('9b: zero ledger events for a no-method stop', (await counts()).fin === preB.fin, preB);
      assert('9b: the order is RETIRADO', (await estado(B.id)) === 'RETIRADO');
    } finally { await c.close(); }
  }
  {
    // PAYMENT_REFUSED and the single tolerated AUTH_LEGACY_IMPORT_REQUIRED.
    const c = await open(env, 'w6rlpay');
    try {
      await ensureCaptureTrigger(c.su);
      const s = await c.fx.day('2026-09-15');
      const { mk, startV2, collect, counts, estado } = ctx(c, s);
      await makeActor(c.su, 'rider-pay');
      const A = await mk({ estado: 'LISTO' });
      await startV2(c.svc, A, 'rider-pay');

      await c.su.query("UPDATE public.fixture_ledger_control SET mode = 'refuse'");
      const pre = await counts();
      const r = await collect(c.svc, A.id, 'rider-pay', { method: 'tarjeta' });
      assert('9c: a ledger refusal -> PAYMENT_REFUSED, the stop does NOT complete',
        r.ok === false && r.code === 'PAYMENT_REFUSED', r);
      assert('9c: the order is still EN_ENTREGA after a refused collection', (await estado(A.id)) === 'EN_ENTREGA');
      assert('9c: nothing was written to the ledger', (await counts()).fin === pre.fin);

      await c.su.query("UPDATE public.fixture_ledger_control SET mode = 'legacy'");
      const r2 = await collect(c.svc, A.id, 'rider-pay', { method: 'tarjeta' });
      assert('9d: AUTH_LEGACY_IMPORT_REQUIRED is tolerated -- the stop completes and the note is surfaced',
        r2.ok === true && r2.code === 'OK' && r2.payment_note === 'AUTH_LEGACY_IMPORT_REQUIRED', r2);
      assert('9d: the order is RETIRADO', (await estado(A.id)) === 'RETIRADO');
      await c.su.query("UPDATE public.fixture_ledger_control SET mode = 'ok'");

      // An unknown payment method is still refused before anything else happens.
      const r3 = await collect(c.svc, A.id, 'rider-pay', { method: 'manual' });
      assert('9e: an unknown method is refused AUTH_METHOD_INVALID', r3.ok === false && r3.code === 'AUTH_METHOD_INVALID', r3);
    } finally { await c.close(); }
  }
  {
    // 12: RIDER_STOP_LOST_RACE -- money AND operational change rolled back together.
    const c = await open(env, 'w6rlrace');
    try {
      await ensureCaptureTrigger(c.su);
      const s = await c.fx.day('2026-09-15');
      const { mk, startV2, counts, estado } = ctx(c, s);
      await makeActor(c.su, 'rider-race');
      const A = await mk({ estado: 'LISTO' });
      await startV2(c.svc, A, 'rider-race');
      const before = await counts();

      const thief = await c.client('service_role', 'w6rl-race-thief');
      const rider = await c.client('service_role', 'w6rl-race-rider');
      await thief.query('BEGIN');
      await thief.query("UPDATE public.ordenes SET estado = 'RETIRADO' WHERE id = $1", [A.id]);

      const pending = rider.query(
        'SELECT public.rider_collect_and_complete_stop($1,$2,$3,$4,$5,$6,$7) AS r',
        [A.id, 'efectivo', 'rider-race', 1, 'iphash', META, `idem-${A.id}`]).catch((e) => e);
      assert('12: the collect blocks on the racing writer', await waitBlocked(c.su, 'w6rl-race-rider'));
      await thief.query('COMMIT');
      const outcome = await pending;

      assert('12: the collect ABORTS with RIDER_STOP_LOST_RACE (never a quiet return)',
        outcome instanceof Error && /RIDER_STOP_LOST_RACE/.test(outcome.message) && outcome.code === '40001',
        outcome && (outcome.message || outcome));
      const after = await counts();
      assert('12: the payment it had already recorded is rolled back with it', after.fin === before.fin, { before, after });
      assert('12: the order keeps the racing writer\'s state, not a half-applied one', (await estado(A.id)) === 'RETIRADO');
    } finally { await c.close(); }
  }

  // ── 13-16. CANONICAL CLOSE ──────────────────────────────────────────────────────────────
  section('W6.3 close -- EARLY_CLOSE, canonical close, idempotent replay, no stranded ACTIVE row');
  {
    const c = await open(env, 'w6rl1316');
    try {
      await ensureCaptureTrigger(c.su);
      const s = await c.fx.day('2026-09-15');
      const { mk, createOrMove, startV2, collect, close, counts } = ctx(c, s);
      await makeActor(c.su, 'rider-13');
      const A = await mk({ estado: 'LISTO' }); const B = await mk({ estado: 'LISTO' });
      await createOrMove([A, B]);
      const dep = await startV2(c.svc, A, 'rider-13');
      assert('13: setup departure OK', dep.ok === true, dep);

      // 13: one member still out
      await collect(c.svc, A.id, 'rider-13', { method: 'efectivo' });
      const early = await close();
      assert('13: closing while a member is still out -> EARLY_CLOSE', early.ok === false && early.code === 'EARLY_CLOSE', early);
      assert('13: the canonical trip is still ACTIVE', (await counts()).active_trips === 1);

      // A non-member trigger id is still a no-op, resolved against trip_members.
      const OUT = await mk({ estado: 'LISTO' });
      const noop = await close(c.svc, OUT.id);
      assert('13b: a non-member trigger order -> NON_MEMBER_NOOP', noop.ok === true && noop.code === 'NON_MEMBER_NOOP', noop);

      // 14: every member terminal
      await collect(c.svc, B.id, 'rider-13', { method: '' });
      const logsBefore = (await c.su.query('SELECT count(*)::int AS n FROM public.delivery_logs')).rows[0].n;
      const ok = await close();
      assert('14: close after every member is terminal -> OK', ok.ok === true && ok.code === 'OK', ok);
      assert('14: the snapshot is CLOSED and carries the full frozen membership',
        ok.snapshot && ok.snapshot.status === 'CLOSED' && ok.snapshot.order_ids.length === 2, ok.snapshot);
      const n14 = await counts();
      assert('14: HARD INVARIANT -- zero ACTIVE canonical trips remain after a successful close',
        n14.active_trips === 0 && n14.trips === 1, n14);
      const closedRow = (await c.su.query('SELECT status, closed_at FROM trip_authority.trips WHERE trip_id = $1', [dep.trip_id])).rows[0];
      assert('14: the canonical row is CLOSED with closed_at set once', closedRow.status === 'CLOSED' && closedRow.closed_at !== null, closedRow);
      const logsAfter = (await c.su.query('SELECT count(*)::int AS n FROM public.delivery_logs')).rows[0].n;
      assert('14: exactly one delivery_logs row was written', logsAfter === logsBefore + 1, { logsBefore, logsAfter });
      const ds = (await c.su.query("SELECT valore::jsonb AS v FROM public.config WHERE chiave = 'DRIVER_STATO'")).rows[0].v;
      assert('14: DRIVER_STATO compatibility output -- active trip cleared, last_closed_trip preserved',
        ds.stato === 'LIBERO' && ds.active_trip === null && ds.last_closed_trip && ds.last_closed_trip.status === 'CLOSED', ds);

      // 15: replay
      const again = await close();
      assert('15: close replay is IDEMPOTENT and returns the closed snapshot',
        again.ok === true && again.code === 'IDEMPOTENT' && again.snapshot.status === 'CLOSED', again);
      assert('15: replay created no new trip row and no new delivery log',
        (await counts()).trips === 1 &&
        (await c.su.query('SELECT count(*)::int AS n FROM public.delivery_logs')).rows[0].n === logsAfter);

      // 16: a second, unrelated trip can start -- proves nothing was stranded
      const r16 = await startV2(c.svc, OUT, 'rider-13');
      assert('16: an unrelated second trip starts cleanly after the first closed', r16.ok === true && r16.code === 'OK', r16);
      const n16 = await counts();
      assert('16: exactly one ACTIVE trip, two trips in total', n16.active_trips === 1 && n16.trips === 2, n16);
    } finally { await c.close(); }
  }

  // ── 17-18. COMPATIBILITY: legacy in-flight trip, and canonical-wins ─────────────────────
  section('W6.3 compatibility -- legacy in-flight DRIVER_STATO trip, and canonical precedence');
  {
    const c = await open(env, 'w6rl17');
    try {
      await ensureCaptureTrigger(c.su);
      const s = await c.fx.day('2026-09-15');
      const { mk, collect, close, counts, estado } = ctx(c, s);
      await makeActor(c.su, 'rider-17');
      // A pre-cutover trip: DRIVER_STATO only, no canonical row anywhere.
      const A = await mk({ estado: 'LISTO' }); const B = await mk({ estado: 'LISTO' });
      for (const o of [A, B]) await c.fx.setEstado(o.id, 'EN_ENTREGA');
      await c.fx.driverStato({
        schema: 2, stato: 'IN_GIRO', zona: 'Q1', trip_seq: 1,
        active_trip: {
          trip_id: 'legacy-trip-1', anchor_order_id: A.id, order_ids: [A.id, B.id], manual_giro_ids: [],
          salida_refs: [], zone_sequence: ['Q1'], n_orders: 2, started_at: '2026-09-15T18:00:00Z',
          closed_at: null, trip_version: 1, status: 'ACTIVE',
        },
      });
      assert('17: no canonical trip exists for this scenario', (await counts()).trips === 0);

      const r = await collect(c.svc, A.id, 'rider-17', { method: 'efectivo' });
      assert('17: a legacy in-flight trip can still be collected on', r.ok === true && r.code === 'OK', r);
      assert('17: the order completed', (await estado(A.id)) === 'RETIRADO');
      const early = await close();
      assert('17: the legacy close still refuses EARLY_CLOSE while a member is out', early.ok === false && early.code === 'EARLY_CLOSE', early);
      await collect(c.svc, B.id, 'rider-17', { method: '' });
      const ok = await close();
      assert('17: the legacy trip closes through the unchanged legacy path', ok.ok === true && ok.code === 'OK', ok);
      assert('17: still zero canonical trip rows -- the legacy path created none', (await counts()).trips === 0);
    } finally { await c.close(); }
  }
  {
    const c = await open(env, 'w6rl18');
    try {
      await ensureCaptureTrigger(c.su);
      const s = await c.fx.day('2026-09-15');
      const { mk, startV2, collect, close, counts, estado } = ctx(c, s);
      await makeActor(c.su, 'rider-18');
      const A = await mk({ estado: 'LISTO' });
      const DECOY = await mk({ estado: 'LISTO' });
      const dep = await startV2(c.svc, A, 'rider-18');
      assert('18: setup canonical departure OK', dep.ok === true, dep);
      await c.fx.setEstado(DECOY.id, 'EN_ENTREGA');

      // Corrupt the compatibility projection so the two sources disagree.
      const ds = (await c.su.query("SELECT valore::jsonb AS v FROM public.config WHERE chiave = 'DRIVER_STATO'")).rows[0].v;
      ds.active_trip.order_ids = [DECOY.id];
      ds.active_trip.n_orders = 1;
      await c.fx.driverStato(ds);

      const rDecoy = await collect(c.svc, DECOY.id, 'rider-18', { method: 'efectivo' });
      assert('18: the DRIVER_STATO-only order is refused NON_MEMBER -- the canonical path wins',
        rDecoy.ok === false && rDecoy.code === 'NON_MEMBER', rDecoy);
      assert('18: the decoy order was not mutated', (await estado(DECOY.id)) === 'EN_ENTREGA');
      const rReal = await collect(c.svc, A.id, 'rider-18', { method: '' });
      assert('18: the real frozen member collects normally', rReal.ok === true && rReal.code === 'OK', rReal);

      // Close, too, must follow trip_members and not the corrupted blob.
      const ok = await close();
      assert('18: the close follows the canonical membership, not the corrupted snapshot',
        ok.ok === true && ok.code === 'OK' && ok.snapshot.order_ids.length === 1 && ok.snapshot.order_ids[0] === A.id, ok.snapshot);
      assert('18: no ACTIVE canonical row remains', (await counts()).active_trips === 0);
    } finally { await c.close(); }
  }

  // ── 19-23. RACES AND DEADLOCK ───────────────────────────────────────────────────────────
  section('W6.3 races -- Giro mutations vs the ATOMIC departure, collect vs departure, no deadlock');
  {
    const c = await open(env, 'w6rl1922');
    try {
      await ensureCaptureTrigger(c.su);
      const s = await c.fx.day('2026-09-15');
      const { mk, createOrMove, close } = ctx(c, s);
      await makeActor(c.su, 'rider-19');
      const t1 = await c.client('service_role', 'w6rl-1922-t1');
      const t2 = await c.client('service_role', 'w6rl-1922-t2');
      const reset = async (orders) => {
        for (const o of orders) await c.fx.setEstado(o.id, 'RETIRADO');
        await c.su.query("UPDATE trip_authority.trips SET status='CLOSED', closed_at=now() WHERE status='ACTIVE'");
        await close();
      };

      // 19: attach vs departure -- the attaching command holds L0 first; the departure
      // waits, then departs the giro as it is AFTER the attach (atomically, all members).
      {
        const A = await mk({ estado: 'LISTO' }); const B = await mk({ estado: 'LISTO' }); const F = await mk({ estado: 'LISTO' });
        const G = await createOrMove([A, B]);
        await t1.query('BEGIN');
        const held = await call(t1, 'giro_authority_attach_or_move_v1', [G.giro_id, F.order_uid, 'op-1', [s]]);
        const pending = t2.query('SELECT public.start_rider_trip_v2($1,$2,$3,$4) AS r', [A.order_uid, 'rider-19', 1, [s]]);
        assert('19: the departure waits on L0 while the attach is held open', await waitBlocked(c.su, 'w6rl-1922-t2'));
        await t1.query('COMMIT');
        const trip = (await pending).rows[0].r;
        assert('19: attach OK, then the departure proceeds with no deadlock', held.code === 'OK' && trip.ok === true, { held, trip });
        const n = (await c.su.query('SELECT count(*)::int AS n FROM trip_authority.trip_members WHERE trip_id = $1', [trip.trip_id])).rows[0].n;
        assert('19: the newly-attached member departed WITH the giro (atomic, 3 members)', n === 3, { n });
        await reset([A, B, F]);
      }

      // 20: detach vs departure -- departure commits first, detach then refuses.
      {
        const A = await mk({ estado: 'LISTO' }); const B = await mk({ estado: 'LISTO' });
        await createOrMove([A, B]);
        await t1.query('BEGIN');
        const dep = (await t1.query('SELECT public.start_rider_trip_v2($1,$2,$3,$4) AS r', [A.order_uid, 'rider-19', 1, [s]])).rows[0].r;
        assert('20: the departure itself returned OK', dep.ok === true, dep);
        const pending = call(t2, 'giro_authority_detach_v1', [A.order_uid, 'op-2', [s]]);
        assert('20: detach waits on L0 while the departure is held open', await waitBlocked(c.su, 'w6rl-1922-t2'));
        await t1.query('COMMIT');
        const r = await pending;
        assert('20: departure first -> detach refuses GIRO_DEPARTED', r.code === 'GIRO_DEPARTED', r);
        await reset([A, B]);
      }

      // 21: dissolve vs departure
      {
        const A = await mk({ estado: 'LISTO' }); const B = await mk({ estado: 'LISTO' });
        const G = await createOrMove([A, B]);
        await t1.query('BEGIN');
        await t1.query('SELECT public.start_rider_trip_v2($1,$2,$3,$4)', [A.order_uid, 'rider-19', 1, [s]]);
        const pending = call(t2, 'giro_authority_dissolve_v1', [G.giro_id, 'op-2', [s]]);
        assert('21: dissolve waits on L0 while the departure is held open', await waitBlocked(c.su, 'w6rl-1922-t2'));
        await t1.query('COMMIT');
        const r = await pending;
        assert('21: departure first -> dissolve refuses GIRO_DEPARTED', r.code === 'GIRO_DEPARTED', r);
        await reset([A, B]);
      }

      // 22: intent consume vs departure
      {
        const A = await mk({ estado: 'LISTO' }); const B = await mk({ estado: 'LISTO' });
        const TG = await createOrMove([A, B]);
        const X = await mk({ estado: 'POR_CONFIRMAR', intent: { v: 1, source: 'operator_http', actor: 'op', sv: 1, target_kind: 'GIRO', target_ref: TG.giro_id } });
        await c.fx.setEstado(X.id, 'EN_COCINA');
        await t1.query('BEGIN');
        await t1.query('SELECT public.start_rider_trip_v2($1,$2,$3,$4)', [A.order_uid, 'rider-19', 1, [s]]);
        const pending = call(t2, 'giro_authority_consume_intent_v1', [X.order_uid, 'op', [s]]);
        assert('22: consume_intent waits on L0 while the departure is held open', await waitBlocked(c.su, 'w6rl-1922-t2'));
        await t1.query('COMMIT');
        const r = await pending;
        assert('22: departure first -> consume refuses TARGET_DEPARTED', r.resolution_code === 'TARGET_DEPARTED', r);
        await reset([A, B]);
      }
    } finally { await c.close(); }
  }
  {
    // 23a. The ABBA this activation would otherwise have introduced.
    // trip_authority.trips.rider_actor is a FOREIGN KEY to auth_actors, so
    // start_rider_trip_v2's INSERT implicitly takes FOR KEY SHARE on the rider's actor
    // row. Before migration 135, rider_collect_and_complete_stop took that same row FOR
    // UPDATE *before* L0, while the departure took L0 first -- a real cycle. 135 moves
    // collect's L0 ahead of its actor lock (the W6.1 placement), so both writers are
    // ordered identically and can only ever queue, never deadlock. Proven structurally:
    // while blocked on L0, collect holds NO lock on auth_actors at all.
    const c = await open(env, 'w6rlabba');
    try {
      await ensureCaptureTrigger(c.su);
      const s = await c.fx.day('2026-09-15');
      const { mk, startV2, counts } = ctx(c, s);
      await makeActor(c.su, 'rider-abba');
      const A = await mk({ estado: 'LISTO' });
      const dep0 = await startV2(c.svc, A, 'rider-abba');
      assert('23a: setup departure OK', dep0.ok === true, dep0);

      const gate = await c.client('service_role', 'w6rl-abba-gate');
      const collector = await c.client('service_role', 'w6rl-abba-collector');
      await gate.query('BEGIN');
      await gate.query("SELECT pg_advisory_xact_lock(hashtext('LA_DIECI_DRIVER_STATO'))");
      const pending = collector.query(
        'SELECT public.rider_collect_and_complete_stop($1,$2,$3,$4,$5,$6,$7) AS r',
        [A.id, 'efectivo', 'rider-abba', 1, 'iphash', META, `idem-${A.id}`]).catch((e) => e);
      assert('23a: collect blocks on L0', await waitBlocked(c.su, 'w6rl-abba-collector'));
      const held = (await c.su.query(`
        SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
         WHERE a.application_name = $1 AND l.relation = 'public.auth_actors'::regclass AND l.granted`,
        ['w6rl-abba-collector'])).rows[0].n;
      assert('23a: while blocked on L0 the collect holds NO auth_actors lock -- L0 really is first', held === 0, { held });
      await gate.query('ROLLBACK');
      const outcome = await pending;
      assert('23a: the collect then completes normally once L0 is released',
        outcome && outcome.rows && outcome.rows[0].r.ok === true, outcome && (outcome.message || outcome.rows));
      assert('23a: the trip is intact', (await counts()).active_trips === 1);
    } finally { await c.close(); }
  }
  {
    // 23b. Mixed real traffic: departures, collects and Giro commands, many rounds.
    const c = await open(env, 'w6rldl');
    try {
      await ensureCaptureTrigger(c.su);
      const s = await c.fx.day('2026-09-15');
      const { mk, createOrMove, close } = ctx(c, s);
      await makeActor(c.su, 'rider-dl');
      const pool = [];
      for (let i = 0; i < 3; i++) pool.push(await c.client('service_role', `w6rl-dl-${i}`));
      let deadlocks = 0; let settled = 0;
      const ROUNDS = 12;
      for (let i = 0; i < ROUNDS; i++) {
        const A = await mk({ estado: 'LISTO' }); const B = await mk({ estado: 'LISTO' }); const P = await mk({ estado: 'LISTO' });
        const G = await createOrMove([A, B]);
        const res = await Promise.allSettled([
          pool[0].query('SELECT public.start_rider_trip_v2($1,$2,$3,$4) AS r', [A.order_uid, 'rider-dl', 1, [s]]),
          call(pool[1], 'giro_authority_attach_or_move_v1', [G.giro_id, P.order_uid, 'op-2', [s]]),
          pool[2].query('SELECT public.rider_collect_and_complete_stop($1,$2,$3,$4,$5,$6,$7) AS r',
            [A.id, 'efectivo', 'rider-dl', 1, 'iphash', META, `idem-${A.id}-${i}`]),
        ]);
        for (const x of res) {
          if (x.status === 'rejected' && x.reason && x.reason.code === '40P01') deadlocks++;
          else settled++;
        }
        for (const o of [A, B, P]) await c.fx.setEstado(o.id, 'RETIRADO');
        await c.su.query("UPDATE trip_authority.trips SET status='CLOSED', closed_at=now() WHERE status='ACTIVE'");
        await close();
      }
      assert(`23b: ${ROUNDS} rounds of departure + attach + collect: zero deadlocks, everything settles`,
        deadlocks === 0 && settled === ROUNDS * 3, { deadlocks, settled, expected: ROUNDS * 3 });
    } finally { await c.close(); }
  }

  // ── 24-33. W6.4 PROJECTION ──────────────────────────────────────────────────────────────
  section('W6.4 projection -- frozen membership, IN_TRIP/DONE, real salida, post-departure guards');
  {
    const c = await open(env, 'w6rl2433');
    try {
      await ensureCaptureTrigger(c.su);
      const s = await c.fx.day('2026-09-15');
      const { mk, createOrMove, startV2, collect, close, giroOf, counts } = ctx(c, s);
      await makeActor(c.su, 'rider-24');
      const A = await mk({ estado: 'LISTO' }); const B = await mk({ estado: 'LISTO' }); const C = await mk({ estado: 'LISTO' });
      const G = await createOrMove([A, B, C], '19:30');
      const frozen = new Set([A, B, C].map((o) => o.order_uid));
      const members = async () => new Set((await giroOf(G.giro_id)).effective_members.map((m) => m.order_uid));
      const sameAsFrozen = (set) => set.size === frozen.size && [...frozen].every((u) => set.has(u));

      // 24: PLANNED before departure, planned salida from hora_ref
      const before = await giroOf(G.giro_id);
      assert('24: before departure the giro is PLANNED', before.giro_state === 'PLANNED', before);
      assert('24: the planned salida comes from the operator hora_ref',
        before.salida === '19:30' && before.salida_source === 'OPERATOR' && before.hora_ref === '19:30', before);

      // 25/26/30/31/32: departure
      const dep = await startV2(c.svc, A, 'rider-24');
      assert('25: departure OK', dep.ok === true, dep);
      const inTrip = await giroOf(G.giro_id);
      assert('25: after departure the giro is IN_TRIP', inTrip.giro_state === 'IN_TRIP' && inTrip.state_reason === 'DEPARTED', inTrip);
      assert('26: effective_members equals the full frozen trip_members set', sameAsFrozen(await members()), inTrip.effective_members);
      const expected = (await c.su.query(
        `SELECT to_char((SELECT departed_at FROM trip_authority.trips WHERE trip_id = $1) AT TIME ZONE 'Europe/Madrid', 'HH24:MI') AS hhmm`,
        [dep.trip_id])).rows[0].hhmm;
      assert('30: salida_source is DEPARTED once the giro has really departed', inTrip.salida_source === 'DEPARTED', inTrip);
      assert('31: salida is the REAL trip.departed_at rendered through the HH:MM contract',
        inTrip.salida === expected, { got: inTrip.salida, expected });
      assert('32: the operator-planned hora_ref is NOT overwritten', inTrip.hora_ref === '19:30', inTrip);
      const mgRow = (await c.su.query('SELECT hora_ref FROM public.manual_giros WHERE id = $1', [G.giro_id])).rows[0];
      assert('32: manual_giros.hora_ref is untouched in the database too', mgRow.hora_ref === '19:30', mgRow);

      // 33a: post-departure Giro mutation refused while the trip is ACTIVE
      const EXTRA = await mk({ estado: 'LISTO' });
      const a33 = await call(c.svc, 'giro_authority_attach_or_move_v1', [G.giro_id, EXTRA.order_uid, 'op-1', [s]]);
      assert('33a: attach to a departed giro is refused (trip ACTIVE)', a33.code === 'GIRO_DEPARTED', a33);
      const d33 = await call(c.svc, 'giro_authority_detach_v1', [B.order_uid, 'op-1', [s]]);
      assert('33a: detach from a departed giro is refused (trip ACTIVE)', d33.code === 'GIRO_DEPARTED', d33);
      const s33 = await call(c.svc, 'giro_authority_dissolve_v1', [G.giro_id, 'op-1', [s]]);
      assert('33a: dissolve of a departed giro is refused (trip ACTIVE)', s33.code === 'GIRO_DEPARTED', s33);
      assert('33a: no mutation reached the membership',
        (await c.su.query('SELECT count(*)::int AS n FROM giro_authority.giro_members WHERE giro_id = $1', [G.giro_id])).rows[0].n === 3);

      // 27: one member delivered -> still IN_TRIP, membership unchanged
      await collect(c.svc, A.id, 'rider-24', { method: 'efectivo' });
      const partial = await giroOf(G.giro_id);
      assert('27: with one member delivered the giro is still IN_TRIP', partial.giro_state === 'IN_TRIP', partial);
      assert('27: effective_members STILL contains every frozen member', sameAsFrozen(await members()), partial.effective_members);
      assert('27: salida is still the real departure', partial.salida === expected && partial.salida_source === 'DEPARTED', partial);

      // 28: every member delivered while the trip is STILL ACTIVE -> DONE
      await collect(c.svc, B.id, 'rider-24', { method: '' });
      await collect(c.svc, C.id, 'rider-24', { method: '' });
      assert('28: the trip row is still ACTIVE at this point', (await counts()).active_trips === 1);
      const allDelivered = await giroOf(G.giro_id);
      assert('28: every member delivered -> DONE, without an explicit close', allDelivered.giro_state === 'DONE', allDelivered);
      assert('28: effective_members STILL equals the full frozen membership', sameAsFrozen(await members()), allDelivered.effective_members);

      // 29: after a real close -> still DONE, still the full frozen membership
      const ok = await close();
      assert('29: the canonical close succeeds', ok.ok === true && ok.code === 'OK', ok);
      assert('29: no ACTIVE canonical trip remains', (await counts()).active_trips === 0);
      const afterClose = await giroOf(G.giro_id);
      assert('29: a CLOSED linked trip keeps the giro DONE', afterClose.giro_state === 'DONE', afterClose);
      assert('29: effective_members STILL equals the full frozen membership after close', sameAsFrozen(await members()), afterClose.effective_members);
      assert('29: salida stays the real departure after close (never reverts to the planned value)',
        afterClose.salida === expected && afterClose.salida_source === 'DEPARTED', afterClose);
      assert('29: hora_ref still carries the operator-planned fact', afterClose.hora_ref === '19:30', afterClose);

      // 33b: the mutation guards still refuse once the trip is CLOSED
      const a33b = await call(c.svc, 'giro_authority_attach_or_move_v1', [G.giro_id, EXTRA.order_uid, 'op-1', [s]]);
      assert('33b: attach to a departed giro is refused (trip CLOSED)', a33b.code === 'GIRO_DEPARTED', a33b);
      const d33b = await call(c.svc, 'giro_authority_detach_v1', [B.order_uid, 'op-1', [s]]);
      assert('33b: detach from a departed giro is refused (trip CLOSED)', d33b.code === 'GIRO_DEPARTED', d33b);
      const s33b = await call(c.svc, 'giro_authority_dissolve_v1', [G.giro_id, 'op-1', [s]]);
      assert('33b: dissolve of a departed giro is refused (trip CLOSED)', s33b.code === 'GIRO_DEPARTED', s33b);
      const X = await mk({ estado: 'POR_CONFIRMAR', intent: { v: 1, source: 'operator_http', actor: 'op', sv: 1, target_kind: 'GIRO', target_ref: G.giro_id } });
      await c.fx.setEstado(X.id, 'EN_COCINA');
      const i33b = await call(c.svc, 'giro_authority_consume_intent_v1', [X.order_uid, 'op', [s]]);
      assert('33b: an intent targeting a departed giro is refused TARGET_DEPARTED (trip CLOSED)',
        i33b.resolution_code === 'TARGET_DEPARTED', i33b);
      assert('33b: the frozen membership is still exactly 3 rows',
        (await c.su.query('SELECT count(*)::int AS n FROM trip_authority.trip_members WHERE trip_id = $1', [dep.trip_id])).rows[0].n === 3);
    } finally { await c.close(); }
  }
  {
  // language-guard: allow-legacy CHIUSO_FORZATO is the existing terminal-state literal, named here only to describe the close-vs-projection divergence, not new vocabulary
    // A cancelled (CHIUSO_FORZATO) member is terminal for PROGRESS but deliberately NOT
    // for the close contract: the projection may read DONE while the close still refuses.
    // The divergence is one-directional and fail-safe, and is pinned here on purpose.
    const c = await open(env, 'w6rlcancel');
    try {
      await ensureCaptureTrigger(c.su);
      const s = await c.fx.day('2026-09-15');
      const { mk, createOrMove, startV2, collect, close, giroOf } = ctx(c, s);
      await makeActor(c.su, 'rider-cx');
      const A = await mk({ estado: 'LISTO' }); const B = await mk({ estado: 'LISTO' });
      const G = await createOrMove([A, B]);
      const dep = await startV2(c.svc, A, 'rider-cx');
      await collect(c.svc, A.id, 'rider-cx', { method: '' });
      // language-guard: allow-legacy CHIUSO_FORZATO is the existing ordenes.estado cancellation literal being exercised, not new vocabulary
      await c.fx.setEstado(B.id, 'CHIUSO_FORZATO');
      const g = await giroOf(G.giro_id);
      assert('CX: a cancelled member counts as terminal progress -> DONE', g.giro_state === 'DONE', g);
      assert('CX: the cancelled member is STILL part of the frozen effective membership',
        g.effective_members.length === 2, g.effective_members);
      const early = await close();
      // language-guard: allow-legacy CHIUSO_FORZATO is the existing terminal-state literal, named here only to describe the close-vs-projection divergence, not new vocabulary
      assert('CX: the close contract stays strictly stricter -- CHIUSO_FORZATO still blocks EARLY_CLOSE',
        early.ok === false && early.code === 'EARLY_CLOSE', early);
      assert('CX: the canonical trip is therefore still ACTIVE, never silently closed',
        (await c.su.query("SELECT count(*)::int AS n FROM trip_authority.trips WHERE status='ACTIVE'")).rows[0].n === 1);
      assert('CX: nothing about the trip row changed', dep.ok === true);
    } finally { await c.close(); }
  }

  // ── 34-35. MONEY / ECONOMY BOUNDARY ─────────────────────────────────────────────────────
  section('W6.3/4 boundary -- no money regression, no Economy mutation');
  {
    const c = await open(env, 'w6rlmoney');
    try {
      await ensureCaptureTrigger(c.su);
      const s = await c.fx.day('2026-09-15');
      const { mk, createOrMove, startV2, close, counts } = ctx(c, s);
      await makeActor(c.su, 'rider-34');
      const A = await mk({ estado: 'LISTO' }); const B = await mk({ estado: 'LISTO' });
      await createOrMove([A, B]);
      const before = await counts();
      const dep = await startV2(c.svc, A, 'rider-34');
      assert('34: departure OK', dep.ok === true, dep);
      const afterDep = await counts();
      assert('34: a DEPARTURE writes nothing financial at all',
        afterDep.fin === before.fin && afterDep.obl === before.obl && afterDep.pay === before.pay, { before, afterDep });
      for (const o of [A, B]) await c.fx.setEstado(o.id, 'RETIRADO');
      await close();
      const afterClose = await counts();
      assert('35: a CLOSE writes nothing financial at all',
        afterClose.fin === before.fin && afterClose.obl === before.obl && afterClose.pay === before.pay, { before, afterClose });
      const cobrado = (await c.su.query(
        'SELECT count(*)::int AS n FROM public.ordenes WHERE cobrado IS NOT NULL OR metodo_pago IS NOT NULL')).rows[0].n;
      assert('34: neither departure nor close invented a cobrado / metodo_pago flag', cobrado === 0, { cobrado });
    } finally { await c.close(); }
  }
}

module.exports = { run };
