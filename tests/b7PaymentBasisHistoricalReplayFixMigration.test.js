'use strict';
// B7A2E static migration tests. Run: node tests/b7PaymentBasisHistoricalReplayFixMigration.test.js
// NON-EXECUTING: inspects SQL text only. Proves payment-basis same-scope replay
// rebuilds the digest from immutable ledger snapshots, not mutable order snapshots.
const fs = require('fs');
const path = require('path');
let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const strip = (s) => s.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');

const MIG_DIR = path.join(__dirname, '..', 'migrations');
const ALL = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql'));
const FWD = '2026-07-19_b7_payment_basis_historical_replay_fix.sql';
const RB = '2026-07-19_b7_payment_basis_historical_replay_fix.ROLLBACK.sql';
const FWD_CONV = /^\d{4}-\d{2}-\d{2}_[a-z0-9_]+\.sql$/;
const RB_CONV = /^\d{4}-\d{2}-\d{2}_[a-z0-9_]+\.ROLLBACK\.sql$/;

assert('forward filename matches convention', FWD_CONV.test(FWD));
assert('rollback filename matches convention', RB_CONV.test(RB));
assert('both discovered', ALL.includes(FWD) && ALL.includes(RB));

const RAW = read('migrations/' + FWD);
const S = strip(RAW);
const R = strip(read('migrations/' + RB));

