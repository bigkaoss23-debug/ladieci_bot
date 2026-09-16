'use strict';
// tests/plannerW6RiderLifecycle.static.test.js — Planner W6.3 + W6.4 (canonical rider
// lifecycle + giro projection cutover, migration 135) static guard. OFFLINE: no DB, no
// network. The behavioural certification runs on ephemeral PostgreSQL 17
// (ci/giro-authority-certification/harness/runW6RiderLifecycle.js). This file pins what
// must stay true in the REPOSITORY:
//   * the migration-135 forward/rollback pair exists and the CI candidate copies are
//     byte-identical to it (the harness certifies the same text that ships);
//   * the migration corrects migration 134's partial-departure body, restores the
//     SERVICE_CLOSING gate, makes collect and close canonical-aware while keeping their
//     legacy fallback, adds ONE-TRIP-PER-GIRO, and makes the projection frozen-membership
//     + DEPARTED-salida aware — and touches no money/economy/fiscal object;
//   * riderTrip.startTrip() is the ONE activated canonical departure call site, calls
//     rpc/start_rider_trip_v2 through the literal sbRpc(...) form the H1B registry
//     scanner reads, and never reads actor/session/scope from a client body;
//   * rpc/start_rider_trip_v2 is registered POST-only; rpc/start_rider_trip stays
//     registered as the documented post-PONR rollback target; trip_projection_v1 and the
//     two public trip_authority_* helpers stay UNREGISTERED (no real Node caller);
//   * the diff versus BASE_HEAD contains no frontend path and no unexpected product file.
//
// Run: node tests/plannerW6RiderLifecycle.static.test.js

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => {
  if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); }
};
const section = (t) => console.log('\n── ' + t + ' ──');

