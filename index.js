require("dotenv").config();
const express = require("express");
const { processWebhook } = require("./src/agents/orchestrator");
const { getConfig, sbSelect, sbUpdate, sbDelete, sbUpsert, sbInsert } = require("./src/utils/supabase");
const { cambiaStato, creaOrdine, modificaOrdine } = require("./src/agents/agentOrdini");
// DRIVER_STATO = telemetria visiva opzionale (best-effort). getDriverStatus per la
// UI, closeGiroInternal condiviso col legacy chiudiGiro (idempotente).
const { getDriverStatus, closeGiroInternal } = require("./src/utils/driverTelemetry");
// Private authenticated READ contracts (P0 containment). Fixed per-action queries;
// no generic table access. Reachable only behind the shared X-Api-Key (trusted proxy).
const readActions = require("./src/utils/readActions");
const { previewOrderTiming } = require("./src/agents/previewTiming");
const { invia, emitDynamicMenuShadowDiagnostic } = require("./src/agents/agentWhatsapp");
const { runWhatsappMenuShadow } = require("./src/menu/whatsappMenuShadow");
const { chiudiServizio, scanServizio, backupSerata } = require("./src/utils/servizio");
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
// A real collection is one of the three canonical methods. Markers like "manual" (the
// "Driver volvió" operator override) are NOT payments and must not enter the ledger nor
// be blocked by it — they keep the pre-existing legacy behaviour untouched.
const isCollectionMethod = (m) => typeof m === "string" && PAYMENT_METHODS.has(m.trim().toLowerCase());
// S2-1B — backend-authoritative legacy authorization + transactional rider trip primitives.
const { legacyAuthGuardMiddleware } = require("./src/auth/legacyAuthGuard");
const riderTrip = require("./src/agents/riderTrip");
const riderReads = require("./src/agents/riderReads");
const { getCurrentServiceCloseout } = require("./src/closeout/currentServiceCloseout");
const { lifecycle: serviceSessionLifecycle } = require("./src/serviceSessions/serviceSessionLifecycle");
const { ensureCurrentServiceSession } = require("./src/serviceSessions/ensureServiceSession");
const { resolveSchedule, closeEligibility, SCHEDULE_STATE, SERVICE_KIND } = require("./src/schedule/serviceSchedule");
const { computeAutoCloseDecision } = require("./src/serviceSessions/autoCloseDecision");
const { hasPendingOperationalActivity } = require("./src/serviceSessions/pendingActivityGuard");

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

