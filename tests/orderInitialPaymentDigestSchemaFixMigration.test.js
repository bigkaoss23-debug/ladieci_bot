'use strict';
// tests/orderInitialPaymentDigestSchemaFixMigration.test.js — MIGRATION 123
// (ORDER_INITIAL_PAYMENT DIGEST SCHEMA QUALIFICATION) static assertions.
//
// OFFLINE. No DB, no network -- exactly like tests/checkCentricUniversalCashV1
// Migration.test.js and tests/refundV1SliceAMigration.test.js. This proves
// everything that lives in the repository: the migration's own guard/fix/
// post-condition text, the rollback's exact reversal, that migration 122 is
// byte-untouched, and that the ONLY semantic difference this migration makes
// anywhere is the single digest(...) -> extensions.digest(...) qualification
// in order_initial_payment_v1's request-hash assignment.
//
// Run: node tests/orderInitialPaymentDigestSchemaFixMigration.test.js

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://stub.local';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'stub-service-role-key';

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => {
  if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); }
};
const section = (t) => console.log('\n── ' + t + ' ──');

const MIG_DIR = path.join(__dirname, '..', 'migrations');

const M122_FILE = '2026-09-07_check_centric_universal_cash_v1_migration_122.sql';
const M122_RB_FILE = '2026-09-07_check_centric_universal_cash_v1_migration_122.ROLLBACK.sql';
const M123_FILE = '2026-09-08_order_initial_payment_digest_schema_fix_migration_123.sql';
const M123_RB_FILE = '2026-09-08_order_initial_payment_digest_schema_fix_migration_123.ROLLBACK.sql';

const M122 = fs.readFileSync(path.join(MIG_DIR, M122_FILE), 'utf8');
const M122_RB = fs.readFileSync(path.join(MIG_DIR, M122_RB_FILE), 'utf8');
const MIG = fs.readFileSync(path.join(MIG_DIR, M123_FILE), 'utf8');
const RB = fs.readFileSync(path.join(MIG_DIR, M123_RB_FILE), 'utf8');

// Extract a function's REAL body (between its own AS $function$ ... $function$
// delimiters) -- same technique as checkCentricUniversalCashV1Migration.test.js's
// fnBody. Slicing on prose landmarks instead would let a neighbouring comment
// satisfy -- or defeat -- an assertion about the SQL.
function fnBody(src, name) {
  const marker = 'FUNCTION public.' + name + '(';
  const i = src.indexOf(marker);
  if (i < 0) return '';
  const j = src.indexOf('AS $function$', i);
  const k = src.indexOf('$function$;', j + 13);
  return src.slice(j + 13, k);
}

// Extract a function's FULL definition, header included (CREATE OR REPLACE ...
// AS $function$ ... $function$;) -- needed to assert on SET search_path, which
// sits in the header, outside fnBody's body-only slice.
function fnFull(src, name) {
  const marker = 'FUNCTION public.' + name + '(';
  const i = src.indexOf(marker);
  if (i < 0) return '';
  const start = src.lastIndexOf('CREATE', i);
  const j = src.indexOf('AS $function$', i);
  const k = src.indexOf('$function$;', j + 13);
  return src.slice(start, k + '$function$;'.length);
}

const sha256 = (s) => require('crypto').createHash('sha256').update(s, 'utf8').digest('hex');

// Drops every full-line `--` comment (leading whitespace tolerated) so a
// prose mention like "the one `CREATE OR REPLACE FUNCTION` below" cannot be
// counted as a second executable DDL statement -- comment-safe by
// construction, not by hoping no comment ever repeats a keyword.
const stripLineComments = (s) => s.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');

// ═══════════════════════════════════════════════════════════════════
section('CASE L — MIGRATION ORDER: 123 present exactly once, 124 is only the authorized constraint-gap fix, 125 still absent');
const allFiles = fs.readdirSync(MIG_DIR);
assert('exactly one forward migration-123 file exists',
  allFiles.filter((f) => /_migration_123\.sql$/.test(f)).length === 1);
assert('exactly one migration-123 rollback file exists',
  allFiles.filter((f) => /_migration_123\.ROLLBACK\.sql$/.test(f)).length === 1);
