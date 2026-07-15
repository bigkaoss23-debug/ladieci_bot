'use strict';
// B7A2B static migration/SQL tests. Run: node tests/b7RefundVoidRpcsMigration.test.js
// NON-EXECUTING: inspects SQL text. No DB, no apply. Comment-stripped structural
// assertions + robust per-function body extraction + negative controls.
const fs = require('fs');
const path = require('path');
let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const MIG_DIR = path.join(__dirname, '..', 'migrations');
const ALL = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql'));
const isRB = (f) => f.endsWith('.ROLLBACK.sql');
const FWD_CONV = /^\d{4}-\d{2}-\d{2}_[a-z0-9_]+\.sql$/;
const RB_CONV = /^\d{4}-\d{2}-\d{2}_[a-z0-9_]+\.ROLLBACK\.sql$/;
const FWD = '2026-07-15_b7_refund_void_rpcs.sql';
const RB = '2026-07-15_b7_refund_void_rpcs.ROLLBACK.sql';

assert('forward filename matches convention', FWD_CONV.test(FWD) && !isRB(FWD));
assert('rollback filename matches convention', RB_CONV.test(RB));
assert('forward discovered / rollback excluded', ALL.includes(FWD) && !isRB(FWD) && isRB(RB));
assert('both files exist', fs.existsSync(path.join(MIG_DIR, FWD)) && fs.existsSync(path.join(MIG_DIR, RB)));

const SQL = read('migrations/' + FWD);
const RBSQL = read('migrations/' + RB);
const strip = (s) => s.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
const S = strip(SQL);
const R = strip(RBSQL);

const rfIdx = S.indexOf('CREATE OR REPLACE FUNCTION public.order_refund');
const vdIdx = S.indexOf('CREATE OR REPLACE FUNCTION public.order_void');
const grantsIdx = S.indexOf('REVOKE ALL ON FUNCTION');
const RF = S.slice(rfIdx, vdIdx);
const VD = S.slice(vdIdx, grantsIdx);
const BODIES = [RF, VD];
const ROW_LOCK_RE = /\bFOR\s+(?:NO\s+KEY\s+UPDATE|KEY\s+SHARE|UPDATE|SHARE)\b/i;
const ledgerSelects = (b) => (b.match(/\bSELECT\b[\s\S]*?;/g) || [])
  .filter((stmt) => /public\.order_financial_events\b/.test(stmt));
const noLedgerRowLocks = (b) => ledgerSelects(b).every((stmt) => !ROW_LOCK_RE.test(stmt));
const firstLedgerReadAfterOrderLock = (b) => {
  const orderLock = b.indexOf('SELECT * INTO v_ord FROM public.ordenes WHERE id = p_order_id FOR UPDATE;');
  const firstLedger = b.indexOf('FROM public.order_financial_events');
  return orderLock >= 0 && firstLedger > orderLock;
};
const noLedgerUpdateGrantToServiceRole = (s) =>
  !/GRANT[\s\S]*?\bUPDATE\b[\s\S]*?order_financial_events[\s\S]*?TO service_role/i.test(s) &&
  !/GRANT[\s\S]*?order_financial_events[\s\S]*?\bUPDATE\b[\s\S]*?TO service_role/i.test(s);
const blockBetween = (s, start, end) => s.slice(s.indexOf(start), s.indexOf(end, s.indexOf(start)));

