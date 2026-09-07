'use strict';
// CHECK-CENTRIC UNIVERSAL CASH V1 (DB migration 122) — generalizes the canonical
// payment ledger (payment_transactions / payment_allocations / order_financial_events)
// so a non-table order (Servicio/Banco/Retiro) can post a real, refundable,
// transaction-backed payment through it. Run: node tests/checkCentricUniversalCashV1Migration.test.js
//
// OFFLINE. No DB, no network -- exactly like tests/ajusteComercialV1.test.js and
// tests/refundV1SliceAMigration.test.js. What this file proves is everything that
// lives in the repository: the migration's own text, the rollback's honesty, the
// role split, and that Mesa's existing writers are not redefined here. The DB-side
// BEHAVIOUR (constraint enforcement, trigger firing, idempotent replay) requires a
// database this slice was explicitly told not to touch (staging) or provision
// (a Supabase branch) without separate authorization -- see the slice report.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://stub.local';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'stub-service-role-key';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => {
  if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); }
};
const section = (t) => console.log('\n── ' + t + ' ──');

const MIG_DIR = path.join(__dirname, '..', 'migrations');
const MIG_FILE = '2026-09-07_check_centric_universal_cash_v1_migration_122.sql';
const RB_FILE = '2026-09-07_check_centric_universal_cash_v1_migration_122.ROLLBACK.sql';
const MIG = fs.readFileSync(path.join(MIG_DIR, MIG_FILE), 'utf8');
const RB = fs.readFileSync(path.join(MIG_DIR, RB_FILE), 'utf8');

// Extract a function's REAL body (between its own AS $function$ ... $function$; delimiters).
// Slicing on prose landmarks instead would let a neighbouring comment satisfy -- or defeat --
// an assertion about the SQL.
function fnBody(src, name) {
  const marker = 'FUNCTION public.' + name + '(';
  const i = src.indexOf(marker);
  if (i < 0) return '';
  const j = src.indexOf('AS $function$', i);
  const k = src.indexOf('$function$;', j + 13);
  return src.slice(j + 13, k);
}

// ═══════════════════════════════════════════════════════════════════
section('NO MIGRATION 123, NO NEW TABLE, LEDGER STAYS 121');
assert('no migration 123 file exists',
  !fs.readdirSync(MIG_DIR).some((f) => /_migration_123\b/.test(f) || /^2026-09-\d\d_.*123/.test(f)));
assert('this migration creates NO new table',
  !/CREATE\s+TABLE/i.test(MIG));
assert('the file declares ledger stays 121 (not applied here)',
  MIG.includes('ledger stays 121'));
assert('the file states NO PUSH / NO DEPLOY / NO STAGING DB APPLY',
  /NO PUSH.*NO DEPLOY.*NO\s*\n?-- STAGING DB APPLY/s.test(MIG.replace(/\r/g, '')) ||
  (MIG.includes('NO PUSH') && MIG.includes('NO DEPLOY') && MIG.includes('STAGING DB APPLY')));

section('PRE-CONDITION GUARD — refuses on drift / already-applied');
assert('guard refuses if table_session_id is already nullable',
  MIG.includes('payment_transactions.table_session_id is already nullable'));
assert('guard refuses if table_order_line_id is already nullable',
  MIG.includes('payment_allocations.table_order_line_id is already nullable'));
assert('guard refuses if order_uid column already exists',
  MIG.includes('payment_allocations.order_uid already exists'));
assert('guard proves zero pre-existing NULL table_session_id rows',
  MIG.includes('payment_transactions already has NULL table_session_id rows'));
assert('guard proves zero pre-existing NULL table_order_line_id rows',
  MIG.includes('payment_allocations already has NULL table_order_line_id rows'));
assert('guard refuses if any new writer already exists',
  MIG.includes("'order_post_payment_v1','order_post_refund_v1','order_apply_commercial_adjustment_v1'"));
assert('guard checks mesa_post_refund_v1 still has the pre-fix comparison',
  MIG.includes("position('v_original.table_session_id <> p_table_session_id' IN v_def) = 0"));
assert('guard refuses if the IS DISTINCT FROM fix is already present',
  MIG.includes("position('v_original.table_session_id IS DISTINCT FROM p_table_session_id' IN v_def) > 0"));
assert('guard snapshots row counts (no-backfill proof basis)',
  MIG.includes('ladieci.m122_pt_count') && MIG.includes('ladieci.m122_pa_count')
  && MIG.includes('ladieci.m122_ordenes_count') && MIG.includes('ladieci.m122_ofe_count'));
