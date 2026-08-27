'use strict';
// OVER-COLLECTED ACKNOWLEDGEMENT AT MESA CLOSE (DB ledger 119, PREREQUISITE B).
// Run: node tests/mesaCloseOverCollectedAcknowledgement.test.js
//
// OFFLINE. No DB, no network. Proves everything that lives in the repository:
//   * the JS wiring (service -> DAO -> RPC param; HTTP handler; safeError classification)
//   * Migration 119's own text + its rollback's honesty and byte-fidelity
// The DB-side BEHAVIOUR (silent close blocked, acknowledged close allowed, exactly one
// incident, no money fabricated, actor attribution, ACL denial, retry idempotency, zero
// residue on rollback) is proven separately by the rollback-forced probes recorded in
// REPORT_AJUSTE_FRONTEND_BACKEND_PREREQUISITES_2026-08-27.md.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://stub.local';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'stub-service-role-key';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };
const section = (t) => console.log('\n── ' + t + ' ──');

const R = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const MIG_DIR = 'migrations';
const FWD = R(path.join(MIG_DIR, '2026-08-27_mesa_close_over_collected_ack_migration_119.sql'));
const RB = R(path.join(MIG_DIR, '2026-08-27_mesa_close_over_collected_ack_migration_119.ROLLBACK.sql'));
const MANIFEST = R(path.join(MIG_DIR, 'MIGRATION_MANIFEST.md'));

// The exact body a CREATE ... AS $fn$ ... $fn$; installs, with the linter's
// `-- language-guard: allow-legacy` comment tails normalised out -- the same discipline
// ajusteComercialV1.test.js uses, because the applied prosrc is comment-free.
const stripGuard = (t) => t.split('\n').map((l) => l.replace(/[ \t]*--[ \t]*language-guard:[^\n]*/, '')).join('\n');
function fnBody(src) {
  const j = src.indexOf('AS $fn$');
  const k = src.indexOf('$fn$;', j + 7);
  return src.slice(j + 7, k);
}

// ═══════════════════════════════════════════════════════════════════
section('MIGRATION 119 -- structure');
ok('forward is one transaction', /^BEGIN;/m.test(FWD) && /COMMIT;\s*$/.test(FWD.trim()));
ok('rollback is one transaction', /^BEGIN;/m.test(RB) && /COMMIT;\s*$/.test(RB.trim()));
ok('no new table', !/CREATE TABLE/i.test(FWD));
ok('no new column', !/ADD COLUMN/i.test(FWD));
ok('no new incident system -- reuses create_service_incident, never CREATEs an incident writer',
  !/CREATE (OR REPLACE )?FUNCTION public\.(create_service_incident|resolve_service_incident|\w*incident\w*)/i.test(FWD)
  && FWD.includes('public.create_service_incident('));
ok('the ONLY function CREATEd/replaced is mesa_close_session_v1',
  (FWD.match(/CREATE (OR REPLACE )?FUNCTION public\.\w+/g) || []).join('|') === 'CREATE FUNCTION public.mesa_close_session_v1');
ok('no CHECK constraint is touched', !/ALTER TABLE .* (DROP|ADD) CONSTRAINT/i.test(FWD));

section('MIGRATION 119 -- signature is a DROP + CREATE, not CREATE OR REPLACE');
ok('drops the pre-119 4-arg overload (else it is a silent bypass)',
  FWD.includes('DROP FUNCTION IF EXISTS public.mesa_close_session_v1(uuid, text, uuid, boolean);'));
ok('creates the 5-arg overload with the new trailing boolean, default false',
  /CREATE FUNCTION public\.mesa_close_session_v1\(\s*\n\s*p_workspace_id uuid,\s*\n\s*p_by_actor text,\s*\n\s*p_table_session_id uuid,\s*\n\s*p_force boolean DEFAULT false,\s*\n\s*p_confirm_over_collected boolean DEFAULT false\s*\n\s*\)/.test(FWD));
ok('preserves LANGUAGE plpgsql / SECURITY INVOKER / the exact search_path',
  /LANGUAGE plpgsql/.test(FWD) && /SECURITY INVOKER/.test(FWD) && /SET search_path = public, extensions, pg_temp/.test(FWD));
