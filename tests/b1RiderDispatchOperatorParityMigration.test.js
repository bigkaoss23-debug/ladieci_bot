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
// REPAIRED 2026-09-18 (POST_OPUS_REVIEW_REMEDIATION, Scope A/B) after the
// independent Opus delta review (POST_UAT_BLOCKER_FIX_OPUS_REVIEW_2026-09-17.md
// language-guard: allow-legacy n_ordini is the existing DRIVER_STATO snapshot field name cited here for context, not new vocabulary
// §1.5) found four defects in the first draft: D-1 the ROLLBACK's n_ordini
// tripped the domain-language build gate; D-2 the rollback was NOT byte-
// identical to migration 135 (all comments stripped); D-3 no predecessor/
// drift guard on the forward migration, none at all on the rollback; D-4 no
// ephemeral-PostgreSQL certification. All four are fixed and re-asserted
// below. The repair also adds a genuine identity-truth fix (§1.2 Q4 of that
// review): trip_authority.trips gains `dispatched_by` (always the caller) and
// `rider_actor` is now NULL for a non-rider dispatcher instead of falsely
// recording the operator/admin as the rider. Certified end-to-end (real RPC
// calls, not just static text) on ephemeral PostgreSQL 17 via
// ci/giro-authority-certification/harness/runB1RiderDispatchOperatorParity.js
// — see MIGRATION_MANIFEST.md row 137 for the run summary.
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
]) {
  assert(`start_rider_trip_v2 keeps the certified literal: ${literal.slice(0, 40)}...`, FWD.includes(literal));
}
assert('SECURITY DEFINER preserved', FWD.includes('SECURITY DEFINER'));
assert('search_path pin preserved (pg_catalog, pg_temp)', FWD.includes('SET search_path = pg_catalog, pg_temp'));

section('IDENTITY TRUTH — dispatched_by always set, rider_actor only for a real rider caller');
assert('trip_authority.trips gains dispatched_by (NOT NULL, FK to auth_actors)',
  /ALTER TABLE trip_authority\.trips ADD COLUMN dispatched_by text NULL REFERENCES public\.auth_actors\(actor\);/.test(FWD) &&
  /ALTER TABLE trip_authority\.trips ALTER COLUMN dispatched_by SET NOT NULL;/.test(FWD));
assert('trip_authority.trips.rider_actor is relaxed to nullable (not silently populated with a false identity)',
  /ALTER TABLE trip_authority\.trips ALTER COLUMN rider_actor DROP NOT NULL;/.test(FWD));
assert('existing rows are backfilled BEFORE the NOT NULL is added (no silent constraint failure)',
  FWD.indexOf('UPDATE trip_authority.trips SET dispatched_by = rider_actor') <
  FWD.indexOf('ALTER COLUMN dispatched_by SET NOT NULL'));
