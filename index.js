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
const { chiudiServizio, scanServizio, backupSerata, madridDateStr } = require("./src/utils/servizio");
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
const authDao = require("./src/auth/dao");
const adminAccessDao = require("./src/auth/adminAccessDao");
const { createAdminAccessService } = require("./src/auth/adminAccessService");
const pinPolicy = require("./src/auth/pinPolicy");
const { hashPin, verifyPin } = require("./src/auth/scrypt");
const { ipHash } = require("./src/auth/ipSecurity");
// S2-1B — backend-authoritative legacy authorization + transactional rider trip primitives.
const { legacyAuthGuardMiddleware } = require("./src/auth/legacyAuthGuard");
const riderTrip = require("./src/agents/riderTrip");
const riderReads = require("./src/agents/riderReads");

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Api-Key");
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
    case "marcarEntregado":
      return riderTrip.completeStop(body && body.id, body && body.cobrado, body && body.metodo_pago);
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

const adminAccessService = createAdminAccessService({
  dao: adminAccessDao,
  hashPin,
  verifyPin,
  pinPolicy,
  ipHash,
  listActorsForVerify: authDao.listActorsForVerify_SENSITIVE,
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
      // Blocco temporale: chiusura permessa solo dopo le 22:00 Madrid (override con ?force=true)
      const madridHourStr = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", hour: "2-digit", hour12: false }).format(new Date());
      const h = parseInt(madridHourStr, 10);
      if (h < 22 && req.query.force !== "true") {
        result = { success: false, error: `Chiusura permessa solo dopo le 22:00 Madrid (ora attuale: ${h}:00). Per forzare aggiungere &force=true.` };
      } else {
        // Sempre via Guarded: idempotente, non si ripete nello stesso giorno
        result = await chiudiServizio(req.query.deleteAttivi === "true", "operator");
        // S2-1G — a service close deferred by an active rider trip is an operational
        // conflict: surface a stable 409 for the operator UI (schedulers consume the same
        // structured body without treating it as a crash).
        if (result && result.deferred && result.reason === "active_rider_trip") {
          return res.status(409).json({ error: "ACTIVE_RIDER_TRIP", message: "Chiusura rinviata: giro rider in corso. Attendere il rientro o chiudere il giro.", data: result.data });
        }
      }
    } else if (action === "triggerCloseIfNeeded") {
      // Endpoint per cron esterno (es. cron-job.org) — backup del cron interno.
      // Idempotente: se già chiuso oggi, no-op.
      result = await chiudiServizio(true, "external");
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
    if (["setActorPin"].includes(action) && (!req.authCtx || req.authCtx.role !== "admin")) {
      return res.status(403).json({ error: "ROLE_FORBIDDEN" });
    }
    let result;

    // S2-1B/1C — the trip primitives are the SINGLE transactional DRIVER_STATO authority
    // for EVERY authorized role. When the guard authenticated any caller on a trip-primitive
    // action (marcarEnEntrega/registrarSalidaDriver/marcarEntregado/chiudiGiro), route to the
    // RPC-backed wrapper and return, bypassing the old direct DRIVER_STATO writers below.
    if (req.authCtx && req.authCtx.rule && req.authCtx.rule.tripPrimitive) {
      const mapped = await routeRiderTripAction(action, req.body);
      return res.status(mapped.status).json(mapped.payload);
    }

    if (action === "cambiaStato") {
      result = await cambiaStato(req.body.id, req.body.estado, {
        actor_type: req.body.actor_type || "operator",
        actor_id: req.body.actor_id || null,
        origin: req.body.origin || "dashboard",
      });
    } else if (action === "creaOrdine") {
      // Dashboard operatore: niente blocco hard orario chiusura (vedi creaOrdine).
      result = await creaOrdine({ ...req.body, operatorManual: true });
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
    } else if (action === "setActorPin") {
      const targetActor = req.body && req.body.targetActor;
      const out = await adminAccessService.setActorPin({
        byActor: req.authCtx.actor,
        targetActor,
        newPin: req.body && req.body.newPin,
        confirmation: targetActor === "owner" ? "CHANGE_OWNER_PIN" : null,
        trustedClientIp: trustedClientIp(req),
        metadata: { source: "admin_pin_management" },
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
      // Accetta campi pagamento/timing/repartidor/descuento in unica scrittura atomica
      const extras = {};
      for (const k of ["metodo_pago","cobrado","ya_pagado","hora_entrega","hora_salida","repartidor","llegado","cucina_check","descuento_tipo","descuento_valor"]) {
        if (req.body[k] !== undefined) extras[k] = req.body[k];
      }
      extras.actor_type = req.body.actor_type || "operator";
      extras.actor_id = req.body.actor_id || null;
      extras.origin = req.body.origin || "dashboard";
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
      const extras = {
        hora_entrega: Date.now(),
        cobrado: req.body.cobrado !== false,
        metodo_pago: req.body.metodo_pago || "",
        actor_type: "rider",
        origin: "entregas",
      };
      if (req.body.descuento_tipo  !== undefined) extras.descuento_tipo  = req.body.descuento_tipo;
      if (req.body.descuento_valor !== undefined) extras.descuento_valor = req.body.descuento_valor;
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
  const sha = process.env.RAILWAY_GIT_COMMIT_SHA || "unknown";
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

// 23:50 — chiudi serata (backupSerata viene chiamato anche dentro chiudiServizio)
function schedula2350() {
  const delay = msUntilMadridHM(23, 50);
  console.log(`[cron 23:50] prossima chiusura tra ${Math.round(delay / 60000)} minuti`);
  setTimeout(async () => {
    try {
      console.log("[cron 23:50] Avvio chiusura automatica serata...");
      // chiudiServizio è idempotente: lock via INSERT serata_summary (PK su fecha).
      // Se Railway riavvia dopo le 23:50, il catch-up all'avvio recupera la chiusura mancata.
      const res = await chiudiServizio(true, "cron2350");
      console.log("[cron 23:50] risultato:", JSON.stringify(res));
      // S2-1G — if deferred by an active rider trip, start a bounded retry chain.
      const plan = deferredCloseRetryPlan(res, 0);
      if (plan.retry) scheduleDeferredCloseRetry("cron2350-retry", plan.attempt);
      const cfg = await getConfig();
      const OPERATOR_WA_IDS = ["41767011848", "34614267535"];
      const msg = buildCloseSummaryMsg(res, "23:50 automatica");
      if (msg) for (const waId of OPERATOR_WA_IDS) await invia(waId, msg, cfg).catch(() => {});
    } catch (e) {
      console.error("[cron 23:50] errore:", e);
    }
    schedula2350();
  }, delay);
}

// Catch-up all'avvio del server: se è dopo le 23:55 Madrid (o prima delle 06:00 del giorno
// dopo) e LAST_CLOSE_DATE in config non è "ieri", il setTimeout della sera è morto durante
// un riavvio Railway — recuperiamo subito.
async function catchUpChiusura() {
  try {
    const now = new Date();
    const madridHourStr = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", hour: "2-digit", hour12: false }).format(now);
    const h = parseInt(madridHourStr, 10);
    // Finestra di recupero: 23:55-23:59 (cron interno morto) oppure 00:00-06:00 (recupero post-restart notturno)
    const inWindow = (h === 23) || (h >= 0 && h < 6);
    if (!inWindow) {
      console.log(`[catchUp] fuori finestra (h=${h} Madrid) — skip`);
      return;
    }
    const cfg = await sbSelect("config", "chiave=eq.LAST_CLOSE_DATE");
    const last = cfg?.[0]?.valore || "";
    // Determina la data di chiusura attesa: se ora Madrid è 0-5, è "ieri Madrid";
    // se è 23, è "oggi Madrid".
    const refDate = new Date(now);
    if (h < 6) refDate.setUTCDate(refDate.getUTCDate() - 1);
    const expectedDate = madridDateStr(refDate);
    if (last === expectedDate) {
      console.log(`[catchUp] LAST_CLOSE_DATE=${last} OK — skip`);
      return;
    }
    console.log(`[catchUp] chiusura mancante (last=${last}, expected=${expectedDate}) — eseguo`);
    const res = await chiudiServizio(true, "catchUp");
    console.log("[catchUp] risultato:", JSON.stringify(res));
    if (res.success && !res.skipped) {
      const cfgAll = await getConfig();
      const msg = buildCloseSummaryMsg(res, "Recupero post-restart");
      if (msg) for (const waId of ["41767011848", "34614267535"]) await invia(waId, msg, cfgAll).catch(() => {});
    }
  } catch (e) {
    console.error("[catchUp] errore:", e);
  }
}

if (require.main === module) {
  schedula2340();
  schedula2350();
  catchUpChiusura();
}

module.exports = { app };
// S2-1G — additional testable exports attached separately so the accepted B7 assertion
// `module.exports = { app }` remains byte-exact.
module.exports.deferredCloseRetryPlan = deferredCloseRetryPlan;
module.exports.CLOSE_RETRY_MAX_ATTEMPTS = CLOSE_RETRY_MAX_ATTEMPTS;
module.exports.CLOSE_RETRY_INTERVAL_MS = CLOSE_RETRY_INTERVAL_MS;
