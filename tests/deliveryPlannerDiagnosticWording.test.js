// tests/deliveryPlannerDiagnosticWording.test.js
// ===============================================================
// OPERATIONAL DIAGNOSTIC WORDING — offline/read-only
// Run: node tests/deliveryPlannerDiagnosticWording.test.js
// ===============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const {
  formatDiagnosticForOperator,
  formatShadowDiagnosticsForOperator,
} = require("../src/core/delivery/diagnosticWording");

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label} ${extra}`); }
}

const dirtyGeo = {
  type: "dirty_geo_timing",
  severity: "diagnostic",
  orderId: "TEST_WORDING_Q5",
  zona: "Q5/Evershine",
  andata_min: 28,
  geo_source: "cache-street",
  geo_confidence: "low",
  estimate_suspect: true,
  nombre: "Persona Inventada",
  tel: "+34000000000",
  direccion: "Calle Falsa 123",
};

console.log("\n══ Dirty geo wording ══");
{
  const msg = formatDiagnosticForOperator(dirtyGeo);
  const all = JSON.stringify(msg).toLowerCase();
  check("1· dirty_geo_timing produce titolo corretto",
    msg.title === "Tiempo estimado poco fiable",
    JSON.stringify(msg));
  check("2· dirty_geo_timing dice chiaramente tempo stimato poco affidabile",
    /poco fiable|inflado/.test(all),
    JSON.stringify(msg));
  check("3· dirty_geo_timing non dice ritardo certo",
    !/retraso real seguro como cierto|retraso cierto|ritardo certo/i.test(JSON.stringify(msg)),
    JSON.stringify(msg));
  check("3b· dirty_geo_timing contiene tag attesi",
    msg.tags.includes("dirty_geo") && msg.tags.includes("q5") && msg.tags.includes("low_confidence"),
    JSON.stringify(msg.tags));
}

console.log("\n══ Rider recovery wording ══");
{
  const msg = formatDiagnosticForOperator({
    type: "dirty_geo_recovery",
    severity: "diagnostic",
    zona: "Q5",
    rider_available_from: "20:30",
  });
  const all = JSON.stringify(msg).toLowerCase();
  check("4· dirty_geo_recovery menziona rider che torna / riallinea futuro",
    /rider vuelve|futuro se recalcula|disponibilidad real/.test(all),
    JSON.stringify(msg));
  check("5· dirty_geo_recovery non promette di riscrivere il passato",
    !/reescribe el pasado|riscrive il passato|cambia el pasado/.test(all),
    JSON.stringify(msg));
  check("5b· dirty_geo_recovery contiene tag attesi",
    msg.tags.includes("rider_recovery") && msg.tags.includes("dirty_geo") && msg.tags.includes("future_replan"),
    JSON.stringify(msg.tags));
}

console.log("\n══ Oven wording ══");
{
  const soft = formatDiagnosticForOperator({
    type: "global_oven_slot_warning",
    code: "forno_soft_overload",
    slot: "20:30",
    pizzas: 5,
    capacity: 4,
  });
  const serious = formatDiagnosticForOperator({
    type: "global_oven_slot_warning",
    code: "forno_overload_serio",
    slot: "20:30",
    pizzas: 7,
    capacity: 4,
  });
  const hard = formatDiagnosticForOperator({
    type: "global_oven_slot_warning",
    code: "forno_pieno",
    slot: "20:30",
    pizzas: 8,
    capacity: 4,
  });
  check("6· global_oven_slot_warning 5/4 = soft wording",
    soft.title === "Horno ligeramente sobre capacidad" && soft.message.includes("retiros"),
    JSON.stringify(soft));
  check("7· global_oven_slot_warning 6–7/4 = horno muy cargado",
    serious.title === "Horno muy cargado",
    JSON.stringify(serious));
  check("8· global_oven_slot_warning 8+/4 = horno lleno",
    hard.title === "Horno lleno" && hard.level === "critical",
    JSON.stringify(hard));
  check("8b· oven warning contiene tag attesi",
    hard.tags.includes("oven") && hard.tags.includes("pickup_load") && hard.tags.includes("capacity"),
    JSON.stringify(hard.tags));
}

console.log("\n══ Fallback / batch / privacy ══");
{
  const fallback = formatDiagnosticForOperator({ type: "unknown_diagnostic" });
  check("9· fallback per diagnostic sconosciuta",
    fallback.title === "Aviso planner" && fallback.message.includes("conviene revisar"),
    JSON.stringify(fallback));

  const batch = formatShadowDiagnosticsForOperator({ diagnostics: [
    dirtyGeo,
    { type: "dirty_geo_recovery" },
    { type: "global_oven_slot_warning", code: "forno_pieno", pizzas: 8, capacity: 4 },
  ]});
  check("9b· formatShadowDiagnosticsForOperator formatta lista diagnostics",
    batch.length === 3 && batch[0].title === "Tiempo estimado poco fiable",
    JSON.stringify(batch));

  const out = JSON.stringify(batch);
  check("10· output non contiene PII",
    !/Persona Inventada|\+34000000000|Calle Falsa/.test(out),
    out);
}

console.log("\n══ Static safety ══");
{
  const helperPath = path.join(__dirname, "../src/core/delivery/diagnosticWording.js");
  const testSrc = fs.readFileSync(__filename, "utf8");
  const helperSrc = fs.readFileSync(helperPath, "utf8");
  const strip = (s) => s.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const testCode = strip(testSrc).toLowerCase();
  const helperCode = strip(helperSrc).toLowerCase();
  const NET_TOKENS = ["su" + "pabase", "fet" + "ch(", "ax" + "ios", "process" + ".env"];
  const WRITE_TOKENS = ["ins" + "ert", "up" + "date", "del" + "ete", "up" + "sert", ".r" + "pc("];
  check("11· helper è puro, senza DB/network/env",
    NET_TOKENS.every((t) => !helperCode.includes(t)) && !/require\(/.test(helperCode));
  check("11b· test wording senza DB/network/env",
    NET_TOKENS.every((t) => !testCode.includes(t)));
  check("11c· helper/test senza metodi di scrittura",
    WRITE_TOKENS.every((t) => !helperCode.includes(t)) && WRITE_TOKENS.every((t) => !testCode.includes(t)));
  check("12· wording scelto in spagnolo semplice",
    formatDiagnosticForOperator(dirtyGeo).title === "Tiempo estimado poco fiable");
}

console.log(`\n──────────────\n  ${pass} PASS · ${fail} FAIL\n`);
process.exit(fail ? 1 : 0);
