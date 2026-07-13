-- Integration tests for B2 auth RPCs — STAGING ONLY (tdikhfeinufaahagmpjz).
-- Run as service_role (Supabase MCP execute_sql or psql with the service key).
-- CONTROLLED & NON-PERSISTENT: correctness checks run inside aborted transactions
-- (RAISE at the end rolls the tx back). Only the concurrency and lock-mapping
-- setup touch failed_count/locked_until, which are reset in CLEANUP. Uses the
-- 'rider' actor. Do NOT run against production.
--
-- Expected results were verified on 2026-07-13:
--   grants: anon/authenticated EXECUTE=false, service_role EXECUTE=true
--   concurrency (4 parallel record calls from failed_count=0) → failed_count=4 (no lost update)
--   lock mapping nfc→min: 5→1, 6→5, 7→15, 8→60, 9→60 (cap)
--   during-lock call → locked=true, failed_count unchanged, retry_after_sec≈300
--   reset → failed_count=0, locked_until=null
--   set_pin (pin_hash NULL) → event=pin_set, sv+1, failed reset
--   set_pin (pin_hash present) → event=pin_change
--   bump_session_version → event=revoke, sv+1
--   set_active(false) → event=revoke, meta{op:set_active,active:false}, sv+1
--   invalid by_actor → constraint violation, NO mutation (atomic)
--   unknown actor → AUTH_ACTOR_NOT_FOUND
--   sensitive meta → AUTH_META_SENSITIVE_KEY, NO mutation
--   final: all actors sv=1, failed_count=0, pin NULL, active; auth_audit=0

-- ── grants ────────────────────────────────────────────────────────────────────
select p.proname,
       has_function_privilege('anon', p.oid, 'EXECUTE')           as anon_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE')  as authenticated_exec,
       has_function_privilege('service_role', p.oid, 'EXECUTE')   as service_role_exec
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname like 'auth_%' order by p.proname;

-- ── concurrency (run these 4 in parallel connections, from failed_count=0) ────
-- update public.auth_actors set failed_count=0, locked_until=null where actor='rider';
--   select public.auth_record_failed_attempt('rider');   -- x4 concurrent
-- expect: final failed_count = 4

-- ── progressive lock mapping (aborted) ────────────────────────────────────────
do $$
declare res jsonb := '[]'::jsonb; n int; lu timestamptz; r jsonb;
begin
  foreach n in array array[5,6,7,8,9] loop
    update public.auth_actors set failed_count=n-1, locked_until=null where actor='rider';
    r := public.auth_record_failed_attempt('rider');
    select locked_until into lu from public.auth_actors where actor='rider';
    res := res || jsonb_build_object('nfc', n, 'lock_min', round(extract(epoch from (lu-now()))/60.0), 'locked', (r->>'locked')::boolean);
  end loop;
  raise exception 'LOCKSEQ %', res;
end $$;

-- ── call during lock does not increment (aborted) ─────────────────────────────
do $$ declare r jsonb; fc int;
begin
  update public.auth_actors set failed_count=5, locked_until=now()+interval '5 min' where actor='rider';
  r := public.auth_record_failed_attempt('rider');
  select failed_count into fc from public.auth_actors where actor='rider';
  raise exception 'DURINGLOCK %', jsonb_build_object('result', r, 'failed_count_after', fc);
end $$;

-- ── reset atomic (aborted) ────────────────────────────────────────────────────
do $$ declare r jsonb;
begin
  update public.auth_actors set failed_count=3, locked_until=now()+interval '9 min' where actor='rider';
  r := public.auth_reset_failed_attempts('rider');
  raise exception 'RESET %', r;
end $$;

-- ── set_pin event derivation (aborted) ────────────────────────────────────────
do $$ declare r jsonb; ev text; sv0 int; sv1 int; fc int;
begin
  select session_version into sv0 from public.auth_actors where actor='rider';
  r := public.auth_set_pin_hash('rider','scrypt$1$TESTONLY','owner','{}'::jsonb);
  select event into ev from public.auth_audit where target_actor='rider' order by id desc limit 1;
  select session_version, failed_count into sv1, fc from public.auth_actors where actor='rider';
  raise exception 'SETPIN %', jsonb_build_object('rpc',r,'audit_event',ev,'sv_before',sv0,'sv_after',sv1,'failed_after',fc);
end $$;

do $$ declare r jsonb; ev text;
begin
  update public.auth_actors set pin_hash='scrypt$1$OLD' where actor='rider';
  r := public.auth_set_pin_hash('rider','scrypt$1$NEW','owner','{}'::jsonb);
  select event into ev from public.auth_audit where target_actor='rider' order by id desc limit 1;
  raise exception 'SETPINCHG %', jsonb_build_object('rpc',r,'audit_event',ev);
end $$;

-- ── revoke + set_active (aborted) ─────────────────────────────────────────────
do $$ declare r jsonb; ev text;
begin
  r := public.auth_bump_session_version('rider','owner','{}'::jsonb);
  select event into ev from public.auth_audit where target_actor='rider' order by id desc limit 1;
  raise exception 'REVOKE %', jsonb_build_object('rpc',r,'audit_event',ev);
end $$;

do $$ declare r jsonb; ev text; mt jsonb;
begin
  r := public.auth_set_active('rider', false, 'owner', '{}'::jsonb);
  select event, meta into ev, mt from public.auth_audit where target_actor='rider' order by id desc limit 1;
  raise exception 'ACTIVE %', jsonb_build_object('rpc',r,'audit_event',ev,'meta',mt);
end $$;

-- ── controlled errors (each raises; the failing statement mutates nothing) ────
-- select public.auth_set_pin_hash('rider','scrypt$1$X','intruso','{}'::jsonb);        -- 23514 (atomic: no mutation)
-- select public.auth_record_failed_attempt('ghost');                                  -- AUTH_ACTOR_NOT_FOUND
-- select public.auth_set_pin_hash('rider','scrypt$1$X','owner','{"secret":"leak"}');   -- AUTH_META_SENSITIVE_KEY

-- ── CLEANUP: restore counters (aborted-tx tests leave nothing else) ───────────
update public.auth_actors set failed_count=0, locked_until=null where actor='rider';
-- verify B0 state: all sv=1, failed_count=0, pin NULL, active; auth_audit=0
