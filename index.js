require("dotenv").config();
const express = require("express");
const { processWebhook } = require("./src/agents/orchestrator");
const { getConfig, sbSelect, sbUpdate, sbDelete, sbUpsert, sbInsert } = require("./src/utils/supabase");
const { cambiaStato, creaOrdine, modificaOrdine } = require("./src/agents/agentOrdini");
// [DELIVERY-REFACTOR 2026-09-22] driverTelemetry rimosso: la telemetria rider
// (DRIVER_STATO, delivery_logs, ETA di rientro) non fa più parte del dominio.
// Private authenticated READ contracts (P0 containment). Fixed per-action queries;
// no generic table access. Reachable only behind the shared X-Api-Key (trusted proxy).
const readActions = require("./src/utils/readActions");
const { previewOrderTiming } = require("./src/agents/previewTiming");
const { invia } = require("./src/agents/agentWhatsapp");
const { chiudiServizio, scanServizio, backupSerata, madridDateStr } = require("./src/utils/servizio");
const { rigeneraSuggerimenti, approvaSuggerimento } = require("./src/agents/agenteMiglioramento");
const {
  getManualGiros,
  createManualGiro,
  addOrderToManualGiro,
  removeOrderFromManualGiro,
  dissolveManualGiro,
} = require("./src/agents/manualGiros");
// [FDV1] Frozen Delivery V1 — dashboard composition layer (deadline, ± block, delete+settle, preview, warnings).
const fdv1 = require("./src/agents/dashboardDelivery");
const { reconcileManualGiros } = require("./src/agents/manualGiros");

// [DELIVERY-REFACTOR 2026-09-22] Attori ammessi nell'audit di stato.
//   rider    = app del repartidor
//   operator = dashboard (Entregas / Listos)
// Un valore assente o fuori whitelist diventa "unknown": meglio un log non
// attribuito che un log attribuito al soggetto sbagliato — prima di questa
// release marcarEnEntrega/marcarEntregado scrivevano "rider" hardcodato anche
// quando a premere era l'operatore.
const ACTOR_TYPES = Object.freeze(["rider", "operator"]);
function normalizeActorType(actorType) {
  const a = String(actorType == null ? "" : actorType).trim().toLowerCase();
  return ACTOR_TYPES.includes(a) ? a : "unknown";
}

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Api-Key");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Auth middleware — protegge tutti gli endpoint /api
const DASHBOARD_API_KEY = process.env.DASHBOARD_API_KEY;
app.use("/api", (req, res, next) => {
  if (!DASHBOARD_API_KEY) return next(); // se non configurata, passa (sviluppo)
  const key = req.headers["x-api-key"] || req.query._k;
  if (key !== DASHBOARD_API_KEY) return res.status(401).json({ error: "unauthorized" });
  next();
});

const WA_VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN || "ladieci_webhook_2026";
const PORT = process.env.PORT || 3000;

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

// [DELIVERY-REFACTOR 2026-09-22] readShadowPreviewOrders rimossa con la rotta shadow-preview.


// [DELIVERY-REFACTOR 2026-09-22 / D-4] Rotta shadow-preview CHIUSA.
// Presentava la simulazione rider (salida_driver_estimada, entrega_estimada,
// retraso, conflicto_driver): campi che da questa release non vengono più
// aggiornati. Lasciarla aperta avrebbe mostrato dati fermi come se fossero vivi.
// I moduli di calcolo restano in src/core/delivery/shadowPreview* con i loro test,
// ma non sono più raggiungibili: vedi DELIVERY_IMPLEMENTATION_RESULT.md.

