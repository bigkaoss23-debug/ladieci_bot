'use strict';
// ACTIVE_TRIP_SERVICE_CLOSE_EXCLUSION (migration 138) certification runner (ephemeral
// PostgreSQL only; never staging, never production). Builds the migration 130-137 candidate
// chain (the same chain runB1RiderDispatchOperatorParity.js uses) as a PRE-138 template, then
// applies the REAL migrations/2026-09-19_..._migration_138.sql on top as the POST-138 template.
// The forced-interleaving group runs against BOTH: pre-138 it must reproduce the harmful states
// of F-1, post-138 it must make them impossible. The W3/W5/W6/B1 regression groups are then
// re-run on the POST-138 template.
//
//   W3_PG_NODE_MODULES=<dir with embedded-postgres@17 and pg> [W3_PG_DATA_ROOT=<tmp>] \
//     node ci/giro-authority-certification/harness/runActiveTripCloseExclusion.js [groupName ...]

const fs = require('fs');
const path = require('path');
const rt = require('./pgRuntime');
const { state, section, assert } = require('./lib');

// ATC_FWD (absolute path) lets a reviewer run the SAME scenarios against a mutated copy of the migration to prove the
// scenarios discriminate (mutation testing). Unset = the real file.
const FWD = process.env.ATC_FWD || 'migrations/2026-09-19_active_trip_service_close_exclusion_v1_migration_138.sql';
const RBK = 'migrations/2026-09-19_active_trip_service_close_exclusion_v1_migration_138.ROLLBACK.sql';

const REGRESSION_GROUPS = ['boundary', 'commands', 'projection', 'capture', 'consume', 'concurrency', 'noMoney', 'lifecycle',
  'w5packet01', 'w5IntentActivation', 'w6LockOrder', 'w6TripAuthority', 'w6RiderLifecycle', 'b1RiderDispatchOperatorParity'];
const NEW_GROUPS = ['activeTripCloseExclusion'];

// The exact predecessor bodies (independently re-derived by this harness from the migration
// files that introduced them, and equal to md5(prosrc) read from staging on 2026-09-19).
const PRE_CLOSE_MD5 = '3caf2da77baabd6b5533879d101b2cc7'; // ledger 132
const PRE_START_MD5 = 'd3482569db6df9ec5e6445e7748ebc3c'; // ledger 137

// Mirrors runB1RiderDispatchOperatorParity.js (kept verbatim so the pre-138 chain is identical).
const CLOSE_SESSION_PREDECESSOR_STUB = fs.readFileSync(path.join(__dirname, 'closeSessionStub.b1.sql'), 'utf8');
const LEDGER_WRITER_STUB = fs.readFileSync(path.join(__dirname, 'ledgerStub.b1.sql'), 'utf8');

async function installCloseSessionPredecessorStub(su) {
  await su.query('SET ROLE postgres');
  await su.query(CLOSE_SESSION_PREDECESSOR_STUB);
  await su.query('RESET ROLE');
}

async function installLedgerWriterStub(su) {
  await su.query('SET ROLE postgres');
  await su.query(LEDGER_WRITER_STUB);
  await su.query(
    'REVOKE EXECUTE ON FUNCTION public._ledger_write_payment(text,text,numeric,text,text,text,jsonb,text) FROM PUBLIC, anon, authenticated; ' +
    'GRANT EXECUTE ON FUNCTION public._ledger_write_payment(text,text,numeric,text,text,text,jsonb,text) TO service_role; ' +
    'GRANT SELECT, INSERT, UPDATE ON public.fixture_ledger_control TO service_role; ' +
    'GRANT SELECT, INSERT ON public.order_financial_events TO service_role; ' +
    'GRANT USAGE, SELECT ON SEQUENCE public.order_financial_events_id_seq TO service_role;');
  await su.query('RESET ROLE');
}

