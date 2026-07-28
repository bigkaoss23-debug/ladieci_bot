// tests/legacyGuardHttpIntegration.test.js — S2-1C local-loopback integration.
// Exercises the REAL Express route stack of index.js with AUTH_V2_LEGACY_GUARD_ENABLED=true.
// DAO + supabase are stubbed via require.cache; JWT is real (signed with a test secret).
// Localhost only — no DB / Railway / Netlify / Supabase network.
// Run: node tests/legacyGuardHttpIntegration.test.js

const crypto = require("crypto");
const http = require("http");

// ── env BEFORE any app module loads ──
process.env.AUTH_JWT_SECRET_B64URL = Buffer.from("s2_1c_test_secret_key_at_least_32_bytes!!").toString("base64url");
process.env.DASHBOARD_API_KEY = "testkey";
process.env.AUTH_V2_LEGACY_GUARD_ENABLED = "true";
process.env.SUPABASE_URL = "http://localhost.invalid";
process.env.SUPABASE_KEY = "test";

// ── stub supabase (record calls; prove handler-not-invoked) ──
let sbCalls = [];
const supaPath = require.resolve("../src/utils/supabase");
const realSupa = require(supaPath);
require.cache[supaPath].exports = Object.assign({}, realSupa, {
  sbSelect: async (table) => { sbCalls.push(table); return []; },
  getConfig: async () => ({}),
  sbUpsert: async () => ({}), sbUpdate: async () => ({}), sbInsert: async () => ({}), sbDelete: async () => ({}),
});

// ── stub dao.getActor ──
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
const check = (l, c) => { if (c) { pass++; console.log("  ✓ " + l); } else { fail++; console.log("  ✗ " + l); } };

function tok(role, sub, sv) { return jwt.signToken({ role, sub, sv, authMethod: jwt.AUTH_METHOD_ACTOR_PIN }); }
function reqHttp(server, { method = "POST", path = "/api", key = "testkey", auth, action, body } = {}) {
  return new Promise((resolve) => {
    const headers = { "Content-Type": "application/json" };
    if (key) headers["X-Api-Key"] = key;
    if (auth) headers["Authorization"] = "Bearer " + auth;
    let p = path;
    if (method === "GET" && action) p += "?action=" + action;
    const data = body ? JSON.stringify(body) : (method === "POST" && action ? JSON.stringify({ action }) : null);
    const { port } = server.address();
    const r = http.request({ host: "127.0.0.1", port, path: p, method, headers }, (res) => {
      let buf = ""; res.on("data", (d) => buf += d); res.on("end", () => resolve({ status: res.statusCode, body: buf }));
    });
    if (data) r.write(data); r.end();
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const OWNER = tok("admin", "owner", 5), OP = tok("operator", "operator_primary", 5), RIDER = tok("rider", "rider", 5);
  const STALE = tok("rider", "rider", 4);

  // 1. missing X-Api-Key -> 401 (before guard)
  check("1 missing X-Api-Key -> 401", (await reqHttp(server, { method: "GET", action: "getOrdenes", key: null, auth: OP })).status === 401);
  // 2. valid key, missing JWT -> 401
  check("2 valid key, no JWT -> 401", (await reqHttp(server, { method: "GET", action: "getOrdenes" })).status === 401);
  // 3. malformed JWT -> 401
  check("3 malformed JWT -> 401", (await reqHttp(server, { method: "GET", action: "getOrdenes", auth: "not.a.jwt" })).status === 401);
  // 4. stale session -> 401
  check("4 stale session -> 401", (await reqHttp(server, { method: "GET", action: "getOrdenes", auth: STALE })).status === 401);
  // 5. rider forbidden action -> 403, and handler not invoked
  sbCalls = [];
  const r5 = await reqHttp(server, { method: "GET", action: "getClientes", auth: RIDER });
  check("5 rider forbidden getClientes -> 403", r5.status === 403);
  check("12 denied request did NOT invoke handler (no sbSelect)", !sbCalls.includes("clientes"));
  // 6. rider allowed read -> handler reached (rider-scoped path calls sbSelect)
  sbCalls = [];
  const r6 = await reqHttp(server, { method: "GET", action: "getOrdenes", auth: RIDER });
  check("6 rider getOrdenes -> 200 handler reached", r6.status === 200 && sbCalls.includes("ordenes"));
  // 7. operator normal action -> handler reached
  sbCalls = [];
  const r7 = await reqHttp(server, { method: "GET", action: "getOrdenes", auth: OP });
  check("7 operator getOrdenes -> 200", r7.status === 200 && sbCalls.includes("ordenes"));
  // S3-1B read-only menu route: operator reaches the facade; the empty dynamic
  // fixture falls back to legacy. Rider is denied before any menu-table read.
  sbCalls = [];
  const menuOp = await reqHttp(server, { method: "GET", action: "getMenu", auth: OP });
  check("operator getMenu -> 200 read-only handler reached", menuOp.status === 200 && sbCalls.includes("menu_productos"));
  check("operator getMenu empty source -> controlled legacy fallback", JSON.parse(menuOp.body).cacheMeta.source === "legacy");
  sbCalls = [];
  const menuRider = await reqHttp(server, { method: "GET", action: "getMenu", auth: RIDER });
  check("rider getMenu -> 403 before handler", menuRider.status === 403 && !sbCalls.some((table) => table.startsWith("menu_")));
  // 8. unknown action -> 404
  check("8 unknown action -> 404", (await reqHttp(server, { method: "GET", action: "totallyBogus", auth: OWNER })).status === 404);
  // 11. shadow-preview requires fresh authorized JWT: no JWT -> 401; rider -> 403
  check("11a shadow-preview no JWT -> 401", (await reqHttp(server, { method: "GET", path: "/api/delivery/shadow-preview" })).status === 401);
  check("11b shadow-preview rider -> 403", (await reqHttp(server, { method: "GET", path: "/api/delivery/shadow-preview", auth: RIDER })).status === 403);
  // 9/10. /health public (guard does not intercept)
  check("9 /health not guarded -> 200", (await reqHttp(server, { method: "GET", path: "/health", key: null })).status === 200);
  // setConfig DRIVER_STATO rejected even for admin
  const rSC = await reqHttp(server, { method: "POST", body: { action: "setConfig", chiave: "DRIVER_STATO", valore: "{}" }, auth: OWNER });
  check("setConfig DRIVER_STATO -> 403 (single authority)", rSC.status === 403);

  server.close();
  console.log(`\nlegacyGuardHttpIntegration: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log("FATAL " + (e && e.stack || e)); process.exit(1); });
