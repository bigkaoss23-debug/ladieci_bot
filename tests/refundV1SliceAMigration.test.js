// tests/refundV1SliceAMigration.test.js — REFUND V1 SLICE A static migration
// assertions (no SQL run -- same convention as ecf2/n6: the behavioural proof (A-X
// matrix: full/partial/multi refunds, over-refund refusal, refund-of-refund
// refusal, allocation invariants, idempotency, concurrency, authorization, legacy
// containment, append-only, projections) runs separately as rollback-forced probes
// against real staging, recorded in this slice's report.
// Run: node tests/refundV1SliceAMigration.test.js
const fs = require('fs');
const path = require('path');
let pass = 0, fail = 0;
const check = (l, c) => { if (c) { pass++; console.log('  ✓ ' + l); } else { fail++; console.log('  ✗ ' + l); } };

const dir = path.join(__dirname, '..', 'migrations');
const BASE = '2026-08-26_refund_v1_slice_a_mesa_post_refund';
const stripComments = (s) => s.replace(/--.*$/gm, '');
const fwdRaw = fs.readFileSync(path.join(dir, BASE + '.sql'), 'utf8');
const rbRaw = fs.readFileSync(path.join(dir, BASE + '.ROLLBACK.sql'), 'utf8');
const fwd = stripComments(fwdRaw);
const rb = stripComments(rbRaw);

const fnBody = (text, name) => {
  const start = text.indexOf('FUNCTION public.' + name + '(');
  if (start < 0) return '';
  const end = text.indexOf('$function$;', start);
  return end < 0 ? '' : text.slice(start, end + '$function$;'.length);
};
const refundFn = fnBody(fwd, 'mesa_post_refund_v1');
const orderRefundFn = fnBody(fwd, 'order_refund');
const rbOrderRefundFn = fnBody(rb, 'order_refund');

console.log('── structure ──');
check('forward wrapped in one transaction', /BEGIN;/.test(fwd) && /COMMIT;\s*$/.test(fwd.trim()));
check('rollback wrapped in one transaction', /BEGIN;/.test(rb) && /COMMIT;\s*$/.test(rb.trim()));
check('no new table', !/CREATE TABLE/i.test(fwd));
check('no new column (ALTER TABLE ... ADD COLUMN)', !/ADD COLUMN/i.test(fwd));
check('the ONLY CHECK constraint touched is auth_audit_event_chk (found live during this slice\'s own behavioural probe: the audit INSERT would have aborted every real refund)',
  (fwd.match(/DROP CONSTRAINT/gi) || []).length === 1 && (fwd.match(/ADD CONSTRAINT.*CHECK/gi) || []).length === 1 &&
  /DROP CONSTRAINT auth_audit_event_chk/.test(fwd) && /ADD CONSTRAINT auth_audit_event_chk CHECK/.test(fwd));
check('no money-table CHECK is touched (payment_transactions/payment_allocations/order_financial_events/order_obligations/table_order_lines)',
  !/ALTER TABLE public\.(payment_transactions|payment_allocations|order_financial_events|order_obligations|table_order_lines)/.test(fwd));
check('the widened CHECK is additive-only: every one of the 24 pre-existing literals survives, plus exactly one new one',
  ['login_ok','login_fail','locked','pin_set','pin_change','revoke','bootstrap','recovery','actor_disabled',
   'actor_enabled','actor_unlocked','user_created','user_renamed','role_changed','user_deactivated','user_reactivated',
   'access_denied','credential_cleared','fingerprint_upgraded','session_invalidated','rate_limit_triggered',
   'migration_login_used','PAYMENT_REPLAY_DIFFERENT_ACTOR','PAYMENT_DUPLICATE_CONFIRMED',
  ].every((lit) => fwd.includes(`'${lit}'::text`)) && fwd.includes("'MESA_PAYMENT_REFUNDED'::text"));
check('pre-condition guard checks the EXACT pre-migration auth_audit_event_chk text before dropping it (fail-closed, same K.1a discipline)',
  /pre-condition failed: auth_audit_event_chk does not match/.test(fwd));
check('no trigger change', !/CREATE TRIGGER/i.test(fwd) && !/DROP TRIGGER/i.test(fwd));
check('no backfill / no historical row touched (no UPDATE outside the two DO $$ blocks and the two function bodies)',
  !/UPDATE public\.ordenes SET refunded/i.test(fwd.replace(refundFn, '').replace(orderRefundFn, '')));
