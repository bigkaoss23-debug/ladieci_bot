require("dotenv").config();
const express = require("express");
const { processWebhook } = require("./src/agents/orchestrator");
const { getConfig, sbSelect, sbUpdate, sbDelete, sbUpsert, sbInsert } = require("./src/utils/supabase");
const { cambiaStato, creaOrdine, modificaOrdine } = require("./src/agents/agentOrdini");
const { invia } = require("./src/agents/agentWhatsapp");
const { chiudiServizio, scanServizio, backupSerata, madridDateStr } = require("./src/utils/servizio");
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
      // Accetta campi pagamento/timing/repartidor in unica scrittura atomica
      const extras = {};
      for (const k of ["metodo_pago","cobrado","ya_pagado","hora_entrega","hora_salida","repartidor","llegado","cucina_check"]) {
        if (req.body[k] !== undefined) extras[k] = req.body[k];
      }
      result = await cambiaStato(req.body.id, req.body.estado, extras);
    } else if (action === "marcarEnEntrega") {
      // LISTO → EN_ENTREGA — registra hora_salida atomicamente
      result = await cambiaStato(req.body.id, "EN_ENTREGA", { hora_salida: Date.now() });
    } else if (action === "marcarEntregado") {
      // EN_ENTREGA/LISTO → RETIRADO — registra hora_entrega + cobrado + metodo_pago atomicamente
      result = await cambiaStato(req.body.id, "RETIRADO", {
        hora_entrega: Date.now(),
        cobrado: req.body.cobrado !== false,
        metodo_pago: req.body.metodo_pago || ""
      });
    } else if (action === "asignarRepartidor") {
      await sbUpdate("ordenes", `id=eq.${encodeURIComponent(req.body.id)}`, { repartidor: req.body.repartidor || null });
      result = { success: true };
    } else if (action === "registrarSalidaDriver") {
      // Driver fuori: setta DRIVER_STATO con zona + ora partenza
      const nuovoStato = {
        stato: "IN_GIRO",
        zona: req.body.zona || null,
        partito_alle: new Date().toISOString(),
        n_ordini: req.body.n_ordini || 1,
        rientro_stimato: null
      };
      await sbUpsert("config", { chiave: "DRIVER_STATO", valore: JSON.stringify(nuovoStato) }, "chiave");
      result = { success: true, stato: nuovoStato };
    } else if (action === "chiudiGiro") {
      // Driver rientra: calcola rientro stimato, logga il giro
      const rows = await sbSelect("config", "chiave=eq.DRIVER_STATO");
      const ds = rows?.[0]?.valore
        ? (typeof rows[0].valore === "string" ? JSON.parse(rows[0].valore) : rows[0].valore)
        : null;
      if (ds?.partito_alle) {
        const adesso = new Date();
        const tempoAndata = Math.round((adesso - new Date(ds.partito_alle)) / 60000);
        const rientroStimato = new Date(adesso.getTime() + (tempoAndata + 3) * 60000).toISOString();
        await sbUpsert("config", {
          chiave: "DRIVER_STATO",
          valore: JSON.stringify({ ...ds, rientro_stimato: rientroStimato })
        }, "chiave");

        // ── Shadow A/B: raccoglie stime degli ordini consegnati in questo giro ──
        // Per ogni ordine RETIRADO con hora_entrega DOPO partito_alle e stessa zona,
        // estrae le 3 stime (chosen, google, haversine) + source.
        // Aggregazione MAX (worst-case del giro) per coerenza con tempo reale registrato.
        let durataStimataMin = null, durataGoogleMin = null, durataHaversineMin = null, durataStimataSource = null;
        try {
          const partitoMs = new Date(ds.partito_alle).getTime();
          const recent = await sbSelect("ordenes",
            `estado=eq.RETIRADO&zona=eq.${encodeURIComponent(ds.zona || "")}&order=hora_entrega.desc&limit=10`
          );
          const ords = (recent || []).filter(o => o.hora_entrega && Number(o.hora_entrega) >= partitoMs);
          if (ords.length > 0) {
            const maxOf = (k) => {
              const vals = ords.map(o => o[k]).filter(v => v != null);
              return vals.length ? Math.max(...vals) : null;
            };
            durataStimataMin    = maxOf("durata_andata_min");
            durataGoogleMin     = maxOf("durata_google_min");
            durataHaversineMin  = maxOf("durata_haversine_min");
            const sources = [...new Set(ords.map(o => o.geo_source).filter(Boolean))];
            durataStimataSource = sources.length === 1 ? sources[0] : (sources.length > 1 ? "mixed" : null);
          }
        } catch (e) {
          console.warn("[chiudiGiro] A/B aggregation failed:", e?.message || e);
        }

        // INSERT (non upsert) — ogni giro è una nuova riga, id è serial autoincrement.
        // sbUpsert qui falliva sempre per via di prefer=resolution=merge-duplicates senza on_conflict
        // → PostgREST 400 → catch silenzioso → tabella vuota per mesi. Bug fixato 2026-05-14.
        try {
          await sbInsert("delivery_logs", {
            zona: ds.zona, n_ordini: ds.n_ordini || 1,
            partito_alle: ds.partito_alle, ultimo_entregado: adesso.toISOString(),
            tempo_andata_min: tempoAndata, rientro_stimato: rientroStimato,
            durata_stimata_min: durataStimataMin,
            durata_stimata_source: durataStimataSource,
            durata_stimata_google_min: durataGoogleMin,
            durata_stimata_haversine_min: durataHaversineMin
          });
        } catch (e) {
          console.warn("[delivery_logs] insert failed:", e?.message || e);
        }
        result = { success: true, rientroStimato, tempoAndata };
      } else {
        result = { success: true, skipped: "driver_not_out" };
      }
    } else if (action === "marcarLlegado") {
      // Cliente arrivato (RITIRO) — segna flag llegado
      await sbUpdate("ordenes", `id=eq.${encodeURIComponent(req.body.id)}`, { llegado: req.body.llegado !== false });
      result = { success: true };
    } else if (action === "resolveAddress") {
      const { risolviIndirizzo } = require("./src/utils/geoResolver");
      const { direccion, tel, tipoConsegna, forceRefresh } = req.body;
      result = await risolviIndirizzo({
        direccion, tel: tel || null,
        tipoConsegna: tipoConsegna || "DOMICILIO",
        forceRefresh: !!forceRefresh
      });
    } else if (action === "createOrden") {
      const d = req.body.data || req.body;
      if (!d.waId && d.wa_id) d.waId = d.wa_id;
      result = await creaOrdine(d);
    } else if (action === "updateNotaCucina") {
      await sbUpdate("ordenes", `id=eq.${encodeURIComponent(req.body.id)}`, { nota_cucina: req.body.nota_cucina });
      result = { success: true };
    } else if (action === "eliminaOrdine") {
      await sbDelete("ordenes", `id=eq.${encodeURIComponent(req.body.id)}`);
      result = { success: true };
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
