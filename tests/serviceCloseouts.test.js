'use strict';
// SERVICE LIFECYCLE V3 / Slice 3.1 — behavioural contract test for
// src/closeout/serviceCloseouts.js against a fake `select`. Read-only: there
// is no capture/write method to test (no RPC exists yet — see the migration
// header). Real DB-level shape (uniqueness, immutability, grants) is proven
// separately, statically, in tests/serviceLifecycleV3Foundation.static.test.js
// — this file cannot run real Postgres and does not claim to.

const { createServiceCloseouts } = require('../src/closeout/serviceCloseouts');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

function fakeDb(rows = []) {
  async function select(table, query) {
    if (table !== 'service_closeouts') throw new Error('unexpected table ' + table);
    let out = rows.slice();
    const eqSession = query.match(/service_session_id=eq\.([^&]+)/);
    if (eqSession) out = out.filter((r) => r.service_session_id === decodeURIComponent(eqSession[1]));
    const eqCorr = query.match(/closeout_correlation_id=eq\.([^&]+)/);
    if (eqCorr) out = out.filter((r) => r.closeout_correlation_id === decodeURIComponent(eqCorr[1]));
    const gte = query.match(/business_date=gte\.([^&]+)/);
    const lte = query.match(/business_date=lte\.([^&]+)/);
    if (gte) out = out.filter((r) => r.business_date >= decodeURIComponent(gte[1]));
    if (lte) out = out.filter((r) => r.business_date <= decodeURIComponent(lte[1]));
    if (query.includes('order=business_date.asc')) out = out.slice().sort((a, b) => (a.business_date > b.business_date ? 1 : -1));
    return out;
  }
  return { select };
}

const ROW_1 = Object.freeze({
  id: 'co-1', service_session_id: 's1', closeout_correlation_id: 'corr-1',
  business_date: '2026-08-05', service_kind: 'SERA',
  opened_at: '2026-08-05T18:00:00Z', closed_at: '2026-08-05T23:10:00Z',
  close_source: 'operator', close_reason: null, closed_by: 'owner',
  gross_sales_cents: 125000, net_sales_cents: 120000, total_discounts_cents: 5000,
  total_refunds_cents: 0, total_void_cents: 0,
  paid_amount_cents: 114250, unpaid_exposure_cents: 5750, order_count: 42,
  cash_amount_cents: 50000, card_amount_cents: 60000, bizum_amount_cents: 4250, other_amount_cents: 0,
  open_orders_at_close: 0, occupied_tables_at_close: 1, kitchen_pending_count: 0,
  listo_count: 0, delivery_pending_count: 0, incident_count: 3, critical_incident_count: 0,
  created_at: '2026-08-05T23:10:01Z',
});
const ROW_2 = Object.freeze({ ...ROW_1, id: 'co-2', service_session_id: 's2', closeout_correlation_id: 'corr-2', business_date: '2026-08-06' });

(async () => {
  console.log('\n== serviceCloseouts.js — read-only contract ==\n');

  console.log('\n── 1. getBySessionId ──');
  {
    const closeouts = createServiceCloseouts(fakeDb([ROW_1, ROW_2]));
    const r = await closeouts.getBySessionId({ serviceSessionId: 's1' });
    assert('1a: finds the matching row', r && r.id === 'co-1', JSON.stringify(r));
    assert('1b: financial totals surface exactly, cents throughout', r.financial.unpaidExposureCents === 5750 && r.financial.paidAmountCents === 114250);
    assert('1c: unknown session -> null, never throws', await closeouts.getBySessionId({ serviceSessionId: 'nope' }) === null);
  }

  console.log('\n── 2. getByCorrelationId ──');
  {
    const closeouts = createServiceCloseouts(fakeDb([ROW_1, ROW_2]));
    const r = await closeouts.getByCorrelationId({ closeoutCorrelationId: 'corr-2' });
    assert('2a: finds by correlation id, distinct from session id', r && r.serviceSessionId === 's2');
    assert('2b: unknown correlation id -> null', await closeouts.getByCorrelationId({ closeoutCorrelationId: 'nope' }) === null);
  }

  console.log('\n── 3. listByBusinessDateRange ──');
  {
    const ROW_3 = { ...ROW_1, id: 'co-3', service_session_id: 's3', closeout_correlation_id: 'corr-3', business_date: '2026-08-09' };
    const closeouts = createServiceCloseouts(fakeDb([ROW_2, ROW_1, ROW_3]));
    const list = await closeouts.listByBusinessDateRange({ fromDate: '2026-08-05', toDate: '2026-08-06' });
    assert('3a: range excludes rows outside it', list.length === 2, String(list.length));
    assert('3b: ordered oldest business_date first', list[0].businessDate === '2026-08-05' && list[1].businessDate === '2026-08-06', JSON.stringify(list.map((r) => r.businessDate)));
  }

  console.log('\n── 4. shape — financial/operational are grouped, not a flat dump ──');
  {
    const closeouts = createServiceCloseouts(fakeDb([ROW_1]));
    const r = await closeouts.getBySessionId({ serviceSessionId: 's1' });
    assert('4a: financial group present with every canonical documented field', ['grossSalesCents', 'totalDiscountsCents', 'totalRefundsCents', 'totalVoidCents', 'paidAmountCents', 'unpaidExposureCents', 'orderCount', 'cashAmountCents', 'cardAmountCents', 'bizumAmountCents', 'otherAmountCents', 'currentObligationCents', 'overCollectedCents'].every((k) => k in r.financial));
    // SERVICE_CLOSEOUT_NET_SALES_LEGACY_CONTRACT_HARDENING_V1 (2026-09-09) — the
    // legacy net_sales_cents column is deliberately NOT projected onto the
    // public closeout object anymore (it used to reach the client via the
    // service-close HTTP response — index.js res.json). The DB column + formula
    // + RPC writer are unchanged; only this wire projection drops it, so no HTTP
    // consumer can bind to the ambiguous legacy value. See migration 125 / the
    // net-sales legacy audit.
    assert('4a-bis: netSalesCents is NOT exposed on the public closeout (wire exposure removed)', !('netSalesCents' in r.financial));
    assert('4b: operational group present with every documented field', ['openOrdersAtClose', 'occupiedTablesAtClose', 'kitchenPendingCount', 'listoCount', 'deliveryPendingCount', 'incidentCount', 'criticalIncidentCount'].every((k) => k in r.operational));
    assert('4c: no raw snake_case column leaks onto the public object', !('unpaid_exposure_cents' in r) && !('service_session_id' in r) && r.serviceSessionId === 's1');
  }

  console.log('\n── 5. no write/capture method exists (schema-only slice — see migration header) ──');
  {
    const closeouts = createServiceCloseouts(fakeDb([]));
    assert('5a: no capture()', typeof closeouts.capture === 'undefined');
    assert('5b: no create()', typeof closeouts.create === 'undefined');
    assert('5c: no insert()', typeof closeouts.insert === 'undefined');
  }

  console.log('\n=== RESULT: ' + pass + ' passed, ' + fail + ' failed ===');
  process.exit(fail === 0 ? 0 : 1);
})();
