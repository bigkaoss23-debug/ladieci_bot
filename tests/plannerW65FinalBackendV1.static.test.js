'use strict';
// tests/plannerW65FinalBackendV1.static.test.js — Planner W6.5 (final backend
// canonicalization + legacy cleanup) static guard. OFFLINE: no DB, no network.
//
// W6.5 replaced the last two legacy internals on the live operational path and
// deleted what they superseded. This file pins what must stay true in the
// REPOSITORY:
//   * NO database change: no migration 136, no DDL, no new persisted fact;
//   * Stage M (the `manual_route` rider block) is GONE from planner.js, and the
//     raw `manual_giros` read that fed it is GONE from plannerSnapshot.js and
//     from readOnlyRestDb.js's table allowlist;
//   * the canonical rider block comes from Trip Authority (trip_projection_v1)
//     via the new pure reader/port pair, and nothing re-derives it from a raw
//     current-Giro read;
//   * riderReads.js no longer reads DRIVER_STATO — Trip Authority is the
//     post-departure authority;
//   * giroFactsPort.js (the W2 shim superseded by giroProjectionPort.js) is
//     DELETED and nothing resurrects it;
//   * rpc/trip_projection_v1 is registered POST-only (it now has real callers);
//     the two public trip_authority_* helpers stay UNREGISTERED (still none);
//   * NO ETA is fabricated: the ETA contract publishes UNKNOWN/DEGRADED and
//     never an arrival timestamp;
//   * no money/economy/fiscal object and no frontend path is touched.
//
// Run: node tests/plannerW65FinalBackendV1.static.test.js

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
const BASE_HEAD = 'd6a0ca18c7a5a833cf600ba51dda4e891442be54';
const read = (rel) => {
  const p = path.join(ROOT, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
};
// Executable code only: `//` line comments stripped. Every "must no longer
// contain X" check below runs on this, because the headers legitimately
// DESCRIBE the very legacy they removed.
const jsCode = (src) => String(src || '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

const PLANNER = 'src/core/delivery/planner.js';
const SNAPSHOT = 'src/core/delivery/plannerSnapshot.js';
const RESTDB = 'src/core/delivery/readOnlyRestDb.js';
const RIDER_READS = 'src/agents/riderReads.js';
const TRIP_READER = 'src/core/delivery/tripProjectionReader.js';
const TRIP_PORT = 'src/core/delivery/tripProjectionPort.js';
const GIRO_FACTS_PORT = 'src/core/delivery/giroFactsPort.js';

// ───────────────────────────────────────────────────────────────────────────
section('DATABASE SCOPE — W6.5 is a pure JS packet (MIGRATION_136_REQUIRED = NO)');
const migrations = fs.readdirSync(path.join(ROOT, 'migrations'));
assert('no migration 136 (or any new number) was introduced',
  !migrations.some((f) => /migration_(12[789]|13[6-9]|1[4-9]\d)\./.test(f)),
  migrations.filter((f) => /migration_(12[789]|13[6-9]|1[4-9]\d)\./.test(f)).join(', '));
let changedAll = [];
try {
  changedAll = execSync(`git diff --name-only ${BASE_HEAD}`, { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map((l) => l.trim()).filter(Boolean);
} catch (e) {
  changedAll = ['<git diff failed: ' + (e && e.message) + '>'];
}
const sqlTouched = changedAll.filter((f) => /\.sql$/i.test(f) || f.startsWith('migrations/'));
assert('zero .sql / migrations/ files changed', sqlTouched.length === 0, sqlTouched.join(', '));

// ───────────────────────────────────────────────────────────────────────────
section('STAGE M — deleted, not repaired');
const plannerCode = jsCode(read(PLANNER));
assert('planner.js has no manual_route type check left in executable code',
  !/manual_route/.test(plannerCode));
assert('planner.js no longer reads snapshot.manual_giros',
  !/manual_giros/.test(plannerCode));
assert('buildRiderBlock() is gone', !/buildRiderBlock/.test(plannerCode));
assert('estimateRouteDuration() is gone', !/estimateRouteDuration/.test(plannerCode));
assert('the Stage-M-only cfg knobs are gone (riderBlockDurMismatch*/riderBlockEarlyTolerance*)',
  !/riderBlockDurMismatch|riderBlockEarlyTolerance/.test(plannerCode));
assert('planner.js builds its rider block from the canonical active trip',
  /buildActiveTripBlock/.test(plannerCode) && /active_trip/.test(plannerCode));
assert('planner.js declares post-departure membership immutable',
  /immutable_membership/.test(plannerCode));
assert('planner.js surfaces an explicit degraded state instead of an idle rider',
  /active_trip_unavailable/.test(plannerCode));

// ───────────────────────────────────────────────────────────────────────────
section('RAW manual_giros READ — removed from the planner snapshot path');
const snapCode = jsCode(read(SNAPSHOT));
assert('plannerSnapshot.js never selects manual_giros', !/manual_giros/.test(snapCode));
assert('plannerSnapshot.js declares no Stage-M column list',
  !/route_order|block_start|manual_duration_min|created_by_operator/.test(snapCode));
assert('plannerSnapshot.js reads the canonical Trip Authority projection',
  /readTripProjection/.test(snapCode) && /activeTripFacts/.test(snapCode));
const restCode = jsCode(read(RESTDB));
assert('readOnlyRestDb.js no longer allowlists the manual_giros table',
  !/manual_giros/.test(restCode));
assert('readOnlyRestDb.js still allowlists ordenes (the one table the planner reads)',
  /ordenes:\s*new Set/.test(restCode));

// ───────────────────────────────────────────────────────────────────────────
section('DRIVER_STATO — not the canonical authority for the rider read');
const riderCode = jsCode(read(RIDER_READS));
assert('riderReads.js contains no DRIVER_STATO read in executable code',
  !/DRIVER_STATO/.test(riderCode));
assert('riderReads.js resolves trip mode from Trip Authority',
  /readTripProjection/.test(riderCode) && /activeTripFacts/.test(riderCode));
assert('riderReads.js in-trip read is bounded by order_uid, not an unscoped scan',
  /order_uid=in\.\(/.test(riderCode));
assert('riderReads.js still fails CLOSED on untrustworthy trip facts',
  /rider_read_unavailable/.test(riderCode));

// ───────────────────────────────────────────────────────────────────────────
section('DEAD CODE — superseded files deleted, nothing resurrects them');
assert('giroFactsPort.js is deleted', !fs.existsSync(path.join(ROOT, GIRO_FACTS_PORT)));
const srcFiles = (function walk(dir, acc) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith('.js')) acc.push(p);
  }
  return acc;
})(path.join(ROOT, 'src'), []).concat([path.join(ROOT, 'index.js')]);
const resurrectors = srcFiles.filter((f) => /require\([^)]*giroFactsPort/.test(fs.readFileSync(f, 'utf8')));
assert('no src/** or index.js file requires giroFactsPort', resurrectors.length === 0, resurrectors.join(', '));

// ───────────────────────────────────────────────────────────────────────────
section('NEW CANONICAL MODULES — a reader that only does I/O, a port that only does logic');
const tripReaderCode = jsCode(read(TRIP_READER));
const tripPortCode = jsCode(read(TRIP_PORT));
assert('tripProjectionReader.js calls rpc("trip_projection_v1", ...) and nothing else',
  /rpc\(\s*"trip_projection_v1"/.test(tripReaderCode));
assert('tripProjectionReader.js reads no raw giro/driver legacy fact',
  !/manual_giro_id|manual_giros|DRIVER_STATO|salida_ref|dissolved_at/.test(tripReaderCode));
assert('tripProjectionReader.js fails closed to null (never a fabricated trip)',
  /return null/.test(tripReaderCode));
assert('tripProjectionPort.js is PURE: no I/O, no supabase, no reader import',
  !/require\([^)]*supabase|require\([^)]*Reader|sbSelect|sbRpc/.test(tripPortCode));
assert('tripProjectionPort.js reads no raw giro/driver legacy fact',
  !/manual_giro_id|manual_giros|DRIVER_STATO/.test(tripPortCode));
assert('tripProjectionPort.js derives frozen membership from trip members only',
  /frozen_member_order_uids/.test(tripPortCode) && /effective_members/.test(tripPortCode) === false);

// ───────────────────────────────────────────────────────────────────────────
section('ETA — an honest contract, never a fabricated arrival time');
const port = require('../src/core/delivery/tripProjectionPort');
assert('ETA_STATUS offers only UNKNOWN and DEGRADED',
  JSON.stringify(Object.keys(port.ETA_STATUS).sort()) === JSON.stringify(['DEGRADED', 'UNKNOWN']),
  JSON.stringify(port.ETA_STATUS));
const etaNoTrip = port.tripEtaContract(null);
assert('no active trip -> UNKNOWN with a machine-readable reason',
  etaNoTrip.eta_status === 'UNKNOWN' && etaNoTrip.eta_reason === 'NO_ACTIVE_TRIP');
const liveFacts = port.activeTripFacts({
  projection: {
    ok: true, active: true, trip_id: 't', giro_id: 'g', anchor_order_uid: 'u1',
    departed_at: '2026-09-16T18:00:00Z', members: [{ order_uid: 'u1', stop_seq: 1 }],
  },
  nowIso: '2026-09-16T18:30:00Z',
});
assert('a real, fully-known trip STILL returns UNKNOWN (no provider invents an arrival)',
  liveFacts.eta.eta_status === 'UNKNOWN' && liveFacts.eta.eta_reason === 'NO_ARRIVAL_ESTIMATE_PROVIDER',
  JSON.stringify(liveFacts.eta));
assert('the ETA payload carries only real facts (elapsed/counts), never an arrival field',
  liveFacts.eta.elapsed_min === 30 &&
  !Object.keys(liveFacts.eta).some((k) => /arriv|eta_at|estimated_at|eta_time/i.test(k)),
  JSON.stringify(Object.keys(liveFacts.eta)));
const degraded = port.activeTripFacts({ projection: null });
assert('unavailable projection -> DEGRADED, never active:false in disguise',
  degraded.available === false && degraded.active === false && degraded.degraded === true &&
  degraded.eta.eta_status === 'DEGRADED' && degraded.reason === 'TRIP_PROJECTION_MISSING',
  JSON.stringify(degraded.reason));
const scopeGone = port.activeTripFacts({ projection: { ok: false, code: 'SCOPE_UNAVAILABLE' } });
assert('scope-invalid projection -> DEGRADED with its own reason',
  scopeGone.available === false && scopeGone.reason === 'SCOPE_UNAVAILABLE');

// ───────────────────────────────────────────────────────────────────────────
section('FROZEN MEMBERSHIP — never shrinks, never re-derived from the Giro');
const frozen = port.activeTripFacts({
  projection: {
    ok: true, active: true, trip_id: 't', giro_id: 'g', anchor_order_uid: 'u1',
    departed_at: '2026-09-16T18:00:00Z',
    members: [{ order_uid: 'u1', stop_seq: 1 }, { order_uid: 'u2', stop_seq: 2 }],
  },
  ordersByUid: new Map([
    ['u1', { id: '#1', estado: 'RETIRADO' }],   // completed
    ['u2', { id: '#2', estado: 'EN_ENTREGA' }], // outstanding
  ]),
});
assert('a completed stop stays in the frozen membership',
  JSON.stringify(frozen.trip.frozen_member_order_ids) === JSON.stringify(['#1', '#2']),
  JSON.stringify(frozen.trip.frozen_member_order_ids));
assert('outstanding / completed are reported separately',
  JSON.stringify(frozen.trip.completed_member_order_ids) === JSON.stringify(['#1']) &&
  JSON.stringify(frozen.trip.outstanding_member_order_ids) === JSON.stringify(['#2']));
assert('current_stop is the first outstanding stop, by stop_seq',
  frozen.trip.current_stop && frozen.trip.current_stop.order_id === '#2');
const allDone = port.activeTripFacts({
  projection: {
    ok: true, active: true, trip_id: 't', giro_id: null, anchor_order_uid: 'u1',
    departed_at: '2026-09-16T18:00:00Z',
    members: [{ order_uid: 'u1', stop_seq: 1 }, { order_uid: 'u2', stop_seq: 2 }],
  },
  ordersByUid: new Map([['u1', { id: '#1', estado: 'RETIRADO' }], ['u2', { id: '#2', estado: 'RETIRADO' }]]),
});
assert('all stops completed still preserves the frozen membership',
  allDone.trip.stops_total === 2 && allDone.trip.stops_remaining === 0 &&
  JSON.stringify(allDone.trip.frozen_member_order_ids) === JSON.stringify(['#1', '#2']));
assert('a member with no resolvable order row is counted, never dropped',
  port.activeTripFacts({
    projection: {
      ok: true, active: true, trip_id: 't', giro_id: null, anchor_order_uid: 'u1',
      departed_at: '2026-09-16T18:00:00Z', members: [{ order_uid: 'u9', stop_seq: 1 }],
    },
  }).trip.unresolved_member_count === 1);
assert('the rider is reported as explicitly unknown, never inferred',
  frozen.trip.rider_known === false && frozen.trip.rider_actor === null);

// ───────────────────────────────────────────────────────────────────────────
section('H1B RESOURCE POLICY — exactly the newly-live RPC, nothing speculative');
const policy = require('../src/utils/supabaseResourcePolicy');
assert('rpc/trip_projection_v1 is registered (it now has real Node callers)',
  policy.getResourcePolicy('rpc/trip_projection_v1') !== null);
assert('rpc/trip_projection_v1 allows POST', policy.isMethodAllowed('rpc/trip_projection_v1', 'POST'));
assert('rpc/trip_projection_v1 denies GET', !policy.isMethodAllowed('rpc/trip_projection_v1', 'GET'));
assert('rpc/trip_projection_v1 denies DELETE', !policy.isMethodAllowed('rpc/trip_projection_v1', 'DELETE'));
assert('rpc/trip_projection_v1 is INTERNAL_OPERATIONAL',
  policy.getResourcePolicy('rpc/trip_projection_v1').sensitivity === 'INTERNAL_OPERATIONAL');
for (const speculative of ['rpc/trip_authority_active_trip_v1', 'rpc/trip_authority_close_active_trip_v1']) {
  assert(`${speculative} stays UNREGISTERED (still no real Node caller)`,
    policy.getResourcePolicy(speculative) === null);
}

// ───────────────────────────────────────────────────────────────────────────
section('NO MONEY, NO ECONOMY, NO FISCAL, NO FRONTEND');
const forbidden = changedAll.filter((f) =>
  /^src\/(economy|financial|cash|closeout)\//.test(f) || /fiscal/i.test(f));
assert('zero economy/financial/cash/closeout/fiscal files changed', forbidden.length === 0, forbidden.join(', '));
const fe = changedAll.filter((f) => /frontend|ladieci-app33|\.jsx$/i.test(f));
assert('zero frontend-path changes', fe.length === 0, fe.join(', '));
for (const rel of [PLANNER, SNAPSHOT, RIDER_READS, TRIP_PORT, TRIP_READER]) {
  const code = jsCode(read(rel));
  assert(`${rel} writes nothing (no sbInsert/sbUpdate/sbUpsert/sbDelete)`,
    !/sbInsert|sbUpdate|sbUpsert|sbDelete/.test(code));
}

// ───────────────────────────────────────────────────────────────────────────
section('DIFF SCOPE — every non-test change is a declared W6.5 product file');
const DECLARED = new Set([
  TRIP_READER, TRIP_PORT,        // new canonical modules
  PLANNER, SNAPSHOT, RESTDB,     // Stage-M replacement + its read path
  RIDER_READS,                   // operational rider read cutover
  GIRO_FACTS_PORT,               // DELETED (git reports it as changed)
  'src/utils/supabaseResourcePolicy.js', // rpc/trip_projection_v1 registration
  'index.js',                    // comment-only: names the new authority
]);
const unexpected = changedAll.filter((f) => !DECLARED.has(f) && !f.startsWith('tests/'));
assert('every non-test changed file is on this packet\'s declared allowlist',
  unexpected.length === 0, unexpected.join(', '));

console.log(`\nplannerW65FinalBackendV1.static: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
