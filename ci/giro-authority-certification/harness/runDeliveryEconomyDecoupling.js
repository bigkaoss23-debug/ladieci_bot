'use strict';
// DELIVERY_ECONOMY_DECOUPLING_V1 (migration 139) certification runner (ephemeral PostgreSQL only; never
// staging, never production). Builds the migration 130-138 chain (the same chain runActiveTripCloseExclusion.js
// uses, with the REAL migration 138 file applied on top) and installs the REAL economic ledger on it
// (fixture/real_ledger_v1.sql + the writer bodies verbatim from migrations/, md5-checked against staging).
// That is the PRE-139 template; the REAL migrations/2026-09-19_..._migration_139.sql applied on top is the
// POST-139 template. The behaviour group runs against both (pre-139: the old rule; post-139: the new one), the
// W3/W5/W6/B1 regression groups are re-run on the POST-139 template.
//
//   W3_PG_NODE_MODULES=<dir with embedded-postgres@17 and pg> [W3_PG_DATA_ROOT=<tmp>] \
//     node ci/giro-authority-certification/harness/runDeliveryEconomyDecoupling.js [groupName ...]
//
// DED_FWD / DED_RBK (absolute paths) let a reviewer run the SAME scenarios against a mutated copy of the forward / rollback
// migration to prove that the scenarios discriminate (mutation testing). Unset = the real files.

const fs = require('fs');
const path = require('path');
const rt = require('./pgRuntime');
const { state, section, assert } = require('./lib');
const { installRealLedger } = require('./realLedger');

const M138 = 'migrations/2026-09-19_active_trip_service_close_exclusion_v1_migration_138.sql';
const FWD = process.env.DED_FWD || 'migrations/2026-09-19_delivery_economy_decoupling_v1_migration_139.sql';
const RBK = process.env.DED_RBK || 'migrations/2026-09-19_delivery_economy_decoupling_v1_migration_139.ROLLBACK.sql';
const readAny = (rel) => (path.isAbsolute(rel) ? fs.readFileSync(rel, 'utf8') : rt.readRepo(rel));

// Groups whose scenarios depend on the W3 economic STUBS (the fixture_ledger_control switch and the
// stub _ledger_write_payment). They cannot run against the real ledger by construction, so they run on a THIRD
// template: the stub chain through 138 + migration 139 (its guard only needs order_post_payment_v1 to EXIST, so a
// one-line shim stands in for it -- these groups never call it). Migration 139 changes none of the functions they
// exercise (rider RPC / start / close_rider_trip are md5-pinned as unchanged); the same scenarios are ALSO covered
// end to end against the REAL writer by deliveryEconomyDecoupling.
const STUB_LEDGER_GROUPS = ['b1RiderDispatchOperatorParity', 'w6RiderLifecycle'];
const REGRESSION_GROUPS = ['boundary', 'commands', 'projection', 'capture', 'consume', 'concurrency', 'noMoney', 'lifecycle',
  'w5packet01', 'w5IntentActivation', 'w6LockOrder', 'w6TripAuthority', ...STUB_LEDGER_GROUPS];
const NEW_GROUPS = ['deliveryEconomyDecoupling', 'b2OffServiceReceipt'];

// Bodies as they are on staging at ledger tip 138 (md5(prosrc), read 2026-09-19).
const PRE_CLOSE_MD5 = '3051158274094b46d668481b0dbdbdc5'; // ledger 138
const PRE_START_MD5 = '0323fbb1bab76a12fd2be3fed0b3187e'; // ledger 138
const L132_CLOSE_MD5 = '3caf2da77baabd6b5533879d101b2cc7'; // the ledger-132 body 138 was derived from
const PRE_OPV1_MD5 = '778cd30008632707e47a372e6afa5640'; // order_post_payment_v1, ledger 126 (staging live) -- edited by 139 (B2)
// payment_transactions_scope_chk and the two column comments exactly as staging has them at ledger 138 (catalog SELECT, 2026-09-20).
const OLD_SCOPE_CHK = 'CHECK (((table_session_id IS NOT NULL) OR (service_session_id IS NOT NULL)))';
const NEW_SCOPE_CHK = "CHECK (((table_session_id IS NOT NULL) OR (service_session_id IS NOT NULL) OR ((table_session_id IS NULL) AND (service_session_id IS NULL) AND (kind = 'payment'::text) AND (mode = ANY (ARRAY['full'::text, 'custom_amount'::text])) AND (covers_settled = 0) AND COALESCE(((meta -> 'off_service_receipt'::text) = 'true'::jsonb), false))))";
const LIVE_COMMENT_SERVICE = "RECEIPT SERVICE: the service session open at the moment the money was received. NULL = off-service receipt (no session open). NEVER the table's origin service. Physical rename to receipt_service_session_id lands in S14.";
const LIVE_COMMENT_TABLE = 'CHECK-CENTRIC UNIVERSAL CASH V1 (migration 122). Nullable: NULL for a check-centric (non-table) payment/refund. See payment_transactions_scope_chk -- a transaction always carries at least one scope (table_session_id for Mesa, service_session_id for check-centric).';
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

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

