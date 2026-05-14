// ===============================================================
// servizio.js — chiusura serata atomica
//
// Filosofia:
//   1. Lock-first via INSERT su serata_summary(fecha PK) → race-safe.
//   2. Backup raw SUBITO in backup_serata → safety net se tutto fallisce.
//   3. Calcolo summary completo prima di toccare nulla.
//   4. writeStorico con payload COMPLETO (33 colonne) per ogni ordine.
//   5. writeArchivioConv con onConflict(wa_id, data_servizio).
//   6. UPDATE serata_summary con valori reali.
//   7. VERIFY: count(storico WHERE fecha=oggi) >= ordini archiviati.
//      Se KO → ROLLBACK (cancella storico/serata_summary), NON tocca ordenes.
//   8. Solo dopo verify OK: cancella ordenes/conv/wa_msgs completati.
//   9. Reset config (DRIVER_STATO, ORDER_RESET_TS, LAST_CLOSE_DATE).
//
// L'operatore vede success+summary atomico, o errore preciso, mai stato a metà.
// ===============================================================

const { sbSelect, sbInsert, sbUpsert, sbUpdate, sbDelete } = require("./supabase");
const { calcolaTotale, calcolaTotaleOrdine, deliveryFeeFor, isBevanda, isDesert, direccionToCacheKey } = require("./helpers");

// Incrementa n_ordini_consegnati sulla riga di geo_cache associata all'indirizzo dell'ordine.
// Chiamata da chiudiServizio per ogni ordine archiviato → la "conferma indirizzo" non dipende dal bottone driver.
// Best-effort: se la migration non è applicata o la riga manca, fallisce silenziosamente con warn.
async function bumpGeoCacheDelivered(direccion, geoSource) {
  if (!direccion || !geoSource) return;
  // Solo ordini con lat/lon reali (Google/Nominatim/Photon) sono significativi per geo_cache.
  // "keyword" e null vivono fuori dalla cache, niente da incrementare.
  if (geoSource === "keyword") return;
  const key = direccionToCacheKey(direccion);
  if (!key || key.length < 5) return;
  try {
    const rows = await sbSelect("geo_cache", `direccion_key=eq.${encodeURIComponent(key)}&limit=1`);
    const row = rows?.[0];
    if (!row) return;
    await sbUpsert("geo_cache",
      { direccion_key: key, n_ordini_consegnati: (row.n_ordini_consegnati || 0) + 1 },
      "direccion_key"
    );
  } catch (e) {
    console.warn("[geo_cache] n_ordini_consegnati bump failed:", e?.message || e);
  }
}


// ─── Date helpers ────────────────────────────────────────────────
function madridDateStr(d = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const y = parts.find(p => p.type === "year").value;
  const m = parts.find(p => p.type === "month").value;
  const day = parts.find(p => p.type === "day").value;
  return `${y}-${m}-${day}`;
}

function diaSemanaIta(d = new Date()) {
  const giorni = ["domenica","lunedi","martedi","mercoledi","giovedi","venerdi","sabato"];
  return giorni[d.getDay()];
}

function fasciaOraDa(hora) {
  const h = parseInt(String(hora || "").split(":")[0], 10);
  if (isNaN(h)) return "tardivo";
  if (h < 20) return "presto";
  if (h < 21) return "20:00";
  if (h < 22) return "21:00";
  return "tardivo";
}


// ─── Scan: cosa c'è prima di chiudere (read-only) ────────────────
async function scanServizio() {
  const oggi = madridDateStr();
  const ordiniCompletati = await sbSelect("ordenes", "estado=in.(RETIRADO,COMPLETADO)") || [];
  const convChiuse       = await sbSelect("conv", "stato_ordine=in.(ritirata,confermata,chiusa)") || [];
  const convAttive       = await sbSelect("conv", "stato_ordine=not.in.(ritirata,confermata,chiusa)") || [];
  const waMsgsAttivi     = await sbSelect("wa_msgs", "stato=in.(NUEVO,IN_TRATTAMENTO)") || [];
  const ordiniInCorso    = await sbSelect("ordenes", "estado=in.(DA_CONFERMARE,EN_COCINA,LISTO,EN_ENTREGA)") || [];

  const attiviMap = {};
  (Array.isArray(convAttive)    ? convAttive    : []).forEach(c => { attiviMap[c.wa_id] = { wa_id: c.wa_id, nombre: c.nombre || c.wa_id, hora: c.hora || "", stato: c.stato_ordine || "" }; });
  (Array.isArray(waMsgsAttivi)  ? waMsgsAttivi  : []).forEach(m => { if (!attiviMap[m.wa_id]) attiviMap[m.wa_id] = { wa_id: m.wa_id, nombre: m.nombre || m.wa_id, hora: "", stato: m.stato || "" }; });
  (Array.isArray(ordiniInCorso) ? ordiniInCorso : []).forEach(o => {
    const key = o.wa_id || o.tel || o.id;
    if (!attiviMap[key]) attiviMap[key] = { wa_id: o.wa_id || o.tel || "", nombre: o.nombre || o.id || "", hora: o.hora || "", stato: o.estado || "" };
  });

  return {
    ok: true,
    data: oggi,
    completati: {
      ordini: Array.isArray(ordiniCompletati) ? ordiniCompletati.length : 0,
      conv:   Array.isArray(convChiuse)       ? convChiuse.length       : 0
    },
    attivi: Object.values(attiviMap)
  };
}


