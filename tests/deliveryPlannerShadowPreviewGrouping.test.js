// tests/deliveryPlannerShadowPreviewGrouping.test.js
// ===============================================================
// INTERNAL SHADOW PREVIEW GROUPING — offline/read-only
// Run: node tests/deliveryPlannerShadowPreviewGrouping.test.js
// ===============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const { buildShadowPreviewForOperator, _internal } = require("../src/core/delivery/shadowPreview");

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
    zones: ["Q5", "Marina"],
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

function dirtyGeo(zona) {
  return {
    type: "dirty_geo_timing",
    severity: "diagnostic",
    orderId: `TEST_GROUP_${zona}`,
    zona,
    geo_confidence: "low",
    estimate_suspect: true,
    nombre: "Persona Inventada",
    telefono: "+34000000000",
    direccion: "Calle Falsa 123",
  };
}

function riderRecovery(zona = "Q5") {
  return { type: "dirty_geo_recovery", zona, rider_available_from: "20:30" };
}

function oven(code, slot, pizzas, capacity = 4) {
  return { type: "global_oven_slot_warning", code, slot, pizzas, capacity };
}

function group(preview, type, severity) {
  return preview.groupedOperatorMessages.find((item) =>
    item.groupType === type && (!severity || item.severity === severity));
}

console.log("\n══ Grouping basics ══");
{
  const preview = buildShadowPreviewForOperator(baseShadow({
    diagnostics: [dirtyGeo("Q5"), dirtyGeo("Marina"), dirtyGeo("Q5")],
  }));
  const dirty = group(preview, "dirty_geo");
  check("1· tre dirty geo diventano un solo gruppo",
    preview.groupedOperatorMessages.filter((item) => item.groupType === "dirty_geo").length === 1 &&
      dirty.count === 3,
    JSON.stringify(preview.groupedOperatorMessages));
  check("2· titolo dirty geo aggrega Q5 / Marina",
    dirty.title === "Q5 / Marina: tiempo estimado poco fiable",
    JSON.stringify(dirty));
  check("3· hint dirty geo evita falso allarme operativo",
    /No lo interpretes como retraso real seguro/.test(dirty.operatorHint),
    JSON.stringify(dirty));
  check("4· messaggi singoli restano disponibili",
    preview.operatorMessages.length === 3,
    JSON.stringify(preview.operatorMessages));
}

console.log("\n══ Rider / oven groups ══");
{
  const preview = buildShadowPreviewForOperator(baseShadow({
    diagnostics: [
      riderRecovery("Q5"),
      riderRecovery("Marina"),
      oven("forno_soft_overload", "20:15", 5),
      oven("forno_overload_serio", "20:30", 6),
      oven("forno_overload_serio", "20:45", 7),
      oven("forno_pieno", "21:00", 8),
    ],
  }));
  check("5· rider recovery raggruppato",
    group(preview, "rider_recovery").title === "Rider reajustable cuando vuelve" &&
      group(preview, "rider_recovery").count === 2,
    JSON.stringify(preview.groupedOperatorMessages));
  check("6· oven soft/serious/hard separati correttamente",
    group(preview, "oven", "soft").count === 1 &&
      group(preview, "oven", "serious").count === 2 &&
      group(preview, "oven", "hard").count === 1,
    JSON.stringify(preview.groupedOperatorMessages));
  check("7· oven serious usa plurale franjas",
    group(preview, "oven", "serious").title === "Horno: 2 franjas muy cargadas" &&
      /Hay 2 franjas/.test(group(preview, "oven", "serious").message),
    JSON.stringify(group(preview, "oven", "serious")));
  check("8· priorità: critical prima, info dopo",
    preview.groupedOperatorMessages[0].level === "critical" &&
      preview.groupedOperatorMessages[preview.groupedOperatorMessages.length - 1].level === "info",
    JSON.stringify(preview.groupedOperatorMessages));
}

console.log("\n══ Fallback / privacy / status ══");
{
  const fallback = buildShadowPreviewForOperator(baseShadow({
    diagnostics: [{ type: "unknown_shadow_signal", code: "opaque" }],
  }));
  check("9· diagnostica ignota va in gruppo planner",
    group(fallback, "planner").title === "Avisos del planner",
    JSON.stringify(fallback.groupedOperatorMessages));

  const shadow = baseShadow({ diagnostics: [dirtyGeo("Q5"), dirtyGeo("Marina")] });
  const before = JSON.stringify(shadow);
  const preview = buildShadowPreviewForOperator(shadow);
  const out = JSON.stringify(preview);
  check("10· output grouped non contiene PII",
    !/Persona Inventada|\+34000000000|Calle Falsa/.test(out),
    out);
  check("11· raw diagnostics restano nascosti",
    preview.rawDiagnosticsHidden === true &&
      !("diagnostics" in preview) &&
      !out.includes("TEST_GROUP_"),
    out);
  check("12· status non cambia per effetto del grouping",
    buildShadowPreviewForOperator(baseShadow()).status === "ok" &&
      preview.status === "warning" &&
      buildShadowPreviewForOperator(baseShadow({
        invariants: { noDriverBeforePizza: false, noInvalidTimeFormat: true },
      })).status === "critical",
    JSON.stringify({ ok: buildShadowPreviewForOperator(baseShadow()).status, dirty: preview.status }));
  check("13· grouping non muta input originale",
    before === JSON.stringify(shadow),
    JSON.stringify(shadow));
  check("14· nessun messaggio produce gruppi vuoti",
    _internal.groupOperatorMessages([], []).length === 0 &&
      buildShadowPreviewForOperator(baseShadow()).groupedOperatorMessages.length === 0,
    JSON.stringify(buildShadowPreviewForOperator(baseShadow())));
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
  check("15· helper puro: no DB/network/env",
    NET_TOKENS.every((t) => !helperCode.includes(t)) &&
      NET_TOKENS.every((t) => !testCode.includes(t)));
  check("16· helper/test senza metodi di scrittura",
    WRITE_TOKENS.every((t) => !helperCode.includes(t)) &&
      WRITE_TOKENS.every((t) => !testCode.includes(t)));
  const UI_RE = new RegExp(["index\\.js", "ag" + "ent", "front" + "end", "app" + "33", "commit" + "writer"].join("|"), "i");
  check("17· nessun file UI o servizio web coinvolto",
    !UI_RE.test(helperSrc + testSrc));
}

console.log(`\n──────────────\n  ${pass} PASS · ${fail} FAIL\n`);
process.exit(fail ? 1 : 0);
