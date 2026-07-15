'use strict';
// B7A1 static migration/SQL tests. Run: node tests/b7FinancialLedgerMigration.test.js
// NON-EXECUTING: asserts structure/safety of the B7A1 migration by inspecting SQL
// text. No DB, no staging, no apply. Structural negative assertions run on
// COMMENT-STRIPPED SQL so prose never satisfies a check.
const fs = require('fs');
const path = require('path');
let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

// ── discovery / filename convention ──────────────────────────────────────────
const MIG_DIR = path.join(__dirname, '..', 'migrations');
const ALL = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql'));
const isRB = (f) => f.endsWith('.ROLLBACK.sql');
const FWD_CONV = /^\d{4}-\d{2}-\d{2}_[a-z0-9_]+\.sql$/;
const RB_CONV = /^\d{4}-\d{2}-\d{2}_[a-z0-9_]+\.ROLLBACK\.sql$/;
const FWD = '2026-07-15_b7_financial_ledger_foundation.sql';
const RB = '2026-07-15_b7_financial_ledger_foundation.ROLLBACK.sql';
const FORWARD_SET = ALL.filter((f) => !isRB(f)).sort();

assert('forward filename matches convention', FWD_CONV.test(FWD) && !isRB(FWD));
assert('rollback filename matches convention', RB_CONV.test(RB));
assert('forward included in derived forward set', FORWARD_SET.includes(FWD));
assert('rollback excluded from forward set', !FORWARD_SET.includes(RB) && isRB(RB));
assert('forward version unique', FORWARD_SET.filter((f) => f === FWD).length === 1);
assert('both files exist', fs.existsSync(path.join(MIG_DIR, FWD)) && fs.existsSync(path.join(MIG_DIR, RB)));

const SQL = read('migrations/' + FWD);
const RBSQL = read('migrations/' + RB);
const strip = (s) => s.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
const S = strip(SQL);   // comment-stripped forward
const R = strip(RBSQL); // comment-stripped rollback

// ── transaction + sentinel + fail-closed partial guard ───────────────────────
assert('wrapped in BEGIN/COMMIT', /^\s*BEGIN;/.test(S) && /COMMIT;\s*$/.test(S.trim() + '\n'));
assert('staging sentinel guard present', /schema_migrations WHERE version='20260710075612'/.test(S));
assert('fail-closed partial-object guard (raises if any B7A1 object exists)',
  /to_regclass\('public\.order_financial_events'\) IS NOT NULL/.test(S) &&
  /order_financial_events_append_only/.test(S) && /partial B7A1 objects already present/.test(S));
assert('ledger uses plain CREATE TABLE (no permissive IF NOT EXISTS)',
  /CREATE TABLE public\.order_financial_events/.test(S) && !/CREATE TABLE IF NOT EXISTS public\.order_financial_events/.test(S));