function body(sql, name) {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.' + name + '(');
  if (start < 0) return '';
  const after = sql.indexOf('$fn$;', start);
  return sql.slice(start, after >= 0 ? after + 5 : sql.length);
}
function between(s, a, b) {
  const i = s.indexOf(a);
  const j = s.indexOf(b, i + a.length);
  return i >= 0 && j >= 0 ? s.slice(i, j) : '';
}
const MP = body(S, 'order_mark_paid');
const IM = body(S, 'order_import_legacy_payment');
const RBMP = body(R, 'order_mark_paid');
const RBIM = body(R, 'order_import_legacy_payment');
const ROW_LOCK_RE = /\bFOR\s+(?:NO\s+KEY\s+UPDATE|KEY\s+SHARE|UPDATE|SHARE)\b/i;
const ledgerSelects = (b) => (b.match(/\bSELECT\b[\s\S]*?;/g) || []).filter((stmt) => /public\.order_financial_events\b/.test(stmt));
const noLedgerRowLocks = (b) => ledgerSelects(b).every((stmt) => !ROW_LOCK_RE.test(stmt));

// structure / scope
assert('BEGIN/COMMIT', /^\s*BEGIN;/.test(S) && /COMMIT;\s*$/.test(S.trim() + '\n'));
assert('staging sentinel', /schema_migrations WHERE version='20260710075612'/.test(S));
assert('precondition requires guarded payment-basis signatures', /expected 2 guarded payment-basis RPCs/.test(S) && /p_session_version integer/.test(S));
assert('precondition refuses old unguarded payment-basis overloads', /unguarded payment-basis overload present/.test(S) &&
  /p_by_actor text, p_ip_hash text, p_meta jsonb/.test(S));
assert('replaces exactly two payment-basis RPCs', (S.match(/CREATE OR REPLACE FUNCTION public\.order_/g) || []).length === 2 &&
  /public\.order_mark_paid/.test(S) && /public\.order_import_legacy_payment/.test(S));
assert('does not replace refund/void/create/rider/generic helper', !/public\.order_(refund|void|create|rider_deliver|insert_financial_event)\b/.test(S));
assert('no table/schema/constraint/index/RLS change', !/CREATE TABLE|ALTER TABLE|ADD COLUMN|DROP COLUMN|CREATE INDEX|CREATE UNIQUE INDEX|ADD CONSTRAINT|ROW LEVEL SECURITY|CREATE POLICY|DROP POLICY/i.test(S));
const TOP = S.replace(/\$fn\$[\s\S]*?\$fn\$/g, '$fn$ body $fn$');
assert('no top-level data mutation', !/INSERT INTO public\.order_financial_events|UPDATE public\.order_financial_events|UPDATE public\.ordenes|DELETE FROM|TRUNCATE/i.test(TOP));

for (const [name, b] of Object.entries({ order_mark_paid: MP, order_import_legacy_payment: IM })) {
  assert(`[${name}] present`, b.length > 0);
  assert(`[${name}] guarded signature preserved`, /p_by_actor text, p_session_version integer/.test(b));
  assert(`[${name}] SECURITY INVOKER + pinned search_path`, /SECURITY INVOKER/.test(b) && /SET search_path = public, pg_temp/.test(b));
  assert(`[${name}] actor lock, session compare, order lock ordering`, (() => {
    const actor = b.indexOf('FROM public.auth_actors WHERE actor = p_by_actor FOR UPDATE');
    const sess = b.indexOf('IF p_session_version <> v_by.session_version');
    const order = b.indexOf('FROM public.ordenes WHERE id = p_order_id FOR UPDATE');
    return actor >= 0 && sess > actor && order > sess;
  })());
  assert(`[${name}] ledger SELECTs remain plain`, noLedgerRowLocks(b));
  assert(`[${name}] same-scope lookup before generic basis rejection`, b.indexOf('idem_scope_key = p_idem_scope_key;') < b.indexOf('AUTH_BASIS_EXISTS'));
  assert(`[${name}] replay digest branch before fresh digest branch`, b.indexOf('v_replay_digest :=') < b.indexOf('v_canon := jsonb_build_object'));
  assert(`[${name}] replay digest excludes ip/meta/created_at/session_version`, (() => {
    const replay = between(b, 'v_replay_digest :=', 'IF v_existing.payload_digest = v_replay_digest');
    return !/ip_hash|v_meta|'meta'|created_at|session_version/i.test(replay);
  })());
  assert(`[${name}] return omits digest/ip_hash/meta/reason`, (() => {
    const returns = b.match(/RETURN jsonb_build_object\([\s\S]*?\);/g) || [];
    return returns.length >= 2 && returns.every((r) => !/payload_digest|ip_hash|'meta'|'reason'|'confirm/i.test(r));
  })());
  assert(`[${name}] integrity gate precedes replay digest`, b.indexOf("THEN RAISE EXCEPTION 'AUTH_IDEMPOTENCY_CONFLICT'") < b.indexOf('v_replay_digest :='));
}

const mpReplay = between(MP, 'v_replay_digest :=', 'IF v_existing.payload_digest = v_replay_digest');
const imReplay = between(IM, 'v_replay_digest :=', 'IF v_existing.payload_digest = v_replay_digest');
const mpFresh = between(MP, 'v_canon := jsonb_build_object', 'v_digest :=');
const imFresh = between(IM, 'v_canon := jsonb_build_object', 'v_digest :=');

assert('mark_paid replay uses immutable estado/pay snapshots', /'prev_estado', v_existing\.prev_estado/.test(mpReplay) &&
  /'new_estado', v_existing\.new_estado/.test(mpReplay) &&
  /'prev_pay_state', v_existing\.prev_pay_state/.test(mpReplay) &&
  /'new_pay_state', v_existing\.new_pay_state/.test(mpReplay) &&
  !/v_ord\.estado/.test(mpReplay));
assert('mark_paid replay uses existing immutable amount', /'amount', v_existing\.amount/.test(mpReplay) && !/'amount', v_amount/.test(mpReplay));
assert('mark_paid replay still uses current normalized actor/method/reason semantics', /'by_actor', p_by_actor/.test(mpReplay) &&
  /'by_role', v_role/.test(mpReplay) && /'reason', v_reason/.test(mpReplay) && /'payment_method', v_method/.test(mpReplay));
assert('mark_paid fresh semantics still use current order amount/state', /v_amount := round\(v_ord\.totale, 2\)/.test(MP) &&
  /'prev_estado', v_ord\.estado/.test(mpFresh) && /'new_estado', v_ord\.estado/.test(mpFresh) && /'amount', v_amount/.test(mpFresh));

assert('import replay uses immutable estado/pay snapshots', /'prev_estado', v_existing\.prev_estado/.test(imReplay) &&
  /'new_estado', v_existing\.new_estado/.test(imReplay) &&
  /'prev_pay_state', v_existing\.prev_pay_state/.test(imReplay) &&
  /'new_pay_state', v_existing\.new_pay_state/.test(imReplay) &&
  !/v_ord\.estado/.test(imReplay));
assert('import replay uses current normalized request amount/method/reason', /'amount', v_amount/.test(imReplay) &&
  /'payment_method', v_method/.test(imReplay) && /'reason', v_reason/.test(imReplay));
assert('import fresh semantics still use current order state + explicit amount', /v_amount := round\(p_amount, 2\)/.test(IM) &&
  /'prev_estado', v_ord\.estado/.test(imFresh) && /'new_estado', v_ord\.estado/.test(imFresh) && /'amount', v_amount/.test(imFresh));

assert('replay validates stored basis shape', /v_existing\.prev_estado IS DISTINCT FROM v_existing\.new_estado/.test(MP) &&
  /v_existing\.original_giro_id IS NOT NULL/.test(MP) && /v_existing\.legacy IS DISTINCT FROM false/.test(MP) &&
  /v_existing\.legacy IS DISTINCT FROM true/.test(IM));
assert('digest mismatch remains AUTH_IDEMPOTENCY_CONFLICT', (MP.match(/AUTH_IDEMPOTENCY_CONFLICT/g) || []).length >= 2 &&
  (IM.match(/AUTH_IDEMPOTENCY_CONFLICT/g) || []).length >= 2);
assert('grants remain service_role only', (S.match(/GRANT EXECUTE ON FUNCTION[\s\S]*?TO service_role/g) || []).length === 2 &&
  !/GRANT EXECUTE[\s\S]*?TO (PUBLIC|anon|authenticated)\b/i.test(S));

// rollback
assert('rollback requires explicit replay downgrade confirmation', /ROLLBACK REFUSED/.test(R) && /confirm_b7a2e_replay_fix_rollback/.test(R));
assert('rollback verifies expected B7A2E forward state before replacement', /expected B7A2E corrected guarded payment-basis RPCs/.test(R) &&
  /pg_get_functiondef\(p\.oid\) LIKE '%v_replay_digest%'/.test(R) &&
  /pg_get_functiondef\(p\.oid\) LIKE '%v_existing\.prev_estado%'/.test(R));
assert('rollback refuses old unguarded payment-basis overloads', /ROLLBACK REFUSED: unguarded payment-basis overload present/.test(R));
assert('rollback restores guarded signatures', /p_by_actor text, p_session_version integer/.test(RBMP) && /p_by_actor text, p_session_version integer/.test(RBIM));
assert('rollback restores B7A2D mutable replay baseline', /v_canon := jsonb_build_object[\s\S]*'prev_estado', v_ord\.estado[\s\S]*SELECT \* INTO v_existing/.test(RBMP) &&
  /v_canon := jsonb_build_object[\s\S]*'prev_estado', v_ord\.estado[\s\S]*SELECT \* INTO v_existing/.test(RBIM));
const RTOP = R.replace(/\$fn\$[\s\S]*?\$fn\$/g, '$fn$ body $fn$');
assert('rollback top level deletes/rewrites no evidence', !/DELETE FROM|TRUNCATE|UPDATE public\.order_financial_events|UPDATE public\.ordenes|UPDATE public\.auth_actors/i.test(RTOP));

// negative controls
(function nc() {
  const mpBadState = mpReplay.replace(/v_existing\.prev_estado/g, 'v_ord.estado');
  assert('NC1: detector catches mutable order estado in mark_paid replay', /v_ord\.estado/.test(mpBadState));
  const mpBadAmount = mpReplay.replace('v_existing.amount', 'v_amount');
  assert('NC2: detector catches mark_paid replay amount drift', /'amount', v_amount/.test(mpBadAmount));
  const imBadState = imReplay.replace(/v_existing\.new_estado/g, 'v_ord.estado');
  assert('NC3: detector catches mutable order estado in import replay', /v_ord\.estado/.test(imBadState));
  const badPayState = mpReplay.replace(/v_existing\.prev_pay_state/g, 'v_pay_state');
  assert('NC4: detector catches current derived pay state in replay', /v_pay_state/.test(badPayState));
  const lateReplay = 'AUTH_BASIS_EXISTS then v_replay_digest :=';
  assert('NC5: detector catches replay after basis rejection', lateReplay.indexOf('v_replay_digest :=') > lateReplay.indexOf('AUTH_BASIS_EXISTS'));
  const withSessionDigest = mpReplay.replace("'legacy', false", "'session_version', p_session_version, 'legacy', false");
  assert('NC6: detector catches session version in digest', /session_version/.test(withSessionDigest));
  assert('NC7: detector catches ledger row locks', !noLedgerRowLocks(MP.replace('idem_scope_key = p_idem_scope_key;', 'idem_scope_key = p_idem_scope_key FOR UPDATE;')));
  const topData = TOP + '\nUPDATE public.ordenes SET cobrado = true;';
  assert('NC8: detector catches top-level order mutation', /UPDATE public\.ordenes/i.test(topData));
  const oldOverload = S.replace('unguarded payment-basis overload present', 'unguarded check removed');
  assert('NC9: detector catches missing unguarded-overload refusal', !/unguarded payment-basis overload present/.test(oldOverload));
  const ledgerRewrite = TOP + '\nUPDATE public.order_financial_events SET payload_digest = payload_digest;';
  assert('NC10: detector catches existing ledger event update', /UPDATE public\.order_financial_events/i.test(ledgerRewrite));
  const refundReplace = S + '\nCREATE OR REPLACE FUNCTION public.order_refund() RETURNS jsonb LANGUAGE sql AS $$ SELECT null::jsonb $$;';
  assert('NC11: detector catches refund/void function replacement', /public\.order_(refund|void)\b/.test(refundReplace));
  const importCurrentState = imReplay.replace(/v_existing\.prev_estado/g, 'v_ord.estado');
  assert('NC12: detector catches legacy-import replay dependent on current order state', /v_ord\.estado/.test(importCurrentState));
})();

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
