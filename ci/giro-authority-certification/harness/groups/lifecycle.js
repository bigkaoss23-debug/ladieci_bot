'use strict';
// Candidate lifecycle: D5 data preconditions, drift refusal, exact rollback, rollback
// refusals, W5 artifact guards. Each case on its own fresh fixture database.
const rt = require('../pgRuntime');
const { section, assert, call } = require('../lib');

const CATALOG_MD5 = `
SELECT md5(string_agg(x, '|' ORDER BY x)) AS h FROM (
  SELECT 'fn:' || p.oid::regprocedure::text || ':' || md5(pg_get_functiondef(p.oid))
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND p.prokind IN ('f', 'p')
  UNION ALL
  SELECT 'rel:' || n.nspname || '.' || c.relname || ':' || c.relkind::text || ':' || COALESCE(c.relacl::text, '') || ':' ||
         c.relrowsecurity::text || c.relforcerowsecurity::text
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
  UNION ALL
  SELECT 'col:' || a.attrelid::regclass::text || '.' || a.attname || ':' || format_type(a.atttypid, a.atttypmod)
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') AND a.attnum > 0 AND NOT a.attisdropped
  UNION ALL
  SELECT 'con:' || c.conrelid::regclass::text || '.' || c.conname || ':' || md5(pg_get_constraintdef(c.oid))
    FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
  UNION ALL SELECT 'trg:' || t.tgrelid::regclass::text || '.' || t.tgname FROM pg_trigger t WHERE NOT t.tgisinternal
  UNION ALL SELECT 'nsp:' || n.nspname || ':' || COALESCE(n.nspacl::text, '') FROM pg_namespace n
             WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
  UNION ALL SELECT 'pol:' || p.polname FROM pg_policy p
  UNION ALL SELECT 'pub:' || pt.schemaname || '.' || pt.tablename FROM pg_publication_tables pt
  UNION ALL SELECT 'dacl:' || d.defaclacl::text FROM pg_default_acl d
) AS s(x)`;

async function expectRefusal(label, su, file, pattern) {
  let err = null;
  try { await rt.applyAsPostgres(su, file); } catch (e) { err = e; }
  assert(`${label} -> refused (${pattern})`, err && new RegExp(pattern).test(err.message), err ? err.message : 'applied');
}

