"use strict";
// S2-7D6E3 — the ONE ledger-based aggregator for historical/multi-session cash reporting
// (Economía). It does not duplicate accounting logic: it calls the SAME `aggregate()`
// used by the live closeout (src/closeout/currentServiceCloseout.js) and by the archived
// serata_summary generation (src/utils/servizio.js), once per service_session in range,
// then sums the results. `metodo_pago`/`cobrado`/`ya_pagado` never enter this file —
// `aggregate()` already applies the correct ledger-first, legacy-fallback-only-when-no-
// event rule (see safeTicket in currentServiceCloseout.js).

const { sbSelect } = require("../utils/supabase");
const { aggregate } = require("./currentServiceCloseout");

const round = (value) => Math.round((Number(value) || 0) * 100) / 100;

const EMPTY_PAYMENT_TOTALS = () => ({ efectivo: 0, tarjeta: 0, bizum: 0, other: 0 });
const EMPTY_TOTALS = () => ({ gross: 0, collected: 0, refunded: 0, unpaid: 0 });

function addInto(target, source) {
  for (const k of Object.keys(target)) target[k] = round(target[k] + (Number(source[k]) || 0));
}

async function aggregateOneSession(session, select) {
  const closed = session.status === "closed";
  const sessionFilter = `service_session_id=eq.${encodeURIComponent(session.id)}`;
  const orders = await select(closed ? "storico" : "ordenes", `${sessionFilter}&order=ts.asc`);
  const list = Array.isArray(orders) ? orders : [];
  const ids = list.map((o) => o.orden_id || o.id).filter(Boolean);
  const events = ids.length
    ? await select("order_financial_events", `${sessionFilter}&order_id=in.(${ids.map((id) => encodeURIComponent(String(id))).join(",")})&order=created_at.asc`)
    : [];
  return aggregate(session, list, Array.isArray(events) ? events : []);
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
      serviceKind: session.service_kind || null,
      status: session.status,
      paymentTotals: agg.paymentTotals,
      totals: agg.totals,
    });

    const day = session.business_date;
    if (!day) continue;
    if (!perDay.has(day)) perDay.set(day, { paymentTotals: EMPTY_PAYMENT_TOTALS(), totals: EMPTY_TOTALS() });
    const bucket = perDay.get(day);
    addInto(bucket.paymentTotals, agg.paymentTotals);
    addInto(bucket.totals, agg.totals);
  }

  const porGiorno = Array.from(perDay.entries())
    .map(([businessDate, v]) => ({ businessDate, paymentTotals: v.paymentTotals, totals: v.totals }))
    .sort((a, b) => String(a.businessDate).localeCompare(String(b.businessDate)));

  const grandPaymentTotals = EMPTY_PAYMENT_TOTALS();
  const grandTotals = EMPTY_TOTALS();
  for (const day of porGiorno) {
    addInto(grandPaymentTotals, day.paymentTotals);
    addInto(grandTotals, day.totals);
  }

  return {
    ok: true,
    porGiorno,
    sessions: sessionSummaries,
    paymentTotals: grandPaymentTotals,
    totals: grandTotals,
  };
}

module.exports = { getEconomiaLedgerAggregate };
