require("dotenv").config();
const express = require("express");
const { processWebhook } = require("./src/agents/orchestrator");
const { getConfig, sbSelect, sbUpdate, sbDelete, sbUpsert, sbInsert } = require("./src/utils/supabase");
const { supabaseRequest } = require("./src/utils/supabaseTransport");
const { getMigrationStatus, getMigrationStatusForStatusEndpoint } = require("./src/utils/migrationAuthority");
const { cambiaStato, creaOrdine, modificaOrdine } = require("./src/agents/agentOrdini");
// DRIVER_STATO = telemetria visiva opzionale (best-effort). getDriverStatus per la
// UI, closeGiroInternal condiviso col legacy chiudiGiro (idempotente).
const { getDriverStatus, closeGiroInternal } = require("./src/utils/driverTelemetry");
// Private authenticated READ contracts (P0 containment). Fixed per-action queries;
// no generic table access. Reachable only behind the shared X-Api-Key (trusted proxy).
const readActions = require("./src/utils/readActions");
const { previewOrderTiming } = require("./src/agents/previewTiming");
// PORT-55 — premium planner preview actions, restored from the V1 planner line
// (backup/v2-planner-rider-conflict-compatible-giro-2026-06-17). All three are
// STRICTLY read-only: no DB write, no WhatsApp, no state transition, no apply.
// The DB handed to them is a select-only allowlisted adapter.
const { previewOrderPlanner } = require("./src/agents/previewOrderPlanner");
const { previewStrategicOpportunities } = require("./src/agents/previewStrategicOpportunities");
const { previewManualGiroRoute } = require("./src/agents/previewManualGiroRoute");
const { createReadOnlyRestDb } = require("./src/core/delivery/readOnlyRestDb");
const { loadPlannerSnapshot } = require("./src/core/delivery/plannerSnapshot");
// This line's 04:00 Business Day, NOT the donor's 06:00 service day — see the
// header of plannerClock.js for why that difference is deliberate.
const { nowMadridHHMM, plannerBusinessDate } = require("./src/core/delivery/plannerClock");
const { invia, emitDynamicMenuShadowDiagnostic } = require("./src/agents/agentWhatsapp");
const { runWhatsappMenuShadow } = require("./src/menu/whatsappMenuShadow");
// language-guard: allow-legacy servizio/scanServizio/backupSerata are the existing module path and export names, unchanged by removing chiudiServizio from this same destructure, not new vocabulary
const { scanServizio, backupSerata } = require("./src/utils/servizio");
const { rigeneraSuggerimenti, approvaSuggerimento } = require("./src/agents/agenteMiglioramento");
const { getCanonicalMenu } = require("./src/menu/menuFacade");
const {
  getManualGiros,
  createManualGiro,
  addOrderToManualGiro,
  removeOrderFromManualGiro,
  dissolveManualGiro,
} = require("./src/agents/manualGiros");
const { handleShadowPreviewReadOnly } = require("./src/core/delivery/shadowPreviewEndpoint");
const { integrateFinancialRoutes } = require("./src/auth/financialHttpIntegration");
const { integrateLoginRoute } = require("./src/auth/loginHttpIntegration");
const { integrateAccountRoutes } = require("./src/account/accountHttpIntegration");
const { integrateAccessManagementRoutes } = require("./src/auth/accessManagementHttpIntegrationV3");
const { integrateMesaRoutes } = require("./src/tables/mesaHttpIntegration");
const { integrateEconomyRoutes } = require("./src/economy/economyHttpIntegration");
const authDao = require("./src/auth/dao");
const adminAccessDao = require("./src/auth/adminAccessDao");
const { createAdminAccessService } = require("./src/auth/adminAccessService");
const pinPolicy = require("./src/auth/pinPolicy");
const { hashPin, verifyPin } = require("./src/auth/scrypt");
const { ipHash } = require("./src/auth/ipSecurity");
const jwt = require("./src/auth/jwt");
const { createPinStepUpVerifier } = require("./src/auth/pinStepUp");
// S2-7D6E — canonical operator payment registration (wires the existing B7A2 ledger into
// the operator flow; payment becomes an event, never a boolean side-effect of RETIRADO).
const { createFinancialDao } = require("./src/auth/financialDao");
const { createFinancialService } = require("./src/auth/financialService");
const { createOperatorPaymentRegistrar, PAYMENT_METHODS, buildIdemScopeKey } = require("./src/financial/registerOperatorPayment");
// N-5 — a request may not collect money and then move the economic basis of the order it
// just collected on. See the two call sites below and src/financial/paidOrderEconomicGuard.js.
const {
  PAID_ORDER_ECONOMIC_MUTATION_FORBIDDEN,
  OPERATOR_MESSAGE: PAID_ORDER_ECONOMIC_MESSAGE,
  collectionWouldMutateEconomicBasis,
} = require("./src/financial/paidOrderEconomicGuard");
// N-3 — "☑ Pagado" at creation is now a REQUEST for a canonical payment, not a boolean that
// declares one. The intent is built HERE because this is the only place holding the verified
// session identity (req.authCtx) and the trusted client IP; the DB trigger then settles it
// through order_mark_paid inside the order's own INSERT transaction.
const { buildInitialPaymentIntent } = require("./src/financial/initialPaymentIntent");
// A real collection is one of the three canonical methods. Markers like "manual" (the
// "Driver volvió" operator override) are NOT payments and must not enter the ledger nor
// be blocked by it — they keep the pre-existing legacy behaviour untouched.
const isCollectionMethod = (m) => typeof m === "string" && PAYMENT_METHODS.has(m.trim().toLowerCase());
// S2-1B — backend-authoritative legacy authorization + transactional rider trip primitives.
const { legacyAuthGuardMiddleware, authorizeLegacyRequest } = require("./src/auth/legacyAuthGuard");
const riderTrip = require("./src/agents/riderTrip");
const riderReads = require("./src/agents/riderReads");
const { getCurrentServiceCloseout } = require("./src/closeout/currentServiceCloseout");
const { lifecycle: serviceSessionLifecycle } = require("./src/serviceSessions/serviceSessionLifecycle");
// F-10.1B — the V3 engine is reached ONLY through the canonical close
// authority, so exactly one application module imports the engine itself.
// Transparent forwarder: identical arguments, identical result.
const { closeServiceSessionV3 } = require("./src/serviceSessions/serviceCloseAuthority");
const { ensureCurrentServiceSession } = require("./src/serviceSessions/ensureServiceSession");
// STALE SERVICE PROTECTION V1 — the remediation half. Migration 120 makes the
// SQL resolvers fail closed on a stale open service; this runs the canonical
// recovery (safe auto-finalize through the ONE V3 authority, or
// PREVIOUS_SERVICE_PENDING) at the single silent lifecycle entry point.
const { recoverStaleService } = require("./src/serviceSessions/staleServiceRecovery");
const { rollEconomicPeriod } = require("./src/serviceSessions/economicBoundaryEngine");
const { periodConsolidation } = require("./src/serviceSessions/periodConsolidation");
const { getCurrentOperationalSession, serviceSessionQuery, getOperationalSessionIds, serviceSessionsQuery } = require("./src/serviceSessions/currentOperationalSession");
const { getPreviousCloseoutIncidentSummary } = require("./src/closeout/previousCloseoutIncidentSummary");
const { serviceIncidents } = require("./src/incidents/serviceIncidents");

const app = express();
app.use(express.json());
// V3-H.2 — the nine V3 access-management routes are the first callers to need
// PATCH/PUT/DELETE and a bearer Authorization header; no legacy route (app.patch/
// app.put/app.delete) exists anywhere in this file, so extending the allow-lists here
// is purely additive. Wildcard origin remains safe: the V3 API is bearer-token-only
// (never cookies), and Access-Control-Allow-Credentials is deliberately never set, so
// the wildcard-plus-credentials combination browsers reject never applies here.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Api-Key, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Access Control V2 / B7A4 — staging-gated financial JWT routes. DISABLED BY DEFAULT
// (mounts nothing unless AUTH_V2_FINANCIAL_HTTP_ENABLED === 'true'). Mounted here — after
// CORS/JSON parsing, BEFORE the legacy /api X-Api-Key proxy — so the four static financial
// paths enter their Bearer-JWT chain first and never require/accept the legacy key, while
// every other /api path continues to the legacy proxy unchanged.
integrateFinancialRoutes(app, { env: process.env, logger: console });

// Access Control V2 / B7A5 — staging-gated Auth V2 login route. DISABLED BY DEFAULT
// (mounts nothing unless AUTH_V2_LOGIN_HTTP_ENABLED === 'true'; independent of the financial
// flag). Mounted here — after CORS/JSON parsing, BEFORE the legacy /api X-Api-Key proxy — so
// the single POST /api/auth/v2/login enters the accepted B3 login handler directly (no JWT,
// no X-Api-Key), while every other /api path continues to the legacy proxy unchanged.
integrateLoginRoute(app, { env: process.env, logger: console });

// S2-7C — staging-gated ACCOUNT boundary (Supabase Auth). DISABLED BY DEFAULT (mounts
// nothing unless ACCOUNT_HTTP_ENABLED === 'true'). Mounted here — after CORS/JSON parsing,
// BEFORE the legacy /api X-Api-Key proxy — so GET /api/account/me enters its Supabase
// Bearer (ES256/JWKS) chain first and never requires/accepts the legacy key or the Auth V2
// PIN JWT. It never touches auth_actors, PIN JWTs, or operational tables. Fully independent
// of the login/financial/legacy flags.
integrateAccountRoutes(app, { env: process.env, logger: console });

// V3-H — staging-gated owner ACCESS-MANAGEMENT boundary (V3-B/C/D/E/G). DISABLED BY
// DEFAULT (mounts nothing unless AUTH_V3_ACCESS_MANAGEMENT_HTTP_ENABLED === 'true',
// exact lowercase match — see accessManagementHttpIntegrationV3.isAccessManagementHttpEnabled).
// Mounted here — after CORS/JSON parsing, BEFORE the legacy /api X-Api-Key proxy — so the
// nine static /api/auth/v3/access-users paths enter their own Bearer-JWT + DB-fresh owner
// chain first and never require/accept the legacy key, while every other /api path
// continues to the legacy proxy unchanged. Not wrapped in try/catch: if a genuinely
// required dependency is missing or invalid while the flag is on, construction throws and
// boot fails closed, exactly like the financial/login/account integrations above — this
// file adds no separate dependency-validation layer of its own.
const accessManagementIntegration = integrateAccessManagementRoutes(app, { env: process.env, logger: console });
console.log(JSON.stringify({
  component: "access-management-v3",
  state: accessManagementIntegration.enabled ? "enabled" : "disabled",
  routeBase: accessManagementIntegration.prefix,
  env: process.env.RAILWAY_ENVIRONMENT_NAME || process.env.NODE_ENV || "unknown",
}));