function extractDollarFunction(sql, name, tag) {
  const marker = `CREATE OR REPLACE FUNCTION public.${name}(`;
  const i = sql.indexOf(marker);
  if (i < 0) throw new Error(`function ${name} not found`);
  const openTag = `AS $${tag}$`;
  const j = sql.indexOf(openTag, i);
  const closeTag = `$${tag}$;`;
  const k = sql.indexOf(closeTag, j + openTag.length);
  return sql.slice(i, k + closeTag.length);
}

async function installRiderCollectPredecessor(su) {
  const sql = rt.readRepo('migrations/2026-07-27_s2_7d6e3a_rider_ledger_writer_additive.sql');
  const text = extractDollarFunction(sql, 'rider_collect_and_complete_stop', 'fn');
  await su.query('SET ROLE postgres');
  await su.query(text);
  await su.query(
    'REVOKE EXECUTE ON FUNCTION public.rider_collect_and_complete_stop(text, text, text, integer, text, jsonb, text) FROM PUBLIC, anon, authenticated; ' +
    'GRANT EXECUTE ON FUNCTION public.rider_collect_and_complete_stop(text, text, text, integer, text, jsonb, text) TO service_role;');
  await su.query('RESET ROLE');
}

async function extendAuthActorsForRiderAuth(su) {
  await su.query('SET ROLE postgres');
  await su.query(`
    ALTER TABLE public.auth_actors
      ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'operator',
      ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS session_version integer NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS workspace_id uuid NOT NULL DEFAULT gen_random_uuid();`);
  await su.query('RESET ROLE');
}

async function applyThroughMigration137(su) {
  await rt.applyAsPostgres(su, 'candidate/giro_authority_v1.sql');
  await rt.applyAsPostgres(su, 'candidate/giro_authority_w5_packet01_v1.sql');
  await installCloseSessionPredecessorStub(su);
  await rt.applyAsPostgres(su, 'candidate/giro_authority_w5_intent_activation_v1.sql');
  await extendAuthActorsForRiderAuth(su);
  await installRiderCollectPredecessor(su);
  await installLedgerWriterStub(su);
  await rt.applyAsPostgres(su, 'candidate/giro_authority_w6_lock_order_unification_v1.sql');
  await rt.applyAsPostgres(su, 'candidate/giro_authority_w6_trip_authority_v1.sql');
  await rt.applyAsPostgres(su, 'candidate/giro_authority_w6_rider_lifecycle_v1.sql');
  await rt.applyAsPostgres(su, 'candidate/giro_authority_b1_rider_dispatch_operator_parity_v1.sql');
  // Staging's ACL for close_service_session_v3 is {postgres=X/postgres,service_role=X/postgres}. The harness stub
  // instead inherits the fixture's default privileges, so align it: the "ACL preserved" proof must run against
  // the live shape (start_rider_trip_v2 already carries it from migration 134).
  await su.query('SET ROLE postgres');
  await su.query('REVOKE ALL ON FUNCTION public.close_service_session_v3(uuid,uuid,text,text) FROM PUBLIC, anon, authenticated; ' +
    'GRANT EXECUTE ON FUNCTION public.close_service_session_v3(uuid,uuid,text,text) TO service_role;');
  await su.query('RESET ROLE');
}

// The REAL migration files, read from migrations/ (not a candidate copy).
async function applyRepoAsPostgres(su, rel) {
  await su.query('SET ROLE postgres');
  try {
    await su.query(path.isAbsolute(rel) ? fs.readFileSync(rel, 'utf8') : rt.readRepo(rel));
  } catch (e) {
    await su.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await su.query('RESET ROLE').catch(() => {});
  }
}

// One production invariant the fixture omits: at most ONE service is open|closing.
async function addSingleActiveIndex(su) {
  await su.query('SET ROLE postgres');
  await su.query(`CREATE UNIQUE INDEX service_sessions_single_active_uq ON public.service_sessions ((true))
                    WHERE status = ANY (ARRAY['open'::text, 'closing'::text])`);
  await su.query('RESET ROLE');
}

