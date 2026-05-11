// ===============================================================
// servizio.js — chiudiServizio, scanServizio, backupSerata
// ===============================================================

const { sbSelect, sbUpsert, sbDelete, sbInsert } = require("./supabase");
const { calcolaTotale, calcolaTotaleOrdine, deliveryFeeFor, isBevanda, isDesert } = require("./helpers");

async function scanServizio() {
  const oggi = new Date().toISOString().slice(0, 10);
  const ordiniCompletati = await sbSelect("ordenes", "estado=in.(RETIRADO,COMPLETADO)") || [];
  const convChiuse = await sbSelect("conv", "stato_ordine=in.(ritirata,confermata,chiusa)") || [];
  const convAttive = await sbSelect("conv", "stato_ordine=not.in.(ritirata,confermata,chiusa)") || [];
  // Solo NUEVO e IN_TRATTAMENTO sono veramente "attivi" per l'operatore.
  // COCINA = già confermato, non richiede attenzione → non va contato come pending.
  const waMsgsAttivi = await sbSelect("wa_msgs", "stato=in.(NUEVO,IN_TRATTAMENTO)") || [];
  // Ordini ancora in lavorazione/consegna: pizza non ritirata o driver ancora in giro.
  const ordiniInCorso = await sbSelect("ordenes", "estado=in.(DA_CONFERMARE,EN_COCINA,LISTO,EN_ENTREGA)") || [];

  const attiviMap = {};
  (Array.isArray(convAttive) ? convAttive : []).forEach(c => { attiviMap[c.wa_id] = { wa_id: c.wa_id, nombre: c.nombre || c.wa_id, hora: c.hora || "", stato: c.stato_ordine || "" }; });
  (Array.isArray(waMsgsAttivi) ? waMsgsAttivi : []).forEach(m => { if (!attiviMap[m.wa_id]) attiviMap[m.wa_id] = { wa_id: m.wa_id, nombre: m.nombre || m.wa_id, hora: "", stato: m.stato || "" }; });
  (Array.isArray(ordiniInCorso) ? ordiniInCorso : []).forEach(o => {
    const key = o.wa_id || o.tel || o.id;
    if (!attiviMap[key]) attiviMap[key] = { wa_id: o.wa_id || o.tel || "", nombre: o.nombre || o.id || "", hora: o.hora || "", stato: o.estado || "" };
  });

  return { ok: true, data: oggi, completati: { ordini: Array.isArray(ordiniCompletati) ? ordiniCompletati.length : 0, conv: Array.isArray(convChiuse) ? convChiuse.length : 0 }, attivi: Object.values(attiviMap) };
}

