// ===============================================================
// agentCucina.js — sola lettura, logica forno
// ===============================================================

const { sbSelect } = require("../utils/supabase");
const { isBevanda, isDesert, getConversazione } = require("../utils/helpers");
const { ZONE_DELIVERY, calcolaTempoGiro, simulateDriverSchedule, BUFFER_OPS_DRIVER_MIN, calcolaFornoOut } = require("../utils/zones");

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

// Verifica capacità giri delivery per una zona (cascade-aware via simulateDriverSchedule).
// Consolida ordini: prima cerca slot già "caldi" (stessa zona stesso slot10 con spazio),
// poi propone il primo slot libero. Considera driver IN_GIRO + sequenza cascadeata.
async function getCaricoDelivery(zonaId, oraRichiesta, tempoGiroRichiesto = null) {
  const zona = ZONE_DELIVERY.find(z => z.id === zonaId);
  if (!zona) return { slotAssegnato: oraRichiesta, slotRichiesto: oraRichiesta, zonaCompleta: false, driverInGiro: false, forno_out: null };

  // Stato driver da config Supabase (override "real-time" se driver è fuori adesso)
  const driverRows = await sbSelect("config", "chiave=eq.DRIVER_STATO");
  let driverStato = null;
  try {
    const val = driverRows?.[0]?.valore;
    driverStato = val ? (typeof val === "string" ? JSON.parse(val) : val) : null;
  } catch(e) {}

  const driverInGiro = !!(driverStato?.stato === "IN_GIRO" && driverStato?.zona === zonaId && driverStato?.partito_alle);

  // Ordini delivery attivi (per consolidazione zonale + simulazione cascade)
  const rows = await sbSelect("ordenes", "tipo_consegna=eq.DOMICILIO&estado=not.in.(RETIRADO,COMPLETATO)") || [];

  // ── Conta ordini per (zona, slot10(hora)) — coerente con la logica di aggregazione ──
  const slotKey = (z, h) => {
    const [hh, mm] = String(h).split(":").map(Number);
    const m = hh * 60 + (mm || 0);
    const mArr = Math.round(m / 10) * 10;
    const aH = Math.floor(mArr/60)%24, aM = mArr % 60;
    return `${z}|${String(aH).padStart(2,"0")}:${String(aM).padStart(2,"0")}`;
  };
  const slotCount = {};
  for (const o of rows) {
    if (!o.zona || !o.hora) continue;
    const k = slotKey(o.zona, o.hora);
    slotCount[k] = (slotCount[k] || 0) + 1;
  }

  // ── minMin: rispetta hora richiesta + driver in giro (real-time) + driverLibero (cascade) ──
  const [h, m] = String(oraRichiesta || "20:00").split(":").map(Number);
  let minMin = h * 60 + (m || 0);

  // Override real-time: driver fuori adesso, deve tornare prima di poter ripartire
  if (driverInGiro) {
    // Stima round-trip dal worst-case degli ordini del giro corrente (snapshot Google guida pura).
    // Round trip = 2 × guida + buffer ops al cliente.
    // Fallback zona.tempoGiro (×2 + buffer) se nessun ordine ha durata_andata_min.
    const partitoMs = new Date(driverStato.partito_alle).getTime();
    const ordiniGiroCorrente = (rows || []).filter(o =>
      o && o.zona === zonaId && o.ts && Number(o.ts) >= partitoMs - 5 * 60000
    );
    const durateSnap = ordiniGiroCorrente
      .map(o => o.durata_andata_min)
      .filter(v => v != null);
    const roundTripMin = durateSnap.length > 0
      ? Math.max(...durateSnap) * 2 + BUFFER_OPS_DRIVER_MIN
      : zona.tempoGiro * 2 + BUFFER_OPS_DRIVER_MIN;
    const rientro = new Date(partitoMs + roundTripMin * 60000);
    if (rientro > new Date()) {
      const rientroMin = rientro.getHours() * 60 + rientro.getMinutes();
      minMin = Math.max(minMin, rientroMin + 5);
    }
  }

  // Simulazione cascade: quando è realmente libero il driver dopo tutti gli ordini in DB?
  const sim = simulateDriverSchedule(rows);
  minMin = Math.max(minMin, sim.driverLiberoMin);
  minMin = Math.ceil(minMin / 10) * 10; // arrotonda al prossimo slot da 10 min

  const slotRichiesto = oraRichiesta;
  const slot10 = (min) => `${String(Math.floor(min/60)%24).padStart(2,"0")}:${String(min % 60).padStart(2,"0")}`;

  // ── Priorità 1: slot "caldo" — stessa zona, stesso slot10, con spazio (aggregazione) ──
  // Cerco tra i giri esistenti uno con same-zone same-slot e count < max
  // Nota: usiamo slot10 (non hora esatta) per coerenza con aggregazione simulate.
  const giriSameZona = sim.giri
    .filter(g => g.zona === zonaId && g.count < zona.maxOrdiniPerGiro && g.horaMin >= (h*60 + (m||0)))
    .sort((a, b) => a.horaMin - b.horaMin);

  if (giriSameZona.length > 0) {
    const slotAss = slot10(giriSameZona[0].horaMin);
    const res = calcolaFornoOut({
      tipoConsegna: "DOMICILIO",
      hora: slotAss,
      durataAndataMin: tempoGiroRichiesto,
      driverLiberoMin: sim.driverLiberoMin
    });
    // Se calcolaFornoOut ha slittato, allineiamo anche lo slot: l'invariante
    // hora=forno_out+andata vale per il consumatore dell'output (orchestrator).
    return { slotAssegnato: res.hora_finale || slotAss, slotRichiesto, zonaCompleta: false, driverInGiro, forno_out: res.forno_out };
  }

  // ── Priorità 2: primo slot vuoto >= minMin con spazio in zona ──
  // Dato che minMin = driverLiberoMin (cascade-aware), qualsiasi slot >= minMin
  // è libero dal punto di vista driver. Resta da verificare capacità giro stessa zona.
  for (let min = minMin; min <= 23 * 60; min += 10) {
    const ora = slot10(min);
    if ((slotCount[`${zonaId}|${ora}`] || 0) >= zona.maxOrdiniPerGiro) continue;
    const res = calcolaFornoOut({
      tipoConsegna: "DOMICILIO",
      hora: ora,
      durataAndataMin: tempoGiroRichiesto,
      driverLiberoMin: sim.driverLiberoMin
    });
    return { slotAssegnato: res.hora_finale || ora, slotRichiesto, zonaCompleta: false, driverInGiro, forno_out: res.forno_out };
  }

  // Tutti gli slot pieni stasera
  return { slotAssegnato: null, slotRichiesto, zonaCompleta: true, driverInGiro, forno_out: null };
}

module.exports = { getStatoCliente, getCaricoForno, getCaricoDelivery, getConversazione };
