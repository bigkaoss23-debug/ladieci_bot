// tests/previewStrategicRiderSaving.test.js
// ===============================================================
// RIDER_SAVING_MIN — metrica INFORMATIVA (mai bloccante): quanto tempo-rider si
// risparmia col giro COMBINATO vs giri SEPARATI (Pizzería→stop→Pizzería per stop).
// Campi additivi su opportunity e proposal: riderSavingMin / combinedDurationMin /
// separateDurationMin. null se non calcolabile. NON tocca blocked/status/cocina.
// Run: node tests/previewStrategicRiderSaving.test.js
// ===============================================================
"use strict";

const { previewStrategicOpportunities } = require("../src/agents/previewStrategicOpportunities");
const { computeRiderSavingForRoute } = require("../src/core/delivery/riderSaving");

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? " — " + extra : ""}`); }
}

// Matrice con TUTTI i depot-leg (così il baseline separato è deterministico).
const TRAVEL = {
  "Pizzería->Q1": 5, "Q1->Q2": 6, "Q2->Q5": 10, "Q5->Pizzería": 15,
  "Q2->Pizzería": 12, "Q1->Q5": 18, "Q1->Pizzería": 8, "Pizzería->Q2": 8, "Pizzería->Q5": 20,
  "Q2->Q1": 6, "Q5->Q2": 10, "Q5->Q1": 18,
};
const CURRENT_Q1 = { tipoConsegna: "DOMICILIO", zone: "Q1", hora: "21:50", pizzas: 1, serviceMin: 0 };

(async () => {
  // ── 1) Giro combinato Q1→Q2 (single anchor): saving positivo, numeri esatti ──
  console.log("\n══ 1. Q1 + anchor Q2 → riderSaving positivo ══");
  const r1 = await previewStrategicOpportunities({
    currentOrderDraft: CURRENT_Q1, startTime: "21:40", now: "21:30", travelTimes: TRAVEL,
    anchors: [{ id: "#Q2", zone: "Q2", promised: "21:56", pizzas: 1, serviceMin: 0, salida: "21:40", estado: "EN_COCINA" }],
  });
  check("ok true", r1.ok === true, JSON.stringify(r1.error || r1.blockers));
  const o1 = (r1.opportunities || []).find(o => String(o.giroId) === "#Q2") || null;
  check("opportunity Q2 presente", !!o1, JSON.stringify((r1.opportunities || []).map(o => o.giroId)));
  // combined = Pizz→Q1(5)+Q1→Q2(6)+Q2→Pizz(12) = 23
  // separate = (5+8)+(8+12) = 33 ; saving = 10
  check("combinedDurationMin = 23", o1 && o1.combinedDurationMin === 23, o1 && String(o1.combinedDurationMin));
  check("separateDurationMin = 33", o1 && o1.separateDurationMin === 33, o1 && String(o1.separateDurationMin));
  check("riderSavingMin = 10 (positivo)", o1 && o1.riderSavingMin === 10, o1 && String(o1.riderSavingMin));
  check("riderSaving NON blocca (blocked false, status non degradato)", o1 && o1.blocked !== true, o1 && `${o1.blocked}/${o1.status}`);

  // ── 2) Multi-order manual_giro_id Q5+Q2 + nuevo Q1 → saving del giro intero ──
  console.log("\n══ 2. giro condiviso Q5+Q2 + nuevo Q1 → riderSaving giro entero ══");
  const r2 = await previewStrategicOpportunities({
    currentOrderDraft: CURRENT_Q1, startTime: "21:45", now: "21:35", travelTimes: TRAVEL,
    anchors: [
      { id: "#Q5", zona: "Q5", estado: "EN_COCINA", hora: "22:00", promised: "22:00", salida_driver_estimada: "21:45", entrega_estimada: "22:00", durata_andata_min: 15, pizzas: 1, serviceMin: 0, manual_giro_id: "G-RS-1" },
      { id: "#Q2", zona: "Q2", estado: "EN_COCINA", hora: "21:56", promised: "21:56", salida_driver_estimada: "21:45", entrega_estimada: "21:56", durata_andata_min: 10, pizzas: 1, serviceMin: 0, manual_giro_id: "G-RS-1" },
    ],
  });
  const g = (r2.opportunities || []).find(o => String(o.giroId) === "G-RS-1") || null;
  check("opp giro condiviso presente", !!g, JSON.stringify((r2.opportunities || []).map(o => o.giroId)));
  // combined = 5+6+10+15 = 36 ; separate = (5+8)+(8+12)+(20+15)=68 ; saving=32
  check("combinedDurationMin = 36", g && g.combinedDurationMin === 36, g && String(g.combinedDurationMin));
  check("separateDurationMin = 68", g && g.separateDurationMin === 68, g && String(g.separateDurationMin));
  check("riderSavingMin = 32 (giro entero)", g && g.riderSavingMin === 32, g && String(g.riderSavingMin));
  // proposal propaga il campo
  const propG = (r2.proposals || []).find(p => p.routeTimeline && (p.routeTimeline.timeline || []).some(n => n.type === "delivery" && n.zone === "Q5"));
  check("proposals[] propaga riderSavingMin", propG && Number.isFinite(propG.riderSavingMin), propG && String(propG.riderSavingMin));

  // ── 3) Cocina freeze ancora esposto (non regressione) ──
  console.log("\n══ 3. cocina freeze invariato ══");
  const sl = (r2.serviceLine || []).find(e => String(e.id) === "G-RS-1");
  check("serviceLine cocina fields presenti", sl && sl.minutesToSalida === 10 && sl.cocinaFrozen === true && sl.cocinaState === "congelada",
    sl && JSON.stringify({ m: sl.minutesToSalida, f: sl.cocinaFrozen, s: sl.cocinaState }));

  // ── 4) routeTimeline shape invariata ──
  console.log("\n══ 4. routeTimeline shape invariata ══");
  const tl = g && g.routeTimeline ? (g.routeTimeline.timeline || []) : [];
  check("routeTimeline ha departure + return + delivery", tl.some(n => n.type === "departure") && tl.some(n => n.type === "return") && tl.some(n => n.type === "delivery"));
  check("riderSaving NON è dentro routeTimeline (shape additiva su opp)", g && g.routeTimeline && g.routeTimeline.riderSavingMin === undefined);

  // ── 5) Helper puro: single-stop → saving 0 ; impossibile → null ; no crash ──
  console.log("\n══ 5. helper puro: 0 / null / no crash ══");
  const single = computeRiderSavingForRoute({ stops: [{ zone: "Q1", serviceMin: 0, travelFromPrevMin: 5 }], returnTravelMin: 5 });
  check("single-stop → riderSavingMin 0", single.riderSavingMin === 0, JSON.stringify(single));
  const impossible = computeRiderSavingForRoute({ stops: [{ zone: "QX", serviceMin: 0, travelFromPrevMin: 5 }], returnTravelMin: 5 });
  check("zona senza leg → riderSavingMin null (no invenzione)", impossible.riderSavingMin === null, JSON.stringify(impossible));
  let noCrash = true;
  try {
    computeRiderSavingForRoute();
    computeRiderSavingForRoute({ stops: [{}], returnTravelMin: null });
    computeRiderSavingForRoute({ stops: null });
  } catch (e) { noCrash = false; }
  check("no crash su input vuoti/null", noCrash);
  // saving mai negativo (clamp a 0): combined > separate → 0
  const neg = computeRiderSavingForRoute({
    stops: [{ zone: "Q1", serviceMin: 0, travelFromPrevMin: 100 }], returnTravelMin: 100, travelTimes: { "Pizzería->Q1": 1, "Q1->Pizzería": 1 },
  });
  check("saving clamp a 0 se combinato non risparmia (mai negativo)", neg.riderSavingMin === 0, JSON.stringify(neg));

  // ── 6) Candidato bloccato/cross → campi null, no crash ──
  console.log("\n══ 6. candidato cross/bloccato → riderSaving null ══");
  const r6 = await previewStrategicOpportunities({
    currentOrderDraft: CURRENT_Q1, startTime: "21:40", now: "21:30", travelTimes: TRAVEL, includeCrossZone: true,
    anchors: [{ id: "#Q4", zone: "Q4", promised: "21:56", pizzas: 1, serviceMin: 0, salida: "21:40", estado: "EN_COCINA" }],
  });
  const o6 = (r6.opportunities || []).find(o => String(o.giroId) === "#Q4") || null;
  check("opp cross presente", !!o6, JSON.stringify((r6.opportunities || []).map(o => o.giroId)));
  check("cross → riderSavingMin null (no invenzione)", o6 && o6.riderSavingMin === null, o6 && String(o6.riderSavingMin));
  check("cross resta blocked (status non toccato da riderSaving)", o6 && o6.blocked === true, o6 && `${o6.blocked}/${o6.status}`);

  console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
  if (fail > 0) process.exit(1);
})();
