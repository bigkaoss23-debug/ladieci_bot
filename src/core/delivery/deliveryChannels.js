// ===============================================================
// deliveryChannels.js — Canali operativi La Dieci (Premium Planner)
// ===============================================================
// Config PURA dei canali di consegna. NESSUNA dipendenza: niente DB,
// niente fetch, niente env, niente import di moduli runtime. Non è
// wired a index.js né a nessun path live — è il primo mattone del
// motore Premium Planner (vedi PREMIUM_PLANNER_ENGINE_DESIGN.md §9).
//
// Sorgente di verità per il campo `opportunity.channel` (sur|oeste|cross)
// che il frontend renderizza senza calcolare. Frontend = renderer,
// planner/backend = motore.
//
// Schema operativo:
//   sur:   Q1 → Q2 → Q5
//   oeste: Q1 → Q3 → Q4
//   cross: zone di canali diversi (es. Q5+Q3, Q5+Q4, Q2+Q4) → no_recomendado
//   Q1 (Centro) = HUB: sede pizzería, neutra, compatibile con entrambi.
//
// NB: la mappa è uno schema a zone, non Google Maps / routing preciso.
// ===============================================================
"use strict";

// Sequenza operativa per canale (ordine di percorrenza dalla pizzería).
const CHANNELS = {
  sur: { id: "sur", label: "Canal sur", sequence: ["Q1", "Q2", "Q5"] },
  oeste: { id: "oeste", label: "Canal oeste", sequence: ["Q1", "Q3", "Q4"] },
};

// Centro: pizzería, condivisa da entrambi i canali → neutra nel calcolo.
const HUB_ZONE = "Q1";

// Mappa zona → canale. "hub" per Q1 (neutra).
const ZONE_CHANNEL = {
  Q1: "hub",
  Q2: "sur",
  Q5: "sur",
  Q3: "oeste",
  Q4: "oeste",
};

function normZone(zone) {
  return String(zone == null ? "" : zone).trim().toUpperCase();
}

// Canale di una singola zona: "sur" | "oeste" | "hub" | null (zona sconosciuta).
function getZoneChannel(zone) {
  const z = normZone(zone);
  return Object.prototype.hasOwnProperty.call(ZONE_CHANNEL, z) ? ZONE_CHANNEL[z] : null;
}

// Canale di una rotta / insieme di zone:
//   "sur" | "oeste"  se tutte le zone non-hub appartengono allo stesso canale
//   "cross"          se mescola canali diversi (es. Q2 sur + Q3 oeste)
//   null             se nessuna zona valida non-hub (solo hub, vuoto, o zona
//                    sconosciuta → indecidibile)
function routeChannel(zones) {
  const list = Array.isArray(zones) ? zones : [];
  const chans = new Set();
  for (const z of list) {
    const c = getZoneChannel(z);
    if (c === null) return null; // zona sconosciuta → non decidibile
    if (c !== "hub") chans.add(c);
  }
  if (chans.size === 0) return null; // solo hub o vuoto
  if (chans.size === 1) return chans.values().next().value;
  return "cross";
}

// Compatibile = non mescola canali. `cross` non è compatibile.
// Una rotta indecidibile (null) è trattata come NON compatibile (prudente).
function isRouteChannelCompatible(zones) {
  const ch = routeChannel(zones);
  return ch !== null && ch !== "cross";
}

// Classifica una coppia di zone: { channel, compatible }.
function classifyChannelPair(a, b) {
  const channel = routeChannel([a, b]);
  return { channel, compatible: channel !== null && channel !== "cross" };
}

// Ordina le zone secondo la sequenza operativa del loro canale
// (sur: Q1→Q2→Q5, oeste: Q1→Q3→Q4). Per rotte cross o indecidibili
// ritorna una copia nell'ordine d'ingresso (nessun riordino arbitrario).
// Zone fuori sequenza vanno in coda mantenendo l'ordine relativo.
function orderZonesByChannel(zones) {
  const list = Array.isArray(zones) ? zones.slice() : [];
  const ch = routeChannel(list);
  if (ch === null || ch === "cross") return list;
  const seq = CHANNELS[ch].sequence;
  const rank = (z) => {
    const i = seq.indexOf(normZone(z));
    return i < 0 ? seq.length : i;
  };
  // Sort stabile: confronto per rank, tie-break sull'indice originale.
  return list
    .map((z, i) => ({ z, i }))
    .sort((p, q) => rank(p.z) - rank(q.z) || p.i - q.i)
    .map((x) => x.z);
}

module.exports = {
  CHANNELS,
  HUB_ZONE,
  ZONE_CHANNEL,
  getZoneChannel,
  routeChannel,
  isRouteChannelCompatible,
  classifyChannelPair,
  orderZonesByChannel,
};