// Mesa floor/table billing boundary. Staging-only and disabled by default; mounted
// before the legacy X-Api-Key proxy so its seven static routes use the DB-fresh Bearer
// context and never trust actor/workspace/payment identity from a request body.
const mesaIntegration = integrateMesaRoutes(app, { env: process.env, logger: console });
console.log(JSON.stringify({
  component: "mesa-v1",
  state: mesaIntegration.enabled ? "enabled" : "disabled",
  routeBase: mesaIntegration.prefix,
  env: process.env.RAILWAY_ENVIRONMENT_NAME || process.env.NODE_ENV || "unknown",
}));

// I-1 Economic Snapshot + Cash Count. Mounted here for the same reason Mesa is:
// ahead of the legacy X-Api-Key proxy, so both routes read their actor from a
// verified Bearer token and a fresh authoritative actor row rather than from a
// request body. Two reads and one append-only insert; nothing on this router
// can open, close or otherwise move the Operational Service lifecycle.
const economyIntegration = integrateEconomyRoutes(app, { logger: console });
console.log(JSON.stringify({
  component: "economy-v1",
  state: economyIntegration.enabled ? "enabled" : "disabled",
  routeBase: economyIntegration.prefix,
  routes: economyIntegration.routes,
  env: process.env.RAILWAY_ENVIRONMENT_NAME || process.env.NODE_ENV || "unknown",
}));

// Auth middleware — protegge tutti gli endpoint /api
const DASHBOARD_API_KEY = process.env.DASHBOARD_API_KEY;
app.use("/api", (req, res, next) => {
  if (!DASHBOARD_API_KEY) return next(); // se non configurata, passa (sviluppo)
  const key = req.headers["x-api-key"] || req.query._k;
  if (key !== DASHBOARD_API_KEY) return res.status(401).json({ error: "unauthorized" });
  next();
});

// S2-1B — backend-authoritative legacy authorization guard. Staging-gated (DISABLED BY
// DEFAULT; mounts nothing unless AUTH_V2_LEGACY_GUARD_ENABLED === 'true'), mirroring the
// B7 route rollout. Mounted AFTER the shared X-Api-Key check and BEFORE the legacy /api
// dispatcher (and /api/delivery/shadow-preview), so every authenticated legacy action is
// verified for JWT + actor active + fresh session_version + role before any handler runs.
// It never intercepts the earlier-mounted /api/auth/v2/login or /api/financial/* routes,
// nor /health or /version. Enable only together with the Netlify Authorization-forwarding
// change (proxy currently strips the Bearer token), else all legacy traffic would 401.
if (process.env.AUTH_V2_LEGACY_GUARD_ENABLED === "true") {
  app.use("/api", legacyAuthGuardMiddleware());
}

// S2-1B — route the rider trip workflow through the single transactional authority.
// Applies only when the guard authenticated a rider on a trip-primitive action.
async function routeRiderTripAction(action, body) {
  // NB: uses a switch (not the router equality form) so it does not add duplicate
  // router-action literals that the authorization-contract coverage test counts.
  switch (action) {
    case "marcarEnEntrega":
      return riderTrip.startTrip(body && body.id);
    case "marcarEntregado": {
      // S2-7D6E2 — a rider stop may collect money, so it needs the VERIFIED session.
      // Fail closed: without a real actor + session_version we cannot write the ledger,
      // and completing the stop anyway is exactly how `cobrado` used to get invented.
      const ctx = body && body.__authCtx;
      if (!ctx || typeof ctx.actor !== "string" || !ctx.actor || !Number.isInteger(ctx.sv) || ctx.sv < 1) {
        return { status: 401, payload: { error: "PAYMENT_CONTEXT_UNAVAILABLE" } };
      }
      const raw = typeof (body && body.metodo_pago) === "string" ? body.metodo_pago.trim().toLowerCase() : "";
      // A method the ledger does not know (notably TabEntregas' operator override
      // "manual") is NOT a collection: the stop completes and no money is claimed.
      const payMethod = PAYMENT_METHODS.has(raw) ? raw : "";
      const key = buildIdemScopeKey(body && body.id);
      if (payMethod && !key) return { status: 400, payload: { error: "PAYMENT_ORDER_INVALID" } };
      const ipH = ipHash(ctx.clientIp);
      if (payMethod && (typeof ipH !== "string" || !ipH.trim())) {
        return { status: 400, payload: { error: "PAYMENT_CONTEXT_UNAVAILABLE" } };
      }
      // `cobrado` from the body is deliberately NOT read: the client never asserts payment.
      return riderTrip.completeStop(body && body.id, payMethod, {
        byActor: ctx.actor,
        sessionVersion: ctx.sv,
        ipHash: ipH,
        meta: { source: "rider_delivery" },
        idemScopeKey: key,
      });
    }
    case "chiudiGiro":
      return riderTrip.closeTrip();
    case "registrarSalidaDriver":
      // The first marcarEnEntrega already started the trip; this legacy side-effect call is
      // an idempotent compatibility no-op — it must never create a competing trip.
      return { status: 200, payload: { ok: true, code: "IDEMPOTENT" } };
    default:
      return { status: 404, payload: { error: "UNKNOWN_ACTION" } };
  }
}

const WA_VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN || "ladieci_webhook_2026";
const PORT = process.env.PORT || 3000;

function trustedClientIp(req) {
  if (req && typeof req.ip === "string" && req.ip) return req.ip;
  return req && req.socket && typeof req.socket.remoteAddress === "string"
    ? req.socket.remoteAddress : null;
}

// S2-7D2 — THE canonical PIN-rotation protocol. Every owner/operator/rider rotation goes
// through it (account-owner path and operational-admin path alike), so no second writer can
// break the workspace PIN-uniqueness invariant.
const pinRotationDao = require("./src/auth/pinRotationDao");
const { createPinRotation } = require("./src/auth/pinRotationService");
const pinRotation = createPinRotation({
  dao: pinRotationDao,
  hashPin,
  verifyPin,
  pinPolicy,
  ipHash,
});

const adminAccessService = createAdminAccessService({
  dao: adminAccessDao,
  hashPin,
  verifyPin,
  pinPolicy,
  ipHash,
  rotation: pinRotation,
  listActorsForVerify: authDao.listActorsForVerify_SENSITIVE,
  // S2-7D6E4 — setActorPin now REQUIRES a valid, session-bound step-up proof. Binding is via
  // the per-login sid carried in req.authCtx (see jwt.js / legacyAuthGuard.js), not a hash of
  // the raw Bearer: two logins for the same actor within the same clock second produce a
  // byte-identical token (verified empirically), so a Bearer-hash alone cannot distinguish
  // them — sid is generated fresh, from real entropy, on every signToken call.
  verifyStepUpProof: jwt.verifyStepUpProof,
  // S2-7D4C — closed-enum check for auth_method, injected so adminAccessService never
  // requires ./jwt directly (see adminAccessBoundary.static.test.js).
  isValidAuthMethod: jwt.isValidAuthMethod,
});

// S2-7D6E4 — step-up PIN confirmation. Reuses login.js's exact lockout-safe verify
// sequence (dao.getLockState / getActorForVerify_SENSITIVE / verifyPin real-or-decoy /
// resetFailedAttempts / recordFailedAttempt) against the CALLER'S OWN actor, never a
// body-supplied one. One process-lifetime decoy hash, same pattern as loginHttpIntegration.
const _pinStepUpDecoyHashPromise = hashPin("decoy-not-a-real-pin-000000");
const pinStepUpVerifier = createPinStepUpVerifier({
  dao: authDao,
  jwt,
  pinPolicy,
  verifyPin,
  decoyHashPromise: _pinStepUpDecoyHashPromise,
});

// S2-7D6E — the operator payment registrar. Reuses the accepted B7A2 DAO/service as-is:
// no new SQL, no new transport. Unconditionally constructed (like adminAccessService) —
// the AUTH_V2_FINANCIAL_HTTP_ENABLED flag gates only the /api/financial HTTP surface, not
// the ledger itself, so the operator path does not depend on it.
const operatorPayments = createOperatorPaymentRegistrar({
  financialService: createFinancialService({ dao: createFinancialDao(), ipHash }),
  logger: console,
});

// --- WEBHOOK WHATSAPP ---

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === WA_VERIFY_TOKEN) return res.send(challenge);
  res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  if (req.body.object !== "whatsapp_business_account") return res.sendStatus(404);
  res.sendStatus(200); // risponde subito a Meta
  try { await processWebhook(req.body); } catch (e) { console.error("webhook:", e); }
});

// --- API DASHBOARD ---

// H1B — routed through the shared hardened transport (fail-closed config,
// timeout, resource-policy enforcement) instead of an inline, un-timed fetch().
// The table is a fixed internal constant, never a caller-supplied parameter —
// see src/core/delivery/shadowPreviewEndpoint.js's readOrderRows(), the only
// caller, which always requests "ordenes" (source-verified, never dynamic).
// Endpoint, payload shape, query, columns and status code are unchanged: a
// non-2xx upstream response still throws a plain Error with no .statusCode,
// which handleShadowPreviewReadOnly still maps to HTTP 500, exactly as before.
async function readShadowPreviewOrders(query) {
  const r = await supabaseRequest({ resource: "ordenes", method: "GET", query, operation: "readShadowPreviewOrders" });
  if (!r.ok) throw new Error(`shadow_preview_read_failed_${r.status}`);
  return r.bodyIsJson ? r.body : [];
}

app.get("/api/delivery/shadow-preview", (req, res) => {
  return handleShadowPreviewReadOnly(req, res, { dbClient: readShadowPreviewOrders });
});

