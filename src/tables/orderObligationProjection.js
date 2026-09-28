'use strict';

// UNIFIED_CASH_UI_SURFACE_V1 — attach the canonical per-order `financial` shape
// to a plain list of `ordenes` rows, in batched reads (never N+1).
//
// WHY THIS EXISTS. `getOrdenes` / `getOrdenesArchivadosSesion` return raw
// `ordenes` rows. After a commercial adjustment `ordenes.totale` still holds the
// ORIGINAL gross while the canonical current obligation lives in
// `order_obligations`, so a list card and the cash panel show two different
// numbers for the same order. This closes that divergence WITHOUT giving the
// frontend a second economic truth: the number is the backend's, derived once
// here by the SAME projection Mesa (`projectSessionAccount`) and the
// check-centric cash reader (`cashService.buildCheckAccount`) already use —
// imported, not reimplemented.
//
// STALE PAYMENT MIRROR (H1/H2) — `financial` also carries what was COLLECTED
// against that obligation: netCollected / outstanding / overCollected / payState.
// `ordenes.cobrado` / `ya_pagado` are a mirror the payment and refund writers set,
// but a commercial adjustment moves the obligation and never recomputes them, so
// a partially paid order adjusted down to what was already collected keeps
// cobrado=false while it owes nothing. Consumers that gated collection or the
// ticket on the mirror asked the customer for money twice. The settlement is the
// writer's own arithmetic (order_post_payment_v1): the order's current canonical
// obligation minus its net order_financial_events (payment + payment_imported −
// refund) scoped by (service_session_id, order_id). The residue reconciler
// (previousBusinessDayResidue.js) reads the same facts through the same function.
//
// PURELY ADDITIVE / READ ONLY. Every existing field on each order row is left
// untouched; `financial` is added alongside. No row is materialised, no write
// happens, `ordenes.totale` / `cobrado` / `ya_pagado` are never modified.

const { projectOrderFinancial } = require('./mesaService');

const cents = (value) => Math.round((Number(value) || 0) * 100);
const money = (value) => Math.round(value) / 100;

// The event types order_post_payment_v1 sums into "net collected before".
const SETTLEMENT_EVENT_TYPES = Object.freeze(['payment', 'payment_imported', 'refund']);

function nonEmptyStrings(values) {
  return [...new Set(values.filter((v) => (typeof v === 'string' || typeof v === 'number') && String(v).length > 0).map(String))];
}

function inFilter(values) {
  return values.length ? `in.(${values.map(encodeURIComponent).join(',')})` : null;
}

// PostgREST `in.(...)` filter over the permanent order_uid (globally unique).
// Class B rows (order_uid null / empty) contribute no filter term and simply
// fall through to projectOrderFinancial's own documented legacy-basis fallback.
function orderUidInFilter(orders) {
  const uids = [...new Set(
    (Array.isArray(orders) ? orders : [])
      .map((o) => o && o.order_uid)
      .filter((u) => typeof u === 'string' && u.length > 0)
      .map(String),
  )];
  return uids.length ? `in.(${uids.map(encodeURIComponent).join(',')})` : null;
}

// The collected side of ONE order against its already-projected obligation.
// `events` are that order's own order_financial_events (same service, same
// order id). payState is the writers' own rule — also their cobrado/ya_pagado
// rule and the one Mesa's per-command settlement publishes.
// legacyPaymentConflict is migration 148's refusal predicate: a paid mirror
// while the ledger still says owed. The mirror is never turned into money here;
// the flag only tells the caller that no new collection will be accepted until
// the historical payment is imported or the obligation reconciled.
function projectOrderSettlement(order, financial, events) {
  const obligationCents = cents(financial.currentObligation);
  const netCents = (Array.isArray(events) ? events : [])
    .filter((e) => SETTLEMENT_EVENT_TYPES.includes(e.type))
    .reduce((sum, e) => sum + (e.type === 'refund' ? -1 : 1) * cents(e.amount), 0);
  const outstandingCents = Math.max(0, obligationCents - netCents);
  return {
    netCollected: money(netCents),
    outstanding: money(outstandingCents),
    overCollected: money(Math.max(0, netCents - obligationCents)),
    payState: netCents <= 0 ? 'unpaid' : (netCents >= obligationCents ? 'paid' : 'partially_paid'),
    legacyPaymentConflict: outstandingCents > 0 && (order.cobrado === true || order.ya_pagado === true),
  };
}

// orders   : array of raw `ordenes` rows (as returned by sbSelect('ordenes', …)).
// select   : the same sbSelect(table, query) the caller already uses.
//
// TWO batched reads for the whole list, whatever its length: order_obligations
// by order_uid, and order_financial_events by the rows' service sessions and
// order ids (display ids are recycled across services, so every event is then
// matched on the exact (service_session_id, order_id) pair). Returns
// financialOf(order) -> projectOrderFinancial's shape plus the settlement.
async function readOrderFinancials(orders, { select }) {
  const list = Array.isArray(orders) ? orders : [];
  const uidFilter = orderUidInFilter(list);
  const sessionFilter = inFilter(nonEmptyStrings(list.map((o) => o && o.service_session_id)));
  const orderIdFilter = inFilter(nonEmptyStrings(list.filter((o) => o && o.service_session_id).map((o) => o.id)));
  const [revisions, events] = await Promise.all([
    uidFilter
      ? select('order_obligations', `order_uid=${uidFilter}&order=order_uid.asc,revision.asc`)
      : [],
    sessionFilter && orderIdFilter
      ? select(
          'order_financial_events',
          `service_session_id=${sessionFilter}&order_id=${orderIdFilter}`
          + `&type=in.(${SETTLEMENT_EVENT_TYPES.join(',')})`,
        )
      : [],
  ]);

  const revisionsByUid = new Map();
  for (const revision of Array.isArray(revisions) ? revisions : []) {
    const key = String(revision.order_uid);
    if (!revisionsByUid.has(key)) revisionsByUid.set(key, []);
    revisionsByUid.get(key).push(revision);
  }
  const eventsByOrder = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const key = `${event.service_session_id}|${event.order_id}`;
    if (!eventsByOrder.has(key)) eventsByOrder.set(key, []);
    eventsByOrder.get(key).push(event);
  }

  return (order) => {
    const financial = projectOrderFinancial(
      order,
      revisionsByUid.get(String(order && order.order_uid)) || [],
    );
    const ownEvents = order && order.service_session_id
      ? eventsByOrder.get(`${order.service_session_id}|${order.id}`) || []
      : [];
    return { ...financial, ...projectOrderSettlement(order, financial, ownEvents) };
  };
}

// Returns a NEW array of shallow-cloned rows, each with an added `financial`
// object: { orderUid, originalObligation, currentObligation, commercialAdjustment,
// obligationRevision, adjustable } (projectOrderFinancial) plus { netCollected,
// outstanding, overCollected, payState, legacyPaymentConflict }.
async function attachOrderFinancial(orders, { select }) {
  const list = Array.isArray(orders) ? orders : [];
  if (list.length === 0) return list;
  const financialOf = await readOrderFinancials(list, { select });
  return list.map((order) => ({ ...order, financial: financialOf(order) }));
}

module.exports = {
  attachOrderFinancial, readOrderFinancials, projectOrderSettlement, orderUidInFilter, SETTLEMENT_EVENT_TYPES,
};