assert('guard snapshots md5(prosrc) for every function that must stay byte-identical',
  ['m122_mesa_pay_md5','m122_mesa_close_md5','m122_mesa_adj_md5','m122_obl_adj_md5',
   'm122_canon_obl_md5','m122_has_evidence_md5','m122_paid_guard_md5','m122_assign_fe_md5',
   'm122_ledger_write_md5','m122_order_mark_paid_md5'].every((k) => MIG.includes(k)));

section('SCHEMA — payment_transactions.table_session_id');
assert('DROP NOT NULL on table_session_id',
  /ALTER TABLE public\.payment_transactions ALTER COLUMN table_session_id DROP NOT NULL/.test(MIG));
assert('scope CHECK added with the exact OR predicate',
  /ADD CONSTRAINT payment_transactions_scope_chk\s*\n?\s*CHECK \(table_session_id IS NOT NULL OR service_session_id IS NOT NULL\)/.test(MIG));
assert('post-condition asserts the CHECK exact pg_get_constraintdef shape',
  MIG.includes("'CHECK (((table_session_id IS NOT NULL) OR (service_session_id IS NOT NULL)))'"));
assert('no service_session_id NOT NULL is introduced (contract report §B: do not over-tighten)',
  !/service_session_id\s+SET NOT NULL/i.test(MIG));

section('SCHEMA — payment_allocations.table_order_line_id / order_uid');
assert('DROP NOT NULL on table_order_line_id',
  /ALTER TABLE public\.payment_allocations ALTER COLUMN table_order_line_id DROP NOT NULL/.test(MIG));
assert('order_uid column added as nullable uuid, no default',
  /ADD COLUMN order_uid uuid;/.test(MIG));
assert('FK targets order_entities, NOT ordenes (ordenes.order_uid sits behind a PARTIAL unique index)',
  /FOREIGN KEY \(order_uid\) REFERENCES public\.order_entities\(order_uid\)/.test(MIG) &&
  !/FOREIGN KEY \(order_uid\) REFERENCES public\.ordenes\(order_uid\)/.test(MIG));
assert('target CHECK is OR, not XOR (a future Mesa allocation may carry both)',
  /ADD CONSTRAINT payment_allocations_target_chk\s*\n?\s*CHECK \(table_order_line_id IS NOT NULL OR order_uid IS NOT NULL\)/.test(MIG));
assert('companion partial UNIQUE index closes the NULL-distinct hazard',
  /CREATE UNIQUE INDEX payment_allocations_transaction_order_uq\s*\n\s*ON public\.payment_allocations \(payment_transaction_id, order_uid\)\s*\n\s*WHERE table_order_line_id IS NULL/.test(MIG));
assert('a lookup index on order_uid exists',
  /CREATE INDEX payment_allocations_order_uid_idx/.test(MIG));

section('auth_audit_event_chk — two new check-centric events, nothing removed');
const rbAuditEvents = (RB.match(/ADD CONSTRAINT auth_audit_event_chk CHECK[\s\S]*?\]\)\);/) || [''])[0];
const migAuditEvents = (MIG.match(/ADD CONSTRAINT auth_audit_event_chk CHECK[\s\S]*?\]\)\);/) || [''])[0];
assert('migration adds ORDER_PAYMENT_REFUNDED', migAuditEvents.includes('ORDER_PAYMENT_REFUNDED'));
assert('migration adds ORDER_COMMERCIAL_ADJUSTMENT', migAuditEvents.includes('ORDER_COMMERCIAL_ADJUSTMENT'));
assert('migration keeps every pre-existing event value (superset, not replace)',
  ['MESA_PAYMENT_REFUNDED', 'MESA_COMMERCIAL_ADJUSTMENT', 'ORDER_CANCELLED', 'PAYMENT_DUPLICATE_CONFIRMED']
    .every((v) => migAuditEvents.includes(v)));
assert('rollback restores the exact pre-122 event list (no ORDER_PAYMENT_REFUNDED/ORDER_COMMERCIAL_ADJUSTMENT)',
  !rbAuditEvents.includes('ORDER_PAYMENT_REFUNDED') && !rbAuditEvents.includes('ORDER_COMMERCIAL_ADJUSTMENT')
  && rbAuditEvents.includes('ORDER_CANCELLED'));

section('order_post_payment_v1 — the check-centric payment writer');
const payFn = fnBody(MIG, 'order_post_payment_v1');
assert('function body extracted (non-empty)', payFn.length > 500);
assert('only full/custom_amount modes accepted (no covers, no line selection)',
  payFn.includes("p_mode NOT IN ('full','custom_amount')"));
assert('preserves the existing Servicio gate: admin/operator only, not Mesa\'s broader set',
  payFn.includes("v_actor.role NOT IN ('admin','operator')") &&
  !payFn.includes("'cashier'") && !payFn.includes("'legacy_operator'"));
assert('refuses a table order at the boundary (defense in depth)',
  payFn.includes('ORDER_PAYMENT_NOT_FOR_TABLE_ORDER') && payFn.includes('v_entity.table_session_id IS NOT NULL'));
