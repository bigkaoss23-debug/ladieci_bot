'use strict';
// N15 — intent capture. The W5 trigger artifact is installed ONLY in this throwaway
// database. Proves: input NULL in RETURNING, at rest and in the WAL; PENDING / REJECTED
// CAPTURE_* for every input; CAPTURE_INTERNAL on a fault; order created even when the
// diagnostic write itself fails; no UPDATE on ordenes; last BEFORE INSERT trigger.
const rt = require('../pgRuntime');
const { section, assert, call, intentInput } = require('../lib');
const { open } = require('./_ctx');

async function run(env) {
  section('N15 CAPTURE — dormant W5 trigger in the ephemeral DB only; best-effort, never blocks the order');
  const c = await open(env, 'capture');
  try {
    let err = null;
    try { await rt.applyAsPostgres(c.su, 'candidate/giro_intent_capture_trigger_v1.W5_DORMANT.sql'); } catch (e) { err = e; }
    assert('W5 artifact installs (guards + post-condition: last BEFORE INSERT)', !err, err && err.message);
    const trg = (await c.su.query(`
      SELECT t.tgname, pg_get_triggerdef(t.oid) AS def FROM pg_trigger t
       WHERE t.tgrelid = 'public.ordenes'::regclass AND NOT t.tgisinternal
         AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 4) = 4 ORDER BY t.tgname`)).rows;
    assert('capture sorts after ordenes_order_entity_anchor_v1 (sees the final order_uid)',
      trg[trg.length - 1].tgname === 'ordenes_zz_giro_intent_capture_v1' &&
      trg.some((t) => t.tgname === 'ordenes_order_entity_anchor_v1'), trg.map((t) => t.tgname));
    assert('capture trigger is WHEN (pending_giro_intent IS NOT NULL)', /WHEN \(\(new\.pending_giro_intent IS NOT NULL\)\)/.test(trg[trg.length - 1].def));

    const walLevel = (await c.su.query('SHOW wal_level')).rows[0].wal_level;
    assert('wal_level=logical available for the WAL proof', walLevel === 'logical', walLevel);
    await c.su.query("SELECT pg_create_logical_replication_slot('w3_capture', 'test_decoding')");

    const s = await c.fx.day('2026-09-14');
    const sOther = await c.fx.day('2026-09-15');
    const scope = [s];
    const mk = (o) => c.fx.order(c.svc, { session: s, ...o });
    const a1 = await mk({ estado: 'LISTO' });
    const a2 = await mk({ estado: 'LISTO' });
    const G = (await call(c.svc, 'giro_authority_create_v1', [[a1.order_uid, a2.order_uid], null, null, 'op-1', scope])).giro_id;
    const single = await mk({});
    const elsewhere = await c.fx.order(c.svc, { session: sOther });
    const auditBefore = (await c.su.query('SELECT max(id) AS m FROM fixture_audit.writes')).rows[0].m || 0;

    const o1 = await mk({ intent: intentInput('GIRO', G) });
    assert('GIRO intent: RETURNING shows pending_giro_intent NULL', o1.pending_giro_intent === null);
    const stored = (await c.su.query('SELECT pending_giro_intent FROM public.ordenes WHERE id = $1', [o1.id])).rows[0];
    assert('GIRO intent: stored row has pending_giro_intent NULL', stored.pending_giro_intent === null);
    const i1 = await c.fx.intent(o1.order_uid);
    assert('GIRO intent -> PENDING with resolved target, fingerprint, actor/sv, context, business date',
      i1 && i1.status === 'PENDING' && i1.phase === 'CAPTURE' && i1.target_giro_id === G && /^[0-9a-f]{64}$/.test(i1.target_fingerprint) &&
      i1.actor === 'op-1' && String(i1.sv) === '3' && i1.order_context.delivery_type === 'DOMICILIO' &&
      i1.order_context.service_session_id === s && i1.business_date === '2026-09-14', i1);

    const o2 = await mk({ intent: intentInput('ANCHOR', single.id) });
    const i2 = await c.fx.intent(o2.order_uid);
    assert('ANCHOR intent -> PENDING resolved to the anchor order_uid', i2 && i2.status === 'PENDING' && i2.target_order_uid === single.order_uid, i2);

    const expectCode = async (label, o, code) => {
      const row = await mk(o);
      const it = await c.fx.intent(row.order_uid);
      assert(`${label} -> order created, input NULL, REJECTED ${code}`,
        row.pending_giro_intent === null && it && it.status === 'REJECTED' && it.phase === 'CAPTURE' && it.resolution_code === code, it);
      return it;
    };
    const m1 = await expectCode('array input', { intent: [1, 2] }, 'CAPTURE_MALFORMED');
    assert('malformed input persists no target', m1.target_kind === null && m1.target_ref === null);
    await expectCode('v=2', { intent: intentInput('GIRO', G, { v: 2 }) }, 'CAPTURE_MALFORMED');
    await expectCode('unknown target_kind', { intent: intentInput('TABLE', G) }, 'CAPTURE_MALFORMED');
    await expectCode('missing target_ref', { intent: { v: 1, source: 'operator_http', actor: 'op-1', sv: 3, target_kind: 'GIRO' } }, 'CAPTURE_MALFORMED');
    await expectCode('source bot', { intent: intentInput('GIRO', G, { source: 'whatsapp_bot' }) }, 'CAPTURE_UNTRUSTED_SOURCE');
    await expectCode('missing actor', { intent: { v: 1, source: 'operator_http', sv: 3, target_kind: 'GIRO', target_ref: G } }, 'CAPTURE_UNTRUSTED_SOURCE');
    await expectCode('sv as string', { intent: intentInput('GIRO', G, { sv: '3' }) }, 'CAPTURE_UNTRUSTED_SOURCE');
    await expectCode('non-delivery order', { intent: intentInput('GIRO', G), delivery: 'PICKUP_FIXTURE' }, 'CAPTURE_NOT_ELIGIBLE');
    const ts = (await c.su.query('INSERT INTO public.table_sessions (workspace_id) SELECT id FROM public.workspaces LIMIT 1 RETURNING id')).rows[0].id;
    await expectCode('table (Mesa) order', { intent: intentInput('GIRO', G), table: ts }, 'CAPTURE_NOT_ELIGIBLE');
    await expectCode('unknown giro', { intent: intentInput('GIRO', 'mg_000000_1') }, 'CAPTURE_TARGET_NOT_FOUND');
    await expectCode('anchor of another service session', { intent: intentInput('ANCHOR', elsewhere.id) }, 'CAPTURE_TARGET_NOT_FOUND');

    const plain = await mk({});
    assert('no input -> no intent record', (await c.fx.intent(plain.order_uid)) === null);

    // Fault injection (test-only triggers on the private table, never product code).
    await c.su.query(`CREATE FUNCTION fixture_audit.fail_pending() RETURNS trigger LANGUAGE plpgsql AS
      $f$ BEGIN IF NEW.status = 'PENDING' THEN RAISE EXCEPTION 'injected' USING ERRCODE = 'P0001'; END IF; RETURN NEW; END $f$`);
    await c.su.query('CREATE TRIGGER a_fault BEFORE INSERT ON giro_authority.giro_intents FOR EACH ROW EXECUTE FUNCTION fixture_audit.fail_pending()');
    const f1 = await mk({ intent: intentInput('GIRO', G) });
    const fi = await c.fx.intent(f1.order_uid);
    assert('fault inside capture -> order created, REJECTED CAPTURE_INTERNAL with sqlstate only',
      f1.pending_giro_intent === null && fi && fi.resolution_code === 'CAPTURE_INTERNAL' &&
      JSON.stringify(fi.resolution_detail) === JSON.stringify({ sqlstate: 'P0001' }), fi);
    await c.su.query('DROP TRIGGER a_fault ON giro_authority.giro_intents');
    await c.su.query(`CREATE FUNCTION fixture_audit.fail_all() RETURNS trigger LANGUAGE plpgsql AS
      $f$ BEGIN RAISE EXCEPTION 'injected-all' USING ERRCODE = 'P0001'; END $f$`);
    await c.su.query('CREATE TRIGGER a_fault_all BEFORE INSERT ON giro_authority.giro_intents FOR EACH ROW EXECUTE FUNCTION fixture_audit.fail_all()');
    c.svc.notices.length = 0;
    let f2 = null;
    let insertErr = null;
    try { f2 = await mk({ intent: intentInput('GIRO', G) }); } catch (e) { insertErr = e; }
    assert('diagnostic persistence broken -> the order is STILL created (order creation wins)', !insertErr && f2 && f2.order_uid, insertErr && insertErr.message);
    assert('...with the input NULL and no intent record', f2 && f2.pending_giro_intent === null && (await c.fx.intent(f2.order_uid)) === null);
    assert('...and a WARNING is the only trace', c.svc.notices.some((n) => /GIRO_INTENT_CAPTURE_DIAGNOSTIC_LOST/.test(n.message)),
      c.svc.notices.map((n) => n.message));
    await c.su.query('DROP TRIGGER a_fault_all ON giro_authority.giro_intents');

    const ops = (await c.su.query("SELECT DISTINCT op FROM fixture_audit.writes WHERE tbl = 'ordenes' AND id > $1", [auditBefore])).rows.map((r) => r.op);
    assert('capture never UPDATEs ordenes (only the INSERT statements themselves)', ops.length === 1 && ops[0] === 'INSERT', ops);

    const wal = (await c.su.query("SELECT data FROM pg_logical_slot_get_changes('w3_capture', NULL, NULL)")).rows.map((r) => r.data);
    const inserts = wal.filter((d) => d.startsWith('table public.ordenes: INSERT:'));
    assert('WAL: every ordenes INSERT tuple carries pending_giro_intent NULL', inserts.length >= 15 &&
      inserts.every((d) => d.includes('pending_giro_intent[jsonb]:null')), { wal: wal.length, inserts: inserts.length, sample: wal.slice(0, 4) });
    assert('WAL: no ordenes tuple ever contains the intent payload', !wal.some((d) => d.startsWith('table public.ordenes') && /operator_http|whatsapp_bot/.test(d)));
    assert('WAL: no ordenes UPDATE was generated by the capture', !wal.some((d) => d.startsWith('table public.ordenes: UPDATE:')));
    await c.su.query("SELECT pg_drop_replication_slot('w3_capture')");
  } finally {
    await c.close();
  }
}

module.exports = { run };
