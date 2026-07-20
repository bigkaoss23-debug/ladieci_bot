// tests/legacyAuthGuard.test.js — S2-1B backend-authoritative legacy authorization.
// Run: node tests/legacyAuthGuard.test.js
// Pure/offline: verifyToken + getActor are injected (no JWT signing, no DB, no network).

const assert = require("assert");
const { authorizeLegacyRequest } = require("../src/auth/legacyAuthGuard");

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log("  ✓ " + label); }
  else { fail++; console.log("  ✗ " + label); }
}

// Deterministic actor store (owner=admin, operator_primary=operator, rider=rider), all sv=5.
const ACTORS = {
  owner:            { actor: "owner", role: "admin", active: true, session_version: 5 },
  operator_primary: { actor: "operator_primary", role: "operator", active: true, session_version: 5 },
  operator_backup:  { actor: "operator_backup", role: "operator", active: true, session_version: 5 },
  rider:            { actor: "rider", role: "rider", active: true, session_version: 5 },
  inactive:         { actor: "operator_primary", role: "operator", active: false, session_version: 5 },
};
const getActor = async (sub) => ACTORS[sub] || null;
// verifyToken stub: token string "role:sub:sv" -> payload, "BAD" -> null.
const verifyToken = (t) => {
  if (t === "BAD") return null;
  const [role, sub, sv] = String(t).split(":");
  return { role, sub, sv: Number(sv), v: 2 };
};
const deps = { getActor, verifyToken };

function req({ method = "POST", action, token, path } = {}) {
  const headers = {};
  if (token !== undefined) headers.authorization = "Bearer " + token;
  const r = { method, headers, query: {}, body: {}, path };
  if (method === "GET") r.query.action = action; else r.body.action = action;
  return r;
}

(async () => {
  // X-Api-Key layer is handled by index.js before the guard; not re-tested here.

  // Missing / malformed / invalid JWT -> 401
  check("missing JWT -> 401 MISSING_TOKEN",
    (await authorizeLegacyRequest(req({ action: "getOrdenes" }), deps)).status === 401);
  check("no Bearer prefix -> 401",
    (await authorizeLegacyRequest({ method: "POST", headers: { authorization: "xyz" }, query: {}, body: { action: "getOrdenes" } }, deps)).status === 401);
  check("invalid JWT -> 401 INVALID_TOKEN",
    (await authorizeLegacyRequest(req({ action: "getOrdenes", token: "BAD" }), deps)).code === "INVALID_TOKEN");

  // Stale session -> 401
  const stale = await authorizeLegacyRequest(req({ action: "getOrdenes", token: "operator:operator_primary:4" }), deps);
  check("stale session_version -> 401 SESSION_STALE", stale.status === 401 && stale.code === "SESSION_STALE");

  // Inactive actor -> 401
  const inact = await authorizeLegacyRequest(req({ action: "getOrdenes", token: "operator:inactive:5" }), deps);
  check("inactive actor -> 401", inact.status === 401 && inact.code === "INACTIVE_OR_UNKNOWN_ACTOR");

  // Unknown actor -> 401
  check("unknown actor -> 401",
    (await authorizeLegacyRequest(req({ action: "getOrdenes", token: "operator:ghost:5" }), deps)).status === 401);

  // Unknown action -> 404 (deny by default), evaluated before token logic
  const unk = await authorizeLegacyRequest(req({ action: "totallyBogus", token: "admin:owner:5" }), deps);
  check("unknown action -> 404 UNKNOWN_ACTION", unk.status === 404 && unk.code === "UNKNOWN_ACTION");

  // Allowed role -> ok
  const okAdmin = await authorizeLegacyRequest(req({ action: "setConfig", token: "admin:owner:5" }), deps);
  check("admin setConfig -> ok", okAdmin.ok === true && okAdmin.ctx.role === "admin");

  // Operator parity: both operator actors allowed for a normal action
  check("operator_primary createOrden -> ok",
    (await authorizeLegacyRequest(req({ action: "createOrden", token: "operator:operator_primary:5" }), deps)).ok === true);
  check("operator_backup createOrden -> ok (parity)",
    (await authorizeLegacyRequest(req({ action: "createOrden", token: "operator:operator_backup:5" }), deps)).ok === true);

  // Operator denied admin-only action -> 403
  check("operator setConfig -> 403",
    (await authorizeLegacyRequest(req({ action: "setConfig", token: "operator:operator_primary:5" }), deps)).status === 403);

  // Rider deny set -> 403
  for (const a of ["updateEstado", "createOrden", "cambiaStato", "createManualGiro", "dissolveManualGiro", "setConfig", "marcarLlegado", "asignarRepartidor"]) {
    const d = await authorizeLegacyRequest(req({ action: a, token: "rider:rider:5" }), deps);
    check("rider denied " + a + " -> 403", d.status === 403);
  }

  // Rider allow set -> ok
  for (const a of ["getOrdenes", "getManualGiros", "getDriverStatus", "marcarEnEntrega", "registrarSalidaDriver", "marcarEntregado", "chiudiGiro"]) {
    const d = await authorizeLegacyRequest(req({ action: a, token: "rider:rider:5" }), deps);
    check("rider allowed " + a, d.ok === true && d.ctx.rule.rider === true);
  }

  // tripPrimitive flag on the four routed rider actions
  const mE = await authorizeLegacyRequest(req({ action: "marcarEnEntrega", token: "rider:rider:5" }), deps);
  check("marcarEnEntrega is tripPrimitive", mE.ctx.rule.tripPrimitive === true);
  const gO = await authorizeLegacyRequest(req({ action: "getOrdenes", token: "rider:rider:5" }), deps);
  check("getOrdenes is NOT tripPrimitive", gO.ctx.rule.tripPrimitive === false);

  // shadow-preview path resolves to "shadowPreview", rider denied, operator allowed
  const shRider = await authorizeLegacyRequest({ method: "GET", headers: { authorization: "Bearer rider:rider:5" }, query: {}, body: {}, path: "/api/delivery/shadow-preview" }, deps);
  check("rider denied shadowPreview -> 403", shRider.status === 403);
  const shOp = await authorizeLegacyRequest({ method: "GET", headers: { authorization: "Bearer operator:operator_primary:5" }, query: {}, body: {}, path: "/api/delivery/shadow-preview" }, deps);
  check("operator allowed shadowPreview", shOp.ok === true);

  // Backend error in getActor -> generic 500
  const boom = await authorizeLegacyRequest(req({ action: "getOrdenes", token: "operator:operator_primary:5" }), { verifyToken, getActor: async () => { throw new Error("db down"); } });
  check("getActor throws -> 500", boom.status === 500);

  console.log(`\nlegacyAuthGuard: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log("FATAL " + (e && e.message)); process.exit(1); });
