'use strict';

const fs = require('node:fs');
const path = require('node:path');

const forward = fs.readFileSync(path.join(__dirname, '../migrations/2026-08-02_v3i_mesa_covers_deferred.sql'), 'utf8');
const rollback = fs.readFileSync(path.join(__dirname, '../migrations/2026-08-02_v3i_mesa_covers_deferred.ROLLBACK.sql'), 'utf8');

let passed = 0;
let failed = 0;
function test(name, condition) {
  if (condition) { passed += 1; process.stdout.write(`  PASS  ${name}\n`); }
  else { failed += 1; process.stderr.write(`  FAIL  ${name}\n`); }
}

test('migration is staging-only and exact-predecessor guarded',
  /STAGING ONLY/.test(forward)
  && /20260710075612/.test(forward)
  && /messa_open_session_v1\(uuid,text,uuid,uuid,integer\)/.test(forward)
  && /messa_post_payment_v1\(uuid,text,text,uuid,text,text,text,text,numeric,integer,uuid\[\],jsonb\)/.test(forward)
  && /messa_open_reservation_v1\(uuid,text,uuid,integer,uuid\)/.test(forward));

test('covers_total becomes nullable and deferred, not removed',
  /ALTER TABLE public\.table_sessions ALTER COLUMN covers_total DROP NOT NULL/.test(forward)
  && /CHECK \(covers_total IS NULL OR covers_total BETWEEN 1 AND 99\)/.test(forward));

test('a monotonic guard forbids un-setting or shrinking covers once real',
  /CREATE OR REPLACE FUNCTION public\.messa_guard_covers_monotonic_v1/.test(forward)
  && /OLD\.covers_total IS NOT NULL AND \(\s*NEW\.covers_total IS NULL OR NEW\.covers_total < OLD\.covers_total\s*\)/.test(forward)
  && /MESSA_COVERS_IMMUTABLE/.test(forward)
  && /BEFORE UPDATE OF covers_total ON public\.table_sessions/.test(forward));

test('ordenes gets a range-checked ephemeral covers-input column',
  /ALTER TABLE public\.ordenes\s*\n\s*ADD COLUMN table_covers_total_input integer NULL\s*\n\s*CHECK \(table_covers_total_input IS NULL OR table_covers_total_input BETWEEN 1 AND 99\)/.test(forward));

test('the first comanda atomically requires and locks in covers, later ones are unaffected', (() => {
  const body = forward.match(/CREATE OR REPLACE FUNCTION public\.messa_prepare_table_order_v1\(\)[\s\S]*?\$fn\$;/)?.[0] || '';
  const requireIdx = body.indexOf('MESSA_COVERS_REQUIRED');
  const nullOutIdx = body.indexOf('NEW.table_covers_total_input := NULL;');
  const updateIdx = body.indexOf('SET covers_total = v_covers_total');
  return requireIdx >= 0 && nullOutIdx > requireIdx && updateIdx > nullOutIdx
    && /v_covers_total := v_session\.covers_total;/.test(body)
    && /IF v_covers_total IS NULL THEN/.test(body)
    && /next_command_number = next_command_number \+ 1/.test(body);
})());

test('no separate endpoint window: covers and command-number share one UPDATE statement', (() => {
  const body = forward.match(/CREATE OR REPLACE FUNCTION public\.messa_prepare_table_order_v1\(\)[\s\S]*?\$fn\$;/)?.[0] || '';
  const updates = body.match(/UPDATE public\.table_sessions/g) || [];
  return updates.length === 1;
})());

test('payment is refused while covers are still unset, checked right after the open-session guard', (() => {
  const body = forward.match(/CREATE OR REPLACE FUNCTION public\.messa_post_payment_v1[\s\S]*?\$fn\$;/)?.[0] || '';
  const openIdx = body.indexOf("IF v_session.status <> 'open' THEN RAISE EXCEPTION 'MESSA_SESSION_NOT_OPEN'");
  const coversIdx = body.indexOf('MESSA_COVERS_NOT_SET');
  const totalsIdx = body.indexOf('SELECT COALESCE(round(sum(l.net_amount)');
  return openIdx >= 0 && coversIdx > openIdx && coversIdx < totalsIdx
    && /IF v_session\.covers_total IS NULL THEN/.test(body);
})());

