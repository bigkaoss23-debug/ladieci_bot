'use strict';
// N14 — no monetary (or order) effect: the full command set + consume + projection write
// nothing to ordenes, order_entities, config or the economic tables, and create no new
// row version of any order (xmin unchanged; FOR SHARE only touches the lock bits).
const rt = require('../pgRuntime');
const { section, assert, call, intentInput } = require('../lib');
const { open } = require('./_ctx');

async function run(env) {
  section('N14 NO MONEY — zero writes to ordenes / economic / config across every Authority call');
  const c = await open(env, 'nomoney');
  try {
    await rt.applyAsPostgres(c.su, 'candidate/giro_intent_capture_trigger_v1.W5_DORMANT.sql');
    const s = await c.fx.day('2026-09-14');
    const scope = [s];
    const mk = (o) => c.fx.order(c.svc, { session: s, ...o });
    const [A, B, C, D, E, F] = [await mk({}), await mk({}), await mk({}), await mk({}), await mk({}), await mk({})];
    const G0 = (await call(c.svc, 'giro_authority_create_v1', [[E.order_uid, F.order_uid], null, null, 'op', scope])).giro_id;
    const X = await mk({ estado: 'POR_CONFIRMAR', intent: intentInput('GIRO', G0) });
    const Y = await mk({ estado: 'POR_CONFIRMAR', intent: intentInput('ANCHOR', D.id) });
    for (const o of [X, Y]) await c.fx.setEstado(o.id, 'EN_COCINA');

    const snap = async () => (await c.su.query(`SELECT
        (SELECT max(id) FROM fixture_audit.writes) AS audit,
        (SELECT string_agg(id || ':' || xmin::text, ',' ORDER BY id) FROM public.ordenes) AS xmins,
        (SELECT count(*) FROM public.order_obligations)::int AS obligations,
        (SELECT count(*) FROM public.order_financial_events)::int AS events,
        (SELECT count(*) FROM public.payment_transactions)::int AS payments,
        (SELECT md5(COALESCE(string_agg(chiave || valore, ',' ORDER BY chiave), '')) FROM public.config) AS config`)).rows[0];
    const before = await snap();

    const outs = [];
    const G = (await call(c.svc, 'giro_authority_create_v1', [[A.order_uid, B.order_uid], '21:00', A.order_uid, 'op', scope]));
    outs.push(G);
    outs.push(await call(c.svc, 'giro_authority_attach_v1', [G.giro_id, C.order_uid, 'op', scope]));
    outs.push(await call(c.svc, 'giro_authority_set_hora_ref_v1', [G.giro_id, '21:15', 'op', scope]));
    outs.push(await call(c.svc, 'giro_authority_move_v1', [C.order_uid, G0, 'op', scope]));
    outs.push(await call(c.svc, 'giro_authority_detach_v1', [C.order_uid, 'op', scope]));
    outs.push(await call(c.svc, 'giro_authority_consume_intent_v1', [X.order_uid, 'op', scope]));
    outs.push(await call(c.svc, 'giro_authority_consume_intent_v1', [Y.order_uid, 'op', scope]));
    outs.push(await call(c.svc, 'giro_authority_consume_intent_v1', [Y.order_uid, 'op', scope]));
    outs.push(await call(c.svc, 'giro_authority_dissolve_v1', [G.giro_id, 'op', scope]));
    await call(c.svc, 'giro_projection_v1', [scope]);
    const after = await snap();

    assert('every command in the window succeeded (the window is meaningful)',
      outs.every((o) => o.ok === true && ['OK', 'CONSUMED'].includes(o.code) || o.replay === true), outs.map((o) => o.code));
    assert('zero statements against ordenes / order_entities / config / economic tables', before.audit === after.audit,
      { before: before.audit, after: after.audit });
    assert('no new row version of any order (xmin unchanged)', before.xmins === after.xmins);
    assert('obligations / financial events / payments untouched',
      before.obligations === after.obligations && before.events === after.events && before.payments === after.payments);
    assert('config (DRIVER_STATO) untouched', before.config === after.config);
  } finally {
    await c.close();
  }
}

module.exports = { run };
