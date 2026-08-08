// tests/serviceIncidentsAdminBacklog.test.js — SERVICE CLOSEOUT V2 / SLICE 4A.
// Behavioral coverage for readActions.getServiceIncidents against a small
// in-memory PostgREST-like filter evaluator (not the marker-row-echo stub
// tests/readActions.test.js uses for query-shape assertions) — proves the
// actual filtering/aggregation semantics STEP 11 requires: actionable
// default, explicit historical access, category/date/session filters never
// leak unrelated rows, financial exposure preserved exactly, attempt-status
// enrichment, and bounded pagination.
//
// Run: node tests/serviceIncidentsAdminBacklog.test.js

const assert = require("assert");

// ── fixture: a small, realistic service_incidents + service_closeout_attempts world ──
// service_session_id / closeout_correlation_id / snapshot_id / incident id are all
// real uuid columns and getServiceIncidents validates serviceSessionId/incidentId
// as uuid — every synthetic identity below is uuid-shaped for that reason.
const SESS_A = "00000000-0000-4000-8000-0000000000a1";
const SESS_B = "00000000-0000-4000-8000-0000000000b1";
const CORR_A = "00000000-0000-4000-8000-0000000000ca";
const CORR_B = "00000000-0000-4000-8000-0000000000cb";
const SNAP_A = "00000000-0000-4000-8000-0000000000da";
const SNAP_B = "00000000-0000-4000-8000-0000000000db";
const INC1 = "00000000-0000-4000-8000-000000001001";
const INC2 = "00000000-0000-4000-8000-000000001002";
const INC3 = "00000000-0000-4000-8000-000000001003";
const INC4 = "00000000-0000-4000-8000-000000001004";
const INC5 = "00000000-0000-4000-8000-000000001005";

const INCIDENTS = [
  { id: INC1, service_session_id: SESS_A, business_date: "2026-08-07", service_kind: "PRANZO", closeout_correlation_id: CORR_A, snapshot_id: SNAP_A, incident_type: "KITCHEN_WORK_PENDING_AT_CLOSE", category: "operational", severity: "warning", entity_type: "order", entity_id: "o1", order_id: "o1", table_session_id: null, giro_id: null, rider_id: null, financial_exposure_cents: null, detected_at: "2026-08-07T20:00:00Z", detected_by: "system", auto_resolved: false, resolution_status: "pending", resolution_type: null, resolved_at: null, resolved_by: null, resolution_note: null, created_at: "2026-08-07T20:00:00Z", updated_at: "2026-08-07T20:00:00Z" },
  { id: INC2, service_session_id: SESS_A, business_date: "2026-08-07", service_kind: "PRANZO", closeout_correlation_id: CORR_A, snapshot_id: SNAP_A, incident_type: "UNPAID_BALANCE_AT_CLOSE", category: "financial", severity: "warning", entity_type: "order", entity_id: "o2", order_id: "o2", table_session_id: null, giro_id: null, rider_id: null, financial_exposure_cents: 6250, detected_at: "2026-08-07T20:01:00Z", detected_by: "system", auto_resolved: false, resolution_status: "pending", resolution_type: null, resolved_at: null, resolved_by: null, resolution_note: null, created_at: "2026-08-07T20:01:00Z", updated_at: "2026-08-07T20:01:00Z" },
  { id: INC3, service_session_id: SESS_A, business_date: "2026-08-07", service_kind: "PRANZO", closeout_correlation_id: CORR_A, snapshot_id: SNAP_A, incident_type: "ORDER_READY_NOT_FINALIZED_AT_CLOSE", category: "operational", severity: "info", entity_type: "order", entity_id: "o3", order_id: "o3", table_session_id: null, giro_id: null, rider_id: null, financial_exposure_cents: null, detected_at: "2026-08-07T20:02:00Z", detected_by: "admin", auto_resolved: false, resolution_status: "resolved", resolution_type: "manual_review", resolved_at: "2026-08-07T21:00:00Z", resolved_by: "admin", resolution_note: null, created_at: "2026-08-07T20:02:00Z", updated_at: "2026-08-07T21:00:00Z" },
  { id: INC4, service_session_id: SESS_B, business_date: "2026-08-06", service_kind: "SERA", closeout_correlation_id: CORR_B, snapshot_id: SNAP_B, incident_type: "EMPTY_TABLE_LEFT_OPEN", category: "informational", severity: "info", entity_type: "table_session", entity_id: "t1", order_id: null, table_session_id: "t1", giro_id: null, rider_id: null, financial_exposure_cents: null, detected_at: "2026-08-06T23:00:00Z", detected_by: "system", auto_resolved: true, resolution_status: "resolved", resolution_type: "auto_released_empty_table", resolved_at: "2026-08-06T23:00:00Z", resolved_by: "system", resolution_note: null, created_at: "2026-08-06T23:00:00Z", updated_at: "2026-08-06T23:00:00Z" },
  { id: INC5, service_session_id: SESS_B, business_date: "2026-08-06", service_kind: "SERA", closeout_correlation_id: CORR_B, snapshot_id: SNAP_B, incident_type: "UNPAID_BALANCE_AT_CLOSE", category: "financial", severity: "warning", entity_type: "order", entity_id: "o4", order_id: "o4", table_session_id: null, giro_id: null, rider_id: null, financial_exposure_cents: 1000, detected_at: "2026-08-06T23:05:00Z", detected_by: "system", auto_resolved: false, resolution_status: "superseded", resolution_type: "closeout_attempt_superseded", resolved_at: "2026-08-06T23:30:00Z", resolved_by: "system", resolution_note: null, created_at: "2026-08-06T23:05:00Z", updated_at: "2026-08-06T23:30:00Z" },
];
const ATTEMPTS = [
  { closeout_correlation_id: CORR_A, status: "completed" },
  { closeout_correlation_id: CORR_B, status: "superseded" },
];

