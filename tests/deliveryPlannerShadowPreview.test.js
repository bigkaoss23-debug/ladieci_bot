// tests/deliveryPlannerShadowPreview.test.js
// ===============================================================
// INTERNAL SHADOW PREVIEW — offline/read-only
// Run: node tests/deliveryPlannerShadowPreview.test.js
// ===============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const { buildShadowPreviewForOperator } = require("../src/core/delivery/shadowPreview");

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label} ${extra}`); }
}

function baseShadow(overrides = {}) {
  return {
    totalOrders: 12,
    deliveryOrders: 5,
    pickupOrders: 7,
    zones: ["Q1", "Q5"],
    trips: 3,
    warnings: [],
    differences: [],
    diagnostics: [],
    invariants: {
      noImpossibleFornoOut: true,
      noDriverBeforePizza: true,
      noRiderOverlap: true,
      noInvalidTimeFormat: true,
      noDerivedInputLeak: true,
    },
    ...overrides,
  };
}

const dirtyGeo = {
  type: "dirty_geo_timing",
  severity: "diagnostic",
  orderId: "TEST_PREVIEW_Q5",
  zona: "Q5/Evershine",
  geo_confidence: "low",
  estimate_suspect: true,
  nombre: "Persona Inventada",
  telefono: "+34000000000",
  direccion: "Calle Falsa 123",
};

console.log("\n══ Status rules ══");
{
  const ok = buildShadowPreviewForOperator(baseShadow());
  check("1· invariants verdi e nessuna diagnostic → status ok",
    ok.status === "ok" && ok.operatorMessages.length === 0,
    JSON.stringify(ok));

  const dirty = buildShadowPreviewForOperator(baseShadow({ diagnostics: [dirtyGeo] }));
  check("2· dirty geo diagnostic → status warning",
    dirty.status === "warning",
    JSON.stringify(dirty));
  check("2b· dirty geo messaggio spagnolo corretto",
    dirty.operatorMessages[0].title === "Tiempo estimado poco fiable" &&
      /No lo interpretes como retraso real seguro/.test(dirty.operatorMessages[0].operatorHint),
    JSON.stringify(dirty.operatorMessages[0]));

  const driverBeforePizza = buildShadowPreviewForOperator(baseShadow({
    invariants: { noDriverBeforePizza: false, noInvalidTimeFormat: true },
  }));
  check("6· invariant rossa noDriverBeforePizza=false → critical",
    driverBeforePizza.status === "critical",
    JSON.stringify(driverBeforePizza));

  const invalidTime = buildShadowPreviewForOperator(baseShadow({
    invariants: { noDriverBeforePizza: true, noInvalidTimeFormat: false },
  }));
  check("7· invariant rossa invalid time → critical",
    invalidTime.status === "critical",
    JSON.stringify(invalidTime));
}

console.log("\n══ Operator messages / risks ══");
{
  const recovery = buildShadowPreviewForOperator(baseShadow({
    diagnostics: [{ type: "dirty_geo_recovery", rider_available_from: "20:30" }],
  }));
  check("3· dirty geo recovery → messaggio rider vuelve / reajustable",
    recovery.operatorMessages[0].title === "Rider reajustable cuando vuelve" &&
      /rider vuelve|futuro se recalcula/.test(JSON.stringify(recovery.operatorMessages[0]).toLowerCase()),
    JSON.stringify(recovery.operatorMessages[0]));

  const soft = buildShadowPreviewForOperator(baseShadow({
    diagnostics: [{ type: "global_oven_slot_warning", code: "forno_soft_overload", slot: "20:30", pizzas: 5, capacity: 4 }],
  }));
  check("4· global oven warning 5/4 → warning soft",
    soft.status === "warning" &&
      soft.operatorMessages[0].title === "Horno ligeramente sobre capacidad" &&
      soft.keyRisks[0].severity === "warning",
    JSON.stringify(soft));

  const hard = buildShadowPreviewForOperator(baseShadow({
    diagnostics: [{ type: "global_oven_slot_warning", code: "forno_pieno", slot: "20:30", pizzas: 8, capacity: 4 }],
  }));
  check("5· global oven warning 8+/4 → warning alto",
    hard.status === "warning" &&
      hard.operatorMessages[0].title === "Horno lleno" &&
      hard.keyRisks[0].severity === "high",
    JSON.stringify(hard));

  check("11· suggestedOperatorActions coerenti",
    hard.suggestedOperatorActions.includes("Revisar si conviene mover o forzar manualmente") &&
      recovery.suggestedOperatorActions.includes("Verificar vuelta del rider"),
    JSON.stringify({ hard: hard.suggestedOperatorActions, recovery: recovery.suggestedOperatorActions }));
}

console.log("\n══ Privacy / summary / fallback ══");
{
  const shadow = baseShadow({
    diagnostics: [dirtyGeo],
    warnings: ["warning tecnico"],
    differences: [{ orderId: "TEST_PREVIEW_Q5" }],
  });
  const before = JSON.stringify(shadow);
  const preview = buildShadowPreviewForOperator(shadow);
  const out = JSON.stringify(preview);
  check("8· output non include PII",
    !/Persona Inventada|\+34000000000|Calle Falsa/.test(out),
    out);
  check("9· output non espone raw diagnostic se rawDiagnosticsHidden=true",
    preview.rawDiagnosticsHidden === true &&
      !("diagnostics" in preview) &&
      !out.includes("cache-street") &&
      !out.includes("TEST_PREVIEW_Q5"),
    out);
  check("10· summary conta ordini/delivery/ritiro/zone",
    preview.summary.totalOrders === 12 &&
      preview.summary.deliveryOrders === 5 &&
      preview.summary.pickupOrders === 7 &&
      preview.summary.zones.join(",") === "Q1,Q5" &&
      preview.summary.warningsCount === 1 &&
      preview.summary.differencesCount === 1 &&
      preview.summary.diagnosticsCount === 1,
    JSON.stringify(preview.summary));
  check("14· helper non cambia input originale",
    before === JSON.stringify(shadow),
    JSON.stringify(shadow));

  const fallback = buildShadowPreviewForOperator({});
  check("15· fallback se diagnostics mancano",
    fallback.status === "ok" &&
      fallback.summary.totalOrders === 0 &&
      Array.isArray(fallback.operatorMessages),
    JSON.stringify(fallback));
}

console.log("\n══ Static safety ══");
{
  const helperPath = path.join(__dirname, "../src/core/delivery/shadowPreview.js");
  const helperSrc = fs.readFileSync(helperPath, "utf8");
  const testSrc = fs.readFileSync(__filename, "utf8");
  const strip = (s) => s.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const helperCode = strip(helperSrc).toLowerCase();
  const testCode = strip(testSrc).toLowerCase();
  const NET_TOKENS = ["su" + "pabase", "fet" + "ch(", "ax" + "ios", "process" + ".env"];
  const WRITE_TOKENS = ["ins" + "ert", "up" + "date", "del" + "ete", "up" + "sert", ".r" + "pc("];
  check("12· helper puro: no DB/network/env",
    NET_TOKENS.every((t) => !helperCode.includes(t)));
  check("13· non importa endpoint/frontend",
    !/index\.js|agent|frontend|app33|commitwriter/i.test(helperSrc));
  check("13b· helper/test senza metodi di scrittura",
    WRITE_TOKENS.every((t) => !helperCode.includes(t)) && WRITE_TOKENS.every((t) => !testCode.includes(t)));
}

console.log(`\n──────────────\n  ${pass} PASS · ${fail} FAIL\n`);
process.exit(fail ? 1 : 0);
