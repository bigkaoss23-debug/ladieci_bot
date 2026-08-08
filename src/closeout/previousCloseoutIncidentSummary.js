"use strict";
// ===============================================================
// previousCloseoutIncidentSummary.js — SERVICE CLOSEOUT V2 / SLICE 4A
//
// Operator carryover read model. Answers exactly one question for the
// CURRENT service session: "does the closeout attempt that immediately
// preceded this one still have actionable (pending/acknowledged) incidents
// the operator should know about?" Read-only — no incident is ever mutated
// here, and no resolution/acknowledge/defer path is wired anywhere in this
// module.
//
// AUTHORITATIVE "PREVIOUS CLOSEOUT" RULE (Slice 4A audit): the most recently
// COMPLETED service_closeout_attempts row whose service_session_id is NOT
// the current session — never inferred from "latest snapshot" and never
// from wall-clock time. A superseded attempt is excluded by the status
// filter alone (status='completed' only); this is also safe by construction
// even without the filter, because the Slice 3.2 supersession RPC (see
// migrations/2026-08-08_service_closeout_attempt_ownership.sql) atomically
// disposes every still-actionable incident of a superseded attempt to
// resolution_status='superseded' in the SAME transaction as its own status
// flip — a superseded attempt could never surface an actionable incident
// here even if it were somehow selected.
//
// Why "most recent completed attempt, current session excluded" is already
// correct without comparing timestamps against the current session's own
// opened_at: a service session is only ever created by ensure_service_session
// (via serviceSessionLifecycle.ensure(), called from incidentSafeRollover.js
// strictly AFTER that same attempt-ownership migration's completion RPC has
// already succeeded for the session it replaces). So by the time the
// current session exists at all, the attempt that closed its predecessor is
// already the most recent completed one in the whole table — no additional
// ordering proof needed.
//
// Failure contract: every caller (index.js) MUST treat a rejection from this
// module as non-fatal to the response it is enriching — see the header
// comment at the ensureCurrentServiceSession call site in index.js.
// ===============================================================

const { sbSelect } = require("../utils/supabase");

const ACTIONABLE_STATUSES = Object.freeze(["pending", "acknowledged"]);
const COUNTED_CATEGORIES = Object.freeze(["informational", "operational", "financial"]);

const EMPTY_SUMMARY = Object.freeze({
  has_actionable_incidents: false,
  source_service_session_id: null,
  source_business_date: null,
  source_service_kind: null,
  closeout_correlation_id: null,
  counts: Object.freeze({ total: 0, informational: 0, operational: 0, financial: 0, critical: 0 }),
  financial_exposure_cents: 0,
});

function createGetPreviousCloseoutIncidentSummary({ select = sbSelect } = {}) {
  return async function getPreviousCloseoutIncidentSummary({ currentServiceSessionId } = {}) {
    if (!currentServiceSessionId || typeof currentServiceSessionId !== "string") {
      throw new Error("getPreviousCloseoutIncidentSummary requires currentServiceSessionId");
    }

    const attempts = await select(
      "service_closeout_attempts",
      `status=eq.completed&service_session_id=neq.${encodeURIComponent(currentServiceSessionId)}&order=completed_at.desc&limit=1`,
    );
    const previous = Array.isArray(attempts) ? attempts[0] : null;
    if (!previous) return EMPTY_SUMMARY;

    const sessions = await select(
      "service_sessions",
      `id=eq.${encodeURIComponent(previous.service_session_id)}&limit=1`,
    );
    const session = Array.isArray(sessions) ? sessions[0] : null;

    const incidents = await select(
      "service_incidents",
      `closeout_correlation_id=eq.${encodeURIComponent(previous.closeout_correlation_id)}`
      + `&resolution_status=in.(${ACTIONABLE_STATUSES.join(",")})`
      + `&select=category,severity,financial_exposure_cents`,
    );
    const rows = Array.isArray(incidents) ? incidents : [];

    const counts = { total: rows.length, informational: 0, operational: 0, financial: 0, critical: 0 };
    let financialExposureCents = 0;
    for (const row of rows) {
      if (COUNTED_CATEGORIES.includes(row.category)) counts[row.category]++;
      if (row.severity === "critical") counts.critical++;
      if (row.category === "financial") financialExposureCents += Number(row.financial_exposure_cents) || 0;
    }

    return {
      has_actionable_incidents: rows.length > 0,
      source_service_session_id: previous.service_session_id,
      source_business_date: session ? session.business_date : null,
      source_service_kind: session ? session.service_kind : null,
      closeout_correlation_id: previous.closeout_correlation_id,
      counts,
      financial_exposure_cents: financialExposureCents,
    };
  };
}

const getPreviousCloseoutIncidentSummary = createGetPreviousCloseoutIncidentSummary();

module.exports = {
  createGetPreviousCloseoutIncidentSummary,
  getPreviousCloseoutIncidentSummary,
  EMPTY_SUMMARY,
  ACTIONABLE_STATUSES,
};