test('idempotent payment replay is still checked before the covers guard', (() => {
  const body = forward.match(/CREATE OR REPLACE FUNCTION public\.messa_post_payment_v1[\s\S]*?\$fn\$;/)?.[0] || '';
  return body.indexOf('idempotent', true) < body.indexOf('MESSA_COVERS_NOT_SET')
    && body.indexOf('FROM public.payment_transactions\n   WHERE workspace_id = p_workspace_id AND by_actor = p_by_actor') <
       body.indexOf('MESSA_COVERS_NOT_SET');
})());

test('open no longer requires covers, keeps the exact 5-argument signature',
  /CREATE OR REPLACE FUNCTION public\.messa_open_session_v1\(\s*p_workspace_id uuid,\s*p_by_actor text,\s*p_table_id uuid,\s*p_service_session_id uuid,\s*p_covers_total integer DEFAULT NULL\s*\)/.test(forward)
  && /p_covers_total IS NOT NULL AND p_covers_total NOT BETWEEN 1 AND 99/.test(forward)
  && !/p_covers_total IS NULL OR p_covers_total NOT BETWEEN 1 AND 99\s*\n\s*THEN RAISE EXCEPTION 'MESSA_INVALID_REQUEST'/.test(forward));

test('a true concurrent double-open maps the unique-index race to a clean domain error', (() => {
  const body = forward.match(/CREATE OR REPLACE FUNCTION public\.messa_open_session_v1[\s\S]*?\$fn\$;/)?.[0] || '';
  return /EXCEPTION WHEN unique_violation THEN\s*\n\s*RAISE EXCEPTION 'MESSA_TABLE_ACCOUNT_OPEN'/.test(body)
    && /INSERT INTO public\.table_sessions\(/.test(body);
})());

test('reservation seating keeps its real, immediately-known covers and is not touched by this migration',
  !/CREATE OR REPLACE FUNCTION public\.messa_open_reservation_v1/.test(forward));

test('an accidentally-opened empty Mesa can be released without any payment', (() => {
  const body = forward.match(/CREATE OR REPLACE FUNCTION public\.messa_release_empty_session_v1[\s\S]*?\$fn\$;/)?.[0] || '';
  return body.length > 0
    && /IF v_session\.covers_total IS NOT NULL THEN\s*\n\s*RAISE EXCEPTION 'MESSA_TABLE_HAS_ORDERS'/.test(body)
    && /status = 'closed', settled_at = v_now, closed_at = v_now/.test(body)
    && !/payment_transactions/.test(body);
})());

test('new function grants are backend/service-role only',
  /REVOKE ALL ON FUNCTION public\.messa_guard_covers_monotonic_v1\(\) FROM PUBLIC, anon, authenticated/.test(forward)
  && /GRANT EXECUTE ON FUNCTION public\.messa_guard_covers_monotonic_v1\(\) TO service_role/.test(forward)
  && /REVOKE ALL ON FUNCTION public\.messa_release_empty_session_v1\(uuid,text,uuid\) FROM PUBLIC, anon, authenticated/.test(forward)
  && /GRANT EXECUTE ON FUNCTION public\.messa_release_empty_session_v1\(uuid,text,uuid\) TO service_role/.test(forward));

test('every new/replaced function stays SECURITY INVOKER',
  (forward.match(/SECURITY INVOKER/g) || []).length >= 5);

test('rollback refuses while a Mesa is open with covers not yet registered',
  /rollback refused: a Mesa is open with covers not yet set/.test(rollback));

test('rollback restores mandatory covers-at-open and drops the deferred-input column',
  /ALTER TABLE public\.table_sessions ALTER COLUMN covers_total SET NOT NULL/.test(rollback)
  && /ADD CONSTRAINT table_sessions_covers_total_chk CHECK \(covers_total BETWEEN 1 AND 99\)/.test(rollback)
  && /ALTER TABLE public\.ordenes DROP COLUMN IF EXISTS table_covers_total_input/.test(rollback)
  && /DROP TRIGGER IF EXISTS table_sessions_guard_covers_monotonic_v1/.test(rollback)
  && /DROP FUNCTION IF EXISTS public\.messa_release_empty_session_v1\(uuid,text,uuid\)/.test(rollback));

process.stdout.write(`\n=== RESULT: ${passed} passed, ${failed} failed ===\n`);
if (failed) process.exit(1);
