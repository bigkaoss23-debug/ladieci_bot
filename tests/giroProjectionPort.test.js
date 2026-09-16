'use strict';
// tests/giroProjectionPort.test.js — Planner W3: the prepared projection adapter.
// PURE, offline. Proves the mapping giro_projection_v1 -> GiroFacts and that it
// composes with the UNCHANGED W2 core (computeTimingAssessmentV3). No cutover: the
// module is required by nothing live (pinned by the W3 static guard).
//
// Run: node tests/giroProjectionPort.test.js

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://stub.local';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'stub-service-role-key';

const fs = require('fs');
const path = require('path');
const port = require('../src/core/delivery/giroProjectionPort');
const { computeTimingAssessmentV3 } = require('../src/core/delivery/timingAssessmentV3');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => {
  if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + (typeof d === 'string' ? d : JSON.stringify(d)) : '')); }
};
const section = (t) => console.log('\n── ' + t + ' ──');

const ordersById = new Map([
  ['#A', { zona: 'Q5' }], ['#B', { zona: 'Q5' }], ['#C', { zona: 'Q4' }], ['#D', { zona: 'Q3' }],
]);
const P = {
  contract: 'giro_projection_v1', scope_valid: true, degraded: false,
  giros: [
    { giro_id: 'mg_1', giro_state: 'PLANNED', salida: '21:10', effective_members: [{ order_uid: 'u-a', order_id: '#A' }, { order_uid: 'u-b', order_id: '#B' }] },
    { giro_id: 'mg_2', giro_state: 'IN_TRIP', salida: '20:30', effective_members: [{ order_uid: 'u-c', order_id: '#C' }] },
    { giro_id: 'mg_3', giro_state: 'DONE', salida: '19:00', effective_members: [] },
    { giro_id: 'mg_4', giro_state: 'DISSOLVED', salida: null, effective_members: [] },
    { giro_id: 'mg_5', giro_state: 'PLANNED', salida: '00:10', effective_members: [{ order_uid: 'u-d', order_id: '#D' }, { order_uid: 'u-a2', order_id: '#A' }] },
  ],
  orders: [
    { order_uid: 'u-a', order_id: '#A', effective_giro_id: 'mg_1' },
    { order_uid: 'u-b', order_id: '#B', effective_giro_id: 'mg_1' },
    { order_uid: 'u-c', order_id: '#C', effective_giro_id: 'mg_2' },
  ],
};

section('AVAILABILITY — an untrusted projection yields no giro facts (DEGRADED, never a guess)');
let f = port.projectionGiroFacts({ projection: null, intendedGiroId: 'mg_1' });
assert('missing projection -> available=false PROJECTION_MISSING, no intended giro', f.available === false && f.unavailableReason === 'PROJECTION_MISSING' && f.intendedGiro === null);
f = port.projectionGiroFacts({ projection: { scope_valid: false, giros: [] }, intendedGiroId: 'mg_1' });
assert('invalid scope -> scopeAvailable=false (W2 emits SCOPE_UNAVAILABLE)', f.available === false && f.scopeAvailable === false && f.unavailableReason === 'SCOPE_UNAVAILABLE');
f = port.projectionGiroFacts({ projection: { ...P, degraded: true }, intendedGiroId: 'mg_1' });
assert('degraded trip facts -> available=false TRIP_FACTS_UNAVAILABLE', f.available === false && f.unavailableReason === 'TRIP_FACTS_UNAVAILABLE' && f.intendedGiro === null);

section('MAPPING — projection state -> GiroFacts status');
const ig = (id, extra = {}) => port.projectionGiroFacts({ projection: P, intendedGiroId: id, newOrderZona: 'Q2', ordersById, ...extra }).intendedGiro;
assert('PLANNED -> VALID', ig('mg_1').status === 'VALID');
assert('PLANNED Q5 giro + Q2 draft (same sur channel) -> absorbsOverlap=true', ig('mg_1').absorbsOverlap === true, ig('mg_1'));
assert('PLANNED Q5 giro + Q3 draft (oeste vs sur) -> absorbsOverlap=false',
  port.projectionGiroFacts({ projection: P, intendedGiroId: 'mg_1', newOrderZona: 'Q3', ordersById }).intendedGiro.absorbsOverlap === false);
assert('estimatedSalidaMin = projection salida in service-day minutes (21:10 -> 1270)', ig('mg_1').estimatedSalidaMin === 1270);
assert('after midnight: salida 00:10 -> 1450 (service day, not clock)', ig('mg_5').estimatedSalidaMin === 1450);
assert('IN_TRIP -> DEPARTED', ig('mg_2').status === 'DEPARTED');
assert('DONE -> DEPARTED', ig('mg_3').status === 'DEPARTED');
assert('DISSOLVED -> GONE', ig('mg_4').status === 'GONE');
assert('unknown giro -> GONE', ig('mg_404').status === 'GONE');
assert('effective members differ from what the operator saw -> CHANGED', ig('mg_1', { expectedMemberIds: ['#A'] }).status === 'CHANGED');
assert('same members (any order) -> VALID', ig('mg_1', { expectedMemberIds: ['#B', '#A'] }).status === 'VALID');
f = port.projectionGiroFacts({ projection: P, newOrderZona: 'Q2', ordersById });
assert('no intended giro + a compatible PLANNED giro -> compatibleGiroAvailable=true', f.intendedGiro === null && f.compatibleGiroAvailable === true);
f = port.projectionGiroFacts({ projection: { ...P, giros: P.giros.filter((g) => g.giro_state !== 'PLANNED') }, newOrderZona: 'Q2', ordersById });
assert('no PLANNED giro -> compatibleGiroAvailable=false (IN_TRIP/DONE never offered)', f.compatibleGiroAvailable === false);

