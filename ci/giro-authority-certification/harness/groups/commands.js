'use strict';
// Giro Authority commands: create / attach / detach / explicit move / explicit dissolve /
// set+clear hora_ref. Refusals, idempotency, no implicit move, no capacity limit (N18).
const { section, assert, call } = require('../lib');
const { open } = require('./_ctx');

async function run(env) {
  section('COMMANDS — create/attach/detach/move/dissolve/hora_ref, refusals, idempotency, N18');
  const c = await open(env, 'commands');
  try {
    const D = '2026-09-14';
    const s = await c.fx.day(D);
    const sOther = await c.fx.day('2026-09-13', 'closed');
    const scope = [s];
    const mk = (o) => c.fx.order(c.svc, { session: s, ...o });
    const [A, B, C, Dd, E, F] = [await mk({ estado: 'LISTO' }), await mk({ estado: 'LISTO' }), await mk({}), await mk({}), await mk({}), await mk({})];
    const R = await mk({ delivery: 'PICKUP_FIXTURE' });
    const ts = (await c.su.query('INSERT INTO public.table_sessions (workspace_id) SELECT id FROM public.workspaces LIMIT 1 RETURNING id')).rows[0].id;
    const M = await mk({ table: ts });
    const P = await mk({ estado: 'POR_CONFIRMAR' });
    const X = await c.fx.order(c.svc, { session: sOther });
    const create = (uids, hora = null, anchor = null, actor = 'op-1', sc = scope) =>
      call(c.svc, 'giro_authority_create_v1', [uids, hora, anchor, actor, sc]);

    let r = await create([A.order_uid, B.order_uid], '9:05', A.order_uid);
    assert('create {A,B} -> OK', r.ok && r.code === 'OK', r);
    const G1 = r.giro_id;
    const row = (await c.su.query('SELECT * FROM public.manual_giros WHERE id = $1', [G1])).rows[0];
    assert('giro id keeps the legacy format mg_<yymmdd>_<seq>', G1 === 'mg_260914_1', G1);
    assert('hora_ref normalized 9:05 -> 09:05; business_date = giro_day = Business Day; anchor/audit set',
      row.hora_ref === '09:05' && row.created_by === 'op-1' && row.anchor_order_uid === A.order_uid &&
      row.business_date === D && row.giro_day === D, row);
    r = await create([B.order_uid, A.order_uid], '9:05', A.order_uid);
    assert('create replay (same set, any order) -> IDEMPOTENT same giro', r.ok && r.code === 'IDEMPOTENT' && r.giro_id === G1, r);
    r = await create([A.order_uid, C.order_uid]);
    assert('create with a member of an effective giro -> ORDER_ALREADY_IN_GIRO (never an implicit move)',
      !r.ok && r.code === 'ORDER_ALREADY_IN_GIRO', r);
    assert('...and A is still in G1', (await c.fx.membership()).find((m) => m.order_uid === A.order_uid).giro_id === G1);

    assert('create {C} -> INSUFFICIENT_MEMBERS', (await create([C.order_uid])).code === 'INSUFFICIENT_MEMBERS');
    assert('create {C,C} -> INSUFFICIENT_MEMBERS', (await create([C.order_uid, C.order_uid])).code === 'INSUFFICIENT_MEMBERS');
    const refusal = async (other, reason) => {
      const x = await create([C.order_uid, other.order_uid]);
      assert(`create with ${reason} -> ORDER_NOT_ELIGIBLE/${reason}`, !x.ok && x.code === 'ORDER_NOT_ELIGIBLE' && x.reason === reason, x);
    };
    await refusal(R, 'NOT_DOMICILIO');
    await refusal(M, 'TABLE_ORDER');
    await refusal(P, 'NOT_OPERATIVE_STATE');
    await refusal(X, 'OUT_OF_SCOPE');
    r = await create([C.order_uid, '00000000-0000-0000-0000-000000000001']);
    assert('create with an unknown order -> ORDER_NOT_FOUND', r.code === 'ORDER_NOT_FOUND', r);
    assert('create with hora_ref 25:00 -> INVALID_INPUT', (await create([C.order_uid, Dd.order_uid], '25:00')).code === 'INVALID_INPUT');
    assert('create with empty actor -> INVALID_INPUT', (await create([C.order_uid, Dd.order_uid], null, null, ' ')).code === 'INVALID_INPUT');
    assert('create with anchor outside the set -> INVALID_INPUT', (await create([C.order_uid, Dd.order_uid], null, A.order_uid)).code === 'INVALID_INPUT');
    for (const [label, sc] of [['NULL', null], ['empty', []], ['[NULL]', [null]]]) {
      assert(`create with scope ${label} -> SCOPE_UNAVAILABLE`, (await create([C.order_uid, Dd.order_uid], null, null, 'op-1', sc)).code === 'SCOPE_UNAVAILABLE');
    }

    const attach = (g, o) => call(c.svc, 'giro_authority_attach_v1', [g, o.order_uid, 'op-2', scope]);
    assert('attach C to G1 -> OK', (await attach(G1, C)).code === 'OK');
    assert('attach C to G1 again -> IDEMPOTENT', (await attach(G1, C)).code === 'IDEMPOTENT');
    assert('attach D to G1 -> OK', (await attach(G1, Dd)).code === 'OK');
    r = await create([E.order_uid, F.order_uid]);
    const G2 = r.giro_id;
    assert('create {E,F} -> G2 with seq 2', r.ok && G2 === 'mg_260914_2', r);
    r = await attach(G2, C);
    assert('attach C (effective in G1) to G2 -> ORDER_ALREADY_IN_GIRO', r.code === 'ORDER_ALREADY_IN_GIRO' && r.giro_id === G1, r);

    const move = (o, g) => call(c.svc, 'giro_authority_move_v1', [o.order_uid, g, 'op-3', scope]);
    r = await move(C, G2);
    assert('explicit move C: G1 -> G2 -> OK', r.ok && r.code === 'OK' && r.from_giro_id === G1 && r.to_giro_id === G2, r);
    assert('move again to the same giro -> IDEMPOTENT', (await move(C, G2)).code === 'IDEMPOTENT');
    assert('move of an order in no giro -> ORDER_NOT_IN_GIRO', (await move(P, G2)).code === 'ORDER_NOT_IN_GIRO');

    const detach = (o) => call(c.svc, 'giro_authority_detach_v1', [o.order_uid, 'op-4', scope]);
    r = await detach(Dd);
    assert('detach D from G1 {A,B,D} -> OK, G1 stays PLANNED', r.code === 'OK' && r.giro_state_after === 'PLANNED', r);
    r = await detach(Dd);
    assert('detach D again -> IDEMPOTENT NOT_A_MEMBER', r.code === 'IDEMPOTENT' && r.reason === 'NOT_A_MEMBER', r);
    r = await detach(B);
    assert('detach B -> G1 has one member -> DISSOLVED (derived, no write)', r.code === 'OK' && r.giro_state_after === 'DISSOLVED', r);
    const g1row = (await c.su.query('SELECT dissolved_at FROM public.manual_giros WHERE id = $1', [G1])).rows[0];
    assert('derived dissolution never writes dissolved_at', g1row.dissolved_at === null);
    assert('attach to a derived-DISSOLVED giro -> GIRO_NOT_PLANNED', (await attach(G1, Dd)).code === 'GIRO_NOT_PLANNED');
    r = await detach(A);
    assert('detach of a non-effective member -> IDEMPOTENT NOT_EFFECTIVE', r.code === 'IDEMPOTENT' && r.reason === 'NOT_EFFECTIVE', r);
    r = await create([A.order_uid, Dd.order_uid]);
    assert('A (only in dissolved G1) is free: create {A,D} -> OK (non-effective row replaced)', r.ok && r.code === 'OK', r);
    const G3 = r.giro_id;

    const hora = (g, h) => call(c.svc, 'giro_authority_set_hora_ref_v1', [g, h, 'op-5', scope]);
    r = await hora(G3, '21:10');
    assert('set hora_ref 21:10 -> OK, salida 21:10 OPERATOR', r.code === 'OK' && r.salida === '21:10' && r.salida_source === 'OPERATOR', r);
    assert('same hora_ref -> IDEMPOTENT', (await hora(G3, '21:10')).code === 'IDEMPOTENT');
    r = await hora(G3, '');
    assert('clear hora_ref -> OK, salida falls back to PROXY_MAX_FORNO', r.code === 'OK' && r.salida_source === 'PROXY_MAX_FORNO', r);
    assert('hora_ref "ab" -> INVALID_INPUT', (await hora(G3, 'ab')).code === 'INVALID_INPUT');

    const dissolve = (g) => call(c.svc, 'giro_authority_dissolve_v1', [g, 'op-6', scope]);
    assert('dissolve G2 -> OK', (await dissolve(G2)).code === 'OK');
    const g2row = (await c.su.query('SELECT dissolved_at, dissolved_by FROM public.manual_giros WHERE id = $1', [G2])).rows[0];
    assert('explicit dissolve records dissolved_at/dissolved_by (audit)', g2row.dissolved_at !== null && g2row.dissolved_by === 'op-6', g2row);
    assert('dissolve G2 again -> IDEMPOTENT', (await dissolve(G2)).code === 'IDEMPOTENT');
    assert('attach to an explicitly dissolved giro -> GIRO_NOT_PLANNED', (await attach(G2, B)).code === 'GIRO_NOT_PLANNED');
    assert('set hora_ref on a dissolved giro -> GIRO_NOT_PLANNED', (await hora(G2, '22:00')).code === 'GIRO_NOT_PLANNED');
    assert('dissolve unknown giro -> GIRO_NOT_FOUND', (await dissolve('mg_000000_9')).code === 'GIRO_NOT_FOUND');
    assert('attach to unknown giro -> GIRO_NOT_FOUND', (await attach('mg_000000_9', B)).code === 'GIRO_NOT_FOUND');

    await c.fx.driverStato('{not json');
    r = await attach(G3, B);
    assert('unreadable DRIVER_STATO -> UNVERIFIABLE (fail closed)', r.code === 'UNVERIFIABLE' && r.reason === 'DRIVER_STATO_UNPARSEABLE', r);
    await c.fx.driverStato({});

    // Departure: the real start_rider_trip (unchanged, W3) moves A out; G3 becomes IN_TRIP.
    await c.fx.setEstado(Dd.id, 'LISTO');
    const trip = (await c.svc.query('SELECT public.start_rider_trip($1) AS r', [A.id])).rows[0].r;
    assert('real start_rider_trip starts a trip with A', trip.ok === true, trip);
    const newbie = await mk({});
    assert('attach to an IN_TRIP giro -> GIRO_DEPARTED', (await attach(G3, newbie)).code === 'GIRO_DEPARTED');
    assert('dissolve an IN_TRIP giro -> GIRO_DEPARTED', (await dissolve(G3)).code === 'GIRO_DEPARTED');
    assert('set hora_ref on an IN_TRIP giro -> GIRO_DEPARTED', (await hora(G3, '22:00')).code === 'GIRO_DEPARTED');
    r = await detach(Dd);
    assert('D (LISTO, left out of the snapshot) is released: detach -> IDEMPOTENT NOT_EFFECTIVE', r.code === 'IDEMPOTENT' && r.reason === 'NOT_EFFECTIVE', r);

    // N18: no authoritative capacity exists, so the Authority never refuses on size.
    const big = [];
    for (let i = 0; i < 8; i++) big.push(await mk({}));
    r = await create(big.slice(0, 7).map((o) => o.order_uid));
    assert('N18: create a 7-member giro -> OK (heuristic capacity is never a hard block)', r.ok && r.code === 'OK', r);
    assert('N18: attach an 8th member -> OK', (await attach(r.giro_id, big[7])).code === 'OK');

    const legacy = (await c.su.query(`SELECT
        (SELECT count(*) FROM public.manual_giros WHERE salida_ref IS NOT NULL OR plan_source IS NOT NULL OR computed_at IS NOT NULL)::int AS salida,
        (SELECT count(*) FROM public.ordenes WHERE manual_giro_id IS NOT NULL)::int AS raw`)).rows[0];
    assert('no salida_ref/plan_source/computed_at ever written', legacy.salida === 0);
    assert('no raw ordenes.manual_giro_id ever written', legacy.raw === 0);
  } finally {
    await c.close();
  }
}

module.exports = { run };