assert('test performs no DB call', (() => { const self = read('tests/b7FinancialLedgerMigration.test.js'); return !/require\(['"](pg|postgres|@supabase)/.test(self) && !/\.query\(/.test(self); })());

// ── exact columns + types ────────────────────────────────────────────────────
const col = (name, typeRe) => assert(`column ${name} typed`, new RegExp(name + '\\s+' + typeRe).test(S));
col('id', 'uuid PRIMARY KEY DEFAULT gen_random_uuid\\(\\)');
col('order_id', 'text NOT NULL');
col('type', 'text NOT NULL');
col('amount', 'numeric\\(10,2\\) NOT NULL');
col('payment_method', 'text');
col('reason', 'text');
col('legacy', 'boolean NOT NULL DEFAULT false');
col('by_actor', 'text NOT NULL');
col('by_role', 'text NOT NULL');
col('prev_estado', 'text');
col('new_estado', 'text');
col('prev_pay_state', 'text NOT NULL');
col('new_pay_state', 'text NOT NULL');
col('original_giro_id', 'text');
col('ip_hash', 'text');
col('meta', "jsonb NOT NULL DEFAULT '\\{\\}'::jsonb");
col('idem_scope_key', 'text NOT NULL');
col('payload_digest', 'text NOT NULL');
col('created_at', 'timestamptz NOT NULL DEFAULT now\\(\\)');

// ── FKs ──────────────────────────────────────────────────────────────────────
assert('order_id FK → ordenes(id) ON DELETE RESTRICT',
  /foreign key \(order_id\)\s*references public\.ordenes\(id\) on delete restrict/i.test(S));
assert('by_actor FK → auth_actors(actor) ON DELETE RESTRICT',
  /foreign key \(by_actor\)\s*references public\.auth_actors\(actor\) on delete restrict/i.test(S));
assert('NO FK on original_giro_id', !/foreign key \(original_giro_id\)/i.test(S) && !/original_giro_id[^,]*references/i.test(S));

// ── checks ───────────────────────────────────────────────────────────────────
assert('type set exact', /type in \('payment','refund','void','payment_imported'\)/.test(S));
assert('amount-by-type (void=0, else >0)', /type = 'void' and amount = 0.*type <> 'void' and amount > 0/s.test(S));
assert('payment_method canonical set + void NULL',
  /type = 'void' and payment_method is null/.test(S) &&
  /payment_method in \('efectivo','tarjeta','bizum'\)/.test(S));
assert('legacy rules', /type = 'payment_imported' and legacy = true.*type <> 'payment_imported' and legacy = false/s.test(S));
assert('original_giro non-void → NULL', /type = 'void' or original_giro_id is null/.test(S));
assert('reason rules (payment optional non-blank; others required non-blank)',
  /type = 'payment' and \(reason is null or btrim\(reason\) <> ''\)/.test(S) &&
  /type in \('refund','void','payment_imported'\) and reason is not null and btrim\(reason\) <> ''/.test(S));
assert('by_actor allowlist', /by_actor in \('owner','operator_primary','operator_backup','rider'\)/.test(S));
assert('by_role allowlist', /by_role in \('admin','operator','rider'\)/.test(S));
assert('actor-role coherence map', /by_actor='owner'\s+and by_role='admin'/.test(S) && /by_actor='rider'\s+and by_role='rider'/.test(S));
assert('pay-state value sets', /prev_pay_state in \('unpaid','paid','refunded'\)/.test(S) && /new_pay_state in \('unpaid','paid','refunded'\)/.test(S));
assert('pay-state per-event transitions',
  /type='payment'\s+and prev_pay_state='unpaid' and new_pay_state='paid'/.test(S) &&
  /type='payment_imported' and prev_pay_state='unpaid' and new_pay_state='paid'/.test(S) &&
  /type='refund'\s+and prev_pay_state='paid'\s+and new_pay_state='refunded'/.test(S) &&
  /type='void'\s+and prev_pay_state = new_pay_state/.test(S));
assert('ip_hash rules (null ok; else non-blank <=64)', /ip_hash is null or \(btrim\(ip_hash\) <> '' and length\(ip_hash\) <= 64\)/.test(S));
assert('meta object + 2048 size', /jsonb_typeof\(meta\) = 'object' and length\(meta::text\) <= 2048/.test(S));
assert('idem_scope_key 8..128 + regex', /char_length\(idem_scope_key\) between 8 and 128 and idem_scope_key ~ '\^\[A-Za-z0-9_-\]\+\$'/.test(S));
assert('payload_digest sha256-hex-64 regex', /payload_digest ~ '\^\[0-9a-f\]\{64\}\$'/.test(S));

// ── indexes / uniqueness ─────────────────────────────────────────────────────
assert('scoped idempotency UNIQUE(order_id,type,idem_scope_key)',
  /unique \(order_id, type, idem_scope_key\)/.test(S));
assert('one payment basis partial unique',
  /CREATE UNIQUE INDEX order_financial_events_one_payment_uq[\s\S]*?\(order_id\) WHERE type in \('payment','payment_imported'\)/.test(S));
assert('one refund partial unique',
  /CREATE UNIQUE INDEX order_financial_events_one_refund_uq[\s\S]*?\(order_id\) WHERE type = 'refund'/.test(S));
assert('history index (order_id, created_at)',
  /CREATE INDEX order_financial_events_order_created_idx[\s\S]*?\(order_id, created_at\)/.test(S));

// ── append-only trigger/function ─────────────────────────────────────────────
assert('append-only function SECURITY INVOKER + pinned search_path',
  /FUNCTION public\.order_financial_events_append_only\(\)[\s\S]*?SECURITY INVOKER[\s\S]*?SET search_path = public, pg_temp/.test(S));
assert('append-only function raises + no dynamic SQL',
  /RAISE EXCEPTION 'order_financial_events is append-only'/.test(S) &&
  !/\bEXECUTE\s+format\b/i.test(S) && !/\bEXECUTE\s+'/.test(S));
assert('append-only trigger BEFORE UPDATE OR DELETE',
  /CREATE TRIGGER order_financial_events_no_update_delete\s+BEFORE UPDATE OR DELETE ON public\.order_financial_events/.test(S));
assert('append-only function execute revoked from public/anon/authenticated',
  /REVOKE ALL ON FUNCTION public\.order_financial_events_append_only\(\) FROM PUBLIC, anon, authenticated/.test(S));

// ── RLS + grants ─────────────────────────────────────────────────────────────
assert('RLS enabled', /ALTER TABLE public\.order_financial_events ENABLE ROW LEVEL SECURITY/.test(S));
assert('ZERO create policy', !/CREATE POLICY/i.test(S));
assert('table revoked from public/anon/authenticated', /REVOKE ALL ON public\.order_financial_events FROM PUBLIC, anon, authenticated/.test(S));
assert('service_role granted SELECT, INSERT only', /GRANT SELECT, INSERT ON public\.order_financial_events TO service_role/.test(S));
assert('NO update/delete/truncate/references/trigger grant', !/GRANT[^;]*\b(UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER)\b[^;]*TO service_role/i.test(S));
assert('NO GRANT ALL / broad grants', !/GRANT ALL/i.test(S) && !/GRANT[\s\S]*?TO (PUBLIC|anon|authenticated)\b/i.test(S));

// ── additive columns ─────────────────────────────────────────────────────────
assert('ordenes.refunded boolean NOT NULL DEFAULT false',
  /ALTER TABLE public\.ordenes ADD COLUMN refunded boolean NOT NULL DEFAULT false/.test(S));
assert('manual_giros.assigned_actor FK → auth_actors(actor) ON DELETE RESTRICT',
  /ADD COLUMN assigned_actor text\s*REFERENCES public\.auth_actors\(actor\) ON DELETE RESTRICT/.test(S));
assert('manual_giros.assigned_actor CHECK (null or rider)',
  /manual_giros_assigned_actor_chk\s*CHECK \(assigned_actor IS NULL OR assigned_actor = 'rider'\)/.test(S));
assert('manual_giros assigned_actor partial unique (active per rider)',
  /CREATE UNIQUE INDEX manual_giros_assigned_actor_active_uq[\s\S]*?\(assigned_actor\)[\s\S]*?WHERE assigned_actor IS NOT NULL AND dissolved_at IS NULL/.test(S));
assert('auth_actors.active_manual_giro_id FK → manual_giros(id) ON DELETE SET NULL',
  /ADD COLUMN active_manual_giro_id text\s*REFERENCES public\.manual_giros\(id\) ON DELETE SET NULL/.test(S));
assert('auth_actors.active_manual_giro_id CHECK (null or role rider)',
  /auth_actors_active_giro_role_chk\s*CHECK \(active_manual_giro_id IS NULL OR role = 'rider'\)/.test(S));
assert('NO unique index on the active pointer',
  !/UNIQUE INDEX[^\n]*active_manual_giro_id/i.test(S) && !/unique\s*\(active_manual_giro_id\)/i.test(S));

// ── no business RPC created in B7A1 ──────────────────────────────────────────
assert('no business RPC (only the append-only trigger function)',
  (S.match(/CREATE OR REPLACE FUNCTION/gi) || []).length === 1 &&
  !/public\.order_(create|mark_paid|rider_deliver|void|refund|import)/i.test(S));

// ── rollback guards + non-destructive + only B7A1 objects ────────────────────
assert('rollback has all five guards', /ROLLBACK REFUSED/.test(R) &&
  /order_financial_events/.test(R) && /refunded = true/.test(R) &&
  /assigned_actor IS NOT NULL/.test(R) && /active_manual_giro_id IS NOT NULL/.test(R) &&
  /estado = 'ANULADO'/.test(R));
assert('rollback never mutates data (no DELETE FROM/UPDATE ... SET on data)',
  !/DELETE FROM public\.(order_financial_events|ordenes|manual_giros|auth_actors)/i.test(R) &&
  !/UPDATE public\.(ordenes|manual_giros|auth_actors)\s+SET/i.test(R));
assert('rollback drops only B7A1 objects', /DROP TABLE\s+IF EXISTS public\.order_financial_events/.test(R) &&
  /DROP FUNCTION IF EXISTS public\.order_financial_events_append_only/.test(R) &&
  /DROP COLUMN IF EXISTS assigned_actor/.test(R) && /DROP COLUMN IF EXISTS active_manual_giro_id/.test(R) &&
  /DROP COLUMN IF EXISTS refunded/.test(R));
assert('rollback does not touch auth/order migrations objects beyond B7A1',
  !/auth_audit|auth_recovery_windows|DROP TABLE IF EXISTS public\.ordenes|DROP TABLE IF EXISTS public\.manual_giros|DROP TABLE IF EXISTS public\.auth_actors/.test(R));

// ── NEGATIVE CONTROLS ────────────────────────────────────────────────────────
(function nc() {
  const brokenGrantAll = S.replace('GRANT SELECT, INSERT ON public.order_financial_events TO service_role', 'GRANT ALL ON public.order_financial_events TO service_role');
  assert('NC1: detector catches GRANT ALL', /GRANT ALL/i.test(brokenGrantAll));
  const brokenFk = S.replace('references public.ordenes(id) on delete restrict', 'references public.ordenes(id) on delete cascade');
  assert('NC2: detector catches non-RESTRICT order FK', !/foreign key \(order_id\)\s*references public\.ordenes\(id\) on delete restrict/i.test(strip(brokenFk)));
  const brokenGuard = R.replace(/estado = 'ANULADO'/g, "estado = 'X'");
  assert('NC3: detector catches a missing ANULADO rollback guard', !/estado = 'ANULADO'/.test(brokenGuard));
  const brokenDigest = S.replace(/payload_digest ~ '\^\[0-9a-f\]\{64\}\$'/, "payload_digest ~ '.*'");
  assert('NC4: detector catches a weakened digest regex', !/payload_digest ~ '\^\[0-9a-f\]\{64\}\$'/.test(brokenDigest));
})();

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
