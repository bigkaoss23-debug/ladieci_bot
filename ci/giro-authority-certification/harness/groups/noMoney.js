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

    // W5 Packet 01 legitimately extends this invariant: detach_v1/dissolve_v1 now
    // bump GIRO_FACTS_SIGNAL on a real state change (by design -- section 9 of the
    // W5 Packet 01 runbook). Detected via the new command's presence rather than a
    // hardcoded epoch flag, mirroring every other forward-compatible guard adapted
    // in this codebase's history. When absent (pure W3 harness), the original
    // strict "zero config byte changes at all" assertion is unchanged.
    const w5Applied = (await c.su.query(
      "SELECT to_regprocedure('public.giro_authority_create_or_move_v1(uuid[],text,uuid,text,uuid[])') IS NOT NULL AS v"
    )).rows[0].v;
    const configExpr = w5Applied
      ? "(SELECT md5(COALESCE(string_agg(chiave || valore, ',' ORDER BY chiave), '')) FROM public.config WHERE chiave <> 'GIRO_FACTS_SIGNAL') AS config"
      : "(SELECT md5(COALESCE(string_agg(chiave || valore, ',' ORDER BY chiave), '')) FROM public.config) AS config";
    const signalExpr = w5Applied
      ? ", (SELECT (valore::jsonb->>'version')::bigint FROM public.config WHERE chiave = 'GIRO_FACTS_SIGNAL') AS signal_version"
      : ", NULL::bigint AS signal_version";
    const snap = async () => (await c.su.query(`SELECT
        (SELECT count(*) FROM fixture_audit.writes WHERE tbl <> 'config')::int AS audit,
        (SELECT string_agg(id || ':' || xmin::text, ',' ORDER BY id) FROM public.ordenes) AS xmins,
        (SELECT count(*) FROM public.order_obligations)::int AS obligations,
        (SELECT count(*) FROM public.order_financial_events)::int AS events,
        (SELECT count(*) FROM public.payment_transactions)::int AS payments,
        ${configExpr}${signalExpr}`)).rows[0];
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
    assert('zero statements against ordenes / order_entities / economic tables (config excluded, checked precisely below)',
      before.audit === after.audit, { before: before.audit, after: after.audit });
    assert('no new row version of any order (xmin unchanged)', before.xmins === after.xmins);
    assert('obligations / financial events / payments untouched',
      before.obligations === after.obligations && before.events === after.events && before.payments === after.payments);
    assert('config untouched except GIRO_FACTS_SIGNAL (W5 Packet 01\'s own authorized bump; DRIVER_STATO and every other key byte-identical)',
      before.config === after.config, { before: before.config, after: after.config });
    if (w5Applied) {
      // bigint columns come back from node-pg as strings; Number() them before
      // arithmetic (string + number would silently concatenate, not add).
      assert('GIRO_FACTS_SIGNAL bumped by exactly the number of real (non-idempotent) mutations in this window (detach + dissolve = 2)',
        Number(after.signal_version) === Number(before.signal_version) + 2,
        { before: before.signal_version, after: after.signal_version });
    }
  } finally {
    await c.close();
  }
}

module.exports = { run };
