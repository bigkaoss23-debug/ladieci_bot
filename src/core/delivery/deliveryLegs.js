// ===============================================================
// deliveryLegs.js — Travel legs inter-zona (Premium Planner, V1 statico)
// ===============================================================
// Config PURA dei tempi di percorrenza tra nodi operativi (depot + zone).
// NESSUNA dipendenza: niente DB, fetch, env, Google, geocoding. Non è wired
// a index.js né a path live — è la fonte offline dei `travelTimes` che
// `strategicOpportunities` / il futuro adapter passano a `routeImpact`.
// Vedi PREMIUM_PLANNER_READONLY_ADAPTER_DESIGN.md §5 (FINDING travel times).
//
// PERCHÉ ESISTE: `andata_min` (snapshot ordini) è SOLO Pizzería→zona. I leg
// inter-zona ("Q2->Q5", "Q5->Pizzería") non esistono nel data model. Per V1
// usiamo una matrice statica/operativa esplicita, NON Google.
//
// REGOLA DURA — niente 0 fantasma: una tratta non definita ritorna `null`
// (mai 0). `routeImpact` tratterebbe uno 0 come leg istantaneo, falsando gli
// ETA: per questo l'assenza deve emergere come null/missing, non come 0.
//
// DIREZIONALITÀ: la matrice è DIREZIONALE (chiavi "From->To"). Per V1 i valori
// sono simmetrici, ma memorizzati per-direzione così un reverse asimmetrico
// futuro non richiede refactor.
//
// CROSS-CHANNEL: le tratte tra canali diversi (es. Q5->Q3, Q2->Q4) sono
// VOLUTAMENTE assenti. Così il generator blocca/segnala il candidato cross
// invece di fingere una rotta plausibile (coerente con deliveryChannels:
// cross = no_recomendado).
//
// NAMING: `HUB_LABEL = "Pizzería"` è il NODO DEPOT del grafo travel, NON è
// `deliveryChannels.HUB_ZONE = "Q1"` (zona Centro, hub di CANALE). Concetti
// distinti: qui è il punto di partenza/rientro del rider.
// ===============================================================
"use strict";

// Nodo depot (partenza/rientro). Coerente col token usato da
// strategicOpportunities (PIZZERIA) e col mapPath del mapper.
const HUB_LABEL = "Pizzería";

// Matrice statica V1 (minuti, stima operativa — NON Google). Direzionale.
//   - Pizzería ↔ Q1..Q5: andata/ritorno depot.
//   - leg same-channel: sur (Q1-Q2-Q5), oeste (Q3-Q4).
//   - NESSUNA tratta cross-channel (Q5↔Q3, Q2↔Q4, …): assente di proposito.
const ZONE_LEGS = {
  // depot → zone
  "Pizzería->Q1": 5,
  "Q1->Pizzería": 5,
  "Pizzería->Q2": 7,
  "Q2->Pizzería": 7,
  "Pizzería->Q3": 8,
  "Q3->Pizzería": 8,
  "Pizzería->Q4": 12,
  "Q4->Pizzería": 12,
  "Pizzería->Q5": 15,
  "Q5->Pizzería": 15,
  // sur: Q1 → Q2 → Q5 (e reverse)
  "Q1->Q2": 5,
  "Q2->Q1": 5,
  "Q2->Q5": 10,
  "Q5->Q2": 10,
  "Q1->Q5": 15,
  "Q5->Q1": 15,
  // oeste: Q3 → Q4 (e reverse)
  "Q3->Q4": 8,
  "Q4->Q3": 8,
};

// Canonicalizza un nodo: il depot (case-insensitive "pizzería"/"pizzeria") →
// "Pizzería"; una zona → uppercase trimmed. Robusto a input misti.
function normNode(node) {
  const s = String(node == null ? "" : node).trim();
  if (/^pizzer[íi]a$/i.test(s)) return HUB_LABEL;
  return s.toUpperCase();
}

// Chiave di tratta "From->To" (stesso formato di strategicOpportunities).
function makeLegKey(from, to) {
  return `${normNode(from)}->${normNode(to)}`;
}

// Esiste la tratta (direzionale)?
function hasDeliveryLeg(from, to) {
  return Object.prototype.hasOwnProperty.call(ZONE_LEGS, makeLegKey(from, to));
}

// Minuti della tratta from→to, oppure `null` se non definita (MAI 0 fantasma).
// opts.legs: matrice alternativa iniettabile (test/override); default ZONE_LEGS.
function getDeliveryLegMin(from, to, opts = {}) {
  const legs = opts.legs || ZONE_LEGS;
  const key = makeLegKey(from, to);
  const v = legs[key];
  return Number.isFinite(v) ? v : null;
}

// Costruisce travelTimes per un PATH di nodi consecutivi
// (es. ["Pizzería","Q2","Q5","Pizzería"]). Ritorna:
//   { ok, travelTimes:{ "A->B": min, … }, missing:[ "X->Y", … ] }
// travelTimes contiene SOLO tratte definite (mai null). ok=false se manca
// anche una sola tratta: il chiamante NON deve passare missing a routeImpact.
function buildTravelTimesForPath(path, opts = {}) {
  const list = Array.isArray(path) ? path : [];
  const travelTimes = {};
  const missing = [];
  for (let i = 0; i + 1 < list.length; i++) {
    const from = list[i];
    const to = list[i + 1];
    const key = makeLegKey(from, to);
    const min = getDeliveryLegMin(from, to, opts);
    if (min == null) missing.push(key);
    else travelTimes[key] = min;
  }
  return { ok: missing.length === 0, travelTimes, missing };
}

// Comodità per una rotta di sole zone: avvolge in [HUB, ...zones, HUB] e
// costruisce i travelTimes completi (depot→prima, inter-zona, ultima→depot).
function buildTravelTimesForZones(routeZones, opts = {}) {
  const zones = Array.isArray(routeZones) ? routeZones : [];
  const path = [HUB_LABEL, ...zones, HUB_LABEL];
  return buildTravelTimesForPath(path, opts);
}

module.exports = {
  HUB_LABEL,
  ZONE_LEGS,
  makeLegKey,
  hasDeliveryLeg,
  getDeliveryLegMin,
  buildTravelTimesForPath,
  buildTravelTimesForZones,
};
