'use strict';
// Giro Authority W3 certification runner (ephemeral PostgreSQL only).
//   node ci/giro-authority-certification/harness/run.js [groupName ...]
// Prints the usual "RESULT: N passed, M failed" line; exit 1 on any failure.
// Optional: W3_EVIDENCE_OUT=<file.json> writes machine-readable evidence.

const fs = require('fs');
const path = require('path');
const rt = require('./pgRuntime');
const { state, section, assert } = require('./lib');

const GROUP_ORDER = ['boundary', 'commands', 'projection', 'capture', 'consume', 'concurrency', 'noMoney', 'lifecycle'];

const SNAPSHOT_SQL = `
SELECT jsonb_build_object(
  'functions', (SELECT jsonb_object_agg(p.oid::regprocedure::text, md5(pg_get_functiondef(p.oid)))
                  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p')),
  'ordenes_triggers', (SELECT jsonb_agg(t.tgname || ':' || md5(pg_get_triggerdef(t.oid)) ORDER BY t.tgname)
                         FROM pg_trigger t WHERE t.tgrelid = 'public.ordenes'::regclass AND NOT t.tgisinternal),
  'ordenes_columns', (SELECT jsonb_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) ORDER BY a.attnum)
                        FROM pg_attribute a WHERE a.attrelid = 'public.ordenes'::regclass AND a.attnum > 0 AND NOT a.attisdropped),
  'ordenes_constraints', (SELECT jsonb_agg(c.conname || ':' || md5(pg_get_constraintdef(c.oid)) ORDER BY c.conname)
                            FROM pg_constraint c WHERE c.conrelid = 'public.ordenes'::regclass),
  'manual_giros_columns', (SELECT jsonb_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) ORDER BY a.attnum)
                             FROM pg_attribute a WHERE a.attrelid = 'public.manual_giros'::regclass AND a.attnum > 0 AND NOT a.attisdropped),
  'manual_giros_constraints', (SELECT jsonb_agg(c.conname ORDER BY c.conname)
                                 FROM pg_constraint c WHERE c.conrelid = 'public.manual_giros'::regclass),
  'publication', (SELECT jsonb_agg(pt.schemaname || '.' || pt.tablename ORDER BY pt.schemaname, pt.tablename) FROM pg_publication_tables pt),
  'public_acls', (SELECT jsonb_object_agg(c.relname, COALESCE(c.relacl::text, ''))
                    FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'),
  'policies', (SELECT jsonb_agg(p.polname ORDER BY p.polname) FROM pg_policy p),
  'default_acl', (SELECT jsonb_agg(d.defaclacl::text ORDER BY d.defaclacl::text) FROM pg_default_acl d),
  'schemas', (SELECT jsonb_agg(n.nspname ORDER BY n.nspname) FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg\\_%')
) AS s`;

