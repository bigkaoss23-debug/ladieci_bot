// tests/unifiedCashOrderFinancialHttpIntegration.test.js — UNIFIED_CASH_UI_SURFACE_V1.
// Exercises the REAL Express route stack of index.js for getOrdenes and
// getOrdenesArchivadosSesion, proving the additive canonical `financial`
// projection reaches the wire and costs exactly ONE extra batched read.
// Localhost only — supabase + DAO + lifecycle stubbed via require.cache, JWT real.
// Run: node tests/unifiedCashOrderFinancialHttpIntegration.test.js

const http = require("http");

process.env.AUTH_JWT_SECRET_B64URL = Buffer.from("unified_cash_test_secret_key_at_least_32_bytes!!").toString("base64url");
process.env.DASHBOARD_API_KEY = "testkey";
process.env.AUTH_V2_LEGACY_GUARD_ENABLED = "true";
process.env.SUPABASE_URL = "http://localhost.invalid";
process.env.SUPABASE_KEY = "test";

const SESSION_ID = "00000000-0000-4000-8000-0000000000b7";
const UID_A = "aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa"; // adjusted 30 -> 22
const UID_B = "bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb"; // no adjustment, totale 18

const ORDENES = [
  { id: "#901", order_uid: UID_A, service_session_id: SESSION_ID, table_session_id: null,
    estado: "RETIRADO", items: [], totale: 30, ts: 2, metodo_pago: "efectivo", ya_pagado: true, cobrado: true },
  { id: "#902", order_uid: UID_B, service_session_id: SESSION_ID, table_session_id: null,
    estado: "RETIRADO", items: [], totale: 18, ts: 1, metodo_pago: "tarjeta", ya_pagado: true, cobrado: true },
];
const OBLIGATIONS = [
  { order_uid: UID_A, order_id: "#901", revision: 1, gross_amount: 30, source: "order_create_v1", cause: null, created_at: "2026-09-07T19:00:00Z" },
  { order_uid: UID_A, order_id: "#901", revision: 2, gross_amount: 22, source: "order_commercial_adjustment_v1", cause: "manual", created_at: "2026-09-07T19:30:00Z" },
];

let sbCalls = [];
const supaPath = require.resolve("../src/utils/supabase");
const realSupa = require(supaPath);
require.cache[supaPath].exports = Object.assign({}, realSupa, {
  sbSelect: async (table, query) => {
    sbCalls.push({ table, query });
    if (table === "ordenes") return ORDENES.map((o) => ({ ...o }));
    if (table === "order_obligations") return OBLIGATIONS.map((o) => ({ ...o }));
    return [];
  },
  getConfig: async () => ({}),
  sbUpsert: async () => ({}), sbUpdate: async () => ({}), sbInsert: async () => ({}), sbDelete: async () => ({}),
});

const opSessionPath = require.resolve("../src/serviceSessions/currentOperationalSession");
const realOpSession = require(opSessionPath);
require.cache[opSessionPath].exports = Object.assign({}, realOpSession, {
  getOperationalSessionIds: async () => [SESSION_ID],
});

const daoPath = require.resolve("../src/auth/dao");
const realDao = require(daoPath);
const ACTORS = {
  owner: { actor: "owner", role: "admin", active: true, session_version: 5 },
  operator_primary: { actor: "operator_primary", role: "operator", active: true, session_version: 5 },
};
require.cache[daoPath].exports = Object.assign({}, realDao, { getActor: async (a) => ACTORS[a] || null });

const jwt = require("../src/auth/jwt");
const { app } = require("../index");

let pass = 0, fail = 0;
const check = (l, c) => { if (c) { pass++; console.log("  ✓ " + l); } else { fail++; console.log("  ✗ " + l); } };
const tok = (role, sub, sv) => jwt.signToken({ role, sub, sv, authMethod: jwt.AUTH_METHOD_ACTOR_PIN });

function reqHttp(server, { auth, action }) {
  return new Promise((resolve) => {
    const { port } = server.address();
    const r = http.request(
      { host: "127.0.0.1", port, path: "/api?action=" + action, method: "GET",
        headers: { "Content-Type": "application/json", "X-Api-Key": "testkey", Authorization: "Bearer " + auth } },
      (res) => { let b = ""; res.on("data", (d) => b += d); res.on("end", () => resolve({ status: res.statusCode, body: b })); },
    );
    r.end();
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const OP = tok("operator", "operator_primary", 5);

  for (const ACTION of ["getOrdenes", "getOrdenesArchivadosSesion"]) {
    sbCalls = [];
    const res = await reqHttp(server, { action: ACTION, auth: OP });
    check(`${ACTION} -> 200`, res.status === 200);
    let rows = [];
    try { rows = JSON.parse(res.body); } catch (_) { /* leave [] */ }
    check(`${ACTION}: 2 rows returned`, Array.isArray(rows) && rows.length === 2);

    const a = rows.find((r) => r.order_uid === UID_A) || {};
    const b = rows.find((r) => r.order_uid === UID_B) || {};

    check(`${ACTION}: every row carries an additive financial block`,
      rows.every((r) => r.financial && typeof r.financial === "object"));
    check(`${ACTION}: financial shape is exactly projectOrderFinancial's`,
      JSON.stringify(Object.keys(a.financial || {}).sort()) ===
      JSON.stringify(["adjustable", "commercialAdjustment", "currentObligation", "obligationRevision", "orderUid", "originalObligation"]));

    check(`${ACTION}: adjusted order exposes original 30 AND current 22`,
      a.financial && a.financial.originalObligation === 30 && a.financial.currentObligation === 22 && a.financial.commercialAdjustment === -8);
    check(`${ACTION}: un-adjusted order -> current == original == 18`,
      b.financial && b.financial.originalObligation === 18 && b.financial.currentObligation === 18 && b.financial.commercialAdjustment === 0);

    check(`${ACTION}: raw ordenes.totale still present and unchanged on the wire`,
      a.totale === 30 && b.totale === 18);
    check(`${ACTION}: original operator fields untouched (estado / metodo_pago / ya_pagado)`,
      a.estado === "RETIRADO" && b.metodo_pago === "tarjeta" && a.ya_pagado === true);

    const obCalls = sbCalls.filter((c) => c.table === "order_obligations");
    check(`${ACTION}: exactly ONE order_obligations read (no N+1)`, obCalls.length === 1);
    check(`${ACTION}: that read is a batched in.(...) over both order_uids`,
      obCalls.length === 1 && /order_uid=in\.\(/.test(obCalls[0].query) &&
      obCalls[0].query.includes(UID_A) && obCalls[0].query.includes(UID_B));
    check(`${ACTION}: no write-shaped supabase call issued`,
      !sbCalls.some((c) => /rpc\//.test(c.table || "")));
  }

  // getOrdenes active-state allowlist is still exactly the original one.
  sbCalls = [];
  await reqHttp(server, { action: "getOrdenes", auth: OP });
  const goCall = sbCalls.find((c) => c.table === "ordenes");
  check("getOrdenes still filters the original active-state allowlist",
    !!goCall && goCall.query.includes("estado=in.(POR_CONFIRMAR,NUEVO,EN_COCINA,LISTO,EN_ENTREGA)"));

  server.close();
  console.log(`\nunifiedCashOrderFinancialHttpIntegration: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log("FATAL " + (e && e.stack || e)); process.exit(1); });
