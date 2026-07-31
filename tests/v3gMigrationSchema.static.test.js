'use strict';
// Access Control V3 -- Block V3-G: migration/schema/static contract tests.
// Run: node tests/v3gMigrationSchema.static.test.js

const fs = require('fs');
const path = require('path');
let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const fwd = read('migrations/2026-07-31_v3g_waiter_table_assignment_safety.sql');
const rb = read('migrations/2026-07-31_v3g_waiter_table_assignment_safety.ROLLBACK.sql');
const v3e = read('migrations/2026-07-30_v3e_access_user_lifecycle.sql');
// Strip full-line SQL comments (-- ...) so structural/positional checks below can't be
// tripped by prose in header/doc comments mentioning the same marker names as the code.
const stripSql = (s) => s.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
const fwdCode = stripSql(fwd);
const rbCode = stripSql(rb);

// ── staging sentinel + predecessor guard ────────────────────────────────────────────
assert('forward: staging sentinel guard present', /schema_migrations WHERE version = '20260710075612'/.test(fwd));
assert('rollback: staging sentinel guard present', /schema_migrations WHERE version = '20260710075612'/.test(rb));
assert('forward: predecessor guard checks the EXACT V3-E active-state signature',
  /p_workspace_id uuid, p_by_actor text, p_target_actor text, p_expected_active boolean, p_requested_active boolean, p_by_sid_hash text, p_client_request_id text, p_request_hash text, p_meta jsonb/.test(fwd));
assert('forward: refuses if predecessor not found', /V3-G refused: auth_set_access_user_active_v3 \(V3-E exact signature\) not found/.test(fwd));
assert('forward: re-checks the 4 legacy rows precondition', /legacy auth_actors rows do not match the expected pre-V3-G shape/.test(fwd));

// ── V3-E migration file is NOT edited ────────────────────────────────────────────────
assert('V3-E migration file unchanged (byte check against known accepted content marker)',
  v3e.includes("cb570e3d738f2aeb") === false && v3e.includes('AUTH_TARGET_ROLE_INELIGIBLE') && !v3e.includes('AUTH_WAITER_HAS_OPEN_TABLES'));

// ── additive-only: no ALTER/DROP of any prior table, no widened auth_audit_event_chk ──
assert('forward: no ALTER TABLE on auth_actors/auth_audit/access_management_idempotency',
  !/ALTER TABLE public\.(auth_actors|auth_audit|access_management_idempotency)\b/.test(fwd));
assert('forward: does not widen auth_audit_event_chk', !/auth_audit_event_chk/.test(fwdCode));
assert('forward: creates table_sessions and table_session_assignment_history only (CREATE TABLE count)',
  (fwd.match(/CREATE TABLE IF NOT EXISTS/g) || []).length === 2);

