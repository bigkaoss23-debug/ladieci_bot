"use strict";
// F-10.3C CI-ONLY evidence capture (Phase 18) -- direct-to-Postgres reads
// (psql), scoped counts and key status fields only, never full row payloads
// (this DB only ever holds synthetic CI fixture data, but the discipline is
// kept anyway: sanitized counts/facts, not raw dumps, matching the rest of
// this program's logging discipline).
const { queryJson, queryScalar } = require("./lib/pg");

function q(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

function captureEvidence({ serviceSessionIds = [] } = {}) {
  const idList = serviceSessionIds.length
    ? serviceSessionIds.map((id) => q(id)).join(",")
    : "'00000000-0000-0000-0000-000000000000'";

  const sessions = queryJson(`
    SELECT id, status, lifecycle_semantics, service_kind, business_day_id,
           rolled_over_at, closed_by, close_source
    FROM public.service_sessions WHERE id IN (${idList})
  `);
  const businessDays = queryJson(`
    SELECT bd.id, bd.business_date, bd.ticket_epoch, bd.next_ticket_number
    FROM public.business_days bd
    WHERE bd.id IN (SELECT business_day_id FROM public.service_sessions WHERE id IN (${idList}))
  `);
  const attempts = queryJson(`
    SELECT closeout_correlation_id, service_session_id, status
    FROM public.service_closeout_attempts WHERE service_session_id IN (${idList})
  `);
  const snapshots = queryJson(`
    SELECT id, service_session_id, closeout_correlation_id, lifecycle_semantics
    FROM public.service_closeout_snapshots WHERE service_session_id IN (${idList})
  `);
  const closeouts = queryJson(`
    SELECT id, service_session_id, closeout_correlation_id, close_source, closed_by,
           order_count, unpaid_exposure_cents, incident_count, critical_incident_count
    FROM public.service_closeouts WHERE service_session_id IN (${idList})
  `);
  const incidents = queryJson(`
    SELECT id, service_session_id, incident_type, category, severity, resolution_status
    FROM public.service_incidents WHERE service_session_id IN (${idList})
  `);
  const audit = queryJson(`
    SELECT id, service_session_id, event_type, by_actor, source
    FROM public.service_session_audit WHERE service_session_id IN (${idList})
  `);
  const orders = queryJson(`
    SELECT id, estado, service_session_id, service_order_number, totale, ya_pagado
    FROM public.ordenes WHERE service_session_id IN (${idList})
  `);
  const financialEvents = queryJson(`
    SELECT order_id, service_session_id FROM public.order_financial_events
    WHERE service_session_id IN (${idList})
  `);
  const pointers = queryJson(`
    SELECT
      (SELECT current_business_day_id FROM public.business_day_lifecycle_state LIMIT 1) AS current_business_day_id,
      (SELECT current_period_id FROM public.business_day_lifecycle_state LIMIT 1) AS current_period_id,
      (SELECT current_session_id FROM public.service_session_state LIMIT 1) AS current_session_id
  `);

  return {
    serviceSessionIds,
    counts: {
      service_sessions: sessions.length,
      business_days: businessDays.length,
      service_closeout_attempts: attempts.length,
      active_closeout_attempts: attempts.filter((a) => a.status === "active").length,
      service_closeout_snapshots: snapshots.length,
      service_closeouts: closeouts.length,
      service_incidents: incidents.length,
      service_session_audit: audit.length,
      orders: orders.length,
      financial_events: financialEvents.length,
    },
    service_sessions: sessions,
    business_days: businessDays,
    service_closeout_attempts: attempts,
    service_closeout_snapshots: snapshots,
    service_closeouts: closeouts,
    service_incidents: incidents,
    service_session_audit: audit,
    orders,
    financial_events: financialEvents,
    lifecycle_pointers: pointers[0] || null,
  };
}

module.exports = { captureEvidence };
