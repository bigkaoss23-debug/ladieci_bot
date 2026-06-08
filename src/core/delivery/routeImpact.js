// ===============================================================
// routeImpact.js — Premium Planner route-impact engine (PURO/offline)
// ===============================================================
// Mattone PURO/offline del motore Premium Planner (vedi
// PREMIUM_PLANNER_STRATEGIC_LAYER_DESIGN.md §B). NON wired a index.js,
// nessun path live, nessun DB/fetch/env/router. ZERO import: il route
// model è interamente contenuto nell'input fixture.
//
// RUOLO: dato un candidato giro (fermate ordinate + tempi di viaggio già
// noti dall'input), ricalcola l'INTERA rotta e produce dati GIÀ CALCOLATI:
//   - ETA per ogni fermata;
//   - slip per fermata rispetto a `promised` (+ tolleranza), slipLabel "+N";
//   - driverReturn, routeMin;
//   - capacity { pizzas "x/y", routeMin, limitMin, state };
//   - status (compatible|ajuste|no_recomendado|lleno), blocked;
//   - warning/explanation già pronti per il mapper/frontend.
// Il frontend NON ricalcola: legge. Questo è backend/motore, quindi calcola.
//
// LIMITI / ASSUNZIONI ONESTE (vedi FINDINGS nel report):
//   1. NON fa routing Google. I tempi di viaggio (`travelFromPrevMin`,
//      `returnTravelMin`) arrivano dall'input: è uno schema a zone, non una
//      matrice punto-punto reale.
//   2. CAPACITY SOURCE: il limite pizze/durata arriva dall'INPUT
//      (`capacity.maxPizzas`, `capacity.routeMinLimit`). L'helper NON importa
//      `ZONE_DELIVERY` né `DEFAULTS`: resta agnostico per non legarsi a UNA
//      delle due fonti divergenti (drift capacity, vedi design §B.6). È il
//      CALLER che deve passare i limiti dalla fonte di verità scelta
//      (consigliata: ZONE_DELIVERY in zones.js).
//   3. PIZZA-QUALITY WINDOW: non esiste forno_out per-fermata in questo input
//      minimale. Proxy usato: il tempo che la pizza più "vecchia" resta in
//      transito = (eta ultima fermata − startTime). Se supera
//      `capacity.pizzaQualityLimitMin` → rischio qualità. È un'ASSUNZIONE
//      esplicita, non un modello forno reale (vedi design §B.6).
//   4. NON tocca `planner.js`, `simulateDriverSchedule` né alcun path live.
//      `simulateDriverSchedule` aggrega solo same-zone-slot (zones.js) quindi
//      non modella questa rotta cross-zone: per questo il route model è qui.
//
// NAMING: `zone` (Q1..Q5). NIENTE `canal` (sorgente WA/MANUAL): non pertinente.
// ===============================================================
"use strict";

// ── Helper temporali (service-day-aware, coerenti con planner.toSvc/fromSvc) ──
// Servizio serale a cavallo di mezzanotte: 00:00–05:59 → +24h.
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
function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// Limite numerico VALIDO o null. CRITICO: `Number(null)===0`, `Number("")===0`,
// `Number(false)===0` sono trappole — `Number.isFinite(Number(x))` tratterebbe
// null/""/false come 0, e un limite 0 fa scattare "full"/"over" falsi.
// Qui SOLO numeri reali (e stringhe numeriche) sono limiti; null/undefined/""/
// non-numerico → null = "limite assente / sconosciuto". Uno 0 NUMERICO reale
// resta 0 (capacità zero reale → resta lleno se le pizze superano 0).
function finiteLimit(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const s = v.trim();
    if (s === "") return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null; // null, undefined, boolean, object, array, …
}

// ── slipLabel: minuti (>0) → "+N", altrimenti "". Calcolato QUI (backend). ─────
function formatSlipLabel(minutes) {
  const n = Number(minutes);
  return Number.isFinite(n) && n > 0 ? `+${n}` : "";
}

// ── slip di una fermata rispetto alla promessa (+ tolleranza). I9-style: ──────
// ritardo sulla promessa, MAI sulla finestra del giro. Nessun `promised`
// (es. pedido attuale flessibile) → niente slip (output stabile).
function computeStopSlip(eta, promised, toleranceMin = 0) {
  const etaMin = toMin(eta);
  const promMin = toMin(promised);
  if (etaMin == null || promMin == null) {
    return { slipMin: 0, slips: false, slipLabel: "" };
  }
  const slipMin = Math.max(0, etaMin - (promMin + num(toleranceMin, 0)));
  return { slipMin, slips: slipMin > 0, slipLabel: formatSlipLabel(slipMin) };
}