app.get("/api", async (req, res) => {
  const action = req.query.action;
  try {
    if (["getAuthActors"].includes(action) && (!req.authCtx || req.authCtx.role !== "admin")) {
      return res.status(403).json({ error: "ROLE_FORBIDDEN" });
    }

    // SERVICE CLOSEOUT V2 / SLICE 4A.1 — getServiceIncidents (operational/
    // financial exposure/audit data) must stay admin-verified REGARDLESS of
    // whether legacyAuthGuardMiddleware happened to be mounted — it is
    // staging-gated behind AUTH_V2_LEGACY_GUARD_ENABLED, OFF by default, and
    // relying on it alone would leave this action protected by nothing but
    // the SHARED DASHBOARD_API_KEY every operator/rider client already holds
    // too, never proof of admin-ness. When the guard already ran (flag on),
    // req.authCtx is already the verified admin decision and this is a
    // cheap no-op re-check. When it did NOT run (flag off), this calls the
    // EXACT SAME verified-identity primitive the guard itself uses
    // (JWT signature + active actor + fresh session_version + role — the
    // role check comes from legacyActionRoles' own ADMIN_ONLY entry for this
    // action, never a body/query field) directly, so the action is
    // unconditionally fail-closed rather than silently open.
    if (["getServiceIncidents"].includes(action) && !req.authCtx) {
      let decision;
      try {
        decision = await authorizeLegacyRequest(req);
      } catch (e) {
        console.error("[getServiceIncidents] inline authorization check failed:", e);
        return res.status(500).json({ error: "internal_error" });
      }
      if (!decision.ok) return res.status(decision.status).json({ error: decision.code });
      req.authCtx = decision.ctx;
    }
    if (["getServiceIncidents"].includes(action) && (!req.authCtx || req.authCtx.role !== "admin")) {
      return res.status(403).json({ error: "ROLE_FORBIDDEN" });
    }
    const cfg = await getConfig();
    let result;

    // S2-1C — rider-scoped reads. When the guard authenticated a rider, the backend (not
    // the client) decides visibility from the active-trip snapshot. Operator/admin fall
    // through to the unchanged handlers below.
    // NB: uses .includes() (not the router equality form) so it does not add duplicate
    // router-action literals that the authorization-contract coverage test counts.
    if (req.authCtx && req.authCtx.role === "rider" &&
        ["getOrdenes", "getManualGiros"].includes(action)) {
      const deps = { sbSelect, getOperationalSessionIds, serviceSessionsQuery };
      const riderResult = action.endsWith("Ordenes")
        ? await riderReads.getRiderOrdenes(deps)
        : await riderReads.getRiderManualGiros(deps);
      // Fail-closed: DRIVER_STATO read error / malformed active snapshot -> 503, never a
      // broadened list.
      if (riderResult && !Array.isArray(riderResult) && riderResult.error) {
        return res.status(503).json({ error: riderResult.error });
      }
      return res.json(riderResult);
    }

    if (action === "getOrdenes") {
      // P0-C2 — scoped to the current session PLUS its immediate rollover
      // source, when that source is still a live, non-destructively-settled
      // 'rolled_over' session (see getOperationalSessionIds' own header) —
      // this is what keeps a table/kitchen ticket that carried across an
      // language-guard: allow-legacy PRANZO is the existing service_kind enum value, named here only to describe the boundary, not new vocabulary
      // intraday PRANZO->SERA boundary visible here, exactly like it was
      // before the boundary. The extra lookup only ever runs when a
      // rollover_source_session_id is actually present on the current
      // session (the common case, no carryover pending, pays nothing extra).
      const sessionIds = await getOperationalSessionIds({ select: sbSelect });
      result = sessionIds.length > 0
        ? await sbSelect(
            "ordenes",
            serviceSessionsQuery(
              sessionIds,
              "estado=in.(POR_CONFIRMAR,NUEVO,EN_COCINA,LISTO,EN_ENTREGA)&order=ts.asc",
            ),
          )
        : [];
    } else if (action === "getOrdenesArchivadosSesion") {
      // LISTOS_ARCHIVADOS_V1 — sibling of getOrdenes above: same session-scoping
      // (getOperationalSessionIds/serviceSessionsQuery, P0-C2), same "no open
      // session -> []" fallback, only the estado filter differs (terminal
      // instead of active). A separate action instead of widening getOrdenes'
      // response keeps that hot, realtime-triggered read from paying for a
      // second query it doesn't need — this one is fetched only while Listos
      // is open.
      const sessionIds = await getOperationalSessionIds({ select: sbSelect });
      result = sessionIds.length > 0
        ? await sbSelect(
            "ordenes",
            serviceSessionsQuery(
              sessionIds,
              // language-guard: allow-legacy COMPLETATO is the legacy Italian terminal spelling still on disk, required alongside COMPLETADO (see orderTerminalStateFilters.test.js), not new vocabulary
              "estado=in.(COMPLETADO,COMPLETATO,RETIRADO)&order=ts.desc&limit=200",
            ),
          )
        : [];
    } else if (action === "getWaMsgs") {
      result = await sbSelect("wa_msgs", "stato=not.eq.COMPLETATO&order=ts.desc&limit=100");
    } else if (action === "getConfig") {
      result = cfg;
    } else if (action === "chiudiServizio") {
      // S2-7D6B — the close window is PER SERVICE KIND, resolved from the
      // schedule module. The old flat "after 22:00" rule made a lunch close
      // literally impossible, which is why lunch could not exist at all.
      //   PRANZO closes from 17:30 onward · SERA from 00:00 onward.
      // A legacy session without a kind keeps the historical 22:00 rule so it
      // never becomes unclosable. `?force=true` still overrides, unchanged.
      const identity = await serviceSessionLifecycle.currentCloseout();
      const kind = identity?.ok ? (identity.session?.service_kind || null) : null;
      // F-8 — ERA-AWARE ROUTING. Same operator-facing action/button/auth as
      // always; the branch is decided server-side from the CURRENT session's
      // own lifecycle_semantics (already present on `identity.session` —
      // get_current_service_closeout_session returns to_jsonb(v_session), the
      // whole row), never from anything the client supplies. An
      // language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values, named here only to describe what an Operational Service does NOT have, not new vocabulary
      // operational_service_v1 session has no PRANZO/SERA identity, so it
      // never reaches (or needs) the closeEligibility clock gate below — that
      // gate is a legacy economic_period_v1 concept only. See
      // tests/f8FinalizarRoutingCutover.static.test.js.
      if (identity?.ok && identity.session?.lifecycle_semantics === "operational_service_v1") {
        const actorId = req.authCtx?.actor;
        if (!actorId) return res.status(401).json({ error: "UNVERIFIED_ACTOR" });
        if (!identity.session?.id) {
          result = { success: false, error: "invalid_service_session_identity" };
        } else {
          // "operator_finalizar_v3" — the one new truthful close_source this
          // slice adds: normal operator Finalizar via the V3 engine. Distinct
          // from every existing value (never "rolled_over", "recovery", or a
          // test/forgotten-close label) because none of those describe this
          // call. The V3 engine itself never gates on service_kind/clock, is
          // already idempotent on retry (its own CASE B/C/D lineage handling),
          // and creates no successor (F-5) — nothing else is done here.
          const v3Result = await closeServiceSessionV3({
            serviceSessionId: identity.session.id,
            source: "operator_finalizar_v3",
            actor: actorId,
          });
          result = v3Result.success
            ? v3Result
            : { success: false, error: v3Result.code || "V3_CLOSE_FAILED", ...v3Result };
        }
      } else {
        // N-2 — LEGACY CLOSE PATH RETIRED (application-wide dead-code purge).
        // This branch is structurally unreachable: open_operational_service_v1
        // is the ONLY primitive that ever creates a service_sessions row, and
        // it hardcodes lifecycle_semantics='operational_service_v1' — no
        // economic_period_v1 session can be newly opened, and the live DB has
        // zero open ones (verified 2026-08-23). It is kept, not removed
        // entirely, only so a corrupted/impossible session identity fails
        // closed with a clear code instead of silently doing nothing.
        result = { success: false, error: "legacy_session_kind_unsupported" };
      }
    } else if (action === "triggerCloseIfNeeded") {
      // N-2 — the automatic (no-human) close scheduler this external-cron
      // backup endpoint fed (serviceCloseTick/catchUpChiusura/incident-safe
      // rollover, behind the retired LEGACY_AUTOMATIC_LIFECYCLE_ENABLED flag)
      // has been deleted: every close now goes through V3 Finalizar (operator,
      // manual) or F-10 forgotten-close recovery (event-driven, from order
      // intake). Endpoint kept registered in case an external cron still
      // pings this URL; permanently inert.
      result = { success: true, skipped: true, reason: "legacy_automatic_lifecycle_retired" };
    } else if (action === "scanServizio") {
      result = await scanServizio();
    } else if (action === "backupSerata") {
      // Stesso blocco temporale del chiudiServizio: il backup è preludio alla chiusura
      const madridHourStr = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", hour: "2-digit", hour12: false }).format(new Date());
      const h = parseInt(madridHourStr, 10);
      if (h < 22 && req.query.force !== "true") {
        result = { success: false, error: `Backup permesso solo dopo le 22:00 Madrid (ora attuale: ${h}:00). Per forzare aggiungere &force=true.` };
      } else {
        result = await backupSerata();
      }
    } else if (action === "rigeneraSuggerimenti") {
      result = await rigeneraSuggerimenti();
    } else if (action === "approvaSuggerimento") {
      result = await approvaSuggerimento(req.query.id, req.query.stato);
    } else if (action === "getConvThread") {
      const rows = await sbSelect("conv", `wa_id=eq.${req.query.wa_id}&select=chat`);
      result = { chat: rows?.[0]?.chat || [] };
    } else if (action === "generaRispostaIA") {
      const { generaRisposta } = require("./src/agents/agentWhatsapp");
      const thread = await sbSelect("conv", `wa_id=eq.${req.query.wa_id}&order=ts.desc&limit=1`);
      const threadCtx = (thread?.[0]?.chat || []).slice(-10).map(m => (m.da === "cliente" ? "C" : "B") + ": " + m.txt).join("\n");
      result = { risposta: await generaRisposta(req.query.testo, req.query.wa_id, cfg, threadCtx) };
    } else if (action === "getClientes") {
      // Lista clienti preferiti + conteggio ordini ultimi 30gg per calcolare VIP lato server.
      // Soglia configurabile via config.VIP_SOGLIA_30GG (default 4).
      const soglia = parseInt(cfg.VIP_SOGLIA_30GG || "4", 10) || 4;
      const cutoffMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const clientes = await sbSelect("clientes",
        "preferito=eq.true&select=id,alias,nombre,tel,direccion,direccion_note,zona,zona_lat,zona_lon,pizza_pref,bevanda_pref,nota_fissa,orario_solito,ultimo_pedido&limit=2000"
      ) || [];
      // Una sola query a storico (cliente_id not null + finestra 30gg) — poi raggruppo in memoria.
      const storicoRows = await sbSelect("storico",
        `cliente_id=not.is.null&ts=gte.${cutoffMs}&select=cliente_id,ts&limit=20000`
      ) || [];
      const counts = {};
      for (const r of storicoRows) counts[r.cliente_id] = (counts[r.cliente_id] || 0) + 1;
      result = clientes.map(c => {
        const n = counts[c.id] || 0;
        return { ...c, ordini_30gg: n, vip: n >= soglia };
      });
    } else if (action === "debugInterpreta") {
      const { interpreta, preDetectaDireccion } = require("./src/agents/agentWhatsapp");
      const testo = req.query.testo || "";
      const ia = await interpreta(testo, cfg, null, []);
      const regex = preDetectaDireccion(testo);
      const tipoConsegna = (ia.tipo_consegna === "DOMICILIO" || regex) ? "DOMICILIO" : "RITIRO";
      result = { ia, regex_match: regex, tipoConsegna_calcolato: tipoConsegna };
    } else if (action === "debugMenuShadow") {
      if (process.env.DYNAMIC_MENU_SHADOW_DEBUG_ENABLED !== "true") return res.status(404).json({ error: "not found" });
      let legacyResult;
      try { legacyResult = JSON.parse(req.query.legacyResult || "null"); } catch (_) { return res.status(400).json({ error: "invalid legacyResult" }); }
      const input = typeof req.query.input === "string" ? req.query.input : "";
      if (!legacyResult || typeof legacyResult.matched !== "boolean") return res.status(400).json({ error: "invalid legacyResult" });
      const replay = await runWhatsappMenuShadow({
        enabled: true,
        legacyItems: Object.freeze([]),
        references: [{ input, legacyResult }],
        loadCanonicalMenu: getCanonicalMenu,
        emitDiagnostic: emitDynamicMenuShadowDiagnostic,
      });
      result = { executed: replay.executed, classification: replay.diagnostics[0]?.classification || "ERROR", legacyResult };
    } else if (action === "getManualGiros") {
      // DELIVERY-MANUAL-GIRO-01 P1C.1: list active manual giros for a
      // service day. Default = today (Madrid TZ) and only non-dissolved.
      // ?day=YYYY-MM-DD overrides the day; ?onlyActive=false includes dissolved.
      result = await getManualGiros({
        day: req.query.day,
        onlyActive: req.query.onlyActive !== "false",
      });
    } else if (action === "getDriverStatus") {
      // Telemetria visiva opzionale del rider. Ritorna status normalizzato o
      // null (assente/stale/malformato/LIBERO) — mai throw, mai blocca la UI.
      result = await getDriverStatus();
    } else if (action === "getMenu") {
      // S3-1B: read-only catalogue consumer. Auth/role enforcement happens in the
      // legacy guard before this dispatcher; the facade hides storage and fallback.
      result = await getCanonicalMenu();
    } else if (action === "getCurrentServiceCloseout") {
      // Server-selected current Madrid service only: no caller-supplied date/range.
      result = await getCurrentServiceCloseout();
    }
    // ── Private authenticated READ contracts (P0). Fixed queries only. ──────
    // Params arrivano da querystring; ogni action valida i propri input e cappa
    // il limit server-side. ReadParamError → 400, ReadBackendError → 500.
    else if (action === "getOrdenesRecent") {
      result = await readActions.getOrdenesRecent();
    } else if (action === "getWaMessages") {
      result = await readActions.getWaMessages();
    } else if (action === "getStorico") {
      result = await readActions.getStorico({ fecha: req.query.fecha, limit: req.query.limit });
    } else if (action === "getEconomiaLedger") {
      // S2-7D6E3 — Economía's cash-by-payment-method figures. Ledger-derived (same
      // aggregate() as the live closeout/serata_summary), never metodo_pago-bucketed.
      result = await readActions.getEconomiaLedger({ desde: req.query.desde, hasta: req.query.hasta });
    } else if (action === "getServiceIncidents") {
      // SERVICE CLOSEOUT V2 / SLICE 4A — the Admin "Incidencias" backlog.
      // Admin-only (see legacyActionRoles.js ADMIN_ONLY / authorizationContract.js
      // ADMIN_ONLY_ACTIONS), same class as getStorico/getEconomiaLedger:
      // sensitive financial/operational history, fresh-auth. Read-only itself
      // — resolution is the separate "resolveServiceIncident" action (P0-C3)
      // below, so a filterable list is enough to find a given incident's id.
      result = await readActions.getServiceIncidents({
        resolutionStatus: req.query.resolutionStatus,
        category: req.query.category,
        businessDate: req.query.businessDate,
        serviceSessionId: req.query.serviceSessionId,
        incidentId: req.query.incidentId,
        limit: req.query.limit,
      });
    } else if (action === "getOrdenesArchivio") {
      result = await readActions.getOrdenesArchivio({ limit: req.query.limit });
    } else if (action === "getDeliveryLogs") {
      result = await readActions.getDeliveryLogs({ limit: req.query.limit });
    } else if (action === "getSuggerimenti") {
      result = await readActions.getSuggerimenti();
    } else if (action === "getAuthActors") {
      const rows = await authDao.listActorsSafe();
      result = rows.map(({ actor, role, active }) => ({ actor, role, active }));
    } else if (action === "getConversacionesActivas") {
      result = await readActions.getConversacionesActivas();
    } else if (action === "getClienteByTelefono") {
      result = await readActions.getClienteByTelefono({ telefono: req.query.telefono });
    } else if (action === "getWaMessageById") {
      result = await readActions.getWaMessageById({ id: req.query.id });
    } else if (action === "getOrdenById") {
      result = await readActions.getOrdenById({ id: req.query.id });
    } else if (action === "getConvByWaId") {
      result = await readActions.getConvByWaId({ wa_id: req.query.wa_id });
    } else if (action === "getConvChats") {
      // wa_ids come CSV in querystring → array validato in readActions.
      result = await readActions.getConvChats({ wa_ids: req.query.wa_ids });
    } else {
      result = { error: "unknown action: " + action };
    }

    res.json(result);
  } catch (e) {
    // Typed read errors carry a controlled httpStatus (400 param / 500 read).
    // Everything else stays a generic 500 without leaking internals.
    const status = e && e.httpStatus ? e.httpStatus : 500;
    if (status >= 500) console.error("API GET error:", e);
    res.status(status).json({ error: status === 400 ? e.message : "read failed" });
  }
});