async function bodies(su) {
  const r = await su.query(`
    SELECT (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.close_service_session_v3(uuid,uuid,text,text)')) AS close_md5,
           (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.start_rider_trip_v2(uuid,text,integer,uuid[])')) AS start_md5`);
  return r.rows[0];
}

const md5Of = (s) => require('crypto').createHash('md5').update(s).digest('hex');

// md5 pins the ROLLBACK file guards on (== the bodies migration 138 installs).
function rollbackPins() {
  const sql = rt.readRepo(RBK);
  const pins = [...sql.matchAll(/md5\(v_src\) IS DISTINCT FROM '([0-9a-f]{32})'/g)].map((m) => m[1]);
  return { postClose: pins[0], postStart: pins[1], preClose: pins[2], preStart: pins[3] };
}

async function phaseApply(env) {
  section('P0 PROVENANCE -- the pre-138 bodies in the harness chain are the LIVE staging bodies');
  const prov = await rt.buildFixtureDb(env.cl, env.admin, 'atc_prov');
  await applyThroughMigration137(prov.su);
  const pre = await bodies(prov.su);
  assert(`pre-138 close_service_session_v3 is byte-identical to the ledger-132 body (md5 ${PRE_CLOSE_MD5} = staging live)`, pre.close_md5 === PRE_CLOSE_MD5, pre);
  assert(`pre-138 start_rider_trip_v2 is byte-identical to the ledger-137 body (md5 ${PRE_START_MD5} = staging live)`, pre.start_md5 === PRE_START_MD5, pre);
  await prov.su.end();

  section('P1 APPLY -- migration 138 on top of the 130-137 chain: guards + post-conditions pass');
  const { su } = await rt.buildFixtureDb(env.cl, env.admin, 'atc_apply');
  await applyThroughMigration137(su);
  const before = (await su.query(`
    SELECT p.proname, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl
      FROM pg_proc p WHERE p.oid IN ('public.close_service_session_v3(uuid,uuid,text,text)'::regprocedure,
                                     'public.start_rider_trip_v2(uuid,text,integer,uuid[])'::regprocedure) ORDER BY 1`)).rows;
  const schemaBefore = (await su.query(`
    SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('public','trip_authority','giro_authority') AND c.relkind IN ('r','i','S','v')) AS rels,
           (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal) AS triggers,
           (SELECT count(*) FROM pg_constraint) AS constraints`)).rows[0];
  let err = null;
  try { await applyRepoAsPostgres(su, FWD); } catch (e) { err = e; }
  assert('migration 138 applies cleanly on the 130-137 chain (predecessor guards + post-conditions pass)', !err, err && `${err.code} ${err.message}`);
  if (err) { await su.end(); return false; }

  const pins = rollbackPins();
  const post = await bodies(su);
  assert('installed close_service_session_v3 body == the md5 the ROLLBACK guard pins', post.close_md5 === pins.postClose, { post, pins });
  assert('installed start_rider_trip_v2 body == the md5 the ROLLBACK guard pins', post.start_md5 === pins.postStart, { post, pins });
  assert('the ROLLBACK restores exactly the two predecessor md5 pins (ledger 132 / 137)', pins.preClose === PRE_CLOSE_MD5 && pins.preStart === PRE_START_MD5, pins);
  assert('both bodies changed (this is not a no-op)', post.close_md5 !== PRE_CLOSE_MD5 && post.start_md5 !== PRE_START_MD5, post);

  const after = (await su.query(`
    SELECT p.proname, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl
      FROM pg_proc p WHERE p.oid IN ('public.close_service_session_v3(uuid,uuid,text,text)'::regprocedure,
                                     'public.start_rider_trip_v2(uuid,text,integer,uuid[])'::regprocedure) ORDER BY 1`)).rows;
  assert('owner, SECURITY attribute, search_path and ACL of both functions are exactly unchanged', JSON.stringify(before) === JSON.stringify(after), { before, after });
  const schemaAfter = (await su.query(`
    SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('public','trip_authority','giro_authority') AND c.relkind IN ('r','i','S','v')) AS rels,
           (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal) AS triggers,
           (SELECT count(*) FROM pg_constraint) AS constraints`)).rows[0];
  assert('ACL of both functions is the live staging ACL {postgres, service_role} after 138', after.every((r) => r.acl === '{postgres=X/postgres,service_role=X/postgres}'), after);
  assert('no relation, index, sequence, view, trigger or constraint was created or dropped (schema unchanged)', JSON.stringify(schemaBefore) === JSON.stringify(schemaAfter), { schemaBefore, schemaAfter });
  await su.end();

  // Double apply: the predecessor guard sees the post-138 body, not the pinned pre-138 md5.
  const dbl = await rt.buildFixtureDb(env.cl, env.admin, 'atc_double_apply');
  await applyThroughMigration137(dbl.su);
  await applyRepoAsPostgres(dbl.su, FWD);
  let dblErr = null;
  try { await applyRepoAsPostgres(dbl.su, FWD); } catch (e) { dblErr = e; }
  assert('double apply of 138 is refused (predecessor guard sees the post-138 bodies)', !!dblErr, dblErr ? `${dblErr.code} ${dblErr.message}` : '(second apply silently succeeded)');
  await dbl.su.end();

  // Rollback without apply.
  const rbwa = await rt.buildFixtureDb(env.cl, env.admin, 'atc_rb_without_apply');
  await applyThroughMigration137(rbwa.su);
  let rbwaErr = null;
  try { await applyRepoAsPostgres(rbwa.su, RBK); } catch (e) { rbwaErr = e; }
  assert('rollback without a prior apply is refused (bodies are not the 138 bodies)', !!rbwaErr, rbwaErr ? `${rbwaErr.code} ${rbwaErr.message}` : '(rollback silently succeeded)');
  await rbwa.su.end();

  // Forward drift, one function at a time: a real prosrc change in the predecessor.
  for (const which of ['close_service_session_v3', 'start_rider_trip_v2']) {
    const drift = await rt.buildFixtureDb(env.cl, env.admin, `atc_drift_${which === 'start_rider_trip_v2' ? 'start' : 'close'}`);
    await applyThroughMigration137(drift.su);
    const cur = (await drift.su.query('SELECT pg_get_functiondef(to_regproc($1)) AS d', [`public.${which}`])).rows[0].d;
    const drifted = cur.replace(/\nBEGIN\n/, '\nBEGIN\n  -- DRIFT_MARKER (harness-injected, proves the guard detects real drift)\n');
    assert(`drift fixture really changed ${which} before installing it`, drifted !== cur && drifted.includes('DRIFT_MARKER'));
    await drift.su.query('SET ROLE postgres');
    await drift.su.query(drifted);
    await drift.su.query('RESET ROLE');
    let driftErr = null;
    try { await applyRepoAsPostgres(drift.su, FWD); } catch (e) { driftErr = e; }
    assert(`forward apply against a DRIFTED ${which} is refused (md5 mismatch)`, !!driftErr, driftErr ? `${driftErr.code} ${driftErr.message}` : '(drifted predecessor silently accepted)');
    await drift.su.end();
  }

  // Rollback proof: exact restoration + round trip.
  const rb = await rt.buildFixtureDb(env.cl, env.admin, 'atc_rollback_proof');
  await applyThroughMigration137(rb.su);
  const rbBefore = (await rb.su.query(`SELECT p.proname, p.prosecdef, p.proconfig, p.proacl::text AS acl FROM pg_proc p
     WHERE p.oid IN ('public.close_service_session_v3(uuid,uuid,text,text)'::regprocedure, 'public.start_rider_trip_v2(uuid,text,integer,uuid[])'::regprocedure) ORDER BY 1`)).rows;
  await applyRepoAsPostgres(rb.su, FWD);
  let rbErr = null;
  try { await applyRepoAsPostgres(rb.su, RBK); } catch (e) { rbErr = e; }
  assert('rollback candidate applies cleanly', !rbErr, rbErr && `${rbErr.code} ${rbErr.message}`);
  if (!rbErr) {
    const restored = await bodies(rb.su);
    assert('L: rollback restored close_service_session_v3 byte-identically to the ledger-132 body', restored.close_md5 === PRE_CLOSE_MD5, restored);
    assert('L: rollback restored start_rider_trip_v2 byte-identically to the ledger-137 body', restored.start_md5 === PRE_START_MD5, restored);
    const rbAfter = (await rb.su.query(`SELECT p.proname, p.prosecdef, p.proconfig, p.proacl::text AS acl FROM pg_proc p
     WHERE p.oid IN ('public.close_service_session_v3(uuid,uuid,text,text)'::regprocedure, 'public.start_rider_trip_v2(uuid,text,integer,uuid[])'::regprocedure) ORDER BY 1`)).rows;
    assert('L: rollback left owner/SECURITY/search_path/ACL exactly as they were before 138', JSON.stringify(rbBefore) === JSON.stringify(rbAfter), { rbBefore, rbAfter });
    let reapplyErr = null;
    try { await applyRepoAsPostgres(rb.su, FWD); } catch (e) { reapplyErr = e; }
    assert('forward 138 re-applies cleanly after rollback (round-trip proof)', !reapplyErr, reapplyErr && `${reapplyErr.code} ${reapplyErr.message}`);
    const again = await bodies(rb.su);
    assert('re-applied bodies equal the first-apply bodies (deterministic)', again.close_md5 === pins.postClose && again.start_md5 === pins.postStart, again);
  }
  await rb.su.end();

  // Templates: PRE (chain through 137) and POST (chain + 138). The single-active index is NOT in the
  // templates (the regression groups create several open days); the new group adds it per database.
  const tpre = await rt.buildFixtureDb(env.cl, env.admin, 'atc_pre_tpl');
  await applyThroughMigration137(tpre.su);
  await tpre.su.end();
  const tpost = await rt.buildFixtureDb(env.cl, env.admin, 'atc_post_tpl');
  await applyThroughMigration137(tpost.su);
  await applyRepoAsPostgres(tpost.su, FWD);
  await tpost.su.end();
  return true;
}