async function readShadowPreviewOrders(table, query) {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!base || !key) throw new Error("supabase_env_missing");
  const res = await fetch(`${base}/rest/v1/${table}?${query}`, {
    method: "GET",
    headers: { apikey: key, Authorization: "Bearer " + key },
  });
  if (!res.ok) throw new Error(`shadow_preview_read_failed_${res.status}`);
  const text = await res.text();
  try { return JSON.parse(text); } catch { return []; }
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
    const cfg = await getConfig();
    let result;

    // S2-1C — rider-scoped reads. When the guard authenticated a rider, the backend (not
    // the client) decides visibility from the active-trip snapshot. Operator/admin fall
    // through to the unchanged handlers below.
    // NB: uses .includes() (not the router equality form) so it does not add duplicate
    // router-action literals that the authorization-contract coverage test counts.
    if (req.authCtx && req.authCtx.role === "rider" &&
        ["getOrdenes", "getManualGiros"].includes(action)) {
      const deps = { sbSelect };
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
      result = await sbSelect("ordenes", "estado=not.in.(RETIRADO,COMPLETADO,COMPLETATO)&order=ts.asc");
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
      const gate = closeEligibility(kind, new Date());
      if (!gate.eligible && req.query.force !== "true") {
        const label = kind || "servicio";
        result = { success: false, error: `Cierre de ${label} permitido solo a partir de las ${gate.boundary} Madrid. Para forzar añadir &force=true.` };
      } else {
        // Sempre via Guarded: idempotente, non si ripete nello stesso giorno
        result = await chiudiServizio(req.query.deleteAttivi === "true", "operator", req.authCtx?.actor || "operator");
        // S2-1G — a service close deferred by an active rider trip is an operational
        // conflict: surface a stable 409 for the operator UI (schedulers consume the same
        // structured body without treating it as a crash).
        if (result && result.deferred && result.reason === "active_rider_trip") {
          return res.status(409).json({ error: "ACTIVE_RIDER_TRIP", message: "Chiusura rinviata: giro rider in corso. Attendere il rientro o chiudere il giro.", data: result.data });
        }
      }
    } else if (action === "triggerCloseIfNeeded") {
      // Endpoint per cron esterno (es. cron-job.org) — backup del cron interno.
      // S2-7D6D — passa dallo STESSO motore di decisione del tick/boot: mai un
      // force-close implicito se pingato fuori finestra (es. a metà pranzo).
      const identity = await serviceSessionLifecycle.currentCloseout();
      if (!identity?.ok || identity.code === "NO_SERVICE_SESSION" || !identity.session || identity.session.status === "closed") {
        result = { success: true, skipped: true, reason: "no_active_session" };
      } else {
        const decision = computeAutoCloseDecision({ now: new Date(), session: identity.session });
        if (!decision.due) {
          result = { success: true, skipped: true, reason: decision.reason || "not_due" };
        } else {
          const activity = await hasPendingOperationalActivity({ sessionId: identity.session.id });
          result = activity.pending
            ? { success: true, skipped: true, reason: "pending_orders" }
            : await chiudiServizio(true, "external");
        }
      }
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
      const ensured = await ensureCurrentServiceSession({ actor: actorId, source: "auto_entry" });
      // A non-success here is almost never a crash: "we are in the 17:30-18:00
      // buffer" and "lunch is still open" are legitimate answers the UI renders
      // differently. 200 carries them; only a genuine failure is a 5xx.
      if (ensured.success) return res.json(ensured);
      const conflict = ensured.code === "LUNCH_SESSION_STILL_ACTIVE"
        || ensured.code === "OTHER_SERVICE_STILL_ACTIVE"
        || ensured.code === "SERVICE_SESSION_CLOSING";
      return res.status(conflict ? 409 : 200).json(ensured);
    }

    if (action === "openServiceSession") {
      // Manual RECOVERY only. It no longer opens a kind-less session (the SQL
      // opener fail-closes): it goes through the same ensure contract so a
      // recovery can never create a service the accounting cannot attribute.
      const actorId = req.authCtx?.actor;
      if (!actorId) return res.status(401).json({ error: "UNVERIFIED_ACTOR" });
      const ensured = await ensureCurrentServiceSession({ actor: actorId, source: "manual_recovery" });
      if (!ensured.success) return res.status(409).json({ error: ensured.code || "SERVICE_SESSION_OPEN_FAILED", detail: ensured });
      result = { ok: true, ...ensured };
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
      result = await creaOrdine({ ...req.body, actor_id: req.authCtx?.actor || null, operatorManual: true });
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

      // S2-7D6E — money first, state second. A RETIRADO carrying a payment method is a
      // COLLECTION: it must produce a ledger event before the order is allowed to move.
      // If the ledger refuses, we do NOT transition — a false "retired & paid" is exactly
      // the defect this replaces. The operator sees the code and retries; the key is
      // deterministic, so the retry replays instead of double-charging.
      const collecting = String(req.body.estado || "") === "RETIRADO"
        && isCollectionMethod(extras.metodo_pago);
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
    } else if (action === "createOrden") {
      const d = req.body.data || req.body;
      if (!d.waId && d.wa_id) d.waId = d.wa_id;
      // Dashboard operatore: niente blocco hard orario chiusura (vedi creaOrdine).
      result = await creaOrdine({ ...d, operatorManual: true });
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

  return { dbCheck, waIn, waProc, ordini };
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
    const { dbCheck, waIn, waProc, ordini } = await _loadStatusChecks();
    const overall = _worstLevel([backend.level, dbCheck.level, waIn.level, waProc.level, ordini.level]);
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
}