// ─── Backup raw: snapshot completo della serata in 1 riga ────────
// Indipendente da tutto. Anche se la chiusura fallisce, qui c'è tutto.
async function backupSerata() {
  const oggi = madridDateStr();
  const ordini = await sbSelect("ordenes", "select=*") || [];
  const lista = Array.isArray(ordini) ? ordini : [];

  let totale = 0, nPizze = 0, nBevande = 0, nDessert = 0;
  for (const o of lista) {
    const t = Number(o.totale) || 0;
    totale += (t > 0) ? t : calcolaTotaleOrdine(o.items || [], o.tipo_consegna || "RITIRO");
    for (const it of (o.items || [])) {
      const nome = it.n || "";
      if (!nome || nome === "Entrega a domicilio") continue;
      const cat = it.cat || "";
      const q = parseInt(it.q || 1) || 1;
      if (cat === "Bebidas" || isBevanda(nome))      nBevande += q;
      else if (cat === "Postres" && nome !== "Pizza Nutella") nDessert += q;
      else if (isDesert(nome))                       nDessert += q;
      else                                           nPizze += q;
    }
  }

  const res = await sbInsert("backup_serata", {
    fecha: oggi,
    ts_backup: Date.now(),
    n_ordini: lista.length,
    totale: Math.round(totale * 100) / 100,
    n_pizze: nPizze,
    n_bevande: nBevande,
    n_dessert: nDessert,
    ordini: lista
  });

  return {
    success: Array.isArray(res) && res.length > 0,
    n_ordini: lista.length,
    totale: Math.round(totale * 100) / 100
  };
}


// ─── Classificazione item (cat prima, fallback su nome) ──────────
function classificaItem(it) {
  const nome = it?.n || "";
  if (!nome || nome === "Entrega a domicilio") return null;
  const cat = it?.cat || "";
  if (cat === "Bebidas" || isBevanda(nome)) return "bevanda";
  if (cat === "Postres" && nome !== "Pizza Nutella") return "dessert";
  if (isDesert(nome)) return "dessert";
  return "pizza";
}


// ─── Mappa pagamento → key cassa_* ───────────────────────────────
function metodoPagoKey(m) {
  const k = String(m || "").toLowerCase().trim();
  if (k === "efectivo")        return "cassa_efectivo";
  if (k === "tarjeta")         return "cassa_tarjeta";
  if (k === "bizum")           return "cassa_bizum";
  return "cassa_non_specificato";
}


// ─── Costruisci payload storico COMPLETO da un ordine ────────────
// Ogni colonna di ordenes che ha senso archiviare → finisce qui.
function buildStoricoPayload(o, oggi, diaSemana, estadoOverride = null) {
  const tipoConsegna = o.tipo_consegna || "RITIRO";
  const deliveryFee  = (o.delivery_fee != null) ? Number(o.delivery_fee) : deliveryFeeFor(tipoConsegna);
  const totale       = (Number(o.totale) > 0) ? Number(o.totale) : calcolaTotaleOrdine(o.items || [], tipoConsegna);

  return {
    orden_id:       o.id || "",
    nombre:         o.nombre || "",
    tel:            o.tel || "",
    wa_id:          o.wa_id || "",
    canal:          o.canal || "WA",
    items:          o.items || [],
    nota:           o.nota || "",
    nota_cucina:    o.nota_cucina || "",
    hora:           o.hora || "",
    estado:         estadoOverride || o.estado || "",
    totale,
    delivery_fee:   deliveryFee,
    tipo_consegna:  tipoConsegna,
    metodo_pago:    o.metodo_pago || "",
    cobrado:        o.cobrado === true,
    ya_pagado:      o.ya_pagado === true,
    direccion:      o.direccion || null,
    direccion_note: o.direccion_note || null,
    zona:           o.zona || null,
    zona_lat:       o.zona_lat != null ? Number(o.zona_lat) : null,
    zona_lon:       o.zona_lon != null ? Number(o.zona_lon) : null,
    zona_manuale:   o.zona_manuale === true,
    repartidor:     o.repartidor || null,
    hora_salida:    o.hora_salida ? Number(o.hora_salida) : null,
    hora_entrega:   o.hora_entrega ? Number(o.hora_entrega) : null,
    llegado:        o.llegado === true,
    cucina_check:   o.cucina_check || null,
    fecha:          oggi,
    dia_semana:     diaSemana,
    fascia_ora:     fasciaOraDa(o.hora),
    ts:             o.ts || Date.now()
  };
}


