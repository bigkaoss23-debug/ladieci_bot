// src/core/delivery/riderSaving.js
// ===============================================================
// RIDER_SAVING_MIN — metrica INFORMATIVA (mai bloccante).
//
// Stima quanto tempo-rider si risparmia facendo gli stop di un giro COMBINATO
// (Pizzería → s1 → s2 → … → sN → Pizzería) invece di N giri SEPARATI
// (Pizzería → sᵢ → Pizzería, uno per stop).
//
//   combinedDurationMin = Σ travelFromPrevMin + Σ serviceMin + returnTravelMin
//   separateDurationMin = Σ [ leg(Pizzería→zᵢ) + serviceMinᵢ + leg(zᵢ→Pizzería) ]
//   riderSavingMin      = max(0, separateDurationMin − combinedDurationMin)
//
// Note di design:
//   - "combined" è derivato dai LEG+serviceMin (NON da routeImpact.routeMin) per
//     evitare la contaminazione da idle/attesa (clamp a `promised`). È la durata
//     di MOVIMENTO+sosta del rider, ciò che si vuole confrontare. Coincide con
//     routeMin quando non c'è attesa.
//   - serviceMin entra in entrambi → numeri "reali" per il display; nel saving si
//     cancella (saving = pura differenza di viaggio).
//   - saving NEGATIVO → clamp a 0 (informativo, mai blocca). Le durate raw restano
//     esposte così l'operatore vede i numeri sotto.
//   - se un dato manca (leg null, stop senza zona, returnTravelMin null) → i campi
//     diventano null: NON si inventa, NON si crasha.
//
// PURO: nessun IO/DB/Date. Risolve i depot-leg via deliveryLegs (static ZONE_LEGS)
// con override `travelTimes` per-tratta se presente (stessa precedenza del giro).
// ===============================================================
"use strict";

const { getDeliveryLegMin, makeLegKey, HUB_LABEL } = require("./deliveryLegs");

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Risolve una tratta depot↔zona: prima l'override esplicito `travelTimes[key]`,
// poi la matrice static. Ritorna minuti o null (mai 0 fantasma).
function resolveLeg(from, to, travelTimes) {
  const key = makeLegKey(from, to);
  const tt = travelTimes || {};
  const explicit = num(tt[key]);
  if (explicit != null) return explicit;
  return getDeliveryLegMin(from, to);
}

// Durata del giro combinato dai leg già risolti negli stop (+ sosta + rientro).
// null se manca anche un solo leg o il rientro.
function combinedDuration(stops, returnTravelMin) {
  const rt = num(returnTravelMin);
  if (rt == null) return null;
  let total = rt;
  for (const s of stops) {
    const leg = num(s && s.travelFromPrevMin);
    if (leg == null) return null;
    total += leg + (num(s.serviceMin) || 0);
  }
  return total;
}

// Durata baseline: somma dei giri singoli Pizzería→zona→Pizzería (+ sosta).
// null se manca un depot-leg o una zona.
function separateDuration(stops, travelTimes) {
  let total = 0;
  for (const s of stops) {
    const zone = s && s.zone;
    if (!zone) return null;
    const out = resolveLeg(HUB_LABEL, zone, travelTimes);
    const back = resolveLeg(zone, HUB_LABEL, travelTimes);
    if (out == null || back == null) return null;
    total += out + back + (num(s.serviceMin) || 0);
  }
  return total;
}

// API pubblica. Ritorna SEMPRE i 3 campi; null dove non calcolabile.
function computeRiderSavingForRoute({ stops, returnTravelMin, travelTimes } = {}) {
  const list = Array.isArray(stops) ? stops : [];
  if (!list.length) {
    return { riderSavingMin: null, combinedDurationMin: null, separateDurationMin: null };
  }
  const combinedDurationMin = combinedDuration(list, returnTravelMin);
  const separateDurationMin = separateDuration(list, travelTimes);
  const riderSavingMin =
    combinedDurationMin != null && separateDurationMin != null
      ? Math.max(0, separateDurationMin - combinedDurationMin)
      : null;
  return { riderSavingMin, combinedDurationMin, separateDurationMin };
}

module.exports = { computeRiderSavingForRoute };
