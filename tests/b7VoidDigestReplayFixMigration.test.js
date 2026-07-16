'use strict';
// B7A2B corrective static tests — order_void replay-digest fix.
// Run: node tests/b7VoidDigestReplayFixMigration.test.js
// NON-EXECUTING: inspects SQL text only. No DB, no apply. Proves the corrective
// migration is a separate file, replaces ONLY order_void, canonicalizes the void
// replay amount as literal 0 in BOTH fresh and replay paths, fails closed on the
// existing-event void shape, preserves all security/lock/ledger invariants, adds no
// UPDATE privilege, and that the rollback refuses when void evidence exists. Plus
// negative controls proving each detector fires.
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
const FWD = '2026-07-16_b7_void_digest_replay_fix.sql';
const RB = '2026-07-16_b7_void_digest_replay_fix.ROLLBACK.sql';
const ORIG = '2026-07-15_b7_refund_void_rpcs.sql';

const strip = (s) => s.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
const blockBetween = (s, start, end) => s.slice(s.indexOf(start), s.indexOf(end, s.indexOf(start)));
const ROW_LOCK_RE = /\bFOR\s+(?:NO\s+KEY\s+UPDATE|KEY\s+SHARE|UPDATE|SHARE)\b/i;

// ── file identity: a separate corrective migration exists ────────────────────
assert('corrective forward filename matches convention', FWD_CONV.test(FWD) && !isRB(FWD));
assert('corrective rollback filename matches convention', RB_CONV.test(RB));
assert('corrective forward is the preferred name', FWD === 'migrations/2026-07-16_b7_void_digest_replay_fix.sql'.replace('migrations/', ''));
assert('both corrective files discovered', ALL.includes(FWD) && ALL.includes(RB) && isRB(RB) && !isRB(FWD));
assert('corrective is distinct from original B7A2B', FWD !== ORIG && RB !== ORIG);

const S = strip(read('migrations/' + FWD));
const R = strip(read('migrations/' + RB));

// ── original B7A2B migration is NOT edited (still carries the pre-fix bug) ────
const ORIGSQL = strip(read('migrations/' + ORIG));
const origVoid = blockBetween(ORIGSQL, 'CREATE OR REPLACE FUNCTION public.order_void', 'REVOKE ALL ON FUNCTION');
const origReplay = blockBetween(origVoid, 'v_replay_digest :=', 'IF v_existing.payload_digest');
assert('ORIGINAL B7A2B untouched: still creates both refund+void', /CREATE OR REPLACE FUNCTION public\.order_refund/.test(ORIGSQL) && /CREATE OR REPLACE FUNCTION public\.order_void/.test(ORIGSQL));
assert('ORIGINAL B7A2B untouched: void replay still uses v_existing.amount (pre-fix)', /'amount', v_existing\.amount/.test(origReplay));

// ── corrective replaces EXACTLY order_void ───────────────────────────────────
const created = (S.match(/CREATE OR REPLACE FUNCTION public\.([a-z_]+)/g) || []).map((m) => m.replace('CREATE OR REPLACE FUNCTION public.', ''));
assert('exactly one CREATE OR REPLACE FUNCTION', created.length === 1, created.join(','));
assert('the replaced function is order_void', created[0] === 'order_void');
assert('does not recreate refund/payment/import/create RPCs', !/public\.order_(refund|mark_paid|import_legacy_payment|create|rider_deliver)\b/.test(S));
assert('no new/generic event RPC', !/order_insert_financial_event/i.test(S));

