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
// N-8 -- the ONE definition of "closeout snapshot vs current reconciled". This file
// deliberately does not re-derive it: the live closeout reader uses the same module.
const { describeServiceEconomicTruth } = require("./closedServiceEconomicTruth");
// N-11 -- the ONE definition of which statuses carry reportable economic history.
// Imported, never restated: an inline status array here is exactly how 'rolled_over'
// went missing from Economía in the first place.
const { isEconomicallyReportableServiceStatus } = require("../economy/serviceStatusReporting");

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
  const agg = aggregate(session, list, Array.isArray(events) ? events : [], Array.isArray(obligations) ? obligations : []);
  // N-8 -- for a CLOSED session, also read what was registered at Finalizar. This reader
  // keeps recomputing current truth (that is its whole purpose and it does not change);
  // the snapshot is attached ALONGSIDE so the two stop being silently interchangeable.
  // Looked up by THIS session's id, so the snapshot can never come from another service.
  //
  // N-11 -- this gate stays 'closed' DELIBERATELY, and is not widened to the new
  // reportable set. A rolled-over period never had a Finalizar, so there is no snapshot
  // authority to attach; describeServiceEconomicTruth says so explicitly with
  // closeoutSnapshotAbsentReason='service_rolled_over' rather than leaving a bare null.
  // Its CURRENT reconciled economics are returned in full, which is the whole point.
  if (session.status !== "closed") {
    return { agg, truth: describeServiceEconomicTruth({ status: session.status, current: agg, snapshot: null }) };
  }
  const closeouts = await select("service_closeouts", `${sessionFilter}&limit=1`);
  const snapshot = Array.isArray(closeouts) ? closeouts[0] : null;
  if (snapshot && String(snapshot.service_session_id || "") !== String(session.id)) {
    throw Object.assign(new Error("mixed closeout session row"), { code: "MIXED_CLOSEOUT_SESSION_ROW" });
  }
  return { agg, truth: describeServiceEconomicTruth({ status: session.status, current: agg, snapshot }) };
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
  // N-11 -- the status gate is a named decision, not an inline list. It used to read
  // `["open","closing","closed"].includes(s.status)` which -- given the DB CHECK allows
  // exactly four values -- excluded 'rolled_over', and with it every euro of real
  // history underneath it. The predicate fails closed on any status it has not been
  // taught, so a future fifth value cannot quietly join these totals.
  const sessionList = (Array.isArray(sessions) ? sessions : [])
    .filter((s) => s && s.id && isEconomicallyReportableServiceStatus(s.status));

  const perDay = new Map();
  const sessionSummaries = [];

  let anyDivergence = false;
  for (const session of sessionList) {
    const { agg, truth } = await aggregateOneSession(session, select);
    if (truth.divergesFromCloseout) anyDivergence = true;
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
      // CURRENT RECONCILED truth -- unchanged semantics, unchanged field names, so every
      // existing consumer of this reader keeps reading exactly what it read before.
      paymentTotals: agg.paymentTotals,
      totals: agg.totals,
      economicBreakdown: agg.economicBreakdown,
      // N-8 -- what was registered AT Finalizar, and whether it disagrees. null for an
      // open service (no snapshot authority exists yet) and for a legacy close that
      // predates the closeout table -- told apart by closeoutSnapshotAbsentReason.
      ...truth,
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
    // N-8 -- every figure below (porGiorno, the grand totals) is CURRENT RECONCILED
    // truth, by design: an arbitrary date window is a question about real receipt
    // instants, and substituting frozen closeout figures into it would misdate money.
    // The per-service Finalizar record lives on `sessions[]`, never mixed into these.
    economicSemantic: "current_reconciled",
    // True when at least one CLOSED service in range now reads differently from what
    // its own closeout registered -- i.e. money moved after Finalizar. A flag, never a
    // correction: nothing here rewrites a snapshot.
    divergesFromCloseout: anyDivergence,
    porGiorno,
    sessions: sessionSummaries,
    paymentTotals: grandPaymentTotals,
    totals: grandTotals,
    economicBreakdown: grandEconomicBreakdown,
  };
}

module.exports = { getEconomiaLedgerAggregate };