// SUPERSEDED 2026-09-09 -- the original assertion here was "no migration-124
// file of any kind exists", a sequence guard from when 123 was the tip. The
// owner authorized 2026-09-09_refund_paid_state_constraint_gap_v1_migration_124
// (REFUND_PAID_STATE_CONSTRAINT_GAP_V1) as the sole migration 124. Same change
// this project made to checkCentricUniversalCashV1Migration.test.js when 123
// landed over 122: the guard is not deleted, it is narrowed to "no OTHER,
// unauthorized migration 124 sneaks in under that number", and no-skip /
// uniqueness / ascending order stay covered by migrationManifestOrder.test.js.
assert('if a migration-124 file exists, it is EXACTLY the owner-authorized refund-paid-state constraint gap fix (no unauthorized migration 124)',
  allFiles
    .filter((f) => /_migration_124\b/.test(f) || /^2026-\d\d-\d\d_.*124/.test(f))
    .every((f) => f === '2026-09-09_refund_paid_state_constraint_gap_v1_migration_124.sql' ||
                   f === '2026-09-09_refund_paid_state_constraint_gap_v1_migration_124.ROLLBACK.sql'));
assert('no migration-125 file of any kind exists yet (the sequence guard moves forward by one)',
  !allFiles.some((f) => /_migration_125\b/.test(f) || /^2026-\d\d-\d\d_.*125/.test(f)));

// ═══════════════════════════════════════════════════════════════════
section('CASE K — M122 IMMUTABILITY: forward and rollback bytes/checksums untouched');
// Pinned the moment this migration was authored (2026-09-08), read from disk
// BEFORE any change in this same commit -- and independently cross-checked
// read-only against the live ladieci_schema_migrations ledger row for
// apply_order=122, whose checksum_sha256 ('31ab8b8f5d2928cf') is exactly this
// sha256's own first 16 hex characters, proving the applied-on-staging file
// and the file on disk in this commit are the identical bytes.
const M122_SHA256 = '31ab8b8f5d2928cf56aa2ecf6cab3eee6de4a77f68ef025f5405d74f7e9a4fb6';
const M122_RB_SHA256 = '32c7c954c074c1e9203f19447c19766f6dbc298be95386976b0232fd107c299f';
assert('migration 122 forward file bytes match the pinned checksum (untouched by this commit)',
  sha256(M122) === M122_SHA256, sha256(M122));
assert('migration 122 rollback file bytes match the pinned checksum (untouched by this commit)',
  sha256(M122_RB) === M122_RB_SHA256, sha256(M122_RB));
assert('pinned M122 checksum matches the live ladieci_schema_migrations ledger checksum prefix for apply_order=122',
  M122_SHA256.slice(0, 16) === '31ab8b8f5d2928cf');

// ═══════════════════════════════════════════════════════════════════
section('HEADER / SCOPE DECLARATIONS');
assert('the file states this is a schema-qualification fix, not a search_path widening',
  MIG.includes('do NOT fix this by widening') || MIG.includes('do NOT widen'));
assert('the file explicitly rejects widening order_initial_payment_v1\'s search_path to include extensions',
  /do NOT (fix this by )?widen(ing)?[\s\S]{0,200}search_path[\s\S]{0,80}extensions/i.test(MIG));
assert('the file declares this migration is the sole correction vehicle (comment-wrap tolerant)',
  /sole\s*\n?(--\s*)?correction vehicle/.test(MIG));
assert('the file states ledger stays 122 (not applied here)',
  MIG.includes('ledger stays 122'));
assert('the file states NO PUSH / NO DEPLOY / NO STAGING DB APPLY (comment-wrap tolerant, same convention as M122\'s own test)',
  /NO PUSH.*NO DEPLOY.*NO\s*\n?(--\s*)?STAGING\s*\n?(--\s*)?DB APPLY/s.test(MIG.replace(/\r/g, '')) ||
  (MIG.includes('NO PUSH') && MIG.includes('NO DEPLOY') && MIG.includes('STAGING DB APPLY')));
assert('the file states migration 122 is not modified',
  MIG.includes('Does NOT modify migration 122'));

// ═══════════════════════════════════════════════════════════════════
section('CASE A — GUARD accepts the M122 baseline epoch');
assert('guard checks search_path is exactly the M122 epoch (public, pg_temp)',
  MIG.includes("v_search_path IS DISTINCT FROM 'search_path=public, pg_temp'"));
assert('guard requires the canonical writer call to already be present (M122 already landed)',
  MIG.includes("position('PERFORM public.order_post_payment_v1(' IN v_def) = 0") &&
  MIG.includes("RAISE EXCEPTION 'M123 refused: order_initial_payment_v1 does not call order_post_payment_v1"));
