// ===============================================================
// servizio.js — chiudiServizio, scanServizio
// ===============================================================

const { sbSelect, sbUpsert, sbDelete } = require("./supabase");
const { calcolaTotale } = require("./helpers");

async function scanServizio() {
  const oggi = new Date().toISOString().slice(0, 10);
  const ordiniCompletati = await sbSelect("ordenes", "estado=in.(RETIRADO,COMPLETADO)") || [];
  const convChiuse = await sbSelect("conv", "stato_ordine=in.(ritirata,confermata,chiusa)") || [];
  const convAttive = await sbSelect("conv", "stato_ordine=not.in.(ritirata,confermata,chiusa)") || [];
  const waMsgsAttivi = await sbSelect("wa_msgs", "stato=neq.COMPLETATO") || [];

  const attiviMap = {};
  (Array.isArray(convAttive) ? convAttive : []).forEach(c => { attiviMap[c.wa_id] = { wa_id: c.wa_id, nombre: c.nombre || c.wa_id, hora: c.hora || "", stato: c.stato_ordine || "" }; });
  (Array.isArray(waMsgsAttivi) ? waMsgsAttivi : []).forEach(m => { if (!attiviMap[m.wa_id]) attiviMap[m.wa_id] = { wa_id: m.wa_id, nombre: m.nombre || m.wa_id, hora: "", stato: m.stato || "" }; });

  return { ok: true, data: oggi, completati: { ordini: Array.isArray(ordiniCompletati) ? ordiniCompletati.length : 0, conv: Array.isArray(convChiuse) ? convChiuse.length : 0 }, attivi: Object.values(attiviMap) };
}

async function chiudiServizio(deleteAttivi = false) {
  const oggi = new Date().toISOString().slice(0, 10);
  const giorniSettimana = ["domenica","lunedi","martedi","mercoledi","giovedi","venerdi","sabato"];
  const diaSemana = giorniSettimana[new Date().getDay()];
  const ora = new Date().getHours();
  const fasciaOra = ora < 20 ? "presto" : ora < 21 ? "20:00" : ora < 22 ? "21:00" : "tardivo";

  const erroriArch = [];

  const convDaArch = await sbSelect("conv", "stato_ordine=in.(ritirata,confermata,chiusa)") || [];
  let archiviate = 0;
  for (const c of (Array.isArray(convDaArch) ? convDaArch : [])) {
    const totale = calcolaTotale(c.items || []);
    const res = await sbUpsert("archivio_conv", { data_servizio: oggi, wa_id: c.wa_id || "", nombre: c.nombre || "", chat: c.chat || [], items: c.items || [], totale, hora: c.hora || "", stato_finale: c.stato_ordine || "", n_messaggi: (c.chat || []).length, ts: c.ts || Date.now() });
    if (!Array.isArray(res) || res.length === 0) erroriArch.push("conv:" + (c.wa_id || "?"));
    else archiviate++;
  }

  const ordiniDaArch = await sbSelect("ordenes", "estado=in.(RETIRADO,COMPLETADO)") || [];
  let ordArch = 0;
  for (const o of (Array.isArray(ordiniDaArch) ? ordiniDaArch : [])) {
    const totale = calcolaTotale(o.items || []);
    const res = await sbUpsert("storico", { orden_id: o.id || "", nombre: o.nombre || "", tel: o.tel || o.wa_id || "", canal: o.canal || "WA", items: o.items || [], nota: o.nota || "", hora: o.hora || "", estado: o.estado || "", totale, fecha: oggi, dia_semana: diaSemana, fascia_ora: fasciaOra, ts: o.ts || Date.now() });
    if (!Array.isArray(res) || res.length === 0) erroriArch.push("ordine:" + (o.id || "?"));
    else ordArch++;
  }

  if (erroriArch.length > 0) return { success: false, errori: erroriArch, conv_archiviate: archiviate, ordini_storico: ordArch };

  await sbDelete("conv", "stato_ordine=in.(ritirata,confermata,chiusa)");
  await sbDelete("wa_msgs", "stato=in.(COMPLETATO)");
  await sbDelete("ordenes", "estado=in.(RETIRADO,COMPLETADO)");

  if (deleteAttivi) {
    await sbDelete("conv", "stato_ordine=not.in.(ritirata,confermata,chiusa)");
    await sbDelete("wa_msgs", "stato=neq.COMPLETATO");
    await sbDelete("ordenes", "estado=not.in.(RETIRADO,COMPLETADO)");
  }

  return { success: true, data: oggi, conv_archiviate: archiviate, ordini_storico: ordArch };
}

module.exports = { scanServizio, chiudiServizio };
