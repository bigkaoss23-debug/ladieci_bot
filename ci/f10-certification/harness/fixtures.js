"use strict";
// F-10.3C CI-ONLY fixture construction, direct-to-Postgres (psql), never
// through the application transport. Builds ONLY what Phase 7 explicitly
// assigns to the harness (not the bootstrap seed): a stale Operational
// Service A per scenario, each on its own disjoint synthetic business_date
// so scenarios never collide with each other (service_sessions_single_
// active_uq allows only one status IN ('open','closing') row at a time --
// distinct dates keep each scenario's fixture independently diagnosable in
// evidence dumps even though correctness only requires the PREVIOUS
// scenario's session to already be closed).
//
// KEY FINDING that shapes this file's one non-obvious technique: EVERY
// insert into ordenes fires ordenes_assign_service_session, whose function
// body (service_session_assign_order) unconditionally overwrites
// NEW.service_session_id with resolve_order_intake_context_v1()'s own
// notion of the CURRENT period -- it does not respect a caller-supplied
// value (and raises SERVICE_SESSION_FORGERY if one is supplied that
// disagrees). This makes it structurally impossible to INSERT a residue
// order attributed to an already-stale service via a normal insert: the
// trigger would either reassign it to whatever IS current, or the insert
// would fail outright. The one clean way to construct this exact fixture
// row is to temporarily disable that one trigger for the single fixture
// INSERT, then immediately re-enable it -- never done to any REAL
// application-path insert (Order A / Order B in the two-order race use the
// real, fully-enabled trigger chain). This technique is applied only to
// this disposable, ephemeral CI database.
const { runSqlFile, queryScalar } = require("./lib/pg");

function q(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

// Creates a real, singleton-legal, stale Operational Service. Relies on
// service_session_business_day_derive_v1 (a real, unmodified trigger) to
// create/attach the matching business_days row automatically -- no manual
// business_days INSERT needed, no manual pointer-table writes needed (the
// pointer table starts NULL from the V3 seed and is only ever written by
// the resolver itself or by close_service_session_v3's own ownership-gated
// clear, both real, unmodified code paths).
function createStaleOperationalService({ businessDate, openedBy = "f10-cert" }) {
  const sql = `
    INSERT INTO public.service_sessions
      (business_date, status, opened_by, open_source, service_kind, lifecycle_semantics)
    VALUES
      (${q(businessDate)}, 'open', ${q(openedBy)}, 'f10_cert_fixture', NULL, 'operational_service_v1')
    RETURNING id;
  `;
  const id = queryScalar(sql);
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    throw new Error(`createStaleOperationalService: unexpected id output: ${JSON.stringify(id)}`);
  }
  return id;
}

// Inserts a residue order (operational and/or financial exposure) directly
// attributed to the given (already-stale) service session, via the
// disable/enable trigger bracket described above. Everything else about
// the insert goes through the REAL trigger chain (mesa_prepare_table_
// order_v1 no-ops for a non-table order; ordenes_order_entity_anchor_v1
// still runs for real, minting a real order_entities row/ticket number).
function insertResidueOrder({ serviceSessionId, orderId, estado, totale, yaPagado, cobrado }) {
  const sql = `
    BEGIN;
    ALTER TABLE public.ordenes DISABLE TRIGGER ordenes_assign_service_session;
    INSERT INTO public.ordenes
      (id, nombre, tel, canal, items, estado, totale, ya_pagado, cobrado, service_session_id, ts)
    VALUES
      (${q(orderId)}, 'F10 CI fixture', '', 'MANUAL', '[]'::jsonb, ${q(estado)}, ${Number(totale)},
       ${yaPagado ? "true" : "false"}, ${cobrado ? "true" : "false"}, ${q(serviceSessionId)}::uuid, extract(epoch from now())*1000);
    ALTER TABLE public.ordenes ENABLE TRIGGER ordenes_assign_service_session;
    COMMIT;
  `;
  runSqlFile(sql);
}

module.exports = { createStaleOperationalService, insertResidueOrder };
