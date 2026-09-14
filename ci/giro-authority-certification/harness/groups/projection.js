'use strict';
// The ONE projection: derived state machine, salida, cancellation/delete (N07),
// service closed (N08), after midnight (N09), degraded reads, payload hygiene.
const { section, assert, call, sortUids } = require('../lib');
const { open } = require('./_ctx');

const byId = (p, g) => p.giros.find((x) => x.giro_id === g);
const members = (p, g) => sortUids((byId(p, g) || { effective_members: [] }).effective_members.map((m) => m.order_uid));
const effOf = (p, uid) => (p.orders.find((o) => o.order_uid === uid) || {}).effective_giro_id || null;

async function run(env) {
  section('PROJECTION — derived states, salida, N07 cancel/delete, N08 closed scope, N09 after midnight, degraded');
  const c = await open(env, 'projection');
  try {
    const s = await c.fx.day('2026-09-14');
    const scope = [s];
    const mk = (o) => c.fx.order(c.svc, { session: s, ...o });
    const create = async (orders, hora = null) =>
      (await call(c.svc, 'giro_authority_create_v1', [orders.map((o) => o.order_uid), hora, null, 'op-1', scope])).giro_id;
    const proj = (sc = scope) => call(c.svc, 'giro_projection_v1', [sc]);

    const A = await mk({ forno: '20:40' });
    const B = await mk({ forno: '21:18' });
    const GA = await create([A, B], '21:10');
    let p = await proj();
    assert('PLANNED with both members effective', byId(p, GA).giro_state === 'PLANNED' &&
      JSON.stringify(members(p, GA)) === JSON.stringify(sortUids([A.order_uid, B.order_uid])));
    assert('hora_ref 21:10 prevails over forno 21:18 -> salida 21:10 OPERATOR (TB-1 case 11)',
      byId(p, GA).salida === '21:10' && byId(p, GA).salida_source === 'OPERATOR', byId(p, GA));
    await call(c.svc, 'giro_authority_set_hora_ref_v1', [GA, null, 'op-1', scope]);
    p = await proj();
    assert('hora_ref cleared -> salida 21:18 PROXY_MAX_FORNO', byId(p, GA).salida === '21:18' && byId(p, GA).salida_source === 'PROXY_MAX_FORNO');

    const Cn = await mk({ forno: '23:55' });
    const Dn = await mk({ forno: '00:10' });
    const GN = await create([Cn, Dn]);
    await c.su.query("UPDATE public.manual_giros SET created_at = '2026-09-14 23:50+02' WHERE id = $1", [GN]);
    p = await proj();
    assert('N09: giro of Business Day 2026-09-14 visible in its scope regardless of the calendar day', !!byId(p, GN) && byId(p, GN).giro_state === 'PLANNED');
    assert('N09: salida is the service-day max (00:10 after 23:55), not the clock max', byId(p, GN).salida === '00:10', byId(p, GN));
    assert('N09: business_date stays 2026-09-14', byId(p, GN).business_date === '2026-09-14');

    const E = await mk({});
    const F = await mk({});
    const GC = await create([E, F]);
    await c.fx.setEstado(F.id, 'CANCELADO');
    p = await proj();
    assert('N07 cancel: 2-member giro with one cancelled -> DISSOLVED/BELOW_MIN_MEMBERS', byId(p, GC).giro_state === 'DISSOLVED' &&
      byId(p, GC).state_reason === 'BELOW_MIN_MEMBERS');
    assert('N07 cancel: survivor E is single (no effective giro)', effOf(p, E.order_uid) === null);

    const H = await mk({ forno: '20:00' });
    const I = await mk({ forno: '20:10' });
    const J = await mk({ forno: '20:50' });
    const GD = await create([H, I, J]);
    await c.svc.query('DELETE FROM public.ordenes WHERE id = $1', [J.id]);
    p = await proj();
    assert('N07 EC-F2 delete: 3-member giro minus a hard-deleted order -> PLANNED with 2', byId(p, GD).giro_state === 'PLANNED' &&
      JSON.stringify(members(p, GD)) === JSON.stringify(sortUids([H.order_uid, I.order_uid])));
    assert('N07 EC-F2 delete: salida recomputed from the survivors (20:10)', byId(p, GD).salida === '20:10', byId(p, GD));
    await c.svc.query('DELETE FROM public.ordenes WHERE id = $1', [I.id]);
    p = await proj();
    assert('N07 EC-F2 delete: down to 1 -> DISSOLVED', byId(p, GD).giro_state === 'DISSOLVED');

    const K = await mk({ estado: 'LISTO', forno: '21:30' });
    const L = await mk({});
    const GT = await create([K, L]);
    const trip = (await c.svc.query('SELECT public.start_rider_trip($1) AS r', [K.id])).rows[0].r;
    p = await proj();
    const snap = trip.snapshot.order_ids;
    assert('IN_TRIP after the real start_rider_trip', byId(p, GT).giro_state === 'IN_TRIP');
    assert('IN_TRIP effective members are exactly the snapshot members (K); L released',
      JSON.stringify(members(p, GT)) === JSON.stringify([K.order_uid]) && snap.includes(K.id) && effOf(p, L.order_uid) === null);
    await c.fx.setEstado(K.id, 'RETIRADO');
    const closed = (await c.svc.query('SELECT public.close_rider_trip(NULL) AS r')).rows[0].r;
    p = await proj();
    assert('DONE after the stop is delivered and the real close_rider_trip closes', closed.ok === true && byId(p, GT).giro_state === 'DONE', closed);
    assert('DONE is never returned as operative (effective members = delivered only)',
      JSON.stringify(members(p, GT)) === JSON.stringify([K.order_uid]));

    await call(c.svc, 'giro_authority_dissolve_v1', [GN, 'op-9', scope]);
    p = await proj();
    assert('explicit dissolve -> DISSOLVED/EXPLICIT with audit fields', byId(p, GN).giro_state === 'DISSOLVED' &&
      byId(p, GN).state_reason === 'EXPLICIT' && byId(p, GN).dissolved_by === 'op-9');

    // salida NONE: no hora_ref and no usable forno_out; a DISSOLVED giro never carries one.
    const N1 = await mk({ forno: null });
    const N2 = await mk({ forno: 'xx' });
    const GNone = await create([N1, N2]);
    p = await proj();
    assert('salida NONE when no hora_ref and no valid forno_out (PLANNED, salida null)',
      byId(p, GNone).giro_state === 'PLANNED' && byId(p, GNone).salida === null && byId(p, GNone).salida_source === 'NONE', byId(p, GNone));
    assert('a DISSOLVED giro never carries a salida (NONE)', byId(p, GC).salida === null && byId(p, GC).salida_source === 'NONE', byId(p, GC));

    // A member outside the operational scope is never effective (same Business Day, two sessions).
    const s2 = await c.fx.day('2026-09-14');
    const O1 = await mk({});
    const O2 = await c.fx.order(c.svc, { session: s2 });
    const O3 = await c.fx.order(c.svc, { session: s2 });
    const GS = (await call(c.svc, 'giro_authority_create_v1',
      [[O1.order_uid, O2.order_uid, O3.order_uid], null, null, 'op-1', [s, s2]])).giro_id;
    p = await proj([s2]);
    assert('out-of-scope member: scope {s2} -> PLANNED with the two in-scope members only',
      byId(p, GS).giro_state === 'PLANNED' && JSON.stringify(members(p, GS)) === JSON.stringify(sortUids([O2.order_uid, O3.order_uid])), byId(p, GS));
    assert('out-of-scope member: the order of the other session has no effective giro', effOf(p, O1.order_uid) === null);
    p = await proj([s]);
    assert('out-of-scope member: scope {s} -> one member in scope -> DISSOLVED/SERVICE_CLOSED',
      byId(p, GS).giro_state === 'DISSOLVED' && byId(p, GS).state_reason === 'SERVICE_CLOSED', byId(p, GS));

    const sNext = await c.fx.day('2026-09-14', 'open');
    await c.su.query("UPDATE public.service_sessions SET status = 'closed' WHERE id = $1", [s]);
    p = await proj([sNext]);
    assert('N08: scope without the closed session -> zero PLANNED giros', p.giros.every((g) => g.giro_state !== 'PLANNED'), p.giros.map((g) => g.giro_state));
    assert('N08: the operative giro of the closed session reads DISSOLVED/SERVICE_CLOSED', byId(p, GA).state_reason === 'SERVICE_CLOSED', byId(p, GA));

    await c.fx.driverStato('{broken');
    p = await proj();
    assert('degraded: unreadable DRIVER_STATO -> trip_facts_available=false, degraded=true, reason listed',
      p.trip_facts_available === false && p.degraded === true && p.reasons.includes('TRIP_FACTS_UNAVAILABLE'));
    await c.fx.driverStato({});
    p = await proj(null);
    assert('invalid scope -> scope_valid=false and no giros (never a silent "no giro")', p.scope_valid === false && p.giros.length === 0);

    p = await proj();
    const text = JSON.stringify(p);
    assert('payload never carries manual_giro_id / pending_giro_intent / fingerprint / capture context / actor',
      !/manual_giro_id|pending_giro_intent|target_fingerprint|order_context|"actor"/.test(text));
    const before = (await c.su.query('SELECT count(*)::int AS n FROM fixture_audit.writes')).rows[0].n;
    await proj();
    const after = (await c.su.query('SELECT count(*)::int AS n FROM fixture_audit.writes')).rows[0].n;
    assert('the projection writes nothing', before === after);
  } finally {
    await c.close();
  }
}

module.exports = { run };