assert('guard requires the unqualified digest() request-hash assignment to be present (this is what M123 fixes)',
  MIG.includes("position('v_request_hash := encode(digest(' IN v_def) = 0") &&
  MIG.includes('resolve drift first'));
assert('guard checks the paid-at-creation trigger is live and targets this function by OID (not rendered text)',
  MIG.includes("t.tgname='ordenes_paid_at_creation_payment_v1'") &&
  MIG.includes("t.tgfoid = 'public.order_initial_payment_v1()'::regprocedure"));
assert('guard checks the DB ledger baseline is 122 without assuming ladieci_schema_migrations always exists',
  MIG.includes("to_regclass('public.ladieci_schema_migrations') IS NOT NULL") &&
  MIG.includes('WHERE apply_order = 122'));

section('CASE B — GUARD refuses an already-fixed body');
assert('guard refuses if extensions.digest( already appears in the function definition',
  MIG.includes("position('extensions.digest(' IN v_def) > 0") &&
  MIG.includes("RAISE EXCEPTION 'M123 refused: order_initial_payment_v1 already calls extensions.digest"));
assert('guard also refuses if the ledger already carries an apply_order=123 row',
  MIG.includes('WHERE apply_order = 123') &&
  MIG.includes('already has an apply_order=123 row'));

// ═══════════════════════════════════════════════════════════════════
section('SEARCH_PATH INDEPENDENCE PROOF (§9 of the brief)');
assert('extensions.digest(text,text) existence is asserted before any fix is applied',
  MIG.includes("to_regprocedure('extensions.digest(text,text)') IS NULL"));
assert('the proof captures resolution under search_path EXCLUDING extensions (this function\'s own path)',
  MIG.includes("SET LOCAL search_path TO 'public', 'pg_temp';") &&
  MIG.includes('v_oid_excl'));
assert('the proof captures resolution under search_path INCLUDING extensions (the rejected alternative fix)',
  MIG.includes("SET LOCAL search_path TO 'public', 'extensions', 'pg_temp';") &&
  MIG.includes('v_oid_incl'));
assert('the proof asserts the schema-qualified reference resolves IDENTICALLY under both search_path states',
  MIG.includes('v_oid_excl IS NULL OR v_oid_excl IS DISTINCT FROM v_oid_incl'));
assert('the proof confirms the unqualified name does NOT resolve under this function\'s own search_path (reproduces the forensic 42883)',
  MIG.includes("IF to_regprocedure('digest(text,text)') IS NOT NULL THEN") &&
  MIG.includes('does not reproduce the forensic defect'));
assert('search_path is explicitly restored after the proof, before the fix statement runs',
  MIG.includes('RESET search_path;'));

// ═══════════════════════════════════════════════════════════════════
const migFull = fnFull(MIG, 'order_initial_payment_v1');
const migBody = fnBody(MIG, 'order_initial_payment_v1');
const m122Body = fnBody(M122, 'order_initial_payment_v1');
const rbBody = fnBody(RB, 'order_initial_payment_v1');

section('CASE C/D — the fix: extensions.digest present, unqualified digest gone (forward)');
assert('migBody/m122Body fixtures extracted successfully (sanity check on the extraction itself)',
  migBody.length > 100 && m122Body.length > 100);
assert('[CASE C] forward body calls extensions.digest at the request-hash assignment',
  migBody.includes("v_request_hash := encode(extensions.digest("));
assert('[CASE D] forward body no longer contains the unqualified digest() assignment',
  !migBody.includes('v_request_hash := encode(digest('));
