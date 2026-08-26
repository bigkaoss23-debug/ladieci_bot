'use strict';
// AJUSTE COMERCIAL V1 (DB ledger 118) — commercial adjustment, atomic cancellation and
// canonical obligation reads. Run: node tests/ajusteComercialV1.test.js
//
// OFFLINE. Stubs global.fetch, exactly like tests/mesaDaoRefund.test.js. No DB, no network.
//
// The DB-side BEHAVIOUR (bootstrap chains, idempotent replay, hash conflict, reduction-only,
// stale expectation, blank reason, revision-1-adjustment refused by create_rev_chk, and the
// CHIUSO_FORZATO reader) is proven separately by rollback-forced probes against real staging  // language-guard: allow-legacy CHIUSO_FORZATO is the existing terminal-state literal this slice deliberately keeps OUT of every economic filter, named here as evidence, not new vocabulary
// specimens, recorded in this slice's report. What this file proves is everything that lives
// in the repository: the migration's own text, the rollback's honesty, the role split, the
// wiring, and the cancellation routing.

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
const MIG = fs.readFileSync(path.join(MIG_DIR, '2026-08-26_ajuste_comercial_v1_migration_118.sql'), 'utf8');

// Extract a function's REAL body (between its own AS $fn$ ... $fn$; delimiters). Slicing on
// prose landmarks instead would let a neighbouring comment block satisfy -- or defeat -- an
// assertion about the SQL, which is exactly how a "CHIUSO_FORZATO is gone" check can pass or  // language-guard: allow-legacy CHIUSO_FORZATO is the existing terminal-state literal this slice deliberately keeps OUT of every economic filter, named here as evidence, not new vocabulary
// fail for the wrong reason.
function fnBody(src, name) {
  const i = src.indexOf('CREATE OR REPLACE FUNCTION public.' + name);
  if (i < 0) return '';
  const j = src.indexOf('AS $fn$', i);
  const k = src.indexOf('$fn$;', j + 7);
  return src.slice(j + 7, k);
}
const RB = fs.readFileSync(path.join(MIG_DIR, '2026-08-26_ajuste_comercial_v1_migration_118.ROLLBACK.sql'), 'utf8');

// ═══════════════════════════════════════════════════════════════════
section('THE INVARIANT THE WHOLE BOOTSTRAP RESTS ON');
// order_obligations_create_rev_chk is a biconditional. It must survive untouched, or
// "revision 1 is always the creation baseline" stops being true and Fiscal Core loses the
// only anchor that identifies the original obligation.
assert('migration never drops create_rev_chk',
  !/DROP\s+CONSTRAINT\s+(IF\s+EXISTS\s+)?order_obligations_create_rev_chk/i.test(MIG));
assert('migration never re-adds create_rev_chk',
  !/ADD\s+CONSTRAINT\s+order_obligations_create_rev_chk/i.test(MIG));
assert('a post-condition asserts create_rev_chk is byte-identical',
  MIG.includes("create_rev_chk was modified"));
assert('the guard refuses to run if create_rev_chk is missing/unrecognised',
  MIG.includes('order_obligations_create_rev_chk missing or unrecognised'));
assert('rollback never touches create_rev_chk either',
  !/create_rev_chk/i.test(RB) || !/DROP\s+CONSTRAINT\s+order_obligations_create_rev_chk/i.test(RB));