async function main() {
  const only = process.argv.slice(2);
  const cl = await rt.startCluster();
  const env = { cl, evidence: { started_at: new Date().toISOString(), mode: cl.mode } };
  let admin;
  try {
    admin = await rt.connect(cl, 'postgres', { name: 'atc-admin' });
    env.admin = admin;
    await rt.ensureRoles(admin);

    let dbSeq = 0;
    const cloneFrom = async (tpl, label) => {
      const name = `atc_${label.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${++dbSeq}`;
      await rt.cloneDb(admin, tpl, name);
      return name;
    };
    env.clone = (label) => cloneFrom('atc_post_tpl', label);      // what every regression group uses
    env.clonePre = (label) => cloneFrom('atc_pre_tpl', label);    // pre-138: bug reproduction
    env.md5Of = md5Of;
    env.addSingleActiveIndex = addSingleActiveIndex;

    const applied = await phaseApply(env);
    if (applied) {
      const groups = only.length ? only : [...NEW_GROUPS, ...REGRESSION_GROUPS];
      for (const g of groups) {
        const file = path.join(__dirname, 'groups', `${g}.js`);
        try {
          await require(file).run(env);
        } catch (e) {
          section(`GROUP ${g} crashed`);
          assert(`group ${g} completed without an unexpected exception`, false, `${e.code || ''} ${e.stack || e.message}`);
        }
      }
    }
  } finally {
    if (admin) await admin.end().catch(() => {});
    await cl.stop().catch(() => {});
  }
  console.log('\n═══ RESULT: ' + state.pass + ' passed, ' + state.fail + ' failed ═══');
  process.exit(state.fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