// ─── Messaggio operatore di fine chiusura (summary completa) ────────────────
function buildCloseSummaryMsg(res, ctx) {
  if (res?.skipped) return null;
  if (!res?.success) {
    return `⚠️ *Chiusura ${ctx} — ERRORE*\n\n${res?.error || "fallita"}\n\n${JSON.stringify(res?.details || res).slice(0, 400)}\n\nIl backup raw è in backup_serata, nessun dato perso. Riprova manualmente.`;
  }
  const s = res.summary || {};
  const eur = n => `${(Number(n)||0).toFixed(2)}€`;
  const cassaLines = [];
  if (s.cassa_efectivo > 0)        cassaLines.push(`  💵 Efectivo  ${eur(s.cassa_efectivo)}`);
  if (s.cassa_tarjeta > 0)         cassaLines.push(`  💳 Tarjeta   ${eur(s.cassa_tarjeta)}`);
  if (s.cassa_bizum > 0)           cassaLines.push(`  📱 Bizum     ${eur(s.cassa_bizum)}`);
  if (s.cassa_non_specificato > 0) cassaLines.push(`  ❓ Non spec. ${eur(s.cassa_non_specificato)}`);
  const zonaLines = Object.entries(s.per_zona || {}).map(([z, v]) => `  ${z}: ${v.n}× · ${eur(v.eur)}`);
  return [
    `🌙 *Serata chiusa* (${ctx})`,
    ``,
    `📊 ${s.n_ordini} ordini · 🍕 ${s.n_pizze} pizze · 🥤 ${s.n_bevande} bevande${s.n_dessert ? ` · 🍰 ${s.n_dessert} dolci` : ""}`,
    `🛵 ${s.n_delivery} delivery · 🏠 ${s.n_ritiro} ritiro`,
    `👥 ${s.n_clienti_unici} clienti${s.n_clienti_nuovi ? ` (${s.n_clienti_nuovi} nuovi)` : ""}`,
    `💬 ${s.n_domande_gestite || 0} domande gestite`,
    ``,
    `💰 *Cassa ${eur(s.cassa_totale)}*` + (s.delivery_fee_totale > 0 ? ` (di cui ${eur(s.delivery_fee_totale)} delivery fee)` : ""),
    ...cassaLines,
    ``,
    zonaLines.length > 0 ? `🗺️ *Per zona:*` : "",
    ...zonaLines,
    ``,
    res.backupOk ? `✅ Backup raw OK` : `⚠️ Backup raw fallito (chiusura comunque OK)`,
    `Buonanotte! 🍕`
  ].filter(Boolean).join("\n");
}

// ─── CRON AUTOMATICO: backup + chiudi serata (ora di Madrid) ────────────────
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

// S2-1G — bounded deferred-close retry. When a scheduled close is deferred by an active
// rider trip, retry on a fixed interval up to a max, so the service does not stay open until
// the next day once the trip finally closes. Pure decision (testable) + a single-timer
// scheduler that never overlaps and never tight-loops.
const CLOSE_RETRY_INTERVAL_MS = 10 * 60 * 1000; // 10 min
const CLOSE_RETRY_MAX_ATTEMPTS = 9;             // ~90 min window after the scheduled close
function deferredCloseRetryPlan(result, attempt) {
  const deferred = !!(result && result.deferred && result.reason === "active_rider_trip");
  if (!deferred) return { retry: false };
  if (attempt >= CLOSE_RETRY_MAX_ATTEMPTS) return { retry: false, reason: "max_attempts" };
  return { retry: true, delayMs: CLOSE_RETRY_INTERVAL_MS, attempt: attempt + 1 };
}
let _closeRetryTimer = null;
function scheduleDeferredCloseRetry(source, attempt) {
  if (_closeRetryTimer) return; // never overlap
  _closeRetryTimer = setTimeout(async () => {
    _closeRetryTimer = null;
    let res;
    try { res = await chiudiServizio(true, source); }
    catch (e) { console.error(`[close-retry ${source}] errore:`, e); return; }
    console.log(`[close-retry ${source}] attempt ${attempt} ->`, JSON.stringify(res));
    const plan = deferredCloseRetryPlan(res, attempt);
    if (plan.retry) scheduleDeferredCloseRetry(source, plan.attempt);
  }, CLOSE_RETRY_INTERVAL_MS);
  if (_closeRetryTimer && _closeRetryTimer.unref) _closeRetryTimer.unref();
}