assert('table_session_id is inserted as NULL, service_session_id as the resolved receipt service',
  /INSERT INTO public\.payment_transactions\([\s\S]{0,400}\) VALUES \(\s*p_workspace_id, NULL, v_receipt_service_id/.test(payFn));
assert('fails closed if no open service can be resolved (would otherwise violate the new scope CHECK)',
  payFn.includes('ORDER_PAYMENT_NO_OPEN_SERVICE') && payFn.includes('v_receipt_service_id IS NULL'));
assert('exactly ONE allocation per transaction, order_uid-targeted, table_order_line_id NULL',
  /INSERT INTO public\.payment_allocations\([\s\S]{0,200}\) VALUES \(v_tx\.id, NULL, v_ord\.id, p_order_uid/.test(payFn));
assert('obligation read via the canonical reader, not a line sum',
  payFn.includes('order_canonical_obligation_v1(p_order_uid)'));
assert('netCollected computed from order_financial_events (captures legacy AND canonical money)',
  /v_paid_before_cents[\s\S]{0,300}order_financial_events/.test(payFn));
assert('rejects a direct overpay (amount > outstanding) -- same policy as Mesa',
  payFn.includes('ORDER_PAYMENT_AMOUNT_INVALID') && payFn.includes('v_amount_cents > v_outstanding_cents'));
assert('already-settled order rejected before any write',
  payFn.includes('ORDER_PAYMENT_ALREADY_SETTLED') && payFn.includes('v_outstanding_cents <= 0'));
assert('idempotency reuses payment_transactions_idempotency_uq via (workspace_id, client_request_id) lookup',
  /SELECT \* INTO v_existing FROM public\.payment_transactions\s*\n\s*WHERE workspace_id = p_workspace_id AND client_request_id = p_client_request_id;/.test(payFn));
assert('idempotency conflict on mismatched request_hash (not silently reused)',
  payFn.includes('ORDER_PAYMENT_IDEMPOTENCY_CONFLICT') && payFn.includes('v_existing.request_hash <> p_request_hash'));
assert('duplicate-candidate detection scoped by order_uid (not table_session)', (() => {
  const dupStart = payFn.indexOf('SELECT EXISTS (');
  const dupEnd = payFn.indexOf('ORDER_PAYMENT_POSSIBLE_DUPLICATE');
  if (dupStart < 0 || dupEnd < 0 || dupEnd < dupStart) return false;
  const dupBlock = payFn.slice(dupStart, dupEnd);
  return dupBlock.includes('pa.order_uid = p_order_uid') && !/table_session/i.test(dupBlock);
})());
assert('publishes overCollected (never netted against unpaid) and unpaid separately',
  payFn.includes("'overCollected'") && payFn.includes("'unpaid'"));
assert('mirror projection reuses MIXTO on mixed tender, same vocabulary as Mesa',
  payFn.includes("'MIXTO'"));
assert('search_path keeps `extensions` (digest() lives there, used for payload_digest)',
  /FUNCTION public\.order_post_payment_v1[\s\S]{0,700}SET search_path TO 'public', 'extensions', 'pg_temp'/.test(MIG));
assert('grants are service_role-only',
  /GRANT EXECUTE ON FUNCTION public\.order_post_payment_v1\([\s\S]{0,120}\) TO service_role;/.test(MIG) &&
  /REVOKE ALL ON FUNCTION public\.order_post_payment_v1\([\s\S]{0,120}\) FROM PUBLIC, anon, authenticated;/.test(MIG));

section('order_post_refund_v1 — the check-centric Refund V1 adapter');
const refundFn = fnBody(MIG, 'order_post_refund_v1');
assert('function body extracted (non-empty)', refundFn.length > 500);
assert('REFUND_ROLES identical to Mesa: admin/owner only',
  refundFn.includes("v_actor.role NOT IN ('admin','owner')"));
assert('requires an existing payment_transactions row and rejects a non-payment kind',
  refundFn.includes('ORDER_REFUND_NOT_REFUNDABLE') && refundFn.includes("v_original.kind <> 'payment'"));
assert('rejects a Mesa (table-bound) transaction -- symmetric to the mesa_post_refund_v1 null-safe guard',
  refundFn.includes('ORDER_REFUND_NOT_CHECK_CENTRIC') && refundFn.includes('v_original.table_session_id IS NOT NULL'));
assert('resolves the original allocation and checks it targets the SAME order_uid',
  refundFn.includes('ORDER_REFUND_TRANSACTION_MISMATCH') && refundFn.includes('v_alloc.order_uid IS DISTINCT FROM p_order_uid'));
assert('remaining-refundable computed from reverses_transaction_id (partial + multiple refunds)',
  refundFn.includes("r.kind='refund' AND r.reverses_transaction_id = v_original.id"));
assert('already-fully-refunded rejected', refundFn.includes('ORDER_REFUND_ALREADY_FULL'));
assert('over-refund (amount > remaining) rejected', refundFn.includes('ORDER_REFUND_EXCEEDS_REMAINING'));
assert('same-tender FORCED from the original -- no caller-supplied method in the signature',
  !/p_payment_method/.test(MIG.slice(MIG.indexOf('FUNCTION public.order_post_refund_v1'),
                                       MIG.indexOf('AS $function$', MIG.indexOf('FUNCTION public.order_post_refund_v1')))) &&
  refundFn.includes('v_original.payment_method, 0, v_original.id'));
assert('reason is required', refundFn.includes('ORDER_REFUND_REASON_REQUIRED'));
assert('never mutates order_obligations (refund moves money, not the obligation)',
  !/order_obligations/.test(refundFn));
assert('ordenes.refunded is never set (would misstate a partial reversal)',
  !/refunded\s*=/.test(refundFn));
assert('no table_session_id / open-session requirement anywhere in this function (terminal orders fine)',
  !/table_sessions/.test(refundFn) && !/status\s*<>\s*.open./.test(refundFn));
assert('grants are service_role-only',
  /GRANT EXECUTE ON FUNCTION public\.order_post_refund_v1\([\s\S]{0,140}\) TO service_role;/.test(MIG));

section('order_apply_commercial_adjustment_v1 — thin adapter, zero duplicated obligation logic');
const adjFn = fnBody(MIG, 'order_apply_commercial_adjustment_v1');
assert('function body extracted (non-empty)', adjFn.length > 300);
assert('ADJUSTMENT_ROLES identical to Mesa: admin/owner only',
  adjFn.includes("v_actor.role NOT IN ('admin','owner')"));
assert('delegates to the SAME shared core Mesa\'s wrapper calls -- no reimplemented obligation math',
  adjFn.includes('public.order_obligation_apply_adjustment_v1('));
assert('does not reimplement bootstrap/revision logic (no INSERT INTO order_obligations here)',
  !/INSERT INTO public\.order_obligations/.test(adjFn));
assert('no table_session_id parameter or requirement anywhere in this function',
  !/table_session/i.test(MIG.slice(MIG.indexOf('FUNCTION public.order_apply_commercial_adjustment_v1'),
                                     MIG.indexOf('AS $function$', MIG.indexOf('FUNCTION public.order_apply_commercial_adjustment_v1')))));
assert('netCollected computed from order_financial_events, NOT payment_allocations (§17: legacy money must still count)',
  /v_net[\s\S]{0,250}FROM public\.order_financial_events/.test(adjFn) &&
  !/FROM public\.payment_allocations|JOIN public\.payment_allocations/.test(adjFn));
assert('reason required, no-change rejected', adjFn.includes('ORDER_ADJUSTMENT_REASON_REQUIRED') && adjFn.includes('ORDER_ADJUSTMENT_NO_CHANGE'));
assert('grants are service_role-only',
  /GRANT EXECUTE ON FUNCTION public\.order_apply_commercial_adjustment_v1\([\s\S]{0,160}\) TO service_role;/.test(MIG));

section('mesa_post_refund_v1 — ONE line changed, Mesa semantics preserved');
const mesaRefundFn = fnBody(MIG, 'mesa_post_refund_v1');
assert('the fixed comparison is present', mesaRefundFn.includes('v_original.table_session_id IS DISTINCT FROM p_table_session_id'));
assert('the old NULL-unsafe comparison is gone', !mesaRefundFn.includes('v_original.table_session_id <> p_table_session_id'));
assert('every other `<>` in the function is untouched (this is a one-line fix, not a rewrite)',
  (mesaRefundFn.match(/<>/g) || []).length >= 3); // request_hash<>, by_actor<>, kind<>
assert('CREATE OR REPLACE (not DROP+CREATE) -- same signature, grants carry over automatically',
  /CREATE OR REPLACE FUNCTION public\.mesa_post_refund_v1\(p_workspace_id uuid, p_by_actor text, p_by_sid_hash text, p_table_session_id uuid, p_original_transaction_id uuid, p_reason text, p_client_request_id text, p_request_hash text, p_amount numeric DEFAULT NULL::numeric, p_meta jsonb DEFAULT '\{\}'::jsonb\)/.test(MIG));
assert('post-condition asserts the fix landed and the old comparison is gone',
  MIG.includes("position('v_original.table_session_id <> p_table_session_id' IN v_def) > 0") &&
  MIG.includes("position('v_original.table_session_id IS DISTINCT FROM p_table_session_id' IN v_def) = 0"));

section('PARAMETER-DEFAULT FAST-FOLLOW — the exact 42P13 caught on a real byte-exact STAGING apply attempt');
// A byte-exact apply of the pre-fast-follow file against live STAGING failed with PostgreSQL
// 42P13 ("cannot remove parameter defaults from existing function"): CREATE OR REPLACE refuses
// to silently drop a parameter's existing DEFAULT, and the live mesa_post_refund_v1 has always
// carried DEFAULT NULL::numeric / DEFAULT '{}'::jsonb on its last two parameters (independently
// confirmed live via pg_get_function_arguments before this fast-follow). The very test above
// (pre-fast-follow) asserted the buggy declaration as if it were correct -- proof that a purely
// static/textual review of a CREATE OR REPLACE cannot catch a missing-default defect; only a
// real apply attempt (or an explicit live-signature diff) can.
assert('declares the live p_amount default verbatim (DEFAULT NULL::numeric)',
  MIG.includes('p_amount numeric DEFAULT NULL::numeric, p_meta jsonb'));
assert('declares the live p_meta default verbatim (DEFAULT \'{}\'::jsonb)',
  MIG.includes("p_meta jsonb DEFAULT '{}'::jsonb"));
const mesaRefundDeclFixed =
  "p_workspace_id uuid, p_by_actor text, p_by_sid_hash text, p_table_session_id uuid, p_original_transaction_id uuid, p_reason text, p_client_request_id text, p_request_hash text, p_amount numeric DEFAULT NULL::numeric, p_meta jsonb DEFAULT '{}'::jsonb";
const mesaRefundDeclOriginal =
  "p_workspace_id uuid, p_by_actor text, p_by_sid_hash text, p_table_session_id uuid, p_original_transaction_id uuid, p_reason text, p_client_request_id text, p_request_hash text, p_amount numeric, p_meta jsonb";
assert('identity arguments (types, order, count) are byte-identical to the live pre-122 signature -- only the two DEFAULT clauses were added, nothing else',
  MIG.includes(mesaRefundDeclFixed) &&
  mesaRefundDeclFixed.replace(' DEFAULT NULL::numeric', '').replace(" DEFAULT '{}'::jsonb", '') === mesaRefundDeclOriginal);
assert('still CREATE OR REPLACE, not DROP+CREATE -- no DROP FUNCTION for mesa_post_refund_v1 anywhere in the forward file (defaults preserved in-declaration instead)',
  !/DROP\s+FUNCTION[^;]*mesa_post_refund_v1/i.test(MIG));
assert('the fixed declaration appears exactly once (no duplicate CREATE for the same function)',
  (MIG.match(/CREATE OR REPLACE FUNCTION public\.mesa_post_refund_v1\(/g) || []).length === 1);
assert('the body-level assertions above (fixed comparison present, old one gone, other `<>` untouched) still hold on the SAME extracted body -- the default fix touched only the parameter list, never AS $function$',
  mesaRefundFn.includes('v_original.table_session_id IS DISTINCT FROM p_table_session_id') &&
  !mesaRefundFn.includes('v_original.table_session_id <> p_table_session_id'));
// ROLLBACK PARAMETER-DEFAULT FAST-FOLLOW (owner-approved) -- the KNOWN DEFECT the previous
// fast-follow deliberately flagged (rollback's CREATE OR REPLACE for mesa_post_refund_v1 omitted
// the same two DEFAULTs the forward file's own item-7 fast-follow had to add) is now fixed in
// the rollback too. §9 required assertions 1-9 below; items 10-12 (Migration 123 absent, no new
// table, no backfill) are already proven, byte-unmoved by this rollback-only change, by the
// "NO MIGRATION 123, NO NEW TABLE, LEDGER STAYS 121" and "POST-CONDITION" sections above -- not
// duplicated here.
const rbMesaRefundFn = fnBody(RB, 'mesa_post_refund_v1');
assert('[§9.1] rollback declares the live p_amount default verbatim (DEFAULT NULL::numeric)',
  RB.includes('p_amount numeric DEFAULT NULL::numeric, p_meta jsonb'));
assert('[§9.2] rollback declares the live p_meta default verbatim (DEFAULT \'{}\'::jsonb)',
  RB.includes("p_meta jsonb DEFAULT '{}'::jsonb"));
assert('[§9.3/§9.4] identity arguments (types AND order) are byte-identical to the live pre-122 signature in the rollback too -- only the two DEFAULT clauses were added, nothing else',
  RB.includes(mesaRefundDeclFixed) &&
  mesaRefundDeclFixed.replace(' DEFAULT NULL::numeric', '').replace(" DEFAULT '{}'::jsonb", '') === mesaRefundDeclOriginal);
assert('[§9.5] return contract unchanged -- rollback declaration is still followed by RETURNS jsonb',
  RB.slice(RB.indexOf('CREATE OR REPLACE FUNCTION public.mesa_post_refund_v1('),
           RB.indexOf('CREATE OR REPLACE FUNCTION public.mesa_post_refund_v1(') + 700)
    .includes('RETURNS jsonb'));
assert('[§9.6] rollback body otherwise unchanged -- still restores the pre-fix NULL-unsafe `<>`, never the IS DISTINCT FROM fix (the default fix touched only the parameter list, never AS $function$)',
  rbMesaRefundFn.includes('v_original.table_session_id <> p_table_session_id') &&
  !rbMesaRefundFn.includes('v_original.table_session_id IS DISTINCT FROM p_table_session_id'));
assert('[§9.7] no DROP FUNCTION mesa_post_refund_v1 anywhere in the rollback (defaults preserved in-declaration, not via drop+recreate)',
  !/DROP\s+FUNCTION[^;]*mesa_post_refund_v1/i.test(RB));
assert('[§9.9] rollback hard-refuse guards preserved verbatim (both canonical-fact checks still present, unmoved by this parameter-only edit)',
  RB.includes('M122 ROLLBACK refused') &&
  RB.includes('a payment_transactions row with table_session_id IS NULL exists') &&
  RB.includes('a payment_allocations row with table_order_line_id IS NULL or order_uid IS NOT NULL exists'));
// NOTE: forward Migration 122 was byte-identical to commit 0dffc2c as of the rollback-only
// fast-follow (8ec5e24) -- that checkpoint (ae15840600e14bd9...) is superseded by the
// comment-safe postcondition fast-follow below, which DOES intentionally change the forward
// file; its own current checksum is pinned in that section instead of re-asserted here.

section('§10 — forward/rollback compatibility: neither direction can hit 42P13 for mesa_post_refund_v1');
// The exact live signature independently confirmed via pg_get_function_arguments during the
// STAGING promotion attempt that surfaced this whole defect class (both fast-follows). Encoded
// once here as the single source of truth this offline test checks the forward AND rollback
// files against -- if either file's declaration ever stops containing this exact substring,
// that direction's CREATE OR REPLACE would attempt to remove a live default and 42P13.
const LIVE_MESA_REFUND_DEFAULTS = "p_amount numeric DEFAULT NULL::numeric, p_meta jsonb DEFAULT '{}'::jsonb";
assert('forward Migration 122 preserves the live defaults (structurally cannot 42P13 on apply)',
  MIG.includes(LIVE_MESA_REFUND_DEFAULTS));
assert('rollback Migration 122 preserves the SAME live defaults (structurally cannot 42P13 if ever run after a successful forward apply)',
  RB.includes(LIVE_MESA_REFUND_DEFAULTS));
assert('both declarations are otherwise identical to each other in their parameter list (same fix, same file convention, applied symmetrically)',
  MIG.slice(MIG.indexOf('FUNCTION public.mesa_post_refund_v1('), MIG.indexOf('\n RETURNS jsonb', MIG.indexOf('FUNCTION public.mesa_post_refund_v1(')))
    ===
  RB.slice(RB.indexOf('FUNCTION public.mesa_post_refund_v1('), RB.indexOf('\n RETURNS jsonb', RB.indexOf('FUNCTION public.mesa_post_refund_v1(')))
);

section('MESA UNTOUCHED — no redefinition of the writers this slice must not touch');
assert('mesa_post_payment_v1 is not redefined in this migration file',
  !/CREATE (OR REPLACE )?FUNCTION public\.mesa_post_payment_v1/.test(MIG));
assert('mesa_close_session_v1 is not redefined in this migration file',
  !/CREATE (OR REPLACE )?FUNCTION public\.mesa_close_session_v1/.test(MIG));
assert('mesa_post_commercial_adjustment_v1 is not redefined in this migration file',
  !/CREATE (OR REPLACE )?FUNCTION public\.mesa_post_commercial_adjustment_v1/.test(MIG));
assert('order_obligation_apply_adjustment_v1 is not redefined in this migration file (reused, not modified)',
  !/CREATE (OR REPLACE )?FUNCTION public\.order_obligation_apply_adjustment_v1/.test(MIG));
assert('post-condition re-verifies md5(prosrc) for every one of those, plus the rider writer and order_mark_paid',
  ['mesa_post_payment_v1','mesa_close_session_v1','mesa_post_commercial_adjustment_v1',
   'order_obligation_apply_adjustment_v1','order_canonical_obligation_v1','order_has_economic_evidence_v1',
   'paid_order_economic_mutation_guard_v1','service_session_assign_financial_event',
   '_ledger_write_payment','order_mark_paid']
    .every((fname) => new RegExp("proname='" + fname + "'").test(MIG)));
assert('rider writer (_ledger_write_payment) is asserted untouched, explicitly annotated as the rider guarantee',
  MIG.includes('rider must stay untouched'));

section('order_initial_payment_v1 — repointed to the canonical writer, same idempotency key');
const initFn = fnBody(MIG, 'order_initial_payment_v1') || (() => {
  const i = MIG.indexOf('CREATE OR REPLACE FUNCTION public.order_initial_payment_v1()');
  const j = MIG.indexOf('AS $function$', i);
  const k = MIG.indexOf('$function$;', j + 13);
  return MIG.slice(j + 13, k);
})();
assert('function body extracted (non-empty)', initFn.length > 300);
assert('calls order_post_payment_v1, never actually invokes order_mark_paid',
  initFn.includes('PERFORM public.order_post_payment_v1(') && !/PERFORM public\.order_mark_paid\(/.test(initFn));
assert('reuses the SAME deterministic pay-order-<id> key', initFn.includes("'pay-order-' || regexp_replace(NEW.id"));
assert('requires sid_hash from the intent (new requirement, since the writer needs it)', initFn.includes("v_intent->>'sid_hash'"));
assert('keeps the pre-existing table-order guard', initFn.includes('INITIAL_PAYMENT_NOT_FOR_TABLE_ORDER'));
assert('keeps the pre-existing legacy-flag guard', initFn.includes('INITIAL_PAYMENT_LEGACY_FLAG_PRESENT'));
assert('always pays mode=full (a creation-time "ya pagado" settles the FULL obligation, like the legacy path did)',
  /order_post_payment_v1\(\s*v_workspace_id, v_actor, v_sid_hash, NEW\.order_uid, v_method, 'full'/.test(initFn));
assert('resolves workspace via order_entities, never trusts a client-supplied workspace',
  initFn.includes('FROM public.order_entities oe WHERE oe.order_uid = NEW.order_uid'));
assert('post-condition proves the repoint landed and the guards survived',
  MIG.includes("position('PERFORM public.order_post_payment_v1(' IN v_def) = 0") &&
  MIG.includes("position('PERFORM public.order_mark_paid(' IN v_def) > 0"));

section('COMMENT-SAFE POSTCONDITION FAST-FOLLOW — real STAGING apply proved the bare-substring check false-positives');
// A byte-exact apply of the pre-fast-follow file against live STAGING reached this exact
// post-condition and failed: `position('order_mark_paid' IN v_def) > 0` matched the PROSE
// comment on the line right above the real call ("...exactly like _ledger_write_payment/
// order_mark_paid did."), not an executable call -- pg_get_functiondef() returns prosrc
// verbatim, comments included. The transaction rolled back cleanly (verified independently:
// ledger tip 121, pre-122 columns still NOT NULL, none of the three new writers persisted).
//
// This section reproduces the OLD and NEW check logic OFFLINE against the real extracted
// function body (proving the false positive existed and is now gone) and against a synthetic
// fixture with a genuine reintroduced legacy call (proving a real regression is still caught).
// Scoped to the DO $post$ block specifically -- the untouched DO $guard$ precondition
// (lines ~195-207) legitimately keeps the same bare `position('order_mark_paid' IN v_def)`
// form: it is not exposed to the false-positive today (the live pre-122 body's ONLY
// real call at that point genuinely IS order_mark_paid, and order_post_payment_v1 cannot
// yet be mentioned anywhere since it does not exist pre-migration) and this fast-follow's
// scope is the failing post-condition, not a sweep of every occurrence in the file.
const postBlock = MIG.slice(MIG.indexOf('DO $post$'), MIG.indexOf('END $post$;') + 'END $post$;'.length);
assert('the OLD bare-substring pattern is gone from the $post$ block specifically (guard block is untouched by design, see comment)',
  !postBlock.includes("position('order_post_payment_v1' IN v_def)") &&
  !postBlock.includes("position('order_mark_paid' IN v_def)"));
assert('the real function body DOES contain the bare token "order_mark_paid" (proves the false-positive scenario is real, not hypothetical -- it is the comment on the line above the call)',
  initFn.includes('order_mark_paid') &&
  !/PERFORM public\.order_mark_paid\(/.test(initFn));

// Local reproduction of Postgres's position(needle IN haystack) semantics: 1-based index,
// 0 when absent. Applied to the REAL extracted body (what pg_get_functiondef would return
// for the body portion) to prove the exact before/after behavior without touching STAGING.
const position = (needle, haystack) => haystack.indexOf(needle) + 1; // 0 if absent, matches SQL position()

// CASE A -- comment-only mention (the real, current function body).
assert('[CASE A / BEFORE FIX] the OLD pattern WOULD have false-positived on the real body (reproduces the exact live failure)',
  position('order_mark_paid', initFn) > 0);
assert('[CASE A / AFTER FIX] the NEW pattern does NOT false-positive on the real body (comment-only mention is correctly ignored)',
  position('PERFORM public.order_mark_paid(', initFn) === 0);
assert('[CASE A] the NEW pattern correctly finds the real canonical call in the real body',
  position('PERFORM public.order_post_payment_v1(', initFn) > 0);

// CASE B -- a genuine legacy call reintroduced (synthetic fixture: swap the one real PERFORM
// line for the pre-122 legacy call shape, keep the explanatory comment as-is -- proving the
// fix is not merely "never matches order_mark_paid at all", but actually discriminates).
const legacyReintroducedFn = initFn.replace(
  'PERFORM public.order_post_payment_v1(',
  'PERFORM public.order_mark_paid(');
assert('[CASE B setup] the synthetic fixture genuinely differs from the real body (sanity check on the fixture itself)',
  legacyReintroducedFn !== initFn && legacyReintroducedFn.includes('PERFORM public.order_mark_paid('));
assert('[CASE B] a REAL legacy call is still correctly rejected by the NEW pattern (not merely blind to the name)',
  position('PERFORM public.order_mark_paid(', legacyReintroducedFn) > 0);
assert('forward Migration 122 is pinned to this fast-follow\'s own committed bytes (9cbc9e1b2b59db51...)',
  crypto.createHash('sha256').update(MIG).digest('hex') ===
    '9cbc9e1b2b59db510b55a997a8e0e0673c55bc78bea378bb166419c43d4f579e');

section('POST-CONDITION — no backfill, append-only intact');
assert('post-condition compares payment_transactions row count against the guard snapshot',
  MIG.includes("current_setting('ladieci.m122_pt_count', true)"));
assert('post-condition compares payment_allocations row count against the guard snapshot',
  MIG.includes("current_setting('ladieci.m122_pa_count', true)"));
assert('post-condition asserts zero payment_transactions rows with table_session_id NULL (no backfill)',
  MIG.includes('payment_transactions WHERE table_session_id IS NULL) <> 0'));
assert('post-condition asserts zero payment_allocations rows backfilled as check-centric',
  MIG.includes('table_order_line_id IS NULL OR order_uid IS NOT NULL) <> 0'));
assert('post-condition re-asserts both append-only triggers are still live',
  MIG.includes('payment_transactions_append_only_v1') && MIG.includes('payment_allocations_append_only_v1'));
assert('post-condition asserts service_role never gains UPDATE/DELETE on the ledger tables',
  MIG.includes("has_table_privilege('service_role','public.payment_transactions','UPDATE')"));

section('ROLLBACK — hard-refuses once a check-centric fact exists, honest about what comes back');
assert('rollback refuses if any payment_transactions row has table_session_id IS NULL',
  RB.includes('M122 ROLLBACK refused') && RB.includes('payment_transactions WHERE table_session_id IS NULL'));
assert('rollback refuses if any payment_allocations row is check-centric',
  RB.includes('table_order_line_id IS NULL OR order_uid IS NOT NULL'));
assert('rollback never disables the append-only trigger to force itself through',
  !/DROP TRIGGER.*append_only/i.test(RB) && !/ALTER TABLE public\.payment_(transactions|allocations) DISABLE TRIGGER/i.test(RB));
assert('rollback never DELETEs from payment_transactions or payment_allocations',
  !/DELETE FROM public\.payment_transactions/i.test(RB) && !/DELETE FROM public\.payment_allocations/i.test(RB));
assert('rollback restores order_initial_payment_v1 to call order_mark_paid again',
  /order_initial_payment_v1[\s\S]*order_mark_paid/.test(RB));
assert('rollback restores mesa_post_refund_v1 to the pre-fix `<>` comparison',
  RB.includes('v_original.table_session_id <> p_table_session_id') &&
  !RB.includes('v_original.table_session_id IS DISTINCT FROM p_table_session_id'));
assert('rollback drops all three new writers',
  RB.includes('DROP FUNCTION IF EXISTS public.order_post_payment_v1') &&
  RB.includes('DROP FUNCTION IF EXISTS public.order_post_refund_v1') &&
  RB.includes('DROP FUNCTION IF EXISTS public.order_apply_commercial_adjustment_v1'));
assert('rollback restores both NOT NULL constraints',
  /ALTER TABLE public\.payment_allocations ALTER COLUMN table_order_line_id SET NOT NULL/.test(RB) &&
  /ALTER TABLE public\.payment_transactions ALTER COLUMN table_session_id SET NOT NULL/.test(RB));
assert('rollback documents the hard-stop rationale explicitly (append-only, no fabrication)',
  RB.includes('HARD-STOP') && RB.includes('append-only'));

console.log('\n═══ RESULT: ' + pass + ' passed, ' + fail + ' failed ═══');
process.exit(fail === 0 ? 0 : 1);
