'use strict';
// FINALIZAR V3 CANONICAL CLOSEOUT V1 — behavioural contract.
//
// Proves the obligation-aware V3 close writer end to end against fake
// DAO/RPC boundaries but the REAL aggregate() (src/closeout/
// currentServiceCloseout.js), the REAL v3IncidentPolicy classifier, and the
// REAL engine wiring (src/serviceSessions/serviceLifecycleEngine.js). The
// DB-level shape of migration 121 is proven separately in
// tests/finalizarV3CanonicalCloseoutMigration.static.test.js.
//
// Root cause it closes: LEGACY_GROSS_CLOSEOUT_WRITER — the engine called
// aggregate() with 3 args and never read order_obligations, so the persisted
// service_closeouts row was derived from ordenes.totale. See
// REPORT_FINALIZAR_V3_CLOSEOUT_DIVERGENCE_AUDIT_2026-09-06.md.
//
// Run: node tests/finalizarV3CanonicalCloseout.test.js

const { createServiceLifecycleEngine } = require('../src/serviceSessions/serviceLifecycleEngine');
const { aggregate } = require('../src/closeout/currentServiceCloseout');
const {
  snapshotToEconomicShape,
} = require('../src/closeout/closedServiceEconomicTruth');
const { withOfficialSnapshot } = require('../src/closeout/currentServiceCloseout');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-9;

const SID = 'sess-canonical-1';

// ── a compact fake env: real aggregate + real classify, faked persistence ────
function run({ orders = [], events = [], obligations = [], tableSessions = [] }) {
  const captured = { create: null, incidents: [], snapshotPayload: null };
  const sessionRow = {
    id: SID, business_date: '2026-08-25', service_kind: 'SERA',
    lifecycle_semantics: 'economic_period_v1',
    opened_at: '2026-08-25T18:00:00Z', status: 'open',
  };
  const select = async (table, query = '') => {
    if (table === 'service_sessions') return [sessionRow];
    if (table === 'ordenes') return orders;
    if (table === 'table_sessions') return tableSessions;
    if (table === 'order_financial_events') return events;
    if (table === 'order_obligations') return obligations;
    throw new Error('unexpected table ' + table);
  };
  const engine = createServiceLifecycleEngine({
    select,
    attempts: {
      async acquire() { return { success: true, created: true, code: 'ACQUIRED', attempt: { closeoutCorrelationId: 'corr-1', serviceSessionId: SID, status: 'active' } }; },
      async getByCorrelationId() { return { closeoutCorrelationId: 'corr-1', serviceSessionId: SID, status: 'active' }; },
      async complete() { return { success: true }; },
    },
    snapshots: {
      async capture({ payload }) { captured.snapshotPayload = payload; return { success: true, created: true, snapshot: { id: 'snap-1' } }; },
    },
    closeoutCreation: {
      async create(fields) {
        captured.create = fields;
        return {
          success: true, created: true, code: 'CREATED',
          closeout: { id: 'co-1', serviceSessionId: SID, closeoutCorrelationId: 'corr-1', financial: {}, operational: {} },
        };
      },
    },
    closeouts: { async getBySessionId() { return null; } },
    transition: {
      async close() { return { success: true, code: 'V3_CLOSED', session: { ...sessionRow, status: 'closed' } }; },
    },
    incidents: {
      async report(fields) { captured.incidents.push(fields); return { success: true, created: true, incident: { id: 'inc-' + captured.incidents.length, ...fields, severity: fields.severity } }; },
      async resolve() { return { success: true, incident: {} }; },
    },
    releaseEmptyTable: async () => ({ ok: true }),
    reconciliation: { persist: async () => ({ success: true, reconciliation: { id: 'rec-1' } }) },
  });
  return engine({ serviceSessionId: SID, source: 'operator_finalizar_v3', actor: 'tester' }).then((res) => ({ res, ...captured }));
}

const ord = (o) => ({ service_session_id: SID, estado: 'RETIRADO', hora: '20:00', cobrado: false, ya_pagado: false, metodo_pago: '', ...o });
const obl = (order_id, revision, gross_amount) => ({ order_id, service_session_id: SID, revision, gross_amount });
const pay = (order_id, amount, payment_method = 'efectivo') => ({ order_id, service_session_id: SID, type: 'payment', amount, payment_method, created_at: '2026-08-25T20:00:00Z' });
const refund = (order_id, amount, payment_method = 'efectivo') => ({ order_id, service_session_id: SID, type: 'refund', amount, payment_method, created_at: '2026-08-25T20:30:00Z' });