// ── S2-7D6B — the service close tick ────────────────────────────────────────
// The old cron fired ONCE at 23:50 and force-closed "the evening". That is wrong
// on both ends now: a 23:50 order is a perfectly normal order (intake runs to
// 00:00), and lunch needs its own close from 17:30 with no evening cron in
// sight. So instead of two hardcoded alarms there is one periodic tick that asks
// the schedule and the live session what is due.
//
// It never forces anything. chiudiServizio remains the ONE close implementation:
// the active-rider-trip gate, the archive/verify contract and the idempotent
// lifecycle are all unchanged and are the reason this can safely run on a timer.
const CLOSE_TICK_INTERVAL_MS = 10 * 60 * 1000;

async function serviceCloseTick() {
  let identity;
  try { identity = await serviceSessionLifecycle.currentCloseout(); }
  catch (e) { console.error("[close-tick] identity read failed:", e?.message || e); return; }
  if (!identity?.ok || identity.code === "NO_SERVICE_SESSION") return;
  const session = identity.session;
  if (!session || session.status === "closed") return;

  const decision = computeAutoCloseDecision({ now: new Date(), session });
  if (!decision.due) return;

  // S2-7D6D — a pending non-terminal order blocks an AUTOMATIC close exactly like an
  // active rider trip does; chiudiServizio's own trip gate is unchanged and still runs,
  // this just stops the timer from ever reaching a force-archive of live kitchen/delivery
  // work in the first place.
  const activity = await hasPendingOperationalActivity({ sessionId: session.id });
  if (activity.pending) {
    console.log(`[close-tick] ${decision.kind} session ${session.id} has pending orders — skip (no force-close)`);
    return;
  }

  if (decision.escalate) {
    // Past 04:00 with a live service: the operator must know. We do NOT skip the
    // close attempt, but we never let it silently destroy in-flight work either
    // — the rider gate inside chiudiServizio still defers if a trip is open.
    console.error(`[close-tick] ESCALATION — ${decision.kind} session ${session.id} still active past 04:00 Madrid`);
  }

  console.log(`[close-tick] closing ${decision.kind} session ${session.id} (${decision.source})`);
  let res;
  try { res = await chiudiServizio(true, decision.source); }
  catch (e) { console.error(`[close-tick ${decision.source}] errore:`, e); return; }
  console.log(`[close-tick ${decision.source}] risultato:`, JSON.stringify(res));

  const plan = deferredCloseRetryPlan(res, 0);
  if (plan.retry) scheduleDeferredCloseRetry(`${decision.source}-retry`, plan.attempt);

  if (res && res.success) {
    try {
      const cfg = await getConfig();
      const msg = buildCloseSummaryMsg(res, `${decision.kind} automática`);
      if (msg) for (const waId of ["41767011848", "34614267535"]) await invia(waId, msg, cfg).catch(() => {});
    } catch (_) { /* notification is best-effort, never blocks the close */ }
  }
}

function schedulaCloseTick() {
  const t = setInterval(() => { serviceCloseTick().catch((e) => console.error("[close-tick]", e)); }, CLOSE_TICK_INTERVAL_MS);
  if (t.unref) t.unref();
  console.log(`[close-tick] attivo — verifica ogni ${CLOSE_TICK_INTERVAL_MS / 60000} minuti (PRANZO da 17:30, SERA da 00:00)`);
  return t;
}

