// tests/staleServiceRecoveryWiring.test.js — STALE SERVICE PROTECTION V1 / REVIEW FIX.
//
// Exercises the REAL Express route stack of index.js for the ONE synchronous
// remediation point: the `ensureCurrentServiceSession` action. Same stub setup
// as serviceIncidentsSlice4aHttpIntegration.test.js (DAO + supabase + lifecycle
// stubbed via require.cache, JWT real). recoverStaleService is stubbed
// per-case.
//
// ISSUE A — FAIL CLOSED: a REUSED result must NOT be handed back if
// recoverStaleService cannot prove the current pointer is valid for the
// canonical Business Day. Any ok:false verdict (LIFECYCLE_UNRESOLVED,
// CANONICAL_BUSINESS_DATE_UNAVAILABLE, MULTIPLE_ACTIVE_SERVICE_SESSIONS,
// SERVICE_SESSION_STATE_CORRUPT, ACTIVE_SERVICE_BUSINESS_DAY_MISMATCH) or an
// unexpected throw -> the response is non-success with the TRUTHFUL code,
// NEVER {success:true, code:'REUSED'}.
//
// Localhost only — no DB / Railway / Netlify / Supabase network.
// Run: node tests/staleServiceRecoveryWiring.test.js

const http = require("http");

process.env.AUTH_JWT_SECRET_B64URL = Buffer.from("stale_wiring_test_secret_key_at_least_32_bytes!!").toString("base64url");
process.env.DASHBOARD_API_KEY = "testkey";
process.env.AUTH_V2_LEGACY_GUARD_ENABLED = "true";
process.env.SUPABASE_URL = "http://localhost.invalid";
process.env.SUPABASE_KEY = "test";

// ── stub supabase (no network; enrichment reads degrade to []) ──
const supaPath = require.resolve("../src/utils/supabase");
const realSupa = require(supaPath);
require.cache[supaPath].exports = Object.assign({}, realSupa, {
  sbSelect: async () => [],
  getConfig: async () => ({}),
  sbUpsert: async () => ({}), sbUpdate: async () => ({}), sbInsert: async () => ({}), sbDelete: async () => ({}),
});

// ── stub the lifecycle read so ensureCurrentServiceSession returns REUSED ──
const SESSION_ID = "00000000-0000-4000-8000-0000000000d1";
const lifecyclePath = require.resolve("../src/serviceSessions/serviceSessionLifecycle");
const realLifecycle = require(lifecyclePath);
require.cache[lifecyclePath].exports = Object.assign({}, realLifecycle, {
  lifecycle: Object.assign({}, realLifecycle.lifecycle, {
    currentCloseout: async () => ({
      ok: true, session: { id: SESSION_ID, status: "open", business_date: "2026-09-06", opened_at: "2026-09-06T09:00:00Z" },
    }),
  }),
});

// ── stub recoverStaleService — reconfigurable per case ──
let recoveryBehavior = async () => ({ ok: true, stale: false, code: "NO_STALE_SERVICE" });
const staleRecoveryPath = require.resolve("../src/serviceSessions/staleServiceRecovery");
const realStaleRecovery = require(staleRecoveryPath);
require.cache[staleRecoveryPath].exports = Object.assign({}, realStaleRecovery, {
  recoverStaleService: (...args) => recoveryBehavior(...args),
});

const daoPath = require.resolve("../src/auth/dao");
const realDao = require(daoPath);
const ACTORS = {
  operator_primary: { actor: "operator_primary", role: "operator", active: true, session_version: 5 },
};
require.cache[daoPath].exports = Object.assign({}, realDao, { getActor: async (a) => ACTORS[a] || null });

const jwt = require("../src/auth/jwt");
const { app } = require("../index");

let pass = 0, fail = 0;
const check = (l, c, extra = "") => { if (c) { pass++; console.log("  ✓ " + l); } else { fail++; console.log("  ✗ " + l + (extra ? " -> " + extra : "")); } };

