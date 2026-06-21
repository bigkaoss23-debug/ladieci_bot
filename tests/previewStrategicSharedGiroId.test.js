// tests/previewStrategicSharedGiroId.test.js
// ===============================================================
// SHARED_GIRO_ID_MULTI_ORDER — el preview estratégico trata un giro (varias órdenes
// con el MISMO manual_giro_id) como UNA entidad: al añadir un pedido nuevo propone
// la ruta del giro ENTERO (todas las paradas), con giroId estable compartido,
// per-stop slip, salida fuente de verdad (no se adelanta) y cocina freeze por giro.
// Órdenes sin manual_giro_id → comportamiento legacy (anclas separadas).
// Run: node tests/previewStrategicSharedGiroId.test.js
// ===============================================================
"use strict";

const { previewStrategicOpportunities } = require("../src/agents/previewStrategicOpportunities");

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? " — " + extra : ""}`); }
}

const TRAVEL = {
  "Pizzería->Q1": 5, "Q1->Q2": 6, "Q2->Q5": 10, "Q5->Pizzería": 15,
  "Q2->Pizzería": 12, "Q1->Q5": 18, "Q1->Pizzería": 8, "Pizzería->Q2": 8, "Pizzería->Q5": 20,
};
const CURRENT_Q1 = { tipoConsegna: "DOMICILIO", zone: "Q1", hora: "21:50", pizzas: 1 };

// Giro G-TEST-1 = Q5 + Q2 (mismo manual_giro_id), ambos EN_COCINA, salida 21:45.
function giroAnchors(manualGiroId) {
  return [
    { id: "#Q5", zona: "Q5", estado: "EN_COCINA", hora: "22:00", promised: "22:00", salida_driver_estimada: "21:45", entrega_estimada: "22:00", durata_andata_min: 15, pizzas: 1, manual_giro_id: manualGiroId },
    { id: "#Q2", zona: "Q2", estado: "EN_COCINA", hora: "21:56", promised: "21:56", salida_driver_estimada: "21:45", entrega_estimada: "21:56", durata_andata_min: 10, pizzas: 1, manual_giro_id: manualGiroId },
  ];
}

(async () => {
  // ── 1) Giro Q5+Q2 con mismo manual_giro_id + nuevo Q1 ──
  console.log("\n══ 1. giro Q5+Q2 (G-TEST-1) + nuevo Q1 → ruta del giro entero ══");
  const r = await previewStrategicOpportunities({
    currentOrderDraft: CURRENT_Q1, startTime: "21:45", now: "21:35",
    travelTimes: TRAVEL, anchors: giroAnchors("G-TEST-1"),
  });
  check("ok true", r.ok === true, JSON.stringify(r.error || r.blockers));

  const giroOpp = (r.opportunities || []).find((o) => String(o.giroId) === "G-TEST-1") || null;
  check("opp.giroId estable y compartido = manual_giro_id (G-TEST-1)", !!giroOpp,
    `giroIds=${JSON.stringify((r.opportunities || []).map((o) => o.giroId))}`);

  const tl = giroOpp && giroOpp.routeTimeline ? (giroOpp.routeTimeline.timeline || []) : [];
  const zonesDel = tl.filter((n) => n.type === "delivery").map((n) => String(n.zone));
  check("routeTimeline incluye Pizzería (departure)", tl.some((n) => n.type === "departure"));
  check("routeTimeline incluye regreso (return)", tl.some((n) => n.type === "return"));
  check("routeTimeline incluye Q1 + Q2 + Q5 (giro entero, no solo 1 ancla)",
    ["Q1", "Q2", "Q5"].every((z) => zonesDel.includes(z)) && zonesDel.length === 3, JSON.stringify(zonesDel));

  // 9) salida source-of-truth: la salida del giro (21:45) NO se adelanta.
  const dep = tl.find((n) => n.type === "departure");
  check("salida source-of-truth: departure = 21:45 (no se adelanta)", dep && dep.eta === "21:45", dep && dep.eta);

  // 5) per-stop slip: las anclas que se mueven traen slipLabel; el nuevo Q1 no.
  const nQ1 = tl.find((n) => n.type === "delivery" && n.zone === "Q1");
  const nQ2 = tl.find((n) => n.type === "delivery" && n.zone === "Q2");
  const nQ5 = tl.find((n) => n.type === "delivery" && n.zone === "Q5");
  check("per-stop slip: Q5 (ancla) tiene slipLabel +N", !!(nQ5 && /^\+\d/.test(String(nQ5.slipLabel || ""))), nQ5 && String(nQ5.slipLabel));
  check("per-stop slip: Q2 (ancla) tiene slipLabel +N", !!(nQ2 && /^\+\d/.test(String(nQ2.slipLabel || ""))), nQ2 && String(nQ2.slipLabel));
  check("nuevo Q1 sin slipLabel (su hora es la propuesta)", !!(nQ1 && (nQ1.slipLabel == null)), nQ1 && String(nQ1.slipLabel));

  // 6) serviceLine: UNA fila para el giro (grupo), no dos filas sueltas.
  const slGiro = (r.serviceLine || []).filter((e) => String(e.id) === "G-TEST-1");
  check("serviceLine: 1 sola fila para el giro (grupo)", slGiro.length === 1, JSON.stringify((r.serviceLine || []).map((e) => e.id)));

  // 8) cocina freeze por giro: now 21:35, salida 21:45 → 10 min → congelada; salida intacta.
  const e = slGiro[0];
  check("cocina freeze: minutesToSalida = 10", e && e.minutesToSalida === 10, e && String(e.minutesToSalida));
  check("cocina freeze: cocinaFrozen = true (<15 min)", e && e.cocinaFrozen === true);
  check("cocina freeze: salida del giro intacta 21:45", e && e.salida === "21:45", e && e.salida);

  // ── 2) Legacy: SIN manual_giro_id → anclas separadas (no merge) ──
  console.log("\n══ 2. legacy: Q5 y Q2 SIN manual_giro_id → 2 anclas separadas ══");
  const rLegacy = await previewStrategicOpportunities({
    currentOrderDraft: CURRENT_Q1, startTime: "21:45", now: "21:35",
    travelTimes: TRAVEL, anchors: giroAnchors(null),
  });
  const legacyGiroIds = (rLegacy.opportunities || []).map((o) => String(o.giroId)).sort();
  check("legacy: opp.giroId = ids de orden separados (#Q2,#Q5), sin merge",
    legacyGiroIds.includes("#Q2") && legacyGiroIds.includes("#Q5") && !legacyGiroIds.includes("G-TEST-1"),
    JSON.stringify(legacyGiroIds));
  check("legacy: serviceLine = 2 filas separadas (#Q2,#Q5)",
    (rLegacy.serviceLine || []).filter((s) => ["#Q2", "#Q5"].includes(String(s.id))).length === 2,
    JSON.stringify((rLegacy.serviceLine || []).map((s) => s.id)));
  // cada opp legacy es de 1 ancla (2 paradas: nuevo + esa ancla), nunca 3.
  const legacyMax = Math.max(...(rLegacy.opportunities || []).map((o) => (o.routeTimeline ? (o.routeTimeline.timeline || []).filter((n) => n.type === "delivery").length : 0)));
  check("legacy: ninguna opp agrupa 3 paradas (máx 2: nuevo+1 ancla)", legacyMax <= 2, String(legacyMax));

  console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
  if (fail > 0) process.exit(1);
})();
