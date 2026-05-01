// ===============================================================
// agentCucina.js — sola lettura, logica forno
// ===============================================================

const { sbSelect } = require("../utils/supabase");
const { isBevanda, isDesert, getConversazione } = require("../utils/helpers");
const { ZONE_DELIVERY } = require("../utils/zones");

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
  if (mArr >= 60) { h += 1; return pad(h) + ":00"; }
  return pad(h) + ":" + pad(mArr);
}

function tuttiSlotValidi() {
  const slots = [];
  for (let tot = 19 * 60 + 30; tot <= 23 * 60; tot += 10) {
    slots.push(pad(Math.floor(tot / 60)) + ":" + pad(tot % 60));
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

// Verifica capacità giri delivery per una zona — analogo a getCaricoForno per il forno.
// Consolida ordini: prima cerca slot già "caldi" (stessa zona, stesso orario con spazio),
// poi cerca il primo slot libero. Considera driver IN_GIRO per posticipare se necessario.
async function getCaricoDelivery(zonaId, oraRichiesta) {
  const zona = ZONE_DELIVERY.find(z => z.id === zonaId);
  if (!zona) return { slotAssegnato: oraRichiesta, slotRichiesto: oraRichiesta, zonaCompleta: false, driverInGiro: false };

  // Stato driver da config Supabase
  const driverRows = await sbSelect("config", "chiave=eq.DRIVER_STATO");
  let driverStato = null;
  try {
    const val = driverRows?.[0]?.valore;
    driverStato = val ? (typeof val === "string" ? JSON.parse(val) : val) : null;
  } catch(e) {}

  const driverInGiro = !!(driverStato?.stato === "IN_GIRO" && driverStato?.zona === zonaId && driverStato?.partito_alle);

  // Conta ordini delivery attivi per (zona, hora)
  const rows = await sbSelect("ordenes", "tipo_consegna=eq.DOMICILIO&estado=not.in.(RETIRADO,COMPLETATO)") || [];
  const slotCount = {};
  for (const o of rows) {
    if (!o.zona || !o.hora) continue;
    const key = `${o.zona}|${o.hora}`;
    slotCount[key] = (slotCount[key] || 0) + 1;
  }

  // Orario minimo: rispetta driver in giro (aspetta rientro se non è ancora tornato)
  const [h, m] = String(oraRichiesta || "20:00").split(":").map(Number);
  let minMin = h * 60 + (m || 0);

  if (driverInGiro) {
    const rientro = new Date(new Date(driverStato.partito_alle).getTime() + zona.tempoGiro * 60000);
    if (rientro > new Date()) {
      const rientroMin = rientro.getHours() * 60 + rientro.getMinutes();
      minMin = Math.max(minMin, rientroMin + 5); // +5 min buffer
    }
  }
  minMin = Math.ceil(minMin / 10) * 10; // arrotonda al prossimo slot da 10 min

  const slotRichiesto = oraRichiesta;
  const slot10 = (min) => `${String(Math.floor(min / 60)).padStart(2,"0")}:${String(min % 60).padStart(2,"0")}`;

  // Priorità 1: slot "caldo" — stessa zona, già ha ordini, c'è ancora spazio (consolidazione)
  const slotsConOrdini = Object.keys(slotCount)
    .filter(k => k.startsWith(`${zonaId}|`))
    .map(k => ({ ora: k.split("|")[1], count: slotCount[k] }))
    .filter(({ ora, count }) => {
      const [hh, mm] = ora.split(":").map(Number);
      return hh * 60 + mm >= minMin && hh * 60 + mm <= 23 * 60 && count < zona.maxOrdiniPerGiro;
    })
    .sort((a, b) => {
      const [ha, ma] = a.ora.split(":").map(Number);
      const [hb, mb] = b.ora.split(":").map(Number);
      return (ha * 60 + ma) - (hb * 60 + mb);
    });

  if (slotsConOrdini.length > 0) {
    return { slotAssegnato: slotsConOrdini[0].ora, slotRichiesto, zonaCompleta: false, driverInGiro };
  }

  // Priorità 2: primo slot libero (nuovo giro)
  for (let min = minMin; min <= 23 * 60; min += 10) {
    const ora = slot10(min);
    if ((slotCount[`${zonaId}|${ora}`] || 0) < zona.maxOrdiniPerGiro) {
      return { slotAssegnato: ora, slotRichiesto, zonaCompleta: false, driverInGiro };
    }
  }

  // Tutti i slot pieni stasera
  return { slotAssegnato: null, slotRichiesto, zonaCompleta: true, driverInGiro };
}

module.exports = { getStatoCliente, getCaricoForno, getCaricoDelivery, getConversazione };