app.post("/api", async (req, res) => {
  const action = req.query.action || req.body.action;
  try {
    if (["setActorPin", "verifyOwnPin"].includes(action) && (!req.authCtx || req.authCtx.role !== "admin")) {
      return res.status(403).json({ error: "ROLE_FORBIDDEN" });
    }
    let result;

    // S2-1B/1C — the trip primitives are the SINGLE transactional DRIVER_STATO authority
    // for EVERY authorized role. When the guard authenticated any caller on a trip-primitive
    // action (marcarEnEntrega/registrarSalidaDriver/marcarEntregado/chiudiGiro), route to the
    // RPC-backed wrapper and return, bypassing the old direct DRIVER_STATO writers below.
    // S2-7D6B — THE silent path. Called on every Servicio entry; idempotent, so
    // the second operator of a shift reuses the first one's UUID. The service
    // kind is resolved server-side from the schedule and is NEVER read from the
    // request body: a caller that could name its own service could misfile a
    // whole shift's takings.
    if (action === "ensureCurrentServiceSession") {
      const actorId = req.authCtx?.actor;
      if (!actorId) return res.status(401).json({ error: "UNVERIFIED_ACTOR" });
      let ensured = await ensureCurrentServiceSession({ actor: actorId, source: "auto_entry" });

      // STALE SERVICE PROTECTION V1 — the ONE synchronous remediation point.
      // ensureCurrentServiceSession returns REUSED for a still-open service
      // regardless of its Business Day (it reads through
      // get_current_service_closeout_session, which migration 120 does NOT
      // touch). So, exactly here, classify that service and — if it belongs
      // to a PAST Business Day — either safely auto-finalize it through the
      // one V3 close authority or surface PREVIOUS_SERVICE_PENDING. The
      // frontend never compares dates; it projects this canonical state.
      if (ensured.success && ensured.code === "REUSED" && ensured.session && ensured.session.id) {
        let recovery = null;
        try {
          recovery = await recoverStaleService({ actor: actorId, source: "stale_service_auto_recovery" });
        } catch (e) {
          // A recovery read failure must never turn the silent path into a
          // 5xx. Leave `ensured` as-is; the SQL fail-closed intake guard
          // (migration 120) remains the backstop against misfiled work.
          console.warn("[ensureCurrentServiceSession] stale-service recovery unavailable (non-fatal):", (e && e.message) || e);
        }
        if (recovery && recovery.stale) {
          if (recovery.recovered) {
            // AUTO_RECOVERY_PERFORMED — the stale service is finalized. Re-run
            // the silent resolver so the response reflects the NEW lifecycle
            // state (typically NO_OPEN_SERVICE: the restaurant is idle until
            // the next real order/seating opens the current-day service, via
            // resolve_order_intake_context_v1 — G-1, unchanged).
            ensured = await ensureCurrentServiceSession({ actor: actorId, source: "auto_entry" });
            ensured.autoRecovery = {
              performed: true,
              code: "AUTO_RECOVERY_PERFORMED",
              recoveredServiceSessionId: recovery.recoveredServiceSessionId,
              staleBusinessDate: recovery.staleBusinessDate,
              currentBusinessDate: recovery.currentBusinessDate,
              idempotent: recovery.idempotent === true,
            };
            // fall through to the normal ensured.success / non-success handling
          } else {
            // PREVIOUS_SERVICE_PENDING — the stale service cannot be auto-
            // finalized (operational blockers / unpaid / over-collected /
            // un-buildable reconciliation). The operator must resolve it via
            // the EXISTING manual Finalizar flow for THIS service.
            return res.status(409).json({
              success: false,
              code: "PREVIOUS_SERVICE_PENDING",
              staleServiceSessionId: recovery.staleServiceSessionId,
              staleBusinessDate: recovery.staleBusinessDate,
              currentBusinessDate: recovery.currentBusinessDate,
              blockers: recovery.blockers,
              // The stale service row itself, so the frontend can open the
              // certified Finalizar preflight for exactly this id — never a
              // client-chosen one.
              session: ensured.session,
            });
          }
        }
      }

      // A non-success here is almost never a crash: "we are in the 17:30-18:00
      // buffer" and "lunch is still open" are legitimate answers the UI renders
      // differently. 200 carries them; only a genuine failure is a 5xx.
      if (ensured.success) {
        // SERVICE CLOSEOUT V2 / SLICE 4A — non-blocking, read-only carryover
        // warning. Lifecycle reconciliation above is ALREADY fully decided by
        // this point (ensured.success is true, ensured.session is the real
        // current session) — this can NEVER change whether the service opens
        // or which session is current. A failure here degrades to simply
        // omitting the field; it must never turn into a 5xx for this action,
        // never reopen/reclose the session, and never block order intake.
        try {
          if (ensured.session && ensured.session.id) {
            ensured.previousCloseoutIncidents = await getPreviousCloseoutIncidentSummary({
              currentServiceSessionId: ensured.session.id,
            });
          }
        } catch (e) {
          console.warn("[ensureCurrentServiceSession] previous-closeout incident summary unavailable (non-fatal):", e && e.message || e);
        }
        return res.json(ensured);
      }
      const conflict = ensured.code === "LUNCH_SESSION_STILL_ACTIVE"
        || ensured.code === "OTHER_SERVICE_STILL_ACTIVE"
        || ensured.code === "SERVICE_SESSION_CLOSING";
      return res.status(conflict ? 409 : 200).json(ensured);
    }

    if (action === "openServiceSession") {
      // LEGACY WRITER HARDENING — RETIRED, PERMANENTLY AND UNCONDITIONALLY.
      //
      // F-9 made this the one intentional-open trigger, routing to
      // explicitReopenServiceSession -> open_operational_service_v1
      // ('explicit_reopen'). G-1 removed the reason it existed: the
      // Operational Service now resumes by itself on the first real order or
      // table seating after a Finalizar, so there is nothing a manual open
      // can achieve that the restaurant does not already get for free. The
      // frontend affordances were deleted in 3eeb24d; this closes the HTTP
      // surface behind them, which was still reachable by anyone able to
      // authenticate and POST.
      //
      // Refused with 410 Gone, not 404: the action existed, was legitimate,
      // and was deliberately withdrawn — an operator or integration hitting
      // it deserves to be told that, not to be left guessing at a typo. No
      // env flag, because a flag is exactly what this slice exists to remove:
      // there must be no configuration under which a human can hand-mint an
      // Operational Service.
      //
      // explicitReopenServiceSession.js itself is left on disk, now with zero
      // callers. Deleting the module is cosmetic; removing its reachability
      // is the invariant, and that is what is asserted by
      // tests/legacyWriterHardening.static.test.js.
      return res.status(410).json({
        error: "MANUAL_SERVICE_OPEN_RETIRED",
        detail: "The Operational Service resumes automatically on the first real order or table seating. There is no manual open.",
      });
    } else if (action === "rollEconomicPeriod") {
      // P0-C2 — explicit, deliberate, non-silent trigger of the non-destructive
      // intraday economic boundary (roll_service_session_economic_v1). Never
      // called automatically — no scheduler/timer wires this anywhere; see
      // economicBoundaryEngine.js's own header for why that stays a separate,
      // future decision (matching P0-C1's "build the primitive, prove it
      // independently" precedent). Idempotent: NO_ROLLOVER_DUE is a normal,
      // non-error success when the current session's kind/date already match
      // what the clock says should be current.
      //
      // CONTAINMENT (S-D, this session): after the Operational Service repair,
      // language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values, named here only to describe what no longer selects session identity, not new vocabulary
      // service_sessions identity no longer follows PRANZO/SERA within a
      // Business Day (see resolve_order_intake_context_v1). This action is the
      // one remaining runtime surface still capable of manually recreating a
      // period-as-session split; it has zero frontend callers (grepped both
      // frontend repos, confirmed empty) and is orphaned. Same discipline as
      // SERVICE_PERIOD_CONSOLIDATION_ENABLED immediately below: exact-match
      // fail-closed gate, unset/anything other than the literal string 'true'
      // means disabled. Does not touch the RPC or economicBoundaryEngine.js —
      // this is the smallest possible containment, at the HTTP boundary only.
      if (process.env.ECONOMIC_PERIOD_ROLLOVER_ENABLED !== "true") {
        return res.status(403).json({ error: "ECONOMIC_PERIOD_ROLLOVER_DISABLED" });
      }
      const actorId = req.authCtx?.actor;
      if (!actorId) return res.status(401).json({ error: "UNVERIFIED_ACTOR" });
      const rolled = await rollEconomicPeriod({ actor: actorId, source: "operator" });
      if (!rolled.success) return res.status(409).json({ error: rolled.code || "ECONOMIC_BOUNDARY_ROLL_FAILED", detail: rolled });
      result = rolled;
    } else if (action === "consolidateServicePeriod") {
      // R-DAY4 — explicit, immutable economic checkpoint for one Service
      // Period. NOT a permission gate, NOT a period transition: it never
      // touches business_day_lifecycle_state/service_session_state/service_
      // sessions.status (see periodConsolidation.js's own header). actor/role/
      // sid are the VERIFIED req.authCtx identity, never client-asserted.
      // resetTickets must be an explicit boolean from the caller — never
      // defaulted here (R-DAY0's own ticket-reset contract: a separate,
      // deliberate decision, never an automatic consequence of consolidating).
      //
      // CONTAINMENT (owner decision, this session, immediately after R-DAY4
      // certification): the exposed action name does not match the product's
      // actual "Resumen del servicio" contract (read-only, non-mutating) and
      // must not be reachable for normal operational use until that semantic
      // question is resolved. Exact-match fail-closed gate, same discipline
      // as AUTH_V2_LOGIN_HTTP_ENABLED/DYNAMIC_MENU_SHADOW_ENABLED elsewhere in
      // this file: unset/anything other than the literal string 'true' means
      // disabled. Does not touch the RPC, the table, or any existing row —
      // this is the smallest possible containment, at the HTTP boundary only.
      if (process.env.SERVICE_PERIOD_CONSOLIDATION_ENABLED !== "true") {
        return res.status(403).json({ error: "SERVICE_PERIOD_CONSOLIDATION_DISABLED" });
      }
      const actorId = req.authCtx?.actor;
      const actorRole = req.authCtx?.role;
      if (!actorId || !actorRole) return res.status(401).json({ error: "UNVERIFIED_ACTOR" });
      const { periodId, resetTickets, clientRequestId } = req.body || {};
      if (!periodId || typeof periodId !== "string") {
        return res.status(400).json({ error: "PERIOD_ID_REQUIRED" });
      }
      if (typeof resetTickets !== "boolean") {
        return res.status(400).json({ error: "RESET_TICKETS_MUST_BE_EXPLICIT_BOOLEAN" });
      }
      if (!clientRequestId || typeof clientRequestId !== "string") {
        return res.status(400).json({ error: "CLIENT_REQUEST_ID_REQUIRED" });
      }
      // Fail-closed workspace resolution, JS-side mirror of the SQL layer's
      // own mesa_singleton_workspace_v1() check (defense in depth, same
      // reasoning as order_entity_anchor_v1 for non-table orders).
      let workspaceRows;
      try {
        workspaceRows = await sbSelect("workspaces", "select=id&limit=2");
      } catch (e) {
        return res.status(500).json({ error: "WORKSPACE_LOOKUP_FAILED", detail: String((e && e.message) || e) });
      }
      if (!Array.isArray(workspaceRows) || workspaceRows.length !== 1) {
        return res.status(500).json({ error: "WORKSPACE_AMBIGUOUS" });
      }
      const consolidated = await periodConsolidation.consolidate({
        workspaceId: workspaceRows[0].id,
        periodId,
        actor: actorId,
        role: actorRole,
        sid: req.authCtx?.sid || null,
        resetTickets,
        clientRequestId,
      });
      if (!consolidated.success) {
        const status = consolidated.code === "SERVICE_PERIOD_NOT_FOUND" ? 404 : 409;
        return res.status(status).json({ error: consolidated.code || "PERIOD_CONSOLIDATION_FAILED", detail: consolidated });
      }
      result = consolidated;
    } else if (action === "resolveServiceIncident") {
      // P0-C3 — Phase 5 explicit resolution primitive. Thin wrapper over the
      // already-built, already-idempotent, already-admin-gated (DB-level)
      // serviceIncidents.resolve() (2026-08-08_service_closeout_incidents_
      // foundation.sql) — this action is the first thing that ever calls it
      // from a live route. Resolves the INCIDENT record only: never touches
      // the underlying order/table_session (canonical state, financial
      // truth, and estado are all untouched by this action — resolve_
      // service_incident's own body writes exclusively to
      // service_incidents). A previous-business-day residue order does NOT
      // language-guard: allow-legacy CHIUSO_FORZATO is the existing terminal-state literal, named here only to state what this action does NOT do, not new vocabulary
      // become CHIUSO_FORZATO by being acknowledged/resolved here — that
      // remains a deliberate, separate, order-level decision this action
      // does not make (see P0_C3 report §16).
      // resolvedBy/role are SERVER-DERIVED from the verified actor identity,
      // exactly like every other admin action in this file — never read from
      // req.body (see serviceIncidents.js's own trust-boundary comment).
      const actorId = req.authCtx?.actor;
      const actorRole = req.authCtx?.role;
      if (!actorId || !actorRole) return res.status(401).json({ error: "UNVERIFIED_ACTOR" });
      const { incidentId, resolutionType, resolutionStatus, resolutionNote } = req.body || {};
      if (!incidentId || typeof incidentId !== "string") {
        return res.status(400).json({ error: "INCIDENT_ID_REQUIRED" });
      }
      if (!resolutionType || typeof resolutionType !== "string" || !resolutionType.trim()) {
        return res.status(400).json({ error: "RESOLUTION_TYPE_REQUIRED" });
      }
      const resolved = await serviceIncidents.resolve({
        incidentId, resolvedBy: actorId, role: actorRole,
        resolutionType, resolutionStatus: resolutionStatus || "resolved",
        resolutionNote: resolutionNote || null,
      });
      if (!resolved.success) {
        const status = resolved.code === "INCIDENT_RESOLUTION_FORBIDDEN" ? 403 : 409;
        return res.status(status).json({ error: resolved.code || "SERVICE_INCIDENT_RESOLVE_FAILED", detail: resolved });
      }
      result = resolved;
    } else if (req.authCtx && req.authCtx.rule && req.authCtx.rule.tripPrimitive) {
      // The verified identity travels under a reserved key the client cannot forge:
      // req.authCtx is built by legacyAuthGuard from the Bearer token and is spread LAST,
      // so any `__authCtx` present in the request body is overwritten, never trusted.
      const mapped = await routeRiderTripAction(action, {
        ...req.body,
        __authCtx: { ...req.authCtx, clientIp: trustedClientIp(req) },
      });
      return res.status(mapped.status).json(mapped.payload);
    }

    if (action === "cambiaStato") {
      result = await cambiaStato(req.body.id, req.body.estado, {
        actor_type: req.body.actor_type || "operator",
        // S2-7D6E3 — actor_id is an audit-trail identity claim: it must come from the
        // VERIFIED req.authCtx (set by legacyAuthGuard from the Bearer token), never from
        // the request body, or any dashboard-key holder could forge who performed the
        // transition. Falls back to null (unattributed) when the guard is not enabled,
        // exactly as before — this only stops trusting a client-asserted identity.
        actor_id: req.authCtx?.actor || null,
        origin: req.body.origin || "dashboard",
      });
    } else if (action === "creaOrdine") {
      // Dashboard operatore: niente blocco hard orario chiusura (vedi creaOrdine).
      // S2-7D6E3 — actor_id override AFTER the spread: whatever the client put in the
      // body is discarded, the verified actor always wins.
      // N-3 — same rule for the money: the paid-at-creation intent is built from the VERIFIED
      // context, never from the body, and a context we cannot verify refuses the creation
      // outright instead of quietly producing an unpaid order the operator thinks is paid.
      const intentA = buildInitialPaymentIntent({
        body: req.body, authCtx: req.authCtx, ipHash, trustedClientIp: trustedClientIp(req),
      });
      if (!intentA.ok) {
        return res.status(409).json({
          success: false, error: intentA.code, code: intentA.code, message: intentA.message,
        });
      }
      // language-guard: allow-legacy creaOrdine is the existing JS order-creation function being called, not new vocabulary
      result = await creaOrdine({
        ...req.body,
        actor_id: req.authCtx?.actor || null,
        initial_payment_intent: intentA.intent,
        operatorManual: true,
      });
    } else if (action === "modificaOrdine") {
      // Dashboard operatore: geo/durata ri-risolti server-side, hora preservata.
      result = await modificaOrdine(req.body.id, { ...req.body, operatorManual: true });
    } else if (action === "aggiornaRispostaBot") {
      await sbUpdate("wa_msgs", `id=eq.${req.body.id}`, { bot_risposta: req.body.bot_risposta });
      result = { success: true };
    } else if (action === "setConfig") {
      // S2-1C — DRIVER_STATO is owned exclusively by the transactional trip primitives.
      // The operational legacy config route must never write it, even for admin.
      if (req.body.chiave === "DRIVER_STATO") {
        return res.status(403).json({ error: "DRIVER_STATO is managed by the rider trip primitives" });
      }
      await sbUpsert("config", { chiave: req.body.chiave, valore: req.body.valore });
      result = { success: true };
    } else if (action === "verifyOwnPin") {
      // S2-7D6E4 — step-up confirmation. actor/role/sv come ONLY from the verified
      // req.authCtx; the client supplies nothing but the PIN it claims to know.
      const out = await pinStepUpVerifier.verifyOwnPin({
        actor: req.authCtx.actor,
        role: req.authCtx.role,
        sv: req.authCtx.sv,
        pin: req.body && req.body.pin,
        sid: req.authCtx.sid,
        // S2-7D4C — server-derived, from the verified token only; never accepted from the body.
        authMethod: req.authCtx.authMethod,
      });
      if (!out.ok) {
        if (out.code === "blocked") return res.status(429).json({ ok: false, error: "LOCKED", retryAfterSec: out.retryAfterSec || 0 });
        if (out.code === "bad") return res.status(400).json({ ok: false, error: "BAD_REQUEST" });
        if (out.code === "unavail") return res.status(503).json({ ok: false, error: "UNAVAILABLE" });
        // S2-7D6E4 — a session signed before the sid fix has no per-login id and cannot ever
        // get a step-up proof: no weaker fallback exists. Distinct code so the UI can say
        // plainly "log in again" instead of a misleading "PIN incorrecto".
        if (out.code === "reauth_required") return res.status(401).json({ ok: false, error: "REAUTH_REQUIRED" });
        return res.status(401).json({ ok: false, error: "PIN_INCORRECTO" });
      }
      result = { ok: true, stepUpProof: out.stepUpProof, expiresInSec: out.expiresInSec };
    } else if (action === "setActorPin") {
      const targetActor = req.body && req.body.targetActor;
      const out = await adminAccessService.setActorPin({
        byActor: req.authCtx.actor,
        byRole: req.authCtx.role,
        bySv: req.authCtx.sv,
        bySid: req.authCtx.sid,
        // S2-7D4C — server-derived, from the verified token only; never accepted from the body.
        byAuthMethod: req.authCtx.authMethod,
        targetActor,
        newPin: req.body && req.body.newPin,
        // S2-7D6E4 — FIX: this used to be auto-supplied as `targetActor === "owner" ?
        // "CHANGE_OWNER_PIN" : null`, meaning any admin session could change the owner's
        // own PIN with zero explicit confirmation. The literal phrase is a deliberate
        // friction step and must come from the caller, exactly like the SQL contract
        // (auth_set_actor_pin_v2) always intended.
        confirmation: targetActor === "owner" ? (req.body && req.body.confirmation) : null,
        trustedClientIp: trustedClientIp(req),
        metadata: { source: "admin_pin_management" },
        stepUpProof: req.body && req.body.stepUpProof,
      });
      if (!out.ok) return res.status(400).json({ ok: false, error: "admin_action_failed" });
      result = { ok: true, actor: out.actor, selfChanged: out.actor === req.authCtx.actor };
    } else if (action === "rispondiWA") {
      const cfg = await getConfig();
      await invia(req.body.wa_id || req.body.tel, req.body.testo, cfg);
      result = { success: true };
    } else if (action === "updateWaStato") {
      // Patch generica su wa_msgs — stato, ordine_ref, ia_items.
      // Solo i campi passati vengono aggiornati.
      const upd = {};
      if (req.body.stato       !== undefined) upd.stato       = req.body.stato;
      if (req.body.ordine_ref  !== undefined) upd.ordine_ref  = req.body.ordine_ref;
      if (req.body.ia_items    !== undefined) upd.ia_items    = req.body.ia_items;
      await sbUpdate("wa_msgs", `id=eq.${req.body.id}`, upd);
      result = { success: true };
    } else if (action === "updateOrden") {
      // Dashboard operatore: geo/durata ri-risolti server-side, hora preservata.
      result = await modificaOrdine(req.body.id, { ...req.body, operatorManual: true });
    } else if (action === "updateEstado") {
      // Accetta campi timing/repartidor/descuento in unica scrittura atomica.
      // S2-7D6E2 — `cobrado` e `ya_pagado` NON sono più accettati dal client: erano
      // l'ultima via per cui il frontend poteva dichiarare un incasso senza alcun evento
      // in order_financial_events. Le due colonne le scrive solo il ledger, sotto lock.
      // `metodo_pago` resta accettato perché descrive un INTENTO (e per un metodo di
      // incasso reale viene comunque scritto da order_mark_paid, vedi sotto).
      const extras = {};
      for (const k of ["metodo_pago","hora_entrega","hora_salida","repartidor","llegado","cucina_check","descuento_tipo","descuento_valor"]) {
        if (req.body[k] !== undefined) extras[k] = req.body[k];
      }
      extras.actor_type = req.body.actor_type || "operator";
      // S2-7D6E3 — same rule as cambiaStato/creaOrdine: verified req.authCtx only.
      extras.actor_id = req.authCtx?.actor || null;
      extras.origin = req.body.origin || "dashboard";
      // F-7.6 — OPTIONAL operator justification, persisted into the transition
      // audit as metadata.reason (see agentOrdini.cambiaStato). Exactly ONE // language-guard: allow-legacy agentOrdini is the existing module filename being cross-referenced, not new vocabulary
      // free-text field is accepted here: arbitrary client metadata must never
      // become injectable into the audit log. Trimmed and length-capped; absent
      // or blank leaves the ordinary contract untouched (no `reason` key is
      // written at all), so existing callers are byte-for-byte unaffected.
      if (typeof req.body.reason === "string" && req.body.reason.trim()) {
        extras.reason = req.body.reason.trim().slice(0, 500);
      }

      // S2-7D6E — money first, state second. A RETIRADO carrying a payment method is a
      // COLLECTION: it must produce a ledger event before the order is allowed to move.
      // If the ledger refuses, we do NOT transition — a false "retired & paid" is exactly
      // the defect this replaces. The operator sees the code and retries; the key is
      // deterministic, so the retry replays instead of double-charging.
      const collecting = String(req.body.estado || "") === "RETIRADO"
        && isCollectionMethod(extras.metodo_pago);
      // N-5 — BEFORE any money moves. "Money first, state second" collects on the CURRENT
      // total, so a discount carried by the same request would be applied AFTER the charge:
      // the ledger would record the undiscounted amount and the order's total would then
      // drop below it. The DB guard refuses that second write — but by then the money is
      // already recorded and the order is stranded mid-transition. Refusing here means
      // nothing is charged and nothing is stuck. Applying a discount and collecting are two
      // operations: discount the order first (still unpaid, still editable), then collect.
      if (collecting && collectionWouldMutateEconomicBasis(extras)) {
        return res.status(409).json({
          success: false, error: PAID_ORDER_ECONOMIC_MUTATION_FORBIDDEN,
          code: PAID_ORDER_ECONOMIC_MUTATION_FORBIDDEN,
          message: PAID_ORDER_ECONOMIC_MESSAGE,
        });
      }
      if (collecting) {
        const pay = await operatorPayments.registerPayment({
          orderId: req.body.id,
          paymentMethod: extras.metodo_pago,
          authCtx: req.authCtx,
          trustedClientIp: trustedClientIp(req),
          origin: extras.origin,
        });
        if (!pay.ok) {
          return res.status(409).json({ success: false, error: pay.code, code: pay.code,
            message: "No se pudo registrar el cobro. El pedido no ha cambiado de estado." });
        }
        // order_mark_paid already set ya_pagado/cobrado/metodo_pago under lock. Re-writing
        // them here would be a redundant second authority over the same accounting fact.
        // (cobrado/ya_pagado non entrano piu in `extras`: li scrive solo il ledger.)
        if (!pay.alreadyPaidLegacy) {
          delete extras.metodo_pago;
        }
      }
      result = await cambiaStato(req.body.id, req.body.estado, extras);
    } else if (action === "marcarEnEntrega") {
      // LISTO → EN_ENTREGA — registra hora_salida atomicamente
      result = await cambiaStato(req.body.id, "EN_ENTREGA", {
        hora_salida: Date.now(),
        actor_type: "rider",
        origin: "entregas",
      });
    } else if (action === "marcarEntregado") {
      // EN_ENTREGA/LISTO → RETIRADO — registra hora_entrega + cobrado + metodo_pago atomicamente.
      // Eventuale descuento applicato al momento del incasso.
      // S2-7D6E2 — `cobrado` NON viene più preso dal body (era `req.body.cobrado !== false`,
      // cioè true di default e dichiarato dal client). Con un metodo non-incasso tipo
      // "manual" quel ramo scriveva cobrado=true SENZA alcun evento nel ledger: è l'ultimo
      // percorso che inventava un incasso. Ora la colonna la scrive solo il ledger.
      const extras = {
        hora_entrega: Date.now(),
        metodo_pago: req.body.metodo_pago || "",
        actor_type: "rider",
        origin: "entregas",
      };
      if (req.body.descuento_tipo  !== undefined) extras.descuento_tipo  = req.body.descuento_tipo;
      if (req.body.descuento_valor !== undefined) extras.descuento_valor = req.body.descuento_valor;

      // S2-7D6E — same contract as updateEstado. This path historically defaulted
      // `cobrado` to TRUE while updateEstado left it untouched: the same operator concept
      // produced two different accounting outcomes depending on which action fired. The
      // ledger is now the single authority whenever a real method is supplied.
      // N-5 — same rule as updateEstado above, same reason: this path accepts a discount
      // too, and it would land after the charge. Refuse before the money moves.
      if (isCollectionMethod(extras.metodo_pago) && collectionWouldMutateEconomicBasis(extras)) {
        return res.status(409).json({
          success: false, error: PAID_ORDER_ECONOMIC_MUTATION_FORBIDDEN,
          code: PAID_ORDER_ECONOMIC_MUTATION_FORBIDDEN,
          message: PAID_ORDER_ECONOMIC_MESSAGE,
        });
      }
      if (isCollectionMethod(extras.metodo_pago)) {
        const pay = await operatorPayments.registerPayment({
          orderId: req.body.id,
          paymentMethod: extras.metodo_pago,
          authCtx: req.authCtx,
          trustedClientIp: trustedClientIp(req),
          origin: "entregas",
        });
        if (!pay.ok) {
          return res.status(409).json({ success: false, error: pay.code, code: pay.code,
            message: "No se pudo registrar el cobro. El pedido no ha cambiado de estado." });
        }
        // (cobrado/ya_pagado non entrano piu in `extras`: li scrive solo il ledger.)
        if (!pay.alreadyPaidLegacy) {
          delete extras.metodo_pago;
        }
      }
      result = await cambiaStato(req.body.id, "RETIRADO", extras);
    } else if (action === "asignarRepartidor") {
      await sbUpdate("ordenes", `id=eq.${encodeURIComponent(req.body.id)}`, { repartidor: req.body.repartidor || null });
      result = { success: true };
    } else if (action === "registrarSalidaDriver") {
      // S2-1D — DRIVER_STATO is owned exclusively by the rider trip RPCs. A trip is started
      // by start_rider_trip (marcarEnEntrega route). This legacy side-effect no longer writes
      // a fresh DRIVER_STATO object; it is an inert idempotent compatibility no-op.
      result = { success: true, code: "IDEMPOTENT", skipped: "managed_by_trip_rpc" };
    } else if (action === "chiudiGiro") {
      // Driver rientra: calcola rientro stimato + logga il giro.
      // Logica centralizzata in driverTelemetry.closeGiroInternal (condivisa con
      // l'hook interno su RETIRADO). IDEMPOTENTE: chiamate ripetute non duplicano
      // il delivery_log (skip se rientro_stimato già settato). Back-compat: stessa
      // forma di response del legacy ({success, rientroStimato, tempoAndata} oppure
      // {success, skipped}). Best-effort: non fa mai throw.
      result = await closeGiroInternal();
    } else if (action === "marcarLlegado") {
      // Cliente arrivato (RITIRO) — segna flag llegado
      await sbUpdate("ordenes", `id=eq.${encodeURIComponent(req.body.id)}`, { llegado: req.body.llegado !== false });
      result = { success: true };
    } else if (action === "setUiOffset") {
      // Snooze visivo per-card DOMICILIO: sposta countdown +N min senza toccare hora/forno_out.
      // Reset naturale a chiudiServizio (ordine va in storico, ui_offset_min escluso da buildStoricoPayload).
      const off = Math.max(0, Math.min(20, parseInt(req.body.offset_min) || 0));
      await sbUpdate("ordenes", `id=eq.${encodeURIComponent(req.body.id)}`, { ui_offset_min: off });
      result = { success: true, ui_offset_min: off };
    } else if (action === "resolveAddress") {
      const { risolviIndirizzo } = require("./src/utils/geoResolver");
      const { direccion, tel, tipoConsegna, forceRefresh } = req.body;
      result = await risolviIndirizzo({
        direccion, tel: tel || null,
        tipoConsegna: tipoConsegna || "DOMICILIO",
        forceRefresh: !!forceRefresh
      });
    } else if (action === "previewOrderTiming") {
      // Step 1 anti-cerotto: timing delivery autoritativo (read-only, no DB write).
      // Fonte unica per zona/durata/forno_out/hora/warning/giro destinata alla
      // dashboard. NON si fida di durata/zona calcolate dal client.
      result = await previewOrderTiming(req.body || {});
    } else if (action === "previewOrderPlanner") {
      // PORT-55 — Nuevo Pedido Premium -> backend planner (read-only). Single
      // source for availability/lead-time/giros. NO write: DB read-only via
      // sbSelect, geo resolver read-only/no-cache by default inside
      // previewOrderPlanner. `now` is the server-authoritative Madrid clock:
      // without it the snapshot fell back to defaultNow() ("19:00") and the D1
      // physical guard (forno_out in the past) could not apply.
      result = await previewOrderPlanner(req.body || {}, {
        db: createReadOnlyRestDb({ sbSelect }),
        now: () => nowMadridHHMM(),
      });
    } else if (action === "previewStrategicOpportunities") {
      // PORT-55 — Premium Planner strategic preview (read-only). Exposes the
      // offline chain -> contract `premium-planner-strategic-preview-v1`.
      // PREVIEW ONLY: no write, no apply, no manual_giros, no PII.
      //
      // loadSnapshot is injected via a read-only closure (loadPlannerSnapshot +
      // createReadOnlyRestDb): the adapter stays pure with no default loader and
      // the DB is `select` only (allowlist, no PII, no wildcard). startTime stays
      // an EXPLICIT input — the adapter returns `missing_start_time` when absent;
      // nothing here invents rider availability.
      //
      // Input safety: `snapshot`/`anchors` are NOT forwarded from the client —
      // anchors derive ONLY from the read-only snapshot (no order injection).
      const sp = req.body || {};
      // Anti-staleness: the operator flow does not send date/now. Without them the
      // snapshot would full-scan ordenes and anchors would have no time reference.
      // Derived HERE (backend boundary) on this line's Business Day calendar.
      result = await previewStrategicOpportunities({
        currentOrderDraft: sp.currentOrderDraft,
        startTime: sp.startTime,
        date: sp.serviceDate || sp.date || plannerBusinessDate(),
        now: sp.now || nowMadridHHMM(),
        includeCrossZone: sp.includeCrossZone,
        capacity: sp.capacity,
        toleranceMin: sp.toleranceMin,
      }, {
        loadSnapshot: (args) => loadPlannerSnapshot({
          ...args,
          db: createReadOnlyRestDb({ sbSelect }),
        }),
      });
    } else if (action === "previewManualGiroRoute") {
      // PORT-55 — Premium Planner manual giro route preview (read-only). The
      // operator proposes a SEQUENCE of stops (selectedStops) and the backend
      // computes the v2 `routeTimeline` from the PURE bricks (deliveryChannels +
      // deliveryLegs + routeImpact + buildRouteTimeline) -> contract
      // `premium-planner-manual-giro-route-preview-v1`. PREVIEW ONLY: no write,
      // no apply, no manual_giros, no PII, no Date.now.
      //
      // No DB here: the action is pure over its input. Input safety: only the
      // proposed route's fields are forwarded (no snapshot/anchors injection, no
      // PII). startTime stays EXPLICIT -> `missing_start_time` when absent.
      const mg = req.body || {};
      result = previewManualGiroRoute({
        startTime: mg.startTime,
        currentOrderDraft: mg.currentOrderDraft,
        selectedStops: mg.selectedStops,
        selectedZones: mg.selectedZones,
        includeReturn: mg.includeReturn,
        includeCrossZone: mg.includeCrossZone,
        capacity: mg.capacity,
        toleranceMin: mg.toleranceMin,
      });
    } else if (action === "createOrden") {
      const d = req.body.data || req.body;
      if (!d.waId && d.wa_id) d.waId = d.wa_id;
      // Dashboard operatore: niente blocco hard orario chiusura (vedi creaOrdine).
      // N-3 — THE Nuevo Pedido path. `actor_id` is now threaded here too: it was already
      // being passed by the sibling creation action above, so its absence here left every
      // order created from the modal with an unattributed `created` transition log.
      const intentB = buildInitialPaymentIntent({
        body: d, authCtx: req.authCtx, ipHash, trustedClientIp: trustedClientIp(req),
      });
      if (!intentB.ok) {
        return res.status(409).json({
          success: false, error: intentB.code, code: intentB.code, message: intentB.message,
        });
      }
      // language-guard: allow-legacy creaOrdine is the same existing JS order-creation function, called here for the Nuevo Pedido path, not new vocabulary
      result = await creaOrdine({
        ...d,
        actor_id: req.authCtx?.actor || null,
        initial_payment_intent: intentB.intent,
        operatorManual: true,
      });
    } else if (action === "updateNotaCucina") {
      await sbUpdate("ordenes", `id=eq.${encodeURIComponent(req.body.id)}`, { nota_cucina: req.body.nota_cucina });
      result = { success: true };
    } else if (action === "eliminaOrdine") {
      // S2-1G — route through the transactional delete guard: an active-trip member is
      // refused (409, operator must cancel it instead); a non-member is deleted atomically.
      const del = await riderTrip.deleteOrder(req.body.id);
      return res.status(del.status).json(del.payload);
    } else if (action === "eliminaConversazione") {
      // S2-1H — conversation hard-delete is guarded transactionally because one wa_id can
      // own multiple orders and any one of them may be an active-trip member.
      const del = await riderTrip.deleteConversation(req.body.wa_id);
      return res.status(del.status).json(del.payload);
    } else if (action === "upsertCliente") {
      // Upsert cliente (preferito). Match per id se passato, altrimenti per alias (UPPER) o tel.
      // Ritorna sempre l'id finale, così il frontend può attaccarlo a createOrden.
      const b = req.body || {};
      const aliasUp = (b.alias || "").trim().toUpperCase();
      const tel = (b.tel || "").trim();
      let existing = null;
      if (b.id) {
        const rows = await sbSelect("clientes", `id=eq.${encodeURIComponent(b.id)}&limit=1`);
        existing = rows?.[0] || null;
      } else if (aliasUp) {
        const rows = await sbSelect("clientes", `alias=ilike.${encodeURIComponent(aliasUp)}&limit=1`);
        existing = rows?.[0] || null;
      } else if (tel) {
        const rows = await sbSelect("clientes", `tel=eq.${encodeURIComponent(tel)}&limit=1`);
        existing = rows?.[0] || null;
      }
      const patch = {
        alias:          aliasUp || existing?.alias || null,
        nombre:         b.nombre || existing?.nombre || aliasUp || "",
        tel:            tel || existing?.tel || null,
        direccion:      b.direccion ?? existing?.direccion ?? null,
        direccion_note: b.direccion_note ?? existing?.direccion_note ?? null,
        zona:           b.zona ?? existing?.zona ?? null,
        zona_lat:       b.zona_lat ?? existing?.zona_lat ?? null,
        zona_lon:       b.zona_lon ?? existing?.zona_lon ?? null,
        preferito:      b.preferito !== false
      };
      if (existing) {
        await sbUpdate("clientes", `id=eq.${existing.id}`, patch);
        result = { success: true, id: existing.id };
      } else {
        const ins = await sbInsert("clientes", patch);
        const newId = Array.isArray(ins) ? ins[0]?.id : ins?.id;
        result = { success: true, id: newId };
      }
    } else if (action === "parseOrdineDaRisposta") {
      result = { success: true };
    } else if (action === "createManualGiro") {
      // DELIVERY-MANUAL-GIRO-01: body { order_ids: ["#A","#B",...],
      //   hora_ref?: "HH:MM" (orario operativo / uscita forno del giro),
      //   anchor_order_id?: "#A" (provenienza scelta, audit),
      //   entrega_ref?: "HH:MM" (target consegna/giro scelto dall'operatore) }.
      // Returns { ok, giro:{id,seq,hora_ref,anchor_order_id,entrega_ref,...,order_ids}, moved_from }
      // or { ok:false, error }.
      result = await createManualGiro(
        req.body.order_ids,
        req.body.hora_ref ?? null,
        req.body.anchor_order_id ?? null,
        req.body.entrega_ref ?? null
      );
    } else if (action === "addOrderToManualGiro") {
      // body { giro_id, order_id }
      result = await addOrderToManualGiro(req.body.giro_id, req.body.order_id);
    } else if (action === "removeOrderFromManualGiro") {
      // body { order_id }. Triggers auto-dissolve on prev giro when <2 active remain.
      result = await removeOrderFromManualGiro(req.body.order_id);
    } else if (action === "dissolveManualGiro") {
      // body { giro_id }. Detaches all members and soft-dissolves the giro.
      result = await dissolveManualGiro(req.body.giro_id);
    } else {
      result = { error: "unknown action: " + action };
    }

    res.json(result);
  } catch (e) {
    const status = e && e.httpStatus ? e.httpStatus : 500;
    if (status >= 500) console.error("API POST error:", e);
    res.status(status).json({ error: status === 400 ? e.message : "read failed" });
  }
});

