// tests/plannerCocinaFreeze15Min.test.js
// ===============================================================
// PLANNER_COCINA_FREEZE_15_MIN — sotto 15 min dalla salida del giro la cucina è
// "congelada": la salida NON si modifica. Esposizione ADDITIVA dello stato
// (minutesToSalida / cocinaFrozen / cocinaState) sul contract strategic, più la
// banda semaforo del ritardo cliente (verde/amarillo/rojo, MAI auto-block).
//   Run: node tests/plannerCocinaFreeze15Min.test.js
// Boundary: read-only, puro. Nessun DB/rete/Date.now. La salida resta fonte di
// verità (additivo: non tocca routing/FIX2 anchor-salida-lock).
// ===============================================================
"use strict";

const {
  previewStrategicOpportunities,
  cocinaStateFor,
  minutesToSalidaOf,
  clientDelayBand,
  toClockMin,
  _internal,
} = require("../src/agents/previewStrategicOpportunities");
const { classifyRouteImpact } = require("../src/core/delivery/routeImpact");

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? " — " + extra : ""}`); }
}

const CAPACITY = { maxPizzas: 6, routeMinLimit: 60, pizzaQualityLimitMin: 60 };
const CURRENT_Q2 = { id: "draft-q2", zona: "Q2", pizzas: 1, promised: "18:54", serviceMin: 2 };
// Anchor Q5 esistente con salida 18:47 (fonte di verità via salida_driver_estimada).
const anchorQ5 = () => ([{
  id: "#005", tipo_consegna: "DOMICILIO", estado: "EN_COCINA", zona: "Q5",
  salida_driver_estimada: "18:47", entrega_estimada: "19:00", hora: "19:00",
  n_pizze: 1, andata_min: 13,
}]);
const slQ5 = (r) => (r.serviceLine || []).find((e) => e.zone === "Q5") || null;

async function main() {
  console.log("\n══ 0. costanti/helper puri ══");
  check("COCINA_FREEZE_MIN = 15", _internal.COCINA_FREEZE_MIN === 15, String(_internal.COCINA_FREEZE_MIN));
  check("minutesToSalidaOf(18:47, now 18:35) = 12", minutesToSalidaOf("18:47", toClockMin("18:35")) === 12);
  check("minutesToSalidaOf(now assente) = null", minutesToSalidaOf("18:47", null) === null);

  // ── TEST 1: now 18:35 → minutesToSalida 12 → cucina FROZEN ──────────────────
  console.log("\n══ 1. anchor Q5 salida 18:47, now 18:35 → frozen ══");
  {
    const r = await previewStrategicOpportunities({
      currentOrderDraft: CURRENT_Q2, startTime: "18:35", now: "18:35",
      capacity: CAPACITY, anchors: anchorQ5(),
    });
    const e = slQ5(r);
    check("ok true", r.ok === true);
    check("serviceLine tiene el giro Q5", !!e, JSON.stringify(r.serviceLine));
    check("minutesToSalida = 12", e && e.minutesToSalida === 12, e && String(e.minutesToSalida));
    check("cocinaFrozen = true", e && e.cocinaFrozen === true);
    check("cocinaState = 'congelada'", e && e.cocinaState === "congelada", e && e.cocinaState);
    check("salida NO cambia (18:47, source of truth)", e && e.salida === "18:47", e && e.salida);
    check("warning cocina_frozen_under_15 presente",
      (r.warnings || []).some((w) => w.code === "cocina_frozen_under_15"), JSON.stringify(r.warnings));
    check("additivo: nessun blocker (no auto-block)", Array.isArray(r.blockers) && r.blockers.length === 0);
  }

  // ── TEST 2: now 18:20 → minutesToSalida 27 → cucina ESTABLE ─────────────────
  console.log("\n══ 2. anchor Q5 salida 18:47, now 18:20 → estable ══");
  {
    const r = await previewStrategicOpportunities({
      currentOrderDraft: CURRENT_Q2, startTime: "18:20", now: "18:20",
      capacity: CAPACITY, anchors: anchorQ5(),
    });
    const e = slQ5(r);
    check("minutesToSalida = 27", e && e.minutesToSalida === 27, e && String(e.minutesToSalida));
    check("cocinaFrozen = false", e && e.cocinaFrozen === false);
    check("cocinaState = 'estable'", e && e.cocinaState === "estable", e && e.cocinaState);
    check("salida sigue 18:47", e && e.salida === "18:47", e && e.salida);
    check("SIN warning cocina_frozen (no congelada)",
      !(r.warnings || []).some((w) => w.code === "cocina_frozen_under_15"), JSON.stringify(r.warnings));
    // >15 min: piccoli aggiustamenti cucina NON ancora implementati → stable by
    // default (dichiarato): la salida resta comunque stabile.
  }

  // ── TEST 3: salida esistente = fonte di verità (mai il vecchio bug 18:41) ───
  console.log("\n══ 3. salida source of truth (mai 18:41) ══");
  {
    for (const now of ["18:35", "18:20", undefined]) {
      const r = await previewStrategicOpportunities({
        currentOrderDraft: CURRENT_Q2, startTime: now || "18:35", now,
        capacity: CAPACITY, anchors: anchorQ5(),
      });
      const e = slQ5(r);
      check(`salida 18:47 intacta (now=${now || "ausente"})`, e && e.salida === "18:47", e && e.salida);
      check(`salida NUNCA anticipada a 18:41 (now=${now || "ausente"})`, !(e && e.salida === "18:41"));
    }
    // now assente → stato non valutabile (backward-compat).
    const r0 = await previewStrategicOpportunities({
      currentOrderDraft: CURRENT_Q2, startTime: "18:35", capacity: CAPACITY, anchors: anchorQ5(),
    });
    const e0 = slQ5(r0);
    check("now assente → cocinaState null, frozen false", e0 && e0.cocinaState === null && e0.cocinaFrozen === false);
  }

  // ── TEST 4: bande ritardo cliente confermato (verde/amarillo/rojo) ──────────
  console.log("\n══ 4. bande ritardo cliente (no auto-block) ══");
  {
    check("0 min → verde", clientDelayBand(0) === "verde");
    check("3 min → verde", clientDelayBand(3) === "verde");
    check("5 min → verde", clientDelayBand(5) === "verde");
    check("6 min → amarillo", clientDelayBand(6) === "amarillo");
    check("10 min → amarillo", clientDelayBand(10) === "amarillo");
    check("11 min → rojo", clientDelayBand(11) === "rojo");
    check("12 min → rojo", clientDelayBand(12) === "rojo");
    // rojo NON è un blocco: è solo una banda (string), decisione operatore.
    check("banda è solo classificazione (string), mai boolean block", typeof clientDelayBand(20) === "string");
  }

  // ── TEST 5: i blocchi VERI restano blocchi; lo slip grande NO (forzabile) ───
  console.log("\n══ 5. true block vs forzabile ══");
  {
    // capacità impossibile (pizzas full) → blocco vero
    check("capacity _pizzasFull → blocked true (lleno)",
      classifyRouteImpact({ capacity: { _pizzasFull: true }, anySlip: false }).blocked === true);
    // slip grande (>15, banda rojo) → no_recomendado ma FORZABILE (no auto-block)
    const big = classifyRouteImpact({ capacity: {}, anySlip: true, maxSlip: 20 });
    check("slip 20 (rojo) → no_recomendado", big.status === "no_recomendado", big.status);
    check("slip 20 → blocked FALSE (decisione operatore)", big.blocked === false);
    // durata oltre limite → forzabile (no auto-block)
    check("_durationOver → blocked false (forzabile)",
      classifyRouteImpact({ capacity: { _durationOver: true }, anySlip: false }).blocked === false);
  }

  console.log(`\n══ RESULT: ${pass} passed, ${fail} failed ══\n`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