check('no order_obligations write anywhere in this file', !/INSERT INTO public\.order_obligations|UPDATE public\.order_obligations/i.test(fwd));

console.log('\n── K.1 index predicate replacement ──');
check('drops order_financial_events_one_refund_session_uq', /DROP INDEX public\.order_financial_events_one_refund_session_uq;/.test(fwd));
check('drops order_financial_events_one_refund_legacy_uq', /DROP INDEX public\.order_financial_events_one_refund_legacy_uq;/.test(fwd));
check('recreates session index WITH payment_transaction_id IS NULL',
  /CREATE UNIQUE INDEX order_financial_events_one_refund_session_uq[\s\S]*?payment_transaction_id IS NULL/.test(fwd));
check('recreates legacy index WITH payment_transaction_id IS NULL',
  /CREATE UNIQUE INDEX order_financial_events_one_refund_legacy_uq[\s\S]*?payment_transaction_id IS NULL/.test(fwd));
check('pre-condition guard checks the EXACT pre-migration indexdef before dropping (fail-closed)',
  /pre-condition failed: order_financial_events_one_refund_session_uq does not match/.test(fwd) &&
  /pre-condition failed: order_financial_events_one_refund_legacy_uq does not match/.test(fwd));

console.log('\n── K.2 mesa_post_refund_v1 ──');
check('function is created (not CREATE OR REPLACE -- this is a brand-new writer)',
  /CREATE FUNCTION public\.mesa_post_refund_v1\(/.test(fwd) && !/CREATE OR REPLACE FUNCTION public\.mesa_post_refund_v1\(/.test(fwd));
check('SECURITY INVOKER (no SECURITY DEFINER anywhere in this file)', !/SECURITY DEFINER/i.test(fwd));
check('search_path pinned', /SET search_path TO 'public', 'extensions', 'pg_temp'/.test(refundFn));
check('p_reason has NO default (mandatory) and precedes the defaulted params',
  /p_reason text,\s*\n\s*p_client_request_id text,\s*\n\s*p_request_hash text,\s*\n\s*p_amount numeric DEFAULT NULL/.test(fwd));
check('p_amount defaults to NULL (full refundable remainder)', /p_amount numeric DEFAULT NULL::numeric/.test(fwd));
check('p_meta defaults to {}', /p_meta jsonb DEFAULT '\{\}'::jsonb/.test(fwd));
check('NO p_payment_method parameter (method forced from the original transaction)', !/p_payment_method/.test(refundFn));
check('NO p_line_ids parameter (allocation is derived, never operator-chosen)', !/p_line_ids/.test(refundFn));
check('NO p_covers_settled parameter (always 0 in V1)', !/p_covers_settled\b/.test(refundFn));
check('NO p_confirm_duplicate parameter (no DUP-01-style heuristic for refunds)', !/p_confirm_duplicate/.test(refundFn));
check('covers_settled is hardcoded 0 in the INSERT', /'refund', 'refund',\s*\n\s*v_amount_cents \/ 100\.0, v_original\.payment_method, 0, v_original\.id/.test(refundFn));

console.log('\n── error vocabulary ──');
for (const code of [
  'MESA_REFUND_INVALID', 'MESA_REFUND_META_INVALID', 'MESA_REFUND_AMOUNT_INVALID',
  'MESA_REFUND_REASON_REQUIRED', 'MESA_REFUND_FORBIDDEN', 'MESA_TRANSACTION_NOT_FOUND',
  'MESA_SESSION_NOT_FOUND', 'MESA_REFUND_TRANSACTION_MISMATCH', 'MESA_REFUND_NOT_REFUNDABLE',
  'MESA_REFUND_EXCEEDS_REMAINING', 'MESA_REFUND_ALREADY_FULL', 'MESA_REFUND_IDEMPOTENCY_CONFLICT',
  'MESA_REFUND_ALLOCATION_MISMATCH', 'MESA_WORKSPACE_NOT_FOUND',
]) check(`raises ${code}`, refundFn.includes(code));
check('canonical vocabulary only -- no "reversal" domain code introduced', !/MESA_REVERSAL/.test(fwd) && !/mesa_post_reversal_v1/.test(fwd));

console.log('\n── D.3 the obligation rule: money returns, the sale does not change ──');
check('never touches order_obligations', !/order_obligations/.test(refundFn));
check('never sets ordenes.refunded', !/refunded\s*=\s*true/.test(refundFn) && !refundFn.includes('refunded = calc'));
check('never writes table_sessions (status/settled_at/closed_at)', !/UPDATE public\.table_sessions/.test(refundFn));
check('reuses the SAME ordenes projection columns as mesa_post_payment_v1 (cobrado/ya_pagado/metodo_pago only)',
  /cobrado = calc\.is_paid/.test(refundFn) && /ya_pagado = calc\.is_paid/.test(refundFn) && /metodo_pago = CASE/.test(refundFn));

console.log('\n── sign convention (frozen, no design freedom) ──');
check('amount stored positive: INSERT uses v_amount_cents / 100.0 directly, no unary minus', /v_amount_cents \/ 100\.0, v_original\.payment_method/.test(refundFn));
check('payment_allocations.amount stored positive (v_take_cents / 100.0, no negation)',
  /VALUES \(v_refund_tx\.id, v_alloc\.table_order_line_id, v_alloc\.order_id, v_take_cents \/ 100\.0, v_now\);/.test(refundFn));
check('order_financial_events.amount stored positive (v_order_allocation_cents \/ 100.0, no negation)',
  /SELECT o\.id, 'refund', v_order_allocation_cents \/ 100\.0, v_original\.payment_method,/.test(refundFn));

console.log('\n── allocation model (§14 of the brief / §F of the contract) ──');
check('reverses ONLY the original transaction\'s own allocations (a.payment_transaction_id = v_original.id)',
  /WHERE a\.payment_transaction_id = v_original\.id/.test(refundFn));
check('deterministic ordering is BYTE-IDENTICAL to mesa_post_payment_v1\'s own line order',
  /ORDER BY l\.created_at, l\.order_id, l\.source_line_index, l\.unit_index, l\.id/.test(refundFn));
check('per (original transaction, line) cap: reversible_cents subtracts prior reversals against the SAME original+line',
  /rt\.reverses_transaction_id = v_original\.id\s*\n\s*AND ra\.table_order_line_id = a\.table_order_line_id/.test(refundFn));
check('allocation invariant enforced: residue aborts with MESA_REFUND_ALLOCATION_MISMATCH',
  /IF v_to_reverse_cents <> 0 THEN RAISE EXCEPTION 'MESA_REFUND_ALLOCATION_MISMATCH'/.test(refundFn));
check('an order_financial_events row is written only for orders that received an allocation (loop scoped to payment_allocations WHERE payment_transaction_id = v_refund_tx.id)',
  /FROM public\.payment_allocations a\s*\n\s*JOIN public\.ordenes o ON o\.id = a\.order_id\s*\n\s*WHERE a\.payment_transaction_id = v_refund_tx\.id/.test(refundFn));

console.log('\n── idempotency / concurrency ──');
check('idempotency keyed on (workspace_id, client_request_id), same table as payments', /WHERE workspace_id = p_workspace_id AND client_request_id = p_client_request_id/.test(refundFn));
check('reason IS part of the request_hash intent (validated shape, hashed by the caller -- DB trusts p_request_hash)', /p_request_hash IS NULL OR p_request_hash !~/.test(refundFn));
check('locks the workspace row first', /FROM public\.workspaces WHERE id = p_workspace_id FOR UPDATE/.test(refundFn));
check('locks the actor row (role gate under lock)', /FROM public\.auth_actors\s*\n\s*WHERE workspace_id = p_workspace_id AND actor = p_by_actor FOR UPDATE/.test(refundFn));
check('locks the table session row', /FROM public\.table_sessions\s*\n\s*WHERE id = p_table_session_id AND workspace_id = p_workspace_id FOR UPDATE/.test(refundFn));
check('locks the ORIGINAL transaction row -- this is what serialises concurrent over-refund attempts',
  /FROM public\.payment_transactions\s*\n\s*WHERE id = p_original_transaction_id AND workspace_id = p_workspace_id FOR UPDATE/.test(refundFn));
check('lock order matches the contract: workspace -> actor -> idempotency -> session -> original transaction',
  (() => {
    const idx = (needle) => refundFn.indexOf(needle);
    const iWorkspace = idx('FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE');
    const iActor = idx('WHERE workspace_id = p_workspace_id AND actor = p_by_actor FOR UPDATE');
    const iIdem = idx('WHERE workspace_id = p_workspace_id AND client_request_id = p_client_request_id');
    const iSession = idx('WHERE id = p_table_session_id AND workspace_id = p_workspace_id FOR UPDATE');
    const iOriginal = idx('WHERE id = p_original_transaction_id AND workspace_id = p_workspace_id FOR UPDATE');
    return iWorkspace >= 0 && iWorkspace < iActor && iActor < iIdem && iIdem < iSession && iSession < iOriginal;
  })());

console.log('\n── refundable-remaining arithmetic ──');
check('remaining = original.amount - SUM(refunds reversing it)',
  /round\(v_original\.amount\*100\)::bigint - COALESCE\(\(\s*\n\s*SELECT sum\(round\(r\.amount\*100\)\)::bigint FROM public\.payment_transactions r\s*\n\s*WHERE r\.kind='refund' AND r\.reverses_transaction_id = v_original\.id/.test(refundFn));
check('kind must be payment -- refusing to refund a refund (MESA_REFUND_NOT_REFUNDABLE)',
  /IF v_original\.kind <> 'payment' THEN RAISE EXCEPTION 'MESA_REFUND_NOT_REFUNDABLE'/.test(refundFn));
check('table session mismatch refused (MESA_REFUND_TRANSACTION_MISMATCH)',
  /IF v_original\.table_session_id <> p_table_session_id THEN/.test(refundFn));
check('zero remaining refused (MESA_REFUND_ALREADY_FULL)', /IF v_remaining_cents <= 0 THEN RAISE EXCEPTION 'MESA_REFUND_ALREADY_FULL'/.test(refundFn));
check('over-request refused (MESA_REFUND_EXCEEDS_REMAINING)', /IF v_amount_cents > v_remaining_cents THEN RAISE EXCEPTION 'MESA_REFUND_EXCEEDS_REMAINING'/.test(refundFn));

console.log('\n── J.2 closed tables are accepted, never reopened ──');
check('table session lookup has NO status filter (accepts open OR closed)',
  (() => {
    const start = refundFn.indexOf('FROM public.table_sessions');
    const clause = refundFn.slice(start, start + 200);
    return !/status\s*=\s*'open'/.test(clause);
  })());

console.log('\n── K.2 ACL ──');
check('mesa_post_refund_v1 revoked from PUBLIC/anon/authenticated',
  /REVOKE ALL ON FUNCTION public\.mesa_post_refund_v1\([^)]*\) FROM PUBLIC, anon, authenticated;/.test(fwd));
check('mesa_post_refund_v1 granted to service_role only',
  /GRANT EXECUTE ON FUNCTION public\.mesa_post_refund_v1\([^)]*\) TO service_role;/.test(fwd));

console.log('\n── K.3 legacy order_refund containment ──');
check('order_refund is redefined (CREATE OR REPLACE, full body restated)', orderRefundFn.length > 0);
check('guard raises AUTH_REFUND_TRANSACTION_BACKED', /RAISE EXCEPTION 'AUTH_REFUND_TRANSACTION_BACKED'/.test(orderRefundFn));
check('guard is keyed on transaction-backed EVIDENCE (payment_transaction_id IS NOT NULL), not table_session_id',
  /AND e\.payment_transaction_id IS NOT NULL\)\s*\n\s*THEN RAISE EXCEPTION 'AUTH_REFUND_TRANSACTION_BACKED'/.test(orderRefundFn));
check('guard positioned AFTER the N-6 ownership check and BEFORE the replay lookup',
  (() => {
    const iOwnership = orderRefundFn.indexOf('ORDER_WITHOUT_SERVICE_SESSION');
    const iGuard = orderRefundFn.indexOf('AUTH_REFUND_TRANSACTION_BACKED');
    const iReplay = orderRefundFn.indexOf('AND idem_scope_key = p_idem_scope_key');
    return iOwnership >= 0 && iGuard > iOwnership && iReplay > iGuard;
  })());
check('every pre-existing refusal/behaviour survives verbatim',
  ['AUTH_META_INVALID','AUTH_META_TOO_LARGE','AUTH_META_SENSITIVE_KEY','AUTH_IP_HASH_REQUIRED',
   'AUTH_IP_HASH_TOO_LONG','AUTH_IDEM_KEY_INVALID','AUTH_SESSION_STALE','AUTH_REASON_BLANK',
   'AUTH_ACTOR_NOT_FOUND','AUTH_INITIATOR_INACTIVE','AUTH_FORBIDDEN_ROLE','AUTH_ORDER_NOT_FOUND',
   'AUTH_REFUND_BASIS_INTEGRITY','AUTH_IDEMPOTENCY_CONFLICT','AUTH_NO_PAYMENT_BASIS','AUTH_ALREADY_REFUNDED',
  ].every((code) => orderRefundFn.includes(code)));
check('admin-only role gate unchanged', /IF v_role <> 'admin' THEN RAISE EXCEPTION 'AUTH_FORBIDDEN_ROLE'/.test(orderRefundFn));
check('legacy refund still sets ordenes.refunded = true (unchanged legacy semantics)', /UPDATE public\.ordenes SET refunded = true WHERE id = p_order_id;/.test(orderRefundFn));
check('order_refund ACL restated: revoked from PUBLIC/anon/authenticated, granted to service_role',
  /REVOKE ALL ON FUNCTION public\.order_refund\([^)]*\) FROM PUBLIC, anon, authenticated;/.test(fwd) &&
  /GRANT EXECUTE ON FUNCTION public\.order_refund\([^)]*\) TO service_role;/.test(fwd));