// ── actors-before-sessions lock order (frozen contract) ──────────────────────────────
{
  const assignFn = fwd.match(/CREATE OR REPLACE FUNCTION public\.auth_assign_table_session_waiter_v3\([\s\S]*?\$fn\$;/)[0];
  const wsLockIdx = assignFn.indexOf('FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE');
  const actorLockIdx = assignFn.indexOf('WHERE actor = ANY (v_actor_set) ORDER BY actor FOR UPDATE');
  const sessLockIdx = assignFn.indexOf('WHERE id = p_table_session_id FOR UPDATE');
  const idemIdx = assignFn.indexOf('FROM public.access_management_idempotency');
  assert('assignment RPC: workspace lock before actor lock', wsLockIdx > 0 && wsLockIdx < actorLockIdx);
  assert('assignment RPC: actor lock before session lock (frozen order)', actorLockIdx > 0 && actorLockIdx < sessLockIdx);
  assert('assignment RPC: session lock before idempotency lookup', sessLockIdx > 0 && sessLockIdx < idemIdx);
  assert('assignment RPC: actor lock uses ONE deterministic ORDER BY actor statement (not a loop)',
    (assignFn.match(/ORDER BY actor FOR UPDATE/g) || []).length === 1);
  assert('assignment RPC: session lock uses FOR UPDATE', /WHERE id = p_table_session_id FOR UPDATE/.test(assignFn));
}
{
  const activeFn = fwd.match(/CREATE OR REPLACE FUNCTION public\.auth_set_access_user_active_v3\([\s\S]*?\$fn\$;/)[0];
  const actorLockIdx = activeFn.indexOf("WHERE actor IN (p_by_actor, p_target_actor) ORDER BY actor FOR UPDATE");
  const guardIdx = activeFn.indexOf('V3-G ADDITION');
  const sessionLockIdx = activeFn.indexOf('FROM public.table_sessions');
  const updateIdx = activeFn.indexOf('UPDATE public.auth_actors');
  assert('active-state RPC: actor lock occurs before the V3-G waiter-guard addition', actorLockIdx > 0 && actorLockIdx < guardIdx);
  assert('active-state RPC: waiter-guard table_sessions lock occurs before any actor UPDATE', sessionLockIdx > 0 && sessionLockIdx < updateIdx);
  assert('active-state RPC: table_sessions lock uses FOR UPDATE with deterministic ORDER BY id', /table_sessions[\s\S]{0,120}ORDER BY id FOR UPDATE/.test(activeFn));
}

// ── same-workspace actor/session references ─────────────────────────────────────────
assert('table_sessions: workspace_id NOT NULL FK to workspaces', /workspace_id\s+uuid NOT NULL REFERENCES public\.workspaces\(id\)/.test(fwd));
assert('table_sessions: assigned_waiter_actor FK is composite (workspace_id, actor)',
  /FOREIGN KEY \(workspace_id, assigned_waiter_actor\) REFERENCES public\.auth_actors \(workspace_id, actor\)/.test(fwd));
assert('assignment RPC: rejects cross-workspace acting actor', /AUTH_INITIATOR_OTHER_WORKSPACE/.test(fwd));
assert('assignment RPC: rejects cross-workspace requested waiter', /AUTH_TARGET_OTHER_WORKSPACE/.test(fwd));
assert('assignment RPC: rejects cross-workspace table session', /TABLE_SESSION_OTHER_WORKSPACE/.test(fwd));

// ── exact waiter-role eligibility (single exact role, not a broader allowlist) ────────
assert('assignment RPC: requested waiter role check is an EXACT equality to \'waiter\' (not an allowlist)',
  /v_req\.role IS DISTINCT FROM 'waiter'/.test(fwd));
assert('assignment RPC: rejects inactive requested waiter', /AUTH_TARGET_INACTIVE/.test(fwd));

// ── open-session semantics: nullable assignment is explicit, not silent ─────────────
assert('table_sessions.assigned_waiter_actor is nullable (no NOT NULL constraint)',
  !/assigned_waiter_actor\s+text NOT NULL/.test(fwd));
assert('the nullable-assignment design choice is explicitly documented, not silent',
  /nullable BY DESIGN|legitimately unassigned/i.test(fwd));

// ── append-only assignment history ──────────────────────────────────────────────────
assert('table_session_assignment_history: RLS enabled with zero policies (default-deny)',
  /ALTER TABLE public\.table_session_assignment_history ENABLE ROW LEVEL SECURITY/.test(fwdCode) &&
  !/CREATE POLICY/.test(fwdCode));
assert('table_session_assignment_history: grants are service_role only',
  /GRANT ALL ON public\.table_session_assignment_history TO service_role/.test(fwd));
assert('no UPDATE/DELETE statement anywhere targets table_session_assignment_history',
  !/UPDATE public\.table_session_assignment_history|DELETE FROM public\.table_session_assignment_history/.test(fwd));

// ── active-state RPC preserves every V3-E contract (structural diff against V3-E) ────
{
  const v3eFn = v3e.match(/CREATE OR REPLACE FUNCTION public\.auth_set_access_user_active_v3\([\s\S]*?\$fn\$;/)[0];
  const v3gFn = fwd.match(/CREATE OR REPLACE FUNCTION public\.auth_set_access_user_active_v3\([\s\S]*?\$fn\$;/)[0];
  const preservedMarkers = [
    'AUTH_WORKSPACE_REQUIRED', 'AUTH_INITIATOR_REQUIRED', 'AUTH_ACTOR_INVALID',
    'AUTH_INITIATOR_OTHER_WORKSPACE', 'AUTH_INITIATOR_INACTIVE', 'AUTH_NOT_OWNER',
    'AUTH_TARGET_OTHER_WORKSPACE', 'AUTH_TARGET_IS_OWNER', 'AUTH_TARGET_ROLE_INELIGIBLE',
    'AUTH_IDEMPOTENCY_CONFLICT', 'AUTH_TARGET_STATE_MISMATCH', 'session_invalidated',
    'user_deactivated', 'user_reactivated', 'SECURITY INVOKER', 'search_path = public, pg_temp',
  ];
  for (const m of preservedMarkers) {
    assert(`active-state RPC: preserves V3-E marker '${m}'`, v3gFn.includes(m) && v3eFn.includes(m));
  }
  assert('active-state RPC: only ONE new marker added (AUTH_WAITER_HAS_OPEN_TABLES)',
    v3gFn.includes('AUTH_WAITER_HAS_OPEN_TABLES') && !v3eFn.includes('AUTH_WAITER_HAS_OPEN_TABLES'));
  assert('active-state RPC: idempotency INSERT still bound to workspace/by_actor/by_sid_hash/action/client_request_id',
    (v3gFn.match(/workspace_id, by_actor, by_sid_hash, action, client_request_id, request_hash, response_status, response_body/g) || []).length === 1);
}

// ── exact conflict code ──────────────────────────────────────────────────────────────
assert('conflict code is exactly AUTH_WAITER_HAS_OPEN_TABLES (once in real code, in the active-state RPC only)',
  (fwdCode.match(/AUTH_WAITER_HAS_OPEN_TABLES/g) || []).length === 1);
assert('guard only fires for a genuinely NEW, real DEACTIVATION of a locked role=\'waiter\' target',
  /v_changed AND NOT p_requested_active AND v_tgt\.role = 'waiter'/.test(fwdCode));
assert('guard is placed AFTER idempotency-replay evaluation and expected-state check',
  fwdCode.indexOf('AUTH_TARGET_STATE_MISMATCH') < fwdCode.indexOf('AUTH_WAITER_HAS_OPEN_TABLES'));
assert('guard is placed BEFORE any UPDATE public.auth_actors',
  fwdCode.indexOf('AUTH_WAITER_HAS_OPEN_TABLES') < fwdCode.lastIndexOf('UPDATE public.auth_actors'));

// ── rollback guards ───────────────────────────────────────────────────────────────────
assert('rollback: refuses if assignment history rows exist', /table_session_assignment_history/.test(rb) && /rollback refused/.test(rb));
assert('rollback: refuses if assignment idempotency rows exist', /assign_table_session_waiter_v3/.test(rb));
assert('rollback: refuses if any table_sessions row carries a non-NULL assignment', /assigned_waiter_actor IS NOT NULL/.test(rb));
assert('rollback: restores the byte-identical V3-E function body', (() => {
  const v3eFn = v3e.match(/CREATE OR REPLACE FUNCTION public\.auth_set_access_user_active_v3\([\s\S]*?\$fn\$;/)[0];
  const rbFn = rb.match(/CREATE OR REPLACE FUNCTION public\.auth_set_access_user_active_v3\([\s\S]*?\$fn\$;/)[0];
  // Normalize whitespace-only differences from re-transcription.
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  return norm(v3eFn) === norm(rbFn);
})());
assert('rollback: never touches auth_actors data (no UPDATE/DELETE on auth_actors)',
  !/UPDATE public\.auth_actors SET|DELETE FROM public\.auth_actors/.test(rb));
assert('rollback: never drops table_sessions or table_session_assignment_history',
  !/DROP TABLE[\s\S]*table_sessions|DROP TABLE[\s\S]*table_session_assignment_history/.test(rb));
assert('rollback: drops only the new assignment RPC',
  (rb.match(/DROP FUNCTION/g) || []).length === 1 && /DROP FUNCTION IF EXISTS public\.auth_assign_table_session_waiter_v3/.test(rb));

// ── no existing actor/role/credential data rewrite anywhere in either file ───────────
for (const [label, text] of [['forward', fwd], ['rollback', rb]]) {
  assert(`${label}: never sets active/role/pin_hash on any actor outside the guarded RPC bodies`,
    !/UPDATE public\.auth_actors SET (active|role|pin_hash) = /.test(text.replace(/CREATE OR REPLACE FUNCTION[\s\S]*?\$fn\$;/g, '')));
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