ok('a pre-condition refuses to run unless the live 4-arg body md5 is the ledger-118 one',
  FWD.includes("'c79312cd83db07cb0375f0cc5354d4f8'") && FWD.includes('pre-119 mesa_close_session_v1 body md5 mismatch'));
ok('a pre-condition refuses to run if already applied',
  FWD.includes('already applied (5-arg mesa_close_session_v1 exists)'));

section('MIGRATION 119 -- the acknowledgement gate');
const body = fnBody(FWD);
ok('the un-acknowledged over-collected close RAISEs a stable domain error',
  body.includes("RAISE EXCEPTION 'MESA_CLOSE_OVER_COLLECTED'"));
ok('it carries safe structured context in DETAIL, not raw SQL',
  /DETAIL = format\('overCollected=%s', v_over_cents \/ 100\.0\)/.test(body));
ok('the gate is exactly "over-collected AND not acknowledged"',
  /IF v_over_cents > 0 AND NOT COALESCE\(p_confirm_over_collected, false\) THEN/.test(body));
ok('the acknowledgement is NEVER inferred -- it is a real parameter the caller must pass',
  /p_confirm_over_collected boolean DEFAULT false/.test(FWD));
ok('the unpaid-balance block still fires BEFORE the over-collected gate',
  body.indexOf("'MESA_TABLE_NOT_SETTLED'") < body.indexOf("'MESA_CLOSE_OVER_COLLECTED'"));
ok('the unpaid block is unconditional -- not itself gated on the acknowledgement',
  /IF v_unpaid_cents > 0 THEN RAISE EXCEPTION 'MESA_TABLE_NOT_SETTLED' USING ERRCODE='55000'; END IF;/.test(body));
ok('p_force stays independent (kitchen/order completeness only)',
  body.includes("'MESA_TABLE_HAS_ACTIVE_ORDERS'") && body.includes('IF NOT p_force THEN'));
ok('MESA_SESSION_NOT_OPEN on a retry is preserved verbatim (idempotency anchor)',
  body.includes("IF v_session.status <> 'open' THEN RAISE EXCEPTION 'MESA_SESSION_NOT_OPEN'"));

section('MIGRATION 119 -- the financial incident');
ok('records via the EXISTING create_service_incident RPC', body.includes('public.create_service_incident('));
ok('incident type is OVER_COLLECTED_AT_CLOSE', body.includes("p_incident_type => 'OVER_COLLECTED_AT_CLOSE'"));
ok('category financial / severity warning', body.includes("p_category => 'financial'") && body.includes("p_severity => 'warning'"));
ok('financial exposure = the unresolved over-collection', body.includes('p_financial_exposure_cents => v_over_cents::integer'));
ok('table + service provenance', body.includes("p_entity_type => 'table_session'") && body.includes('p_table_session_id => v_session.id') && body.includes('p_service_session_id => v_session.service_session_id'));
ok('actor attribution is the closing actor', body.includes('p_detected_by => p_by_actor'));
ok('deterministic correlation id per table session (retry -> same dedupe key)',
  body.includes("md5('mesa_close_over_collected:' || v_session.id::text)::uuid"));
ok('the incident write is inside the SAME transaction, before the table_sessions UPDATE',
  body.indexOf('create_service_incident(') < body.indexOf('UPDATE public.table_sessions SET'));
ok('the incident write is AFTER the p_force block (a blocked close writes nothing)',
  body.indexOf("'MESA_TABLE_HAS_ACTIVE_ORDERS'") < body.indexOf('create_service_incident('));
ok('fail closed: an un-recordable exposure aborts the close',
  body.includes("RAISE EXCEPTION 'MESA_CLOSE_INCIDENT_PERSISTENCE_FAILED'"));
ok('the return names the acknowledgement and the incident id',
  body.includes("'overCollectedAcknowledged'") && body.includes("'incidentId'"));

section('MIGRATION 119 -- SS27: no money, no obligation revision');
ok('no INSERT into any money/obligation table in the close body',
  !/INSERT INTO public\.(payment_transactions|payment_allocations|order_financial_events|order_obligations)/.test(body));