const ROOT = path.join(__dirname, '..');
const BASE_HEAD = '4a20c774a6bc6feaf8ef5d061024a3251bdd5794';
const read = (rel) => {
  const p = path.join(ROOT, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
};

const FWD_REL = 'migrations/2026-09-15_planner_w6_rider_lifecycle_cutover_v1_migration_135.sql';
const RBK_REL = 'migrations/2026-09-15_planner_w6_rider_lifecycle_cutover_v1_migration_135.ROLLBACK.sql';
const CAND_FWD_REL = 'ci/giro-authority-certification/candidate/giro_authority_w6_rider_lifecycle_v1.sql';
const CAND_RBK_REL = 'ci/giro-authority-certification/candidate/giro_authority_w6_rider_lifecycle_v1.ROLLBACK.sql';

section('MIGRATION 135 — the pair exists and the certified candidate IS the shipped text');
const FWD = read(FWD_REL);
const RBK = read(RBK_REL);
assert('migration 135 forward file exists', FWD !== null);
assert('migration 135 rollback file exists', RBK !== null);
assert('the CI candidate forward copy is byte-identical to the migration file', read(CAND_FWD_REL) === FWD);
assert('the CI candidate rollback copy is byte-identical to the rollback file', read(CAND_RBK_REL) === RBK);
assert('no other migration number was introduced by this packet',
  !fs.readdirSync(path.join(ROOT, 'migrations')).some((f) => /migration_(12[789]|13[6-9])\./.test(f)));

// The object-defining part of the migration, with `--` line comments stripped and the
// post-condition block removed. The post-conditions legitimately QUOTE the very literals
// the checks below forbid (that is how they assert their own invariants), and the header
// legitimately quotes the migration-134 body it corrects — so a whole-file substring scan
// would report both as violations. Every "this migration must never do X" check runs
// against this executable body instead.
const POST_IDX = FWD.indexOf('-- 11. Post-conditions');
const BODY = (POST_IDX > 0 ? FWD.slice(0, POST_IDX) : FWD).replace(/^\s*--.*$/gm, '');
assert('the post-condition block was located (the executable-body extraction is real)', POST_IDX > 0);

section('W6.3 — the departure correction migration 134 must not have shipped unchanged');
assert('the forward migration freezes the COMPLETE effective member set',
  /v_uids\s*:=\s*d\.effective_order_uids;/.test(BODY));
assert('the forward migration no longer narrows a canonical giro to its LISTO subset',
  !BODY.includes("o.estado = 'LISTO'"));
assert('CANONICAL_GIRO_DEPARTURE_IS_ATOMIC is declared in the migration header',
  FWD.includes('CANONICAL_GIRO_DEPARTURE_IS_ATOMIC'));
assert('the refusal reuses the existing INVALID_STATE code (no new product vocabulary invented)',
  FWD.includes("'code', 'INVALID_STATE'"));
assert('the S2-1H SERVICE_CLOSING gate is restored on the activated path',
  FWD.includes("'code', 'SERVICE_CLOSING'"));
assert('start_rider_trip_v2 no longer locks auth_actors FOR UPDATE (ABBA with collect)',
  !BODY.includes('FROM public.auth_actors WHERE actor = p_actor FOR UPDATE'));
assert('the post-condition enforces the atomic-departure correction',
  FWD.includes('still narrows giro membership to the LISTO subset'));

section('W6.3 — canonical collect and close, with the legacy in-flight fallback intact');
assert('collect resolves membership from the canonical read boundary',
  BODY.includes('public.trip_authority_active_trip_v1()') && BODY.includes("v_canon->'member_order_ids' ? p_order_id"));
assert('collect keeps the legacy DRIVER_STATO membership path for an in-flight trip',
  BODY.includes("v_active->'order_ids' ? p_order_id"));
for (const literal of ['RIDER_STOP_LOST_RACE', "ERRCODE='40001'", 'AUTH_LEGACY_IMPORT_REQUIRED',
  'PAYMENT_REFUSED', 'AUTH_METHOD_INVALID', 'AUTH_FORBIDDEN_ROLE', '_ledger_write_payment']) {
  assert(`collect preserves the certified literal ${literal}`, BODY.includes(literal));
}
assert('the post-condition enforces that collect takes L0 before every other lock',
  FWD.includes('does not take L0 before every other lock'));
assert('close resolves the frozen member set canonically and transitions through the guarded helper',
  BODY.includes('public.trip_authority_close_active_trip_v1'));
assert('close keeps its legacy path verbatim (snapshot validation + last_closed_trip)',
  BODY.includes('INVALID_TRIP_SNAPSHOT') && BODY.includes('last_closed_trip') && BODY.includes('NON_MEMBER_NOOP'));
assert('close keeps its own certified terminal-state list',
  // language-guard: allow-legacy COMPLETATO is close_rider_trip's own pre-135 ordenes.estado terminal literal, cited verbatim, not new vocabulary
  BODY.includes("'RETIRADO', 'COMPLETADO', 'COMPLETATO', 'CANCELADO', 'ANULADO'"));
assert('ONE TRIP PER GIRO is a real partial UNIQUE index on non-null giro_id',
  /CREATE UNIQUE INDEX trips_one_trip_per_giro_v1 ON trip_authority\.trips \(giro_id\) WHERE giro_id IS NOT NULL/.test(BODY));

section('W6.4 — frozen membership after departure, real salida, no calendar logic of its own');
assert('derive_giros_v1 sources effective membership from trip_authority.trip_members',
  BODY.includes('trip_authority.trip_members') && BODY.includes('ctm.uid, ctm.oid FROM ctm'));
assert('progress is derived separately from membership (never by deleting members)',
  BODY.includes('n_outstanding') && BODY.includes('still_out'));
assert('salida_source DEPARTED is produced for a giro with a canonical trip',
  BODY.includes("'DEPARTED'") && BODY.includes('departed_hhmm_v1'));
assert('the Madrid wall clock lives in exactly ONE narrow helper',
  (BODY.match(/Europe\/Madrid/g) || []).length === 1
  && /to_char\(p_departed_at AT TIME ZONE 'Europe\/Madrid'/.test(BODY));
assert('the migration pins that derive_giros_v1 itself gains no calendar/clock logic',
  FWD.includes('gained calendar-day / wall-clock logic of its own'));
assert('the canonical membership fact stops filtering delivered members out',
  FWD.includes('still filters delivered members out of the membership fact'));
assert('hora_ref is never written by this migration', !/UPDATE\s+public\.manual_giros/i.test(BODY));

section('BOUNDARY — no money, economy, fiscal, table or trigger change');
for (const forbidden of ['order_obligations', 'payment_transactions', 'order_financial_events',
  'service_closeouts', 'economic_', 'fiscal']) {
  assert(`the forward migration never touches ${forbidden} in a write`,
    !new RegExp(`(INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+(public\\.)?${forbidden}`, 'i').test(BODY));
}
assert('the forward migration creates or drops no table', !/\bCREATE TABLE\b|\bDROP TABLE\b/.test(BODY));
assert('the forward migration adds or drops no trigger', !/\bCREATE TRIGGER\b|\bDROP TRIGGER\b/.test(BODY));
assert('the forward migration adds or drops no column', !/\bADD COLUMN\b|\bDROP COLUMN\b/.test(BODY));
assert('the private trip_authority schema stays closed to every API role',
  FWD.includes('an API role holds USAGE on schema trip_authority'));
assert('the rollback is PONR-guarded on real canonical trip history',
  RBK.includes('canonical trip row(s) exist') && RBK.includes('PONR'));
assert('the rollback never drops the trip_authority schema or its tables',
  !/DROP SCHEMA/i.test(RBK) && !/DROP TABLE/i.test(RBK));
assert('the rollback re-asserts that every migration-134 object survived',
  RBK.includes('a migration-134 object was removed'));

// The rollback restores two function bodies byte-identically (the harness proves it by
// md5 against the checksums captured live from staging), so an inline language-guard
// marker would land in pg_proc.prosrc and break exactly that. It therefore takes a
// NARROW file-level domain-language exemption instead — the same resolution the
// pre-existing H-1 rollback already uses. The FORWARD migration is NOT exempt.
const DL = read('scripts/check-domain-language.js');
assert('the migration-135 ROLLBACK is the domain-language exemption, and the forward file is not',
  DL.includes('planner_w6_rider_lifecycle_cutover_v1_migration_135') && DL.includes('ROLLBACK'));
assert('the rollback carries no inline language-guard marker inside a restored body',
  !/^-- language-guard/m.test(RBK));

section('ACTIVATION — riderTrip.startTrip is the ONE canonical departure call site');
const RIDER = read('src/agents/riderTrip.js');
assert('startTrip calls sbRpc("start_rider_trip_v2") literally (visible to the H1B registry scanner)',
  /sbRpc\(\s*"start_rider_trip_v2"/.test(RIDER));
assert('riderTrip.js no longer calls the legacy rpc start_rider_trip',
  !/sbRpc\(\s*["']start_rider_trip["']/.test(RIDER));
assert('exactly one start_rider_trip_v2 call site in the whole of src/ + index.js', (() => {
  const files = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (e.name.endsWith('.js')) files.push(p);
  });
  walk(path.join(ROOT, 'src'));
  files.push(path.join(ROOT, 'index.js'));
  let n = 0;
  for (const f of files) n += (fs.readFileSync(f, 'utf8').match(/["']start_rider_trip_v2["']/g) || []).length;
  return n === 1;
})());
assert('startTrip resolves order_uid server-side from the display order id',
  RIDER.includes('p_anchor_order_uid') && /select\(\s*"ordenes"/.test(RIDER));
assert('startTrip resolves the operational scope through the lifecycle authority',
  RIDER.includes('getOperationalSessionIds') && RIDER.includes('p_operational_session_ids'));
assert('startTrip fails closed without a verified rider identity', RIDER.includes('TRIP_CONTEXT_UNAVAILABLE'));
assert('startTrip fails closed on an unresolvable scope', RIDER.includes('SCOPE_UNAVAILABLE'));
assert('startTrip fails closed on an order with no canonical identity', RIDER.includes('ORDER_NOT_CANONICAL'));
assert('every canonical refusal code is mapped to a real HTTP status (never a generic 500)', (() => {
  const need = ['INVALID_INPUT', 'ORDER_NOT_ELIGIBLE', 'ORDER_NOT_FOUND', 'ORDER_NOT_CANONICAL',
    'SCOPE_MISMATCH', 'SCOPE_UNAVAILABLE', 'UNVERIFIABLE', 'TRIP_CONTEXT_UNAVAILABLE',
    'AUTH_FORBIDDEN_ROLE', 'AUTH_SESSION_STALE', 'SERVICE_CLOSING', 'ACTIVE_TRIP_CONFLICT'];
  const map = require('../src/agents/riderTrip').CODE_TO_HTTP;
  return need.every((c) => Number.isInteger(map[c]) && map[c] >= 200 && map[c] < 500);
})());
const INDEX = read('index.js');
assert('index.js passes the VERIFIED actor + session_version into startTrip, never a body field',
  /riderTrip\.startTrip\(body && body\.id, \{ byActor: ctx\.actor, sessionVersion: ctx\.sv \}\)/.test(INDEX));
assert('index.js refuses an unverified departure before calling the RPC',
  /case "marcarEnEntrega"[\s\S]{0,900}?TRIP_CONTEXT_UNAVAILABLE/.test(INDEX));

section('H1B RESOURCE POLICY — exactly the newly-live RPC, nothing speculative');
const policy = require('../src/utils/supabaseResourcePolicy');
assert('rpc/start_rider_trip_v2 is registered', policy.getResourcePolicy('rpc/start_rider_trip_v2') !== null);
assert('rpc/start_rider_trip_v2 allows POST', policy.isMethodAllowed('rpc/start_rider_trip_v2', 'POST'));
assert('rpc/start_rider_trip_v2 denies GET', !policy.isMethodAllowed('rpc/start_rider_trip_v2', 'GET'));
assert('rpc/start_rider_trip (v1) stays registered as the documented post-PONR rollback target',
  policy.getResourcePolicy('rpc/start_rider_trip') !== null);
// W6.5 — Planner final backend canonicalization gave trip_projection_v1 its first
// REAL Node callers (plannerSnapshot.js's canonical rider block and riderReads.js's
// operational rider read), so it is registered there and certified by
// tests/plannerW65FinalBackendV1.static.test.js. The invariant this section guards
// is unchanged and still enforced below: a resource is registered only once
// something actually calls it, never speculatively.
const W6_5_STATIC_GUARD = path.join(ROOT, 'tests', 'plannerW65FinalBackendV1.static.test.js');
const w65Applied = fs.existsSync(W6_5_STATIC_GUARD);
if (w65Applied) {
  assert('rpc/trip_projection_v1 is registered by W6.5, which supplies its real Node callers',
    policy.getResourcePolicy('rpc/trip_projection_v1') !== null);
} else {
  assert('rpc/trip_projection_v1 stays UNREGISTERED (no real Node caller)',
    policy.getResourcePolicy('rpc/trip_projection_v1') === null);
}
for (const speculative of ['rpc/trip_authority_active_trip_v1',
  'rpc/trip_authority_close_active_trip_v1']) {
  assert(`${speculative} stays UNREGISTERED (no real Node caller)`, policy.getResourcePolicy(speculative) === null);
}

section('DIFF SCOPE — no frontend, no unexpected product file');
const DECLARED = new Set([
  FWD_REL, RBK_REL, CAND_FWD_REL, CAND_RBK_REL,
  'migrations/MIGRATION_MANIFEST.md',
  'ci/giro-authority-certification/harness/runW6RiderLifecycle.js',
  'ci/giro-authority-certification/harness/groups/w6RiderLifecycle.js',
  // W6.2's own group, narrowly maintained: its case 12 relied on the partial departure
  // migration 135 forbids. Documented in place, lock-ordering assertions unchanged.
  'ci/giro-authority-certification/harness/groups/w6TripAuthority.js',
  'src/agents/riderTrip.js',
  'src/utils/supabaseResourcePolicy.js',
  'index.js',
  // Narrow, file-level domain-language exemption for the ROLLBACK only (see above).
  'scripts/check-domain-language.js',
  // W6.5 Planner Final Backend Canonicalization — the packet that ACTIVATES the
  // Trip Authority projection in Node (and deletes the legacy it supersedes).
  // Certified by tests/plannerW65FinalBackendV1.static.test.js.
  ...(w65Applied ? [
    'src/core/delivery/tripProjectionReader.js',
    'src/core/delivery/tripProjectionPort.js',
    'src/core/delivery/planner.js',
    'src/core/delivery/plannerSnapshot.js',
    'src/core/delivery/readOnlyRestDb.js',
    'src/core/delivery/giroFactsPort.js',
    'src/agents/riderReads.js',
  ] : []),
  // Planner W6.6 — Trip Operational HTTP wire bridge: a later, separately-
  // authorized packet exposing the Trip Authority projection over HTTP for
  // the first time (getTripOperationalState). New action registration
  // mandatorily touches the 4-file auth-registry pattern plus its own new
  // pure module. No DB/economy/frontend change accompanies it.
  'src/core/delivery/tripOperationalState.js',
  'src/auth/legacyActionRoles.js',
  'src/auth/authorizationContract.js',
  'src/auth/actionPolicyRegistry.js',
  'docs/access-control/B4_AUTHORIZATION_CONTRACT.md',
]);
let changed = [];
try {
  changed = execSync(`git diff --name-only ${BASE_HEAD}`, { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map((l) => l.trim()).filter(Boolean);
} catch (e) {
  changed = ['<git diff failed: ' + (e && e.message) + '>'];
}
const fe = changed.filter((f) => /frontend|ladieci-app33/i.test(f));
assert('zero frontend-path changes in this packet\'s diff', fe.length === 0, fe.join(', '));
const unexpected = changed.filter((f) => !DECLARED.has(f) && !f.startsWith('tests/'));
assert('every non-test changed file is on this packet\'s declared allowlist',
  unexpected.length === 0, unexpected.join(', '));

console.log(`\nplannerW6RiderLifecycle.static: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