// Health check
app.get("/health", (_, res) => res.json({ ok: true, ts: Date.now() }));

// Boot time marker per `/version` (uptime e diagnostica deploy live).
const BOOT_TIME = Date.now();

// Endpoint diagnostica: espone commit/branch/deploy live di Railway senza segreti.
// Whitelist esplicita dei campi — MAI process.env completo, MAI token/key.
app.get("/version", (_, res) => {
  // RAILWAY_GIT_COMMIT_SHA is only populated for git-linked deploys. Staging is
  // deployed with `railway up` from a local tree, so it was always "unknown" —
  // which is precisely why the S2-7D6A audit could not prove what was running.
  // DEPLOY_COMMIT_SHA is set as a service variable at deploy time so the live
  // build can always be identified. It is evidence, never a code path.
  const sha = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.DEPLOY_COMMIT_SHA || "unknown";
  res.json({
    ok: true,
    service: process.env.RAILWAY_SERVICE_NAME || "ladieci-bot",
    env: process.env.RAILWAY_ENVIRONMENT_NAME || process.env.NODE_ENV || "unknown",
    commit: sha === "unknown" ? "unknown" : sha.slice(0, 7),
    commitFull: sha,
    branch: process.env.RAILWAY_GIT_BRANCH || "unknown",
    deploymentId: process.env.RAILWAY_DEPLOYMENT_ID || "unknown",
    version: process.env.npm_package_version || "unknown",
    bootTime: new Date(BOOT_TIME).toISOString(),
    uptimeSec: Math.floor((Date.now() - BOOT_TIME) / 1000),
  });
});