// Catch-up all'avvio del server — S2-7D6D. Il vecchio catch-up ragionava solo su una
// finestra oraria fissa (23:00-05:59) e sul marker LAST_CLOSE_DATE, che è scritto SOLO
// dalle chiusure SERA (servizio.js chiudiServizio) — un PRANZO rimasto aperto a riavvio
// non veniva mai recuperato al boot, solo dal tick periodico (fino a ~10 min di ritardo).
// Ora usa lo STESSO motore di decisione del tick (computeAutoCloseDecision), letto sulla
// sessione realmente attiva: kind-agnostic, nessuna finestra oraria ad hoc, nessun
// force-close implicito (chiudiServizio resta l'unica implementazione, con lo stesso
// gate rider-trip e la stessa idempotenza).
async function catchUpChiusura() {
  try {
    let identity;
    try { identity = await serviceSessionLifecycle.currentCloseout(); }
    catch (e) { console.error("[catchUp] identity read failed:", e?.message || e); return; }
    if (!identity?.ok || identity.code === "NO_SERVICE_SESSION") {
      console.log("[catchUp] nessuna sessione attiva — skip");
      return;
    }
    const session = identity.session;
    if (!session || session.status === "closed") {
      console.log("[catchUp] sessione già chiusa — skip");
      return;
    }

    const decision = computeAutoCloseDecision({ now: new Date(), session });
    if (!decision.due) {
      console.log(`[catchUp] non ancora dovuta (${decision.reason || "n/a"}) — skip`);
      return;
    }

    const activity = await hasPendingOperationalActivity({ sessionId: session.id });
    if (activity.pending) {
      console.log(`[catchUp] ${decision.kind} session ${session.id} ha ordini pendenti — skip (no force-close)`);
      return;
    }

    if (decision.escalate) {
      console.error(`[catchUp] ESCALATION — ${decision.kind} session ${session.id} ancora attiva oltre le 04:00 Madrid al riavvio`);
    }

    console.log(`[catchUp] chiusura mancante — chiudo ${decision.kind} session ${session.id} (boot recovery)`);
    const res = await chiudiServizio(true, "catchUp");
    console.log("[catchUp] risultato:", JSON.stringify(res));

    const plan = deferredCloseRetryPlan(res, 0);
    if (plan.retry) scheduleDeferredCloseRetry("catchUp-retry", plan.attempt);

    if (res && res.success && !res.skipped) {
      const cfgAll = await getConfig();
      const msg = buildCloseSummaryMsg(res, "Recupero post-restart");
      if (msg) for (const waId of ["41767011848", "34614267535"]) await invia(waId, msg, cfgAll).catch(() => {});
    }
  } catch (e) {
    console.error("[catchUp] errore:", e);
  }
}

if (require.main === module) {
  schedula2340();          // 23:40 preventive backup — kept: useful, and it never
                           // touches session identity or closes the cash session.
  schedulaCloseTick();     // S2-7D6B — replaces the single 23:50 forced close.
  catchUpChiusura();
}

module.exports = { app };
// S2-1G — additional testable exports attached separately so the accepted B7 assertion
// `module.exports = { app }` remains byte-exact.
module.exports.deferredCloseRetryPlan = deferredCloseRetryPlan;
module.exports.CLOSE_RETRY_MAX_ATTEMPTS = CLOSE_RETRY_MAX_ATTEMPTS;
module.exports.CLOSE_RETRY_INTERVAL_MS = CLOSE_RETRY_INTERVAL_MS;
// S2-7D6D — exported so cron/boot/external parity is provable without a live server:
// serviceCloseTick/catchUpChiusura both delegate their "is it due" decision to the
// same computeAutoCloseDecision (see src/serviceSessions/autoCloseDecision.js); these
// exports let a test drive each trigger end-to-end against a stubbed lifecycle/chiudiServizio.
module.exports.serviceCloseTick = serviceCloseTick;
module.exports.catchUpChiusura = catchUpChiusura;
module.exports.CLOSE_TICK_INTERVAL_MS = CLOSE_TICK_INTERVAL_MS;