ok('never calls a money/obligation writer',
  !/mesa_post_refund_v1|mesa_post_commercial_adjustment_v1|order_cancel_v1|order_obligation_apply_adjustment_v1/.test(body));
ok('never names reverses_transaction_id', !body.includes('reverses_transaction_id'));
ok('a post-condition proves all of that structurally',
  FWD.includes('close writer fabricates money or an obligation revision'));

section('MIGRATION 119 -- ACL (the ledger-118 default-ACL lesson)');
ok('REVOKE names anon and authenticated EXPLICITLY, not just PUBLIC',
  /REVOKE ALL ON FUNCTION public\.mesa_close_session_v1\(uuid, text, uuid, boolean, boolean\) FROM PUBLIC, anon, authenticated;/.test(FWD));
ok('GRANT EXECUTE to service_role only',
  /GRANT EXECUTE ON FUNCTION public\.mesa_close_session_v1\(uuid, text, uuid, boolean, boolean\) TO service_role;/.test(FWD));
ok('a post-condition proves anon/authenticated cannot execute it',
  FWD.includes('a browser role holds EXECUTE on mesa_close_session_v1'));
ok('a post-condition proves service_role CAN execute it',
  FWD.includes('service_role cannot execute mesa_close_session_v1'));

section('MIGRATION 119 -- things that MUST NOT have changed (md5-pinned in-txn)');
for (const [label, marker] of [
  ['create_service_incident', 'create_service_incident was modified'],
  ['mesa_post_payment_v1', 'mesa_post_payment_v1 was modified'],
  ['Refund V1', 'Refund V1 semantics were modified'],
  ['mesa_post_commercial_adjustment_v1', 'mesa_post_commercial_adjustment_v1 was modified'],
  ['order_cancel_v1', 'order_cancel_v1 was modified'],
]) ok('a post-condition pins ' + label + ' unchanged', FWD.includes(marker));
ok('NO BACKFILL -- post-conditions pin service_incidents / closed-session / auth_audit counts',
  FWD.includes('service_incidents row count changed')
  && FWD.includes('a table_session was closed by the migration')
  && FWD.includes('the migration emitted an auth_audit row'));

section('MIGRATION 119 -- the applied body is pinned exactly (transcription drift = abort)');
const bodyMd5 = crypto.createHash('md5').update(stripGuard(body)).digest('hex');
ok('the forward migration asserts the md5 it will really install', FWD.includes(bodyMd5));
ok('that md5 is the expected new 5-arg body', bodyMd5 === '1e4525aa3fc4e571f7df1acb3a6a59d4', bodyMd5);
ok('the new body preserves the canonical obligation basis (ledger 118)', body.includes('public.order_canonical_obligation_v1(o.order_uid)'));
ok('the OPERATIONAL CHIUSO_FORZATO completeness check survives byte-for-byte',  // language-guard: allow-legacy CHIUSO_FORZATO is the pre-existing terminal-state literal this assertion proves SURVIVED the CREATE, not new vocabulary
  (stripGuard(body).match(/'RETIRADO','COMPLETADO','COMPLETATO','CANCELADO','CANCELLED','ANULADO','CHIUSO_FORZATO'/g) || []).length === 2);  // language-guard: allow-legacy COMPLETATO / CHIUSO_FORZATO restated verbatim from the pre-existing body for the count assertion, not new vocabulary

section('ROLLBACK -- byte-fidelity + honesty');
ok('drops the 5-arg overload', RB.includes('DROP FUNCTION IF EXISTS public.mesa_close_session_v1(uuid, text, uuid, boolean, boolean);'));
ok('recreates the 4-arg overload', /CREATE FUNCTION public\.mesa_close_session_v1\([\s\S]{0,160}p_force boolean DEFAULT false\s*\n\s*\) RETURNS jsonb/.test(RB));
ok('the restored body is the pre-119 ledger-118 body BYTE-IDENTICALLY (md5 pinned)',
  crypto.createHash('md5').update(stripGuard(fnBody(RB))).digest('hex') === 'c79312cd83db07cb0375f0cc5354d4f8',
  crypto.createHash('md5').update(stripGuard(fnBody(RB))).digest('hex'));
