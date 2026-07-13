-- migrations/2026-07-13_auth_v2_foundation.sql
-- Access Control V2 — Block B0 (auth foundation).
-- TARGET PROJECT REF: tdikhfeinufaahagmpjz   ***STAGING ONLY***
-- Do not apply outside staging. Additive + idempotent.
-- Creates auth_actors + auth_audit only. No void_/refund_ columns (those are B7).
BEGIN;

-- Staging-positive guard: assert a staging-only migration is present.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations
    WHERE version = '20260710075612'   -- menu_extras_add_emoji (staging-only sentinel)
  ) THEN
    RAISE EXCEPTION 'B0 refused: staging sentinel migration absent — wrong database?';
  END IF;
END $$;

create table if not exists public.auth_actors (
  actor           text primary key
                  constraint auth_actors_actor_chk
                    check (actor in ('owner','operator_primary','operator_backup','rider')),
  role            text not null
                  constraint auth_actors_role_chk
                    check (role in ('admin','operator','rider')),
  pin_hash        text,                                   -- nullable; scrypt only; NEVER plaintext
  session_version integer not null default 1
                  constraint auth_actors_sv_chk check (session_version >= 1),
  active          boolean not null default true,
  failed_count    integer not null default 0
                  constraint auth_actors_failed_chk check (failed_count >= 0),
  locked_until    timestamptz,
  updated_at      timestamptz not null default now(),
  updated_by      text
                  constraint auth_actors_updated_by_chk
                    check (updated_by is null or updated_by in
                      ('owner','operator_primary','operator_backup','rider')),
  constraint auth_actors_actor_role_map check (
    (actor='owner'            and role='admin')    or
    (actor='operator_primary' and role='operator') or
    (actor='operator_backup'  and role='operator') or
    (actor='rider'            and role='rider')
  )
);

create table if not exists public.auth_audit (
  id           bigint generated always as identity primary key,
  ts           timestamptz not null default now(),
  event        text not null
               constraint auth_audit_event_chk check (event in
                 ('login_ok','login_fail','locked','pin_set','pin_change',
                  'revoke','bootstrap','recovery')),   -- void_order/refund added in B7
  target_actor text
               constraint auth_audit_target_actor_chk
                 check (target_actor is null or target_actor in
                   ('owner','operator_primary','operator_backup','rider')),
  by_actor     text
               constraint auth_audit_by_actor_chk
                 check (by_actor is null or by_actor in
                   ('owner','operator_primary','operator_backup','rider')),
  ip_hash      text,
  meta         jsonb not null default '{}'::jsonb      -- NEVER PIN/JWT/secret/API key
);
create index if not exists auth_audit_ts_idx on public.auth_audit (ts desc);

alter table public.auth_actors enable row level security;
alter table public.auth_audit  enable row level security;
-- ZERO CREATE POLICY -> default-deny for anon & authenticated; service_role bypasses RLS.

-- Idempotent seed: never overwrite existing rows (pin_hash/sv/active/timestamps preserved).
insert into public.auth_actors (actor, role) values
  ('owner','admin'),
  ('operator_primary','operator'),
  ('operator_backup','operator'),
  ('rider','rider')
on conflict (actor) do nothing;

comment on table public.auth_actors is 'Access Control V2 — operational identities; scrypt PIN hashes only; service_role-only (B0).';
comment on table public.auth_audit  is 'Access Control V2 — append-only auth audit; no secrets (B0).';

COMMIT;
