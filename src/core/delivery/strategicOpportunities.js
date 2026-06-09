// ===============================================================
// strategicOpportunities.js — Premium Planner strategic candidate generator
// ===============================================================
// Mattone PURO/offline del motore Premium Planner (vedi
// PREMIUM_PLANNER_STRATEGIC_LAYER_DESIGN.md §A). NON wired a index.js,
// nessun path live, nessun DB/fetch/env/router. Dipendenze: solo config pure
// `deliveryChannels` (canale) e `deliveryLegs` (travel inter-zona V1).
//
// TRAVEL TIMES: precedenza agli espliciti `input.travelTimes`; per i buchi si
// usa `deliveryLegs` (matrice statica). Una tratta assente in entrambi (es.
// cross-channel) resta MISSING → candidato bloccato, MAI un 0 fantasma.
//
// RUOLO: generare i CANDIDATI cross-zone "di passaggio" che il planner reale
// NON produce (evaluateNewOrder fa solo join same-zone, planner.js:713).
// Esempio: ordine attuale Q2 + target futuro Q5 21:00 → candidato "Q2 entra
// prima del Q5" nel canale sur, con un `routeImpactInput` PRONTO da passare a
// `premiumPlannerBridge` (context.routeImpactInput) / `buildRouteImpact`.
//
// COSA FA:
//   - classifica il canale della rotta (sur|oeste|cross) via deliveryChannels;
//   - ordina le fermate secondo la sequenza operativa del canale;
//   - assembla `routeImpactInput` (stops + travel + capacity limiti + pizze tot);
//   - marca i candidati cross o senza dati di viaggio come `blockedCandidate`.
//
// COSA NON FA (resta a routeImpact / al resto della catena):
//   - NON calcola ETA, slip, slipLabel, status finale, capacity.state;
//   - NON applica nulla, NON crea giri, NON scrive DB, NON chiama endpoint;
//   - NON inventa fermate (la rotta = zone di currentOrder + anchor, niente Q2
//     fantasma se non è una fermata reale);
//   - NON inventa tempi di viaggio: se un leg manca, blocca il candidato.
//
// FINDING (status cross-channel, vedi report): `routeImpact` NON conosce il
// canale → per una rotta `cross` senza slip potrebbe dire "compatible". Il
// "no_recomendado" cross è una decisione STRATEGICA: qui la portiamo come
// `blockedCandidate=true` + `channel="cross"` + reason. La riconciliazione
// (strategic blockedCandidate ↔ routeImpact status) è wiring futuro.
//
// NAMING: SEMPRE `channel` (sur|oeste|cross, direzione rotta). MAI `canal`
// (sorgente WA/MANUAL): non pertinente qui.
// ===============================================================
"use strict";

const { routeChannel, orderZonesByChannel } = require("./deliveryChannels");
const { buildTravelTimesForZones } = require("./deliveryLegs");

// Nodo di partenza/rientro del rider. Coerente col mapPath del mapper
// (`["Pizzería", ...]`) e con le chiavi travelTimes ("Pizzería->Q2").
const PIZZERIA = "Pizzería";