(async () => {
  console.log('\n== FIXTURE F — the #999034 equivalent (obligation 85 -> 60, 85 paid, 15 refunded) ==');
  {
    const orders = [ord({ orden_id: '#F', id: '#F', totale: 85 })];
    const obligations = [obl('#F', 1, 85), obl('#F', 2, 70), obl('#F', 3, 60)];
    const events = [pay('#F', 85), refund('#F', 15)];
    const { res, create, incidents } = await run({ orders, events, obligations });
    assert('F0: close succeeded', res.success === true, res.code);
    assert('F1: current_obligation_cents = 6000 (60 EUR, the adjusted obligation)', create.currentObligationCents === 6000, String(create.currentObligationCents));
    assert('F2: gross_sales_cents = 8500 (ORIGINAL order gross, unchanged meaning)', create.grossSalesCents === 8500, String(create.grossSalesCents));
    assert('F3: unpaid_exposure_cents = 0 (60 - 70, clamped)', create.unpaidExposureCents === 0, String(create.unpaidExposureCents));
    assert('F4: over_collected_cents = 1000 (70 - 60, never netted against unpaid)', create.overCollectedCents === 1000, String(create.overCollectedCents));
    assert('F5: paid_amount_cents = 7000 (85 paid - 15 refunded, cash)', create.paidAmountCents === 7000, String(create.paidAmountCents));
    assert('F6: NO UNPAID_BALANCE_AT_CLOSE incident for #F',
      !incidents.some((i) => i.incidentType === 'UNPAID_BALANCE_AT_CLOSE'), JSON.stringify(incidents.map((i) => i.incidentType)));

    // The regression this fixture pins: the pre-fix 3-argument aggregate()
    // would have reported unpaid 15 / overCollected 0 for this same order.
    const legacy = aggregate({ id: SID, status: 'closing' }, orders, events);
    const canonical = aggregate({ id: SID, status: 'closing' }, orders, events, obligations);
    assert('F7: pre-fix (3-arg) aggregate would have said unpaid 15 — this is what the fix removes',
      near(legacy.totals.unpaid, 15) && near(legacy.totals.overCollected, 0));
    assert('F8: obligation-aware (4-arg) aggregate says unpaid 0 / overCollected 10',
      near(canonical.totals.unpaid, 0) && near(canonical.totals.overCollected, 10));
    assert('F9: originalGross is 85 in both, gross is 60 only when obligation-aware',
      near(legacy.totals.originalGross, 85) && near(canonical.totals.originalGross, 85)
      && near(legacy.totals.gross, 85) && near(canonical.totals.gross, 60));
  }

  console.log('\n== FULL 4-ORDER FIXTURE (service 42af1de9 equivalent) ==');
  {
    const orders = [
      ord({ orden_id: '#31', id: '#31', totale: 69, estado: 'RETIRADO' }),
      ord({ orden_id: '#32', id: '#32', totale: 15, estado: 'EN_ENTREGA' }),
      ord({ orden_id: '#33', id: '#33', totale: 17, estado: 'LISTO' }),
      ord({ orden_id: '#34', id: '#34', totale: 85, estado: 'RETIRADO' }),
    ];
    const obligations = [
      obl('#31', 1, 69),
      obl('#32', 1, 15),
      obl('#33', 1, 17),
      obl('#34', 1, 85), obl('#34', 2, 70), obl('#34', 3, 60),
    ];
    const events = [
      pay('#31', 27, 'tarjeta'), pay('#31', 42, 'tarjeta'),
      pay('#34', 85, 'efectivo'), refund('#34', 15, 'efectivo'),
    ];
    const { res, create, incidents } = await run({ orders, events, obligations });
    assert('S0: close succeeded', res.success === true, res.code);
    assert('S1: gross_sales_cents        = 18600 (ORIGINAL: 69+15+17+85)', create.grossSalesCents === 18600, String(create.grossSalesCents));
    assert('S2: current_obligation_cents = 16100 (CURRENT: 69+15+17+60 — the Finalizar "Total")', create.currentObligationCents === 16100, String(create.currentObligationCents));
    assert('S3: paid_amount_cents        = 13900 (69 card + 70 net cash)', create.paidAmountCents === 13900, String(create.paidAmountCents));
    assert('S4: total_refunds_cents      = 1500', create.totalRefundsCents === 1500, String(create.totalRefundsCents));
    assert('S5: unpaid_exposure_cents    = 3200 (0 + 15 + 17 + 0)', create.unpaidExposureCents === 3200, String(create.unpaidExposureCents));
    assert('S6: over_collected_cents     = 1000 (0 + 0 + 0 + 10)', create.overCollectedCents === 1000, String(create.overCollectedCents));
    assert('S7: cash_amount_cents        = 7000', create.cashAmountCents === 7000, String(create.cashAmountCents));
    assert('S8: card_amount_cents        = 6900', create.cardAmountCents === 6900, String(create.cardAmountCents));
    assert('S9: bizum/other              = 0 / 0', create.bizumAmountCents === 0 && create.otherAmountCents === 0);
    assert('S10: order_count             = 4', create.orderCount === 4, String(create.orderCount));
    assert('S11: incident_count          = 4 (not 5 — no false #34 unpaid)', create.incidentCount === 4, String(create.incidentCount));
    const types = incidents.map((i) => i.incidentType).sort();
    assert('S12: exactly the 4 real incidents (2 unpaid + delivery + ready)',
      JSON.stringify(types) === JSON.stringify([
        'DELIVERY_ACTIVE_AT_CLOSE', 'ORDER_READY_NOT_FINALIZED_AT_CLOSE',
        'UNPAID_BALANCE_AT_CLOSE', 'UNPAID_BALANCE_AT_CLOSE',
      ]), JSON.stringify(types));
    const unpaidIncidents = incidents.filter((i) => i.incidentType === 'UNPAID_BALANCE_AT_CLOSE');
    assert('S13: the two unpaid incidents are #32 (1500) and #33 (1700) — NOT #34',
      JSON.stringify(unpaidIncidents.map((i) => [i.entityId, i.financialExposureCents]).sort())
        === JSON.stringify([['#32', 1500], ['#33', 1700]]));
    assert('S14: net_sales_cents stays legacy — max(0, 18600 - 1500) = 17100', create.netSalesCents === 17100, String(create.netSalesCents));
  }

  console.log('\n== SNAPSHOT REPRODUCIBILITY — obligations captured in the immutable payload ==');
  {
    const orders = [ord({ orden_id: '#31', id: '#31', totale: 69 })];
    const obligations = [obl('#31', 1, 69)];
    const { snapshotPayload } = await run({ orders, events: [pay('#31', 69)], obligations });
    assert('M1: the close snapshot payload carries orderObligations',
      Array.isArray(snapshotPayload.orderObligations) && snapshotPayload.orderObligations.length === 1);
    assert('M2: and still carries the pre-existing keys unchanged',
      'session' in snapshotPayload && 'orders' in snapshotPayload
      && 'tableSessions' in snapshotPayload && 'financialEvents' in snapshotPayload);
  }

  console.log('\n== §26 regression fixtures A–F (aggregate() level) ==');
  const S = { id: SID, status: 'closing' };
  const one = (totale, revs, ev) => ({
    orders: [ord({ orden_id: '#x', id: '#x', totale })],
    obligations: revs.map((g, i) => obl('#x', i + 1, g)),
    events: ev,
  });
  const cases = [
    ['A fully paid   (obl 50, pay 50)',                  one(50, [50], [pay('#x', 50)]),          { gross: 50, orig: 50, unpaid: 0,  over: 0 }],
    ['B unpaid       (obl 20, pay 0)',                   one(20, [20], []),                        { gross: 20, orig: 20, unpaid: 20, over: 0 }],
    ['C adjustment   (orig 100 -> obl 70, pay 70)',      one(100, [100, 70], [pay('#x', 70)]),     { gross: 70, orig: 100, unpaid: 0, over: 0 }],
    ['D refund       (obl 40, pay 40, refund 10)',       one(40, [40], [pay('#x', 40), refund('#x', 10)]), { gross: 40, orig: 40, unpaid: 10, over: 0 }],
    ['E over-collect (obl 30, pay 45)',                  one(30, [30], [pay('#x', 45)]),           { gross: 30, orig: 30, unpaid: 0,  over: 15 }],
    ['F #999034      (orig 85 -> obl 60, pay 85, ref 15)', one(85, [85, 70, 60], [pay('#x', 85), refund('#x', 15)]), { gross: 60, orig: 85, unpaid: 0, over: 10 }],
  ];
  for (const [label, fx, exp] of cases) {
    const a = aggregate(S, fx.orders, fx.events, fx.obligations);
    assert(label, near(a.totals.gross, exp.gross) && near(a.totals.originalGross, exp.orig)
      && near(a.totals.unpaid, exp.unpaid) && near(a.totals.overCollected, exp.over),
      `gross ${a.totals.gross} orig ${a.totals.originalGross} unpaid ${a.totals.unpaid} over ${a.totals.overCollected}`);
  }

  console.log('\n== BACK-COMPAT — no obligations passed => gross === originalGross, byte-unchanged ==');
  {
    const orders = [ord({ orden_id: '#a', id: '#a', totale: 33 }), ord({ orden_id: '#b', id: '#b', totale: 12 })];
    const a3 = aggregate(S, orders, []);            // legacy 3-arg
    const a4 = aggregate(S, orders, [], []);        // 4-arg, empty obligations
    assert('BC1: 3-arg — gross 45 and originalGross 45 agree', near(a3.totals.gross, 45) && near(a3.totals.originalGross, 45));
    assert('BC2: 4-arg empty — identical', near(a4.totals.gross, 45) && near(a4.totals.originalGross, 45));
  }

  console.log('\n== CLOSED-SERVICE READER — canonical vs legacy row ==');
  {
    const canonicalRow = {
      id: 'co-canon', closed_at: '2026-09-06T17:35:00Z', close_source: 'operator_finalizar_v3',
      gross_sales_cents: 18600, current_obligation_cents: 16100, over_collected_cents: 1000,
      paid_amount_cents: 13900, unpaid_exposure_cents: 3200, total_refunds_cents: 1500, total_void_cents: 0,
      cash_amount_cents: 7000, card_amount_cents: 6900, bizum_amount_cents: 0, other_amount_cents: 0,
      order_count: 4, incident_count: 4,
    };
    const s = snapshotToEconomicShape(canonicalRow);
    assert('R1: headline gross is the CURRENT obligation (161), not the original', s.totals.gross === 161, String(s.totals.gross));
    assert('R2: originalGross is still exposed (186)', s.totals.originalGross === 186, String(s.totals.originalGross));
    assert('R3: overCollected is a real figure (10)', s.totals.overCollected === 10, String(s.totals.overCollected));
    assert('R4: unpaid is canonical (32)', s.totals.unpaid === 32, String(s.totals.unpaid));
    assert('R5: closeoutContract = canonical_obligation_v1', s.closeoutContract === 'canonical_obligation_v1', s.closeoutContract);
    assert('R6: difference is gross(canonical) - collected = 22', s.totals.difference === 22, String(s.totals.difference));

    const legacyRow = { ...canonicalRow, id: 'co-legacy', current_obligation_cents: null, over_collected_cents: null };
    const l = snapshotToEconomicShape(legacyRow);
    assert('R7: legacy row — headline gross stays the original (186), byte-identical to before', l.totals.gross === 186, String(l.totals.gross));
    assert('R8: legacy row — overCollected is null, never a fabricated 0', l.totals.overCollected === null);
    assert('R9: legacy row — closeoutContract = legacy_gross_v0', l.closeoutContract === 'legacy_gross_v0', l.closeoutContract);

    const base = { ok: true, status: 'closed', tickets: [], serviceSessionId: SID,
      totals: { gross: 161, collected: 139, refunded: 15, unpaid: 32, overCollected: 10, difference: 22 },
      paymentTotals: { efectivo: 70, tarjeta: 69, bizum: 0, other: 0 },
      counts: { tickets: 4 } };
    const overlaid = withOfficialSnapshot(base, canonicalRow);
    assert('R10: withOfficialSnapshot surfaces closeoutContract', overlaid.closeoutContract === 'canonical_obligation_v1');
    assert('R11: and the headline Total is the canonical obligation (161)', overlaid.totals.gross === 161);
    assert('R12: no divergence — current aggregate and canonical snapshot converge on gross',
      overlaid.divergesFromCloseout === false, JSON.stringify(overlaid.divergence));
  }

  console.log('');
  console.log('Totale: ' + (pass + fail) + ' | PASS: ' + pass + ' | FAIL: ' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