section('COMPATIBILITY ALIAS — only the effective giro id, never a raw membership');
const alias = port.effectiveGiroIdByOrderId(P);
assert('effective members map to their effective giro', alias.get('#A') === 'mg_1' && alias.get('#C') === 'mg_2');
assert('an order absent from the projection has no giro id', alias.get('#Z') === undefined);
assert('unavailable projection -> empty alias map (visible "no giro", never a phantom)', port.effectiveGiroIdByOrderId({ scope_valid: false, giros: [] }).size === 0);

section('W2 BOUNDARY — composes with the unchanged timingAssessmentV3 core');
const base = { asOfMin: 1200, newOrder: { horaMin: 1290, zona: 'Q2' }, standaloneRetrasoMin: 20,
  driver: { state: 'FREE' }, newOrderSalidaMin: null, geoDurationAvailable: true };
const run = (facts) => computeTimingAssessmentV3({ ...base, ...facts });
let gf = port.projectionGiroFacts({ projection: P, intendedGiroId: 'mg_1', newOrderZona: 'Q2', ordersById });
let out = run({ intendedGiro: gf.intendedGiro, compatibleGiroAvailable: gf.compatibleGiroAvailable, scopeAvailable: gf.scopeAvailable });
assert('VALID absorbing giro -> intended_giro VALID + GIRO_ABSORBS_OVERLAP', out.intended_giro && out.intended_giro.status === 'VALID' &&
  out.reasons.some((r) => r.code === 'GIRO_ABSORBS_OVERLAP'), out.reasons.map((r) => r.code));
gf = port.projectionGiroFacts({ projection: P, intendedGiroId: 'mg_2', newOrderZona: 'Q2', ordersById });
out = run({ intendedGiro: gf.intendedGiro, scopeAvailable: gf.scopeAvailable });
assert('IN_TRIP giro -> INTENT_TARGET_DEPARTED, can_apply=false', out.intended_giro.can_apply === false && out.reasons.some((r) => r.code === 'INTENT_TARGET_DEPARTED'));
gf = port.projectionGiroFacts({ projection: { scope_valid: false, giros: [] }, intendedGiroId: 'mg_1' });
out = run({ intendedGiro: gf.intendedGiro, scopeAvailable: gf.scopeAvailable });
assert('invalid scope -> SCOPE_UNAVAILABLE reason and degraded=true', out.degraded === true && out.reasons.some((r) => r.code === 'SCOPE_UNAVAILABLE'));

section('W6.6 FINAL CLEANUP — canonicalDepartedOrderIds: the one giro fact that survives its own trip closing');
const DEPARTED_P = {
  contract: 'giro_projection_v1', scope_valid: true, degraded: false,
  giros: [
    // linked to a real canonical trip (IN_TRIP or DONE, salida_source DEPARTED) -- included
    { giro_id: 'mg_d1', giro_state: 'IN_TRIP', salida: '20:00', salida_source: 'DEPARTED',
      effective_members: [{ order_uid: 'u-a', order_id: '#A' }, { order_uid: 'u-b', order_id: '#B' }] },
    { giro_id: 'mg_d2', giro_state: 'DONE', salida: '19:00', salida_source: 'DEPARTED',
      effective_members: [{ order_uid: 'u-c', order_id: '#C' }] },
    // operator-planned salida (no canonical trip) -- never departed, excluded
    { giro_id: 'mg_p1', giro_state: 'PLANNED', salida: '21:00', salida_source: 'OPERATOR',
      effective_members: [{ order_uid: 'u-d', order_id: '#D' }] },
    // dissolved -- excluded regardless of any stale salida_source
    { giro_id: 'mg_x1', giro_state: 'DISSOLVED', salida: null, salida_source: 'NONE',
      effective_members: [] },
  ],
  orders: [],
};
assert('DEPARTED giros contribute their effective members, in order', JSON.stringify(port.canonicalDepartedOrderIds(DEPARTED_P)) === JSON.stringify(['#A', '#B', '#C']));
assert('OPERATOR/PLANNED salida never counts as departed', !port.canonicalDepartedOrderIds(DEPARTED_P).includes('#D'));
assert('DISSOLVED giro never counts, whatever its stale salida_source', !port.canonicalDepartedOrderIds(DEPARTED_P).includes('#Z'));
assert('unavailable projection -> empty (fail closed, never a guessed departure)', port.canonicalDepartedOrderIds({ scope_valid: false, giros: [] }).length === 0);
assert('null projection -> empty', port.canonicalDepartedOrderIds(null).length === 0);
assert('degraded projection -> empty', port.canonicalDepartedOrderIds({ ...DEPARTED_P, degraded: true }).length === 0);
assert('a giro with no effective_members contributes nothing, never throws', port.canonicalDepartedOrderIds({ scope_valid: true, degraded: false, giros: [{ giro_id: 'mg_e', giro_state: 'DONE', salida_source: 'DEPARTED' }] }).length === 0);

section('PURITY — no I/O, no clock, no raw membership, not wired');
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'delivery', 'giroProjectionPort.js'), 'utf8');
const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
assert('no supabase / fetch / sbRpc / process.env / Date.now in the adapter',
  !/require\([^)]*supabase|fetch\(|sbRpc|sbSelect|process\.env|Date\.now/.test(code));
assert('no manual_giro_id / pending_giro_intent / salida_ref in the adapter', !/manual_giro_id|pending_giro_intent|salida_ref/.test(code));

console.log('\n═══ RESULT: ' + pass + ' passed, ' + fail + ' failed ═══');
process.exit(fail === 0 ? 0 : 1);
