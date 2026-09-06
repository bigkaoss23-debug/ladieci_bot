// tests/serviceIncidentsSlice4aHttpIntegration.test.js — SERVICE CLOSEOUT V2 / SLICE 4A.
// Exercises the REAL Express route stack of index.js, mirroring
// getOrdenesArchivadosSesionHttpIntegration.test.js's stub setup (DAO +
// supabase stubbed via require.cache, JWT real). Proves two things live:
//   1. getServiceIncidents is genuinely admin-only at the HTTP layer.
//   2. ensureCurrentServiceSession's carryover enrichment is present on a
//      normal success and degrades to simply omitting the field — never a
//      5xx, never a different session, never a blocked response — when the
//      read model itself fails (plan STEP 9).
// Localhost only — no DB / Railway / Netlify / Supabase network.
// Run: node tests/serviceIncidentsSlice4aHttpIntegration.test.js

const http = require("http");

process.env.AUTH_JWT_SECRET_B64URL = Buffer.from("slice4a_test_secret_key_at_least_32_bytes!!!!").toString("base64url");
process.env.DASHBOARD_API_KEY = "testkey";
process.env.AUTH_V2_LEGACY_GUARD_ENABLED = "true";
process.env.SUPABASE_URL = "http://localhost.invalid";
process.env.SUPABASE_KEY = "test";

// ── stub supabase (record calls; per-table behavior configurable per test) ──
let sbCalls = [];
let serviceIncidentsBehavior = async () => [];
let closeoutAttemptsBehavior = async () => [];
const supaPath = require.resolve("../src/utils/supabase");
const realSupa = require(supaPath);
require.cache[supaPath].exports = Object.assign({}, realSupa, {
  sbSelect: async (table, query) => {
    sbCalls.push({ table, query });
    if (table === "service_incidents") return serviceIncidentsBehavior(query);
    if (table === "service_closeout_attempts") return closeoutAttemptsBehavior(query);
    if (table === "service_sessions") return [];
    return [];
  },
  getConfig: async () => ({}),
  sbUpsert: async () => ({}), sbUpdate: async () => ({}), sbInsert: async () => ({}), sbDelete: async () => ({}),
});

const SESSION_ID = "00000000-0000-4000-8000-0000000000c1";
// STALE SERVICE PROTECTION V1 — index.js now runs recoverStaleService on every
// REUSED. The current session's business_date and the canonical Business Day
// (stubbed below) are the SAME date, so that check resolves to NO_STALE_SERVICE
// and the handler continues on the ordinary success path. The stale / future /
// fail-closed branches are covered in tests/staleServiceRecovery.test.js.
const TODAY_BD = "2026-08-08";
const lifecyclePath = require.resolve("../src/serviceSessions/serviceSessionLifecycle");
const realLifecycle = require(lifecyclePath);
require.cache[lifecyclePath].exports = Object.assign({}, realLifecycle, {
  lifecycle: Object.assign({}, realLifecycle.lifecycle, {
    // No service_kind -> classifySessionForRollover returns INTEGRITY_ERROR ->
    // isRolloverDue() false -> ensureCurrentServiceSession takes the simple
    // "REUSED, no rollover" success path. business_date present and equal to
    // the canonical Business Day => the new stale-service check is a no-op.
    currentCloseout: async () => ({
      ok: true,
      session: { id: SESSION_ID, status: "open", business_date: TODAY_BD, opened_at: "2026-08-08T09:00:00Z" },
    }),
  }),
});

// recoverStaleService reads the canonical Business Day through
// orderIntakePolicy.fetchOrderIntakeContext (wraps the
// get_order_intake_context_v1 RPC). No DB here, so stub it to the same date as
// the current session: staleness = false, no recovery, no close.
const orderIntakePolicyPath = require.resolve("../src/serviceSessions/orderIntakePolicy");
const realOrderIntakePolicy = require(orderIntakePolicyPath);
require.cache[orderIntakePolicyPath].exports = Object.assign({}, realOrderIntakePolicy, {
  // recoverStaleService reads ONLY businessDate off this context.
  fetchOrderIntakeContext: async () => ({
    businessDate: TODAY_BD, canCreateNewOrder: true, hasValidCurrentService: true,
  }),
});

const daoPath = require.resolve("../src/auth/dao");
const realDao = require(daoPath);
const ACTORS = {
  owner: { actor: "owner", role: "admin", active: true, session_version: 5 },
  operator_primary: { actor: "operator_primary", role: "operator", active: true, session_version: 5 },
  rider: { actor: "rider", role: "rider", active: true, session_version: 5 },
};
require.cache[daoPath].exports = Object.assign({}, realDao, { getActor: async (a) => ACTORS[a] || null });