console.log('\n── K.4 post-conditions actually assert the contract ──');
for (const needle of [
  'session refund index missing payment_transaction_id IS NULL predicate',
  'legacy refund index missing payment_transaction_id IS NULL predicate',
  'mesa_post_refund_v1 signature mismatch or missing',
  'service_role lacks EXECUTE on mesa_post_refund_v1',
  'a browser role holds EXECUTE on mesa_post_refund_v1',
  'service_role lost EXECUTE on order_refund',
  'order_refund missing the containment guard',
  'order_refund containment guard not keyed on transaction-backed evidence',
  'order_refund lost pre-existing legacy behaviour',
  'mesa_post_payment_v1 was structurally modified',
  'mesa_close_session_v1 was structurally modified',
  'an append-only trigger disappeared',
  'mesa_post_refund_v1 must never touch order_obligations',
  'mesa_post_refund_v1 must never set ordenes.refunded',
  'mesa_post_refund_v1 must never write table_sessions',
  'auth_audit_event_chk does not accept MESA_PAYMENT_REFUNDED',
  'auth_audit_event_chk lost pre-existing literal',
]) check('post-condition: ' + needle, fwd.includes(needle));

check('captures BEFORE-state md5 of mesa_post_payment_v1/mesa_close_session_v1 before any DDL runs (structural-unchanged proof, not an assumption)',
  fwd.indexOf("set_config('ladieci.refund_v1_payment_md5_before'") < fwd.indexOf('DROP INDEX public.order_financial_events_one_refund_session_uq'));

