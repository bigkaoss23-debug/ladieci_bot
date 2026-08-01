'use strict';

const fs = require('node:fs');
const path = require('node:path');

const forward = fs.readFileSync(path.join(__dirname, '../migrations/2026-08-01_v3h_messa_billing_foundation.sql'), 'utf8');
const rollback = fs.readFileSync(path.join(__dirname, '../migrations/2026-08-01_v3h_messa_billing_foundation.ROLLBACK.sql'), 'utf8');
const manifest = fs.readFileSync(path.join(__dirname, '../migrations/MIGRATION_MANIFEST.md'), 'utf8');
const serviceIdentity = fs.readFileSync(path.join(__dirname, '../migrations/2026-07-22_service_session_identity.sql'), 'utf8');

let passed = 0;
let failed = 0;
function test(name, condition) {
  if (condition) {
    passed += 1;
    process.stdout.write(`  PASS  ${name}\n`);
  } else {
    failed += 1;
    process.stderr.write(`  FAIL  ${name}\n`);
  }
}

test('forward is staging-positive guarded', /20260710075612/.test(forward) && /STAGING ONLY/.test(forward));
test('forward requires exact V3-G assignment RPC', /auth_assign_table_session_waiter_v3\(uuid,text,uuid,text,text,text,text,text,jsonb\)/.test(forward));
test('forward refuses to invent links for non-empty dormant sessions', /IF EXISTS \(SELECT 1 FROM public\.table_sessions\)/.test(forward));

test('physical table model is workspace scoped and numbered', /CREATE TABLE public\.restaurant_tables/.test(forward) && /UNIQUE \(workspace_id, table_number\)/.test(forward));
test('exact owner-approved Mesa spelling is seeded', /'Mesa ' \|\| seed\.n/.test(forward));
test('exactly five initial seed tuples are present', (forward.match(/\(\d, \d+\.000::numeric, \d+\.000::numeric, '(?:round|square)'\)/g) || []).length === 5);
test('floor positions are persisted, responsive percentages', /position_x\s+numeric\(6,3\)/.test(forward) && /BETWEEN 0 AND 100/.test(forward));
test('table removal is soft active=false; no DELETE RPC exists', /active\s+boolean NOT NULL DEFAULT true/.test(forward) && !/DELETE FROM public\.restaurant_tables/i.test(forward));
test('layout editing follows the command trigger session-before-table lock order', /Global lock order[\s\S]*FROM public\.table_sessions[\s\S]*ORDER BY id FOR UPDATE[\s\S]*FROM public\.restaurant_tables[\s\S]*FOR UPDATE/.test(forward));
test('opening locks any open account before the physical table', /messa_open_session_v1[\s\S]*FROM public\.table_sessions[\s\S]*ORDER BY id FOR UPDATE[\s\S]*MESSA_TABLE_ACCOUNT_OPEN[\s\S]*FROM public\.restaurant_tables[\s\S]*FOR UPDATE/.test(forward));

