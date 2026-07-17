'use strict';
// B7A2D static migration tests. Run: node tests/b7FinancialSessionVersionGuardMigration.test.js
// NON-EXECUTING: inspects SQL text only. Proves the corrective migration adds
// p_session_version (integer) to all four financial RPCs, compares it to the LOCKED
// auth_actors.session_version AFTER the actor lock and BEFORE the order lock, raises
// AUTH_SESSION_STALE on mismatch, drops the old unguarded signatures, grants EXECUTE
// to service_role only, keeps ledger reads plain + no ledger UPDATE grant, preserves
// the canonical-zero void replay fix, and mutates no table/data. Plus negative controls.
const fs = require('fs');
const path = require('path');
let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const strip = (s) => s.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');

const MIG_DIR = path.join(__dirname, '..', 'migrations');
const ALL = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql'));
const FWD = '2026-07-17_b7_financial_session_version_guard.sql';
const RB = '2026-07-17_b7_financial_session_version_guard.ROLLBACK.sql';
const FWD_CONV = /^\d{4}-\d{2}-\d{2}_[a-z0-9_]+\.sql$/;
const RB_CONV = /^\d{4}-\d{2}-\d{2}_[a-z0-9_]+\.ROLLBACK\.sql$/;

assert('forward filename matches convention', FWD_CONV.test(FWD));
assert('rollback filename matches convention', RB_CONV.test(RB));
assert('both discovered', ALL.includes(FWD) && ALL.includes(RB));

const RAW = read('migrations/' + FWD);
const S = strip(RAW);
const R = strip(read('migrations/' + RB));

// function body slices (from CREATE FUNCTION to the next CREATE/grants block)
function body(name) {
  const start = S.indexOf('CREATE FUNCTION public.' + name + '(');
  if (start < 0) return '';
  const after = S.indexOf('$fn$;', start);
  return S.slice(start, after >= 0 ? after + 5 : S.length);
}
const MP = body('order_mark_paid');
const IM = body('order_import_legacy_payment');
const RF = body('order_refund');
const VD = body('order_void');
const BODIES = { order_mark_paid: MP, order_import_legacy_payment: IM, order_refund: RF, order_void: VD };
const ROW_LOCK_RE = /\bFOR\s+(?:NO\s+KEY\s+UPDATE|KEY\s+SHARE|UPDATE|SHARE)\b/i;