const jwt = require("../src/auth/jwt");
const { app } = require("../index");

let pass = 0, fail = 0;
const check = (l, c, extra = "") => { if (c) { pass++; console.log("  ✓ " + l); } else { fail++; console.log("  ✗ " + l + (extra ? " -> " + extra : "")); } };

function tok(role, sub, sv) { return jwt.signToken({ role, sub, sv, authMethod: jwt.AUTH_METHOD_ACTOR_PIN }); }
function reqHttp(server, { method = "GET", key = "testkey", auth, action, body } = {}) {
  return new Promise((resolve) => {
    const headers = { "Content-Type": "application/json" };
    if (key) headers["X-Api-Key"] = key;
    if (auth) headers["Authorization"] = "Bearer " + auth;
    const path = "/api?action=" + action;
    const { port } = server.address();
    const r = http.request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let buf = ""; res.on("data", (d) => buf += d); res.on("end", () => resolve({ status: res.statusCode, body: buf }));
    });
    r.end(body ? JSON.stringify(body) : undefined);
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const OWNER = tok("admin", "owner", 5), OP = tok("operator", "operator_primary", 5), RIDER = tok("rider", "rider", 5);

  console.log("\n── getServiceIncidents: admin-only enforcement ──");
  {
    const ACTION = "getServiceIncidents";

    sbCalls = [];
    const rOwner = await reqHttp(server, { action: ACTION, auth: OWNER });
    check("admin/owner getServiceIncidents -> 200", rOwner.status === 200, rOwner.body);
    check("owner call reached the handler (sbSelect on service_incidents)", sbCalls.some((c) => c.table === "service_incidents"));

    sbCalls = [];
    const rOp = await reqHttp(server, { action: ACTION, auth: OP });
    check("operator getServiceIncidents -> 403 (admin-only)", rOp.status === 403, rOp.body);
    check("denied operator request did NOT reach the handler", !sbCalls.some((c) => c.table === "service_incidents"));

    sbCalls = [];
    const rRider = await reqHttp(server, { action: ACTION, auth: RIDER });
    check("rider getServiceIncidents -> 403 (admin-only)", rRider.status === 403, rRider.body);
    check("denied rider request did NOT reach the handler", !sbCalls.some((c) => c.table === "service_incidents"));

    const rNoAuth = await reqHttp(server, { action: ACTION });
    check("no Bearer token -> 401", rNoAuth.status === 401, rNoAuth.body);
  }

  console.log("\n── ensureCurrentServiceSession: carryover summary present on a normal success ──");
  {
    closeoutAttemptsBehavior = async () => [];
    serviceIncidentsBehavior = async () => [];
    const r = await reqHttp(server, { method: "POST", action: "ensureCurrentServiceSession", auth: OP });
    check("ensure -> 200", r.status === 200, r.body);
    const parsed = JSON.parse(r.body);
    check("ensure succeeded", parsed.success === true, r.body);
    check("previousCloseoutIncidents field is present", Object.prototype.hasOwnProperty.call(parsed, "previousCloseoutIncidents"), r.body);
    check("no previous completed attempt -> has_actionable_incidents false", parsed.previousCloseoutIncidents && parsed.previousCloseoutIncidents.has_actionable_incidents === false, r.body);
  }

  console.log("\n── ensureCurrentServiceSession: read-model failure degrades safely, never blocks the service ──");
  {
    closeoutAttemptsBehavior = async () => { throw new Error("simulated read-model outage"); };
    const r = await reqHttp(server, { method: "POST", action: "ensureCurrentServiceSession", auth: OP });
    check("ensure STILL -> 200 even though the carryover read failed", r.status === 200, r.body);
    const parsed = JSON.parse(r.body);
    check("ensure STILL succeeded", parsed.success === true, r.body);
    check("the SAME current session is returned, not reverted/reopened/closed", parsed.session && parsed.session.id === SESSION_ID, r.body);
    check("previousCloseoutIncidents is simply OMITTED, not a 500 and not a fabricated value", !Object.prototype.hasOwnProperty.call(parsed, "previousCloseoutIncidents"), r.body);
    closeoutAttemptsBehavior = async () => []; // reset for any later test
  }

  console.log("\n── sanity: getEconomiaLedger (an existing admin-only action) is completely unaffected ──");
  {
    const r = await reqHttp(server, { action: "getEconomiaLedger", auth: OP });
    check("operator still denied getEconomiaLedger (unrelated pre-existing action, unaffected)", r.status === 403, r.body);
  }

  server.close();
  console.log(`\nserviceIncidentsSlice4aHttpIntegration: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log("FATAL " + (e && e.stack || e)); process.exit(1); });