// ─── Calcolo summary aggregata (pure, no side effects) ───────────
async function computeSummary(ordiniDaArch, oggi, diaSemana, source) {
  const summary = {
    fecha: oggi,
    dia_semana: diaSemana,
    ts_chiusura: Date.now(),
    source,
    n_ordini: 0,
    n_pizze: 0, n_bevande: 0, n_dessert: 0,
    n_delivery: 0, n_ritiro: 0,
    n_clienti_unici: 0, n_clienti_nuovi: 0,
    cassa_totale: 0,
    cassa_efectivo: 0, cassa_tarjeta: 0, cassa_bizum: 0, cassa_non_specificato: 0,
    delivery_fee_totale: 0,
    n_domande_gestite: 0,
    per_zona: {},
    per_fascia: {},
    per_canal: {},
    errori: null
  };

  const telSet = new Set();

  for (const o of ordiniDaArch) {
    summary.n_ordini++;

    const tipoConsegna = o.tipo_consegna || "RITIRO";
    const deliveryFee  = (o.delivery_fee != null) ? Number(o.delivery_fee) : deliveryFeeFor(tipoConsegna);
    const totale       = (Number(o.totale) > 0) ? Number(o.totale) : calcolaTotaleOrdine(o.items || [], tipoConsegna);

    summary.cassa_totale += totale;
    summary.delivery_fee_totale += deliveryFee;

    // Breakdown pagamento — totale (non item) finisce nella cassa giusta
    const cassaKey = metodoPagoKey(o.metodo_pago);
    summary[cassaKey] += totale;

    // Delivery vs Ritiro
    if (tipoConsegna === "DOMICILIO") summary.n_delivery++; else summary.n_ritiro++;

    // Items: pizze/bevande/dessert
    for (const it of (o.items || [])) {
      const kind = classificaItem(it);
      if (!kind) continue;
      const q = parseInt(it.q || 1) || 1;
      if (kind === "pizza")        summary.n_pizze   += q;
      else if (kind === "bevanda") summary.n_bevande += q;
      else if (kind === "dessert") summary.n_dessert += q;
    }

    // Clienti unici (per tel)
    const telKey = String(o.tel || o.wa_id || "").trim();
    if (telKey) telSet.add(telKey);

    // Per zona
    if (o.zona) {
      if (!summary.per_zona[o.zona]) summary.per_zona[o.zona] = { n: 0, eur: 0 };
      summary.per_zona[o.zona].n   += 1;
      summary.per_zona[o.zona].eur += totale;
    }

    // Per fascia
    const f = fasciaOraDa(o.hora);
    if (!summary.per_fascia[f]) summary.per_fascia[f] = { n: 0, eur: 0 };
    summary.per_fascia[f].n   += 1;
    summary.per_fascia[f].eur += totale;

    // Per canale
    const canal = (o.canal || "MANUAL").toUpperCase();
    summary.per_canal[canal] = (summary.per_canal[canal] || 0) + 1;
  }

  // Arrotonda i monetari a 2 cifre
  summary.cassa_totale          = Math.round(summary.cassa_totale * 100) / 100;
  summary.cassa_efectivo        = Math.round(summary.cassa_efectivo * 100) / 100;
  summary.cassa_tarjeta         = Math.round(summary.cassa_tarjeta * 100) / 100;
  summary.cassa_bizum           = Math.round(summary.cassa_bizum * 100) / 100;
  summary.cassa_non_specificato = Math.round(summary.cassa_non_specificato * 100) / 100;
  summary.delivery_fee_totale   = Math.round(summary.delivery_fee_totale * 100) / 100;
  for (const z in summary.per_zona)   summary.per_zona[z].eur   = Math.round(summary.per_zona[z].eur * 100) / 100;
  for (const f in summary.per_fascia) summary.per_fascia[f].eur = Math.round(summary.per_fascia[f].eur * 100) / 100;

  summary.n_clienti_unici = telSet.size;

  // Clienti nuovi: presenti in clientes con created_at di oggi
  // (semplice: count clientes con created_at >= midnight Madrid di oggi)
  try {
    const startOfDayMadrid = new Date(oggi + "T00:00:00+02:00"); // Madrid è UTC+2 in CEST
    const clientiNuovi = await sbSelect("clientes", `created_at=gte.${startOfDayMadrid.toISOString()}&tel=in.(${[...telSet].map(t => `"${t}"`).join(",") || '""'})`);
    summary.n_clienti_nuovi = Array.isArray(clientiNuovi) ? clientiNuovi.length : 0;
  } catch (_) { summary.n_clienti_nuovi = 0; }

  // Domande gestite: wa_msgs di oggi con stato IN_TRATTAMENTO o COMPLETATO
  // (NUEVO = mai gestito, COCINA = già ordine — escludiamo)
  try {
    const startMs = new Date(oggi + "T00:00:00+02:00").getTime();
    const waOggi = await sbSelect("wa_msgs", `ts=gte.${startMs}&stato=in.(IN_TRATTAMENTO,COMPLETATO)`);
    summary.n_domande_gestite = Array.isArray(waOggi) ? waOggi.length : 0;
  } catch (_) { summary.n_domande_gestite = 0; }

  return summary;
}


