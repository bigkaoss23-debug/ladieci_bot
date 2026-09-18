'use strict';
// B1_RIDER_DISPATCH_OPERATOR_PARITY (migration 137) certification.
// Exercises the migration-137 delta end to end on real PostgreSQL: admin/operator/rider
// can all depart (start_rider_trip_v2), an unlisted role still cannot, the
// dispatched_by/rider_actor identity-truth split is correct for every caller role, and
// rider_collect_and_complete_stop (money collection) still refuses admin/operator
// exactly as before -- proving the completion path was genuinely NOT widened.
const { section, assert, call } = require('../lib');
const { open, ensureCaptureTrigger } = require('./_ctx');

const META = JSON.stringify({});

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
  const startV2 = async (client, anchor, actor, sv = 1, sc = scope) =>
    call(client, 'start_rider_trip_v2', [anchor.order_uid, actor, sv, sc]);
  const collect = async (client, orderId, actor, { method = '', sv = 1, idem = null } = {}) =>
    call(client, 'rider_collect_and_complete_stop',
      [orderId, method, actor, sv, 'iphash', META, idem == null ? `idem-${orderId}` : idem]);
  const close = async (client = c.svc, trigger = null) => call(client, 'close_rider_trip', [trigger]);
  const tripRow = async (tripId) => (await c.su.query(
    'SELECT rider_actor, dispatched_by FROM trip_authority.trips WHERE trip_id = $1', [tripId])).rows[0];
  const estado = async (id) => (await c.su.query('SELECT estado FROM public.ordenes WHERE id = $1', [id])).rows[0].estado;
  return { scope, mk, startV2, collect, close, tripRow, estado };
}