async function run(env) {
  section('LIFECYCLE — D5 preconditions, drift refusal, exact rollback, rollback refusals, W5 guards');
  const hash = async (su) => (await su.query(CATALOG_MD5)).rows[0].h;
  const fresh = async (name) => (await rt.buildFixtureDb(env.cl, env.admin, name)).su;
  const seedOrder = async (su, extra) => {
    await su.query("INSERT INTO public.business_days (business_date) VALUES ('2026-09-14')");
    const s = (await su.query(`INSERT INTO public.service_sessions (business_date, status, business_day_id)
      SELECT '2026-09-14', 'open', id FROM public.business_days RETURNING id`)).rows[0].id;
    await su.query(`INSERT INTO public.ordenes (id, service_session_id, ${extra.col}) VALUES ('#L1', $1, $2)`, [s, extra.val]);
  };

  let su = await fresh('w3_lc_raw');
  await su.query("INSERT INTO public.manual_giros (id, seq, giro_day) VALUES ('mg_legacy_1', 1, '2026-09-14')");
  await seedOrder(su, { col: 'manual_giro_id', val: 'mg_legacy_1' });
  await expectRefusal('D5: a raw ordenes.manual_giro_id exists', su, 'candidate/giro_authority_v1.sql', 'raw manual_giro_id');
  assert('D5: the refused apply left nothing behind', (await su.query("SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = 'giro_authority'")).rows[0].n === 0);
  await su.end();

  su = await fresh('w3_lc_intent');
  await seedOrder(su, { col: 'pending_giro_intent', val: JSON.stringify({ giroId: 'mg_x', anchorOrderId: '#1' }) });
  await expectRefusal('D5: a persisted pending_giro_intent exists', su, 'candidate/giro_authority_v1.sql', 'persisted pending_giro_intent');
  await su.end();

  su = await fresh('w3_lc_legacy_shell');
  await su.query("INSERT INTO public.manual_giros (id, seq, giro_day) VALUES ('mg_legacy_2', 1, '2026-09-14')");
  su.notices.length = 0;
  let err = null;
  try { await rt.applyAsPostgres(su, 'candidate/giro_authority_v1.sql'); } catch (e) { err = e; }
  assert('memberless legacy giro: apply succeeds and reports it', !err && su.notices.some((n) => /legacy undissolved giros=1/.test(n.message)),
    err ? err.message : su.notices.map((n) => n.message));
  await expectRefusal('second apply (drift)', su, 'candidate/giro_authority_v1.sql', 'already exists');
  await su.end();

  su = await fresh('w3_lc_rollback');
  const h0 = await hash(su);
  await rt.applyAsPostgres(su, 'candidate/giro_authority_v1.sql');
  const h1 = await hash(su);
  err = null;
  try { await rt.applyAsPostgres(su, 'candidate/giro_authority_v1.ROLLBACK.sql'); } catch (e) { err = e; }
  assert('rollback applies', !err, err && err.message);
  const h2 = await hash(su);
  assert('rollback restores the catalog byte-for-byte (functions, relations, columns, constraints, ACLs, triggers, policies, publications, default ACLs)',
    h0 === h2 && h1 !== h0, { h0, h1, h2 });
  err = null;
  try { await rt.applyAsPostgres(su, 'candidate/giro_authority_v1.sql'); } catch (e) { err = e; }
  assert('forward re-applies cleanly after rollback', !err, err && err.message);
  await su.end();

  su = await fresh('w3_lc_rb_refusals');
  await rt.applyAsPostgres(su, 'candidate/giro_authority_v1.sql');
  await rt.applyAsPostgres(su, 'candidate/giro_intent_capture_trigger_v1.W5_DORMANT.sql');
  await expectRefusal('W5 artifact installed twice', su, 'candidate/giro_intent_capture_trigger_v1.W5_DORMANT.sql', 'already exists');
  await expectRefusal('rollback while the W5 trigger is installed', su, 'candidate/giro_authority_v1.ROLLBACK.sql', 'roll W5 back first');
  await su.query('DROP TRIGGER ordenes_zz_giro_intent_capture_v1 ON public.ordenes');
  await su.query("INSERT INTO public.business_days (business_date) VALUES ('2026-09-14')");
  const s = (await su.query(`INSERT INTO public.service_sessions (business_date, status, business_day_id)
    SELECT '2026-09-14', 'open', id FROM public.business_days RETURNING id`)).rows[0].id;
  const svc = await rt.connect(env.cl, 'w3_lc_rb_refusals', { role: 'service_role' });
  const uids = [];
  for (const id of ['#R1', '#R2']) {
    uids.push((await svc.query(`INSERT INTO public.ordenes (id, estado, service_session_id,
      -- language-guard: allow-legacy tipo_consegna is the existing ordenes column name
      tipo_consegna) VALUES ($1, 'EN_COCINA', $2, 'DOMICILIO') RETURNING order_uid`, [id, s])).rows[0].order_uid);
  }
  const g = await call(svc, 'giro_authority_create_v1', [uids, null, null, 'op', [s]]);
  await svc.end();
  assert('setup: an Authority giro exists', g.code === 'OK', g);
  await expectRefusal('rollback while Authority data exists', su, 'candidate/giro_authority_v1.ROLLBACK.sql', 'data exists');
  await su.end();

  su = await fresh('w3_lc_w5_alone');
  await expectRefusal('W5 artifact without the Authority', su, 'candidate/giro_intent_capture_trigger_v1.W5_DORMANT.sql', 'not applied');
  await su.end();
}

module.exports = { run };
