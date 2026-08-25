"use strict";
// ===============================================================
// N-11 — WHICH SERVICE-SESSION STATUSES CARRY REPORTABLE ECONOMIC HISTORY
//
// THE DEFECT THIS EXISTS TO CLOSE. Economía's ledger reader filtered service
// sessions with an inline `["open","closing","closed"].includes(s.status)`.
// The DB's own CHECK constraint allows exactly FOUR values, so that inline
// array excluded exactly one: 'rolled_over'. Nothing stated that as a decision
// — it read as a list of "the statuses we happened to think of", and it
// silently removed real historical money from every Economía history view.
//
// WHAT 'rolled_over' ACTUALLY MEANS, from the migration that writes it
// (2026-08-16_r_day3_business_day_intake_authority.sql, verbatim):
//
//     'rolled_over' means EXACTLY: no longer current for new economic
//     attribution. Not paid, not reconciled, not empty, not closed, not
//     consolidated, not archived.
//
// It was introduced by P0-C2 (2026-08-10_service_lifecycle_economic_boundary_v1)
// precisely so an ordinary intraday PRANZO->SERA boundary could demote a period // language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values, named here to quote the migration's own rationale, not new vocabulary
// WITHOUT routing it through close_service_session_v3's hard guard. And
// service_sessions_check enforces `(status='closed') = (closed_at IS NOT NULL)`
// bidirectionally, so a rolled_over row structurally CANNOT carry closed_at —
// it has its own rolled_over_at instead.
//
// So the status is a statement about ATTRIBUTION CURRENCY, not about validity.
// It says "stop attributing new money here". It says nothing whatsoever about
// whether the money already attributed is real. Excluding it from history
// therefore made a legacy lifecycle status delete real historical money —
// which is exactly what a reporting surface must never do.
//
// THIS IS REPORTING COMPATIBILITY, NOT LIFECYCLE. Nothing here writes, nothing
// here maps one status onto another, and no historical row is normalized. A
// rolled_over session stays rolled_over forever, which is what forensics needs.
//
// WHY AN ALLOWLIST AND NOT `status !== 'something'`. The predicate must FAIL
// CLOSED: if a future migration adds a fifth status (a cancelled/voided/
// superseded kind), it must NOT silently start contributing money to Economía
// just because it is "not excluded". A new value has to be classified here, on
// purpose, by a human. `serviceStatusReporting.test.js` pins this allowlist to
// the live CHECK constraint's value set so the two cannot drift apart quietly.
// ===============================================================

// The complete status vocabulary, mirroring service_sessions_status_check:
//   CHECK (status = ANY (ARRAY['open','closing','closed','rolled_over']))
const SERVICE_SESSION_STATUSES = Object.freeze([
  "open",
  "closing",
  "closed",
  "rolled_over",
]);

// Statuses whose economic facts belong in HISTORICAL economic reporting.
//
// All four known values qualify, each for its own reason, and that is a
// decision rather than an absence of one:
//   open        — the live service; money is accruing right now.
//   closing     — mid-close; its money already exists.
//   closed      — finalized; the signed-off record.
//   rolled_over — historical period, no longer the attribution target, but its
//                 already-attributed facts are as real as any other session's.
//
// Anything not in this set is NOT reportable until classified.
const ECONOMICALLY_REPORTABLE_STATUSES = Object.freeze(new Set([
  "open",
  "closing",
  "closed",
  "rolled_over",
]));

// Statuses that are HISTORICAL, i.e. no longer the live attribution target, and
// whose orders may therefore have been moved to the archive store.
//
// This drives the dual-store order read. Reading only the live table for a
// historical session is a known zero-reporting bug: it was reproduced for real
// against staging service 480eca89 (262.50 EUR reported as 0.00) and fixed for
// 'closed'. 'rolled_over' is historical in exactly the same sense, so it gets
// the same dual-store read rather than waiting to be discovered the same way.
// Today this is provably inert — zero archived rows point at a rolled_over
// session — which is precisely why it is safe to make correct now.
const HISTORICAL_STATUSES = Object.freeze(new Set(["closed", "rolled_over"]));

// May this session's economic facts appear in historical economic reporting?
// Fail-closed: an unknown/absent status is never reportable.
function isEconomicallyReportableServiceStatus(status) {
  return ECONOMICALLY_REPORTABLE_STATUSES.has(String(status || ""));
}

// Is this session historical, i.e. might its orders live in the archive store
// rather than the live one? Fail-closed the other way round: an unknown status
// is treated as live-only, never as a licence to widen a query.
function isHistoricalServiceStatus(status) {
  return HISTORICAL_STATUSES.has(String(status || ""));
}

// Is this a period that was demoted by an economic-period roll rather than
// finalized? Used ONLY to explain the absence of a Finalizar snapshot — never
// to synthesize one. See closedServiceEconomicTruth.js.
function isRolledOverServiceStatus(status) {
  return String(status || "") === "rolled_over";
}

module.exports = {
  SERVICE_SESSION_STATUSES,
  isEconomicallyReportableServiceStatus,
  isHistoricalServiceStatus,
  isRolledOverServiceStatus,
};
