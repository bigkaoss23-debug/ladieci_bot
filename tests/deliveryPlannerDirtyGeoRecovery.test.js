// tests/deliveryPlannerDirtyGeoRecovery.test.js
// ===============================================================
// DIRTY GEO RIDER RECOVERY — spec/test offline · task 11
// Run: node tests/deliveryPlannerDirtyGeoRecovery.test.js
// ===============================================================
// Formalizza la regola operativa: Q5/Marina/Evershine con geo timing sporco va
// marcato a bassa confidenza; appena arriva rider_returned/rider_available, il
// futuro usa l'evento reale invece della simulazione lunga.
// ===============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const { buildPlan } = require("../src/core/delivery/planner");
const { runShadow } = require("../scripts/deliveryPlannerShadowReadOnly");

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label} ${extra}`); }
}

function delivery(o) {
  return {
    id: o.id,
    tipo_consegna: "DOMICILIO",
    estado: o.estado || "NUEVO",
    zona: o.zona,
    hora: o.hora,
    andata_min: o.andata_min,
    durata_andata_min: o.andata_min,
    n_pizze: o.n_pizze ?? 1,
    ...(o.geo_source !== undefined ? { geo_source: o.geo_source } : {}),
    ...(o.durata_google_min !== undefined ? { durata_google_min: o.durata_google_min } : {}),
    ...(o.durata_haversine_min !== undefined ? { durata_haversine_min: o.durata_haversine_min } : {}),
    ...(o.forno_out ? { forno_out: o.forno_out } : {}),
    ...(o.salida_driver_estimada ? { salida_driver_estimada: o.salida_driver_estimada } : {}),
    ...(o.entrega_estimada ? { entrega_estimada: o.entrega_estimada } : {}),
  };
}

function toMin(hhmm) {
  const m = /^(\d{1,2}):([0-5]\d)$/.exec(String(hhmm || ""));
  if (!m) return null;
  let h = Number(m[1]);
  if (h < 6) h += 24;
  return h * 60 + Number(m[2]);
}

const dirtyEvershine = (overrides = {}) => delivery({
  id: "TEST_RECOVERY_EVERSHINE_DIRTY",
  zona: "Q5",
  hora: "21:30",
  andata_min: 28,
  geo_source: "cache-street",
  durata_google_min: null,
  durata_haversine_min: 28,
  ...overrides,
});

console.log("\n══ Dirty geo diagnostic contract ══");
{
  const report = runShadow({
    fecha: "2026-06-04",
    now: "20:00",
    driver_events: [{ type: "rider_returned", at: "20:30", source: "operator_button" }],
    orders: [dirtyEvershine()],
  });
  const dirty = report.diagnostics.find((d) => d.type === "dirty_geo_timing");
  const recovery = report.diagnostics.find((d) => d.type === "dirty_geo_recovery");

  check("1· Evershine/Q5 cache-street → dirty_geo_timing",
    dirty && dirty.orderId === "TEST_RECOVERY_EVERSHINE_DIRTY",
    JSON.stringify(report.diagnostics));
  check("2· dirty geo espone geo_confidence low + estimate_suspect",
    dirty && dirty.geo_confidence === "low" && dirty.estimate_suspect === true,
    JSON.stringify(dirty));
  check("3· round trip sporco stimato ≈ 59 min, hint realistico ≈ 30",
    dirty && dirty.estimated_round_trip_min === 59 && dirty.realistic_round_trip_hint_min === 30,
    JSON.stringify(dirty));
  check("4· rider_returned produce dirty_geo_recovery diagnostic",
    recovery && recovery.rider_available_from === "20:30" && recovery.geo_confidence === "low",
    JSON.stringify(recovery));
  check("5· reason recovery chiara per operatore/report",
    recovery && /riallineare il futuro/.test(recovery.reason),
    recovery && recovery.reason);
  check("6· diagnostics non cambiano verdict se invarianti verdi",
    report.verdict === "shadow_ok",
    JSON.stringify({ verdict: report.verdict, invariants: report.invariants }));
}

console.log("\n══ Rider recovery beats dirty simulation for future ══");
{
  const initialDirtyPlan = buildPlan({
    now: "20:00",
    orders: [dirtyEvershine({ hora: "20:30" })],
  });
  const dirtyTrip = initialDirtyPlan.trips.find((t) => t.members.includes("TEST_RECOVERY_EVERSHINE_DIRTY"));
  const dirtyRoundTrip = toMin(dirtyTrip.rientro) - toMin(dirtyTrip.departure);
  check("7· stima sporca fa partire il delivery comunque",
    initialDirtyPlan.orders.TEST_RECOVERY_EVERSHINE_DIRTY.salida === "20:02",
    JSON.stringify(initialDirtyPlan.orders.TEST_RECOVERY_EVERSHINE_DIRTY));
  check("8· simulazione sporca terrebbe il rider occupato troppo a lungo",
    dirtyRoundTrip === 59 && dirtyTrip.rientro === "21:01",
    JSON.stringify(dirtyTrip));

  const futureOrder = delivery({
    id: "TEST_RECOVERY_FUTURE_Q1",
    zona: "Q1",
    hora: "20:40",
    andata_min: 4,
    geo_source: "google",
    durata_google_min: 4,
  });
  const staleSimulation = buildPlan({
    now: "20:30",
    driver: { libero_desde: dirtyTrip.rientro },
    orders: [futureOrder],
  });
  const recovered = buildPlan({
    now: "20:30",
    driver_events: [{ type: "rider_returned", at: "20:30", source: "operator_button" }],
    orders: [futureOrder],
  });
  check("9· senza evento futuro resta imprigionato nella stima sporca",
    staleSimulation.orders.TEST_RECOVERY_FUTURE_Q1.salida === "21:01",
    staleSimulation.orders.TEST_RECOVERY_FUTURE_Q1.salida);
  check("10· rider_returned batte la simulazione per il futuro",
    recovered.orders.TEST_RECOVERY_FUTURE_Q1.salida === "20:36" &&
      recovered.orders.TEST_RECOVERY_FUTURE_Q1.salida < staleSimulation.orders.TEST_RECOVERY_FUTURE_Q1.salida,
    `${recovered.orders.TEST_RECOVERY_FUTURE_Q1.salida} vs ${staleSimulation.orders.TEST_RECOVERY_FUTURE_Q1.salida}`);
  check("11· evento reale tracciato come real_event",
    recovered.driver.real_event === true && recovered.driver.source === "operator_button",
    JSON.stringify(recovered.driver));
}

console.log("\n══ Past is not rewritten ══");
{
  const semi = delivery({
    id: "TEST_RECOVERY_SEMI",
    estado: "EN_COCINA",
    zona: "Q1",
    hora: "20:40",
    andata_min: 10,
    forno_out: "20:35",
    salida_driver_estimada: "20:35",
    entrega_estimada: "20:40",
  });
  const plan = buildPlan({
    now: "20:00",
    driver_events: [{ type: "rider_returned", at: "20:30", source: "operator_button" }],
    orders: [semi],
  });
  check("12· rider_returned non anticipa il semi-congelato",
    plan.orders.TEST_RECOVERY_SEMI.salida === "20:35" && plan.orders.TEST_RECOVERY_SEMI.freeze === "SEMI_CONGELATO",
    JSON.stringify(plan.orders.TEST_RECOVERY_SEMI));
}

console.log("\n══ Static safety ══");
{
  const src = fs.readFileSync(__filename, "utf8");
  const shadowSrc = fs.readFileSync(path.join(__dirname, "../scripts/deliveryPlannerShadowReadOnly.js"), "utf8");
  const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const shadowCode = shadowSrc.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const NET_TOKENS = ["su" + "pabase", "fet" + "ch(", "ax" + "ios", "process" + ".env"];
  const WRITE_TOKENS = ["ins" + "ert", "up" + "date", "del" + "ete", "up" + "sert", ".r" + "pc("];
  check("13· nuovo test senza DB/network/env",
    NET_TOKENS.every((t) => !code.toLowerCase().includes(t)));
  check("14· helper reporting senza DB/network/env",
    NET_TOKENS.every((t) => !shadowCode.toLowerCase().includes(t)));
  check("15· nuovo test senza metodi di scrittura",
    WRITE_TOKENS.every((t) => !code.toLowerCase().includes(t)));
}

console.log(`\n──────────────\n  ${pass} PASS · ${fail} FAIL\n`);
process.exit(fail ? 1 : 0);
