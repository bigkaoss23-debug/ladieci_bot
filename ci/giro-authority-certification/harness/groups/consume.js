'use strict';
// Consume: N01-lite, N03 (idempotent under parallel calls), N04 (stale target), N05
// (departed target), N08 (service closed -> EXPIRED), N12 (unverifiable -> fail closed),
// every consume code, and the one-shot guard.
const rt = require('../pgRuntime');
const { section, assert, sqlstate, call, intentInput, sortUids } = require('../lib');
const { open } = require('./_ctx');

const logical = (r) => JSON.stringify({ s: r.status, c: r.resolution_code, g: r.resulting_giro_id, t: r.resolved_at });

async function run(env) {
  section('CONSUME — N01-lite, N03, N04, N05, N08, N12, codes, one-shot guard');
  const c = await open(env, 'consume');
  try {
    await rt.applyAsPostgres(c.su, 'candidate/giro_intent_capture_trigger_v1.W5_DORMANT.sql');
    const s = await c.fx.day('2026-09-14');
    const scope = [s];
    const mk = (o) => c.fx.order(c.svc, { session: s, ...o });
    const create = async (orders) =>
      (await call(c.svc, 'giro_authority_create_v1', [orders.map((o) => o.order_uid), null, null, 'op-1', scope])).giro_id;
    const consume = (o, sc = scope, cl = c.svc) => call(cl, 'giro_authority_consume_intent_v1', [o.order_uid, 'op-k', sc]);
    const kitchen = (o) => c.fx.setEstado(o.id, 'EN_COCINA');
    const withIntent = (kind, ref, o = {}) => mk({ estado: 'POR_CONFIRMAR', intent: intentInput(kind, ref), ...o });
    const proj = (sc = scope) => call(c.svc, 'giro_projection_v1', [sc]);

    // N01-lite: Q5 anchor; Q2 -> ANCHOR Q5; Q1 -> GIRO; one giro {Q5,Q2,Q1}, no split.
    const Q5 = await mk({ zona: 'Q5' });
    const Q2 = await withIntent('ANCHOR', Q5.id, { zona: 'Q2' });
    let r = await consume(Q2);
    assert('consume before the first kitchen entry -> NOT_YET_OPERATIVE, intent stays PENDING',
      r.code === 'NOT_YET_OPERATIVE' && (await c.fx.intent(Q2.order_uid)).status === 'PENDING', r);
    await kitchen(Q2);
    r = await consume(Q2);
    assert('Q2 ANCHOR Q5 -> CONSUMED GIRO_CREATED', r.status === 'CONSUMED' && r.resolution_code === 'GIRO_CREATED' && !r.replay, r);
    const GQ = r.resulting_giro_id;
    const gq = (await c.su.query('SELECT anchor_order_uid FROM public.manual_giros WHERE id = $1', [GQ])).rows[0];
    assert('the created giro records Q5 as anchor_order_uid (audit)', gq.anchor_order_uid === Q5.order_uid);
    const Q1 = await withIntent('GIRO', GQ, { zona: 'Q1' });
    await kitchen(Q1);
    r = await consume(Q1);
    assert('Q1 GIRO -> CONSUMED ATTACHED', r.status === 'CONSUMED' && r.resolution_code === 'ATTACHED' && r.resulting_giro_id === GQ, r);
    let p = await proj();
    const gp = p.giros.find((g) => g.giro_id === GQ);
    assert('N01-lite: exactly one giro {Q5,Q2,Q1}, PLANNED, no split',
      gp.giro_state === 'PLANNED' && JSON.stringify(sortUids(gp.effective_members.map((m) => m.order_uid))) ===
        JSON.stringify(sortUids([Q5.order_uid, Q2.order_uid, Q1.order_uid])));

    // N03: 8 parallel consumes of the same order.
    const a = await mk({});
    const b = await mk({});
    const GN3 = await create([a, b]);
    const W = await withIntent('GIRO', GN3);
    await kitchen(W);
    const clients = [];
    for (let i = 0; i < 8; i++) clients.push(await c.client('service_role', `w3-n03-${i}`));
    const outs = await Promise.all(clients.map((cl) => consume(W, scope, cl)));
    const firsts = outs.filter((o) => o.replay === false);
    assert('N03: 8 parallel consumes -> exactly one non-replay CONSUMED', firsts.length === 1 && firsts[0].status === 'CONSUMED', outs);
    assert('N03: all 8 outcomes logically identical', outs.every((o) => logical(o) === logical(firsts[0])));
    const again = [await consume(W), await consume(W), await consume(W)];
    assert('N03: sequential retries replay the identical outcome', again.every((o) => o.replay === true && logical(o) === logical(firsts[0])));
    const wm = (await c.fx.membership()).filter((m) => m.order_uid === W.order_uid);
    assert('N03: exactly one membership row for the order', wm.length === 1 && wm[0].giro_id === GN3);

    // N04 GIRO: target membership changed after capture.
    const c1 = await mk({});
    const d1 = await mk({});
    const G2 = await create([c1, d1]);
    const X = await withIntent('GIRO', G2);
    const Y = await mk({});
    await call(c.svc, 'giro_authority_attach_v1', [G2, Y.order_uid, 'op-1', scope]);
    await kitchen(X);
    r = await consume(X);
    assert('N04: stale GIRO target -> REJECTED TARGET_CHANGED', r.status === 'REJECTED' && r.resolution_code === 'TARGET_CHANGED', r);
    p = await proj();
    assert('N04: the other giro is untouched {c,d,Y}', JSON.stringify(sortUids(p.giros.find((g) => g.giro_id === G2).effective_members.map((m) => m.order_uid))) ===
      JSON.stringify(sortUids([c1.order_uid, d1.order_uid, Y.order_uid])));
    // N04 ANCHOR: the anchor entered another giro before consume.
    const e1 = await mk({});
    const f1 = await mk({});
    const X2 = await withIntent('ANCHOR', e1.id);
    const GEF = await create([e1, f1]);
    await kitchen(X2);
    r = await consume(X2);
    assert('N04: anchor now in another giro -> REJECTED TARGET_CHANGED', r.resolution_code === 'TARGET_CHANGED', r);
    p = await proj();
    assert('N04: that giro keeps {e,f}; X2 stays single', p.giros.find((g) => g.giro_id === GEF).effective_members.length === 2 &&
      !p.orders.some((o) => o.order_uid === X2.order_uid));

    // N05: departed targets.
    const g1 = await mk({ estado: 'LISTO' });
    const h1 = await mk({ estado: 'LISTO' });
    const G3 = await create([g1, h1]);
    const Z = await withIntent('GIRO', G3);
    const trip = (await c.svc.query('SELECT public.start_rider_trip($1) AS r', [g1.id])).rows[0].r;
    await kitchen(Z);
    r = await consume(Z);
    assert('N05: GIRO target departed (real start_rider_trip) -> REJECTED TARGET_DEPARTED', trip.ok && r.resolution_code === 'TARGET_DEPARTED', r);
    const k1 = await mk({});
    const Z2 = await withIntent('ANCHOR', k1.id);
    await c.fx.setEstado(k1.id, 'EN_ENTREGA');
    await kitchen(Z2);
    assert('N05: ANCHOR departed -> REJECTED TARGET_DEPARTED', (await consume(Z2)).resolution_code === 'TARGET_DEPARTED');

    // Other codes.
    const oc = await withIntent('GIRO', GQ, { zona: 'Q3' });
    await c.su.query("UPDATE public.ordenes SET zona = 'Q4', estado = 'EN_COCINA' WHERE id = $1", [oc.id]);
    assert('order zona changed after capture -> REJECTED ORDER_CHANGED', (await consume(oc)).resolution_code === 'ORDER_CHANGED');
    const cx = await withIntent('GIRO', GQ);
    await c.fx.setEstado(cx.id, 'CANCELADO');
    assert('cancelled order -> REJECTED ORDER_NOT_ELIGIBLE', (await consume(cx)).resolution_code === 'ORDER_NOT_ELIGIBLE');
    const dx = await withIntent('GIRO', GQ);
    await c.svc.query('DELETE FROM public.ordenes WHERE id = $1', [dx.id]);
    r = await consume(dx);
    assert('hard-deleted order -> REJECTED ORDER_NOT_ELIGIBLE (intent survives, keyed on order_uid)', r.resolution_code === 'ORDER_NOT_ELIGIBLE', r);
    const m1 = await mk({});
    const m2 = await mk({});
    const GD = await create([m1, m2]);
    const tg = await withIntent('GIRO', GD);
    await call(c.svc, 'giro_authority_dissolve_v1', [GD, 'op-1', scope]);
    await kitchen(tg);
    assert('dissolved GIRO target -> REJECTED TARGET_GONE', (await consume(tg)).resolution_code === 'TARGET_GONE');
    const an = await mk({});
    const ta = await withIntent('ANCHOR', an.id);
    await c.fx.setEstado(an.id, 'CANCELADO');
    await kitchen(ta);
    assert('cancelled anchor -> REJECTED TARGET_GONE', (await consume(ta)).resolution_code === 'TARGET_GONE');
    const n1 = await mk({});
    assert('order without intent -> NO_INTENT', (await consume(n1)).code === 'NO_INTENT');
    const am = await withIntent('GIRO', GQ);
    await kitchen(am);
    await call(c.svc, 'giro_authority_attach_v1', [GQ, am.order_uid, 'op-1', scope]);
    r = await consume(am);
    assert('operator already attached it to the target -> CONSUMED ATTACHED', r.status === 'CONSUMED' && r.resulting_giro_id === GQ, r);
    const ao = await withIntent('GIRO', GQ);
    await kitchen(ao);
    const o2 = await mk({});
    await create([ao, o2]);
    r = await consume(ao);
    assert('order grouped elsewhere by the operator -> REJECTED ORDER_CHANGED', r.resolution_code === 'ORDER_CHANGED', r);

    // N12 unverifiable -> fail closed, materialized.
    const u1 = await withIntent('GIRO', GQ);
    await kitchen(u1);
    r = await consume(u1, null);
    assert('N12: scope unavailable -> REJECTED SCOPE_UNAVAILABLE', r.status === 'REJECTED' && r.resolution_code === 'SCOPE_UNAVAILABLE', r);
    assert('N12: the replay returns the same SCOPE_UNAVAILABLE outcome', logical(await consume(u1)) === logical(r));
    const u2 = await withIntent('GIRO', GQ);
    await kitchen(u2);
    await c.fx.driverStato('{broken');
    assert('N12: DRIVER_STATO unreadable -> REJECTED UNVERIFIABLE', (await consume(u2)).resolution_code === 'UNVERIFIABLE');
    await c.fx.driverStato({});

    // N08: service closed -> EXPIRED (materialized by consume, derived by the projection).
    const e8 = await withIntent('GIRO', GQ);
    const p8 = await withIntent('GIRO', GQ);
    await kitchen(e8);
    const sNext = await c.fx.day('2026-09-14');
    r = await consume(e8, [sNext]);
    assert('N08: consume outside the operational scope -> EXPIRED SERVICE_CLOSED', r.status === 'EXPIRED' && r.resolution_code === 'SERVICE_CLOSED', r);
    p = await proj([sNext]);
    const pi = p.intents.find((i) => i.order_uid === p8.order_uid);
    assert('N08: a never-consumed PENDING intent reads EXPIRED/SERVICE_CLOSED in the projection',
      pi && pi.stored_status === 'PENDING' && pi.effective_status === 'EXPIRED' && pi.effective_code === 'SERVICE_CLOSED', pi);
    assert('N08: zero PLANNED giros in the closed-scope projection', p.giros.every((g) => g.giro_state !== 'PLANNED'));

    // One-shot guard (fires even for the owner / superuser).
    assert('resolved intent cannot go back to PENDING (GIRO_INTENT_ALREADY_RESOLVED)',
      await sqlstate(c.su, "UPDATE giro_authority.giro_intents SET status = 'PENDING' WHERE order_uid = $1", [W.order_uid]) === 'P0001');
    assert('intents are append-only (GIRO_INTENT_APPEND_ONLY)',
      await sqlstate(c.su, 'DELETE FROM giro_authority.giro_intents WHERE order_uid = $1', [W.order_uid]) === 'P0001');
    assert('capture facts immutable even while PENDING (GIRO_INTENT_CAPTURE_FACTS_IMMUTABLE)',
      await sqlstate(c.su, "UPDATE giro_authority.giro_intents SET target_ref = 'x' WHERE order_uid = $1", [p8.order_uid]) === 'P0001');
  } finally {
    await c.close();
  }
}

module.exports = { run };