ok('the rollback asserts the md5 it will really install', RB.includes('c79312cd83db07cb0375f0cc5354d4f8'));
ok('the restored body has NO acknowledgement logic (pre-119 authority)',
  !fnBody(RB).includes('p_confirm_over_collected') && !fnBody(RB).includes('MESA_CLOSE_OVER_COLLECTED')
  && !fnBody(RB).includes('create_service_incident'));
ok('restores the pre-119 privilege posture (service_role only, no anon/authenticated)',
  /REVOKE ALL ON FUNCTION public\.mesa_close_session_v1\(uuid, text, uuid, boolean\) FROM PUBLIC, anon, authenticated;/.test(RB)
  && /GRANT EXECUTE ON FUNCTION public\.mesa_close_session_v1\(uuid, text, uuid, boolean\) TO service_role;/.test(RB));
ok('a post-condition proves the 5-arg overload is gone and exactly one remains',
  RB.includes('the 5-arg overload survived') && RB.includes('expected exactly one mesa_close_session_v1 overload'));
ok('rollback NEVER deletes a service_incidents row', !/DELETE\s+FROM\s+public\.service_incidents/i.test(RB));
ok('rollback says out loud that already-written OVER_COLLECTED_AT_CLOSE rows are RETAINED',
  RB.includes('RETAINED') && RB.includes('append-only'));

section('MANIFEST');
ok('manifest carries a narrative row 121 for this migration file',
  MANIFEST.includes('| 2026-08-27_mesa_close_over_collected_ack_migration_119.sql |'));
{
  const checksum = crypto.createHash('sha256').update(FWD, 'utf8').digest('hex').slice(0, 16);
  ok('manifest row 121 checksum matches this exact forward file', MANIFEST.includes(checksum), checksum);
}