test('session stores table, service and covers', /ADD COLUMN table_id uuid/.test(forward) && /ADD COLUMN service_session_id uuid/.test(forward) && /ADD COLUMN covers_total integer/.test(forward));
test('only one open account exists per physical table', /table_sessions_one_open_per_table_uq/.test(forward) && /WHERE status = 'open'/.test(forward));
test('full payment closes the account and makes the table free immediately', /status='closed', settled_at=v_now, closed_at=v_now/.test(forward) && /v_table_remaining_cents=0 THEN 'free'/.test(forward));
test('a later order opens a brand-new account id', /status = 'open'[\s\S]*MESSA_TABLE_ACCOUNT_OPEN[\s\S]*INSERT INTO public\.table_sessions/.test(forward));
test('there is no paid-occupied state or physical release workflow', !/paid_occupied|occupied_service_session_id|messa_release_table_v1/.test(forward));
test('service close atomically refuses an open Mesa account', /CREATE OR REPLACE FUNCTION public\.begin_service_session_close[\s\S]*service_session_id=v_session\.id[\s\S]*status = 'open'[\s\S]*MESSA_TABLES_NOT_RELEASED[\s\S]*SET status='closing'/.test(forward));
test('covers remaining are derived from transactions', /covers_total - COALESCE\(sum/.test(forward) && /covers_settled/.test(forward));

test('orders and archive carry table snapshots', /ALTER TABLE public\.ordenes[\s\S]*ADD COLUMN table_session_id/.test(forward) && /ALTER TABLE public\.storico[\s\S]*ADD COLUMN table_session_id/.test(forward));
test('each command gets a table-local sequence number', /next_command_number/.test(forward) && /NEW\.table_command_number := v_session\.next_command_number/.test(forward));
test('table commands remain BANCO + RITIRO internally', /NEW\.canal := 'BANCO'/.test(forward) && /NEW\.tipo_consegna := 'RITIRO'/.test(forward));
test('table command snapshots get stable line ids atomically', /jsonb_set\(v_item, '\{lineId\}'/.test(forward) && /BEFORE INSERT ON public\.ordenes/.test(forward));
test('quantity is expanded into immutable per-unit charges', /CREATE TABLE public\.table_order_lines/.test(forward) && /FOR v_unit_index IN 1\.\.v_quantity/.test(forward));
test('per-unit net amounts sum to exact discounted order total', /v_net_remaining_cents/.test(forward) && /v_gross_remaining_cents/.test(forward));

test('transaction supports all approved payment modes', /'full','equal_split','item_selection','custom_amount','refund'/.test(forward));
test('one method per transaction supports mixed table methods', /payment_method\s+text NOT NULL CHECK \(payment_method IN \('efectivo','tarjeta','bizum'\)\)/.test(forward));
test('allocations reference immutable table charge units', /table_order_line_id\s+uuid NOT NULL REFERENCES public\.table_order_lines/.test(forward));
test('item selection rejects duplicates and foreign lines', /v_selected_count <> v_selected_distinct/.test(forward) && /v_selected_matched <> v_selected_count/.test(forward));
test('custom amount and item selection both settle optional covers', /p_amount numeric DEFAULT NULL/.test(forward) && /p_covers_settled integer DEFAULT NULL/.test(forward));
test('Roman share uses sequential ceiling cents', /ceil\(v_outstanding_cents::numeric \/ v_remaining_covers\)/.test(forward));
test('final cent settles all remaining covers', /v_amount_cents = v_outstanding_cents THEN v_covers_settled := v_remaining_covers/.test(forward));
test('payment idempotency is session-bound and request-hashed', /UNIQUE \(workspace_id, by_actor, by_sid_hash, client_request_id\)/.test(forward) && /MESSA_PAYMENT_IDEMPOTENCY_CONFLICT/.test(forward));
test('a lost final-payment response replays after the account is closed', (() => {
  const body = forward.match(/CREATE OR REPLACE FUNCTION public\.messa_post_payment_v1[\s\S]*?END\n\$fn\$;/)?.[0] || '';
  return body.indexOf('SELECT * INTO v_existing FROM public.payment_transactions') >= 0
    && body.indexOf('SELECT * INTO v_existing FROM public.payment_transactions')
      < body.indexOf("IF v_session.status <> 'open'");
})());

test('multi-payment allocations mirror into canonical financial ledger', /INSERT INTO public\.order_financial_events/.test(forward) && /payment_transaction_id/.test(forward));
test('legacy one-payment index remains only for legacy-null transactions', /payment_transaction_id IS NULL/.test(forward));
test('ledger pay states include partially_paid', /'unpaid','partially_paid','paid','refunded'/.test(forward));
test('legacy paid booleans are projections, not source of truth', /Legacy booleans remain compatibility projections only/.test(forward));
test('mixed order projection is explicit', /THEN 'MIXTO'/.test(forward));

test('all new data tables enable RLS', ['restaurant_tables','table_order_lines','payment_transactions','payment_allocations'].every((name) => new RegExp(`ALTER TABLE public\\.${name} ENABLE ROW LEVEL SECURITY`).test(forward)));
test('anon and authenticated grants are revoked', /REVOKE ALL ON public\.restaurant_tables[\s\S]*FROM PUBLIC, anon, authenticated/.test(forward));
test('money RPC is SECURITY INVOKER and service-role only', /messa_post_payment_v1[\s\S]*SECURITY INVOKER/.test(forward) && /GRANT EXECUTE ON FUNCTION public\.messa_post_payment_v1[\s\S]*TO service_role/.test(forward));
test('financial actor and role come from locked auth row', /SELECT \* INTO v_actor FROM public\.auth_actors[\s\S]*FOR UPDATE/.test(forward) && /p_by_actor, v_actor\.role/.test(forward));
test('ledger keeps a bounded actor id and actor-role integrity map', /ADD CONSTRAINT ofe_by_actor_chk CHECK/.test(forward) && /ADD CONSTRAINT ofe_actor_role_map_chk CHECK/.test(forward) && /by_actor <> 'owner'/.test(forward));
test('payment evidence tables are append-only', (forward.match(/BEFORE UPDATE OR DELETE ON public\.(?:table_order_lines|payment_transactions|payment_allocations)/g) || []).length === 3);

test('rollback refuses any operational or financial evidence', /rollback refused: Mesa operational or financial evidence exists/.test(rollback));
test('rollback never deletes financial rows', !/DELETE FROM public\.(?:order_financial_events|payment_transactions|payment_allocations)/i.test(rollback));
test('rollback restores legacy pay states and one-payment indexes', /prev_pay_state IN \('unpaid','paid','refunded'\)/.test(rollback) && /CREATE UNIQUE INDEX order_financial_events_one_payment_session_uq/.test(rollback));
test('rollback restores the pre-Mesa service-close function without the table gate', (() => {
  const pattern = /CREATE OR REPLACE FUNCTION public\.begin_service_session_close[\s\S]*?END \$\$;/;
  const normalize = (value) => (value.match(pattern)?.[0] || '').replace(/\s+/g, ' ').trim();
  return normalize(rollback) === normalize(serviceIdentity)
    && !normalize(rollback).includes('MESSA_TABLES_NOT_RELEASED');
})());
test('manifest row 45 checksum matches this exact forward file', (() => {
  const checksum = require('node:crypto').createHash('sha256').update(forward, 'utf8').digest('hex').slice(0, 16);
  return manifest.includes(`| 45 |`) && manifest.includes(checksum);
})());

process.stdout.write(`\n=== RESULT: ${passed} passed, ${failed} failed ===\n`);
if (failed) process.exit(1);
