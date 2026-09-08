'use strict';

// UNIFIED_CASH_UI_SURFACE_V1 — attach the canonical per-order `financial` shape
// to a plain list of `ordenes` rows, in ONE batched order_obligations read
// (never N+1).
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
// PURELY ADDITIVE / READ ONLY. Every existing field on each order row is left
// untouched; `financial` is added alongside. No row is materialised, no write
// happens, `ordenes.totale` is never modified.

const { projectOrderFinancial } = require('./mesaService');

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

// orders   : array of raw `ordenes` rows (as returned by sbSelect('ordenes', …)).
// select   : the same sbSelect(table, query) the caller already uses. ONE call.
//
// Returns a NEW array of shallow-cloned rows, each with an added `financial`
// object: { orderUid, originalObligation, currentObligation, commercialAdjustment,
// obligationRevision, adjustable } — exactly projectOrderFinancial's shape,
// nothing more.
async function attachOrderFinancial(orders, { select }) {
  const list = Array.isArray(orders) ? orders : [];
  if (list.length === 0) return list;

  const filter = orderUidInFilter(list);
  const revisions = filter
    ? await select(
        'order_obligations',
        `order_uid=${filter}&order=order_uid.asc,revision.asc`,
      )
    : [];

  const revisionsByUid = new Map();
  for (const revision of Array.isArray(revisions) ? revisions : []) {
    const key = String(revision.order_uid);
    if (!revisionsByUid.has(key)) revisionsByUid.set(key, []);
    revisionsByUid.get(key).push(revision);
  }

  return list.map((order) => ({
    ...order,
    financial: projectOrderFinancial(
      order,
      revisionsByUid.get(String(order && order.order_uid)) || [],
    ),
  }));
}

module.exports = { attachOrderFinancial, orderUidInFilter };