function normZone(zone) {
  return String(zone == null ? "" : zone).trim().toUpperCase();
}
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Conversioni orario ↔ minuti. SPECCHIO ESATTO di routeImpact.js:toMin/fromMin
// (incl. la normalizzazione night-service `h<6 → +24`): la salida del rider che
// calcoliamo qui finisce nello stesso orologio di routeImpact, quindi DEVE usare
// la stessa aritmetica o i giri dopo mezzanotte slittano. Non importiamo
// routeImpact per non rompere la regola "deps minime" dichiarata in testa al file.
function toMin(hhmm) {
  if (hhmm == null) return null;
  const m = String(hhmm).trim().match(/^(\d{1,2}):([0-5]\d)$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 6) h += 24; // night-service normalization
  return h * 60 + min;
}
function fromMin(min) {
  if (min == null || !Number.isFinite(min)) return null;
  const w = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(w / 60)).padStart(2, "0")}:${String(w % 60).padStart(2, "0")}`;
}

// Chiave di viaggio "from->to" (es. "Pizzería->Q2", "Q2->Q5", "Q5->Pizzería").
function makeTravelKey(from, to) {
  return `${from}->${to}`;
}

// Tempo di viaggio dall'input fixture, oppure null se assente/non numerico.
// NON inventa: null è un segnale, non uno 0 silenzioso (routeImpact tratterebbe
// uno 0 come leg istantaneo, falsando gli ETA).
function resolveTravelTime(from, to, travelTimes) {
  const tt = travelTimes || {};
  const key = makeTravelKey(from, to);
  return num(tt[key]);
}

// Merge travelTimes: gli ESPLICITI (input) hanno PRECEDENZA per-tratta sui
// legs derivati da deliveryLegs (la matrice statica riempie solo i buchi).
function mergeTravelTimes(explicit, legs) {
  return { ...(legs || {}), ...(explicit || {}) };
}

// Risolve i travelTimes effettivi per una rotta: parte dai legs statici
// (deliveryLegs.buildTravelTimesForZones) e lascia che gli espliciti dell'input
// vincano per-tratta. deliveryLegs NON inventa: le tratte assenti (es. cross)
// NON finiscono nel merge → restano "missing" a valle (mai 0).
function resolveTravelTimesForCandidate(routeZones, context = {}) {
  const legs = buildTravelTimesForZones(routeZones); // { ok, travelTimes, missing }
  return mergeTravelTimes(context.travelTimes, legs.travelTimes);
}

// Reason testuale per le tratte mancanti (DRY tra buildCandidateForAnchor).
function missingLegReason(missing) {
  return `Tiempos de viaje incompletos: ${(missing || []).join(", ")}`;
}

// Canale della rotta: thin wrapper su deliveryChannels (fonte unica).
//   "sur" | "oeste"  → compatibile
//   "cross"          → canali misti (no_recomendado strategico)
//   null             → indecidibile (zona sconosciuta / solo hub)
function classifyCandidateChannel(routeZones) {
  return routeChannel(routeZones);
}

// Assembla il routeImpactInput per una sequenza di fermate ordinate.
// Ritorna { routeImpactInput, missingLegs[] }. Se manca anche un solo leg,
// routeImpactInput=null e missingLegs elenca le chiavi mancanti (il candidato
// verrà bloccato a monte: NON passiamo travel mancanti a routeImpact).
function buildRouteImpactInputForCandidate(orderedStops, context = {}) {
  const { startTime, travelTimes, capacity = {}, toleranceMin } = context;
  const missingLegs = [];

  let prev = PIZZERIA;
  let totalPizzas = 0;
  const stops = orderedStops.map((s) => {
    const travel = resolveTravelTime(prev, s.zone, travelTimes);
    if (travel == null) missingLegs.push(makeTravelKey(prev, s.zone));
    totalPizzas += num(s.pizzas) || 0;
    const stop = {
      id: s.id,
      zone: s.zone,
      label: typeof s.label === "string" ? s.label : "",
      isNew: s.isNew === true,
      promised: typeof s.promised === "string" ? s.promised : null,
      pizzas: num(s.pizzas) || 0,
      serviceMin: num(s.serviceMin) || 0,
      travelFromPrevMin: travel, // può essere null → blocco a valle
    };
    prev = s.zone;
    return stop;
  });

  // Rientro dall'ultima zona alla pizzería.
  const lastZone = orderedStops.length ? orderedStops[orderedStops.length - 1].zone : PIZZERIA;
  const returnTravelMin = resolveTravelTime(lastZone, PIZZERIA, travelTimes);
  if (returnTravelMin == null) missingLegs.push(makeTravelKey(lastZone, PIZZERIA));

  if (missingLegs.length) {
    return { routeImpactInput: null, missingLegs };
  }

  return {
    routeImpactInput: {
      startTime: typeof startTime === "string" ? startTime : null,
      stops,
      returnTravelMin,
      capacity: {
        pizzas: totalPizzas,
        maxPizzas: num(capacity.maxPizzas),
        routeMinLimit: num(capacity.routeMinLimit),
        pizzaQualityLimitMin: num(capacity.pizzaQualityLimitMin),
      },
      toleranceMin: num(toleranceMin) || 0,
    },
    missingLegs: [],
  };
}

// Costruisce UN candidato per (currentOrder, anchor). anchor=null → candidato
// "crear" per il solo ordine attuale (nessuna fermata di passaggio).
function buildCandidateForAnchor(currentOrder, anchor, context = {}) {
  const co = currentOrder || {};
  const kind = anchor ? "agregar" : "crear";

  // Descrittori fermata: currentOrder è il NUOVO stop; anchor è esistente.
  const rawStops = [
    { ...co, zone: normZone(co.zone), isNew: true, label: co.label || "Pedido actual" },
  ];
  if (anchor) {
    rawStops.push({ ...anchor, zone: normZone(anchor.zone), isNew: false, label: anchor.label || "" });
  }

  const routeZonesUnordered = rawStops.map((s) => s.zone);
  const channel = classifyCandidateChannel(routeZonesUnordered);

  // Ordina le fermate secondo la sequenza del canale (sur: Q1→Q2→Q5,
  // oeste: Q1→Q3→Q4). Per cross/indecidibile mantiene l'ordine d'ingresso.
  const orderedZones = orderZonesByChannel(routeZonesUnordered);
  const orderedStops = orderedZones.map((z) =>
    rawStops.find((s) => s.zone === z)
  ).filter(Boolean);
  // Difesa: se l'ordinamento ha perso/duplicato zone, ricadi sull'ordine grezzo.
  const finalStops = orderedStops.length === rawStops.length ? orderedStops : rawStops;
  const routeZones = finalStops.map((s) => s.zone);

  const mapPath = [PIZZERIA, ...routeZones];

  // Travel times effettivi: espliciti (input) con precedenza, deliveryLegs
  // riempie i buchi. Le tratte assenti in entrambi restano missing (no 0).
  const effectiveTravelTimes = resolveTravelTimesForCandidate(routeZones, context);

  // ── Salida del rider para un giro NUEVO (crear) ──────────────────────────
  // En "crear" el rider NO está ya en ruta: su salida es una variable libre. La
  // fijamos hacia atrás desde la hora prometida del pedido nuevo
  //   salida = prometido − viaje(pizzería→zona)
  // para que la entrega caiga EXACTA sobre lo prometido (slip 0), en lugar de
  // heredar startTime = prometido y generar un retraso fantasma igual al tiempo
  // de viaje (bug "+5 con pizzería vacía"). En "agregar" NO se toca: ahí la
  // salida la fija el giro EXISTENTE y el slip resultante es real y significativo.
  // Si falta el promised o el primer leg, se mantiene el startTime original.
  let effectiveStartTime = context.startTime;
  if (kind === "crear" && finalStops.length) {
    const firstStop = finalStops[0];
    const firstLegMin = resolveTravelTime(PIZZERIA, firstStop.zone, effectiveTravelTimes);
    const promisedMin = toMin(firstStop.promised);
    if (firstLegMin != null && promisedMin != null) {
      effectiveStartTime = fromMin(promisedMin - firstLegMin);
    }
  }

  const { routeImpactInput, missingLegs } = buildRouteImpactInputForCandidate(
    finalStops,
    { ...context, travelTimes: effectiveTravelTimes, startTime: effectiveStartTime }
  );

  // Blocco strategico: cross/indecidibile, o dati di viaggio incompleti.
  // Una rotta con UNA SOLA fermata è una entrega DIRECTA: no hay "canal" que
  // mezclar, así que cross/indecidible NO aplican. routeChannel da null para el
  // hub Q1 a solas (Q1 = pizzería, pertenece a sur Y oeste) → sin este caso, un
  // pedido directo a Q1/Centro salía marcado "no recomendado / canal indecidible".
  // Aquí lo tratamos como DIRECTA. Solo sigue bloqueando el viaje incompleto
  // (sin tiempo Pizzería→zona no se puede calcular ningún ETA).
  const isSingleStop = routeZones.length === 1;
  const effectiveChannel = isSingleStop && (channel === null || channel === "cross")
    ? "directa"
    : channel;
  const isCross = effectiveChannel === "cross";
  const isUndecidable = effectiveChannel === null;
  const hasMissingTravel = missingLegs.length > 0;
  const blockedCandidate = isCross || isUndecidable || hasMissingTravel;

  let reason;
  if (hasMissingTravel) {
    reason = missingLegReason(missingLegs);
  } else if (isCross) {
    reason = `Canales distintos (${routeZones.join("+")}): ruta no recomendada, forzable.`;
  } else if (isUndecidable) {
    reason = `Canal indecidible para zonas ${routeZones.join("+")}.`;
  } else if (anchor) {
    reason = `${routeZones[0]} entra antes de ${anchor.label || anchor.zone} (canal ${effectiveChannel}).`;
  } else if (isSingleStop) {
    reason = `Pedido directo ${routeZones[0]}.`;
  } else {
    reason = `Pedido directo ${routeZones[0]} (canal ${effectiveChannel}).`;
  }

  // priority: minore = migliore. Compatibile in-canale prima; cross dopo;
  // dati mancanti/indecidibile ultimi. Ranking grezzo (placeholder dichiarato).
  let priority;
  if (hasMissingTravel || isUndecidable) priority = 100;
  else if (isCross) priority = 90;
  else priority = 10;

  return {
    id: `cand-${kind}-${routeZones.join("-").toLowerCase()}${anchor ? `-${anchor.id}` : ""}`,
    kind,
    anchorId: anchor ? anchor.id : null,
    channel: effectiveChannel || "cross", // single-stop → "directa"; null multi → "cross" lato UI
    routeZones,
    mapPath,
    routeImpactInput, // null se travel incompleti
    reason,
    priority,
    blockedCandidate,
  };
}

// Genera la lista di candidati strategici dall'input.
//   - un candidato "agregar" per ogni anchor;
//   - se nessun anchor, un candidato "crear" per il solo ordine attuale.
// Ordinati per priority (compatibili prima).
function buildStrategicCandidates(input = {}) {
  const currentOrder = input.currentOrder || {};
  const anchors = Array.isArray(input.anchors) ? input.anchors : [];
  const context = {
    startTime: input.startTime,
    travelTimes: input.travelTimes,
    capacity: input.capacity,
    toleranceMin: input.toleranceMin,
  };

  const candidates = anchors.length
    ? anchors.map((a) => buildCandidateForAnchor(currentOrder, a, context))
    : [buildCandidateForAnchor(currentOrder, null, context)];

  // Sort stabile per priority (tie-break sull'ordine d'ingresso).
  return candidates
    .map((c, i) => ({ c, i }))
    .sort((p, q) => p.c.priority - q.c.priority || p.i - q.i)
    .map((x) => x.c);
}

module.exports = {
  PIZZERIA,
  makeTravelKey,
  resolveTravelTime,
  mergeTravelTimes,
  resolveTravelTimesForCandidate,
  missingLegReason,
  classifyCandidateChannel,
  buildRouteImpactInputForCandidate,
  buildCandidateForAnchor,
  buildStrategicCandidates,
};