// ── ETA cumulativo lungo la rotta ─────────────────────────────────────────────
// clock parte da startTime; per ogni fermata: + travelFromPrevMin → arrivo
// (eta = consegna), poi + serviceMin (sosta/handoff) prima di ripartire.
// Ritorna { routeEtas[], lastEtaMin, returnMin } in minuti service-day.
function computeRouteEtas(stops, context = {}) {
  const startMin = toMin(context.startTime);
  const tol = num(context.toleranceMin, 0);
  const list = Array.isArray(stops) ? stops : [];

  let clock = startMin != null ? startMin : 0;
  let lastEtaMin = null;
  const routeEtas = [];

  for (const s of list) {
    const stop = s || {};
    clock += num(stop.travelFromPrevMin, 0); // viaggio dalla posizione precedente
    const etaMin = clock;
    lastEtaMin = etaMin;
    const slip = computeStopSlip(fromMin(etaMin), stop.promised, tol);
    routeEtas.push({
      zone: stop.zone != null ? String(stop.zone) : null,
      label: typeof stop.label === "string" ? stop.label : "",
      eta: fromMin(etaMin),
      promised: typeof stop.promised === "string" ? stop.promised : null,
      slips: slip.slips,
      slipLabel: slip.slipLabel,
      isNew: stop.isNew === true,
      _slipMin: slip.slipMin, // interno: usato dal classifier/warning
    });
    clock += num(stop.serviceMin, 0); // sosta operativa prima di ripartire
  }

  const returnMin = clock + num(context.returnTravelMin, 0);
  return { routeEtas, startMin, lastEtaMin, returnMin };
}

// ── Capacity: classifica pizze + durata. Limiti dall'INPUT (vedi §2). ─────────
// state: "full"        se pizze oltre il max (capacità rider piena, limite NOTO);
//        "tight"       se la durata supera il limite o la qualità è a rischio;
//        "desconocida" se il limite pizze è assente/sconosciuto (NON lo trattiamo
//                      come 0 → niente "lleno" falso quando manca il dato);
//        "ok"          limite noto e rispettato.
// REGOLA: `null`/assente NON è `0`. Un `maxPizzas` mancante = capacità ignota,
// non capacità zero. Solo un `0` numerico reale resta capacità zero (→ full).
function classifyCapacity(capacityInput = {}, routeMin = null, qualityExceeded = false) {
  const c = capacityInput || {};
  const pizzas = num(c.pizzas, 0);
  const maxPizzas = finiteLimit(c.maxPizzas);
  const limitMin = finiteLimit(c.routeMinLimit);
  const rm = finiteLimit(routeMin);

  const pizzasFull = maxPizzas != null && pizzas > maxPizzas;
  const durationOver = limitMin != null && rm != null && rm > limitMin;

  let state;
  if (pizzasFull) state = "full";
  else if (durationOver || qualityExceeded) state = "tight";
  else if (maxPizzas == null) state = "desconocida"; // limite pizze ignoto, non "lleno"
  else state = "ok";

  return {
    pizzas: maxPizzas != null ? `${pizzas}/${maxPizzas}` : `${pizzas}`,
    routeMin: rm,
    limitMin,
    state,
    _pizzasFull: pizzasFull,
    _durationOver: durationOver,
  };
}

// ── Classifica lo status complessivo della rotta + blocked. ───────────────────
// Precedenza (documentata, design §B.7 + Task 5):
//   1. pizze oltre il max          → "lleno"          blocked=true  (capacità dura)
//   2. durata oltre il limite      → "no_recomendado" blocked=false (giro brutto, forzabile)
//   3. qualità pizza a rischio     → "no_recomendado" blocked=false (forzabile con avviso)
//   4. una fermata slitta          → "ajuste"         blocked=false
//   5. nessuno slip, capacity ok   → "compatible"     blocked=false
function classifyRouteImpact({ capacity, qualityExceeded, anySlip }) {
  if (capacity._pizzasFull) return { status: "lleno", blocked: true };
  if (capacity._durationOver) return { status: "no_recomendado", blocked: false };
  if (qualityExceeded) return { status: "no_recomendado", blocked: false };
  if (anySlip) return { status: "ajuste", blocked: false };
  return { status: "compatible", blocked: false };
}

