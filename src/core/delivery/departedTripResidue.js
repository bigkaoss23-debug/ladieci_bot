// src/core/delivery/departedTripResidue.js
// ===============================================================
// DepartedTripResidue — DELIVERY x ECONOMY DECOUPLING (migration 139).
//
// A trip that has already departed may outlive the close of its economic service: service CLOSED + trip ACTIVE
// is a valid, recoverable state. The operator's order board (getOrdenes) is scoped to the OPERATIONAL services,
// which never contain a closed one, so without this the departed trip's orders would vanish from Entregas the
// moment the service was finalized -- and the operator could no longer confirm the delivery, collect the money
// or say "Driver volvió".
//
// This returns ONLY the operational residue: the ordenes that are frozen members of an ACTIVE trip whose service
// is NOT already in the operational scope, still in an operational state (EN_ENTREGA). It NEVER widens the board
// to "everything of the old closed service": a closed service's other rows (terminal orders, leftover kitchen
// tickets recorded as incidents) stay exactly as invisible as before. Membership comes from the Trip Authority
// projection (the unchanged public.trip_projection_v1 over operational ∪ residual scope), the same source the rider
// read boundary uses -- never the DRIVER_STATO compatibility blob, never any raw giro column.
//
// Read-only. In the common case (no departed trip outside the operational scope) the whole cost is ONE light RPC.
// Best-effort by contract: the caller treats any throw as "no residue" -- the operator's board read must never fail
// because of this.
// ===============================================================
"use strict";

const { sbSelect } = require("../../utils/supabase");
const { readTripProjection, readResidualServiceScope } = require("./tripProjectionReader");

// Same operational states as the getOrdenes board itself.
const OPERATIONAL_ORDER_STATES = "POR_CONFIRMAR,NUEVO,EN_COCINA,LISTO,EN_ENTREGA";

async function readDepartedTripResidueOrders({
  select = sbSelect,
  operationalSessionIds = [],
  residualScope = readResidualServiceScope,
  readProjection = readTripProjection,
} = {}) {
  const operational = new Set((Array.isArray(operationalSessionIds) ? operationalSessionIds : []).map(String));
  const residual = await residualScope();
  // The board read is best-effort by contract, but an UNREADABLE residual is not "no residue": say so (the caller logs
  // it) instead of silently answering "nothing to add".
  if (!residual || residual.ok !== true || !Array.isArray(residual.ids)) {
    throw new Error("RESIDUAL_SCOPE_UNAVAILABLE");
  }
  const outside = residual.ids.filter((id) => !operational.has(String(id)));
  if (outside.length === 0) return [];

  const projection = await readProjection({
    getOperationalSessionIds: async () => (Array.isArray(operationalSessionIds) ? operationalSessionIds : []),
    select,
  });
  if (!projection || projection.ok !== true || projection.active !== true) return [];

  const uids = (projection.members || [])
    .map((m) => (m && m.order_uid != null ? String(m.order_uid) : ""))
    .filter(Boolean);
  if (uids.length === 0) return [];

  const rows = await select(
    "ordenes",
    `order_uid=in.(${uids.map((u) => encodeURIComponent(u)).join(",")})&estado=in.(${OPERATIONAL_ORDER_STATES})&order=ts.asc`,
  );
  return Array.isArray(rows) ? rows : [];
}

// primary first, then any extra row whose display id is not already there.
function mergeOrdersById(primary, extra) {
  const out = Array.isArray(primary) ? primary.slice() : [];
  const seen = new Set(out.map((o) => String(o && o.id)));
  for (const row of Array.isArray(extra) ? extra : []) {
    const key = String(row && row.id);
    if (row && !seen.has(key)) { seen.add(key); out.push(row); }
  }
  return out;
}

module.exports = { readDepartedTripResidueOrders, mergeOrdersById, OPERATIONAL_ORDER_STATES };
