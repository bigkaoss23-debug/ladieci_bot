'use strict';
// tests/plannerSnapshotW4FinalCutover.test.js — Final W4 Read-Cutover Packet.
// Run: node tests/plannerSnapshotW4FinalCutover.test.js
//
// plannerSnapshot.js is the ONLY product file this packet touches. Canonical
// giro membership (manual_giro_id alias) is resolved HERE, once, from the
// Projection -- planner.js and previewStrategicOpportunities.js receive the
// canonical alias transparently and are NOT modified. Historical-day requests
// keep the exact byte-for-byte pre-cutover raw path (never a fallback).

const path = require('path');

let pass = 0, fail = 0;
function check(label, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`); }
}
function section(t) { console.log('\n── ' + t + ' ──'); }

// ── stub installation (require.cache, BEFORE requiring plannerSnapshot.js) ──
// Single closures over shared mutable state -- never reassign the exported
// function reference after plannerSnapshot.js has destructured it.
let STUB_CURRENT_BUSINESS_DATE = '2026-09-15';
let STUB_CURRENT_BUSINESS_DATE_THROWS = false;
let currentBusinessDateCallCount = 0;

let STUB_PROJECTION = null; // null => readGiroProjection() resolves null (unavailable)
let STUB_PROJECTION_THROWS = false;
let projectionCallCount = 0;

const sessionsPath = require.resolve('../src/serviceSessions/currentOperationalSession');
require.cache[sessionsPath] = {
  id: sessionsPath,
  filename: sessionsPath,
  loaded: true,
  exports: {
    async getCurrentOperationalBusinessDate() {
      currentBusinessDateCallCount++;
      if (STUB_CURRENT_BUSINESS_DATE_THROWS) throw new Error('stub_current_business_date_failed');
      return STUB_CURRENT_BUSINESS_DATE;
    },
    // unused by plannerSnapshot.js but present on the real module's surface
    async getCurrentOperationalSession() { return null; },
    async getOperationalSessionIds() { return []; },
    async getPriorDayCarryoverSessionIds() { return []; },
    serviceSessionQuery: () => '',
    serviceSessionsQuery: () => '',
  },
};

const readerPath = require.resolve('../src/core/delivery/giroProjectionReader');
require.cache[readerPath] = {
  id: readerPath,
  filename: readerPath,
  loaded: true,
  exports: {
    async readGiroProjection() {
      projectionCallCount++;
      if (STUB_PROJECTION_THROWS) throw new Error('stub_projection_read_failed');
      return STUB_PROJECTION;
    },
  },
};

const { loadPlannerSnapshot, _internal } = require('../src/core/delivery/plannerSnapshot');
const { buildAnchorsFromSnapshot } = require('../src/agents/previewStrategicOpportunities');
const { buildPlan } = require('../src/core/delivery/planner');

// ── fixtures ──────────────────────────────────────────────────────────────

function makeAvailableProjection({ ordersToGiro = {} } = {}) {
  // ordersToGiro: { order_id: giro_id|null }. Builds a minimal-but-real
  // giro_projection_v1 body shape (contract/scope_valid/degraded/giros/orders/intents).
  const giroIds = [...new Set(Object.values(ordersToGiro).filter(Boolean))];
  return {
    contract: 'giro_projection_v1',
    scope_valid: true,
    degraded: false,
    giros: giroIds.map((gid) => ({
      giro_id: gid, seq: 1, business_date: STUB_CURRENT_BUSINESS_DATE,
      giro_state: 'PLANNED', state_reason: null,
      hora_ref: null, salida: null, salida_source: null,
      effective_members: Object.entries(ordersToGiro)
        .filter(([, g]) => g === gid)
        .map(([oid]) => ({ order_uid: 'uid-' + oid, order_id: oid })),
      anchor_order_uid: null, created_at: null, created_by: null,
      dissolved_at: null, dissolved_by: null,
    })),
    orders: Object.entries(ordersToGiro)
      .filter(([, g]) => g)
      .map(([oid, gid]) => ({ order_uid: 'uid-' + oid, order_id: oid, effective_giro_id: gid })),
    intents: [],
  };
}

function stubDb(orderRows, giroRows) {
  return {
    select: async (table) => (table === 'ordenes' ? orderRows : table === 'manual_giros' ? giroRows : []),
  };
}

function mkOrder(id, overrides = {}) {
  // language-guard: allow-legacy tipo_consegna is the existing ordenes field name, reproduced verbatim once here so every fixture below can omit it
  return { id, tipo_consegna: 'DOMICILIO', estado: 'EN_COCINA', zona: 'Q2', hora: '21:00', ...overrides };
}

function resetStubs() {
  STUB_CURRENT_BUSINESS_DATE = '2026-09-15';
  STUB_CURRENT_BUSINESS_DATE_THROWS = false;
  currentBusinessDateCallCount = 0;
  STUB_PROJECTION = null;
  STUB_PROJECTION_THROWS = false;
  projectionCallCount = 0;
}

// ── FINAL-W4-N01: current snapshot uses Projection ─────────────────────────
section('FINAL-W4-N01: current snapshot uses Projection');
(async () => {
  resetStubs();
  STUB_PROJECTION = makeAvailableProjection({ ordersToGiro: { '#A': 'mg_1', '#B': 'mg_1' } });
  const rows = [
    mkOrder('#A', { manual_giro_id: 'RAW_STALE' }),
    mkOrder('#B', { hora: '21:05', manual_giro_id: 'RAW_STALE' }),
  ];
  const snap = await loadPlannerSnapshot({ db: stubDb(rows, []), date: STUB_CURRENT_BUSINESS_DATE });
  check('N01: orders carry the Projection-derived giro id, not the raw column',
    snap.orders.every((o) => o.manual_giro_id === 'mg_1'),
    JSON.stringify(snap.orders.map((o) => o.manual_giro_id)));
  check('N01: exactly one Projection read for this snapshot', projectionCallCount === 1, String(projectionCallCount));

  // ── FINAL-W4-N02 (HARD GATE): raw/projection disagreement → Projection wins ──
  section('FINAL-W4-N02 (HARD GATE): raw/projection membership disagreement → Projection wins');
  resetStubs();
  STUB_PROJECTION = makeAvailableProjection({ ordersToGiro: { '#A': 'mg_CANON' } });
  const rows2 = [mkOrder('#A', { manual_giro_id: 'mg_RAW_A' })];
  const snap2 = await loadPlannerSnapshot({ db: stubDb(rows2, []), date: STUB_CURRENT_BUSINESS_DATE });
  check('N02: canonical value B wins over raw value A', snap2.orders[0].manual_giro_id === 'mg_CANON', snap2.orders[0].manual_giro_id);

  resetStubs();
  STUB_PROJECTION = makeAvailableProjection({ ordersToGiro: {} }); // projection says: not a member of anything
  const rows2b = [mkOrder('#A', { manual_giro_id: 'mg_RAW_A' })];
  const snap2b = await loadPlannerSnapshot({ db: stubDb(rows2b, []), date: STUB_CURRENT_BUSINESS_DATE });
  check('N02: Projection saying "no giro" overrides a non-null raw value (never A)', snap2b.orders[0].manual_giro_id === null, String(snap2b.orders[0].manual_giro_id));

  // ── FINAL-W4-N03: manual_giro_id alias = effective_giro_id ──────────────
  section('FINAL-W4-N03: manual_giro_id alias = effective_giro_id');
  resetStubs();
  STUB_PROJECTION = makeAvailableProjection({ ordersToGiro: { '#X': 'mg_9' } });
  const rows3 = [mkOrder('#X', { estado: 'LISTO', zona: 'Q3', hora: '20:00' })];
  const snap3 = await loadPlannerSnapshot({ db: stubDb(rows3, []), date: STUB_CURRENT_BUSINESS_DATE });
  check('N03: alias equals projection.orders[].effective_giro_id verbatim', snap3.orders[0].manual_giro_id === 'mg_9');

  // ── FINAL-W4-N04: Projection effective_members drive membership ─────────
  section('FINAL-W4-N04: Projection effective_members drive membership');
  resetStubs();
  STUB_PROJECTION = makeAvailableProjection({ ordersToGiro: { '#A': 'mg_1', '#B': 'mg_1', '#C': null } });
  const rows4 = [
    mkOrder('#A'),
    mkOrder('#B', { hora: '21:05' }),
    mkOrder('#C', { hora: '21:10' }),
  ];
  const snap4 = await loadPlannerSnapshot({ db: stubDb(rows4, []), date: STUB_CURRENT_BUSINESS_DATE });
  const byId4 = Object.fromEntries(snap4.orders.map((o) => [o.id, o.manual_giro_id]));
  check('N04: A and B share the effective giro, C has none', byId4['#A'] === 'mg_1' && byId4['#B'] === 'mg_1' && byId4['#C'] === null, JSON.stringify(byId4));

  // ── FINAL-W4-N08: Stage M metadata retained but cannot override canonical facts ──
  section('FINAL-W4-N08: Stage M raw manual_giros metadata cannot override canonical alias');
  resetStubs();
  STUB_PROJECTION = makeAvailableProjection({ ordersToGiro: { '#A': 'mg_CANON' } });
  const giroRows8 = [{ id: 'mg_RAW_ROUTE', type: 'manual_route', order_ids: ['#A'], route_order: ['#A'], block_start: '20:00', manual_duration_min: 15, created_by_operator: true, force: true, hora_ref: '20:10' }];
  const rows8 = [mkOrder('#A', { manual_giro_id: 'mg_RAW_ROUTE' })];
  const snap8 = await loadPlannerSnapshot({ db: stubDb(rows8, giroRows8), date: STUB_CURRENT_BUSINESS_DATE });
  check('N08: manual_giros raw row (Stage M metadata) is still present, untouched', snap8.manual_giros.length === 1 && snap8.manual_giros[0].id === 'mg_RAW_ROUTE');
  check('N08: order-level alias is still the CANONICAL value, not the Stage-M raw manual_giros.id', snap8.orders[0].manual_giro_id === 'mg_CANON', snap8.orders[0].manual_giro_id);
  check('N08: Stage M fields (route_order/block_start/etc) survive unmodified in the snapshot',
    snap8.manual_giros[0].route_order.length === 1 && snap8.manual_giros[0].block_start === '20:00' &&
    snap8.manual_giros[0].manual_duration_min === 15 && snap8.manual_giros[0].created_by_operator === true && snap8.manual_giros[0].force === true);

  // ── FINAL-W4-N09 (HARD GATE): Projection unavailable → no raw current-day fallback ──
  section('FINAL-W4-N09 (HARD GATE): Projection unavailable → explicit failure, never a raw fallback');
  resetStubs();
  STUB_PROJECTION = null; // unavailable
  const rows9 = [mkOrder('#A', { manual_giro_id: 'mg_RAW_WOULD_LEAK' })];
  let threw9 = null;
  try {
    await loadPlannerSnapshot({ db: stubDb(rows9, []), date: STUB_CURRENT_BUSINESS_DATE });
  } catch (e) { threw9 = e; }
  check('N09: loadPlannerSnapshot throws (never silently returns raw-aliased data)', threw9 !== null);
  check('N09: thrown error is explicitly typed, not a generic Error', threw9 && threw9.safe === true && typeof threw9.code === 'string', threw9 && threw9.message);
  check('N09: error code names snapshot/projection unavailability for the caller\'s existing regex match', threw9 && /snapshot/i.test(threw9.code), threw9 && threw9.code);

  section('FINAL-W4-N09b: same for RPC-error / degraded / scope-unavailable projections');
  resetStubs();
  STUB_PROJECTION = { contract: 'giro_projection_v1', scope_valid: false, degraded: true, giros: [], orders: [], intents: [] };
  let threw9b = null;
  try { await loadPlannerSnapshot({ db: stubDb(rows9, []), date: STUB_CURRENT_BUSINESS_DATE }); } catch (e) { threw9b = e; }
  check('N09b: scope_valid=false also throws explicitly', threw9b !== null && threw9b.safe === true);

  resetStubs();
  STUB_PROJECTION_THROWS = true; // RPC error
  let threw9c = null;
  try { await loadPlannerSnapshot({ db: stubDb(rows9, []), date: STUB_CURRENT_BUSINESS_DATE }); } catch (e) { threw9c = e; }
  check('N09c: readGiroProjection() itself throwing also surfaces as an explicit failure', threw9c !== null && threw9c.safe === true);

  // ── FINAL-W4-N09d: end-to-end through the REAL, unmodified consumers ────
  section('FINAL-W4-N09d: end-to-end — real previewStrategicOpportunities.js surfaces snapshot_unavailable, never empty');
  resetStubs();
  STUB_PROJECTION = null;
  const previewStrategicOpportunities = require('../src/agents/previewStrategicOpportunities').previewStrategicOpportunities;
  const result9d = await previewStrategicOpportunities(
    { currentOrderDraft: { zona: 'Q2', hora: '21:00', pizzas: 1 }, startTime: '21:00', date: STUB_CURRENT_BUSINESS_DATE, now: '20:30' },
    { loadSnapshot: (args) => loadPlannerSnapshot({ ...args, db: stubDb(rows9, []) }) }
  );
  check('N09d: real previewStrategicOpportunities() returns an explicit error, not a silent empty result',
    result9d && result9d.ok === false && result9d.error && result9d.error.code === 'snapshot_unavailable', JSON.stringify(result9d));

  section('FINAL-W4-N09e: end-to-end — real previewOrderPlanner.js surfaces snapshot_unavailable');
  resetStubs();
  STUB_PROJECTION = null;
  const { previewOrderPlanner } = require('../src/agents/previewOrderPlanner');
  const result9e = await previewOrderPlanner(
    // language-guard: allow-legacy tipo_consegna is the existing previewOrderPlanner params field name, not new vocabulary
    { tipo_consegna: 'DOMICILIO', hora: '21:00', pizzas_count: 1, date: STUB_CURRENT_BUSINESS_DATE, direccion: 'Calle Test 1' },
    {
      db: stubDb(rows9, []), now: () => '20:30', loadPlannerSnapshot,
      resolveDeliveryFields: async () => ({ zona: 'Q2', durata_andata_min: 10 }),
    }
  );
  check('N09e: real previewOrderPlanner() returns an explicit error, not fabricated planner output',
    result9e && result9e.ok === false && result9e.error &&
    (result9e.error.code === 'snapshot_unavailable' || result9e.error.code === 'planner_unavailable'), JSON.stringify(result9e));

  // ── FINAL-W4-N10 (implied by N01 check above, restated standalone) ──────
  section('FINAL-W4-N10: one Projection RPC per current snapshot, no N+1');
  resetStubs();
  STUB_PROJECTION = makeAvailableProjection({ ordersToGiro: { '#A': 'mg_1', '#B': 'mg_2', '#C': 'mg_3' } });
  const rows10 = [
    mkOrder('#A'),
    mkOrder('#B', { zona: 'Q3', hora: '21:05' }),
    mkOrder('#C', { zona: 'Q4', hora: '21:10' }),
  ];
  await loadPlannerSnapshot({ db: stubDb(rows10, []), date: STUB_CURRENT_BUSINESS_DATE });
  check('N10: exactly 1 Projection RPC regardless of order count', projectionCallCount === 1, String(projectionCallCount));

  // ── FINAL-W4-N11 (HARD GATE): non-giro AU bucketing unchanged ───────────
  section('FINAL-W4-N11 (HARD GATE): non-giro automatic bucketing parity, end-to-end through the real planner.js');
  resetStubs();
  STUB_PROJECTION = makeAvailableProjection({ ordersToGiro: {} }); // nobody is in a giro
  const rows11 = [
    mkOrder('#A', { durata_andata_min: 10, created_at: '2026-09-15T18:00:00Z' }),
    mkOrder('#B', { zona: 'Q3', hora: '21:30', durata_andata_min: 12, created_at: '2026-09-15T18:01:00Z' }),
  ];
  const snap11 = await loadPlannerSnapshot({ db: stubDb(rows11, []), date: STUB_CURRENT_BUSINESS_DATE, now: '19:00' });
  check('N11: non-giro orders keep manual_giro_id null after the cutover',
    snap11.orders.every((o) => o.manual_giro_id === null));
  const plan11 = buildPlan(snap11);
  const tripIds11 = (plan11.trips || []).map((t) => t.id).sort();
  check('N11: end-to-end buildPlan() buckets non-giro orders as AU:<zona>|<slot> exactly as before the cutover',
    tripIds11.length > 0 && tripIds11.every((k) => typeof k === 'string' && k.startsWith('AU:')), JSON.stringify(tripIds11));

  // ── FINAL-W4-N13 (HARD GATE): previewStrategic merge membership canonical ──
  section('FINAL-W4-N13 (HARD GATE): previewStrategicOpportunities groups by the CANONICAL giro id, end-to-end');
  resetStubs();
  STUB_PROJECTION = makeAvailableProjection({ ordersToGiro: { '#A': 'mg_CANON', '#B': 'mg_CANON' } });
  const rows13 = [
    mkOrder('#A', { manual_giro_id: 'mg_RAW_A' }),
    mkOrder('#B', { estado: 'LISTO', zona: 'Q3', hora: '21:05', manual_giro_id: 'mg_RAW_B' }),
  ];
  const snap13 = await loadPlannerSnapshot({ db: stubDb(rows13, []), date: STUB_CURRENT_BUSINESS_DATE, now: '19:00' });
  const anchors13 = buildAnchorsFromSnapshot(snap13, { now: '19:00' });
  const giroAnchor13 = anchors13.find((a) => a.isGiro);
  check('N13: a merged giro-anchor exists (A and B were merged by the CANONICAL id)', !!giroAnchor13, JSON.stringify(anchors13));
  check('N13: the merged anchor id is the canonical giro id, not a raw one', giroAnchor13 && giroAnchor13.manualGiroId === 'mg_CANON', giroAnchor13 && giroAnchor13.manualGiroId);
  check('N13: the merged anchor carries both stops', giroAnchor13 && giroAnchor13.stops.length === 2);

  // ── FINAL-W4-N14 / N15: historical path unchanged, zero Projection calls ──
  section('FINAL-W4-N14/N15: historical day — byte-for-byte legacy path, zero Projection RPCs');
  resetStubs();
  STUB_CURRENT_BUSINESS_DATE = '2026-09-15';
  STUB_PROJECTION = makeAvailableProjection({ ordersToGiro: { '#A': 'mg_WOULD_BE_CANONICAL' } }); // must be ignored entirely
  const rowsHist = [mkOrder('#A', { manual_giro_id: 'mg_RAW_HISTORICAL' })];
  const snapHist = await loadPlannerSnapshot({ db: stubDb(rowsHist, []), date: '2026-09-10' }); // explicit past day
  check('N14: historical order keeps the RAW manual_giro_id, untouched by the Projection', snapHist.orders[0].manual_giro_id === 'mg_RAW_HISTORICAL', snapHist.orders[0].manual_giro_id);
  check('N15: zero Projection RPCs for a historical-day snapshot', projectionCallCount === 0, String(projectionCallCount));

  section('FINAL-W4-N14b: currentBusinessDate unknowable (null) + explicit date → routed historical, not canonical');
  resetStubs();
  STUB_CURRENT_BUSINESS_DATE_THROWS = true;
  STUB_PROJECTION = makeAvailableProjection({ ordersToGiro: { '#A': 'mg_WOULD_BE_CANONICAL' } });
  const rowsHist2 = [mkOrder('#A', { manual_giro_id: 'mg_RAW_KEPT' })];
  const snapHist2 = await loadPlannerSnapshot({ db: stubDb(rowsHist2, []), date: '2026-09-15' });
  check('N14b: unknowable current-business-date + explicit date -> treated as historical (fail-closed, not mis-applied Projection)',
    snapHist2.orders[0].manual_giro_id === 'mg_RAW_KEPT' && projectionCallCount === 0);

  section('FINAL-W4-N14c: date absent -> NOT historical -> canonical path used (matches Packet 02B\'s own routing rule)');
  resetStubs();
  STUB_PROJECTION = makeAvailableProjection({ ordersToGiro: { '#A': 'mg_CANON_NO_DATE' } });
  const rowsNoDate = [mkOrder('#A', { manual_giro_id: 'mg_RAW' })];
  const snapNoDate = await loadPlannerSnapshot({ db: stubDb(rowsNoDate, []) }); // no date at all
  check('N14c: date-absent snapshot is canonical (matches getManualGirosRead\'s own day-absent rule)',
    snapNoDate.orders[0].manual_giro_id === 'mg_CANON_NO_DATE' && projectionCallCount === 1);

  // ── FINAL-W4-N16: public Planner response shapes unchanged ─────────────
  section('FINAL-W4-N16: snapshot + normalizeOrder/normalizeManualGiro shapes unchanged');
  resetStubs();
  STUB_PROJECTION = makeAvailableProjection({ ordersToGiro: {} });
  const rows16 = [mkOrder('#A', { items: [], forzado: false })];
  const snap16 = await loadPlannerSnapshot({ db: stubDb(rows16, []), date: STUB_CURRENT_BUSINESS_DATE });
  check('N16: top-level snapshot keys unchanged',
    JSON.stringify(Object.keys(snap16).sort()) === JSON.stringify(['driver', 'driver_events', 'driver_status', 'manual_giros', 'now', 'orders'].sort()));
  const orderKeys16 = Object.keys(snap16.orders[0]).sort();
  // language-guard: allow-legacy tipo_consegna/n_pizze are the existing normalizeOrder() output field names this assertion checks are still present, not new vocabulary
  const expectedOrderKeys16 = ['estado', 'forzado', 'id', 'items', 'manual_giro_id', 'n_pizze', 'tipo_consegna', 'zona', 'hora'].sort();
  check('N16: normalizeOrder still returns exactly the pre-cutover key set (only the manual_giro_id VALUE changed)',
    JSON.stringify(orderKeys16) === JSON.stringify(expectedOrderKeys16),
    JSON.stringify(orderKeys16));

  console.log(`\n═══ plannerSnapshotW4FinalCutover.test.js: ${pass} passed, ${fail} failed ═══`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('UNCAUGHT:', e);
  process.exit(1);
});
