// tests/deliveryPlannerShadowPreviewContract.test.js
// ===============================================================
// SHADOW PREVIEW UI CONTRACT — offline/read-only
// Run: node tests/deliveryPlannerShadowPreviewContract.test.js
// ===============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const { buildShadowPreviewForOperator } = require("../src/core/delivery/shadowPreview");
const { buildShadowPreviewContract } = require("../src/core/delivery/shadowPreviewContract");

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label} ${extra}`); }
}

function baseShadow(overrides = {}) {
  return {
    totalOrders: 6,
    deliveryOrders: 3,
    pickupOrders: 3,
    zones: ["Q5", "Marina"],
    trips: 2,
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

function dirtyGeo(zona = "Q5") {
  return {
    type: "dirty_geo_timing",
    severity: "diagnostic",
    orderId: `TEST_CONTRACT_${zona}`,
    zona,
    geo_confidence: "low",
    estimate_suspect: true,
    nombre: "Persona Inventada",
    telefono: "+34000000000",
    direccion: "Calle Falsa 123",
  };
}

function oven(code = "forno_overload_serio") {
  return { type: "global_oven_slot_warning", code, slot: "20:30", pizzas: 7, capacity: 4 };
}

function contractFromDiagnostics(diagnostics, extra = {}) {
  const preview = buildShadowPreviewForOperator(baseShadow({ diagnostics, ...(extra.shadow || {}) }));
  return {
    preview,
    contract: buildShadowPreviewContract({
      preview,
      generatedAt: "2026-06-04T12:00:00.000Z",
      source: { type: "backup_serata", dates: ["2026-05-28"] },
    }),
  };
}

console.log("\n══ Contract shape / safety ══");
{
  const { preview, contract } = contractFromDiagnostics([dirtyGeo("Q5"), dirtyGeo("Marina")]);
  const out = JSON.stringify(contract);
  check("1· contract ha version",
    contract.version === "shadow-preview-contract-v1",
    out);
  check("2· mode è read_only",
    contract.mode === "read_only",
    out);
  check("3· safety.readOnly true",
    contract.safety.readOnly === true,
    out);
  check("4· safety.writesEnabled false",
    contract.safety.writesEnabled === false,
    out);
  check("5· safety.rawDiagnosticsHidden true",
    contract.safety.rawDiagnosticsHidden === true,
    out);
  check("6· safety.piiIncluded false",
    contract.safety.piiIncluded === false,
    out);
  check("7· usa groupedOperatorMessages come groups",
    contract.groups.length === preview.groupedOperatorMessages.length &&
      contract.groups[0].title === preview.groupedOperatorMessages[0].title,
    JSON.stringify({ groups: contract.groups, grouped: preview.groupedOperatorMessages }));
  check("8· non espone raw diagnostics",
    !("diagnostics" in contract) &&
      !out.includes("TEST_CONTRACT_") &&
      !out.includes("geo_confidence") &&
      !out.includes("estimate_suspect"),
    out);
  check("9· non espone PII",
    !/Persona Inventada|\+34000000000|Calle Falsa/.test(out),
    out);
}

console.log("\n══ Actions / summary / source ══");
{
  const dirty = contractFromDiagnostics([dirtyGeo("Q5")]).contract;
  const hot = contractFromDiagnostics([oven("forno_overload_serio")]).contract;
  const criticalPreview = buildShadowPreviewForOperator(baseShadow({
    invariants: { noDriverBeforePizza: false, noInvalidTimeFormat: true },
  }));
  const critical = buildShadowPreviewContract({
    preview: criticalPreview,
    generatedAt: "2026-06-04T12:00:00.000Z",
    source: { type: "fixture", dates: ["2026-06-04"] },
  });
  check("10· dirty geo genera action check_rider_return",
    dirty.actions.some((item) => item.id === "check_rider_return" &&
      item.type === "manual_check" &&
      item.priority === "medium"),
    JSON.stringify(dirty.actions));
  check("11· oven genera action review_oven_load",
    hot.actions.some((item) => item.id === "review_oven_load" &&
      item.type === "manual_check" &&
      item.priority === "medium"),
    JSON.stringify(hot.actions));
  check("12· critical genera action do_not_apply_plan",
    critical.actions.some((item) => item.id === "do_not_apply_plan" &&
      item.type === "safety_stop" &&
      item.priority === "high"),
    JSON.stringify(critical.actions));
  check("13· warning genera action review_before_confirming",
    dirty.actions.some((item) => item.id === "review_before_confirming"),
    JSON.stringify(dirty.actions));
  check("14· summary contiene groupedMessagesCount",
    dirty.summary.groupedMessagesCount === dirty.groups.length &&
      typeof dirty.summary.groupedMessagesCount === "number",
    JSON.stringify(dirty.summary));
  check("15· source metadata corretto",
    dirty.source.type === "backup_serata" &&
      dirty.source.dates.join(",") === "2026-05-28" &&
      dirty.source.readOnly === true,
    JSON.stringify(dirty.source));
  check("16· output JSON serializzabile",
    JSON.parse(JSON.stringify(dirty)).version === dirty.version,
    JSON.stringify(dirty));
}

console.log("\n══ Fallback / immutability / status ══");
{
  const preview = buildShadowPreviewForOperator(baseShadow({ diagnostics: [dirtyGeo("Q5")] }));
  const before = JSON.stringify(preview);
  const contract = buildShadowPreviewContract({
    preview,
    generatedAt: "2026-06-04T12:00:00.000Z",
    source: { type: "ordenes", dates: ["2026-06-04"] },
  });
  const fallback = buildShadowPreviewContract({
    preview: { status: "warning", title: "Vista previa planner", summary: { totalOrders: 1 }, rawDiagnosticsHidden: true },
    generatedAt: "2026-06-04T12:00:00.000Z",
    source: { type: "fixture", dates: [] },
  });
  check("18· helper non muta input originale",
    before === JSON.stringify(preview),
    JSON.stringify(preview));
  check("19· fallback se mancano groups",
    Array.isArray(fallback.groups) &&
      fallback.groups.length === 0 &&
      fallback.summary.groupedMessagesCount === 0,
    JSON.stringify(fallback));
  check("20· status passa invariato",
    contract.status === preview.status &&
      fallback.status === "warning",
    JSON.stringify({ preview: preview.status, contract: contract.status, fallback: fallback.status }));
}

console.log("\n══ Static safety ══");
{
  const helperPath = path.join(__dirname, "../src/core/delivery/shadowPreviewContract.js");
  const helperSrc = fs.readFileSync(helperPath, "utf8");
  const testSrc = fs.readFileSync(__filename, "utf8");
  const strip = (s) => s.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const helperCode = strip(helperSrc).toLowerCase();
  const testCode = strip(testSrc).toLowerCase();
  const NET_TOKENS = ["su" + "pabase", "fet" + "ch(", "ax" + "ios", "process" + ".env"];
  const WRITE_TOKENS = ["ins" + "ert", "up" + "date", "del" + "ete", "up" + "sert", ".r" + "pc("];
  check("17· helper puro: no DB/network/env",
    NET_TOKENS.every((t) => !helperCode.includes(t)) &&
      NET_TOKENS.every((t) => !testCode.includes(t)));
  check("17b· helper/test senza metodi di scrittura",
    WRITE_TOKENS.every((t) => !helperCode.includes(t)) &&
      WRITE_TOKENS.every((t) => !testCode.includes(t)));
  check("17c· nessun endpoint o UI coinvolti",
    !new RegExp(["index\\.js", "ag" + "ent", "front" + "end", "app" + "33", "commit" + "writer"].join("|"), "i")
      .test(helperSrc + testSrc));
}

console.log(`\n──────────────\n  ${pass} PASS · ${fail} FAIL\n`);
process.exit(fail ? 1 : 0);