section('BOOTSTRAP — revision 1 is a creation baseline, never an adjustment');
assert('bootstrap writes source order_create_v1 at revision 1',
  /VALUES\s*\(\s*p_order_uid,\s*v_ord\.id,\s*v_session,\s*v_workspace,\s*1,[\s\S]{0,200}?'order_create_v1'/.test(MIG));
assert('bootstrap gross comes from the LOCKED ordenes.totale, not a line sum',
  /v_current\s*:=\s*COALESCE\(v_ord\.totale, 0\);/.test(MIG));
assert('bootstrap never sums table_order_lines',
  !/v_current[\s\S]{0,80}table_order_lines/.test(MIG));
assert('bootstrap marks provenance (materialized_lazily) rather than hiding it',
  MIG.includes('materialized_lazily)') && MIG.includes("'order_create_v1', v_period,"));
assert('only a creation baseline may be lazily materialized',
  MIG.includes("materialized_lazily = false OR source = 'order_create_v1'"));
assert('created_at reuses the ORDER\'s own creation instant (what the anchor would have written)',
  MIG.includes('COALESCE(v_ord.created_at, now()), true)'));
assert('the adjustment revision is rev 2 when bootstrapped, else prev+1',
  MIG.includes('v_new_rev := CASE WHEN v_bootstrap THEN 2 ELSE v_revision + 1 END;'));
assert('the order row is locked FOR UPDATE before the baseline is read (races serialise)',
  MIG.includes('FROM public.ordenes WHERE order_uid = p_order_uid FOR UPDATE'));

section('CANONICAL OBLIGATION READER');
assert('legacy fallback is ordenes.totale — the SAME source the bootstrap uses',
  /order_canonical_obligation_v1[\s\S]{0,900}COALESCE\(o\.totale, 0\)/.test(MIG));
assert('reader prefers the latest revision',
  /order_canonical_obligation_v1[\s\S]{0,600}ORDER BY ob\.revision DESC LIMIT 1/.test(MIG));
assert('CHIUSO_FORZATO is NOT an economic void in the fallback',  // language-guard: allow-legacy CHIUSO_FORZATO is the existing terminal-state literal this slice deliberately keeps OUT of every economic filter, named here as evidence, not new vocabulary
  fnBody(MIG, 'order_canonical_obligation_v1').includes("'ANULADO','CANCELADO','CANCELLED'")
  && !fnBody(MIG, 'order_canonical_obligation_v1').includes('CHIUSO_FORZATO'));  // language-guard: allow-legacy CHIUSO_FORZATO is the existing terminal-state literal this slice deliberately keeps OUT of every economic filter, named here as evidence, not new vocabulary

section('mesa_post_payment_v1 — estado is no longer economic authority');
assert('payment writer reads the canonical obligation',
  /CREATE OR REPLACE FUNCTION public\.mesa_post_payment_v1[\s\S]*?order_canonical_obligation_v1/.test(MIG));
const paymentFn = fnBody(MIG, 'mesa_post_payment_v1');
assert('payment writer no longer filters on CHIUSO_FORZATO anywhere',  // language-guard: allow-legacy CHIUSO_FORZATO is the existing terminal-state literal this slice deliberately keeps OUT of every economic filter, named here as evidence, not new vocabulary
  !paymentFn.includes('CHIUSO_FORZATO'));  // language-guard: allow-legacy CHIUSO_FORZATO is the existing terminal-state literal this slice deliberately keeps OUT of every economic filter, named here as evidence, not new vocabulary
assert('a post-condition enforces that absence',
  MIG.includes('still filters on CHIUSO_FORZATO'));  // language-guard: allow-legacy CHIUSO_FORZATO is the existing terminal-state literal this slice deliberately keeps OUT of every economic filter, named here as evidence, not new vocabulary
assert('each order is capped by its OWN remaining obligation',
  paymentFn.includes('v_order_cap_cents') && paymentFn.includes('LEAST(v_to_allocate_cents, v_line_remaining_cents, v_order_cap_cents)'));
assert('payment writer publishes overCollected',
  paymentFn.includes("'overCollected'"));
assert('search_path keeps `extensions` (digest() lives there)',
  /FUNCTION public\.mesa_post_payment_v1[\s\S]{0,900}SET search_path = public, extensions, pg_temp/.test(MIG));

section('mesa_close_session_v1 — both sides of the divergence');
const closeFn = fnBody(MIG, 'mesa_close_session_v1');
assert('close derives unpaid AND overCollected', closeFn.includes('v_unpaid_cents') && closeFn.includes('v_over_cents'));
assert('the close gate is on unpaid ONLY (over-collection must never trap a table)',
  closeFn.includes('IF v_unpaid_cents > 0 THEN') && closeFn.includes('MESA_TABLE_NOT_SETTLED'));
assert('close publishes overCollected in its payload', closeFn.includes("'overCollected', v_over_cents / 100.0"));
assert('the OPERATIONAL completeness check keeps its CHIUSO_FORZATO literals',  // language-guard: allow-legacy CHIUSO_FORZATO is the existing terminal-state literal this slice deliberately keeps OUT of every economic filter, named here as evidence, not new vocabulary
  closeFn.includes("'RETIRADO','COMPLETADO','COMPLETATO','CANCELADO','CANCELLED','ANULADO','CHIUSO_FORZATO'"));  // language-guard: allow-legacy COMPLETATO is the existing terminal-state literal, cited verbatim, not new vocabulary
assert('force-close still writes only an audit row, never an obligation',
  closeFn.includes('must NOT be routed through the commercial')
  && !/orphaned[\s\S]{0,400}order_obligation_apply_adjustment_v1/.test(closeFn));

section('CANCELLATION — atomic, and it never chooses the amount');
const cancelFn = fnBody(MIG, 'order_cancel_v1');
assert('order_cancel_v1 exposes NO new-gross parameter',
  !/p_new_gross/.test(MIG.slice(MIG.indexOf('FUNCTION public.order_cancel_v1'),
                                MIG.indexOf('AS $fn$', MIG.indexOf('FUNCTION public.order_cancel_v1')))));
assert('the server hard-codes 0 as the resulting obligation',
  cancelFn.includes("v_ord.order_uid, 0, 'order_cancellation'"));
assert('a post-condition forbids an amount parameter ever appearing',
  MIG.includes('order_cancel_v1 exposes an amount parameter'));
assert('obligation is written BEFORE the state, in the same function body',
  cancelFn.indexOf('order_obligation_apply_adjustment_v1') < cancelFn.indexOf('UPDATE public.ordenes SET estado'));
assert('cancellation never inserts a payment_transactions row', !/INSERT INTO public\.payment_transactions/.test(cancelFn));
assert('a post-condition proves cancellation can never fabricate a refund',
  MIG.includes('order_cancel_v1 can create a refund'));
assert('Class B fails closed instead of guessing from a display id',
  cancelFn.includes('ORDER_WITHOUT_STABLE_IDENTITY'));
assert('an already-cancelled order replays instead of appending a second revision',
  cancelFn.includes("'idempotent', true"));
assert('cancellable-from set mirrors orderStateMachine CANCELLABLE_FROM',
  cancelFn.includes("'POR_CONFIRMAR','NUEVO','EN_COCINA','LISTO','EN_ENTREGA'"));
assert('lock order is actor -> table_session -> order (a subsequence of the Mesa prefix)',
  cancelFn.indexOf('FROM public.auth_actors') < cancelFn.indexOf('FROM public.table_sessions')
  && cancelFn.indexOf('FROM public.table_sessions') < cancelFn.indexOf('FROM public.ordenes WHERE id = p_order_id FOR UPDATE'));

section('order_void — ANULADO is an economic cancellation too');
const voidFn = fnBody(MIG, 'order_void');
assert('order_void now appends an obligation revision to 0',
  voidFn.includes("v_ord.order_uid, 0, 'order_cancellation'"));
assert('order_void keeps its zero-amount OFE void marker', voidFn.includes("'void', 0, NULL, v_reason"));
assert('order_void keeps its admin/operator gate', voidFn.includes("v_role NOT IN ('admin','operator')"));
assert('order_void derives its adjustment key from the PERMANENT order identity',
  voidFn.includes("'voidadj-' || replace(v_ord.order_uid::text, '-', '')"));

section('THINGS THAT MUST NOT HAVE CHANGED');
for (const [label, marker] of [
  ['Refund V1 semantics', 'Refund V1 semantics were modified'],
  ['the N-5 guard', 'the N-5 guard was weakened'],
  ['the N-2 anchor', 'the N-2 anchor was modified'],
]) assert('a post-condition proves ' + label + ' is untouched', MIG.includes(marker));
assert('migration never redefines the N-5 guard',
  !/CREATE OR REPLACE FUNCTION public\.paid_order_economic_mutation_guard_v1/.test(MIG));
assert('migration never redefines mesa_post_refund_v1',
  !/CREATE OR REPLACE FUNCTION public\.mesa_post_refund_v1/.test(MIG));

section('NO BACKFILL');
assert('post-condition pins order_obligations at exactly 6 rows',
  MIG.includes('order_obligations row count changed (expected 6'));
assert('post-condition forbids any historical row gaining a cause or a lazy baseline',
  MIG.includes('a historical obligation row was written'));
assert('post-condition forbids the migration emitting its own audit event',
  MIG.includes('the migration itself emitted an audit event'));
assert('no UPDATE/INSERT against business tables outside the function bodies',
  !/^\s*(INSERT INTO|UPDATE)\s+public\.(ordenes|order_obligations|payment_)/m.test(
    MIG.replace(/CREATE OR REPLACE FUNCTION[\s\S]*?\$fn\$;/g, '')));

section('ADDITIVE SCHEMA — old rows stay valid');
for (const col of ['cause','reason','by_actor','by_role','client_request_id','request_hash','materialized_lazily'])
  assert('column ' + col + ' is added', MIG.includes('ADD COLUMN ' + col));
assert('only materialized_lazily is NOT NULL (it has a default)',
  MIG.includes('materialized_lazily boolean NOT NULL DEFAULT false'));
assert('a post-condition proves the attribution columns are nullable',
  MIG.includes('an attribution column is NOT NULL'));
assert('adjustment rows must carry full provenance',
  MIG.includes('order_obligations_adjustment_provenance_chk'));
assert('cause is present exactly for adjustment revisions',
  MIG.includes("CHECK ((cause IS NOT NULL) = (source = 'order_commercial_adjustment_v1'))"));
assert('source widening keeps both pre-existing literals',
  /order_obligations_source_chk[\s\S]{0,300}'order_create_v1'[\s\S]{0,120}'order_total_revision_v1'[\s\S]{0,120}'order_commercial_adjustment_v1'/.test(MIG));
assert('idempotency index is PARTIAL (anchor rows carry NULL)',
  MIG.includes('WHERE client_request_id IS NOT NULL'));
assert('auth_audit widening keeps every pre-existing literal',
  ['login_ok','MESA_PAYMENT_REFUNDED','PAYMENT_DUPLICATE_CONFIRMED','migration_login_used']
    .every((l) => MIG.includes("'" + l + "'::text")));

section('PRIVILEGES — fail closed');
for (const fn of ['order_canonical_obligation_v1','order_obligation_apply_adjustment_v1',
                  'mesa_post_commercial_adjustment_v1','order_cancel_v1']) {
  assert(fn + ' revokes PUBLIC', new RegExp('REVOKE ALL ON FUNCTION public\\.' + fn).test(MIG));
  assert(fn + ' grants service_role only', new RegExp('GRANT EXECUTE ON FUNCTION public\\.' + fn + '[\\s\\S]{0,200}?TO service_role').test(MIG));
}
assert('a post-condition proves anon/authenticated cannot execute a new writer',
  MIG.includes('anon/authenticated can execute a new writer'));

section('ROLLBACK — honest about what it cannot undo');
assert('rollback drops all four new functions',
  ['mesa_post_commercial_adjustment_v1','order_cancel_v1','order_obligation_apply_adjustment_v1','order_canonical_obligation_v1']
    .every((f) => RB.includes('DROP FUNCTION IF EXISTS public.' + f) || RB.includes('DROP FUNCTION IF EXISTS public.' + f + '(uuid)')));
assert('rollback restores all three replaced bodies',
  ['order_void','mesa_post_payment_v1','mesa_close_session_v1']
    .every((f) => RB.includes('CREATE OR REPLACE FUNCTION public.' + f)));
// THE STRONGEST CHECK IN THIS FILE. The rollback restores three large function bodies by
// transcription, and a silent slip there is the failure mode ledgers 115/116 were bitten by.
// Extract what the rollback would actually install and md5 it against the CERTIFIED pre-118
// bodies captured live from pg_proc. This runs offline, so the transcription is verified on
// every test run, not once at write time.
{
  const crypto = require('crypto');
  const bodyMd5 = (src, name) => crypto.createHash('md5').update(fnBody(src, name)).digest('hex');
  // The linter requires a `language-guard: allow-legacy` comment on every ADDED line carrying
  // a legacy Italian term. The pre-118 mesa_post_payment_v1 body carried none (its creating
  // migration predates the linter), so the text this rollback installs differs from the
  // certified body by exactly those comments -- and by nothing else, which is what this
  // strips-and-compares proves.
  const stripGuard = (t) => t.split('\n')
    .map((l) => l.replace(/\s*--\s*language-guard:\s*allow-legacy.*$/, '')).join('\n');
  assert('rollback restores order_void BYTE-IDENTICALLY to the certified pre-118 body',
    bodyMd5(RB, 'order_void') === 'a19db124d4c09db12a2f09248a4b7f07', bodyMd5(RB, 'order_void'));
  assert('rollback restores mesa_close_session_v1 BYTE-IDENTICALLY to the certified pre-118 body',
    bodyMd5(RB, 'mesa_close_session_v1') === '6b21ffbcee68bd55c24f376af2e69001', bodyMd5(RB, 'mesa_close_session_v1'));
  assert('rollback restores mesa_post_payment_v1 exactly, modulo only the linter comments',
    crypto.createHash('md5').update(stripGuard(fnBody(RB, 'mesa_post_payment_v1'))).digest('hex')
      === 'ddc9d1ad3c654b4e1a639afda22132c9');
  assert('the rollback asserts the md5 it will really install',
    RB.includes(bodyMd5(RB, 'mesa_post_payment_v1')));
  assert('the restored payment writer is the PRE-118 authority (no canonical obligation read)',
    !fnBody(RB, 'mesa_post_payment_v1').includes('order_canonical_obligation_v1')
    && fnBody(RB, 'mesa_post_payment_v1').includes("'ANULADO','CANCELADO','CANCELLED','CHIUSO_FORZATO'"));  // language-guard: allow-legacy CHIUSO_FORZATO is the existing terminal-state literal the pre-118 body filtered on, asserted here verbatim, not new vocabulary
}
assert('rollback NEVER deletes an obligation revision',
  !/DELETE\s+FROM\s+public\.order_obligations/i.test(RB));
assert('rollback drops the columns only when no adjustment exists',
  RB.includes('IF v_adjustments = 0 THEN') && RB.includes('DROP COLUMN cause'));
assert('rollback says out loud when it is partial', RB.includes('AJUSTE_118 rollback: PARTIAL'));

// ═══════════════════════════════════════════════════════════════════
section('APPLICATION LAYER — the authority split');
const svc = fs.readFileSync(path.join(__dirname, '..', 'src', 'tables', 'mesaService.js'), 'utf8');
assert('ADJUSTMENT_ROLES exists and is {admin, owner}',
  /const ADJUSTMENT_ROLES = new Set\(\['admin','owner'\]\)/.test(svc));
const { createMesaService, MesaServiceError } = require('../src/tables/mesaService');
const ctx = (role) => ({ actor: role === 'admin' ? 'owner' : 'operator_primary', role, workspaceId: 'ws', sid: 's'.repeat(16) });
const calls = [];
const svcInstance = createMesaService({
  dao: { postCommercialAdjustment: async (a) => { calls.push(a); return { ok: true, currentObligation: 20 }; } },
  hashSid: () => 'a'.repeat(64),
});
const tryAdjust = async (role, over = {}) => {
  try {
    await svcInstance.commercialAdjustment({
      context: ctx(role), tableSessionId: 'ts-1', orderUid: 'uid-1',
      newGross: 20, reason: 'corrección', clientRequestId: 'req-12345678', ...over,
    });
    return 'OK';
  } catch (e) { return e instanceof MesaServiceError ? e.code : 'THREW:' + (e && e.message); }
};
(async () => {
  assert('admin MAY perform a manual adjustment', (await tryAdjust('admin')) === 'OK');
  for (const role of ['operator','cashier','waiter','rider','shift_manager','kitchen'])
    assert(role + ' may NOT perform a manual adjustment', (await tryAdjust(role)) === 'MESA_FORBIDDEN');
  assert('blank reason is refused', (await tryAdjust('admin', { reason: '   ' })) === 'MESA_ADJUSTMENT_REASON_REQUIRED');
  assert('missing orderUid fails closed (never a display id)',
    (await tryAdjust('admin', { orderUid: '' })) === 'ORDER_WITHOUT_STABLE_IDENTITY');
  assert('negative gross is refused', (await tryAdjust('admin', { newGross: -1 })) === 'MESA_ADJUSTMENT_INVALID');
  assert('the DAO receives order_uid, absolute gross and a request hash',
    calls.length > 0 && calls[0].orderUid === 'uid-1' && calls[0].newGross === 20
    && /^[0-9a-f]{64}$/.test(calls[0].requestHash));
  assert('the adjustment call carries no payment/refund field at all',
    calls.length > 0 && !('amount' in calls[0]) && !('paymentMethod' in calls[0])
    && !('originalTransactionId' in calls[0]));

  section('CANCELLATION MODULE');
  const co = require('../src/financial/cancelOrder');
  for (const s of ['CANCELADO','CANCELLED','ANULADO'])
    assert(s + ' is an economic cancellation', co.isEconomicCancellation(s) === true);
  for (const s of ['CHIUSO_FORZATO','RETIRADO','COMPLETADO','EN_COCINA',null,''])  // language-guard: allow-legacy CHIUSO_FORZATO is the existing terminal-state literal this slice deliberately keeps OUT of every economic filter, named here as evidence, not new vocabulary
    assert(String(s) + ' is NOT an economic cancellation', co.isEconomicCancellation(s) === false);
  assert('request id is deterministic per order and PostgREST-safe',
    co.buildCancelRequestId('#999034') === 'cancel-order-999034'
    && /^[A-Za-z0-9_-]{8,128}$/.test(co.buildCancelRequestId('#999034')));
  assert('an unattributable actor fails closed',
    (await co.cancelOrderCanonical({ orderId: '#1', targetEstado: 'CANCELADO', extras: {} })).code
      === 'ORDER_CANCEL_ACTOR_REQUIRED');
  assert('a blank order id fails closed',
    (await co.cancelOrderCanonical({ orderId: '', targetEstado: 'CANCELADO', extras: { actor_id: 'owner' } })).code
      === 'ORDER_CANCEL_INVALID');
  const cancelSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'financial', 'cancelOrder.js'), 'utf8');
  assert('the module exposes no amount/gross parameter anywhere',
    !/gross/i.test(cancelSrc.replace(/\/\/.*$/gm, '')));

  section('cambiaStato ROUTING');
  const ord = fs.readFileSync(path.join(__dirname, '..', 'src', 'agents', 'agentOrdini.js'), 'utf8');  // language-guard: allow-legacy agentOrdini is the existing module filename being cross-referenced, not new vocabulary
  assert('economic cancellation routes through the canonical writer',
    ord.includes('if (!_isNoop && isEconomicCancellation(nuovoStato)) {'));
  assert('a self-loop cancel stays a pure no-op (no financial writer, no actor demanded)',
    ord.includes('!_isNoop && isEconomicCancellation'));
  assert('the non-cancel path still uses the ordinary sbUpdate + N-5 refusal check',
    ord.includes('const stateRes = await sbUpdate("ordenes"') && ord.includes('isEconomicMutationRefusal(stateRes)'));
  assert('a refused cancellation reports failure instead of inventing a transition',
    ord.includes('if (!cancelled.ok) {'));
  assert('collecting/discounting cannot ride along with a cancellation',
    ord.includes('cancellation_with_economic_extras'));

  section('WIRING');
  const pol = fs.readFileSync(path.join(__dirname, '..', 'src', 'utils', 'supabaseResourcePolicy.js'), 'utf8');
  assert('rpc/mesa_post_commercial_adjustment_v1 is registered', pol.includes("entry('rpc/mesa_post_commercial_adjustment_v1'"));
  assert('rpc/order_cancel_v1 is registered', pol.includes("entry('rpc/order_cancel_v1'"));
  assert('both are FINANCIAL sensitivity',
    /rpc\/mesa_post_commercial_adjustment_v1'[\s\S]{0,120}SENSITIVITY\.FINANCIAL/.test(pol)
    && /rpc\/order_cancel_v1'[\s\S]{0,120}SENSITIVITY\.FINANCIAL/.test(pol));
  const dao = fs.readFileSync(path.join(__dirname, '..', 'src', 'tables', 'mesaDao.js'), 'utf8');
  for (const p of ['p_workspace_id','p_by_actor','p_by_sid_hash','p_table_session_id','p_order_uid',
                   'p_new_gross','p_reason','p_client_request_id','p_request_hash','p_expected_current_gross','p_meta'])
    assert('DAO maps ' + p, new RegExp('postCommercialAdjustment[\\s\\S]{0,900}' + p + ':').test(dao));
  const h = fs.readFileSync(path.join(__dirname, '..', 'src', 'tables', 'mesaHttpHandlers.js'), 'utf8');
  assert('ORDER_* domain codes are no longer collapsed into MESA_INTERNAL_ERROR',
    h.includes('/^(MESA|ORDER)_[A-Z0-9_]+$/'));
  for (const [code, status] of [['MESA_ADJUSTMENT_STALE_OBLIGATION', 409], ['MESA_ADJUSTMENT_NO_CHANGE', 409],
    ['MESA_ADJUSTMENT_IDEMPOTENCY_CONFLICT', 409], ['MESA_ADJUSTMENT_FORBIDDEN', 403],
    ['ORDER_CANCEL_FORBIDDEN', 403], ['MESA_ADJUSTMENT_ORDER_NOT_FOUND', 404], ['ORDER_CANCEL_NOT_FOUND', 404]])
    assert(code + ' is classified (' + status + ')', h.includes("'" + code + "'"));
  assert('the adjustments route is registered', h.includes("router.post('/sessions/:sessionId/adjustments'"));

  console.log('\n═══ RESULT: ' + pass + ' passed, ' + fail + ' failed ═══');
  process.exit(fail === 0 ? 0 : 1);
})();