console.log('\n── rollback ──');
check('rollback drops mesa_post_refund_v1', /DROP FUNCTION IF EXISTS public\.mesa_post_refund_v1\(/.test(rb));
check('rollback restores order_refund WITHOUT the containment guard', !/AUTH_REFUND_TRANSACTION_BACKED/.test(rbOrderRefundFn));
check('rollback restores order_refund WITH every other pre-existing behaviour', /AUTH_ALREADY_REFUNDED/.test(rbOrderRefundFn) && /ORDER_WITHOUT_SERVICE_SESSION/.test(rbOrderRefundFn));
check('rollback restores both indexes WITHOUT payment_transaction_id IS NULL',
  (() => {
    const s = fnBodyLikeIndex(rb, 'order_financial_events_one_refund_session_uq');
    const l = fnBodyLikeIndex(rb, 'order_financial_events_one_refund_legacy_uq');
    return s && !/payment_transaction_id IS NULL/.test(s) && l && !/payment_transaction_id IS NULL/.test(l);
  })());
check('rollback deletes no financial facts, no TRUNCATE', !/DELETE FROM public\.(order_financial_events|order_obligations|payment_transactions|payment_allocations|table_order_lines)\b/.test(rb) && !/TRUNCATE/i.test(rb));
check('rollback restores auth_audit_event_chk WITHOUT MESA_PAYMENT_REFUNDED', /DROP CONSTRAINT auth_audit_event_chk/.test(rb) && /ADD CONSTRAINT auth_audit_event_chk CHECK/.test(rb) && !/MESA_PAYMENT_REFUNDED/.test(rb));
check('rollback header states it reinstates the defect', /WHAT COMES BACK IS THE DEFECT/.test(rbRaw));

function fnBodyLikeIndex(text, indexName) {
  const start = text.indexOf('CREATE UNIQUE INDEX ' + indexName);
  if (start < 0) return '';
  const end = text.indexOf(';', start);
  return end < 0 ? '' : text.slice(start, end);
}

console.log('\nREFUND V1 SLICE A migration: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