async function snapshot(su) {
  return (await su.query(SNAPSHOT_SQL)).rows[0].s;
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function phaseApply(env) {
  section('P1 APPLY — forward candidate on a staging-shaped fixture (catalog diff)');
  const { su, tripEvidence } = await rt.buildFixtureDb(env.cl, env.admin, 'w3_apply');
  env.evidence.trip_rpcs = tripEvidence;
  const before = await snapshot(su);
  let err = null;
  try { await rt.applyAsPostgres(su, 'candidate/giro_authority_v1.sql'); } catch (e) { err = e; }
  assert('forward candidate applies as role postgres (guards + post-conditions pass)', !err, err && `${err.code} ${err.message}`);
  if (err) { await su.end(); return false; }
  const after = await snapshot(su);

  const newFns = Object.keys(after.functions).filter((k) => !(k in before.functions)).sort();
  assert('pre-existing public functions are byte-identical (economic + trip RPCs untouched)',
    Object.keys(before.functions).every((k) => before.functions[k] === after.functions[k]));
  assert('exactly the 8 public entry points are new in public', newFns.length === 8 &&
    newFns.every((k) => /^giro_authority_[a-z_]+_v1\(|^giro_projection_v1\(/.test(k)), newFns);
  assert('ordenes triggers unchanged (capture NOT installed)', eq(before.ordenes_triggers, after.ordenes_triggers));
  assert('ordenes columns unchanged', eq(before.ordenes_columns, after.ordenes_columns));
  assert('ordenes constraints unchanged', eq(before.ordenes_constraints, after.ordenes_constraints));
  assert('publication membership unchanged', eq(before.publication, after.publication));
  assert('ACL of every pre-existing public table unchanged', eq(before.public_acls, after.public_acls));
  assert('no policy created anywhere', eq(before.policies, after.policies));
  assert('default privileges unchanged', eq(before.default_acl, after.default_acl));
  assert('manual_giros gains exactly business_date/anchor_order_uid/dissolved_by',
    eq(after.manual_giros_columns, [...before.manual_giros_columns, 'business_date:date', 'anchor_order_uid:uuid', 'dissolved_by:text']),
    after.manual_giros_columns);
  assert('manual_giros gains exactly 3 constraints',
    eq(after.manual_giros_constraints.filter((c) => !before.manual_giros_constraints.includes(c)).sort(),
      ['manual_giros_anchor_order_uid_fkey', 'manual_giros_business_date_mirror_chk', 'manual_giros_dissolved_by_chk']));
  assert('one new schema: giro_authority',
    eq(after.schemas.filter((s) => !before.schemas.includes(s)), ['giro_authority']));
  env.evidence.apply_notices = su.notices.map((n) => n.message);
  await su.end();

  // Template for the scenario groups: fixture + forward candidate.
  const t = await rt.buildFixtureDb(env.cl, env.admin, 'w3_tpl');
  await rt.applyAsPostgres(t.su, 'candidate/giro_authority_v1.sql');
  await t.su.end();
  return true;
}

async function main() {
  const only = process.argv.slice(2);
  const cl = await rt.startCluster();
  const env = { cl, evidence: { started_at: new Date().toISOString(), mode: cl.mode } };
  let admin;
  try {
    admin = await rt.connect(cl, 'postgres', { name: 'w3-admin' });
    env.admin = admin;
    await rt.ensureRoles(admin);
    env.evidence.server_version = (await admin.query('SHOW server_version')).rows[0].server_version;
    env.evidence.candidate_sha256 = Object.fromEntries(
      ['candidate/giro_authority_v1.sql', 'candidate/giro_authority_v1.ROLLBACK.sql',
        'candidate/giro_intent_capture_trigger_v1.W5_DORMANT.sql', 'fixture/staging_shape_v1.sql']
        .map((f) => [f, rt.sha256(rt.readCert(f))]));

    let dbSeq = 0;
    env.clone = async (label) => {
      const name = `w3_${label.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${++dbSeq}`;
      await rt.cloneDb(admin, 'w3_tpl', name);
      return name;
    };

    const applied = await phaseApply(env);
    if (applied) {
      for (const g of GROUP_ORDER) {
        if (only.length && !only.includes(g)) continue;
        const file = path.join(__dirname, 'groups', `${g}.js`);
        if (!fs.existsSync(file)) continue;
        try {
          await require(file).run(env);
        } catch (e) {
          section(`GROUP ${g} crashed`);
          assert(`group ${g} completed without an unexpected exception`, false, `${e.code || ''} ${e.stack || e.message}`);
        }
      }
      if (!only.length) {
        const matrix = require('./matrix');
        const results = state.results.slice();
        section('W3 CONTRACT MATRIX — every requirement backed by named, passing assertions');
        env.evidence.matrix = {};
        for (const [id, spec] of Object.entries(matrix)) {
          const hits = results.filter((r) => spec.match.some((p) => p.test(r.name)));
          const passing = hits.filter((h) => h.ok).length;
          const deadPatterns = spec.match.filter((p) => !results.some((r) => p.test(r.name))).map(String);
          env.evidence.matrix[id] = { title: spec.title, pass: passing, fail: hits.length - passing,
            assertions: hits.map((h) => `${h.ok ? 'PASS' : 'FAIL'} ${h.group} :: ${h.name}`), dead_patterns: deadPatterns };
          assert(`${id} ${spec.title} — ${passing} passing assertion(s)`,
            hits.length > 0 && passing === hits.length && deadPatterns.length === 0,
            { failing: hits.filter((h) => !h.ok).map((h) => h.name), deadPatterns });
        }
      }
    }
  } finally {
    if (admin) await admin.end().catch(() => {});
    await cl.stop().catch(() => {});
  }
  env.evidence.groups = state.groups;
  env.evidence.result = { pass: state.pass, fail: state.fail };
  if (process.env.W3_EVIDENCE_OUT) fs.writeFileSync(process.env.W3_EVIDENCE_OUT, JSON.stringify(env.evidence, null, 2));
  console.log('\n═══ RESULT: ' + state.pass + ' passed, ' + state.fail + ' failed ═══');
  process.exit(state.fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