assert('the INSERT writes dispatched_by = the caller, ALWAYS',
  FWD.includes('rider_actor, dispatched_by, anchor_order_uid, giro_id, departed_at, status, seq)') &&
  /VALUES\s*\n\s*\(v_trip_id, v_dates\[1\], v_anchor_sess, CASE WHEN v_by\.role = 'rider' THEN p_actor ELSE NULL END, p_actor,/.test(FWD));
assert('rider_actor is written ONLY when the caller is actually a rider, NULL otherwise',
  FWD.includes("CASE WHEN v_by.role = 'rider' THEN p_actor ELSE NULL END"));
assert('post-condition asserts the CASE expression landed (not just present in a comment)',
  FWD.includes("v_src NOT LIKE '%CASE WHEN v_by.role = ''rider'' THEN p_actor ELSE NULL END%'"));
assert('post-condition asserts dispatched_by is NOT NULL after apply',
  FWD.includes("v_col.is_nullable <> 'NO'") && FWD.includes("dispatched_by"));
assert('post-condition asserts rider_actor is nullable after apply',
  FWD.includes("v_col.is_nullable <> 'YES'") && FWD.includes('rider_actor'));

section('D-3 REPAIR — predecessor / drift guard on the FORWARD migration (mirrors migration 136)');
assert('the forward migration pins migration 135\'s exact installed body by md5(prosrc) before replacing it',
  /IF md5\(v_src\) IS DISTINCT FROM '[0-9a-f]{32}' THEN/.test(FWD));
assert('the pinned predecessor md5 is the independently-verified migration-135 body (8787814e8020b6fa4322d42febc3a78a, len 11366)',
  FWD.includes("'8787814e8020b6fa4322d42febc3a78a'"));
assert('the guard refuses if start_rider_trip_v2 is missing entirely',
  FWD.includes("to_regprocedure('public.start_rider_trip_v2(uuid,text,integer,uuid[])') IS NULL"));
assert('the guard refuses a double-apply (dispatched_by already present)',
  FWD.includes('dispatched_by already exists -- this migration is already applied'));
assert('the guard runs BEFORE the schema change and the CREATE OR REPLACE (real precondition, not decoration)',
  FWD.indexOf('DO $guard$') < FWD.indexOf('ALTER TABLE trip_authority.trips ADD COLUMN dispatched_by'));

section('D-2/D-3 REPAIR — the ROLLBACK is byte-identical to migration 135 and carries its own guard');
const M135_BODY_MARKER_START = "CREATE OR REPLACE FUNCTION public.start_rider_trip_v2(";
function extractFnBody(text, tag) {
  const i = text.indexOf(M135_BODY_MARKER_START);
  const openTag = `AS $${tag}$`;
  const j = text.indexOf(openTag, i);
  const closeTag = `$${tag}$;`;
  const k = text.indexOf(closeTag, j + openTag.length);
  return text.slice(i, k + closeTag.length);
}
const m135Fn = extractFnBody(BASE, 'fn');
const rollbackFn = extractFnBody(RBK, 'fn');
assert('migration 135\'s start_rider_trip_v2 body was found for comparison', m135Fn.length > 1000, `len=${m135Fn.length}`);
assert('the ROLLBACK restores start_rider_trip_v2 BYTE-IDENTICALLY to migration 135 (comments included)',
  rollbackFn === m135Fn);
assert('the rollback carries a predecessor/drift guard (refuses if migration 137 is not applied)',
  RBK.includes('dispatched_by is absent -- migration 137 is not applied'));
assert('the rollback carries a PONR guard (refuses if any operator/admin-dispatched row -- rider_actor NULL -- exists)',
  /SELECT count\(\*\) INTO v_unresolved FROM trip_authority\.trips WHERE rider_actor IS NULL;/.test(RBK) &&
  RBK.includes('would require inventing an identity that was never real'));
assert('the rollback reverses the schema change: drops dispatched_by, restores rider_actor NOT NULL',
  RBK.includes('ALTER TABLE trip_authority.trips DROP COLUMN dispatched_by;') &&
  RBK.includes('ALTER TABLE trip_authority.trips ALTER COLUMN rider_actor SET NOT NULL;'));

section('D-1 REPAIR — the domain-language build gate no longer fails on this packet');
const domainLangSrc = read('scripts/check-domain-language.js');
assert('migration 137\'s ROLLBACK is allowlisted (byte-identical restoration cannot carry an inline suppression)',
  /migrations\\\/2026-09-17_b1_rider_dispatch_operator_parity_v1_migration_137\\\.ROLLBACK\\\.sql/.test(domainLangSrc));
assert('the certification candidate copy of the ROLLBACK is allowlisted too',
  /ci\\\/giro-authority-certification\\\/candidate\\\/giro_authority_b1_rider_dispatch_operator_parity_v1\\\.ROLLBACK\\\.sql/.test(domainLangSrc));
assert('the FORWARD migration is NOT allowlisted (it authors new text, so it must use ordinary inline suppressions)',
  !new RegExp('migrations\\\\/2026-09-17_b1_rider_dispatch_operator_parity_v1_migration_137\\\\.sql\\$').test(domainLangSrc.replace(/\.ROLLBACK/g, '')));

section('D-4 REPAIR — ephemeral-PostgreSQL certification artifacts exist and are wired to the real candidate files');
const CERT_RUNNER_REL = 'ci/giro-authority-certification/harness/runB1RiderDispatchOperatorParity.js';
const CERT_GROUP_REL = 'ci/giro-authority-certification/harness/groups/b1RiderDispatchOperatorParity.js';
const CERT_FWD_REL = 'ci/giro-authority-certification/candidate/giro_authority_b1_rider_dispatch_operator_parity_v1.sql';
const CERT_RBK_REL = 'ci/giro-authority-certification/candidate/giro_authority_b1_rider_dispatch_operator_parity_v1.ROLLBACK.sql';
assert('the certification runner exists', read(CERT_RUNNER_REL) !== null);
assert('the new behavioral scenario group exists', read(CERT_GROUP_REL) !== null);
assert('the certification candidate forward file is byte-identical to the real migration file',
  read(CERT_FWD_REL) === FWD);
assert('the certification candidate rollback file is byte-identical to the real rollback file',
  read(CERT_RBK_REL) === RBK);
assert('the runner stacks on the SAME 130-135 candidate chain migration 135\'s own harness uses (no independent, unverified bootstrap)',
  (read(CERT_RUNNER_REL) || '').includes("await applyThroughMigration134(su)") &&
  (read(CERT_RUNNER_REL) || '').includes("giro_authority_w6_rider_lifecycle_v1.sql"));
assert('the new group proves REAL admin/operator/rider departures, not just static text',
  (read(CERT_GROUP_REL) || '').includes("call(client, 'start_rider_trip_v2'"));
assert('the new group proves money-collection stays refused for admin/operator via a REAL RPC call',
  (read(CERT_GROUP_REL) || '').includes("call(client, 'rider_collect_and_complete_stop'"));

section('POST-CONDITION BLOCK — the migration verifies its own invariant on apply');
assert('a DO $$ post-condition block asserts the widened predicate landed',
  FWD.includes("v_by.role NOT IN (''rider'', ''admin'', ''operator'')") || /pg_get_functiondef[\s\S]{0,400}v_by\.role NOT IN/.test(FWD));
assert('the post-condition also asserts collect stayed untouched',
  FWD.includes('rider_collect_and_complete_stop(text,text,text,integer,text,jsonb,text)'));

section('NO PARALLEL AUTHORITY — the fix stays inside Trip/Giro Authority');
assert('no DRIVER_STATO-only write path is introduced (the existing compatibility projection is untouched, not duplicated)',
  (FWD.match(/UPDATE public\.config SET valore/g) || []).length === 1);
assert('no new TABLE is created (no parallel authority object)', !FWD.includes('CREATE TABLE'));
const alterTableCount = (FWD.match(/ALTER TABLE/g) || []).length;
const alterTripsCount = (FWD.match(/ALTER TABLE trip_authority\.trips/g) || []).length;
assert('every ALTER TABLE statement touches ONLY trip_authority.trips (the dispatched_by/rider_actor identity-truth fix), nothing else',
  alterTableCount > 0 && alterTableCount === alterTripsCount);
assert('no manual_giros table is touched by this migration', !/ALTER TABLE (public\.)?manual_giros/.test(FWD));
assert('the function still writes trip_authority.trips as the ONE canonical trip row (INSERT appears exactly once)',
  (FWD.match(/INSERT INTO trip_authority\.trips/g) || []).length === 1);

console.log(`\nb1RiderDispatchOperatorParityMigration: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
