'use strict';
// N16 — the private relations are unreachable for every API role; access only through
// the SECURITY DEFINER entry points, EXECUTE for service_role only.
const rt = require('../pgRuntime');
const { section, assert, sqlstate, call } = require('../lib');
const { open } = require('./_ctx');

const COMMAND_CALLS = [
  ['giro_authority_create_v1', 'SELECT public.giro_authority_create_v1(ARRAY[]::uuid[], NULL, NULL, $1, ARRAY[]::uuid[])'],
  ['giro_authority_attach_v1', 'SELECT public.giro_authority_attach_v1(NULL, NULL, $1, NULL)'],
  ['giro_authority_detach_v1', 'SELECT public.giro_authority_detach_v1(NULL, $1, NULL)'],
  ['giro_authority_move_v1', 'SELECT public.giro_authority_move_v1(NULL, NULL, $1, NULL)'],
  ['giro_authority_dissolve_v1', 'SELECT public.giro_authority_dissolve_v1(NULL, $1, NULL)'],
  ['giro_authority_set_hora_ref_v1', 'SELECT public.giro_authority_set_hora_ref_v1(NULL, NULL, $1, NULL)'],
  ['giro_authority_consume_intent_v1', 'SELECT public.giro_authority_consume_intent_v1(NULL, $1, NULL)'],
];

async function run(env) {
  section('N16 BOUNDARY — private relations unreachable; DEFINER owner/search_path; EXECUTE service_role only');
  const c = await open(env, 'boundary');
  try {
    const s = await c.fx.day('2026-09-14');
    const a = await c.fx.order(c.svc, { session: s, estado: 'LISTO' });
    const b = await c.fx.order(c.svc, { session: s, estado: 'LISTO' });
    const g = await call(c.svc, 'giro_authority_create_v1', [[a.order_uid, b.order_uid], null, null, 'op-1', [s]]);
    assert('service_role reaches the Authority through the public entry point (create OK)', g.ok && g.code === 'OK', g);

    for (const role of ['anon', 'authenticated', 'service_role']) {
      const r = await rt.connect(env.cl, c.db, { role, name: `w3-${role}` });
      for (const t of ['giro_members', 'giro_intents']) {
        assert(`${role}: SELECT giro_authority.${t} -> 42501`, await sqlstate(r, `SELECT * FROM giro_authority.${t}`) === '42501');
        assert(`${role}: INSERT giro_authority.${t} -> 42501`,
          await sqlstate(r, `INSERT INTO giro_authority.${t} (order_uid) VALUES ('${a.order_uid}')`) === '42501');
        assert(`${role}: UPDATE giro_authority.${t} -> 42501`,
          await sqlstate(r, `UPDATE giro_authority.${t} SET order_uid = order_uid`) === '42501');
        assert(`${role}: DELETE giro_authority.${t} -> 42501`, await sqlstate(r, `DELETE FROM giro_authority.${t}`) === '42501');
        assert(`${role}: TRUNCATE giro_authority.${t} -> 42501`, await sqlstate(r, `TRUNCATE giro_authority.${t}`) === '42501');
      }
      assert(`${role}: private helper (trip_facts_v1) -> 42501`, await sqlstate(r, 'SELECT giro_authority.trip_facts_v1()') === '42501');
      assert(`${role}: private derivation (derive_giros_v1) -> 42501`,
        await sqlstate(r, "SELECT * FROM giro_authority.derive_giros_v1(ARRAY['x'], NULL, '{}'::jsonb)") === '42501');
      if (role === 'service_role') {
        const p = await sqlstate(r, 'SELECT public.giro_projection_v1($1)', [[s]]);
        assert('service_role: projection executes', p === null, p);
      } else {
        assert(`${role}: projection -> 42501`, await sqlstate(r, 'SELECT public.giro_projection_v1($1)', [[s]]) === '42501');
        for (const [fn, sql] of COMMAND_CALLS) {
          assert(`${role}: ${fn} -> 42501`, await sqlstate(r, sql, ['op-x']) === '42501');
        }
      }
      await r.end();
    }

    const fns = (await c.su.query(`
      SELECT p.proname, n.nspname, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'giro_authority'
          OR (n.nspname = 'public' AND (p.proname LIKE 'giro\\_authority\\_%' OR p.proname = 'giro_projection_v1'))`)).rows;
    const pub = fns.filter((f) => f.nspname === 'public');
    assert('every Authority function is owned by postgres', fns.length > 20 && fns.every((f) => f.owner === 'postgres'));
    assert('every Authority function pins search_path=pg_catalog, pg_temp',
      fns.every((f) => JSON.stringify(f.proconfig) === JSON.stringify(['search_path=pg_catalog, pg_temp'])));
    assert('8 public entry points, all SECURITY DEFINER', pub.length === 8 && pub.every((f) => f.prosecdef));
    assert('capture function is SECURITY DEFINER (fires for service_role inserts)',
      fns.some((f) => f.proname === 'capture_giro_intent_v1' && f.prosecdef));

    const rels = (await c.su.query(`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
             (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::int AS policies,
             (SELECT count(*) FROM pg_publication_rel pr WHERE pr.prrelid = c.oid)::int AS published
        FROM pg_class c WHERE c.relnamespace = 'giro_authority'::regnamespace AND c.relkind = 'r'`)).rows;
    assert('both private tables: RLS enabled + forced, zero policies, not published',
      rels.length === 2 && rels.every((r) => r.relrowsecurity && r.relforcerowsecurity && r.policies === 0 && r.published === 0), rels);
    const acl = (await c.su.query(`
      SELECT bool_or(has_schema_privilege(r, 'giro_authority', 'USAGE')) AS usage
        FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r`)).rows[0];
    assert('no API role holds USAGE on schema giro_authority', acl.usage === false);
    const pubAll = (await c.su.query('SELECT count(*)::int AS n FROM pg_publication WHERE puballtables')).rows[0].n;
    assert('no FOR ALL TABLES publication exists that could publish them', pubAll === 0);
  } finally {
    await c.close();
  }
}

module.exports = { run };