// ── /status (OPS-HEALTH-01-BE-MIN) ──────────────────────────────
// Endpoint operativo: aggregate read-only su Supabase per fornire
// all'operatore un colpo d'occhio sulla salute del servizio. Whitelist
// esplicita dei campi — niente segreti, niente payload utenti, solo
// timestamp/conteggi. Cache 5s in-memory + timeout 1s sulle query DB
// per non martellare e per non bloccare in caso di Supabase lento.
let STATUS_CACHE = { ts: 0, payload: null };
const STATUS_CACHE_MS = 5000;
const STATUS_DB_TIMEOUT_MS = 1000;

function _withTimeout(p, ms, label) {
  return new Promise((resolve, reject) => {
    const tid = setTimeout(() => reject(new Error(label)), ms);
    Promise.resolve(p).then(
      v => { clearTimeout(tid); resolve(v); },
      e => { clearTimeout(tid); reject(e); }
    );
  });
}

function _ageMinFromIso(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 60000);
}

function _levelFromAge(ageMin, greenMax = 60) {
  if (ageMin == null) return "yellow";
  return ageMin <= greenMax ? "green" : "yellow";
}

function _worstLevel(levels) {
  if (levels.includes("red")) return "red";
  if (levels.includes("yellow")) return "yellow";
  return "green";
}

