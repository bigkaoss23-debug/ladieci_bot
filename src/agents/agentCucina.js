// ===============================================================
// agentCucina.js — sola lettura, logica forno
// ===============================================================

const { sbSelect } = require("../utils/supabase");
const { isBevanda, isDesert, getConversazione } = require("../utils/helpers");
// [DELIVERY-REFACTOR 2026-09-22] via simulateDriverSchedule / BUFFER_OPS_DRIVER_MIN /
// calcolaTempoGiro: la capacità delivery non simula più il rider.
const { ZONE_DELIVERY, calcolaFornoOut } = require("../utils/zones");

function pad(n) { return n < 10 ? "0" + n : "" + n; }

function oraToMin(ora) {
  if (!ora) return -1;
  const [h, m] = String(ora).split(":").map(Number);
  return h * 60 + (m || 0);
}

function slot10(ora) {
  if (!ora) return "";
  const [hStr, mStr] = String(ora).split(":");
  let h = parseInt(hStr), m = parseInt(mStr || 0);
  const mArr = Math.round(m / 10) * 10;
  // Wrap orari post-mezzanotte: tollera input come "24:35" (legacy DB sporco)
  // e ogni overflow generato dal carry mArr>=60.
  if (mArr >= 60) { h += 1; return pad(((h % 24) + 24) % 24) + ":00"; }
  return pad(((h % 24) + 24) % 24) + ":" + pad(mArr);
}

function tuttiSlotValidi() {
  const slots = [];
  for (let tot = 19 * 60 + 30; tot <= 23 * 60; tot += 10) {
    slots.push(pad(Math.floor(tot/60)%24) + ":" + pad(tot % 60));
  }
  return slots;
}

async function getStatoCliente(waId) {
  if (!waId) return { haOrdine: false };
  const rows = await sbSelect("ordenes", `wa_id=eq.${waId}&estado=in.(EN_COCINA,LISTO)&order=ts.desc&limit=1`);
  if (!rows || !Array.isArray(rows) || rows.length === 0) return { haOrdine: false };
  const o = rows[0];
  return { haOrdine: true, ordenId: o.id, estado: o.estado, items: o.items || [], hora: o.hora || "", nombre: o.nombre || "" };
}

async function getCaricoForno(oraRichiesta) {
  const MAX_PIZZE_SLOT = 4;
  const rows = await sbSelect("ordenes", "estado=eq.EN_COCINA") || [];
  const convRows = await sbSelect("conv", "stato_ordine=eq.confermata") || [];

  const pizzeSlot = {};
  function contaItems(itemsList, horaRecord) {
    if (!horaRecord) return;
    const s = slot10(horaRecord);
    if (!pizzeSlot[s]) pizzeSlot[s] = 0;
    (itemsList || []).forEach(it => {
      if (!isBevanda(it.n) && !isDesert(it.n)) pizzeSlot[s] += (Number(it.q) || 1);
    });
  }

  (Array.isArray(rows) ? rows : []).forEach(o => contaItems(o.items, o.hora));
  (Array.isArray(convRows) ? convRows : []).forEach(c => contaItems(c.items, c.hora));

  if (!oraRichiesta) return { slotAssegnato: null, pizzeOra: 0, slotRichiesto: null };

  const slotRichiesto = slot10(oraRichiesta);
  const allSlots = tuttiSlotValidi();
  let idxStart = allSlots.indexOf(slotRichiesto);
  if (idxStart < 0) idxStart = 0;

  let slotAssegnato = null;
  let fornoCompleto = true;
  for (let i = idxStart; i < allSlots.length; i++) {
    if ((pizzeSlot[allSlots[i]] || 0) < MAX_PIZZE_SLOT) {
      slotAssegnato = allSlots[i];
      fornoCompleto = false;
      break;
    }
  }

  return {
    slotAssegnato,
    fornoCompleto,
    pizzeOra: slotAssegnato ? (pizzeSlot[slotAssegnato] || 0) : 0,
    pizzeSlotRichiesto: pizzeSlot[slotRichiesto] || 0,
    slotRichiesto
  };
}