async function run(env) {
  // ── 1-3. AUTHORIZED DISPATCH: admin, operator, rider all depart ──────────────────────
  section('B1 identity -- admin, operator and rider can all depart (authorized dispatch)');
  for (const role of ['admin', 'operator', 'rider']) {
    const c = await open(env, `b1dep_${role}`);
    try {
      await ensureCaptureTrigger(c.su);
      const s = await c.fx.day('2026-09-17');
      const { mk, startV2, tripRow, estado } = ctx(c, s);
      await makeActor(c.su, `${role}-actor`, role);
      const A = await mk({ estado: 'LISTO' });
      const r = await startV2(c.svc, A, `${role}-actor`);
      assert(`AUTHORIZED_DISPATCH: ${role} departs successfully -> OK`, r.ok === true && r.code === 'OK', r);
      assert(`AUTHORIZED_DISPATCH: ${role} departure moved the order to EN_ENTREGA`, (await estado(A.id)) === 'EN_ENTREGA');
      const row = await tripRow(r.trip_id);
      assert(`IDENTITY_TRUTH: ${role} dispatch always sets dispatched_by to the caller`, row.dispatched_by === `${role}-actor`, row);
      if (role === 'rider') {
        assert('IDENTITY_TRUTH: a REAL rider dispatch sets rider_actor to the rider', row.rider_actor === `${role}-actor`, row);
      } else {
        assert(`IDENTITY_TRUTH: an ${role}-initiated dispatch leaves rider_actor NULL (no false rider claim)`, row.rider_actor === null, row);
      }
    } finally { await c.close(); }
  }

  // ── 4. UNAUTHORIZED_DISPATCH: an unlisted role is still refused ─────────────────────
  section('B1 identity -- unauthorized/unknown/inactive/stale dispatch still fails closed');
  {
    const c = await open(env, 'b1unauth');
    try {
      await ensureCaptureTrigger(c.su);
      const s = await c.fx.day('2026-09-17');
      const { mk, startV2 } = ctx(c, s);
      await makeActor(c.su, 'cashier-01', 'cashier');
      await makeActor(c.su, 'inactive-rider', 'rider', 1, false);
      await makeActor(c.su, 'stale-rider', 'rider', 1, true);

      const A = await mk({ estado: 'LISTO' });
      const rCashier = await startV2(c.svc, A, 'cashier-01');
      assert('UNAUTHORIZED_DISPATCH: a role outside (rider,admin,operator) is refused AUTH_FORBIDDEN_ROLE',
        rCashier.ok === false && rCashier.code === 'AUTH_FORBIDDEN_ROLE', rCashier);

      const rUnknown = await startV2(c.svc, A, 'nobody-here');
      assert('UNAUTHORIZED_DISPATCH: an unknown actor is refused AUTH_ACTOR_NOT_FOUND',
        rUnknown.ok === false && rUnknown.code === 'AUTH_ACTOR_NOT_FOUND', rUnknown);

      const rInactive = await startV2(c.svc, A, 'inactive-rider');
      assert('UNAUTHORIZED_DISPATCH: an inactive rider is refused AUTH_INITIATOR_INACTIVE',
        rInactive.ok === false && rInactive.code === 'AUTH_INITIATOR_INACTIVE', rInactive);

      const rStale = await startV2(c.svc, A, 'stale-rider', 99);
      assert('UNAUTHORIZED_DISPATCH: a stale session_version is refused AUTH_SESSION_STALE',
        rStale.ok === false && rStale.code === 'AUTH_SESSION_STALE', rStale);

      const n = (await c.su.query('SELECT count(*)::int AS n FROM trip_authority.trips')).rows[0].n;
      assert('UNAUTHORIZED_DISPATCH: zero trip rows were created by any refused attempt', n === 0, { n });
    } finally { await c.close(); }
  }

  // ── 5. COMPLETION PATH: rider_collect_and_complete_stop stays rider-exclusive ────────
  section('B1 completion path -- money collection is untouched: admin/operator still 403, real rider still succeeds');
  {
    const c = await open(env, 'b1collect');
    try {
      await ensureCaptureTrigger(c.su);
      const s = await c.fx.day('2026-09-17');
      const { mk, startV2, collect, tripRow } = ctx(c, s);
      await makeActor(c.su, 'op-collect', 'operator');
      await makeActor(c.su, 'admin-collect', 'admin');
      await makeActor(c.su, 'real-rider', 'rider');

      // An OPERATOR dispatches (B1's authorized widening)...
      const A = await mk({ estado: 'LISTO' });
      const dep = await startV2(c.svc, A, 'op-collect');
      assert('setup: operator departure succeeded', dep.ok === true, dep);
      const row = await tripRow(dep.trip_id);
      assert('setup: rider_actor is NULL (operator dispatched, not a rider)', row.rider_actor === null, row);

      // ...but neither the SAME operator nor an unrelated admin may collect/complete it.
      const rOp = await collect(c.svc, A.id, 'op-collect', { idem: 'op-try' });
      assert('COMPLETION_PATH: the dispatching OPERATOR still cannot collect/complete -> AUTH_FORBIDDEN_ROLE',
        rOp.ok === false && rOp.code === 'AUTH_FORBIDDEN_ROLE', rOp);
      const rAdmin = await collect(c.svc, A.id, 'admin-collect', { idem: 'admin-try' });
      assert('COMPLETION_PATH: an unrelated ADMIN still cannot collect/complete -> AUTH_FORBIDDEN_ROLE',
        rAdmin.ok === false && rAdmin.code === 'AUTH_FORBIDDEN_ROLE', rAdmin);

      // The REAL rider (never dispatched, no identity match required -- membership-based)
      // CAN complete a stop an operator departed. This is the pre-existing, unchanged
      // rider_collect_and_complete_stop contract; B1 must not have disturbed it.
      const rRider = await collect(c.svc, A.id, 'real-rider', { idem: 'rider-try' });
      assert('COMPLETION_PATH: the REAL rider (membership-based, not identity-matched) CAN complete a stop an operator departed',
        rRider.ok === true && rRider.code === 'OK', rRider);
    } finally { await c.close(); }
  }

  // ── 6. close_rider_trip fails closed until every member is independently
  //       confirmed -- the canonical action the operator "Driver de vuelta" control now
  //       calls instead of marcarEntregado (FE fix, same packet; not modified by 137,
  //       proven here unchanged and already correct for the operator-dispatch case). ────
  // language-guard: allow-legacy chiudiGiro is the existing legacy-action name for close_rider_trip, cited throughout this scenario for context, not new vocabulary
  section('B1 completion path -- close_rider_trip (operator "driver back") fails closed until deliveries are rider-confirmed');
  {
    const c = await open(env, 'b1closeTrip');
    try {
      await ensureCaptureTrigger(c.su);
      const s = await c.fx.day('2026-09-17');
      const { mk, startV2, collect, close } = ctx(c, s);
      await makeActor(c.su, 'op-close', 'operator');
      await makeActor(c.su, 'rider-close', 'rider');

      const A = await mk({ estado: 'LISTO' });
      const dep = await startV2(c.svc, A, 'op-close');
      assert('setup: operator departure succeeded', dep.ok === true, dep);

      // Operator presses "Driver de vuelta" (close_rider_trip) BEFORE the rider confirmed delivery.
      const rEarly = await close(c.svc);
      assert('EARLY_CLOSE: operator cannot close the giro before the rider confirms delivery',
        rEarly.ok === false && (rEarly.code === 'EARLY_CLOSE' || rEarly.code === 'MISSING_TRIP_MEMBER'), rEarly);

      // Only the REAL rider's own completion legitimately unblocks it.
      const rCollect = await collect(c.svc, A.id, 'rider-close', { idem: 'close-flow' });
      assert('setup: real rider completes the delivery', rCollect.ok === true, rCollect);

      const rClose = await close(c.svc);
      assert('close_rider_trip (operator "driver back") succeeds once the rider has confirmed every delivery',
        rClose.ok === true && rClose.code === 'OK', rClose);
    } finally { await c.close(); }
  }
}

module.exports = { run };