async function _loadStatusChecks() {
  const todayUtcMidnight = new Date(new Date().setUTCHours(0, 0, 0, 0)).toISOString();
  let dbCheck = { ok: false, level: "red", latencyMs: null };
  let waIn = { lastAt: null, ageMin: null, level: "yellow" };
  let waProc = { lastAt: null, ageMin: null, level: "yellow" };
  let ordini = { lastCreatedAt: null, todayCount: 0, level: "green" };
  // S4 — migration-authority block (MESA_REMEDIATION_PLAN_FINAL_V2_1_2_2026-08-15.md
  // §15): "yellow when only unverified bootstrap rows exist, red on any missing
  // required or checksum mismatch." SHADOW FIX (§15: "the boot check logs both
  // heads for one full service before /status reports on them"): until a
  // genuine post-boot service closes, this returns only the non-consuming
  // { phase: "shadow" } marker (see migrationAuthority.js) — never the real
  // heads, and (below) never a level that could influence overall _worstLevel.
  // Once shadow completes, a read failure degrades to red exactly as before,
  // matching dbCheck's own fail-closed shape.
  let migrations = { phase: "shadow" };
  try {
    const m = await _withTimeout(getMigrationStatusForStatusEndpoint(new Date(BOOT_TIME).toISOString()), STATUS_DB_TIMEOUT_MS, "migrations_timeout");
    migrations = { ...m };
  } catch (e) {
    migrations = { level: "red", headVerified: null, headRecorded: null, unverifiedCount: null, missingRequired: null, checksumMismatches: null, error: String(e?.message || e).slice(0, 80) };
  }

  const t0 = Date.now();
  try {
    const [waInRows, waProcRows, ordTodayRows] = await _withTimeout(
      Promise.all([
        sbSelect("wa_msgs", "order=ts.desc&limit=1"),
        sbSelect("wa_msgs", "stato=in.(IN_TRATTAMENTO,COMPLETATO)&order=ts.desc&limit=1"),
        sbSelect("ordenes", `created_at=gte.${encodeURIComponent(todayUtcMidnight)}&order=created_at.desc&limit=200`),
      ]),
      STATUS_DB_TIMEOUT_MS,
      "db_timeout"
    );
    dbCheck = { ok: true, level: "green", latencyMs: Date.now() - t0 };

    if (Array.isArray(waInRows) && waInRows[0]?.ts) {
      const iso = new Date(Number(waInRows[0].ts)).toISOString();
      const a = _ageMinFromIso(iso);
      waIn = { lastAt: iso, ageMin: a, level: _levelFromAge(a) };
    }
    if (Array.isArray(waProcRows) && waProcRows[0]?.ts) {
      const iso = new Date(Number(waProcRows[0].ts)).toISOString();
      const a = _ageMinFromIso(iso);
      waProc = { lastAt: iso, ageMin: a, level: _levelFromAge(a) };
    }
    if (Array.isArray(ordTodayRows)) {
      ordini.todayCount = ordTodayRows.length;
      ordini.lastCreatedAt = ordTodayRows[0]?.created_at || null;
      // todayCount=0 in mattina/post-chiusura non è un'emergenza → resta green.
      ordini.level = "green";
    }
  } catch (e) {
    dbCheck = {
      ok: false,
      level: "red",
      latencyMs: Date.now() - t0,
      error: String(e?.message || e).slice(0, 80),
    };
  }

  // language-guard: allow-legacy `ordini` below is the pre-existing local variable declared above in this same function (not introduced by S4); touched only to append the new `migrations` field alongside it
  return { dbCheck, waIn, waProc, ordini, migrations };
}