// Capacità delivery per una zona: quanti ordini stanno nello stesso slot da 10'
// della stessa zona, e qual è il primo slot con ancora posto.
//
// [DELIVERY-REFACTOR 2026-09-22] Separazione cucina / rider.
// RESTA (capacità reale, decide davvero cosa si può promettere al cliente):
//   - conteggio ordini per (zona, slot10) contro zona.maxOrdiniPerGiro
//   - aggregazione: se lo slot della zona ha ancora posto, ci si accoda
//   - forno_out = hora − durata_andata (tempo di percorrenza reale)
// RIMOSSO (assunzioni su UN rider, non fatti di cucina):
//   - lettura di config.DRIVER_STATO e il pavimento "driver rientrato": nessun
//     percorso moderno scrive più quella chiave, quindi driverInGiro era
//     comunque sempre false — la rimozione non cambia il comportamento live
//   - simulateDriverSchedule e il pavimento driverLiberoMin, che accodavano le
//     proposte dietro l'intero schedule simulato della serata
// `driverInGiro` resta nella risposta (sempre false) perché orchestrator.js lo
// usa per scegliere il testo del messaggio: l'unico motivo residuo di
// spostamento slot è la zona piena, ed è quello che il cliente si sente dire.
async function getCaricoDelivery(zonaId, oraRichiesta, tempoGiroRichiesto = null) {
  const zona = ZONE_DELIVERY.find(z => z.id === zonaId);
  if (!zona) return { slotAssegnato: oraRichiesta, slotRichiesto: oraRichiesta, zonaCompleta: false, driverInGiro: false, forno_out: null };

  // Ordini delivery attivi (per consolidazione zonale)
  const rows = await sbSelect("ordenes", "tipo_consegna=eq.DOMICILIO&estado=not.in.(RETIRADO,COMPLETATO)") || [];

  const slot10 = (min) => `${String(Math.floor(min/60)%24).padStart(2,"0")}:${String(min % 60).padStart(2,"0")}`;
  const slotMin = (h) => {
    const [hh, mm] = String(h).split(":").map(Number);
    if (!Number.isFinite(hh)) return null;
    return Math.round((hh * 60 + (mm || 0)) / 10) * 10;
  };

  // ── Conta ordini per (zona, slot10(hora)) ──────────────────────────────────
  const slotCount = {};
  for (const o of rows) {
    if (!o.zona || !o.hora) continue;
    const m = slotMin(o.hora);
    if (m == null) continue;
    slotCount[`${o.zona}|${slot10(m)}`] = (slotCount[`${o.zona}|${slot10(m)}`] || 0) + 1;
  }

  const [h, m] = String(oraRichiesta || "20:00").split(":").map(Number);
  const richiestoMin = h * 60 + (m || 0);
  const minMin = Math.ceil(richiestoMin / 10) * 10; // prossimo slot da 10 min
  const slotRichiesto = oraRichiesta;

  // ── Priorità 1: slot "caldo" — stessa zona, stesso slot10, con ancora posto ─
  // Il driver esce una volta sola per lo slot: accodarsi non costa un giro nuovo.
  const slotsZonaConPosto = Object.keys(slotCount)
    .filter(k => k.startsWith(`${zonaId}|`))
    .map(k => ({ ora: k.split("|")[1], count: slotCount[k] }))
    .map(x => ({ ...x, min: slotMin(x.ora) }))
    .filter(x => x.min != null && x.count < zona.maxOrdiniPerGiro && x.min >= richiestoMin)
    .sort((a, b) => a.min - b.min);

  if (slotsZonaConPosto.length > 0) {
    const slotAss = slotsZonaConPosto[0].ora;
    const res = calcolaFornoOut({
      tipoConsegna: "DOMICILIO",
      hora: slotAss,
      durataAndataMin: tempoGiroRichiesto,
      driverLiberoMin: 0,
    });
    return { slotAssegnato: res.hora_finale || slotAss, slotRichiesto, zonaCompleta: false, driverInGiro: false, forno_out: res.forno_out };
  }

  // ── Priorità 2: primo slot con posto in zona, dall'ora richiesta in poi ─────
  for (let min = minMin; min <= 23 * 60; min += 10) {
    const ora = slot10(min);
    if ((slotCount[`${zonaId}|${ora}`] || 0) >= zona.maxOrdiniPerGiro) continue;
    const res = calcolaFornoOut({
      tipoConsegna: "DOMICILIO",
      hora: ora,
      durataAndataMin: tempoGiroRichiesto,
      driverLiberoMin: 0,
    });
    return { slotAssegnato: res.hora_finale || ora, slotRichiesto, zonaCompleta: false, driverInGiro: false, forno_out: res.forno_out };
  }

  // Tutti gli slot pieni stasera
  return { slotAssegnato: null, slotRichiesto, zonaCompleta: true, driverInGiro: false, forno_out: null };
}

module.exports = { getStatoCliente, getCaricoForno, getCaricoDelivery, getConversazione };
