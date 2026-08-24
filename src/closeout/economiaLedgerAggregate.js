"use strict";
// S2-7D6E3 — the ONE ledger-based aggregator for historical/multi-session cash reporting
// (Economía). It does not duplicate accounting logic: it calls the SAME `aggregate()`
// used by the live closeout (src/closeout/currentServiceCloseout.js) and by the archived
// serata_summary generation (src/utils/servizio.js), once per service_session in range,
// then sums the results. `metodo_pago`/`cobrado`/`ya_pagado` never enter this file —
// `aggregate()` already applies the correct ledger-first, legacy-fallback-only-when-no-
// event rule (see safeTicket in currentServiceCloseout.js).

const { sbSelect } = require("../utils/supabase");
const { aggregate, loadSessionOrders } = require("./currentServiceCloseout");

const round = (value) => Math.round((Number(value) || 0) * 100) / 100;

const EMPTY_PAYMENT_TOTALS = () => ({ efectivo: 0, tarjeta: 0, bizum: 0, other: 0 });
const EMPTY_TOTALS = () => ({ gross: 0, collected: 0, refunded: 0, unpaid: 0 });
// S-E — mirrors currentServiceCloseout.aggregate()'s economicBreakdown shape
// (obligations = sales by their own creation window, receipts = net payments
// by their own, independent window; "unknown" only for the currently-inert
// cross-session-receipt edge case — see economicPeriodReadRule.js).
const EMPTY_ECONOMIC_BREAKDOWN = () => ({
  obligations: { PRANZO: 0, SERA: 0, unknown: 0 }, // language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values, used here as object keys, not new vocabulary
  receipts: { PRANZO: 0, SERA: 0, unknown: 0 },
});

function addBreakdownInto(target, source) {
  for (const scope of ["obligations", "receipts"]) {
    for (const key of Object.keys(target[scope])) {
      target[scope][key] = round(target[scope][key] + (Number(source?.[scope]?.[key]) || 0));
    }
  }
}

function addInto(target, source) {
  for (const k of Object.keys(target)) target[k] = round(target[k] + (Number(source[k]) || 0));
}

async function aggregateOneSession(session, select) {
  const sessionFilter = `service_session_id=eq.${encodeURIComponent(session.id)}`;
  // P0 — same dual-store closed-session read as the live closeout, via the
  // ONE shared reader (see loadSessionOrders in currentServiceCloseout.js).
  // Previously this queried only the legacy archive table for closed
  // sessions, so any service closed by V3 operator Finalizar
  // (close_source='operator_finalizar_v3', which leaves rows in `ordenes`
  // and never archives them) reported 0 tickets / 0.00 EUR here even with
  // real revenue — reproduced against staging service 480eca89 (262.50 EUR).
  const list = await loadSessionOrders(session, select);
  const ids = list.map((o) => o.orden_id || o.id).filter(Boolean);
  const events = ids.length
    ? await select("order_financial_events", `${sessionFilter}&order_id=in.(${ids.map((id) => encodeURIComponent(String(id))).join(",")})&order=created_at.asc`)
    : [];
  // N-2 — canonical obligations, fetched and scoped exactly like the events
  // above so this reader keeps sharing ONE accounting implementation with the
  // live closeout instead of growing a second, drifting one. Pre-N-2 orders
  // have no row here and fall through to the legacy `totale`.
  const obligations = ids.length
    ? await select("order_obligations", `${sessionFilter}&order_id=in.(${ids.map((id) => encodeURIComponent(String(id))).join(",")})&order=revision.asc`)
    : [];
  return aggregate(session, list, Array.isArray(events) ? events : [], Array.isArray(obligations) ? obligations : []);
}

// Returns per-session-day ledger totals for service_sessions with business_date in
// [desde, hasta] (inclusive, both optional). Each business_date can carry more than one
// session (PRANZO/SERA) — those are summed into one entry per day.
async function getEconomiaLedgerAggregate({ desde, hasta, select = sbSelect } = {}) {
  const filters = [];
  if (desde) filters.push(`business_date=gte.${encodeURIComponent(desde)}`);
  if (hasta) filters.push(`business_date=lte.${encodeURIComponent(hasta)}`);
  filters.push("order=business_date.asc");
  const sessions = await select("service_sessions", filters.join("&"));
  const sessionList = (Array.isArray(sessions) ? sessions : [])
    .filter((s) => s && s.id && ["open", "closing", "closed"].includes(s.status));

  const perDay = new Map();
  const sessionSummaries = [];

  for (const session of sessionList) {
    const agg = await aggregateOneSession(session, select);
    sessionSummaries.push({
      serviceSessionId: session.id,
      businessDate: session.business_date,
      // S-E — era-aware (agg.serviceKind, computed from actual ticket
      // evidence with the session's own kind only as fallback), not the raw
      // column: a session can now legitimately span both economic windows,
      // in which case this is null and economicBreakdown below carries the
      // real split. Byte-identical to before for every session that is
      // still genuinely single-kind (all real data, as of S-E).
      serviceKind: agg.serviceKind,
      status: session.status,
      paymentTotals: agg.paymentTotals,
      totals: agg.totals,
      economicBreakdown: agg.economicBreakdown,
    });

    const day = session.business_date;
    if (!day) continue;
    if (!perDay.has(day)) perDay.set(day, { paymentTotals: EMPTY_PAYMENT_TOTALS(), totals: EMPTY_TOTALS(), economicBreakdown: EMPTY_ECONOMIC_BREAKDOWN() });
    const bucket = perDay.get(day);
    addInto(bucket.paymentTotals, agg.paymentTotals);
    addInto(bucket.totals, agg.totals);
    addBreakdownInto(bucket.economicBreakdown, agg.economicBreakdown);
  }

  const porGiorno = Array.from(perDay.entries())
    .map(([businessDate, v]) => ({ businessDate, paymentTotals: v.paymentTotals, totals: v.totals, economicBreakdown: v.economicBreakdown }))
    .sort((a, b) => String(a.businessDate).localeCompare(String(b.businessDate)));

  const grandPaymentTotals = EMPTY_PAYMENT_TOTALS();
  const grandTotals = EMPTY_TOTALS();
  const grandEconomicBreakdown = EMPTY_ECONOMIC_BREAKDOWN();
  for (const day of porGiorno) {
    addInto(grandPaymentTotals, day.paymentTotals);
    addInto(grandTotals, day.totals);
    addBreakdownInto(grandEconomicBreakdown, day.economicBreakdown);
  }

  return {
    ok: true,
    porGiorno,
    sessions: sessionSummaries,
    paymentTotals: grandPaymentTotals,
    totals: grandTotals,
    economicBreakdown: grandEconomicBreakdown,
  };
}

module.exports = { getEconomiaLedgerAggregate };
