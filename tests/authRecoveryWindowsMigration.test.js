'use strict';
// B5 static migration/SQL tests. Run: node tests/authRecoveryWindowsMigration.test.js
// NON-EXECUTING: asserts structure/safety of the B5 migration by inspecting the
// SQL text. No DB, no staging. Proves table/constraints/RLS/grants and that the
// atomic consumption performs actor mutation + window one-shot + audit in ONE
// SECURITY INVOKER function with row locking and pinned search_path.
const fs = require('fs');
const path = require('path');
let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const SQL = read('migrations/2026-07-14_auth_recovery_windows.sql');
const RB = read('migrations/2026-07-14_auth_recovery_windows.ROLLBACK.sql');
// Isolate each function DEFINITION body (not the REVOKE/GRANT signatures) for
// atomicity assertions. register spans its CREATE → consume's CREATE; consume
// spans its CREATE → the grants section.
const regCreate = SQL.indexOf('CREATE OR REPLACE FUNCTION public.auth_register_recovery_window');
const conCreate = SQL.indexOf('CREATE OR REPLACE FUNCTION public.auth_consume_recovery_window');
const grantsAt = SQL.indexOf('-- ── grants');
const register = SQL.slice(regCreate, conCreate);
const consume = SQL.slice(conCreate, grantsAt);

// ── table + constraints ──────────────────────────────────────────────────────
assert('table auth_recovery_windows created', /CREATE TABLE IF NOT EXISTS public\.auth_recovery_windows/.test(SQL));
assert('window_id primary key', /window_id\s+text\s+primary key/.test(SQL));
assert('window_id UUID format check', /arw_window_id_uuid_chk[\s\S]*?\^\[0-9a-f\]\{8\}-/.test(SQL));
assert('purpose IN (bootstrap,recovery)', /purpose in \('bootstrap','recovery'\)/.test(SQL));
assert('actor FK to auth_actors ON DELETE RESTRICT', /references public\.auth_actors\(actor\) on delete restrict/.test(SQL));
assert('secret_digest present + hex-64 check (no plaintext column)', /secret_digest\s+text not null[\s\S]*?\^\[0-9a-f\]\{64\}\$/.test(SQL));
assert('NO plaintext secret column', !/\bsecret\s+text\b/.test(SQL) && !/window_secret/i.test(SQL));
assert('created_at default now()', /created_at\s+timestamptz not null default now\(\)/.test(SQL));
assert('expires_at not null', /expires_at\s+timestamptz not null/.test(SQL));
assert('consumed_at nullable (one-shot marker)', /consumed_at\s+timestamptz,/.test(SQL));
assert('metadata jsonb default empty object', /metadata\s+jsonb not null default '\{\}'::jsonb/.test(SQL));
assert('metadata must be object', /jsonb_typeof\(metadata\) = 'object'/.test(SQL));
assert('constraint expires_at > created_at', /check \(expires_at > created_at\)/.test(SQL));
assert('constraint max lifetime 15 minutes', /expires_at <= created_at \+ interval '15 minutes'/.test(SQL));