// ── signature / security / structure unchanged ───────────────────────────────
assert('exact committed signature', /CREATE OR REPLACE FUNCTION public\.order_void\(\s*p_order_id text, p_reason text, p_by_actor text,\s*p_ip_hash text, p_meta jsonb, p_idem_scope_key text\)/.test(S));
assert('returns jsonb', /RETURNS jsonb/.test(S));
assert('SECURITY INVOKER (no DEFINER)', /SECURITY INVOKER/.test(S) && !/SECURITY DEFINER/i.test(S));
assert('pinned search_path', /SET search_path = public, pg_temp/.test(S));
assert('BEGIN/COMMIT', /^\s*BEGIN;/.test(S) && /COMMIT;\s*$/.test(S.trim() + '\n'));
assert('staging sentinel', /schema_migrations WHERE version='20260710075612'/.test(S));
assert('precondition verifies committed order_void exists', /pg_get_function_identity_arguments\(p\.oid\)='p_order_id text, p_reason text, p_by_actor text, p_ip_hash text, p_meta jsonb, p_idem_scope_key text'/.test(S) && /order_void/.test(S));
assert('no dynamic SQL', !/\bEXECUTE\s+format\b/i.test(S) && !/\bEXECUTE\s+'/.test(S));
assert('no table/schema/constraint/index/RLS change', !/CREATE TABLE|ALTER TABLE|ADD COLUMN|DROP COLUMN|CREATE INDEX|CREATE UNIQUE INDEX|ADD CONSTRAINT|ROW LEVEL SECURITY|CREATE POLICY|DROP POLICY/i.test(S));
assert('no data mutation outside the function body', !/\b(DELETE FROM|TRUNCATE)\b/i.test(S));
assert('test executes no DB', (() => { const self = read('tests/b7VoidDigestReplayFixMigration.test.js'); return !/require\(['"](pg|postgres|@supabase)/.test(self) && !/\.query\(/.test(self); })());

const VD = blockBetween(S, 'CREATE OR REPLACE FUNCTION public.order_void', 'REVOKE ALL ON FUNCTION');

// ── locks + plain ledger reads preserved ─────────────────────────────────────
assert('locks initiator FOR UPDATE + active', /auth_actors WHERE actor = p_by_actor FOR UPDATE/.test(VD) && /v_by\.active <> true[\s\S]*?AUTH_INITIATOR_INACTIVE/.test(VD));
assert('role from DB, not caller', /v_role := v_by\.role/.test(VD) && !/p_by_role/.test(VD));
assert('locks order FOR UPDATE', /ordenes WHERE id = p_order_id FOR UPDATE/.test(VD));
const ledgerSelects = (b) => (b.match(/\bSELECT\b[\s\S]*?;/g) || []).filter((stmt) => /public\.order_financial_events\b/.test(stmt));
assert('all ledger SELECTs are plain (no row lock)', ledgerSelects(VD).every((stmt) => !ROW_LOCK_RE.test(stmt)));
const firstLedger = VD.indexOf('FROM public.order_financial_events');
const orderLock = VD.indexOf('SELECT * INTO v_ord FROM public.ordenes WHERE id = p_order_id FOR UPDATE;');
assert('first ledger read after order lock', orderLock >= 0 && firstLedger > orderLock);
assert('role/meta/ip/idem/reason validation retained', /AUTH_META_INVALID/.test(VD) && /AUTH_META_TOO_LARGE/.test(VD) && /AUTH_META_SENSITIVE_KEY/.test(VD) && /AUTH_IP_HASH_REQUIRED/.test(VD) && /AUTH_IP_HASH_TOO_LONG/.test(VD) && /AUTH_IDEM_KEY_INVALID/.test(VD) && /AUTH_REASON_BLANK/.test(VD) && /AUTH_FORBIDDEN_ROLE/.test(VD) && /AUTH_VOID_STATE_FORBIDDEN/.test(VD));
assert('void state grammar unchanged (four active states)', /v_ord\.estado NOT IN \('POR_CONFIRMAR','EN_COCINA','LISTO','EN_ENTREGA'\)/.test(VD));
assert('pay-state derived from ledger only (no mutable flags)', /type IN \('refund','payment','payment_imported'\)/.test(VD) && !/ya_pagado|cobrado/.test(blockBetween(VD, 'v_pay_state :=', 'v_canon :=')));
assert('atomic: insert then order UPDATE', VD.indexOf('INSERT INTO public.order_financial_events') < VD.indexOf('UPDATE public.ordenes'));
assert('order update only estado + cancelado_at', /UPDATE public\.ordenes SET estado = 'ANULADO', cancelado_at = v_now/.test(VD));

// ── grants: reasserted, service_role only, NO update privilege ───────────────
assert('reasserts REVOKE from PUBLIC/anon/authenticated for order_void', /REVOKE ALL ON FUNCTION public\.order_void\(text, text, text, text, jsonb, text\)\s*FROM PUBLIC, anon, authenticated/.test(S));
assert('reasserts EXECUTE to service_role only', /GRANT EXECUTE ON FUNCTION public\.order_void\(text, text, text, text, jsonb, text\)\s*TO service_role/.test(S));
assert('no EXECUTE grant to PUBLIC/anon/authenticated', !/GRANT EXECUTE[\s\S]*?TO (PUBLIC|anon|authenticated)\b/i.test(S));
const noLedgerUpdateGrant = (s) =>
  !/GRANT[\s\S]*?\bUPDATE\b[\s\S]*?order_financial_events[\s\S]*?TO service_role/i.test(s) &&
  !/GRANT[\s\S]*?order_financial_events[\s\S]*?\bUPDATE\b[\s\S]*?TO service_role/i.test(s);
assert('no ledger UPDATE privilege granted to service_role', noLedgerUpdateGrant(S));

// ── THE FIX: fresh + replay canon both serialize amount as literal 0 ─────────
const freshCanon = blockBetween(VD, 'v_canon := jsonb_build_object', 'v_digest :=');
const sameScopeFound = blockBetween(VD, "type = 'void' AND idem_scope_key = p_idem_scope_key;", '(B) pay state');
const integrity = blockBetween(sameScopeFound, 'IF FOUND THEN', 'v_replay_digest :=');
const replayCanon = blockBetween(sameScopeFound, 'v_replay_digest :=', 'IF v_existing.payload_digest');

assert('FRESH void canon uses literal amount 0', /'amount', 0\b/.test(freshCanon) && !/'amount', v_existing\.amount/.test(freshCanon) && !/'amount', v_ord\.amount/.test(freshCanon));
assert('FRESH void canon method NULL / legacy false', /'payment_method', NULL/.test(freshCanon) && /'legacy', false/.test(freshCanon));
assert('REPLAY void canon uses literal amount 0 (fix)', /'amount', 0\b/.test(replayCanon));
assert('REPLAY void canon does NOT use v_existing.amount', !/'amount', v_existing\.amount/.test(replayCanon));
assert('REPLAY void canon method NULL / legacy false (scale-independent)', /'payment_method', NULL/.test(replayCanon) && /'legacy', false/.test(replayCanon) && !/'payment_method', v_existing\.payment_method/.test(replayCanon) && !/'legacy', v_existing\.legacy/.test(replayCanon));
assert('REPLAY still sources immutable state snapshots from v_existing', /'prev_estado', v_existing\.prev_estado/.test(replayCanon) && /'new_estado', v_existing\.new_estado/.test(replayCanon) && /'prev_pay_state', v_existing\.prev_pay_state/.test(replayCanon) && /'new_pay_state', v_existing\.new_pay_state/.test(replayCanon) && /'original_giro_id', v_existing\.original_giro_id/.test(replayCanon));
assert('REPLAY does NOT rebuild from post-op current order state', !/v_ord\.estado|v_ord\.manual_giro_id/.test(replayCanon));

// ── existing-event integrity check before returning replay ───────────────────
assert('replay fails closed on non-void shape (AUTH_VOID_REPLAY_INTEGRITY)', /AUTH_VOID_REPLAY_INTEGRITY/.test(integrity));
assert('integrity validates amount=0', /v_existing\.amount <> 0/.test(integrity));
assert('integrity validates payment_method NULL', /v_existing\.payment_method IS NOT NULL/.test(integrity));
assert('integrity validates legacy=false', /v_existing\.legacy IS DISTINCT FROM false/.test(integrity));
assert('integrity validates new_estado ANULADO + pay-state stable', /v_existing\.new_estado <> 'ANULADO'/.test(integrity) && /v_existing\.prev_pay_state IS DISTINCT FROM v_existing\.new_pay_state/.test(integrity));
assert('integrity check precedes replay digest computation', VD.indexOf('AUTH_VOID_REPLAY_INTEGRITY') < VD.indexOf('v_replay_digest :='));
assert('replay returns idempotent true on digest match', /v_existing\.payload_digest = v_replay_digest[\s\S]*?'idempotent', true/.test(VD));
assert('digest mismatch → conflict', /AUTH_IDEMPOTENCY_CONFLICT/.test(VD));
assert('same-scope replay still BEFORE state rejection', VD.indexOf("type = 'void' AND idem_scope_key = p_idem_scope_key;") < VD.indexOf('AUTH_VOID_STATE_FORBIDDEN'));

// ── rollback ─────────────────────────────────────────────────────────────────
assert('rollback refuses when void evidence exists', /ROLLBACK REFUSED/.test(R) && /type = 'void'/.test(R) && /count\(\*\)/.test(R));
assert('rollback restores order_void only', (R.match(/CREATE OR REPLACE FUNCTION public\.([a-z_]+)/g) || []).length === 1 && /CREATE OR REPLACE FUNCTION public\.order_void/.test(R));
// The restored function body legitimately contains its own DML (INSERT/UPDATE ordenes);
// the safety property is that the rollback's TOP-LEVEL statements (outside the
// dollar-quoted body) run no destructive DML. Strip the $fn$…$fn$ body first.
const R_TOP = R.replace(/\$fn\$[\s\S]*?\$fn\$/g, '$fn$ …restored-body… $fn$');
assert('rollback top-level runs no destructive DML (no digest/evidence/order rewrite)', !/DELETE FROM|TRUNCATE|refunded = false|cancelado_at = NULL|payload_digest\s*=|UPDATE public\.order_financial_events|UPDATE public\.ordenes/i.test(R_TOP));
assert('rollback never deletes evidence anywhere', !/DELETE FROM|TRUNCATE/i.test(R));
assert('rollback does not drop functions or touch other B7 objects', !/DROP FUNCTION|order_refund|order_mark_paid|order_import_legacy_payment/.test(R));

// ── doc references corrective artifacts ──────────────────────────────────────
const DOC = read('docs/access-control/B7A2_REFUND_VOID_CONTRACT.md');
assert('doc references corrective forward + rollback filenames', DOC.includes('migrations/' + FWD) && DOC.includes('migrations/' + RB));
assert('doc states void amount canonical literal 0 in both paths', /literal.*0|canonical JSON number `0`|literal canonical zero/i.test(DOC) && /replay/i.test(DOC));

// ── NEGATIVE CONTROLS ────────────────────────────────────────────────────────
(function nc() {
  // NC1: replay reverting to v_existing.amount must be caught
  const nc1 = replayCanon.replace("'amount', 0", "'amount', v_existing.amount");
  assert('NC1: replay using v_existing.amount detected', /'amount', v_existing\.amount/.test(nc1));
  // NC2: fresh uses literal 0 but replay uses numeric column → asymmetry caught
  const badReplay = replayCanon.replace("'amount', 0", "'amount', v_existing.amount");
  assert('NC2: fresh/replay representation mismatch detected',
    /'amount', 0\b/.test(freshCanon) && !/'amount', v_existing\.amount/.test(freshCanon) && /'amount', v_existing\.amount/.test(badReplay));
  // NC3: removing the amount integrity check is caught
  const nc3 = integrity.replace(/v_existing\.amount <> 0 OR /, '');
  assert('NC3: removed amount integrity check detected', /v_existing\.amount <> 0/.test(integrity) && !/v_existing\.amount <> 0/.test(nc3));
  // NC4: reintroducing a ledger row-lock clause is caught
  const nc4 = VD.replace("type = 'void' AND idem_scope_key = p_idem_scope_key;", "type = 'void' AND idem_scope_key = p_idem_scope_key FOR UPDATE;");
  assert('NC4: ledger FOR UPDATE reintroduced detected', ledgerSelects(VD).every((s) => !ROW_LOCK_RE.test(s)) && !ledgerSelects(nc4).every((s) => !ROW_LOCK_RE.test(s)));
  // NC5: granting UPDATE to service_role is caught
  assert('NC5: ledger UPDATE grant detected', noLedgerUpdateGrant(S) && !noLedgerUpdateGrant(S + '\nGRANT UPDATE ON public.order_financial_events TO service_role;'));
  // NC6: rewriting an existing void event is caught
  assert('NC6: rewriting existing void events detected', !/UPDATE public\.order_financial_events/i.test(S) && /UPDATE public\.order_financial_events/i.test(S + '\nUPDATE public.order_financial_events SET amount=0 WHERE type=\'void\';'));
  // NC7: rollback deleting evidence is caught
  assert('NC7: rollback deleting evidence detected', !/DELETE FROM/i.test(R) && /DELETE FROM/i.test(R + '\nDELETE FROM public.order_financial_events;'));
  // NC8: replay rebuilt from current (already-ANULADO) order state is caught
  const nc8 = replayCanon.replace('v_existing.prev_estado', 'v_ord.estado');
  assert('NC8: replay rebuilt from post-op current state detected', /v_existing\.prev_estado/.test(replayCanon) && !/v_existing\.prev_estado/.test(nc8));
})();

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
