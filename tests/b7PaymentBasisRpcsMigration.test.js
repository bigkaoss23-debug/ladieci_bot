'use strict';
// B7A2A static migration/SQL tests. Run: node tests/b7PaymentBasisRpcsMigration.test.js
// NON-EXECUTING: inspects the SQL text. No DB, no apply. Comment-stripped
// structural assertions + robust per-function body extraction + negative controls.
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
const FWD = '2026-07-15_b7_payment_basis_rpcs.sql';
const RB = '2026-07-15_b7_payment_basis_rpcs.ROLLBACK.sql';

// ── discovery / filename convention ──────────────────────────────────────────
assert('forward filename matches convention', FWD_CONV.test(FWD) && !isRB(FWD));
assert('rollback filename matches convention', RB_CONV.test(RB));
assert('forward discovered', ALL.includes(FWD) && !isRB(FWD));
assert('rollback excluded from forward set', isRB(RB));
assert('both files exist', fs.existsSync(path.join(MIG_DIR, FWD)) && fs.existsSync(path.join(MIG_DIR, RB)));

const SQL = read('migrations/' + FWD);
const RBSQL = read('migrations/' + RB);
const strip = (s) => s.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
const S = strip(SQL);
const R = strip(RBSQL);

// per-function body extraction
const mpIdx = S.indexOf('CREATE OR REPLACE FUNCTION public.order_mark_paid');
const liIdx = S.indexOf('CREATE OR REPLACE FUNCTION public.order_import_legacy_payment');
const grantsIdx = S.indexOf('REVOKE ALL ON FUNCTION');
const MP = S.slice(mpIdx, liIdx);      // order_mark_paid body
const LI = S.slice(liIdx, grantsIdx);  // order_import_legacy_payment body
const BODIES = [MP, LI];
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

// ── structure: transaction, sentinel, exactly two RPCs, fail-closed ──────────
assert('BEGIN/COMMIT', /^\s*BEGIN;/.test(S) && /COMMIT;\s*$/.test(S.trim() + '\n'));
assert('staging sentinel', /schema_migrations WHERE version='20260710075612'/.test(S));
assert('verifies B7A1 ledger exists', /to_regclass\('public\.order_financial_events'\) IS NULL/.test(S));
assert('fail-closed on partial B7A2A objects', /partial B7A2A objects already present/.test(S) &&
  /proname IN \('order_mark_paid','order_import_legacy_payment'\)/.test(S));
const created = (S.match(/CREATE OR REPLACE FUNCTION public\.([a-z_]+)/g) || []).map((m) => m.replace('CREATE OR REPLACE FUNCTION public.', ''));
assert('exactly two business RPCs created', created.length === 2 && created.includes('order_mark_paid') && created.includes('order_import_legacy_payment'), created.join(','));
assert('no refund/void/create/rider-deliver/generic-writer RPC',
  !/public\.order_(refund|void|create|rider_deliver)\b/.test(S) && !/order_insert_financial_event/i.test(S));
