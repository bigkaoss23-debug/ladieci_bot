// tests/driverScheduleSeparation.test.js
// DELIVERY-DRIVER-SCHEDULE-SEPARATION-01
// Verifica la matematica driver service-day-aware (computeDriverFields) e che
// forno_out NON sia mai prodotto dal path driver. No DB: funzioni pure di zones.js.

const assert = require("assert");
const {
  computeDriverFields,
  toServiceDayMin,
  fromServiceDayMin,
} = require("../src/utils/zones");

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label} ${extra}`); }
}

// ── Service-day helpers ──────────────────────────────────────────
console.log("\n── Service-day helpers ──");
check("toServiceDayMin 20:00 = 1200", toServiceDayMin("20:00") === 1200);
check("toServiceDayMin 23:21 = 1401", toServiceDayMin("23:21") === 1401);
check("toServiceDayMin 00:11 = 1451", toServiceDayMin("00:11") === 1451);
check("toServiceDayMin 00:22 = 1462", toServiceDayMin("00:22") === 1462);
check("toServiceDayMin 00:25 = 1465", toServiceDayMin("00:25") === 1465);
check("fromServiceDayMin 1495 = 00:55", fromServiceDayMin(1495) === "00:55", fromServiceDayMin(1495));
check("fromServiceDayMin 1200 = 20:00", fromServiceDayMin(1200) === "20:00", fromServiceDayMin(1200));
check("fromServiceDayMin no 24/25", !/^2[45]:/.test(fromServiceDayMin(1500)), fromServiceDayMin(1500));

// ── Test A — Q5 after-midnight (replay reale 2026-05-31, Bug #2) ──
console.log("\n── Test A — Q5 after-midnight ──");
{
  const rows = [
    { id: "#012", tipo_consegna: "DOMICILIO", estado: "EN_COCINA", zona: "Q5", hora: "00:11", durata_andata_min: 12, forno_out: "00:00" },
    { id: "#006", tipo_consegna: "DOMICILIO", estado: "EN_COCINA", zona: "Q5", hora: "00:22", durata_andata_min: 13, forno_out: "00:09" },
    { id: "#007", tipo_consegna: "DOMICILIO", estado: "EN_COCINA", zona: "Q5", hora: "00:25", durata_andata_min: 12, forno_out: "00:13" },
  ];
  const f = computeDriverFields(rows);
  const o12 = f.get("#012"), o6 = f.get("#006"), o7 = f.get("#007");

  // forno_out NON è tra i campi driver
  check("A nessun campo driver è forno_out", ![o12, o6, o7].some(x => x && "forno_out" in x));

  // #012 primo giro: consegna entro hora → nessun ritardo
  check("A #012 conflicto_driver false", o12 && o12.conflicto_driver === false, JSON.stringify(o12));
  check("A #012 retraso 0", o12 && o12.retraso_estimado_min === 0, JSON.stringify(o12));

  // #006 ~ salida 00:26/27, entrega 00:39/40, retraso ~17/18, conflicto true
  check("A #006 salida ~00:2x", o6 && /^00:2[0-9]$/.test(o6.salida_driver_estimada), JSON.stringify(o6));
  check("A #006 entrega ~00:3x/4x", o6 && /^00:[34][0-9]$/.test(o6.entrega_estimada), JSON.stringify(o6));
  check("A #006 retraso 15..20", o6 && o6.retraso_estimado_min >= 15 && o6.retraso_estimado_min <= 20, JSON.stringify(o6));
  check("A #006 conflicto true", o6 && o6.conflicto_driver === true, JSON.stringify(o6));

  // #007 ~ salida 00:55/56, entrega 01:07/08, retraso ~42/43, conflicto true
  check("A #007 salida ~00:5x", o7 && /^00:5[0-9]$/.test(o7.salida_driver_estimada), JSON.stringify(o7));
  check("A #007 retraso 40..45", o7 && o7.retraso_estimado_min >= 40 && o7.retraso_estimado_min <= 45, JSON.stringify(o7));
  check("A #007 conflicto true", o7 && o7.conflicto_driver === true, JSON.stringify(o7));

  // Nessun valore con 24/25 nelle ore
  const allTimes = [o12, o6, o7].flatMap(x => x ? [x.salida_driver_estimada, x.entrega_estimada] : []);
  check("A nessun 24/25 nelle ore", allTimes.every(t => !/^2[45]:/.test(t)), JSON.stringify(allTimes));
}

// ── Test B — Q1 cluster (stessa zona/slot aggrega in un giro) ─────
console.log("\n── Test B — Q1 cluster ──");
{
  const rows = [
    { id: "#013", tipo_consegna: "DOMICILIO", estado: "EN_COCINA", zona: "Q1", hora: "22:00", durata_andata_min: 1, forno_out: "21:59" },
    { id: "#015", tipo_consegna: "DOMICILIO", estado: "EN_COCINA", zona: "Q1", hora: "22:00", durata_andata_min: 1, forno_out: "21:59" },
    { id: "#018", tipo_consegna: "DOMICILIO", estado: "EN_COCINA", zona: "Q1", hora: "22:00", durata_andata_min: 1, forno_out: "21:59" },
    { id: "#019", tipo_consegna: "DOMICILIO", estado: "EN_COCINA", zona: "Q1", hora: "22:10", durata_andata_min: 1, forno_out: "22:09" },
  ];
  const f = computeDriverFields(rows);
  // I 3 ordini 22:00 condividono lo stesso giro → stessa salida.
  const s13 = f.get("#013")?.salida_driver_estimada;
  check("B #013/#015/#018 stessa salida (aggregati)",
    s13 && f.get("#015")?.salida_driver_estimada === s13 && f.get("#018")?.salida_driver_estimada === s13,
    JSON.stringify([f.get("#013"), f.get("#015"), f.get("#018")]));
  check("B tutte le ore senza 24/25",
    [...f.values()].every(v => !/^2[45]:/.test(v.salida_driver_estimada) && !/^2[45]:/.test(v.entrega_estimada)));
  check("B nessun campo forno_out", ![...f.values()].some(v => "forno_out" in v));
}

// ── Test C — RITIRO non schedulato ───────────────────────────────
console.log("\n── Test C — Ritiro ──");
{
  const rows = [
    { id: "#020", tipo_consegna: "DOMICILIO", estado: "EN_COCINA", zona: "Q2", hora: "21:45", durata_andata_min: 8, forno_out: "21:37" },
    { id: "#021", tipo_consegna: "RITIRO",    estado: "EN_COCINA", hora: "21:50", forno_out: "21:50" },
  ];
  const f = computeDriverFields(rows);
  check("C RITIRO non in map (campi driver null/false)", !f.has("#021"));
  check("C nessun crash con RITIRO presente", f.has("#020"));
}

console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
assert.strictEqual(fail, 0, `${fail} assertion(s) failed`);