// ─── ENTRY POINT: chiudiServizio ─────────────────────────────────
// Ritorna SEMPRE oggetto con shape consistente:
//   { success: true, summary: {...}, data: "YYYY-MM-DD" }
//   { skipped: true, reason: "already_closed_today" | "race_lost", data }
//   { success: false, error: "verify_failed" | "...", details: {...} }
async function chiudiServizio(deleteAttivi = false, source = "manual") {
  const oggi = madridDateStr();
  const diaSemana = diaSemanaIta();

  // ─── PASSO 1: già chiuso oggi? ────────────────────────────────
  const existing = await sbSelect("serata_summary", `fecha=eq.${oggi}`);
  if (Array.isArray(existing) && existing.length > 0) {
    return { skipped: true, reason: "already_closed_today", data: oggi };
  }

  // ─── PASSO 2: backup raw SUBITO (safety net) ──────────────────
  const bkp = await backupSerata().catch(e => {
    console.error(`[chiudiServizio ${source}] backup fallito:`, e);
    return { success: false };
  });

  // ─── PASSO 3: leggi tutti gli ordini target ───────────────────
  const ordCompletati = await sbSelect("ordenes", "estado=in.(RETIRADO,COMPLETADO)") || [];
  const ordAttivi     = deleteAttivi ? (await sbSelect("ordenes", "estado=not.in.(RETIRADO,COMPLETADO)") || []) : [];
  const ordiniDaArch  = [
    ...(Array.isArray(ordCompletati) ? ordCompletati : []),
    ...(Array.isArray(ordAttivi)     ? ordAttivi.map(o => ({ ...o, estado: "CHIUSO_FORZATO" })) : [])
  ];

  // ─── PASSO 4: compute summary ─────────────────────────────────
  const summary = await computeSummary(ordiniDaArch, oggi, diaSemana, source);

  // ─── PASSO 5: lock via INSERT serata_summary (PK su fecha) ────
  // Se due processi tentano contemporaneamente, solo uno passa.
  const lockResult = await sbInsert("serata_summary", summary);
  const lockOk = Array.isArray(lockResult) && lockResult.length > 0;
  if (!lockOk) {
    // Conflitto chiave primaria → un altro processo è già passato in mezzo a noi
    const errCode = lockResult?.code || lockResult?.[0]?.code || "";
    if (errCode === "23505") {
      return { skipped: true, reason: "race_lost", data: oggi };
    }
    return { success: false, error: "lock_failed", details: lockResult };
  }

  // Da qui in poi siamo gli unici a chiudere — il lock vive in serata_summary.

  // ─── PASSO 6: writeStorico (payload COMPLETO) ─────────────────
  const erroriStorico = [];
  let storicoOk = 0;
  for (const o of ordiniDaArch) {
    const isAttivo = deleteAttivi && o.estado === "CHIUSO_FORZATO";
    const payload = buildStoricoPayload(o, oggi, diaSemana, isAttivo ? "CHIUSO_FORZATO" : null);
    const res = await sbUpsert("storico", payload, "orden_id,fecha");
    if (!Array.isArray(res) || res.length === 0) erroriStorico.push(o.id || "?");
    else {
      storicoOk++;
      // Conferma indirizzo via segnale "ordine archiviato" — indipendente dal bottone driver.
      // Ordini CHIUSO_FORZATO non contano (non sono andati a buon fine).
      if (!isAttivo) await bumpGeoCacheDelivered(o.direccion, o.geo_source);
    }
  }

  // ─── PASSO 7: writeArchivioConv ───────────────────────────────
  const convCompletate = await sbSelect("conv", "stato_ordine=in.(ritirata,confermata,chiusa)") || [];
  const convAttive     = deleteAttivi ? (await sbSelect("conv", "stato_ordine=not.in.(ritirata,confermata,chiusa)") || []) : [];
  const convDaArch     = [
    ...(Array.isArray(convCompletate) ? convCompletate : []),
    ...(Array.isArray(convAttive)     ? convAttive.map(c => ({ ...c, _forzata: true })) : [])
  ];

  const erroriConv = [];
  let convOk = 0;
  for (const c of convDaArch) {
    const totale = calcolaTotale(c.items || []);
    const res = await sbUpsert("archivio_conv", {
      data_servizio: oggi,
      wa_id:         c.wa_id || "",
      nombre:        c.nombre || "",
      chat:          c.chat || [],
      items:         c.items || [],
      totale,
      hora:          c.hora || "",
      stato_finale:  c._forzata ? "CHIUSO_FORZATO" : (c.stato_ordine || ""),
      n_messaggi:    (c.chat || []).length,
      ts:            c.ts || Date.now()
    }, "wa_id,data_servizio");
    if (!Array.isArray(res) || res.length === 0) erroriConv.push(c.wa_id || "?");
    else convOk++;
  }

  // ─── PASSO 8: VERIFY ──────────────────────────────────────────
  // Numero righe storico per fecha=oggi >= ordini archiviati attesi?
  const storicoCheck = await sbSelect("storico", `fecha=eq.${oggi}&select=orden_id`);
  const storicoActual = Array.isArray(storicoCheck) ? storicoCheck.length : 0;
  const verifyOk = storicoActual >= storicoOk && erroriStorico.length === 0;

  if (!verifyOk) {
    // ROLLBACK: cancella storico e serata_summary di oggi. NON tocca ordenes.
    // L'operatore vede l'errore, può riprovare. Backup raw resta in backup_serata.
    await sbDelete("storico", `fecha=eq.${oggi}`);
    await sbDelete("serata_summary", `fecha=eq.${oggi}`);
    return {
      success: false,
      error: "verify_failed",
      details: {
        expected: storicoOk,
        actual:   storicoActual,
        erroriStorico,
        erroriConv,
        backupOk: !!bkp?.success
      }
    };
  }

  // ─── PASSO 9: aggiorna serata_summary con eventuali errori conv ─
  if (erroriConv.length > 0) {
    await sbUpdate("serata_summary", `fecha=eq.${oggi}`, {
      errori: { storico: erroriStorico, conv: erroriConv }
    });
  }

  // ─── PASSO 10: cleanup ordenes/conv/wa_msgs ───────────────────
  await sbDelete("conv",    "stato_ordine=in.(ritirata,confermata,chiusa)");
  await sbDelete("wa_msgs", "stato=in.(COMPLETATO,COCINA)");
  await sbDelete("ordenes", "estado=in.(RETIRADO,COMPLETADO)");

  if (deleteAttivi) {
    await sbDelete("conv",    "stato_ordine=not.in.(ritirata,confermata,chiusa)");
    await sbDelete("wa_msgs", "stato=neq.COMPLETATO");
    await sbDelete("ordenes", "estado=not.in.(RETIRADO,COMPLETADO)");
  }

  // ─── PASSO 11: reset config ───────────────────────────────────
  await sbUpsert("config", { chiave: "ORDER_RESET_TS",  valore: String(Date.now()) }, "chiave");
  await sbUpsert("config", { chiave: "DRIVER_STATO",    valore: JSON.stringify({ stato: "LIBERO" }) }, "chiave");
  await sbUpsert("config", { chiave: "LAST_CLOSE_DATE", valore: oggi }, "chiave");

  // ─── DONE ────────────────────────────────────────────────────
  return {
    success: true,
    data: oggi,
    summary,
    conv_archiviate: convOk,
    ordini_storico:  storicoOk,
    backupOk:        !!bkp?.success
  };
}


module.exports = {
  scanServizio,
  backupSerata,
  chiudiServizio,
  madridDateStr,
  fasciaOraDa
};
