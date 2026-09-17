'use strict';
// tests/b1RiderDispatchOperatorParityMigration.test.js — B1 (POST_UAT_BLOCKER_
// FIX_2026-09-17): AUTH_FORBIDDEN_ROLE on rider dispatch, migration 137.
// OFFLINE static guard: no DB, no network (this migration is PREPARED, not
// applied — see governance in POST_UAT_BLOCKER_FIX_REPORT_2026-09-17.md).
//
// THE BUG (source-verified against staging tdikhfeinufaahagmpjz, ledger 136):
//   legacyActionRoles.js already grants admin/operator/rider the HTTP-level
//   right to call "marcarEnEntrega" (not ADMIN_ONLY, and it is in
//   RIDER_ALLOWED). index.js routes every such call through
//   routeRiderTripAction -> riderTrip.startTrip -> start_rider_trip_v2
//   whenever authCtx.rule.tripPrimitive is true (unconditional on role).
//   start_rider_trip_v2 (migration 135) then required v_by.role = 'rider'
//   EXACTLY, so an admin/operator call the HTTP layer had just approved was
//   always refused here with AUTH_FORBIDDEN_ROLE. Staging's empty
//   public.platform_roles is unrelated: it is a separate, unwired
//   multi-tenant workspace table with zero application readers; the real
//   identity source is public.auth_actors, which already holds an active
//   'rider' row on staging.
//
// THE FIX: start_rider_trip_v2's IDENTITY check now accepts the exact role
// set legacyActionRoles.js already grants for this action (admin, operator,
// rider) instead of 'rider' alone. rider_collect_and_complete_stop (the
// MONEY-COLLECTION step) is untouched and stays rider-exclusive — its own
// header explicitly says "this contract never serves admin/operator", and it
// does not require the collecting actor to match trips.rider_actor, so a real
// rider can still complete/collect a stop an operator departed.
//
// Run: node tests/b1RiderDispatchOperatorParityMigration.test.js

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => {
  if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); }
};
const section = (t) => console.log('\n── ' + t + ' ──');

