// tests/serviceIncidentsAlwaysOnAuthHttpIntegration.test.js — SERVICE CLOSEOUT
// V2 / SLICE 4A.1. Proves getServiceIncidents stays admin-verified even when
// legacyAuthGuardMiddleware is NOT mounted (AUTH_V2_LEGACY_GUARD_ENABLED left
// unset/off, the DEFAULT) — the exact gap the Slice 4A report flagged.
// Real Express route stack, mirroring getOrdenesArchivadosSesionHttpIntegration
// / serviceIncidentsSlice4aHttpIntegration's stub pattern, but deliberately
// WITHOUT setting AUTH_V2_LEGACY_GUARD_ENABLED — this must be a separate
// process from that file since index.js reads the flag once at require time.
// Localhost only — no DB / Railway / Netlify / Supabase network.
// Run: node tests/serviceIncidentsAlwaysOnAuthHttpIntegration.test.js

const http = require("http");

process.env.AUTH_JWT_SECRET_B64URL = Buffer.from("slice4a1_test_secret_key_at_least_32_bytes!").toString("base64url");
process.env.DASHBOARD_API_KEY = "testkey";
// Deliberately NOT setting AUTH_V2_LEGACY_GUARD_ENABLED — proves the fix does
// not depend on it. delete() guards against inherited env pollution.
delete process.env.AUTH_V2_LEGACY_GUARD_ENABLED;
process.env.SUPABASE_URL = "http://localhost.invalid";
process.env.SUPABASE_KEY = "test";

let sbCalls = [];
const supaPath = require.resolve("../src/utils/supabase");
const realSupa = require(supaPath);
require.cache[supaPath].exports = Object.assign({}, realSupa, {
  sbSelect: async (table, query) => { sbCalls.push({ table, query }); return []; },
  getConfig: async () => ({}),
  sbUpsert: async () => ({}), sbUpdate: async () => ({}), sbInsert: async () => ({}), sbDelete: async () => ({}),
});

const SESSION_ID = "00000000-0000-4000-8000-0000000000d1";
const lifecyclePath = require.resolve("../src/serviceSessions/serviceSessionLifecycle");
const realLifecycle = require(lifecyclePath);
require.cache[lifecyclePath].exports = Object.assign({}, realLifecycle, {
  lifecycle: Object.assign({}, realLifecycle.lifecycle, {
    currentCloseout: async () => ({ ok: true, session: { id: SESSION_ID, status: "open", opened_at: "2026-08-08T09:00:00Z" } }),
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
function reqHttp(server, { key = "testkey", auth, action, extraQuery = "" } = {}) {
  return new Promise((resolve) => {
    const headers = { "Content-Type": "application/json" };
    if (key) headers["X-Api-Key"] = key;
    if (auth) headers["Authorization"] = "Bearer " + auth;
    const path = "/api?action=" + action + extraQuery;
    const { port } = server.address();
    const r = http.request({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      let buf = ""; res.on("data", (d) => buf += d); res.on("end", () => resolve({ status: res.statusCode, body: buf }));
    });
    r.end();
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const OWNER = tok("admin", "owner", 5), OP = tok("operator", "operator_primary", 5), RIDER = tok("rider", "rider", 5);
  const ACTION = "getServiceIncidents";

  console.log("\n== getServiceIncidents always-on admin auth, AUTH_V2_LEGACY_GUARD_ENABLED UNSET (default/off) ==\n");

  sbCalls = [];
  const rOwner = await reqHttp(server, { action: ACTION, auth: OWNER });
  check("flag OFF + verified admin -> 200 (allowed)", rOwner.status === 200, rOwner.body);
  check("admin request reached the handler (real sbSelect on service_incidents)", sbCalls.some((c) => c.table === "service_incidents"), JSON.stringify(sbCalls));

  sbCalls = [];
  const rOp = await reqHttp(server, { action: ACTION, auth: OP });
  check("flag OFF + verified operator -> 403 (denied)", rOp.status === 403, rOp.body);
  check("denied operator request never reached the handler", !sbCalls.some((c) => c.table === "service_incidents"));

  sbCalls = [];
  const rRider = await reqHttp(server, { action: ACTION, auth: RIDER });
  check("flag OFF + verified rider -> 403 (denied)", rRider.status === 403, rRider.body);
  check("denied rider request never reached the handler", !sbCalls.some((c) => c.table === "service_incidents"));

  sbCalls = [];
  const rNoAuth = await reqHttp(server, { action: ACTION });
  check("flag OFF + no Bearer token at all -> 401/403 (denied, never 200)", rNoAuth.status === 401 || rNoAuth.status === 403, rNoAuth.body);
  check("missing-identity request never reached the handler", !sbCalls.some((c) => c.table === "service_incidents"));

  sbCalls = [];
  const rBadToken = await reqHttp(server, { action: ACTION, auth: "not-a-real-jwt" });
  check("flag OFF + garbage/invalid token -> denied, never 200", rBadToken.status === 401 || rBadToken.status === 403, rBadToken.body);

  // Self-declared role cannot elevate: a real, verified OPERATOR token, with
  // role=admin also smuggled into the query string. The verified JWT's own
  // role is the only thing consulted (authorizeLegacyRequest never reads
  // req.query/req.body for role) — this must still be denied.
  sbCalls = [];
  const rSpoof = await reqHttp(server, { action: ACTION, auth: OP, extraQuery: "&role=admin" });
  check("verified operator + role=admin smuggled in the querystring -> STILL 403, cannot self-elevate", rSpoof.status === 403, rSpoof.body);
  check("spoofed-role request never reached the handler", !sbCalls.some((c) => c.table === "service_incidents"));

  console.log("\n── sanity: an ordinary shared operator action is unaffected by this fix ──");
  {
    sbCalls = [];
    const r = await reqHttp(server, { action: "getOrdenes", auth: OP });
    // No JWT guard mounted (flag off) and no inline check on getOrdenes ->
    // legacy behavior preserved exactly: reaches the handler.
    check("getOrdenes (unrelated, shared action) still reaches the handler with the guard unmounted", r.status === 200, r.body);
  }

  server.close();
  console.log(`\nserviceIncidentsAlwaysOnAuthHttpIntegration: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log("FATAL " + (e && e.stack || e)); process.exit(1); });