// Migration 138's table it needs but the fixture omits: orden_estado_logs (created by migration 40 in production).
const ORDEN_ESTADO_LOGS_DDL = `
CREATE TABLE IF NOT EXISTS public.orden_estado_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  orden_id text NOT NULL,
  numero_ordine text, -- language-guard: allow-legacy numero_ordine is the existing orden_estado_logs column name reproduced verbatim, not new vocabulary
  estado_from text,
  estado_to text NOT NULL,
  event_type text NOT NULL,
  actor_type text,
  actor_id text,
  origin text,
  created_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);`;

async function applyThroughMigration138(su) {
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
  await su.query('SET ROLE postgres');
  await su.query('REVOKE ALL ON FUNCTION public.close_service_session_v3(uuid,uuid,text,text) FROM PUBLIC, anon, authenticated; ' +
    'GRANT EXECUTE ON FUNCTION public.close_service_session_v3(uuid,uuid,text,text) TO service_role;');
  await su.query(ORDEN_ESTADO_LOGS_DDL);
  await su.query('RESET ROLE');
  await applyRepoAsPostgres(su, M138);
}

// PRE-139 = chain through 138 + the real ledger.
async function buildPre(su) {
  await applyThroughMigration138(su);
  return installRealLedger(su);
}

// One production invariant the fixture omits: at most ONE service is open|closing.
async function addSingleActiveIndex(su) {
  await su.query('SET ROLE postgres');
  await su.query(`CREATE UNIQUE INDEX service_sessions_single_active_uq ON public.service_sessions ((true))
                    WHERE status = ANY (ARRAY['open'::text, 'closing'::text])`);
  await su.query('RESET ROLE');
}

// STUB template: the chain through 138 with the W3 ledger stub, plus 139. Only the guard's dependency is shimmed.
async function buildStubPost(su) {
  await applyThroughMigration138(su);
  // 139 pins and then EDITS the canonical order writer (B2), so the stub template needs the EXACT ledger-126 text.
  // These stub-ledger groups never call it, and its tables do not exist on the stub chain, so the body is installed
  // with check_function_bodies off (the text -- hence md5(prosrc) -- is byte-identical to staging) and 139 itself is
  // applied the same way (its CREATE OR REPLACE of the edited body is only parsed here as well).
  const m126 = rt.readRepo('migrations/2026-09-11_economic_writer_hardening_v1_migration_126.sql');
  const start = m126.indexOf('CREATE OR REPLACE FUNCTION public.order_post_payment_v1(');
  const end = m126.indexOf('$function$;', m126.indexOf('$function$', start) + 10) + '$function$;'.length;
  await su.query('SET check_function_bodies = off');
  await su.query('SET ROLE postgres');
  await su.query(m126.slice(start, end));
  // 139 (B2) also REPLACES payment_transactions_scope_chk and two column comments, and its drift guards read them. The W3
  // stub table is (id, order_uid, amount_cents): widen it to exactly the columns / constraint / comments the guards need
  // (the live ones, verbatim). These stub-ledger groups never write to it; the real behaviour is proved on the real template.
  await su.query(`
    ALTER TABLE public.payment_transactions
      ADD COLUMN table_session_id uuid, ADD COLUMN service_session_id uuid,
      ADD COLUMN kind text NOT NULL DEFAULT 'payment', ADD COLUMN mode text NOT NULL DEFAULT 'full',
      ADD COLUMN covers_settled integer NOT NULL DEFAULT 0, ADD COLUMN meta jsonb NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE public.payment_transactions ADD CONSTRAINT payment_transactions_scope_chk
      CHECK (table_session_id IS NOT NULL OR service_session_id IS NOT NULL);`);
  await su.query(`COMMENT ON COLUMN public.payment_transactions.service_session_id IS ${lit(LIVE_COMMENT_SERVICE)}`);
  await su.query(`COMMENT ON COLUMN public.payment_transactions.table_session_id IS ${lit(LIVE_COMMENT_TABLE)}`);
  await su.query('RESET ROLE');
  await applyRepoAsPostgres(su, FWD);
  await su.query('RESET check_function_bodies');
}

