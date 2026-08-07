// tests/getOrdenesArchivadosSesionHttpIntegration.test.js — LISTOS_ARCHIVADOS_V1.
// Exercises the REAL Express route stack of index.js for the new
// getOrdenesArchivadosSesion action, mirroring legacyGuardHttpIntegration.test.js's
// stub setup (DAO + supabase stubbed via require.cache, JWT real).
// Localhost only — no DB / Railway / Netlify / Supabase network.
// Run: node tests/getOrdenesArchivadosSesionHttpIntegration.test.js

const http = require("http");

process.env.AUTH_JWT_SECRET_B64URL = Buffer.from("archivados_test_secret_key_at_least_32_bytes!!").toString("base64url");
process.env.DASHBOARD_API_KEY = "testkey";
process.env.AUTH_V2_LEGACY_GUARD_ENABLED = "true";
process.env.SUPABASE_URL = "http://localhost.invalid";
process.env.SUPABASE_KEY = "test";

// ── stub supabase (record calls + the exact query string) ──
let sbCalls = [];
const supaPath = require.resolve("../src/utils/supabase");
const realSupa = require(supaPath);
require.cache[supaPath].exports = Object.assign({}, realSupa, {
  sbSelect: async (table, query) => { sbCalls.push({ table, query }); return []; },
  getConfig: async () => ({}),
  sbUpsert: async () => ({}), sbUpdate: async () => ({}), sbInsert: async () => ({}), sbDelete: async () => ({}),
});

const SESSION_ID = "00000000-0000-4000-8000-0000000000a1";
const lifecyclePath = require.resolve("../src/serviceSessions/serviceSessionLifecycle");
const realLifecycle = require(lifecyclePath);
require.cache[lifecyclePath].exports = Object.assign({}, realLifecycle, {
  lifecycle: Object.assign({}, realLifecycle.lifecycle, {
    currentCloseout: async () => ({
      ok: true,
      session: { id: SESSION_ID, status: "open", opened_at: "2026-08-02T09:00:00Z" },
    }),
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
const check = (l, c) => { if (c) { pass++; console.log("  ✓ " + l); } else { fail++; console.log("  ✗ " + l); } };

function tok(role, sub, sv) { return jwt.signToken({ role, sub, sv, authMethod: jwt.AUTH_METHOD_ACTOR_PIN }); }
function reqHttp(server, { method = "GET", key = "testkey", auth, action } = {}) {
  return new Promise((resolve) => {
    const headers = { "Content-Type": "application/json" };
    if (key) headers["X-Api-Key"] = key;
    if (auth) headers["Authorization"] = "Bearer " + auth;
    const path = "/api?action=" + action;
    const { port } = server.address();
    const r = http.request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let buf = ""; res.on("data", (d) => buf += d); res.on("end", () => resolve({ status: res.statusCode, body: buf }));
    });
    r.end();
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const OWNER = tok("admin", "owner", 5), OP = tok("operator", "operator_primary", 5), RIDER = tok("rider", "rider", 5);
  const ACTION = "getOrdenesArchivadosSesion";

  // 1. operator -> 200, handler reached, real query issued against ordenes.
  sbCalls = [];
  const rOp = await reqHttp(server, { action: ACTION, auth: OP });
  check("operator getOrdenesArchivadosSesion -> 200", rOp.status === 200);
  const opCall = sbCalls.find((c) => c.table === "ordenes");
  check("handler reached (sbSelect on ordenes)", !!opCall);
  check("query is scoped to the current service session",
    !!opCall && opCall.query.includes(`service_session_id=eq.${SESSION_ID}`));
  check("query filters terminal states only (both completed spellings + RETIRADO)",
    // language-guard: allow-legacy COMPLETATO is the legacy Italian terminal spelling still on disk, required alongside COMPLETADO, not new vocabulary
    !!opCall && opCall.query.includes("estado=in.(COMPLETADO,COMPLETATO,RETIRADO)"));
  check("query does NOT include any active state",
    !!opCall && !/EN_COCINA|POR_CONFIRMAR|\bLISTO\b|EN_ENTREGA/.test(opCall.query));

  // 2. admin/owner -> 200, handler reached.
  sbCalls = [];
  const rOwner = await reqHttp(server, { action: ACTION, auth: OWNER });
  check("owner getOrdenesArchivadosSesion -> 200", rOwner.status === 200);
  check("owner call reached the handler too", sbCalls.some((c) => c.table === "ordenes"));

  // 3. rider -> 403, handler NOT reached (no rider-scoping exists for this action).
  sbCalls = [];
  const rRider = await reqHttp(server, { action: ACTION, auth: RIDER });
  check("rider getOrdenesArchivadosSesion -> 403", rRider.status === 403);
  check("denied rider request did NOT invoke the handler", !sbCalls.some((c) => c.table === "ordenes"));

  // 4. sanity: getOrdenes itself is completely unaffected (still 200 for operator,
  // still queries the active-state list, not the terminal one).
  sbCalls = [];
  const rGetOrdenes = await reqHttp(server, { action: "getOrdenes", auth: OP });
  check("getOrdenes operator -> 200 (unaffected)", rGetOrdenes.status === 200);
  const goCall = sbCalls.find((c) => c.table === "ordenes");
  check("getOrdenes query is still the original active-state allowlist",
    !!goCall && goCall.query.includes("estado=in.(POR_CONFIRMAR,NUEVO,EN_COCINA,LISTO,EN_ENTREGA)"));

  server.close();
  console.log(`\ngetOrdenesArchivadosSesionHttpIntegration: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log("FATAL " + (e && e.stack || e)); process.exit(1); });