assert('no helper functions beyond the two RPCs', (S.match(/CREATE OR REPLACE FUNCTION/gi) || []).length === 2);
assert('no table/schema/RLS/index/constraint change', !/CREATE TABLE|ALTER TABLE|ADD COLUMN|DROP COLUMN|CREATE INDEX|CREATE UNIQUE INDEX|ROW LEVEL SECURITY|CREATE POLICY|ADD CONSTRAINT|auth_audit_event_chk/i.test(S));
assert('test executes no DB', (() => { const self = read('tests/b7PaymentBasisRpcsMigration.test.js'); return !/require\(['"](pg|postgres|@supabase)/.test(self) && !/\.query\(/.test(self); })());

// ── security (both) ──────────────────────────────────────────────────────────
assert('both SECURITY INVOKER', (S.match(/SECURITY INVOKER/g) || []).length === 2 && !/SECURITY DEFINER/i.test(S));
assert('both pin search_path', (S.match(/SET search_path = public, pg_temp/g) || []).length === 2);
assert('no dynamic SQL', !/\bEXECUTE\s+format\b/i.test(S) && !/\bEXECUTE\s+'/.test(S));
assert('grants: revoke from PUBLIC/anon/authenticated (both)', (S.match(/REVOKE ALL ON FUNCTION[\s\S]*?FROM PUBLIC, anon, authenticated/g) || []).length === 2);
assert('grants: EXECUTE to service_role only (both)', (S.match(/GRANT EXECUTE ON FUNCTION[\s\S]*?TO service_role/g) || []).length === 2);
assert('no broad EXECUTE grant to PUBLIC/anon/authenticated', !/GRANT EXECUTE[\s\S]*?TO (PUBLIC|anon|authenticated)\b/i.test(S));
assert('no ledger UPDATE privilege granted to service_role', noLedgerUpdateGrantToServiceRole(S));
assert('digest uses native pg sha256 (no md5, no caller digest)',
  /encode\(sha256\(convert_to\(v_canon::text, 'UTF8'\)\), 'hex'\)/.test(S) && !/\bmd5\b/i.test(S));

// per-function common invariants
BODIES.forEach((b, i) => {
  const nm = i === 0 ? 'order_mark_paid' : 'order_import_legacy_payment';
  assert(`[${nm}] locks initiator FOR UPDATE`, /auth_actors WHERE actor = p_by_actor FOR UPDATE/.test(b));
  assert(`[${nm}] initiator must exist + be active`, /AUTH_ACTOR_NOT_FOUND/.test(b) && /v_by\.active <> true[\s\S]*?AUTH_INITIATOR_INACTIVE/.test(b));
  assert(`[${nm}] role derived from DB (v_by.role), not caller`, /v_role := v_by\.role/.test(b) && !/p_by_role/.test(b));
  assert(`[${nm}] locks order FOR UPDATE`, /ordenes WHERE id = p_order_id FOR UPDATE/.test(b));
  assert(`[${nm}] first ledger read occurs after order lock`, firstLedgerReadAfterOrderLock(b));
  assert(`[${nm}] ledger SELECTs use no row-locking clause`, noLedgerRowLocks(b));
  assert(`[${nm}] IP hash required + max length`, /p_ip_hash IS NULL OR btrim\(p_ip_hash\) = ''[\s\S]*?AUTH_IP_HASH_REQUIRED/.test(b) && /length\(p_ip_hash\) > 64/.test(b));
  assert(`[${nm}] metadata object/size/sensitive guard`, /jsonb_typeof\(v_meta\) <> 'object'/.test(b) && /length\(v_meta::text\) > 2048/.test(b) && /AUTH_META_SENSITIVE_KEY/.test(b) && /'raw_ip'/.test(b) && /'confirmation'/.test(b));
  assert(`[${nm}] idem key length + regex`, /char_length\(p_idem_scope_key\) < 8 OR char_length\(p_idem_scope_key\) > 128[\s\S]*?\^\[A-Za-z0-9_-\]\+\$/.test(b));
  assert(`[${nm}] canonical method normalized (lower+btrim) + exact set`, /v_method := lower\(btrim\(COALESCE\(p_payment_method, ''\)\)\)/.test(b) && /v_method NOT IN \('efectivo','tarjeta','bizum'\)/.test(b));
  // canonical digest includes reason; excludes ip_hash/meta/created_at
  assert(`[${nm}] digest jsonb includes reason`, /'reason', v_reason/.test(b.slice(b.indexOf('v_canon := jsonb_build_object'), b.indexOf('v_digest :='))));
  assert(`[${nm}] digest jsonb excludes ip_hash/meta/created_at`, (() => { const c = b.slice(b.indexOf('v_canon := jsonb_build_object'), b.indexOf('v_digest :=')); return !/ip_hash|'meta'|created_at/i.test(c); })());
  assert(`[${nm}] caller supplies no digest/pay-state/estado snapshots`, !/p_digest|p_prev_pay_state|p_new_pay_state|p_prev_estado|p_new_estado/.test(b));
  // idempotency check before generic basis rejection
  assert(`[${nm}] same-scope idempotency precedes AUTH_BASIS_EXISTS`,
    b.indexOf('idem_scope_key = p_idem_scope_key;') < b.indexOf('AUTH_BASIS_EXISTS') &&
    /payload_digest = v_digest[\s\S]*?'idempotent', true/.test(b) &&
    /AUTH_IDEMPOTENCY_CONFLICT/.test(b));
  assert(`[${nm}] one basis per order (payment OR payment_imported)`, /type IN \('payment','payment_imported'\)[\s\S]*?AUTH_BASIS_EXISTS/.test(b));
  assert(`[${nm}] generic basis rejection is a plain ledger SELECT`,
    /SELECT \* INTO v_existing_basis FROM public\.order_financial_events[\s\S]*?type IN \('payment','payment_imported'\)[\s\S]*?LIMIT 1;[\s\S]*?IF FOUND THEN[\s\S]*?AUTH_BASIS_EXISTS/.test(b));
  // atomic: insert event + update order mirrors in same fn
  assert(`[${nm}] inserts event then mirrors order flags (one fn)`,
    /INSERT INTO public\.order_financial_events/.test(b) &&
    /UPDATE public\.ordenes SET ya_pagado = true, cobrado = true, metodo_pago = v_method/.test(b) &&
    b.indexOf('INSERT INTO public.order_financial_events') < b.indexOf('UPDATE public.ordenes'));
  assert(`[${nm}] order UPDATE preserves estado/refunded/manual_giro_id (not in SET)`,
    !/SET[\s\S]*?(estado|refunded|manual_giro_id)/.test(b.slice(b.indexOf('UPDATE public.ordenes SET'), b.indexOf('WHERE id = p_order_id;'))));
  assert(`[${nm}] snapshots prev/new pay-state unpaid→paid + original_giro NULL`, /'unpaid', 'paid', NULL/.test(b));
  // sanitized return: no digest/ip/meta/reason
  assert(`[${nm}] sanitized return (event_id..created_at)`, /RETURN jsonb_build_object\('event_id'/.test(b) && /'idempotent'/.test(b));
  assert(`[${nm}] return omits digest/ip_hash/meta/reason`, (() => { const rets = b.match(/RETURN jsonb_build_object\([\s\S]*?\);/g) || []; return rets.every((r) => !/payload_digest|ip_hash|'meta'|'reason'|'confirm/i.test(r)); })());
});

// ── mark_paid specifics ──────────────────────────────────────────────────────
assert('mark_paid: amount from locked ordenes.totale', /v_amount := round\(v_ord\.totale, 2\)/.test(MP));
assert('mark_paid: no caller amount parameter', !/p_amount/.test(MP));
assert('mark_paid: rejects zero/neg amount', /v_amount IS NULL OR v_amount <= 0[\s\S]*?AUTH_AMOUNT_INVALID/.test(MP));
assert('mark_paid: legacy-paid flags force import path', /v_ord\.ya_pagado IS TRUE OR v_ord\.cobrado IS TRUE[\s\S]*?AUTH_LEGACY_IMPORT_REQUIRED/.test(MP));
assert('mark_paid: role admin OR operator (rider denied)', /v_role NOT IN \('admin','operator'\)[\s\S]*?AUTH_FORBIDDEN_ROLE/.test(MP));
assert('mark_paid: reason optional (blank rejected only)', /p_reason IS NOT NULL AND btrim\(p_reason\) = ''[\s\S]*?AUTH_REASON_BLANK/.test(MP));
assert('mark_paid: event type payment + legacy false', /VALUES \(p_order_id, 'payment', v_amount, v_method, v_reason, false,/.test(MP));

// ── legacy import specifics ──────────────────────────────────────────────────
assert('import: admin only', /v_role <> 'admin'[\s\S]*?AUTH_FORBIDDEN_ROLE/.test(LI));
assert('import: exact confirmation IMPORT_LEGACY_PAYMENT (no normalization)', /p_confirm IS DISTINCT FROM 'IMPORT_LEGACY_PAYMENT'[\s\S]*?AUTH_CONFIRMATION_REQUIRED/.test(LI));
assert('import: confirmation never stored/returned', !/p_confirm/.test(LI.slice(LI.indexOf('INSERT INTO'))) && (LI.match(/IMPORT_LEGACY_PAYMENT/g) || []).length === 1);
assert('import: explicit amount rounded 10,2 + > 0', /v_amount := round\(p_amount, 2\)/.test(LI) && /v_amount IS NULL OR v_amount <= 0[\s\S]*?AUTH_AMOUNT_INVALID/.test(LI));
assert('import: reason mandatory non-blank', /p_reason IS NULL OR btrim\(p_reason\) = ''[\s\S]*?AUTH_REASON_BLANK/.test(LI));
assert('import: requires legacy paid evidence', /NOT \(v_ord\.ya_pagado IS TRUE OR v_ord\.cobrado IS TRUE\)[\s\S]*?AUTH_NOT_LEGACY_PAID/.test(LI));
assert('import: event type payment_imported + legacy true', /VALUES \(p_order_id, 'payment_imported', v_amount, v_method, v_reason, true,/.test(LI));

// ── rollback: only drops the two RPCs; refuses on basis; no mutation ─────────
assert('rollback drops exactly the two B7A2A RPCs', (R.match(/DROP FUNCTION IF EXISTS public\.order_(mark_paid|import_legacy_payment)/g) || []).length === 2);
assert('rollback no other DROP FUNCTION', (R.match(/DROP FUNCTION/g) || []).length === 2);
assert('rollback refuses when basis events exist', /ROLLBACK REFUSED/.test(R) && /type IN \('payment','payment_imported'\)/.test(R));
assert('rollback never deletes/mutates data or drops ledger', !/DELETE FROM|UPDATE public\.|DROP TABLE|ALTER TABLE|TRUNCATE/i.test(R));
assert('rollback does not touch B7A1 grant hardening / auth objects', !/GRANT|REVOKE|auth_audit|auth_actors/i.test(R));

// ── doc references actual filenames ──────────────────────────────────────────
const DOC = read('docs/access-control/B7A2_PAYMENT_BASIS_CONTRACT.md');
assert('doc references forward + rollback filenames', DOC.includes('migrations/' + FWD) && DOC.includes('migrations/' + RB));

// ── NEGATIVE CONTROLS ────────────────────────────────────────────────────────
(function nc() {
  // NC1: caller p_digest present
  const withDigest = MP.replace('p_idem_scope_key text)', 'p_idem_scope_key text, p_digest text)');
  assert('NC1: detector catches a caller p_digest parameter', /p_digest/.test(withDigest));
  // NC2: reason omitted from digest jsonb
  const noReason = MP.replace(/'reason', v_reason,\n\s*/, '');
  const canonNC2 = noReason.slice(noReason.indexOf('v_canon := jsonb_build_object'), noReason.indexOf('v_digest :='));
  assert('NC2: detector catches reason missing from digest', !/'reason', v_reason/.test(canonNC2));
  // NC3: mark_paid gains a caller amount
  const mpAmount = MP.replace('p_payment_method text,', 'p_payment_method text, p_amount numeric,');
  assert('NC3: detector catches a mark_paid caller amount', /p_amount/.test(mpAmount));
  // NC4: import allowed without legacy flag (guard removed)
  const noLegacy = LI.replace(/IF NOT \(v_ord\.ya_pagado IS TRUE OR v_ord\.cobrado IS TRUE\)[\s\S]*?AUTH_NOT_LEGACY_PAID[\s\S]*?END IF;/, '');
  assert('NC4: detector catches import missing the legacy-flag guard', !/AUTH_NOT_LEGACY_PAID/.test(noLegacy));
  // NC5: rider allowed on mark_paid
  const riderOk = MP.replace("v_role NOT IN ('admin','operator')", "v_role NOT IN ('admin','operator','rider')");
  assert('NC5: detector catches rider being allowed', /v_role NOT IN \('admin','operator','rider'\)/.test(riderOk));
  // NC6: ledger row lock added to basis lookup
  const basisLocked = MP.replace('ORDER BY created_at ASC LIMIT 1;', 'ORDER BY created_at ASC LIMIT 1 FOR UPDATE;');
  assert('NC6: detector catches FOR UPDATE added to a basis lookup', !noLedgerRowLocks(basisLocked));
  // NC7: ledger row lock added to scoped-event lookup
  const scopedLocked = MP.replace('idem_scope_key = p_idem_scope_key;', 'idem_scope_key = p_idem_scope_key FOR UPDATE;');
  assert('NC7: detector catches FOR UPDATE added to a scoped-event lookup', !noLedgerRowLocks(scopedLocked));
  // NC8: weaker-looking ledger row lock added
  assert('NC8: detector catches FOR SHARE added to a ledger lookup', !noLedgerRowLocks(MP.replace('idem_scope_key = p_idem_scope_key;', 'idem_scope_key = p_idem_scope_key FOR SHARE;')));
  // NC9: key-share ledger row lock added
  assert('NC9: detector catches FOR KEY SHARE added to a ledger lookup', !noLedgerRowLocks(MP.replace('ORDER BY created_at ASC LIMIT 1;', 'ORDER BY created_at ASC LIMIT 1 FOR KEY SHARE;')));
  // NC10: order lock removed
  assert('NC10: detector catches removed order lock', !/ordenes WHERE id = p_order_id FOR UPDATE/.test(MP.replace(' WHERE id = p_order_id FOR UPDATE', ' WHERE id = p_order_id')));
  // NC11: first ledger read moved before order lock
  const ledgerMovedEarly = MP.replace('SELECT * INTO v_ord FROM public.ordenes WHERE id = p_order_id FOR UPDATE;', 'SELECT 1 FROM public.order_financial_events WHERE order_id = p_order_id;\n  SELECT * INTO v_ord FROM public.ordenes WHERE id = p_order_id FOR UPDATE;');
  assert('NC11: detector catches first ledger read before order lock', !firstLedgerReadAfterOrderLock(ledgerMovedEarly));
  // NC12: service_role UPDATE grant
  assert('NC12: detector catches UPDATE granted to service_role', !noLedgerUpdateGrantToServiceRole(S + '\nGRANT UPDATE ON public.order_financial_events TO service_role;'));
  // NC13: idempotency check placed AFTER basis rejection
  const swapped = 'AUTH_BASIS_EXISTS then later idem_scope_key = p_idem_scope_key;';
  assert('NC13: detector catches idempotency-after-basis ordering', swapped.indexOf('AUTH_BASIS_EXISTS') < swapped.indexOf('idem_scope_key = p_idem_scope_key;'));
  // NC14: generic arbitrary event helper
  const withGeneric = S + '\nCREATE OR REPLACE FUNCTION public.order_insert_financial_event(p_type text) RETURNS void LANGUAGE sql AS $$ $$;';
  assert('NC14: detector catches a generic event helper', /order_insert_financial_event/i.test(withGeneric));
  // NC15: rollback deleting evidence
  const rbDelete = R + '\nDELETE FROM public.order_financial_events;';
  assert('NC15: detector catches rollback deleting evidence', /DELETE FROM|UPDATE public\.|DROP TABLE|ALTER TABLE|TRUNCATE/i.test(rbDelete));
})();

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