// ── RLS + zero policies + service-role-only ──────────────────────────────────
assert('RLS enabled on the table', /alter table public\.auth_recovery_windows enable row level security/i.test(SQL));
// A real policy statement is "CREATE POLICY <name> ..."; the explanatory comment
// "ZERO CREATE POLICY -> default-deny" is not a statement (next char is '-').
assert('ZERO create policy (default-deny)', !/CREATE POLICY\s+["\w]/i.test(SQL));
assert('staging sentinel guard present', /schema_migrations WHERE version='20260710075612'/.test(SQL));

// ── functions: security invoker + pinned search_path + no SECURITY DEFINER ───
assert('register fn is SECURITY INVOKER', /FUNCTION public\.auth_register_recovery_window[\s\S]*?SECURITY INVOKER/.test(SQL));
assert('consume fn is SECURITY INVOKER', /FUNCTION public\.auth_consume_recovery_window[\s\S]*?SECURITY INVOKER/.test(SQL));
assert('NO SECURITY DEFINER anywhere', !/SECURITY DEFINER/i.test(SQL));
assert('search_path pinned on both fns', (SQL.match(/SET search_path = public, pg_temp/g) || []).length >= 2);
assert('no dynamic SQL (EXECUTE ... USING/format)', !/\bEXECUTE\s+format\b/i.test(SQL) && !/\bEXECUTE\s+'/i.test(SQL));

// ── consumption atomicity + guards (all inside ONE function) ─────────────────
assert('consume locks window row FOR UPDATE', /auth_recovery_windows WHERE window_id = p_window_id FOR UPDATE/.test(consume));
assert('consume locks actor row FOR UPDATE', /auth_actors WHERE actor = w\.actor FOR UPDATE/.test(consume));
assert('consume checks descriptor (purpose/actor/digest)', /w\.purpose <> p_purpose OR w\.actor <> p_actor OR w\.secret_digest <> p_secret_digest/.test(consume));
assert('consume rejects already-consumed', /w\.consumed_at IS NOT NULL[\s\S]*?AUTH_WINDOW_CONSUMED/.test(consume));
assert('consume rejects expired (server time now())', /w\.expires_at <= v_now[\s\S]*?AUTH_WINDOW_EXPIRED/.test(consume));
assert('consume requires role admin', /a\.role <> 'admin'[\s\S]*?AUTH_ACTOR_NOT_ADMIN/.test(consume));
assert('bootstrap requires pin_hash NULL', /p_purpose = 'bootstrap' AND a\.pin_hash IS NOT NULL[\s\S]*?AUTH_PIN_STATE_CONFLICT/.test(consume));
assert('recovery requires pin_hash NOT NULL', /p_purpose = 'recovery' AND a\.pin_hash IS NULL[\s\S]*?AUTH_PIN_STATE_CONFLICT/.test(consume));
assert('sets new scrypt hash', /SET pin_hash = p_new_hash/.test(consume));
assert('resets failed_count=0 and locked_until=NULL', /failed_count = 0, locked_until = NULL/.test(consume));
assert('sets active = true', /active = true/.test(consume));
assert('increments session_version', /session_version = session_version \+ 1/.test(consume));
assert('marks window consumed (one-shot)', /SET consumed_at = v_now, consumed_ip_hash = p_ip_hash/.test(consume));
assert('writes audit in same fn/tx', /INSERT INTO public\.auth_audit\(event, target_actor, by_actor, ip_hash, meta\)/.test(consume));
assert('audit event = purpose (bootstrap/recovery reused, not invented)', /VALUES \(p_purpose, w\.actor, NULL, p_ip_hash,/.test(consume));
assert('audit meta carries no secret/hash (purpose+window_id only)', /jsonb_build_object\('purpose', p_purpose, 'window_id', p_window_id\)/.test(consume));
assert('consume guards p_new_hash shape (scrypt$)', /left\(p_new_hash, 7\) <> 'scrypt\$'/.test(consume));
assert('consume applies meta sensitive-key guard', /AUTH_META_SENSITIVE_KEY/.test(consume));
// order: audit INSERT occurs after the actor UPDATE and window UPDATE (same tx, atomic)
assert('actor update precedes window-consume precedes audit',
  consume.indexOf('SET pin_hash = p_new_hash') < consume.indexOf('SET consumed_at = v_now') &&
  consume.indexOf('SET consumed_at = v_now') < consume.indexOf('INSERT INTO public.auth_audit'));

// ── registration idempotency / no-reopen ─────────────────────────────────────
assert('register uses ON CONFLICT DO NOTHING (idempotent)', /ON CONFLICT \(window_id\) DO NOTHING/.test(register));
assert('register rejects over-15-min lifetime', /p_expires_at > v_now \+ interval '15 minutes'[\s\S]*?AUTH_WINDOW_LIFETIME_EXCEEDED/.test(SQL));
assert('register rejects already-expired', /p_expires_at <= v_now[\s\S]*?AUTH_WINDOW_EXPIRED/.test(SQL));
assert('register never resets consumed_at', !/UPDATE[\s\S]*?consumed_at = NULL/i.test(SQL));
assert('register fails on descriptor mismatch (no silent reopen)', /AUTH_WINDOW_DESCRIPTOR_MISMATCH/.test(SQL));

// ── grants: service_role only ────────────────────────────────────────────────
assert('register revoked from public/anon/authenticated', /REVOKE ALL ON FUNCTION public\.auth_register_recovery_window[\s\S]*?FROM PUBLIC, anon, authenticated/.test(SQL));
assert('consume revoked from public/anon/authenticated', /REVOKE ALL ON FUNCTION public\.auth_consume_recovery_window[\s\S]*?FROM PUBLIC, anon, authenticated/.test(SQL));
assert('register granted to service_role only', /GRANT EXECUTE ON FUNCTION public\.auth_register_recovery_window[\s\S]*?TO service_role/.test(SQL));
assert('consume granted to service_role only', /GRANT EXECUTE ON FUNCTION public\.auth_consume_recovery_window[\s\S]*?TO service_role/.test(SQL));
assert('no broad GRANT ... TO PUBLIC/anon/authenticated', !/GRANT[\s\S]*?TO (PUBLIC|anon|authenticated)/.test(SQL));

// ── rollback safety ──────────────────────────────────────────────────────────
assert('rollback refuses if any consumed window exists', /ROLLBACK REFUSED/.test(RB) && /consumed_at IS NOT NULL/.test(RB));
assert('rollback drops both functions + table', /DROP FUNCTION IF EXISTS public\.auth_consume_recovery_window/.test(RB) && /DROP FUNCTION IF EXISTS public\.auth_register_recovery_window/.test(RB) && /DROP TABLE IF EXISTS public\.auth_recovery_windows/.test(RB));

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
