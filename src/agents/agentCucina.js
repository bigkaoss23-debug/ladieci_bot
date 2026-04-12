// ===============================================================
// agentCucina.js — sola lettura, logica forno
// ===============================================================

const { sbSelect } = require("../utils/supabase");
const { isBevanda, isDesert, getConversazione } = require("../utils/helpers");

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

  let slotAssegnato = allSlots[allSlots.length - 1];
  for (let i = idxStart; i < allSlots.length; i++) {
    if ((pizzeSlot[allSlots[i]] || 0) < MAX_PIZZE_SLOT) {
      slotAssegnato = allSlots[i];
      break;
    }
  }

  return {
    slotAssegnato,
    pizzeOra: pizzeSlot[slotAssegnato] || 0,
    pizzeSlotRichiesto: pizzeSlot[slotRichiesto] || 0,
    slotRichiesto
  };
}

module.exports = { getStatoCliente, getCaricoForno, getConversazione };