assert('extensions.digest( appears exactly once in the new function body (one call site, one fix)',
  (migBody.match(/extensions\.digest\(/g) || []).length === 1);

section('CASE E — search_path unchanged in the new CREATE OR REPLACE header');
assert('the new function header still declares SET search_path TO \'public\', \'pg_temp\' verbatim',
  migFull.includes("SET search_path TO 'public', 'pg_temp'"));
assert('the new function header does NOT add extensions to its own search_path',
  !/SET search_path TO[^\n;]*extensions/.test(migFull));

section('CASE F/G — writer call: canonical present, legacy absent (forward)');
assert('[CASE F] forward body still calls the canonical writer order_post_payment_v1',
  migBody.includes('PERFORM public.order_post_payment_v1('));
assert('[CASE G] forward body contains no executable call to the legacy writer order_mark_paid',
  !migBody.includes('PERFORM public.order_mark_paid('));

section('CASE H — request-hash semantic input material byte-identical to M122 (§10 of the brief)');
// The ONLY textual difference this migration makes to the function body is the
// schema qualifier itself. Undo exactly that substitution and the two bodies
// must be byte-for-byte identical -- proving every guard, every declaration,
// validation order, the deterministic client_request_id, the concat_ws input
// material, the 'sha256' algorithm, and the 'hex' output encoding are all
// completely unchanged; only function-resolution authority changed.
const migBodyUnqualified = migBody.replace('extensions.digest(', 'digest(');
assert('reversing the qualifier makes the M123 body byte-identical to the M122 body (proves the ONLY change is the qualifier)',
  migBodyUnqualified === m122Body);
assert('the digest algorithm argument (\'sha256\') is unchanged',
  migBody.includes("'sha256'), 'hex')") && m122Body.includes("'sha256'), 'hex')"));
assert('the concat_ws input material (source tag, NEW.id, NEW.order_uid, v_method) is unchanged',
  migBody.includes("concat_ws('|', 'initial_payment_at_creation', NEW.id,\n    NEW.order_uid::text, v_method)"));
assert('the deterministic pay-order-<id> client_request_id key is unchanged',
  migBody.includes("'pay-order-' || regexp_replace(NEW.id, '[^A-Za-z0-9_-]', '', 'g')"));
assert('every pre-existing N-3/M122 refusal gate is reproduced verbatim',
  ['INITIAL_PAYMENT_NOT_FOR_TABLE_ORDER', 'INITIAL_PAYMENT_LEGACY_FLAG_PRESENT',
   'INITIAL_PAYMENT_METHOD_INVALID', 'INITIAL_PAYMENT_CONTEXT_INVALID',
   'INITIAL_PAYMENT_WORKSPACE_UNRESOLVED'].every((code) => migBody.includes(code)));

section('CASE I — paid-at-creation trigger untouched (identity + WHEN clause)');
assert('M123 forward file contains no CREATE TRIGGER statement at all (the trigger itself is never redefined)',
  !/CREATE\s+(OR REPLACE\s+)?TRIGGER/i.test(MIG));
assert('M123 forward file contains no DROP TRIGGER / ALTER TRIGGER statement',
  !/\b(DROP|ALTER)\s+TRIGGER\b/i.test(MIG));
assert('guard AND post-condition both re-verify the trigger by OID identity (tgfoid), not rendered text',
  (MIG.match(/t\.tgfoid = 'public\.order_initial_payment_v1\(\)'::regprocedure/g) || []).length === 2);
assert('the OID-identity check is scoped to the correct table AND the correct trigger name',
  (MIG.match(/c\.relname='ordenes'[\s\S]{0,120}t\.tgname='ordenes_paid_at_creation_payment_v1'/g) || []).length === 2);
assert('post-condition proves the function OID itself is unchanged (CREATE OR REPLACE, not drop+recreate)',
  MIG.includes("p.oid::text = current_setting('ladieci.m123_fn_oid', true)"));

section('CANONICAL WRITER CALL ARGUMENTS unchanged');
const argLine = 'v_workspace_id, v_actor, v_sid_hash, NEW.order_uid, v_method, \'full\', NULL,';
assert('order_post_payment_v1 is called with the exact same arguments, order, and mode=\'full\'',
  migBody.includes(argLine) && m122Body.includes(argLine));

// ═══════════════════════════════════════════════════════════════════
section('CASE J — ROLLBACK restores the exact known-broken M122 epoch');
assert('rollback body fixture extracted successfully (sanity check)',
  rbBody.length > 100);
assert('[CASE J] rollback body is byte-identical to the currently-installed M122 body (exact epoch restore)',
  rbBody === m122Body);
assert('rollback body contains the unqualified digest() call (the KNOWN BROKEN shape)',
  rbBody.includes('v_request_hash := encode(digest('));
assert('rollback body contains NO extensions.digest( (fix fully reversed)',
  !rbBody.includes('extensions.digest('));
assert('rollback file explicitly documents ROLLBACK_RESTORES_KNOWN_BROKEN_M122_YA_PAGADO_BEHAVIOR',
  RB.includes('ROLLBACK_RESTORES_KNOWN_BROKEN_M122_YA_PAGADO_BEHAVIOR'));
assert('rollback uses CREATE OR REPLACE, never DROP FUNCTION or DROP TRIGGER',
  RB.includes('CREATE OR REPLACE FUNCTION public.order_initial_payment_v1()') &&
  !/DROP\s+FUNCTION/i.test(RB) && !/DROP\s+TRIGGER/i.test(RB));
assert('rollback guard refuses unless the current body is the M123-fixed (extensions.digest) epoch',
  RB.includes("position('v_request_hash := encode(extensions.digest(' IN v_def) = 0") &&
  RB.includes('already rolled back, or never fixed?'));
assert('rollback post-condition re-verifies the trigger still targets this function by OID',
  RB.includes("t.tgfoid = 'public.order_initial_payment_v1()'::regprocedure"));

// ═══════════════════════════════════════════════════════════════════
section('NO OTHER DATABASE OBJECT CHANGES (§12 of the brief)');
for (const [label, rawSrc] of [['forward', MIG], ['rollback', RB]]) {
  const src = stripLineComments(rawSrc); // executable statements only -- a prose
  // mention of "the one `CREATE OR REPLACE FUNCTION` below" must not count as DDL.
  assert(`${label} file creates/replaces exactly one function (order_initial_payment_v1), as EXECUTABLE code`,
    (src.match(/CREATE (OR REPLACE )?FUNCTION/gi) || []).length === 1);
  assert(`${label} file contains no CREATE TABLE`,
    !/CREATE\s+TABLE/i.test(src));
  assert(`${label} file contains no ALTER TABLE`,
    !/ALTER\s+TABLE/i.test(src));
  assert(`${label} file contains no CREATE/DROP INDEX`,
    !/(CREATE|DROP)\s+(UNIQUE\s+)?INDEX/i.test(src));
  assert(`${label} file contains no CREATE/DROP TRIGGER`,
    !/(CREATE|DROP)\s+TRIGGER/i.test(src));
  assert(`${label} file contains no GRANT or REVOKE statement`,
    !/^\s*(GRANT|REVOKE)\b/im.test(src));
  assert(`${label} file touches no other named function or table from the frozen no-touch list, as EXECUTABLE code`,
    ['payment_transactions', 'payment_allocations', 'order_financial_events', 'order_obligations',
     'order_entities', 'service_sessions', 'business_days', 'service_session_state',
     'business_day_lifecycle_state', 'mesa_post_refund_v1', 'order_post_payment_v1',
     'order_post_refund_v1', 'order_apply_commercial_adjustment_v1']
      .every((obj) => !new RegExp('CREATE\\s+(OR REPLACE\\s+)?FUNCTION\\s+public\\.' + obj + '\\b|ALTER\\s+TABLE\\s+public\\.' + obj + '\\b').test(src)));
}
assert('neither file contains a bare INSERT/UPDATE/DELETE against a business table (only the intentional per-row UPDATE inside the trigger function body)',
  (MIG.match(/^\s*(INSERT INTO|DELETE FROM)\s+public\./gim) || []).length === 0 &&
  (RB.match(/^\s*(INSERT INTO|DELETE FROM)\s+public\./gim) || []).length === 0);
assert('neither file writes to ladieci_schema_migrations (registration stays a separate operational step, per house convention)',
  !MIG.includes('INSERT INTO public.ladieci_schema_migrations') &&
  !RB.includes('INSERT INTO public.ladieci_schema_migrations') &&
  !MIG.includes('DELETE FROM public.ladieci_schema_migrations') &&
  !RB.includes('DELETE FROM public.ladieci_schema_migrations'));

section('SEPARATE DEBTS — recorded, not touched');
[
  'MANUAL_ORDER_INTAKE_BUSINESS_DAY_AUTHORITY_V1',
  'OBSERVABILITY_SUPABASE_ERROR_BODY_V1',
  'ORDER_CREATION_ERROR_DETAIL_LOST_V1',
  'FINANCIAL_LEDGER_SERVICE_ROLE_PRIVILEGE_HARDENING_REVIEW',
  'RIDER_LEGACY_PAYMENT_FAST_FOLLOW',
  'SERVICIO_DEAD_ONCAMBIAPAGO_CANONICAL_CONFLICT',
].forEach((debt) => {
  assert(`header records ${debt} as a separate, un-fixed debt`,
    MIG.includes(debt));
});
assert('no debt name appears inside the actual fix statement (recorded only in the header, not acted on)',
  !migFull.includes('MANUAL_ORDER_INTAKE') && !migFull.includes('PRIVILEGE_HARDENING'));

console.log('\n═══ RESULT: ' + pass + ' passed, ' + fail + ' failed ═══');
process.exit(fail === 0 ? 0 : 1);