// ═══════════════════════════════════════════════════════════════════
section('APPLICATION LAYER -- DAO');
const dao = R('src/tables/mesaDao.js');
ok('closeSession maps p_confirm_over_collected from confirmOverCollected, strict === true',
  /closeSession = \(args\) => rpc\('mesa_close_session_v1', \{[\s\S]{0,400}p_confirm_over_collected: args\.confirmOverCollected === true,/.test(dao));
ok('rpc() surfaces PostgREST DETAIL as error.pgDetail (for the one whitelisted field)',
  /error\.pgDetail = response\.body && typeof response\.body\.details === 'string'/.test(dao));

section('APPLICATION LAYER -- service');
const svc = R('src/tables/mesaService.js');
ok('closeTable accepts confirmOverCollected and narrows it to === true',
  /async closeTable\(\{ context, tableSessionId, force, confirmOverCollected \} = \{\}\)/.test(svc)
  && /confirmOverCollected: confirmOverCollected === true,/.test(svc));
ok('closeTable still uses the ordinary close authority (OPEN_ROLES), NOT the admin-only adjustment gate',
  /async closeTable\([\s\S]{0,160}requireContext\(context, OPEN_ROLES\)/.test(svc));

section('APPLICATION LAYER -- HTTP handler + safeError');
const h = R('src/tables/mesaHttpHandlers.js');
ok('the close handler forwards req.body.confirmOverCollected',
  /closeTable: run\('close_table',[\s\S]{0,600}confirmOverCollected: req\.body\?\.confirmOverCollected,/.test(h));
ok('MESA_CLOSE_OVER_COLLECTED classified as a 409 conflict', h.includes("'MESA_CLOSE_OVER_COLLECTED'") && /conflict = new Set\(\[[\s\S]*'MESA_CLOSE_OVER_COLLECTED'/.test(h));
ok('MESA_CLOSE_INCIDENT_PERSISTENCE_FAILED classified as a 500 (fail closed)',
  /internal = new Set\(\[[\s\S]*'MESA_CLOSE_INCIDENT_PERSISTENCE_FAILED'/.test(h));
ok('exactly ONE whitelisted structured field is forwarded, strictly parsed from DETAIL',
  h.includes("code === 'MESA_CLOSE_OVER_COLLECTED'")
  && /\/\^overCollected=\(\[0-9\]\+\(\?:\\\.\[0-9\]\+\)\?\)\$\//.test(h)
  && h.includes('result.overCollected = Number(m[1])'));
ok('the raw PG DETAIL string is never forwarded', !/payload\.pgDetail|json\([^)]*pgDetail/.test(h));

// ═══════════════════════════════════════════════════════════════════
section('BEHAVIOUR -- service -> DAO wiring, live-stubbed');
const { createMesaService } = require('../src/tables/mesaService');
(async () => {
  const seen = [];
  const service = createMesaService({ dao: { closeSession: async (a) => { seen.push(a); return { ok: true, status: 'closed' }; } } });
  const ctx = (role = 'operator') => ({ actor: 'operator_primary', role, workspaceId: 'ws', sid: 's'.repeat(16) });

  await service.closeTable({ context: ctx(), tableSessionId: 'ts-1' });
  ok('plain close -> confirmOverCollected:false, force:false', seen[0].confirmOverCollected === false && seen[0].force === false);

  await service.closeTable({ context: ctx(), tableSessionId: 'ts-1', confirmOverCollected: true });
  ok('explicit acknowledgement -> confirmOverCollected:true', seen[1].confirmOverCollected === true && seen[1].force === false);

  await service.closeTable({ context: ctx(), tableSessionId: 'ts-1', force: true });
  ok('force does not imply acknowledgement', seen[2].force === true && seen[2].confirmOverCollected === false);

  for (const bad of ['true', 1, {}, [], 'yes']) {
    seen.length = 0;
    await service.closeTable({ context: ctx(), tableSessionId: 'ts-1', confirmOverCollected: bad });
    ok('truthy-but-not-true (' + JSON.stringify(bad) + ') is NOT acknowledgement', seen[0].confirmOverCollected === false);
  }

  // a waiter may still close (and acknowledge) -- same authority as a plain close
  seen.length = 0;
  await service.closeTable({ context: ctx('waiter'), tableSessionId: 'ts-1', confirmOverCollected: true });
  ok('a waiter who may close may also acknowledge over-collection (not the admin-only power)',
    seen[0] && seen[0].confirmOverCollected === true);

  // a role that cannot close cannot acknowledge either
  try {
    await service.closeTable({ context: ctx('rider'), tableSessionId: 'ts-1', confirmOverCollected: true });
    ok('rider cannot close/acknowledge', false, 'expected MESA_FORBIDDEN');
  } catch (e) { ok('rider cannot close/acknowledge', e && e.code === 'MESA_FORBIDDEN'); }

  section('BEHAVIOUR -- safeError classification + whitelisted field');
  const { safeError } = require('../src/tables/mesaHttpHandlers');
  const e409 = safeError(Object.assign(new Error('x'), { code: 'MESA_CLOSE_OVER_COLLECTED', pgDetail: 'overCollected=12.5' }));
  ok('MESA_CLOSE_OVER_COLLECTED -> 409', e409.status === 409 && e409.code === 'MESA_CLOSE_OVER_COLLECTED');
  ok('...and forwards ONLY the parsed numeric exposure', e409.overCollected === 12.5);
  const eBadDetail = safeError(Object.assign(new Error('x'), { code: 'MESA_CLOSE_OVER_COLLECTED', pgDetail: 'DROP TABLE x; overCollected=9' }));
  ok('a non-matching DETAIL is dropped entirely (no leak)', !('overCollected' in eBadDetail));
  const e500 = safeError(Object.assign(new Error('x'), { code: 'MESA_CLOSE_INCIDENT_PERSISTENCE_FAILED' }));
  ok('MESA_CLOSE_INCIDENT_PERSISTENCE_FAILED -> 500', e500.status === 500);
  const ePlain = safeError(Object.assign(new Error('x'), { code: 'MESA_TABLE_NOT_SETTLED' }));
  ok('an unrelated close error carries no overCollected field', !('overCollected' in ePlain) && ePlain.status === 409);

  console.log('\n═══ RESULT: ' + pass + ' passed, ' + fail + ' failed ═══');
  process.exit(fail === 0 ? 0 : 1);
})();
