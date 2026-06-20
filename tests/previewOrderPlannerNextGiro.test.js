// tests/previewOrderPlannerNextGiro.test.js
// ===============================================================
// PREVIEW ORDER PLANNER — `nextGiroOpportunity` hint (task 44B)
// Run: node tests/previewOrderPlannerNextGiro.test.js
//
// Scenario operatore: anchor Q5 EN_COCINA 22:00 già in forno, ordine corrente Q2
// con primo slot/direct ~19:20. Atteso: hint "Próximo giro Q5 22:00".
// Read-only: nessuna write DB. Mirror dell'harness di previewOrderPlanner.test.js.
// ===============================================================
"use strict";

const { previewOrderPlanner } = require("../src/agents/previewOrderPlanner");

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? " — " + extra : ""}`); }
}

function writeGuardDb() {
  const calls = [];
  const write = async (op) => { throw new Error(`unexpected_db_write_${op}`); };
  return {
    calls,
    select: async (table) => { calls.push({ op: "select", table }); return []; },
    insert: () => write("insert"),
    update: () => write("update"),
    delete: () => write("delete"),
    upsert: () => write("upsert"),
  };
}

// deps con snapshot.orders iniettabili; direct/recommended fisso a 19:20 (Q2).
function depsWith(orders) {
  return {
    now: () => "19:00",
    db: writeGuardDb(),
    resolveDeliveryFields: async () => ({
      zona: "Q2", zona_lat: 36.74, zona_lon: -2.61,
      durata_andata_min: 8, durata_google_min: 8, durata_haversine_min: 9,
      geo_source: "google", warnings: [],
    }),
    loadPlannerSnapshot: async () => ({
      now: "19:00", orders, manual_giros: [], driver: null, driver_events: [], driver_status: null,
    }),
    evaluateNewOrder: () => ({
      selected: { type: "separate", hora: "19:20", forno_out: "19:12", salida: "19:12", status: "valid" },
      recommended: null, options: [], proximo_slot: null, warnings: [], snapshot_now: "19:00",
    }),
  };
}

const baseParams = {
  tipo_consegna: "DOMICILIO",
  direccion: "Calle Cuba 5",
  hora: "19:20",
  items: [{ id: "p", nombre: "X", cantidad: 1, categoria: "pizza" }],
  pizzas_count: 1,
  now: "19:00",
};

async function main() {
  console.log("\n══ Scenario: anchor Q5 EN_COCINA 22:00 ══");
  {
    const deps = depsWith([
      { id: "#001", tipo_consegna: "DOMICILIO", estado: "EN_COCINA", zona: "Q5", hora: "22:00", andata_min: 13, n_pizze: 1 },
    ]);
    const r = await previewOrderPlanner(baseParams, deps);
    const hint = r.nextGiroOpportunity;
    check("hint present", !!hint, JSON.stringify(r.nextGiroOpportunity));
    check("hint.zone === Q5", hint && hint.zone === "Q5", JSON.stringify(hint));
    check("hint.hora === 22:00", hint && hint.hora === "22:00", JSON.stringify(hint));
    check("hint.kind === future_giro", hint && hint.kind === "future_giro", JSON.stringify(hint));
    check("hint.cta === Ver propuestas", hint && hint.cta === "Ver propuestas", JSON.stringify(hint));
    check("hint.label", hint && hint.label === "Próximo giro Q5 22:00", JSON.stringify(hint));
    check("hint.anchorOrderId === #001", hint && hint.anchorOrderId === "#001", JSON.stringify(hint));
    check("primary recommendation intact (19:20)", r.recommendation.recommended_hora === "19:20", JSON.stringify(r.recommendation));
    check("no DB write", deps.db.calls.every((c) => c.op === "select"), JSON.stringify(deps.db.calls));
  }

  console.log("\n══ Scenario: nessun anchor → null ══");
  {
    const deps = depsWith([]);
    const r = await previewOrderPlanner(baseParams, deps);
    check("hint is null", r.nextGiroOpportunity === null, JSON.stringify(r.nextGiroOpportunity));
  }

  console.log("\n══ Scenario: due anchor → nearest future (Q1 20:30) ══");
  {
    const deps = depsWith([
      { id: "#005", tipo_consegna: "DOMICILIO", estado: "EN_COCINA", zona: "Q5", hora: "22:00", andata_min: 13, n_pizze: 1 },
      { id: "#002", tipo_consegna: "DOMICILIO", estado: "EN_COCINA", zona: "Q1", hora: "20:30", andata_min: 7, n_pizze: 1 },
    ]);
    const r = await previewOrderPlanner(baseParams, deps);
    const hint = r.nextGiroOpportunity;
    check("nearest chosen: zone Q1", hint && hint.zone === "Q1", JSON.stringify(hint));
    check("nearest chosen: hora 20:30", hint && hint.hora === "20:30", JSON.stringify(hint));
  }

  console.log("\n══ Scenario: anchor non operativo (NUEVO) → ignorato ══");
  {
    const deps = depsWith([
      { id: "#009", tipo_consegna: "DOMICILIO", estado: "NUEVO", zona: "Q5", hora: "22:00", andata_min: 13, n_pizze: 1 },
    ]);
    const r = await previewOrderPlanner(baseParams, deps);
    check("non-operational anchor ignored → null", r.nextGiroOpportunity === null, JSON.stringify(r.nextGiroOpportunity));
  }

  console.log("\n══ RITIRO: nessun hint ══");
  {
    const deps = depsWith([
      { id: "#001", tipo_consegna: "DOMICILIO", estado: "EN_COCINA", zona: "Q5", hora: "22:00", andata_min: 13, n_pizze: 1 },
    ]);
    const r = await previewOrderPlanner({ tipo_consegna: "RITIRO", hora: "21:00", items: [], pizzas_count: 1 }, deps);
    check("RITIRO hint null", r.nextGiroOpportunity === null, JSON.stringify(r.nextGiroOpportunity));
  }

  console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("UNEXPECTED TEST ERROR:", e && e.stack ? e.stack : e);
  process.exit(1);
});