async function backupSerata() {
  const oggi = new Date().toISOString().slice(0, 10);
  const ordini = await sbSelect("ordenes", "select=*") || [];
  const lista = Array.isArray(ordini) ? ordini : [];

  let totale = 0, nPizze = 0, nBevande = 0, nDessert = 0;
  for (const o of lista) {
    // Preferisce il totale già calcolato e salvato (nuovo sistema).
    // Fallback per ordini legacy senza la colonna: ricalcola con delivery_fee.
    const t = Number(o.totale) || 0;
    totale += (t > 0) ? t : calcolaTotaleOrdine(o.items || [], o.tipo_consegna || "RITIRO");
    for (const it of (o.items || [])) {
      const nome = it.n || "";
      if (nome === "Entrega a domicilio") continue; // legacy: ignora il fake item
      if (isBevanda(nome))      nBevande += parseInt(it.q || 1);
      else if (isDesert(nome))  nDessert += parseInt(it.q || 1);
      else if (nome)            nPizze += parseInt(it.q || 1);
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

  return { success: Array.isArray(res) && res.length > 0, n_ordini: lista.length, totale: Math.round(totale * 100) / 100 };
}

// Calcola la fascia oraria a partire dall'orario "HH:MM" dell'ordine (non dall'ora di esecuzione del cron).
function fasciaOraDa(hora) {
  const h = parseInt(String(hora || "").split(":")[0], 10);
  if (isNaN(h)) return "tardivo";
  if (h < 20) return "presto";
  if (h < 21) return "20:00";
  if (h < 22) return "21:00";
  return "tardivo";
}

async function chiudiServizio(deleteAttivi = false) {
  const oggi = new Date().toISOString().slice(0, 10);
  const giorniSettimana = ["domenica","lunedi","martedi","mercoledi","giovedi","venerdi","sabato"];
  const diaSemana = giorniSettimana[new Date().getDay()];

  // Backup immediato — prima di qualsiasi operazione sul DB
  await backupSerata().catch(e => console.error("[chiudiServizio] backup fallito:", e));

  // Errori separati: conv e storico gestiti indipendentemente.
  // Se storico OK ma conv fallisce → cleanup ordines avviene comunque (no data loss).
  const erroriConv = [];
  const erroriStorico = [];

  const convDaArch = await sbSelect("conv", "stato_ordine=in.(ritirata,confermata,chiusa)") || [];
  let archiviate = 0;
  for (const c of (Array.isArray(convDaArch) ? convDaArch : [])) {
    const totale = calcolaTotale(c.items || []);
    const res = await sbUpsert("archivio_conv", { data_servizio: oggi, wa_id: c.wa_id || "", nombre: c.nombre || "", chat: c.chat || [], items: c.items || [], totale, hora: c.hora || "", stato_finale: c.stato_ordine || "", n_messaggi: (c.chat || []).length, ts: c.ts || Date.now() });
    if (!Array.isArray(res) || res.length === 0) erroriConv.push("conv:" + (c.wa_id || "?"));
    else archiviate++;
  }

  const ordiniDaArch = await sbSelect("ordenes", "estado=in.(RETIRADO,COMPLETADO)") || [];
  let ordArch = 0;
  for (const o of (Array.isArray(ordiniDaArch) ? ordiniDaArch : [])) {
    // Copia delivery_fee e totale dall'ordine (già calcolati alla creazione/modifica).
    // Fallback safe per ordini legacy senza queste colonne.
    const tipoConsegna = o.tipo_consegna || "RITIRO";
    const deliveryFee  = (o.delivery_fee != null) ? Number(o.delivery_fee) : deliveryFeeFor(tipoConsegna);
    const totale       = (Number(o.totale) > 0) ? Number(o.totale) : calcolaTotaleOrdine(o.items || [], tipoConsegna);
    const payload = {
      orden_id: o.id || "", nombre: o.nombre || "", tel: o.tel || o.wa_id || "", canal: o.canal || "WA",
      items: o.items || [], nota: o.nota || "", hora: o.hora || "", estado: o.estado || "",
      totale, delivery_fee: deliveryFee, tipo_consegna: tipoConsegna,
      fecha: oggi, dia_semana: diaSemana, fascia_ora: fasciaOraDa(o.hora), ts: o.ts || Date.now()
    };
    // La unique constraint sbagliata su solo orden_id è stata droppata: ora (orden_id, fecha) è la chiave.
    const res = await sbUpsert("storico", payload, "orden_id,fecha");
    if (!Array.isArray(res) || res.length === 0) erroriStorico.push("ordine:" + (o.id || "?"));
    else ordArch++;
  }

  // Blocca SOLO se storico ha fallito — errori conv non impediscono la pulizia ordini
  if (erroriStorico.length > 0) {
    return { success: false, errori: [...erroriConv, ...erroriStorico], conv_archiviate: archiviate, ordini_storico: ordArch };
  }

  // Storico OK → elimina completati (anche se alcune conv hanno avuto errori)
  await sbDelete("conv", "stato_ordine=in.(ritirata,confermata,chiusa)");
  // COCINA incluso: wa_msgs COCINA = ordine confermato e già gestito dall'operatore.
  // Senza questa riga sopravvivono a chiudiServizio(false) e ricompaiono il giorno dopo.
  await sbDelete("wa_msgs", "stato=in.(COMPLETATO,COCINA)");
  await sbDelete("ordenes", "estado=in.(RETIRADO,COMPLETADO)");

  if (deleteAttivi) {
    // Archivia ordini ancora attivi — verifica errori PRIMA di cancellare (evita data loss)
    const ordiniAttivi = await sbSelect("ordenes", "estado=not.in.(RETIRADO,COMPLETADO)") || [];
    const erroriAttivi = [];
    for (const o of (Array.isArray(ordiniAttivi) ? ordiniAttivi : [])) {
      const tipoConsegna = o.tipo_consegna || "RITIRO";
      const deliveryFee  = (o.delivery_fee != null) ? Number(o.delivery_fee) : deliveryFeeFor(tipoConsegna);
      const totale       = (Number(o.totale) > 0) ? Number(o.totale) : calcolaTotaleOrdine(o.items || [], tipoConsegna);
      const res = await sbUpsert("storico", {
        orden_id: o.id || "", nombre: o.nombre || "", tel: o.tel || o.wa_id || "", canal: o.canal || "WA",
        items: o.items || [], nota: o.nota || "", hora: o.hora || "", estado: "CHIUSO_FORZATO",
        totale, delivery_fee: deliveryFee, tipo_consegna: tipoConsegna,
        fecha: oggi, dia_semana: diaSemana, fascia_ora: fasciaOraDa(o.hora), ts: o.ts || Date.now()
      }, "orden_id,fecha");
      if (!Array.isArray(res) || res.length === 0) erroriAttivi.push("ordine_attivo:" + (o.id || "?"));
    }
    if (erroriAttivi.length > 0) {
      return { success: false, errori: erroriAttivi, conv_archiviate: archiviate, ordini_storico: ordArch };
    }
    // Archivia conversazioni ancora aperte
    const convAttive = await sbSelect("conv", "stato_ordine=not.in.(ritirata,confermata,chiusa)") || [];
    for (const c of (Array.isArray(convAttive) ? convAttive : [])) {
      const totale = calcolaTotale(c.items || []);
      await sbUpsert("archivio_conv", { data_servizio: oggi, wa_id: c.wa_id || "", nombre: c.nombre || "", chat: c.chat || [], items: c.items || [], totale, hora: c.hora || "", stato_finale: "CHIUSO_FORZATO", n_messaggi: (c.chat || []).length, ts: c.ts || Date.now() });
    }
    await sbDelete("conv", "stato_ordine=not.in.(ritirata,confermata,chiusa)");
    await sbDelete("wa_msgs", "stato=neq.COMPLETATO");
    await sbDelete("ordenes", "estado=not.in.(RETIRADO,COMPLETADO)");
  }

  // Salva il timestamp di chiusura — creaOrdine userà questo per resettare il contatore
  await sbUpsert("config", { chiave: "ORDER_RESET_TS", valore: String(Date.now()) }, "chiave");

  // Resetta stato driver — fine serata il driver è libero
  await sbUpsert("config", { chiave: "DRIVER_STATO", valore: JSON.stringify({ stato: "LIBERO" }) }, "chiave");

  return { success: true, data: oggi, conv_archiviate: archiviate, ordini_storico: ordArch };
}

// Data Madrid in formato YYYY-MM-DD — usata da chiudiServizioGuarded.
function madridDateStr(d = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const y = parts.find(p => p.type === "year").value;
  const m = parts.find(p => p.type === "month").value;
  const day = parts.find(p => p.type === "day").value;
  return `${y}-${m}-${day}`;
}

// Wrapper idempotente: se LAST_CLOSE_DATE in config = oggi (Madrid), no-op.
// Usato da cron 23:50 e dal catch-up all'avvio del server, così se Railway riavvia
// e il setTimeout muore, al primo restart successivo la chiusura viene recuperata.
//
// LAST_CLOSE_DATE viene settato SOLO se siamo dentro la "finestra di chiusura"
// (ora Madrid 22:00-06:59) oppure se è stato archiviato almeno qualcosa. Questo
// evita che una chiamata mattutina (es. trigger esterno alle 10) marchi il giorno
// come "chiuso" e blocchi la chiusura serale legittima alle 23:50.
async function chiudiServizioGuarded(deleteAttivi, source) {
  const oggi = madridDateStr();
  const cfg = await sbSelect("config", "chiave=eq.LAST_CLOSE_DATE");
  const last = cfg?.[0]?.valore || "";
  if (last === oggi) {
    console.log(`[chiudiServizioGuarded ${source}] già chiuso oggi (${oggi}) — skip`);
    return { skipped: true, reason: "already_closed_today", data: oggi };
  }
  console.log(`[chiudiServizioGuarded ${source}] avvio chiusura (last=${last}, oggi=${oggi})`);
  const res = await chiudiServizio(deleteAttivi);

  const madridHourStr = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", hour: "2-digit", hour12: false }).format(new Date());
  const h = parseInt(madridHourStr, 10);
  const inFinestraChiusura = (h >= 22) || (h < 7);
  const haArchiviato = (res.conv_archiviate || 0) + (res.ordini_storico || 0) > 0;
  if (res.success && (inFinestraChiusura || haArchiviato)) {
    await sbUpsert("config", { chiave: "LAST_CLOSE_DATE", valore: oggi }, "chiave");
    console.log(`[chiudiServizioGuarded ${source}] LAST_CLOSE_DATE settato a ${oggi}`);
  } else if (res.success) {
    console.log(`[chiudiServizioGuarded ${source}] success ma fuori finestra e 0 archiviati — LAST_CLOSE_DATE NON aggiornato`);
  }
  return res;
}

module.exports = { scanServizio, chiudiServizio, chiudiServizioGuarded, backupSerata, madridDateStr };