function evalFilter(rows, query) {
  let out = rows;
  // Anchored on (?:^|&) so e.g. "id=eq." never matches as a substring tail of
  // "service_session_id=eq." — a real PostgREST query is parsed field-by-field,
  // this mirrors that instead of naive substring matching.
  const inMatch = (field) => { const m = query.match(new RegExp("(?:^|&)" + field + "=in\\.\\(([^)]*)\\)")); return m ? m[1].split(",") : null; };
  const eqMatch = (field) => { const m = query.match(new RegExp("(?:^|&)" + field + "=eq\\.([^&]*)")); return m ? decodeURIComponent(m[1]) : null; };
  const resStatus = inMatch("resolution_status"); if (resStatus) out = out.filter((r) => resStatus.includes(r.resolution_status));
  const cat = inMatch("category"); if (cat) out = out.filter((r) => cat.includes(r.category));
  const bdate = eqMatch("business_date"); if (bdate) out = out.filter((r) => r.business_date === bdate);
  const sid = eqMatch("service_session_id"); if (sid) out = out.filter((r) => r.service_session_id === sid);
  const id = eqMatch("id"); if (id) out = out.filter((r) => r.id === id);
  const corrIn = inMatch("closeout_correlation_id"); if (corrIn) {
    const cleaned = corrIn.map((s) => s.replace(/"/g, ""));
    out = out.filter((r) => cleaned.includes(r.closeout_correlation_id));
  }
  // limit is a plain PostgREST reserved param (no "eq." operator), unlike a column filter.
  const limMatch = query.match(/(?:^|&)limit=(\d+)/);
  if (limMatch) out = out.slice(0, Number(limMatch[1]));
  return out;
}

const supabasePath = require.resolve("../src/utils/supabase");
require.cache[supabasePath] = {
  id: supabasePath, filename: supabasePath, loaded: true,
  exports: {
    sbSelect: async (table, query) => {
      if (table === "service_incidents") return evalFilter(INCIDENTS, query);
      if (table === "service_closeout_attempts") return evalFilter(ATTEMPTS, query);
      throw new Error("unexpected table " + table);
    },
    sbUpsert: async () => [], sbUpdate: async () => [], sbInsert: async () => [], sbDelete: async () => [], getConfig: async () => ({}),
  },
};

const R = require("../src/utils/readActions");

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label} ${extra}`); }
}

(async () => {
  console.log("\n── Default: actionable only (pending/acknowledged) ──");
  const def = await R.getServiceIncidents();
  check("default returns exactly the 2 pending rows (INC1, INC2)",
    def.length === 2 && def.every((r) => [INC1, INC2].includes(r.id)), JSON.stringify(def.map((r) => r.id)));
  check("resolved/superseded excluded from the default view",
    !def.some((r) => ["resolved", "superseded"].includes(r.resolution_status)));

  console.log("\n── Explicit historical filter surfaces resolved/superseded ──");
  const hist = await R.getServiceIncidents({ resolutionStatus: "resolved,superseded" });
  check("historical filter returns exactly INC3, INC4, INC5",
    hist.length === 3 && [INC3, INC4, INC5].every((id) => hist.some((r) => r.id === id)), JSON.stringify(hist.map((r) => r.id)));

  console.log("\n── Financial exposure preserved exactly, never recomputed ──");
  const fin = await R.getServiceIncidents({ resolutionStatus: "pending", category: "financial" });
  check("financial exposure is exactly 6250 cents, untouched", fin.length === 1 && fin[0].financial_exposure_cents === 6250, JSON.stringify(fin));

  console.log("\n── Category/date/session filters never leak unrelated rows ──");
  const byDate = await R.getServiceIncidents({ resolutionStatus: "pending,acknowledged,resolved,superseded", businessDate: "2026-08-06" });
  check("businessDate=2026-08-06 returns ONLY sess-B rows (INC4, INC5), nothing from sess-A",
    byDate.length === 2 && byDate.every((r) => r.service_session_id === SESS_B), JSON.stringify(byDate.map((r) => r.id)));
  const bySession = await R.getServiceIncidents({ resolutionStatus: "pending,acknowledged,resolved,superseded", serviceSessionId: SESS_A });
  check("serviceSessionId=sess-A returns ONLY sess-A rows, none from sess-B",
    bySession.length === 3 && bySession.every((r) => r.service_session_id === SESS_A), JSON.stringify(bySession.map((r) => r.id)));
  const byCategory = await R.getServiceIncidents({ resolutionStatus: "pending,acknowledged,resolved,superseded", category: "informational" });
  check("category=informational returns ONLY INC4",
    byCategory.length === 1 && byCategory[0].id === INC4, JSON.stringify(byCategory.map((r) => r.id)));
  const combined = await R.getServiceIncidents({ resolutionStatus: "resolved,superseded", businessDate: "2026-08-06", category: "financial" });
  check("combined filters AND together (date+category+status), returns ONLY INC5",
    combined.length === 1 && combined[0].id === INC5, JSON.stringify(combined.map((r) => r.id)));

  console.log("\n── Attempt-status enrichment ──");
  const enriched = await R.getServiceIncidents({ resolutionStatus: "pending,acknowledged,resolved,superseded" });
  check("corr-A incidents carry attempt_status='completed'",
    enriched.filter((r) => r.closeout_correlation_id === CORR_A).every((r) => r.attempt_status === "completed"));
  check("corr-B incidents carry attempt_status='superseded'",
    enriched.filter((r) => r.closeout_correlation_id === CORR_B).every((r) => r.attempt_status === "superseded"));

  console.log("\n── Incident detail lookup ──");
  const detail = await R.getServiceIncidents({ incidentId: INC2 });
  check("detail lookup returns the exact row with attempt_status enrichment",
    detail && detail.id === INC2 && detail.financial_exposure_cents === 6250 && detail.attempt_status === "completed", JSON.stringify(detail));
  const missing = await R.getServiceIncidents({ incidentId: "99999999-9999-4999-8999-999999999999" });
  check("detail lookup for a non-existent id returns null, not an error", missing === null);

  console.log("\n── Pagination is bounded ──");
  const bounded = await R.getServiceIncidents({ resolutionStatus: "pending,acknowledged,resolved,superseded", limit: 2 });
  check("limit=2 returns at most 2 rows", bounded.length === 2, JSON.stringify(bounded.map((r) => r.id)));

  console.log("\n── No mutation surface exists ──");
  const exportedFns = Object.keys(R);
  check("no resolve/acknowledge/write function exported by readActions for incidents",
    !exportedFns.some((k) => /incident/i.test(k) && /(resolve|acknowledge|write|update|delete|defer)/i.test(k)));

  console.log(`\n${fail === 0 ? "✅" : "❌"} serviceIncidentsAdminBacklog: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