async function bodies(su) {
  const r = await su.query(`
    SELECT (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.close_service_session_v3(uuid,uuid,text,text)')) AS close_md5,
           (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.start_rider_trip_v2(uuid,text,integer,uuid[])')) AS start_md5,
           (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.order_post_payment_v1(uuid,text,text,uuid,text,text,numeric,text,text,jsonb,boolean)')) AS opv1_md5`);
  return r.rows[0];
}

const SCHEMA_COUNTS = `
  SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('public','trip_authority','giro_authority') AND c.relkind IN ('r','i','S','v')) AS rels,
         (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal) AS triggers,
         (SELECT count(*) FROM pg_constraint) AS constraints`;

const md5Of = (s) => require('crypto').createHash('md5').update(s).digest('hex');

// A CATALOG FINGERPRINT of everything migration 139 could conceivably touch: every constraint definition, every constraint /
// column / function comment, table owner + ACL + RLS flags, every column definition, every index, every trigger and, for
// every function, md5(prosrc) + owner + SECURITY + search_path + ACL. Compared before/after so that "nothing else changed"
// and "the rollback restores EXACTLY" are proven by comparison, not by a hand-picked list of assertions.
const FP_SCHEMAS = "('public','trip_authority','giro_authority')";
async function catalogFingerprint(su) {
  const q = async (sql) => (await su.query(sql)).rows;
  const s = {};
  s.constraints = Object.fromEntries((await q(`
    SELECT n.nspname||'.'||c.relname||'::'||k.conname AS key, pg_get_constraintdef(k.oid) AS v
      FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname IN ${FP_SCHEMAS}`)).map((r) => [r.key, r.v]));
  s.constraintComments = Object.fromEntries((await q(`
    SELECT n.nspname||'.'||c.relname||'::'||k.conname AS key, obj_description(k.oid,'pg_constraint') AS v
      FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname IN ${FP_SCHEMAS} AND obj_description(k.oid,'pg_constraint') IS NOT NULL`)).map((r) => [r.key, r.v]));
  s.columnComments = Object.fromEntries((await q(`
    SELECT n.nspname||'.'||c.relname||'.'||a.attname AS key, col_description(a.attrelid,a.attnum) AS v
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname IN ${FP_SCHEMAS} AND a.attnum > 0 AND NOT a.attisdropped AND col_description(a.attrelid,a.attnum) IS NOT NULL`)).map((r) => [r.key, r.v]));
  s.tableComments = Object.fromEntries((await q(`
    SELECT n.nspname||'.'||c.relname AS key, obj_description(c.oid,'pg_class') AS v
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname IN ${FP_SCHEMAS} AND c.relkind IN ('r','v','S') AND obj_description(c.oid,'pg_class') IS NOT NULL`)).map((r) => [r.key, r.v]));
  s.tables = Object.fromEntries((await q(`
    SELECT n.nspname||'.'||c.relname AS key,
           pg_get_userbyid(c.relowner)||'|'||coalesce(c.relacl::text,'')||'|rls='||c.relrowsecurity||'/'||c.relforcerowsecurity AS v
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname IN ${FP_SCHEMAS} AND c.relkind IN ('r','v','S')`)).map((r) => [r.key, r.v]));
  s.columns = Object.fromEntries((await q(`
    SELECT n.nspname||'.'||c.relname||'.'||a.attname AS key,
           format_type(a.atttypid,a.atttypmod)||'|nn='||a.attnotnull||'|def='||coalesce(pg_get_expr(d.adbin,d.adrelid),'') AS v
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE n.nspname IN ${FP_SCHEMAS} AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped`)).map((r) => [r.key, r.v]));
  s.indexes = Object.fromEntries((await q(`SELECT schemaname||'.'||indexname AS key, indexdef AS v FROM pg_indexes WHERE schemaname IN ${FP_SCHEMAS}`)).map((r) => [r.key, r.v]));
  s.triggers = Object.fromEntries((await q(`
    SELECT n.nspname||'.'||c.relname||'::'||t.tgname AS key, pg_get_triggerdef(t.oid) AS v
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE NOT t.tgisinternal AND n.nspname IN ${FP_SCHEMAS}`)).map((r) => [r.key, r.v]));
  s.functions = Object.fromEntries((await q(`
    SELECT n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' AS key,
           md5(p.prosrc)||'|'||pg_get_userbyid(p.proowner)||'|secdef='||p.prosecdef||'|cfg='||coalesce(p.proconfig::text,'')||'|acl='||coalesce(p.proacl::text,'')||'|cmt='||coalesce(obj_description(p.oid,'pg_proc'),'') AS v
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname IN ${FP_SCHEMAS}`)).map((r) => [r.key, r.v]));
  return s;
}
// Every catalog entry that differs between two fingerprints, as "section:key" (added, removed or changed).
function fingerprintDiff(a, b) {
  const out = [];
  for (const sec of Object.keys(a)) {
    const keys = new Set([...Object.keys(a[sec]), ...Object.keys(b[sec])]);
    for (const k of keys) if (a[sec][k] !== b[sec][k]) out.push(`${sec}:${k}`);
  }
  return out.sort();
}