// ── Warning già pronto (backend-side), in spagnolo come il contract frontend. ─
function buildWarning({ status, capacity, routeEtas, qualityExceeded }) {
  if (status === "lleno") {
    return `Giro lleno: ${capacity.pizzas} pizzas`;
  }
  if (status === "no_recomendado" && capacity._durationOver) {
    return `Ruta demasiado larga: ${capacity.routeMin} min (límite ${capacity.limitMin})`;
  }
  if (status === "no_recomendado" && qualityExceeded) {
    return "Calidad de pizza en riesgo: ruta demasiado larga para el horno";
  }
  if (status === "ajuste") {
    const slipped = routeEtas.filter((e) => e.slips);
    if (slipped.length) {
      return slipped
        .map((e) => `${e.zone || e.label || "Parada"} se mueve ${e.slipLabel} min`)
        .join(" · ");
    }
  }
  return "";
}

// ── Explanation umana (descrittiva, non normativa). ───────────────────────────
function buildExplanation({ status, routeEtas, capacity }) {
  const stopsTxt = routeEtas
    .map((e) => `${e.zone || e.label || "?"} ${e.eta || "?"}`)
    .join(" → ");
  switch (status) {
    case "lleno":
      return `Ruta llena (${capacity.pizzas} pizzas): no se puede agregar.`;
    case "no_recomendado":
      return `Ruta no recomendada (${capacity.routeMin} min). Forzable con aviso. ${stopsTxt}`;
    case "ajuste":
      return `Inserción posible con ajuste: ${stopsTxt}`;
    case "compatible":
      return `Ruta compatible sin retrasos: ${stopsTxt}`;
    default:
      return stopsTxt;
  }
}

// ── buildRouteImpact(input): orchestratore puro. ──────────────────────────────
function buildRouteImpact(input = {}) {
  const { routeEtas, startMin, lastEtaMin, returnMin } = computeRouteEtas(
    input.stops,
    {
      startTime: input.startTime,
      returnTravelMin: input.returnTravelMin,
      toleranceMin: input.toleranceMin,
    }
  );

  const driverReturnMin = returnMin;
  const routeMin =
    startMin != null && Number.isFinite(driverReturnMin)
      ? driverReturnMin - startMin
      : null;

  // Pizza-quality (proxy, §3): tempo max in transito = ultima eta − start.
  // finiteLimit: un `pizzaQualityLimitMin` null/assente NON è 0 (altrimenti
  // qualsiasi transito > 0 farebbe "no_recomendado" falso).
  const capIn = input.capacity || {};
  const qualityLimit = finiteLimit(capIn.pizzaQualityLimitMin);
  const worstTransitMin =
    startMin != null && lastEtaMin != null ? lastEtaMin - startMin : null;
  const qualityExceeded =
    qualityLimit != null && worstTransitMin != null && worstTransitMin > qualityLimit;

  const capacity = classifyCapacity(capIn, routeMin, qualityExceeded);
  const anySlip = routeEtas.some((e) => e.slips);
  const { status, blocked } = classifyRouteImpact({ capacity, qualityExceeded, anySlip });

  const warning = buildWarning({ status, capacity, routeEtas, qualityExceeded });
  const explanation = buildExplanation({ status, routeEtas, capacity });

  // routeEtas pubblici: rimuovi i campi interni (_slipMin).
  const publicEtas = routeEtas.map(({ _slipMin, ...rest }) => rest);
  // capacity pubblica: rimuovi i flag interni (_pizzasFull/_durationOver).
  const { _pizzasFull, _durationOver, ...publicCapacity } = capacity;

  return {
    routeEtas: publicEtas,
    driverReturn: fromMin(driverReturnMin),
    routeMin,
    capacity: publicCapacity,
    status,
    blocked,
    warning,
    explanation,
  };
}

// ── buildRouteImpactOpportunityFields: subset pronto per il mapper. ───────────
// Estrae SOLO i campi che `premiumPlannerOpportunities.buildPremiumOpportunity`
// consuma da un input già calcolato (routeEtas/capacity/status/blocked/warning/
// explanation). Niente wiring: è il caller futuro a comporre l'input mapper.
function buildRouteImpactOpportunityFields(impact = {}) {
  return {
    routeEtas: Array.isArray(impact.routeEtas) ? impact.routeEtas : [],
    capacity: impact.capacity || {},
    status: impact.status != null ? impact.status : null,
    blocked: impact.blocked === true,
    warning: typeof impact.warning === "string" ? impact.warning : "",
    explanation: typeof impact.explanation === "string" ? impact.explanation : "",
  };
}

module.exports = {
  toMin,
  fromMin,
  formatSlipLabel,
  computeStopSlip,
  computeRouteEtas,
  classifyCapacity,
  classifyRouteImpact,
  buildWarning,
  buildExplanation,
  buildRouteImpact,
  buildRouteImpactOpportunityFields,
};