const ROOT = path.join(__dirname, '..');
const read = (rel) => {
  const p = path.join(ROOT, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
};

const FWD_REL = 'migrations/2026-09-17_b1_rider_dispatch_operator_parity_v1_migration_137.sql';
const RBK_REL = 'migrations/2026-09-17_b1_rider_dispatch_operator_parity_v1_migration_137.ROLLBACK.sql';
const BASE_FWD_REL = 'migrations/2026-09-15_planner_w6_rider_lifecycle_cutover_v1_migration_135.sql';

section('MIGRATION 137 — the forward/rollback pair exists, NOT applied');
const FWD = read(FWD_REL);
const RBK = read(RBK_REL);
const BASE = read(BASE_FWD_REL);
assert('migration 137 forward file exists', FWD !== null);
assert('migration 137 rollback file exists', RBK !== null);
assert('migration 135 (the baseline this widens) still exists, unmodified in place', BASE !== null);
assert('no ledger-registration INSERT in the forward file (prepare only, never apply)',
  !/INSERT\s+INTO\s+public\.ladieci_schema_migrations/i.test(FWD || ''));

section('THE WIDENED ROLE PREDICATE — start_rider_trip_v2 only');
assert('the forward migration redefines exactly ONE function (start_rider_trip_v2)',
  (FWD.match(/CREATE OR REPLACE FUNCTION/g) || []).length === 1);
assert('start_rider_trip_v2 is the one redefined',
  FWD.includes('CREATE OR REPLACE FUNCTION public.start_rider_trip_v2('));
assert('the widened predicate accepts rider, admin AND operator',
  FWD.includes("IF v_by.role NOT IN ('rider', 'admin', 'operator') THEN"));
assert('the old rider-only literal is gone from the forward file',
  !FWD.includes("v_by.role <> 'rider'"));
assert('the rollback restores the EXACT old rider-only literal',
  RBK.includes("IF v_by.role <> 'rider' THEN RETURN jsonb_build_object('ok', false, 'code', 'AUTH_FORBIDDEN_ROLE'); END IF;"));
assert('the rollback does not itself carry the widened predicate',
  !RBK.includes("v_by.role NOT IN ('rider', 'admin', 'operator')"));

section('MONEY-COLLECTION CONTRACT UNTOUCHED — rider_collect_and_complete_stop stays rider-exclusive');
assert('migration 137 never REDEFINES rider_collect_and_complete_stop (only its post-condition reads it, to verify it stayed untouched)',
  !FWD.includes('CREATE OR REPLACE FUNCTION public.rider_collect_and_complete_stop'));
assert('migration 135 (still the live definition of that function) keeps the rider-only contract',
  /rider_collect_and_complete_stop[\s\S]{0,4000}v_by\.role <> 'rider'/.test(BASE));
assert('migration 135 explicitly documents collect as never serving admin/operator (unchanged)',
  BASE.includes('this contract never serves admin/operator'));
assert('collect does not require the collecting actor to equal the trip\'s rider_actor (a real rider can still finish a departure an operator started)',
  !/rider_collect_and_complete_stop[\s\S]{0,6000}rider_actor\s*=\s*p_by_actor/.test(BASE));

section('EVERYTHING ELSE BYTE-IDENTICAL — locks, giro membership, DRIVER_STATO projection unchanged');
for (const literal of [
  "PERFORM pg_advisory_xact_lock(hashtext('LA_DIECI_DRIVER_STATO'));",
  "'code', 'AUTH_ACTOR_NOT_FOUND'", "'code', 'AUTH_INITIATOR_INACTIVE'", "'code', 'AUTH_SESSION_STALE'",
  "'code', 'SERVICE_CLOSING'", "'code', 'ACTIVE_TRIP_CONFLICT'", "'code', 'SCOPE_UNAVAILABLE'",
  "CANONICAL_GIRO_DEPARTURE_IS_ATOMIC" /* header prose, from the copied leading comment */,
  "v_uids := d.effective_order_uids;",
  "giro_authority.lock_orders_v1(v_uids);",
  "estado = 'EN_ENTREGA', hora_salida = (extract(epoch FROM now()) * 1000)::bigint",
  "rider_actor, anchor_order_uid, giro_id, departed_at, status, seq",
]) {
  assert(`start_rider_trip_v2 keeps the certified literal: ${literal.slice(0, 40)}...`, FWD.includes(literal));
}
assert('SECURITY DEFINER preserved', FWD.includes('SECURITY DEFINER'));
assert('search_path pin preserved (pg_catalog, pg_temp)', FWD.includes('SET search_path = pg_catalog, pg_temp'));

section('POST-CONDITION BLOCK — the migration verifies its own invariant on apply');
assert('a DO $$ post-condition block asserts the widened predicate landed',
  FWD.includes("v_by.role NOT IN (''rider'', ''admin'', ''operator'')") || /pg_get_functiondef[\s\S]{0,400}v_by\.role NOT IN/.test(FWD));
assert('the post-condition also asserts collect stayed untouched',
  FWD.includes('rider_collect_and_complete_stop(text,text,text,integer,text,jsonb,text)'));

section('NO PARALLEL AUTHORITY — the fix stays inside Trip/Giro Authority');
assert('no DRIVER_STATO-only write path is introduced (the existing compatibility projection is untouched, not duplicated)',
  (FWD.match(/UPDATE public\.config SET valore/g) || []).length === 1);
assert('no new manual_giro authority is introduced', !FWD.includes('CREATE TABLE') && !FWD.includes('ALTER TABLE'));
assert('the function still writes trip_authority.trips as the ONE canonical trip row (INSERT appears exactly once)',
  (FWD.match(/INSERT INTO trip_authority\.trips/g) || []).length === 1);

console.log(`\nb1RiderDispatchOperatorParityMigration: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