// md5 pins the ROLLBACK file guards on (== the body migration 139 installs, then the 138 body it restores).
function rollbackPins() {
  const sql = readAny(RBK);
  const pins = [...sql.matchAll(/md5\(v_src\) IS DISTINCT FROM '([0-9a-f]{32})'/g)].map((m) => m[1]);
  return { post139Close: pins[0], start: pins[1], post139Opv1: pins[2] };
}

const FN_ACL = `SELECT p.proname, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl
                  FROM pg_proc p WHERE p.oid IN ('public.close_service_session_v3(uuid,uuid,text,text)'::regprocedure,
                                                 'public.start_rider_trip_v2(uuid,text,integer,uuid[])'::regprocedure,
                                                 'public.order_post_payment_v1(uuid,text,text,uuid,text,text,numeric,text,text,jsonb,boolean)'::regprocedure) ORDER BY 1`;

async function phaseApply(env) {
  section('P0 PROVENANCE -- the pre-139 state is the LIVE staging state (ledger tip 138) and the real ledger is the live ledger');
  const prov = await rt.buildFixtureDb(env.cl, env.admin, 'ded_prov');
  const led = await buildPre(prov.su);
  const pre = await bodies(prov.su);
  assert(`pre-139 close_service_session_v3 is byte-identical to the ledger-138 body (md5 ${PRE_CLOSE_MD5} = staging live)`, pre.close_md5 === PRE_CLOSE_MD5, pre);
  assert(`pre-139 start_rider_trip_v2 is byte-identical to the ledger-138 body (md5 ${PRE_START_MD5} = staging live)`, pre.start_md5 === PRE_START_MD5, pre);
  assert(`pre-139 order_post_payment_v1 is byte-identical to the ledger-126 body (md5 ${PRE_OPV1_MD5} = staging live)`, pre.opv1_md5 === PRE_OPV1_MD5, pre);
  assert('the REAL ledger installed on the fixture is byte-identical to staging: every helper/writer md5(prosrc) equals the live value',
    led.mismatches.length === 0 && led.missing.length === 0 && led.checked >= 10, led);
  await prov.su.end();

  section('P1 APPLY -- migration 139 on top of the 130-138 chain: guards + post-conditions pass');
  const { su } = await rt.buildFixtureDb(env.cl, env.admin, 'ded_apply');
  await buildPre(su);
  const before = (await su.query(FN_ACL)).rows;
  const schemaBefore = (await su.query(SCHEMA_COUNTS)).rows[0];
  const fpBefore = await catalogFingerprint(su);
  assert('P1 pre-state: payment_transactions_scope_chk is exactly the migration-122 constraint and both column comments are the live S2 / 122 texts',
    fpBefore.constraints['public.payment_transactions::payment_transactions_scope_chk'] === OLD_SCOPE_CHK
    && fpBefore.columnComments['public.payment_transactions.service_session_id'] === LIVE_COMMENT_SERVICE
    && fpBefore.columnComments['public.payment_transactions.table_session_id'] === LIVE_COMMENT_TABLE
    && !('public.payment_transactions::payment_transactions_scope_chk' in fpBefore.constraintComments), {
    def: fpBefore.constraints['public.payment_transactions::payment_transactions_scope_chk'] });
  let err = null;
  try { await applyRepoAsPostgres(su, FWD); } catch (e) { err = e; }
  assert('migration 139 applies cleanly on the 130-138 chain (predecessor guards + post-conditions pass)', !err, err && `${err.code} ${err.message}`);
  if (err) { await su.end(); return false; }

  const pins = rollbackPins();
  const post = await bodies(su);
  assert('installed close_service_session_v3 body == the md5 the ROLLBACK guard pins', post.close_md5 === pins.post139Close, { post, pins });
  assert('start_rider_trip_v2 is UNTOUCHED (still exactly the ledger-138 body: SERVICE_NOT_OPEN half intact)', post.start_md5 === PRE_START_MD5 && pins.start === PRE_START_MD5, { post, pins });
  assert('the close body changed (this is not a no-op)', post.close_md5 !== PRE_CLOSE_MD5, post);
  assert('order_post_payment_v1 is now the exact 139 body the rollback guard pins (and is NOT the ledger-126 body any more)', post.opv1_md5 === pins.post139Opv1 && post.opv1_md5 !== PRE_OPV1_MD5, { post, pins });

  const after = (await su.query(FN_ACL)).rows;
  assert('owner, SECURITY attribute, search_path and ACL of close/start are exactly unchanged', JSON.stringify(before) === JSON.stringify(after), { before, after });
  assert('ACL of close/start is the live staging ACL {postgres, service_role} after 139', after.filter((r) => r.proname !== 'order_post_payment_v1').every((r) => r.acl === '{postgres=X/postgres,service_role=X/postgres}'), after);
  const news = (await su.query(`
    SELECT p.proname, p.prosecdef, p.proconfig::text AS cfg, pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl,
           has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_x, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_x,
           has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc_x
      FROM pg_proc p WHERE p.oid IN ('public.operator_confirm_delivery_v1(text,text,integer,jsonb)'::regprocedure, 'public.trip_residual_scope_v1()'::regprocedure) ORDER BY 1`)).rows;
  assert('the two new functions exist, are owned by postgres, and only service_role (not anon/authenticated/PUBLIC) may execute them',
    news.length === 2 && news.every((r) => r.owner === 'postgres' && r.acl === '{postgres=X/postgres,service_role=X/postgres}' && !r.anon_x && !r.auth_x && r.svc_x), news);
  assert('operator_confirm_delivery_v1 is SECURITY INVOKER (public, pg_temp); trip_residual_scope_v1 is SECURITY DEFINER (pg_catalog, pg_temp)',
    news.find((r) => r.proname === 'operator_confirm_delivery_v1').prosecdef === false
    && news.find((r) => r.proname === 'operator_confirm_delivery_v1').cfg === '{"search_path=public, pg_temp"}'
    && news.find((r) => r.proname === 'trip_residual_scope_v1').prosecdef === true
    && news.find((r) => r.proname === 'trip_residual_scope_v1').cfg === '{"search_path=pg_catalog, pg_temp"}', news);
  const schemaAfter = (await su.query(SCHEMA_COUNTS)).rows[0];
  assert('no relation, index, sequence, view or trigger was created or dropped, and the constraint COUNT is unchanged (one constraint is REPLACED in place)', JSON.stringify(schemaBefore) === JSON.stringify(schemaAfter), { schemaBefore, schemaAfter });
  // The exhaustive catalog comparison: EXACTLY these eight entries changed, nothing else in the three schemas.
  const fpAfter = await catalogFingerprint(su);
  const touched = fingerprintDiff(fpBefore, fpAfter);
  const EXPECTED = [
    'columnComments:public.payment_transactions.service_session_id',
    'columnComments:public.payment_transactions.table_session_id',
    'constraintComments:public.payment_transactions::payment_transactions_scope_chk',
    'constraints:public.payment_transactions::payment_transactions_scope_chk',
    'functions:public.close_service_session_v3(',
    'functions:public.operator_confirm_delivery_v1(',
    'functions:public.order_post_payment_v1(',
    'functions:public.trip_residual_scope_v1(',
  ];
  assert('P1 catalog fingerprint: migration 139 changed EXACTLY the scope constraint + its comment, the two column comments and the four functions -- no other constraint, comment, column, index, trigger, table ACL/owner/RLS or function moved',
    touched.length === EXPECTED.length && EXPECTED.every((p) => touched.filter((t) => t.startsWith(p)).length === 1), touched);
  assert('P1 after 139: payment_transactions_scope_chk is exactly the narrow off-service constraint (and the old exact definition is gone)',
    fpAfter.constraints['public.payment_transactions::payment_transactions_scope_chk'] === NEW_SCOPE_CHK
    && fpAfter.constraints['public.payment_transactions::payment_transactions_scope_chk'] !== OLD_SCOPE_CHK,
    { def: fpAfter.constraints['public.payment_transactions::payment_transactions_scope_chk'] });
  assert('P1 after 139: the column comment of payment_transactions.service_session_id STILL states the receipt contract ("RECEIPT SERVICE ... NULL = off-service receipt ... NEVER the table\'s origin service") and does not call it a scope anchor',
    /^RECEIPT SERVICE: the service session open at the moment the money was received\. NULL = off-service receipt \(no session open\)\. NEVER the table's origin service/.test(fpAfter.columnComments['public.payment_transactions.service_session_id'])
    && /NEVER the order's own service: it is a receipt attribute, not a scope anchor/.test(fpAfter.columnComments['public.payment_transactions.service_session_id']),
    { c: fpAfter.columnComments['public.payment_transactions.service_session_id'] });
  await su.end();

  // Double apply.
  const dbl = await rt.buildFixtureDb(env.cl, env.admin, 'ded_double_apply');
  await buildPre(dbl.su);
  await applyRepoAsPostgres(dbl.su, FWD);
  let dblErr = null;
  try { await applyRepoAsPostgres(dbl.su, FWD); } catch (e) { dblErr = e; }
  assert('double apply of 139 is refused (a 139 object already exists / the bodies are not the 138 ones)', !!dblErr, dblErr ? `${dblErr.code} ${dblErr.message}` : '(second apply silently succeeded)');
  await dbl.su.end();

  // Rollback without apply.
  const rbwa = await rt.buildFixtureDb(env.cl, env.admin, 'ded_rb_without_apply');
  await buildPre(rbwa.su);
  let rbwaErr = null;
  try { await applyRepoAsPostgres(rbwa.su, RBK); } catch (e) { rbwaErr = e; }
  assert('rollback without a prior apply is refused (the 139 objects do not exist)', !!rbwaErr, rbwaErr ? `${rbwaErr.code} ${rbwaErr.message}` : '(rollback silently succeeded)');
  await rbwa.su.end();

  // Forward drift, one function at a time: a real prosrc change in the predecessor.
  for (const which of ['close_service_session_v3', 'start_rider_trip_v2', 'order_post_payment_v1']) {
    const drift = await rt.buildFixtureDb(env.cl, env.admin, `ded_drift_${which === 'start_rider_trip_v2' ? 'start' : which === 'order_post_payment_v1' ? 'opv1' : 'close'}`);
    await buildPre(drift.su);
    const cur = (await drift.su.query('SELECT pg_get_functiondef(to_regproc($1)) AS d', [`public.${which}`])).rows[0].d;   // eslint-disable-line
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

  // Forward drift on the RECEIPT-SCOPE contract (B2): the constraint / comments 139 replaces must be exactly staging's, or the
  // rollback could not restore them verbatim -- so the forward refuses instead of guessing.
  const scopeDrifts = [
    ['a different payment_transactions_scope_chk', `ALTER TABLE public.payment_transactions DROP CONSTRAINT payment_transactions_scope_chk;
       ALTER TABLE public.payment_transactions ADD CONSTRAINT payment_transactions_scope_chk CHECK (table_session_id IS NOT NULL OR service_session_id IS NOT NULL OR kind = 'refund')`],
    ['a comment already present on the scope constraint', `COMMENT ON CONSTRAINT payment_transactions_scope_chk ON public.payment_transactions IS 'drift'`],
    ['a drifted service_session_id column comment', `COMMENT ON COLUMN public.payment_transactions.service_session_id IS 'drift'`],
    ['a drifted table_session_id column comment', `COMMENT ON COLUMN public.payment_transactions.table_session_id IS 'drift'`],
    ['payment_transactions.meta no longer NOT NULL', `ALTER TABLE public.payment_transactions ALTER COLUMN meta DROP NOT NULL`],
  ];
  for (const [label, ddl] of scopeDrifts) {
    const d = await rt.buildFixtureDb(env.cl, env.admin, `ded_scope_drift_${scopeDrifts.findIndex((x) => x[0] === label)}`);
    await buildPre(d.su);
    await d.su.query('SET ROLE postgres');
    await d.su.query(ddl);
    await d.su.query('RESET ROLE');
    let e2 = null;
    try { await applyRepoAsPostgres(d.su, FWD); } catch (e) { e2 = e; }
    assert(`forward apply against ${label} is refused (typed guard, nothing applied)`, !!e2 && /refused/.test(e2.message), e2 ? `${e2.code} ${e2.message}` : '(drifted receipt-scope contract silently accepted)');
    if (e2) {
      const still = (await d.su.query(`SELECT to_regprocedure('public.trip_residual_scope_v1()') IS NULL AS untouched`)).rows[0];
      assert(`...and the refused forward left NOTHING behind (${label})`, still.untouched === true, still);
    }
    await d.su.end();
  }

  // Rollback proof: exact restoration to POST-138 + round trip.
  const rb = await rt.buildFixtureDb(env.cl, env.admin, 'ded_rollback_proof');
  await buildPre(rb.su);
  const rbBefore = (await rb.su.query(FN_ACL)).rows;
  const rbSchemaBefore = (await rb.su.query(SCHEMA_COUNTS)).rows[0];
  const rbFp0 = await catalogFingerprint(rb.su);
  await applyRepoAsPostgres(rb.su, FWD);
  const rbFp1 = await catalogFingerprint(rb.su);
  assert('rollback proof pre-condition: 139 really changed the catalog (the comparison below is not vacuous)', fingerprintDiff(rbFp0, rbFp1).length === 8, fingerprintDiff(rbFp0, rbFp1));
  let rbErr = null;
  try { await applyRepoAsPostgres(rb.su, RBK); } catch (e) { rbErr = e; }
  assert('rollback candidate applies cleanly', !rbErr, rbErr && `${rbErr.code} ${rbErr.message}`);
  if (!rbErr) {
    const rbFp2 = await catalogFingerprint(rb.su);
    const rbDiff = fingerprintDiff(rbFp0, rbFp2);
    assert('L: CATALOG FINGERPRINT after the rollback == before 139, entry by entry (constraint definitions, comments, table owner/ACL/RLS, columns, indexes, triggers, function md5 + owner + SECURITY + search_path + ACL): the rollback restores EXACTLY and leaves NO residue of the off-service exception',
      rbDiff.length === 0, rbDiff);
    assert('L: after the rollback the scope constraint is the exact migration-122 definition, it carries no comment, and both column comments are the S2 / 122 texts',
      rbFp2.constraints['public.payment_transactions::payment_transactions_scope_chk'] === OLD_SCOPE_CHK
      && !('public.payment_transactions::payment_transactions_scope_chk' in rbFp2.constraintComments)
      && rbFp2.columnComments['public.payment_transactions.service_session_id'] === LIVE_COMMENT_SERVICE
      && rbFp2.columnComments['public.payment_transactions.table_session_id'] === LIVE_COMMENT_TABLE, {
      def: rbFp2.constraints['public.payment_transactions::payment_transactions_scope_chk'] });
    const restored = await bodies(rb.su);
    assert('L: rollback restored close_service_session_v3 byte-identically to the POST-138 body (NOT the pre-138 one)', restored.close_md5 === PRE_CLOSE_MD5 && restored.close_md5 !== L132_CLOSE_MD5, restored);
    assert('L: rollback left start_rider_trip_v2 exactly as it was (ledger-138 body)', restored.start_md5 === PRE_START_MD5, restored);
    assert('L: rollback restored order_post_payment_v1 byte-identically to the ledger-126 body (md5 = staging live)', restored.opv1_md5 === PRE_OPV1_MD5, restored);
    const rbAfter = (await rb.su.query(FN_ACL)).rows;
    assert('L: rollback left owner/SECURITY/search_path/ACL exactly as they were after 138', JSON.stringify(rbBefore) === JSON.stringify(rbAfter), { rbBefore, rbAfter });
    const gone = (await rb.su.query(`SELECT to_regprocedure('public.operator_confirm_delivery_v1(text,text,integer,jsonb)') IS NULL AS op_gone,
                                            to_regprocedure('public.trip_residual_scope_v1()') IS NULL AS res_gone`)).rows[0];
    assert('L: rollback dropped both 139-created functions', gone.op_gone === true && gone.res_gone === true, gone);
    assert('L: rollback left the schema exactly as it was after 138', JSON.stringify(rbSchemaBefore) === JSON.stringify((await rb.su.query(SCHEMA_COUNTS)).rows[0]));
    let reapplyErr = null;
    try { await applyRepoAsPostgres(rb.su, FWD); } catch (e) { reapplyErr = e; }
    assert('forward 139 re-applies cleanly after rollback (round-trip proof)', !reapplyErr, reapplyErr && `${reapplyErr.code} ${reapplyErr.message}`);
    const again = await bodies(rb.su);
    assert('re-applied bodies equal the first-apply bodies (deterministic)', again.close_md5 === pins.post139Close && again.start_md5 === PRE_START_MD5 && again.opv1_md5 === pins.post139Opv1, again);
  }
  await rb.su.end();

  // Templates: PRE (chain through 138 + real ledger) and POST (PRE + 139).
  const tpre = await rt.buildFixtureDb(env.cl, env.admin, 'ded_pre_tpl');
  await buildPre(tpre.su);
  await tpre.su.end();
  const tpost = await rt.buildFixtureDb(env.cl, env.admin, 'ded_post_tpl');
  await buildPre(tpost.su);
  await applyRepoAsPostgres(tpost.su, FWD);
  await tpost.su.end();
  const tstub = await rt.buildFixtureDb(env.cl, env.admin, 'ded_stub_post_tpl');
  await buildStubPost(tstub.su);
  await tstub.su.end();
  return true;
}

async function main() {
  const only = process.argv.slice(2);
  const cl = await rt.startCluster();
  const env = { cl, evidence: { started_at: new Date().toISOString(), mode: cl.mode } };
  let admin;
  try {
    admin = await rt.connect(cl, 'postgres', { name: 'ded-admin' });
    env.admin = admin;
    await rt.ensureRoles(admin);

    let dbSeq = 0;
    const cloneFrom = async (tpl, label) => {
      const name = `ded_${label.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${++dbSeq}`;
      await rt.cloneDb(admin, tpl, name);
      return name;
    };
    const postClone = (label) => cloneFrom('ded_post_tpl', label);
    env.clone = postClone;                                         // POST-139 + real ledger: what the regression groups use
    env.clonePre = (label) => cloneFrom('ded_pre_tpl', label);    // PRE-139: the old rule, for contrast
    env.md5Of = md5Of;
    env.addSingleActiveIndex = addSingleActiveIndex;
    env.RBK = RBK;
    env.FWD = FWD;
    env.applyRepoAsPostgres = applyRepoAsPostgres;
    env.PRE_CLOSE_MD5 = PRE_CLOSE_MD5;
    env.catalogFingerprint = catalogFingerprint;
    env.fingerprintDiff = fingerprintDiff;
    env.OLD_SCOPE_CHK = OLD_SCOPE_CHK;
    env.NEW_SCOPE_CHK = NEW_SCOPE_CHK;
    env.LIVE_COMMENT_SERVICE = LIVE_COMMENT_SERVICE;
    env.LIVE_COMMENT_TABLE = LIVE_COMMENT_TABLE;

    let applied = false;
    try {
      applied = await phaseApply(env);
    } catch (e) {
      // Print the REAL failure before the finally-block stops the cluster (which would otherwise surface as an
      // unrelated "terminating connection" error on the still-open fixture connection).
      section('phaseApply crashed');
      assert('phaseApply completed without an unexpected exception', false, `${e.code || ''} ${e.stack || e.message}`);
    }
    if (applied) {
      const groups = only.length ? only : [...NEW_GROUPS, ...REGRESSION_GROUPS];
      for (const g of groups) {
        if (g === 'none') continue;
        // stub-ledger-bound groups run on the stub + 139 template; everything else on the real-ledger one
        env.clone = STUB_LEDGER_GROUPS.includes(g) ? ((label) => cloneFrom('ded_stub_post_tpl', label)) : postClone;
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

// B-RID-1 (migration 140): runRiderCanonicalPayment.js stacks 140 on the SAME chain, so the builders are exported; run
// directly, this file is the unchanged migration-139 certification.
module.exports = { applyThroughMigration138, buildPre, buildStubPost, applyRepoAsPostgres, addSingleActiveIndex, catalogFingerprint,
  fingerprintDiff, md5Of, bodies, FWD, RBK, REGRESSION_GROUPS, STUB_LEDGER_GROUPS, NEW_GROUPS, OLD_SCOPE_CHK, NEW_SCOPE_CHK,
  LIVE_COMMENT_SERVICE, LIVE_COMMENT_TABLE, PRE_CLOSE_MD5 };
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
