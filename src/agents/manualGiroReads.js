// src/agents/manualGiroReads.js — W4 Packet 02B: read-only dashboard manual-giro reader.
//
// Extracted from manualGiros.js (which stays the sole writer module, completely
// untouched by this file) so the canonical read cutover never risks the writer
// surface. manualGiros.js's own getManualGiros() becomes a thin delegate to
// getManualGirosRead() here.
//
// CURRENT operational business day -> canonical Giro Authority projection
// (public.giro_projection_v1, Planner W3). HISTORICAL business day -> the exact,
// byte-for-byte pre-W4 legacy reader (raw manual_giros + ordenes.manual_giro_id
// join) -- a genuinely separate capability, not a fallback: the projection has
// no concept of "a past day" at all.
//
// "Current" is decided by the SAME DB-authoritative source giro_projection_v1's
// own scope resolution uses (getCurrentOperationalBusinessDate, sharing its
// lifecycle-authoritative session lookup with getOperationalSessionIds) -- never
// a wall-clock calendar-day computation. The two can and do disagree by design:
// a business day only rolls at the DB's own 04:00 boundary, and only once the
// operational session actually reflects it -- exactly the class of gap the
// P0-C1/P0-C3 lifecycle-authority helpers exist to close.

"use strict";

const { sbSelect } = require("../utils/supabase");
const { getCurrentOperationalBusinessDate } = require("../serviceSessions/currentOperationalSession");
const { readGiroProjection } = require("../core/delivery/giroProjectionReader");
const { projectionAvailability } = require("../core/delivery/giroProjectionPort");

// PostgREST in.(…) literal builder for ids -- giro ids are mg_<yymmdd>_<seq>
// (alphanumeric/underscore only); order ids can contain "#" so are CSV-quoted.
// A local, tiny, pure duplicate of manualGiros.js's encodeIdList (same rationale
// as riderReads.js's own copy, W4 Packet 02A): this module must not import
// anything from manualGiros.js, the writer-adjacent module.
function encodeIdList(ids) {
  return (ids || []).map((id) => `"${encodeURIComponent(String(id).replace(/"/g, '""'))}"`).join(",");
}

// CURRENT day: every canonical fact (membership, state, salida, hora_ref,
// dissolved) comes exclusively from the projection. entrega_ref and
// anchor_order_id are legacy metadata the Authority deliberately never claims
// (migration 130 touches neither; the Authority's own anchor_order_uid is
// itself documented "audit only, never an input to derived state" -- there is
// no canonical anchor fact to prefer over the raw column) -- read as a narrow,
// explicit enrichment scoped to only the giro ids the projection already
// returned, never able to override a canonical field because it supplies two
// fields the projection doesn't expose at all.
async function currentDayCanonicalGiros(onlyActive) {
  let projection = null;
  try {
    projection = await readGiroProjection();
  } catch (_) {
    projection = null;
  }
  const avail = projectionAvailability(projection);
  if (!avail.available) {
    // Explicit, typed unavailability -- the existing dashboard consumers
    // (TabEntregas.jsx/TabCocina.jsx/PanelCocina.jsx) already branch on
    // Array.isArray(res) vs res.error and treat the latter as "don't update,
    // log a warning", never as "the giro list is empty". Confirmed by direct
    // read of all four call sites before choosing this shape -- it is not a
    // new contract, the FE was already written defensively for exactly this.
    return { error: "manual_giro_read_unavailable", reason: avail.reason || "PROJECTION_MISSING" };
  }

  const filtered = onlyActive
    ? projection.giros.filter((g) => g.giro_state !== "DISSOLVED")
    : projection.giros;

  const giroIds = filtered.map((g) => g.giro_id);
  const metaById = new Map();
  if (giroIds.length > 0) {
    try {
      const rows = (await sbSelect(
        "manual_giros",
        `id=in.(${encodeIdList(giroIds)})&select=id,entrega_ref,anchor_order_id`
      )) || [];
      for (const r of rows) metaById.set(String(r.id), r);
    } catch (_) {
      // best-effort legacy metadata only: on failure both fields are null
      // below, canonical giro facts (already resolved above) are unaffected
    }
  }

  return filtered.map((g) => {
    const meta = metaById.get(String(g.giro_id));
    return {
      id: g.giro_id,
      seq: g.seq,
      giro_day: g.business_date,
      created_at: g.created_at,
      created_by: g.created_by,
      dissolved_at: g.dissolved_at,
      hora_ref: g.hora_ref,
      anchor_order_id: meta ? (meta.anchor_order_id ?? null) : null,
      entrega_ref: meta ? (meta.entrega_ref ?? null) : null,
      order_ids: (g.effective_members || []).map((m) => m.order_id),
    };
  });
}

// HISTORICAL day: byte-for-byte the pre-W4 reader (manualGiros.js's original
// getManualGiros body). The projection has no concept of a caller-specified
// past day (it is scoped only by the CURRENT operational session) -- this is
// not a fallback, it is the only capability that can answer this query at all.
async function historicalManualGiros(giroDay, onlyActive) {
  const filter = onlyActive ? "dissolved_at=is.null&" : "";
  const giros = await sbSelect(
    "manual_giros",
    `${filter}giro_day=eq.${encodeURIComponent(giroDay)}&select=id,seq,giro_day,created_at,created_by,dissolved_at,hora_ref,anchor_order_id,entrega_ref&order=seq.asc`
  );
  if (!Array.isArray(giros) || giros.length === 0) return [];

  const ids = giros.map((g) => g.id);
  const orders = await sbSelect(
    "ordenes",
    `manual_giro_id=in.(${encodeIdList(ids)})&select=id,manual_giro_id`
  );
  const byGiro = {};
  if (Array.isArray(orders)) {
    for (const o of orders) {
      (byGiro[o.manual_giro_id] = byGiro[o.manual_giro_id] || []).push(o.id);
    }
  }
  return giros.map((g) => ({ ...g, order_ids: byGiro[g.id] || [] }));
}

// getManualGirosRead — the routing decision. `day` absent, or equal to the
// CURRENT operational business date -> canonical. `day` present and different
// (or current is unknowable) -> historical, explicit, never called a fallback:
// this is NOT "try Projection, catch -> legacy" -- the branch is chosen purely
// by whether the request is genuinely about a different day, before either
// reader is ever invoked.
async function getManualGirosRead({ day, onlyActive = true } = {}) {
  let currentBusinessDate = null;
  try {
    currentBusinessDate = await getCurrentOperationalBusinessDate();
  } catch (_) {
    currentBusinessDate = null;
  }

  const isHistorical = day != null && (currentBusinessDate == null || day !== currentBusinessDate);
  if (isHistorical) {
    return historicalManualGiros(day, onlyActive);
  }
  return currentDayCanonicalGiros(onlyActive);
}

module.exports = { getManualGirosRead, currentDayCanonicalGiros, historicalManualGiros };