// ── structure ────────────────────────────────────────────────────────────────
assert('BEGIN/COMMIT', /^\s*BEGIN;/.test(S) && /COMMIT;\s*$/.test(S.trim() + '\n'));
assert('staging sentinel', /schema_migrations WHERE version='20260710075612'/.test(S));
assert('verifies B7A1 ledger exists', /to_regclass\('public\.order_financial_events'\) IS NULL/.test(S));
assert('fail-closed on partial B7A2B', /partial B7A2B objects already present/.test(S) && /proname IN \('order_refund','order_void'\)/.test(S));
const created = (S.match(/CREATE OR REPLACE FUNCTION public\.([a-z_]+)/g) || []).map((m) => m.replace('CREATE OR REPLACE FUNCTION public.', ''));
assert('exactly two business RPCs', created.length === 2 && created.includes('order_refund') && created.includes('order_void'), created.join(','));
assert('no create/rider-deliver/payment/import RPC recreation', !/public\.order_(create|rider_deliver|mark_paid|import_legacy_payment)\b/.test(S));
assert('no generic event helper', !/order_insert_financial_event/i.test(S) && (S.match(/CREATE OR REPLACE FUNCTION/gi) || []).length === 2);
assert('no table/schema/constraint/index/RLS change', !/CREATE TABLE|ALTER TABLE|ADD COLUMN|DROP COLUMN|CREATE INDEX|CREATE UNIQUE INDEX|ADD CONSTRAINT|ROW LEVEL SECURITY|CREATE POLICY/i.test(S));
assert('test executes no DB', (() => { const self = read('tests/b7RefundVoidRpcsMigration.test.js'); return !/require\(['"](pg|postgres|@supabase)/.test(self) && !/\.query\(/.test(self); })());

// ── security (both) ──────────────────────────────────────────────────────────
assert('both SECURITY INVOKER', (S.match(/SECURITY INVOKER/g) || []).length === 2 && !/SECURITY DEFINER/i.test(S));
assert('both pin search_path', (S.match(/SET search_path = public, pg_temp/g) || []).length === 2);
assert('no dynamic SQL', !/\bEXECUTE\s+format\b/i.test(S) && !/\bEXECUTE\s+'/.test(S));
assert('grants revoke from PUBLIC/anon/authenticated (both)', (S.match(/REVOKE ALL ON FUNCTION[\s\S]*?FROM PUBLIC, anon, authenticated/g) || []).length === 2);
assert('grants EXECUTE to service_role only (both)', (S.match(/GRANT EXECUTE ON FUNCTION[\s\S]*?TO service_role/g) || []).length === 2);
assert('no EXECUTE grant to PUBLIC/anon/authenticated', !/GRANT EXECUTE[\s\S]*?TO (PUBLIC|anon|authenticated)\b/i.test(S));
assert('no ledger UPDATE privilege granted to service_role', noLedgerUpdateGrantToServiceRole(S));
assert('digest via native sha256 (no md5/no caller digest)', (S.match(/encode\(sha256\(convert_to\(/g) || []).length >= 2 && !/\bmd5\b/i.test(S) && !/p_digest/.test(S));

BODIES.forEach((b, i) => {
  const nm = i === 0 ? 'order_refund' : 'order_void';
  assert(`[${nm}] locks initiator FOR UPDATE + active`, /auth_actors WHERE actor = p_by_actor FOR UPDATE/.test(b) && /v_by\.active <> true[\s\S]*?AUTH_INITIATOR_INACTIVE/.test(b));
  assert(`[${nm}] role from DB (v_by.role), not caller`, /v_role := v_by\.role/.test(b) && !/p_by_role/.test(b));
  assert(`[${nm}] locks order FOR UPDATE`, /ordenes WHERE id = p_order_id FOR UPDATE/.test(b));
  assert(`[${nm}] first ledger read occurs after order lock`, firstLedgerReadAfterOrderLock(b));
  assert(`[${nm}] ledger SELECTs use no row-locking clause`, noLedgerRowLocks(b));
  assert(`[${nm}] IP hash required + max length`, /p_ip_hash IS NULL OR btrim\(p_ip_hash\) = ''[\s\S]*?AUTH_IP_HASH_REQUIRED/.test(b) && /length\(p_ip_hash\) > 64/.test(b));
  assert(`[${nm}] metadata object/size/sensitive guard`, /jsonb_typeof\(v_meta\) <> 'object'/.test(b) && /length\(v_meta::text\) > 2048/.test(b) && /'raw_ip'/.test(b) && /'confirmation'/.test(b));
  assert(`[${nm}] idem key length + regex`, /char_length\(p_idem_scope_key\) < 8 OR char_length\(p_idem_scope_key\) > 128[\s\S]*?\^\[A-Za-z0-9_-\]\+\$/.test(b));
  assert(`[${nm}] reason mandatory non-blank`, /p_reason IS NULL OR btrim\(p_reason\) = ''[\s\S]*?AUTH_REASON_BLANK/.test(b));
  assert(`[${nm}] no caller amount/method/state/giro/pay-state/digest`, !/p_amount|p_payment_method|p_new_estado|p_prev_estado|p_pay_state|p_original_giro|p_digest/.test(b));
  // same-scope idempotency uses EXISTING event snapshots (replay reconstruction)
  assert(`[${nm}] same-scope lookup by (order_id,type,idem key) is a plain ledger SELECT`,
    new RegExp(`order_id = p_order_id AND type = '${nm === 'order_refund' ? 'refund' : 'void'}' AND idem_scope_key = p_idem_scope_key;`).test(b));
  assert(`[${nm}] replay digest reconstructed from v_existing snapshots (not current order)`,
    /v_replay_digest :=[\s\S]*?v_existing\.prev_estado[\s\S]*?v_existing\.new_estado[\s\S]*?v_existing\.prev_pay_state[\s\S]*?v_existing\.new_pay_state/.test(b));
  assert(`[${nm}] replay compares stored digest → idempotent true`, /v_existing\.payload_digest = v_replay_digest[\s\S]*?'idempotent', true/.test(b));
  assert(`[${nm}] different digest → conflict`, /AUTH_IDEMPOTENCY_CONFLICT/.test(b));
  assert(`[${nm}] digest excludes ip_hash/meta/created_at`, (() => { const c = b.slice(b.indexOf("'order_id', p_order_id"), b.indexOf('v_digest :=')); return !/ip_hash|'meta'|created_at/i.test(c); })());
  assert(`[${nm}] digest includes reason`, /'reason', v_reason/.test(b));
  assert(`[${nm}] sanitized return incl original_giro_id, no reason/digest/ip/meta`, (() => { const rets = b.match(/RETURN jsonb_build_object\([\s\S]*?\);/g) || []; return rets.length >= 1 && rets.every((r) => /'original_giro_id'/.test(r) && !/payload_digest|ip_hash|'meta'|'reason'/i.test(r)); })());
  assert(`[${nm}] atomic: insert event then order UPDATE (one fn)`, /INSERT INTO public\.order_financial_events/.test(b) && b.indexOf('INSERT INTO public.order_financial_events') < b.indexOf('UPDATE public.ordenes'));
});

// ── refund specifics ─────────────────────────────────────────────────────────
assert('refund: admin only', /v_role <> 'admin'[\s\S]*?AUTH_FORBIDDEN_ROLE/.test(RF));
assert('refund: basis from ledger (payment/payment_imported), plain SELECT', /type IN \('payment','payment_imported'\)[\s\S]*?LIMIT 1;/.test(RF));
assert('refund: no basis → reject', /AUTH_NO_PAYMENT_BASIS/.test(RF));
assert('refund: amount/method from basis (not order/flags)', /'amount', v_basis\.amount/.test(RF) && /'payment_method', v_basis\.payment_method/.test(RF) && !/v_ord\.totale|descuento|v_ord\.cobrado|v_ord\.ya_pagado/.test(RF));
assert('refund: replay obtains basis UUID through plain ledger SELECT', (() => {
  const replay = blockBetween(RF, 'IF FOUND THEN', 'IF v_existing.payload_digest');
  return /SELECT \* INTO v_basis FROM public\.order_financial_events[\s\S]*?type IN \('payment','payment_imported'\)[\s\S]*?LIMIT 1;/.test(replay) &&
    !ROW_LOCK_RE.test(replay);
})());
assert('refund: replay resolves basis before digest comparison', RF.indexOf('SELECT * INTO v_basis FROM public.order_financial_events') < RF.indexOf('IF v_existing.payload_digest'));
assert('refund: basis_event_id in fresh and replay digest', (() => {
  const replay = blockBetween(RF, 'v_replay_digest :=', 'IF v_existing.payload_digest');
  const fresh = blockBetween(RF, 'v_canon := jsonb_build_object', 'v_digest :=');
  return /'basis_event_id', v_basis\.id/.test(replay) && /'basis_event_id', v_basis\.id/.test(fresh);
})());
assert('refund: replay verifies basis amount/method match existing refund', /v_basis\.amount IS DISTINCT FROM v_existing\.amount[\s\S]*?v_basis\.payment_method IS DISTINCT FROM v_existing\.payment_method[\s\S]*?AUTH_REFUND_BASIS_INTEGRITY/.test(RF));
assert('refund: basis identity not from metadata or request input', (() => {
  const replay = blockBetween(RF, 'v_replay_digest :=', 'IF v_existing.payload_digest');
  const fresh = blockBetween(RF, 'v_canon := jsonb_build_object', 'v_digest :=');
  return !/p_basis|v_meta|p_meta/.test(replay + fresh);
})());
assert('refund: same-scope BEFORE basis and already-refunded', RF.indexOf('idem_scope_key = p_idem_scope_key;') < RF.indexOf('AUTH_NO_PAYMENT_BASIS') && RF.indexOf('idem_scope_key = p_idem_scope_key;') < RF.indexOf('AUTH_ALREADY_REFUNDED'));
assert('refund: already-refunded uses plain ledger SELECT not ordenes.refunded',
  /SELECT \* INTO v_existing_refund FROM public\.order_financial_events[\s\S]*?type = 'refund'[\s\S]*?LIMIT 1;[\s\S]*?IF FOUND THEN[\s\S]*?AUTH_ALREADY_REFUNDED/.test(RF) &&
  !/refunded = true[\s\S]*?AUTH_ALREADY_REFUNDED/.test(RF));
assert('refund: pay-state paid→refunded', /'prev_pay_state', 'paid', 'new_pay_state', 'refunded'/.test(RF));
assert('refund: event type refund + original_giro NULL', /VALUES \(p_order_id, 'refund', v_basis\.amount, v_basis\.payment_method, v_reason, false,[\s\S]*?'paid', 'refunded', NULL,/.test(RF));
assert('refund: updates only refunded=true', /UPDATE public\.ordenes SET refunded = true/.test(RF) && !/SET refunded = true[\s\S]*?(estado|manual_giro_id|metodo_pago|cancelado_at)/.test(RF.slice(RF.indexOf('UPDATE public.ordenes SET refunded'), RF.indexOf('WHERE id = p_order_id;', RF.indexOf('UPDATE public.ordenes SET refunded')))));

// ── void specifics ───────────────────────────────────────────────────────────
assert('void: admin or operator (rider denied)', /v_role NOT IN \('admin','operator'\)[\s\S]*?AUTH_FORBIDDEN_ROLE/.test(VD));
assert('void: NEW allowed only from four active states', /v_ord\.estado NOT IN \('POR_CONFIRMAR','EN_COCINA','LISTO','EN_ENTREGA'\)[\s\S]*?AUTH_VOID_STATE_FORBIDDEN/.test(VD));
assert('void: same-scope replay BEFORE pay-state and state rejection', VD.indexOf("type = 'void' AND idem_scope_key = p_idem_scope_key;") < VD.indexOf('v_pay_state :=') && VD.indexOf("type = 'void' AND idem_scope_key = p_idem_scope_key;") < VD.indexOf('AUTH_VOID_STATE_FORBIDDEN'));
assert('void: pay-state derived from plain ledger SELECT only',
  /SELECT \* INTO v_pay_event FROM public\.order_financial_events[\s\S]*?type IN \('refund','payment','payment_imported'\)[\s\S]*?LIMIT 1;/.test(VD) &&
  /IF FOUND AND v_pay_event\.type = 'refund' THEN\s*v_pay_state := 'refunded'/.test(VD) &&
  /ELSIF FOUND THEN\s*v_pay_state := 'paid'/.test(VD) &&
  /ELSE\s*v_pay_state := 'unpaid'/.test(VD));
assert('void: pay-state derivation precedes current-state rejection', VD.indexOf('v_pay_state :=') < VD.indexOf('AUTH_VOID_STATE_FORBIDDEN'));
assert('void: pay-state not from mutable flags', !/ya_pagado|cobrado/.test(VD.slice(VD.indexOf('v_pay_state :='), VD.indexOf('v_canon :='))));
assert('void: amount 0, method NULL, original_giro snapshot', /'amount', 0, 'payment_method', NULL, 'original_giro_id', v_ord\.manual_giro_id/.test(VD));
assert('void: prev/new pay-state equal (v_pay_state both)', /'prev_pay_state', v_pay_state, 'new_pay_state', v_pay_state/.test(VD));
assert('void: event new_estado ANULADO', /VALUES \(p_order_id, 'void', 0, NULL, v_reason, false,[\s\S]*?'ANULADO', v_pay_state, v_pay_state, v_ord\.manual_giro_id,/.test(VD));
assert('void: updates only estado + cancelado_at (retains manual_giro_id/refunded)', /UPDATE public\.ordenes SET estado = 'ANULADO', cancelado_at = v_now/.test(VD) && !/SET estado = 'ANULADO'[\s\S]*?(manual_giro_id|refunded|metodo_pago|ya_pagado)/.test(VD.slice(VD.indexOf("SET estado = 'ANULADO'"), VD.indexOf('WHERE id = p_order_id;', VD.indexOf("SET estado = 'ANULADO'")))));
assert('void: no automatic refund (no refund insert / no refunded write)', !/'refund'/.test(VD.slice(VD.indexOf('INSERT INTO public.order_financial_events'))) && !/SET refunded/.test(VD));

// ── rollback ─────────────────────────────────────────────────────────────────
assert('rollback drops exactly the two RPCs', (R.match(/DROP FUNCTION IF EXISTS public\.order_(refund|void)\b/g) || []).length === 2 && (R.match(/DROP FUNCTION/g) || []).length === 2);
assert('rollback refuses when refund/void evidence exists', /ROLLBACK REFUSED/.test(R) && /type IN \('refund','void'\)/.test(R));
assert('rollback never deletes/rewrites evidence', !/DELETE FROM|UPDATE public\.|DROP TABLE|ALTER TABLE|TRUNCATE|refunded = false/i.test(R));
assert('rollback does not touch B7A1/B7A2A/auth/grants', !/GRANT|REVOKE|order_mark_paid|order_import_legacy_payment|auth_actors|auth_audit/i.test(R));

// ── doc ──────────────────────────────────────────────────────────────────────
const DOC = read('docs/access-control/B7A2_REFUND_VOID_CONTRACT.md');
assert('doc references forward + rollback filenames', DOC.includes('migrations/' + FWD) && DOC.includes('migrations/' + RB));

// ── NEGATIVE CONTROLS ────────────────────────────────────────────────────────
(function nc() {
  assert('NC1: caller refund amount detected', /p_amount/.test(RF.replace('p_reason text, p_by_actor', 'p_reason text, p_amount numeric, p_by_actor')));
  assert('NC2: refund derived from ordenes.totale detected', /v_ord\.totale/.test(RF.replace('v_basis.amount', 'v_ord.totale')));
  assert('NC3: operator allowed to refund detected', /v_role NOT IN \('admin','operator'\)/.test(RF.replace("v_role <> 'admin'", "v_role NOT IN ('admin','operator')")));
  assert('NC4: ordenes.refunded used as refund authority detected', /v_ord\.refunded[\s\S]*?AUTH_ALREADY_REFUNDED/.test(RF.replace(/SELECT \* INTO v_existing_refund FROM public\.order_financial_events[\s\S]*?IF FOUND THEN/, 'IF v_ord.refunded THEN')));
  // NC5: RETIRADO wrongly added to the allowed set → the exact-four forbidden-state regex no longer matches
  assert('NC5: void allowed from RETIRADO detected', !/v_ord\.estado NOT IN \('POR_CONFIRMAR','EN_COCINA','LISTO','EN_ENTREGA'\)/.test(VD.replace("'EN_ENTREGA')", "'EN_ENTREGA','RETIRADO')")));
  assert('NC6: void clearing manual_giro_id detected', /SET estado = 'ANULADO'[\s\S]*?manual_giro_id = NULL/.test(VD.replace("SET estado = 'ANULADO', cancelado_at = v_now", "SET estado = 'ANULADO', cancelado_at = v_now, manual_giro_id = NULL")));
  assert('NC7: void auto-refund detected', /'refund'/.test(VD.slice(VD.indexOf('INSERT INTO public.order_financial_events')).replace("'void'", "'refund'")));
  assert('NC8: void pay-state from mutable flags detected', /v_ord\.cobrado/.test(VD.replace("type = 'refund'", "v_ord.cobrado")));
  const replayDigest = blockBetween(RF, 'v_replay_digest :=', 'IF v_existing.payload_digest');
  assert('NC9: detector catches basis_event_id omitted from replay digest', /'basis_event_id', v_basis\.id/.test(replayDigest) && !/'basis_event_id', v_basis\.id/.test(replayDigest.replace(/'basis_event_id', v_basis\.id,\s*/, '')));
  const digestBeforeBasis = RF.replace('SELECT * INTO v_basis FROM public.order_financial_events', 'IF v_existing.payload_digest = v_replay_digest THEN\n    SELECT * INTO v_basis FROM public.order_financial_events');
  assert('NC10: detector catches replay compare before resolving basis UUID', !(digestBeforeBasis.indexOf('SELECT * INTO v_basis FROM public.order_financial_events') < digestBeforeBasis.indexOf('IF v_existing.payload_digest')));
  assert('NC11: detector catches basis identity from metadata', /basis_event_id[\s\S]*v_meta/.test(RF.replace("'basis_event_id', v_basis.id", "'basis_event_id', v_meta->>'basis_event_id'")));
  assert('NC12: detector catches basis identity from request input', /p_basis_event_id/.test(RF.replace("'basis_event_id', v_basis.id", "'basis_event_id', p_basis_event_id")));
  assert('NC13: detector catches FOR UPDATE added to a basis lookup', !noLedgerRowLocks(RF.replace('ORDER BY created_at ASC LIMIT 1;', 'ORDER BY created_at ASC LIMIT 1 FOR UPDATE;')));
  assert('NC14: detector catches FOR UPDATE added to a scoped-event lookup', !noLedgerRowLocks(VD.replace('idem_scope_key = p_idem_scope_key;', 'idem_scope_key = p_idem_scope_key FOR UPDATE;')));
  assert('NC15: detector catches FOR SHARE added to a ledger lookup', !noLedgerRowLocks(VD.replace('idem_scope_key = p_idem_scope_key;', 'idem_scope_key = p_idem_scope_key FOR SHARE;')));
  assert('NC16: detector catches FOR KEY SHARE added to a ledger lookup', !noLedgerRowLocks(RF.replace('ORDER BY created_at ASC LIMIT 1;', 'ORDER BY created_at ASC LIMIT 1 FOR KEY SHARE;')));
  assert('NC17: detector catches removed order lock', !/ordenes WHERE id = p_order_id FOR UPDATE/.test(VD.replace(' WHERE id = p_order_id FOR UPDATE', ' WHERE id = p_order_id')));
  const ledgerMovedEarly = VD.replace('SELECT * INTO v_ord FROM public.ordenes WHERE id = p_order_id FOR UPDATE;', 'SELECT 1 FROM public.order_financial_events WHERE order_id = p_order_id;\n  SELECT * INTO v_ord FROM public.ordenes WHERE id = p_order_id FOR UPDATE;');
  assert('NC18: detector catches first ledger read before order lock', !firstLedgerReadAfterOrderLock(ledgerMovedEarly));
  assert('NC19: detector catches UPDATE granted to service_role', !noLedgerUpdateGrantToServiceRole(S + '\nGRANT UPDATE ON public.order_financial_events TO service_role;'));
  assert('NC20: same-scope check placed AFTER state rejection detected', (() => {
    const bad = "AUTH_VOID_STATE_FORBIDDEN then type = 'void' AND idem_scope_key = p_idem_scope_key;";
    return !(bad.indexOf("type = 'void' AND idem_scope_key = p_idem_scope_key;") < bad.indexOf('AUTH_VOID_STATE_FORBIDDEN'));
  })());
  // NC10: within the replay-reconstruction block only, swapping the existing-event
  // snapshot for the current order state must be caught (block no longer cites v_existing.prev_estado)
  assert('NC21: replay rebuilt from post-op current state detected', (() => {
    const block = VD.slice(VD.indexOf('v_replay_digest :='), VD.indexOf('IF v_existing.payload_digest'));
    const badBlock = block.replace('v_existing.prev_estado', 'v_ord.estado');
    return /v_existing\.prev_estado/.test(block) && !/v_existing\.prev_estado/.test(badBlock);
  })());
  assert('NC22: generic event helper detected', /order_insert_financial_event/i.test(S + '\nCREATE OR REPLACE FUNCTION public.order_insert_financial_event(p_type text) RETURNS void LANGUAGE sql AS $$ $$;'));
  assert('NC23: rollback deleting evidence detected', /DELETE FROM|DROP TABLE|refunded = false/i.test(R + '\nDELETE FROM public.order_financial_events;'));
})();

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