app.get("/api", async (req, res) => {
  const action = req.query.action;
  try {
    const cfg = await getConfig();
    let result;

    if (action === "getOrdenes") {
      result = await sbSelect("ordenes", "estado=not.in.(RETIRADO,COMPLETADO)&order=ts.asc");
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
    } else if (action === "getManualGiros") {
      // DELIVERY-MANUAL-GIRO-01 P1C.1: list active manual giros for a
      // service day. Default = today (Madrid TZ) and only non-dissolved.
      // ?day=YYYY-MM-DD overrides the day; ?onlyActive=false includes dissolved.
      result = await getManualGiros({
        day: req.query.day,
        onlyActive: req.query.onlyActive !== "false",
      });
    }
    // [DELIVERY-REFACTOR 2026-09-22] action "getDriverStatus" RIMOSSA: nessun
    // chiamante (verificato su FE dashboard e app driver) e nessuna sorgente —
    // DRIVER_STATO non viene più scritta da nessun percorso.
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
    let result;

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
      await sbUpsert("config", { chiave: req.body.chiave, valore: req.body.valore });
      result = { success: true };
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
      // [DELIVERY-REFACTOR 2026-09-22] DEPRECATO: EN_ENTREGA non fa più parte del
      // flusso operativo (POR_CONFIRMAR → EN_COCINA → LISTO → RETIRADO). L'azione
      // resta esposta solo finché il FE di PRODUZIONE (d7816dc) la chiama; nessun
      // nuovo client deve usarla. Rimozione prevista con la dismissione del legacy.
      result = await cambiaStato(req.body.id, "EN_ENTREGA", {
        hora_salida: Date.now(),
        actor_type: normalizeActorType(req.body.actor_type),
        actor_id: req.body.actor_id || null,
        origin: req.body.origin || "entregas",
      });
    } else if (action === "marcarEntregado") {
      // LISTO (o legacy EN_ENTREGA) → RETIRADO — finalizzazione della consegna.
      // [DELIVERY-REFACTOR 2026-09-22] `cobrado` e `metodo_pago` NON si prendono più
      // dal payload: li decide la regola canonica in cambiaStato (finalization.js),
      // che rifiuta la transizione se manca un metodo reale e l'ordine non è pagato.
      // `actor_type`/`origin` arrivano dal chiamante: driver e operatore usano la
      // stessa azione business ma devono restare distinguibili nell'audit.
      const extras = {
        hora_entrega: Date.now(),
        metodo_pago: req.body.metodo_pago,
        actor_type: normalizeActorType(req.body.actor_type),
        actor_id: req.body.actor_id || null,
        origin: req.body.origin || "entregas",
      };
      if (req.body.descuento_tipo  !== undefined) extras.descuento_tipo  = req.body.descuento_tipo;
      if (req.body.descuento_valor !== undefined) extras.descuento_valor = req.body.descuento_valor;
      result = await cambiaStato(req.body.id, "RETIRADO", extras);
    } else if (action === "asignarRepartidor") {
      await sbUpdate("ordenes", `id=eq.${encodeURIComponent(req.body.id)}`, { repartidor: req.body.repartidor || null });
      result = { success: true };
    // [DELIVERY-REFACTOR 2026-09-22] action "registrarSalidaDriver" e "chiudiGiro"
    // RIMOSSE. Scrivevano DRIVER_STATO e delivery_logs per modellare "driver uscito"
    // e "driver rientrato", concetti che il contratto Delivery non prevede più.
    // Dependency proof: zero chiamanti nel FE dashboard e nell'app driver.
    } else if (action === "marcarLlegado") {
      // Cliente arrivato (RITIRO) — segna flag llegado
      await sbUpdate("ordenes", `id=eq.${encodeURIComponent(req.body.id)}`, { llegado: req.body.llegado !== false });
      result = { success: true };
    } else if (action === "priorityContract") {
      // [FDV1 R3] contratto ± letto dal FE (capability): −50..+50, + solo dentro la finestra prima della HORA LÍMITE.
      result = { ok: true, contract: fdv1.PRIORITY_CONTRACT };
    } else if (action === "setUiOffset") {
      // [FDV1 R3] ± priorità di produzione: scrive SOLO ui_offset_min (−50..+50; + solo entro la finestra). Giro → tutto il blocco.
      // Mai deadline / hora / pagamento. Reset naturale a chiudiServizio (ui_offset_min escluso da buildStoricoPayload).
      result = await fdv1.setPriorityOffset(req.body.id, req.body.offset_min);
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
      // [FDV1] delivery_deadline_at (ts + 55') la scrive creaOrdine nella stessa INSERT per ogni nuovo DOMICILIO;
      // `hora` (promessa cliente) passa invariata. Qui solo il giro_intent opzionale dell'operatore.
      result = await fdv1.createOrdenDeliveryV1({ ...d }, { creaOrdine });
    } else if (action === "previewDeliveryV1") {
      // [FDV1] read-only: deadline (now + 55') + suggerimento giro compatibile (zona, deadline ±15', capienza, stato).
      let cfg = {};
      try { cfg = await getConfig(); } catch (_) { cfg = {}; }
      result = await fdv1.previewDeliveryV1(req.body || {}, { cfg });
    } else if (action === "giroWarnings") {
      // [FDV1] read-only: warning fattuali per una composizione di giro (mai bloccanti: l'operatore conferma).
      let cfg = {};
      try { cfg = await getConfig(); } catch (_) { cfg = {}; }
      result = await fdv1.giroWarningsFor(req.body || {}, { cfg });
    } else if (action === "reconcileManualGiros") {
      // [FDV1] self-heal strutturale del dominio giro (una transazione DB, idempotente).
      result = await reconcileManualGiros({ alignOffsets: req.body && req.body.align_offsets !== false });
    } else if (action === "updateNotaCucina") {
      await sbUpdate("ordenes", `id=eq.${encodeURIComponent(req.body.id)}`, { nota_cucina: req.body.nota_cucina });
      result = { success: true };
    } else if (action === "eliminaOrdine") {
      // [FDV1] delete + settle del giro di appartenenza (niente giro monco / anchor stale).
      result = await fdv1.deleteOrderWithGiroRecompute(req.body.id);
    } else if (action === "eliminaConversazione") {
      const wid = req.body.wa_id;
      await sbDelete("conv",     `wa_id=eq.${wid}`);
      await sbDelete("wa_msgs",  `wa_id=eq.${wid}`);
      await sbDelete("ordenes",  `wa_id=eq.${wid}`);
      result = { success: true };
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
// timestamp/conteggi. Cache 5s in-memory + timeout sulle query DB
// per non martellare e per non bloccare in caso di Supabase lento.
let STATUS_CACHE = { ts: 0, payload: null };
const STATUS_CACHE_MS = 5000;
// [2026-09-22] 1000 → 2500 ms. Il budget copre TRE letture PostgREST in parallelo
// da Railway a Supabase, TLS incluso: misura la RETE, non il database. Misurato in
// produzione il 22/09: la query più pesante del check esegue in 0,185 ms
// (EXPLAIN ANALYZE), mentre il round-trip Railway→Supabase è stabile fra 848 e
// 1019 ms su ~2 ore di sonde. Col tetto a 1000 ms il check sbatteva sul proprio
// timeout e segnalava `db_timeout` su un database sano — un falso rosso marginale.
// 2500 ms lascia margine alla variabilità di rete restando sotto i 5 s, oltre i
// quali un rallentamento sarebbe un incidente vero e `red` la risposta giusta.
const STATUS_DB_TIMEOUT_MS = 2500;

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

app.listen(PORT, () => console.log(`La Dieci Bot running on port ${PORT}`));

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

schedula2340();
schedula2350();
catchUpChiusura();