function reqHttp(server, { auth } = {}) {
  return new Promise((resolve) => {
    const headers = { "Content-Type": "application/json", "X-Api-Key": "testkey" };
    if (auth) headers["Authorization"] = "Bearer " + auth;
    const { port } = server.address();
    const r = http.request({ host: "127.0.0.1", port, path: "/api?action=ensureCurrentServiceSession", method: "POST", headers }, (res) => {
      let buf = ""; res.on("data", (d) => buf += d); res.on("end", () => resolve({ status: res.statusCode, body: buf }));
    });
    r.end();
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const OP = jwt.signToken({ role: "operator", sub: "operator_primary", sv: 5, authMethod: jwt.AUTH_METHOD_ACTOR_PIN });
  const ensure = () => reqHttp(server, { auth: OP });

  // ── 1. NO_STALE_SERVICE -> normal ensure continues ──
  {
    recoveryBehavior = async () => ({ ok: true, stale: false, code: "NO_STALE_SERVICE" });
    const r = await ensure();
    const p = JSON.parse(r.body);
    check("NO_STALE_SERVICE -> 200 + success:true + REUSED (normal continuation)",
      r.status === 200 && p.success === true && p.code === "REUSED" && p.session && p.session.id === SESSION_ID, r.body);
    check("NO_STALE_SERVICE -> no autoRecovery advisory attached", !p.autoRecovery, r.body);
  }

  // ── 2. AUTO_RECOVERY_PERFORMED -> ensure re-run, normal path continues, advisory attached ──
  {
    recoveryBehavior = async () => ({
      ok: true, stale: true, recovered: true, code: "AUTO_RECOVERY_PERFORMED",
      recoveredServiceSessionId: SESSION_ID, staleBusinessDate: "2026-08-25", currentBusinessDate: "2026-09-06", idempotent: false,
    });
    const r = await ensure();
    const p = JSON.parse(r.body);
    check("AUTO_RECOVERY_PERFORMED -> 200 + success:true (the re-run resolver's answer)", r.status === 200 && p.success === true, r.body);
    check("AUTO_RECOVERY_PERFORMED -> autoRecovery advisory present and typed", p.autoRecovery
      && p.autoRecovery.performed === true && p.autoRecovery.code === "AUTO_RECOVERY_PERFORMED"
      && p.autoRecovery.staleBusinessDate === "2026-08-25" && p.autoRecovery.currentBusinessDate === "2026-09-06", r.body);
  }

  // ── 3. PREVIOUS_SERVICE_PENDING -> 409, blocking, typed, NEVER success:true ──
  {
    recoveryBehavior = async () => ({
      ok: true, stale: true, recovered: false, code: "PREVIOUS_SERVICE_PENDING",
      staleServiceSessionId: "svc-old", staleBusinessDate: "2026-08-25", currentBusinessDate: "2026-09-06",
      blockers: { orders: 2, tables: 0, unpaid: 32, overCollected: 10, reconciliationError: null },
    });
    const r = await ensure();
    const p = JSON.parse(r.body);
    check("PREVIOUS_SERVICE_PENDING -> 409", r.status === 409, r.body);
    check("PREVIOUS_SERVICE_PENDING -> success:false + the canonical code + blockers", p.success === false
      && p.code === "PREVIOUS_SERVICE_PENDING" && p.staleServiceSessionId === "svc-old" && p.blockers && p.blockers.orders === 2, r.body);
    check("PREVIOUS_SERVICE_PENDING -> the operator never gets REUSED", p.code !== "REUSED", r.body);
  }

  // ── 4-6 + future: any ok:false verdict -> FAIL CLOSED, never REUSED, truthful code ──
  for (const [label, verdict, expectCode] of [
    ["LIFECYCLE_UNRESOLVED", { ok: false, stale: false, code: "LIFECYCLE_UNRESOLVED" }, "LIFECYCLE_UNRESOLVED"],
    ["CANONICAL_BUSINESS_DATE_UNAVAILABLE", { ok: false, stale: false, code: "CANONICAL_BUSINESS_DATE_UNAVAILABLE" }, "CANONICAL_BUSINESS_DATE_UNAVAILABLE"],
    ["MULTIPLE_ACTIVE_SERVICE_SESSIONS", { ok: false, stale: false, code: "MULTIPLE_ACTIVE_SERVICE_SESSIONS" }, "MULTIPLE_ACTIVE_SERVICE_SESSIONS"],
    ["SERVICE_SESSION_STATE_CORRUPT", { ok: false, stale: false, code: "SERVICE_SESSION_STATE_CORRUPT" }, "SERVICE_SESSION_STATE_CORRUPT"],
    ["ACTIVE_SERVICE_BUSINESS_DAY_MISMATCH (future-dated service)", {
      ok: false, stale: false, code: "ACTIVE_SERVICE_BUSINESS_DAY_MISMATCH",
      serviceBusinessDate: "2026-09-07", currentBusinessDate: "2026-09-06",
    }, "ACTIVE_SERVICE_BUSINESS_DAY_MISMATCH"],
  ]) {
    recoveryBehavior = async () => verdict;
    const r = await ensure();
    const p = JSON.parse(r.body);
    check(`${label} -> fail closed: success:false`, p.success === false, r.body);
    check(`${label} -> truthful code, never coerced to PREVIOUS_SERVICE_PENDING or REUSED`,
      p.code === expectCode && p.code !== "REUSED" && p.code !== "PREVIOUS_SERVICE_PENDING", r.body);
    check(`${label} -> no session handed back (operational work cannot proceed)`, !p.session, r.body);
  }

  // ── 7. unexpected staleRecovery throw -> FAIL CLOSED, never REUSED ──
  {
    recoveryBehavior = async () => { throw new Error("recovery exploded"); };
    const r = await ensure();
    const p = JSON.parse(r.body);
    check("recovery THROW -> success:false (never a fake REUSED)", p.success === false && p.code !== "REUSED", r.body);
    check("recovery THROW -> classified as LIFECYCLE_UNRESOLVED", p.code === "LIFECYCLE_UNRESOLVED", r.body);
  }

  // ── regression: NO_STALE_SERVICE still works after the throw case ──
  {
    recoveryBehavior = async () => ({ ok: true, stale: false, code: "NO_STALE_SERVICE" });
    const r = await ensure();
    const p = JSON.parse(r.body);
    check("recovery recovers: a later NO_STALE_SERVICE call still continues normally", r.status === 200 && p.success === true && p.code === "REUSED", r.body);
  }

  server.close();
  console.log(`\nstaleServiceRecoveryWiring: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log("FATAL " + (e && e.stack || e)); process.exit(1); });