app.get("/status", async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const now = Date.now();
  if (STATUS_CACHE.payload && now - STATUS_CACHE.ts < STATUS_CACHE_MS) {
    return res.json(STATUS_CACHE.payload);
  }
  const sha = process.env.RAILWAY_GIT_COMMIT_SHA || "unknown";
  const commit = sha === "unknown" ? "unknown" : sha.slice(0, 7);
  const backend = { ok: true, level: "green" };
  try {
    // language-guard: allow-legacy `ordini` below is the pre-existing destructured field from _loadStatusChecks (not introduced by S4); touched only to also destructure the new `migrations` field
    const { dbCheck, waIn, waProc, ordini, migrations } = await _loadStatusChecks();
    // language-guard: allow-legacy `ordini` below is the pre-existing level fed into _worstLevel (not introduced by S4); touched only to also fold in migrations.level once shadow has completed
    const levels = [backend.level, dbCheck.level, waIn.level, waProc.level, ordini.level];
    // §15 SHADOW: during the shadow phase migrations has no `level` at all (only
    // { phase: "shadow" }) -- it must never influence overall, not even
    // incidentally via an undefined array entry, so it is omitted outright
    // rather than pushed and relied on to no-op.
    if (migrations.phase !== "shadow") levels.push(migrations.level);
    const overall = _worstLevel(levels);
    const payload = {
      ok: overall !== "red",
      level: overall,
      service: process.env.RAILWAY_SERVICE_NAME || "ladieci-bot",
      commit,
      uptimeSec: Math.floor((Date.now() - BOOT_TIME) / 1000),
      checks: {
        backend,
        database: dbCheck,
        whatsappInbound: waIn,
        whatsappProcessed: waProc,
        ordini,
        migrations,
      },
      checkedAt: new Date().toISOString(),
    };
    STATUS_CACHE = { ts: now, payload };
    res.json(payload);
  } catch (e) {
    // Fallback estremo: anche se loadStatusChecks lancia (non dovrebbe — gestisce
    // internamente), restituiamo JSON valido con level=red.
    res.json({
      ok: false,
      level: "red",
      service: process.env.RAILWAY_SERVICE_NAME || "ladieci-bot",
      commit,
      uptimeSec: Math.floor((Date.now() - BOOT_TIME) / 1000),
      checks: {
        backend: { ok: false, level: "red", error: String(e?.message || e).slice(0, 80) },
      },
      checkedAt: new Date().toISOString(),
    });
  }
});

// Start the server + schedulers ONLY when run as the process entrypoint. When the module
// is required (e.g. offline integration tests), it exports `app` without listening, opening
// no port and triggering no scheduled DB work. Production startup semantics are unchanged.
if (require.main === module) {
  app.listen(PORT, () => console.log(`La Dieci Bot running on port ${PORT}`));
  // S4 boot check (§15 SHADOW): log both migration heads once at boot, ahead of
  // /status's own reporting of them, so an operator can compare boot-log evidence
  // against the dashboard before trusting it live. Never throws into the boot path —
  // a read failure here must not prevent the server from starting.
  getMigrationStatus()
    .then(m => console.log(`[S4 boot check] migration heads: verified=${m.headVerified} recorded=${m.headRecorded} unverified=${m.unverifiedCount} level=${m.level}`))
    .catch(e => console.error(`[S4 boot check] migration status read failed: ${String(e?.message || e).slice(0, 200)}`));
}

// ─── CRON AUTOMATICO: backup preventivo (ora di Madrid) ─────────────────────
function msUntilMadridHM(h, m) {
  const now = new Date();
  const madridNow = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Madrid" }));
  const target = new Date(madridNow);
  target.setHours(h, m, 0, 0);
  if (madridNow >= target) target.setDate(target.getDate() + 1);
  return target - madridNow;
}

// 23:40 — backup preventivo prima della chiusura
function schedula2340() {
  const delay = msUntilMadridHM(23, 40);
  console.log(`[cron 23:40] prossimo backup tra ${Math.round(delay / 60000)} minuti`);
  setTimeout(async () => {
    try {
      console.log("[cron 23:40] Backup pre-chiusura...");
      const res = await backupSerata();
      console.log("[cron 23:40] backup:", JSON.stringify(res));
    } catch (e) {
      console.error("[cron 23:40] errore:", e);
    }
    schedula2340();
  }, delay);
}

// N-2 — the automatic close-tick, boot catch-up, external-cron backup, and
// bounded deferred-close retry that used to live here (behind the retired
// LEGACY_AUTOMATIC_LIFECYCLE_ENABLED flag) are deleted, not frozen: every
// close now goes through V3 Finalizar (operator, manual) — see
// src/serviceSessions/serviceLifecycleEngine.js. O-4 (ledger 108) retired the
// other close path this comment used to name (F-10's event-driven
// forgotten-close recovery): O-3 (ledger 107) made an open
// operational_service_v1 unconditional continuity regardless of Business
// Day, which left that recovery path with nothing left to recover from, and
// O-4 deleted it — the raise, the recovery module, and both callers.
if (require.main === module) {
  schedula2340();          // 23:40 preventive backup — kept: useful, and it never
                           // touches session identity or closes the cash session.
}

module.exports = { app };
