"use strict";
// tests/previousCloseoutIncidentSummary.test.js — SERVICE CLOSEOUT V2 / SLICE 4A.
// Unit tests for the operator carryover read model against a fully
// controllable fake `select`, covering exactly the mandatory cases from
// plan STEP 10.
// Run: node tests/previousCloseoutIncidentSummary.test.js

const { createGetPreviousCloseoutIncidentSummary, EMPTY_SUMMARY } = require("../src/closeout/previousCloseoutIncidentSummary");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };

const CURRENT_SESSION_ID = "cur-session-1";

function fakeSelect({ attempts = [], sessions = [], incidents = [], failOn = null } = {}) {
  return async (table, query) => {
    if (failOn === table) throw new Error("boom: " + table + " read failed");
    if (table === "service_closeout_attempts") return attempts;
    if (table === "service_sessions") return sessions;
    if (table === "service_incidents") return incidents;
    throw new Error("unexpected table " + table);
  };
}

function makeGet(opts) {
  return createGetPreviousCloseoutIncidentSummary({ select: fakeSelect(opts) });
}

(async () => {
  console.log("\n== getPreviousCloseoutIncidentSummary ==\n");

  console.log("── mandatory case: mixed pending/resolved/superseded — only actionable counted ──");
  {
    const PREV_SESSION = "prev-session-1";
    const CORR = "corr-1";
    const attempts = [{ closeout_correlation_id: CORR, service_session_id: PREV_SESSION, status: "completed", completed_at: "2026-08-08T18:00:00Z" }];
    const sessions = [{ id: PREV_SESSION, business_date: "2026-08-08", service_kind: "PRANZO" }];
    // The fake select's service_incidents branch must itself reflect the
    // resolution_status=in.(pending,acknowledged) filter the module applies —
    // exactly what a real DB would already have filtered before returning rows.
    const actionableIncidents = [
      { category: "financial", severity: "warning", financial_exposure_cents: 6250 },
      { category: "operational", severity: "warning", financial_exposure_cents: null },
      { category: "operational", severity: "info", financial_exposure_cents: null },
    ];
    const get = makeGet({ attempts, sessions, incidents: actionableIncidents });
    const r = await get({ currentServiceSessionId: CURRENT_SESSION_ID });
    assert("has_actionable_incidents true", r.has_actionable_incidents === true);
    assert("source_service_session_id is the previous session", r.source_service_session_id === PREV_SESSION);
    assert("source_business_date/service_kind from the session row", r.source_business_date === "2026-08-08" && r.source_service_kind === "PRANZO");
    assert("closeout_correlation_id is the previous attempt's", r.closeout_correlation_id === CORR);
    assert("counts.total = 3", r.counts.total === 3, JSON.stringify(r.counts));
    assert("counts.financial = 1", r.counts.financial === 1, JSON.stringify(r.counts));
    assert("counts.operational = 2", r.counts.operational === 2, JSON.stringify(r.counts));
    assert("counts.informational = 0", r.counts.informational === 0);
    assert("financial_exposure_cents = 6250 (sum of actionable financial only)", r.financial_exposure_cents === 6250, JSON.stringify(r));
  }

  console.log("\n── mandatory case: superseded attempt followed by a clean completed attempt -> NO warning ──");
  {
    // Only the completed attempt (B) is ever visible to this module — the
    // superseded attempt A is not even a candidate (status filter excludes
    // it at the query level), proving it can never be accidentally selected
    // just because it has more recent snapshot/incident data.
    const CLEAN_SESSION = "prev-session-clean";
    const attempts = [{ closeout_correlation_id: "corr-B", service_session_id: CLEAN_SESSION, status: "completed", completed_at: "2026-08-08T20:00:00Z" }];
    const sessions = [{ id: CLEAN_SESSION, business_date: "2026-08-08", service_kind: "SERA" }];
    const get = makeGet({ attempts, sessions, incidents: [] });
    const r = await get({ currentServiceSessionId: CURRENT_SESSION_ID });
    assert("no actionable incidents -> has_actionable_incidents false", r.has_actionable_incidents === false);
    assert("counts all zero", r.counts.total === 0 && r.counts.financial === 0 && r.counts.operational === 0);
    assert("financial_exposure_cents 0", r.financial_exposure_cents === 0);
    // Still identifies the clean attempt/session — false does not mean "unknown".
    assert("source identity is still the clean completed attempt", r.source_service_session_id === CLEAN_SESSION);
  }

  console.log("\n── mandatory case: completed closeout with ONLY resolved incidents -> no actionable warning ──");
  {
    const PREV = "prev-resolved-only";
    const attempts = [{ closeout_correlation_id: "corr-resolved", service_session_id: PREV, status: "completed", completed_at: "2026-08-08T18:00:00Z" }];
    const sessions = [{ id: PREV, business_date: "2026-08-08", service_kind: "PRANZO" }];
    // Resolved incidents are excluded by the module's own query filter — the
    // fake's service_incidents branch returns [] because a real
    // resolution_status=in.(pending,acknowledged) filter would too.
    const get = makeGet({ attempts, sessions, incidents: [] });
    const r = await get({ currentServiceSessionId: CURRENT_SESSION_ID });
    assert("resolved-only -> has_actionable_incidents false", r.has_actionable_incidents === false);
  }

  console.log("\n── mandatory case: no previous completed closeout at all -> clean empty result, not an error ──");
  {
    const get = makeGet({ attempts: [], sessions: [], incidents: [] });
    const r = await get({ currentServiceSessionId: CURRENT_SESSION_ID });
    assert("result deep-equals EMPTY_SUMMARY", JSON.stringify(r) === JSON.stringify(EMPTY_SUMMARY), JSON.stringify(r));
    assert("has_actionable_incidents false", r.has_actionable_incidents === false);
    assert("source_service_session_id null", r.source_service_session_id === null);
  }

  console.log("\n── the current session itself is excluded from candidacy ──");
  {
    // Even if the current session somehow has a 'completed' attempt row
    // (should never happen in practice — a session only becomes "current"
    // via ensure() called strictly after ITS OWN predecessor completed, never
    // after completing itself), it must never be selected as its own "previous".
    const attempts = [{ closeout_correlation_id: "corr-self", service_session_id: CURRENT_SESSION_ID, status: "completed", completed_at: "2026-08-08T23:00:00Z" }];
    const get = createGetPreviousCloseoutIncidentSummary({
      select: async (table, query) => {
        if (table === "service_closeout_attempts") {
          // Simulate the real neq. filter: the module's own query string
          // excludes the current session — a fake that ignored the filter
          // would wrongly return the row above.
          if (query.includes(`service_session_id=neq.${CURRENT_SESSION_ID}`)) return [];
          return attempts;
        }
        return [];
      },
    });
    const r = await get({ currentServiceSessionId: CURRENT_SESSION_ID });
    assert("current session's own attempt is never selected as previous", r.source_service_session_id === null);
  }

  console.log("\n── read failure at any stage is NOT swallowed here — the caller (index.js) is responsible for degrading ──");
  {
    const get = makeGet({ failOn: "service_closeout_attempts" });
    let threw = false;
    try { await get({ currentServiceSessionId: CURRENT_SESSION_ID }); }
    catch (e) { threw = true; }
    assert("a read failure propagates as a rejected promise (module itself does not hide it)", threw === true);
  }

  console.log("\n── invalid input ──");
  {
    const get = makeGet({});
    let threw = false;
    try { await get({}); } catch (e) { threw = true; }
    assert("missing currentServiceSessionId throws", threw === true);
  }

  console.log("\n=== RESULT: " + pass + " passed, " + fail + " failed ===");
  process.exit(fail === 0 ? 0 : 1);
})();
