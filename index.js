require("dotenv").config();
const express = require("express");
const { processWebhook } = require("./src/agents/orchestrator");
const { getConfig, sbSelect, sbUpdate, sbDelete, sbUpsert } = require("./src/utils/supabase");
const { cambiaStato, creaOrdine, modificaOrdine } = require("./src/agents/agentOrdini");
const { invia } = require("./src/agents/agentWhatsapp");
const { chiudiServizio, chiudiServizioGuarded, scanServizio, backupSerata, madridDateStr } = require("./src/utils/servizio");
const { rigeneraSuggerimenti, approvaSuggerimento } = require("./src/agents/agenteMiglioramento");

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
      result = await chiudiServizio(req.query.deleteAttivi === "true");
    } else if (action === "triggerCloseIfNeeded") {
      // Endpoint per cron esterno (es. cron-job.org) — backup del cron interno.
      // Idempotente: se già chiuso oggi, no-op.
      result = await chiudiServizioGuarded(true, "external");
    } else if (action === "scanServizio") {
      result = await scanServizio();
    } else if (action === "backupSerata") {
      result = await backupSerata();
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
    } else if (action === "debugInterpreta") {
      const { interpreta, preDetectaDireccion } = require("./src/agents/agentWhatsapp");
      const testo = req.query.testo || "";
      const ia = await interpreta(testo, cfg, null, []);
      const regex = preDetectaDireccion(testo);
      const tipoConsegna = (ia.tipo_consegna === "DOMICILIO" || regex) ? "DOMICILIO" : "RITIRO";
      result = { ia, regex_match: regex, tipoConsegna_calcolato: tipoConsegna };
    } else {
      result = { error: "unknown action: " + action };
    }

    res.json(result);
  } catch (e) {
    console.error("API GET error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api", async (req, res) => {
  const action = req.query.action || req.body.action;
  try {
    let result;

    if (action === "cambiaStato") {
      result = await cambiaStato(req.body.id, req.body.estado);
    } else if (action === "creaOrdine") {
      result = await creaOrdine(req.body);
    } else if (action === "modificaOrdine") {
      result = await modificaOrdine(req.body.id, req.body);
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
      const upd = { stato: req.body.stato };
      if (req.body.ordine_ref !== undefined) upd.ordine_ref = req.body.ordine_ref;
      await sbUpdate("wa_msgs", `id=eq.${req.body.id}`, upd);
      result = { success: true };
    } else if (action === "updateOrden") {
      result = await modificaOrdine(req.body.id, req.body);
    } else if (action === "updateEstado") {
      result = await cambiaStato(req.body.id, req.body.estado);
    } else if (action === "createOrden") {
      const d = req.body.data || req.body;
      if (!d.waId && d.wa_id) d.waId = d.wa_id;
      result = await creaOrdine(d);
    } else if (action === "updateNotaCucina") {
      await sbUpdate("ordenes", `id=eq.${encodeURIComponent(req.body.id)}`, { nota_cucina: req.body.nota_cucina });
      result = { success: true };
    } else if (action === "eliminaConversazione") {
      const wid = req.body.wa_id;
      await sbDelete("conv",     `wa_id=eq.${wid}`);
      await sbDelete("wa_msgs",  `wa_id=eq.${wid}`);
      await sbDelete("ordenes",  `wa_id=eq.${wid}`);
      result = { success: true };
    } else if (action === "parseOrdineDaRisposta") {
      result = { success: true };
    } else {
      result = { error: "unknown action: " + action };
    }

    res.json(result);
  } catch (e) {
    console.error("API POST error:", e);
    res.status(500).json({ error: e.message });
  }
});

// Health check
app.get("/health", (_, res) => res.json({ ok: true, ts: Date.now() }));

app.listen(PORT, () => console.log(`La Dieci Bot running on port ${PORT}`));

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
      // chiudiServizioGuarded è idempotente: setta LAST_CLOSE_DATE in config dopo successo.
      // Se Railway riavvia dopo le 23:50, il catch-up all'avvio recupera la chiusura mancata.
      const res = await chiudiServizioGuarded(true, "cron2350");
      console.log("[cron 23:50] risultato:", JSON.stringify(res));
      const cfg = await getConfig();
      const OPERATOR_WA_IDS = ["41767011848", "34614267535"];
      let msg;
      if (res.skipped) msg = null;
      else if (res.success) msg = `🌙 *Serata chiusa automaticamente* (23:50)\n\nArchiviate ${res.conv_archiviate || 0} conv · ${res.ordini_storico || 0} ordini su storico.\n\nBuonanotte! 🍕`;
      else msg = `⚠️ Chiusura automatica 23:50 — errore archivio:\n${JSON.stringify(res.errori || res)}`;
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
    const res = await chiudiServizioGuarded(true, "catchUp");
    console.log("[catchUp] risultato:", JSON.stringify(res));
    if (res.success && !res.skipped) {
      const cfgAll = await getConfig();
      const msg = `🌙 *Recupero chiusura serata* (avvio server)\n\nArchiviate ${res.conv_archiviate || 0} conv · ${res.ordini_storico || 0} ordini su storico.`;
      for (const waId of ["41767011848", "34614267535"]) await invia(waId, msg, cfgAll).catch(() => {});
    }
  } catch (e) {
    console.error("[catchUp] errore:", e);
  }
}

schedula2340();
schedula2350();
catchUpChiusura();