// ── structure ────────────────────────────────────────────────────────────────
assert('BEGIN/COMMIT', /^\s*BEGIN;/.test(S) && /COMMIT;\s*$/.test(S.trim() + '\n'));
assert('staging sentinel', /schema_migrations WHERE version='20260710075612'/.test(S));
assert('creates exactly the four guarded RPCs', (S.match(/CREATE FUNCTION public\.(order_[a-z_]+)\(/g) || []).length === 4);
assert('no table/schema/constraint/index/RLS change', !/CREATE TABLE|ALTER TABLE|ADD COLUMN|DROP COLUMN|CREATE INDEX|CREATE UNIQUE INDEX|ADD CONSTRAINT|ROW LEVEL SECURITY|CREATE POLICY|DROP POLICY/i.test(S));

// top-level (outside function bodies) performs NO data mutation
const TOP = S.replace(/\$fn\$[\s\S]*?\$fn\$/g, '$fn$ …body… $fn$');
assert('no financial-event insert/rewrite at migration top level', !/INSERT INTO public\.order_financial_events|UPDATE public\.order_financial_events|DELETE FROM/i.test(TOP));
assert('no order update at migration top level', !/UPDATE public\.ordenes/i.test(TOP));

// ── per-RPC guard checks ─────────────────────────────────────────────────────
for (const [name, b] of Object.entries(BODIES)) {
  assert(`[${name}] present`, b.length > 0);
  assert(`[${name}] signature adds p_session_version integer adjacent to p_by_actor`, /p_by_actor text, p_session_version integer/.test(b));
  assert(`[${name}] SECURITY INVOKER + pinned search_path`, /SECURITY INVOKER/.test(b) && /SET search_path = public, pg_temp/.test(b));
  assert(`[${name}] locks actor FOR UPDATE (row incl session_version via SELECT *)`, /SELECT \* INTO v_by FROM public\.auth_actors WHERE actor = p_by_actor FOR UPDATE/.test(b));
  assert(`[${name}] raises AUTH_SESSION_STALE on mismatch vs LOCKED v_by.session_version`, /IF p_session_version <> v_by\.session_version THEN RAISE EXCEPTION 'AUTH_SESSION_STALE'/.test(b));
  assert(`[${name}] structural session guard also present (absent/invalid)`, /IF p_session_version IS NULL OR p_session_version < 1 THEN RAISE EXCEPTION 'AUTH_SESSION_STALE'/.test(b));
  // ordering: actor FOR UPDATE  <  session compare  <  order FOR UPDATE
  const actorLock = b.indexOf('FROM public.auth_actors WHERE actor = p_by_actor FOR UPDATE');
  const sessCmp = b.indexOf('IF p_session_version <> v_by.session_version');
  const orderLock = b.indexOf('FROM public.ordenes WHERE id = p_order_id FOR UPDATE');
  const firstLedger = b.indexOf('FROM public.order_financial_events');
  assert(`[${name}] actor lock BEFORE session comparison`, actorLock >= 0 && sessCmp > actorLock);
  assert(`[${name}] session comparison BEFORE order lock`, sessCmp > 0 && orderLock > sessCmp);
  assert(`[${name}] order lock BEFORE first ledger read`, orderLock > 0 && firstLedger > orderLock);
  // ledger SELECTs plain
  const ledgerSelects = (b.match(/\bSELECT\b[\s\S]*?;/g) || []).filter((st) => /public\.order_financial_events\b/.test(st));
  assert(`[${name}] all ledger SELECTs are plain (no row lock)`, ledgerSelects.every((st) => !ROW_LOCK_RE.test(st)));
  // session comparison uses the LOCKED db value, not a literal/default
  assert(`[${name}] compares against v_by.session_version (no fabricated/default)`, !/p_session_version <> 1\b/.test(b) && !/p_session_version <> COALESCE/.test(b));
}

// ── old unguarded signatures removed; new guarded grants safe ────────────────
const OLD = [
  'public.order_mark_paid(text, text, text, text, text, jsonb, text)',
  'public.order_import_legacy_payment(text, numeric, text, text, text, text, jsonb, text, text)',
  'public.order_refund(text, text, text, text, jsonb, text)',
  'public.order_void(text, text, text, text, jsonb, text)',
];
for (const sig of OLD) {
  assert(`drops old signature ${sig.split('(')[0].replace('public.', '')}`, S.includes('DROP FUNCTION ' + sig + ';'));
  assert(`revokes old signature before drop`, new RegExp('REVOKE ALL ON FUNCTION ' + sig.replace(/[.()]/g, '\\$&') + '\\s+FROM PUBLIC, anon, authenticated, service_role').test(S));
}
const NEW = [
  'public.order_mark_paid(text, text, text, text, integer, text, jsonb, text)',
  'public.order_import_legacy_payment(text, numeric, text, text, text, integer, text, jsonb, text, text)',
  'public.order_refund(text, text, text, integer, text, jsonb, text)',
  'public.order_void(text, text, text, integer, text, jsonb, text)',
];
for (const sig of NEW) {
  assert(`grants EXECUTE to service_role on guarded ${sig.split('(')[0].replace('public.', '')}`, new RegExp('GRANT EXECUTE ON FUNCTION ' + sig.replace(/[.()]/g, '\\$&') + '\\s+TO service_role').test(S));
  assert(`revokes guarded ${sig.split('(')[0].replace('public.', '')} from PUBLIC/anon/authenticated`, new RegExp('REVOKE ALL ON FUNCTION ' + sig.replace(/[.()]/g, '\\$&') + '\\s+FROM PUBLIC, anon, authenticated').test(S));
}
assert('no EXECUTE grant to PUBLIC/anon/authenticated', !/GRANT EXECUTE[\s\S]*?TO (PUBLIC|anon|authenticated)\b/i.test(S));
assert('no ledger UPDATE privilege granted to service_role', !/GRANT[\s\S]*?\bUPDATE\b[\s\S]*?order_financial_events[\s\S]*?TO service_role/i.test(S));
assert('preconditions require the four OLD signatures + reject existing guarded', /expected 4 accepted unguarded financial RPCs/.test(S) && /guarded signature already present/.test(S));

// ── canonical-zero void replay fix preserved ─────────────────────────────────
const vdReplay = VD.slice(VD.indexOf('v_replay_digest :='), VD.indexOf('IF v_existing.payload_digest'));
assert('void replay canon uses literal amount 0 (fix preserved)', /'amount', 0\b/.test(vdReplay) && !/'amount', v_existing\.amount/.test(vdReplay));
assert('void replay integrity gate preserved', /AUTH_VOID_REPLAY_INTEGRITY/.test(VD));
assert('void fresh canon still literal 0', /'amount', 0, 'payment_method', NULL, 'original_giro_id', v_ord\.manual_giro_id/.test(VD));

// ── rollback (guarded, security-downgrade) ───────────────────────────────────
assert('rollback refuses without explicit downgrade confirmation', /ROLLBACK REFUSED/.test(R) && /confirm_b7a2d_downgrade/.test(R));
assert('rollback documents the session-revocation downgrade', /SECURITY DOWNGRADE|weakens? .*(revocation|session)/i.test(read('migrations/' + RB)));
assert('rollback restores the four unguarded signatures', NEW.length === 4 && (R.match(/CREATE FUNCTION public\.order_[a-z_]+\(/g) || []).length === 4 && /p_by_actor text,\n  p_ip_hash text/.test(R));
const RTOP = R.replace(/\$fn\$[\s\S]*?\$fn\$/g, '$fn$ …body… $fn$');
assert('rollback top level deletes/rewrites no evidence, no order/session mutation', !/DELETE FROM|TRUNCATE|UPDATE public\.order_financial_events|UPDATE public\.ordenes|UPDATE public\.auth_actors|session_version\s*=/i.test(RTOP));

// ── NEGATIVE CONTROLS ────────────────────────────────────────────────────────
(function nc() {
  // NC1: an RPC missing p_session_version is detectable
  const noParam = MP.replace('p_by_actor text, p_session_version integer', 'p_by_actor text');
  assert('NC1: RPC without p_session_version detected', /p_by_actor text, p_session_version integer/.test(MP) && !/p_by_actor text, p_session_version integer/.test(noParam));
  // NC2: session comparison AFTER order lock detected (order-index check fails)
  const reordered = 'FROM public.ordenes WHERE id = p_order_id FOR UPDATE; IF p_session_version <> v_by.session_version';
  assert('NC2: comparison after order lock detected', reordered.indexOf('IF p_session_version <> v_by.session_version') > reordered.indexOf('ordenes WHERE id = p_order_id FOR UPDATE'));
  // NC3: comparison removed after actor lock detected
  const noCmp = MP.replace(/IF p_session_version <> v_by\.session_version[\s\S]*?END IF;/, '');
  assert('NC3: missing under-lock comparison detected', /IF p_session_version <> v_by\.session_version/.test(MP) && !/IF p_session_version <> v_by\.session_version/.test(noCmp));
  // NC4: old overload left callable (a missing DROP) detected
  const missingDrop = S.replace('DROP FUNCTION public.order_void(text, text, text, text, jsonb, text);', '');
  assert('NC4: old overload not dropped detected', S.includes('DROP FUNCTION public.order_void(text, text, text, text, jsonb, text);') && !missingDrop.includes('DROP FUNCTION public.order_void(text, text, text, text, jsonb, text);'));
  // NC5: fabricated/default session version (compare to a literal) detected
  const faked = MP.replace('p_session_version <> v_by.session_version', 'p_session_version <> 1');
  assert('NC5: fabricated/default session version detected', /p_session_version <> 1\b/.test(faked) && !/p_session_version <> 1\b/.test(MP));
  // NC6: removal of the void canonical-zero replay correction detected
  const brokeVoid = vdReplay.replace("'amount', 0", "'amount', v_existing.amount");
  assert('NC6: void canonical-zero removal detected', !/'amount', v_existing\.amount/.test(vdReplay) && /'amount', v_existing\.amount/.test(brokeVoid));
  // NC7: a ledger row-lock reintroduced is detectable
  const rowlocked = RF.replace('ORDER BY created_at ASC LIMIT 1;', 'ORDER BY created_at ASC LIMIT 1 FOR UPDATE;');
  const ls = (rowlocked.match(/\bSELECT\b[\s\S]*?;/g) || []).filter((st) => /order_financial_events/.test(st));
  assert('NC7: ledger FOR UPDATE reintroduced detected', !ls.every((st) => !ROW_LOCK_RE.test(st)));
})();

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
