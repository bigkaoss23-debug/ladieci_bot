// tests/deliveryPlannerShadowPreviewReadOnly.test.js
// ===============================================================
// SHADOW PREVIEW CLI READ-ONLY — offline tests
// Run: node tests/deliveryPlannerShadowPreviewReadOnly.test.js
// ===============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const {
  parseArgs,
  aggregateShadowReports,
  runBackupPreviewFromNights,
} = require("../scripts/deliveryPlannerShadowPreviewReadOnly");
const { buildShadowPreviewForOperator } = require("../src/core/delivery/shadowPreview");

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label} ${extra}`); }
}

function pizza(name, q) {
  return { n: name, q };
}

const fakeBackupRow = {
  fecha: "2026-05-31",
  n_ordini: 3,
  ordini: [
    {
      id: "TEST_PREVIEW_DIRTY",
      tipo_consegna: "DOMICILIO",
      estado: "RETIRADO",
      zona: "Q5",
      hora: "21:30",
      durata_andata_min: 28,
      geo_source: "cache-street",
      durata_google_min: null,
      durata_haversine_min: 28,
      items: [pizza("Margherita", 1)],
      forno_out: "21:02",
      nombre: "Persona Inventada",
      telefono: "+34000000000",
      direccion: "Calle Falsa 123",
    },
    {
      id: "TEST_PREVIEW_PICKUP_A",
      tipo_consegna: "RITIRO",
      estado: "RETIRADO",
      zona: null,
      hora: "20:30",
      items: [pizza("Diavola", 4)],
      forno_out: "20:30",
    },
    {
      id: "TEST_PREVIEW_PICKUP_B",
      tipo_consegna: "RITIRO",
      estado: "RETIRADO",
      zona: null,
      hora: "20:30",
      items: [pizza("Napoli", 4)],
      forno_out: "20:30",
    },
  ],
};

console.log("\n══ Args / errors ══");
{
  const args = parseArgs(["--source", "backup", "--dates", "2026-05-28,2026-05-29"]);
  check("10· source backup supportata",
    args.source === "backup" && args.dates.length === 2 && args.error === null,
    JSON.stringify(args));
  check("11· missing source gestito con errore pulito",
    parseArgs(["--date", "2026-05-31"]).error === "missing --source");
  check("11b· missing date gestito con errore pulito",
    parseArgs(["--source", "backup"]).error === "missing --date or --dates");
}

console.log("\n══ Preview from backup rows ══");
{
  const nights = [{ date: "2026-05-31", rows: [fakeBackupRow] }];
  const before = JSON.stringify(nights);
  const result = runBackupPreviewFromNights(nights, { now: "19:00", executed_live: true });
  const out = JSON.stringify(result);
  check("1· CLI/helper costruisce preview da shadow output fake",
    result.executed_live === true && result.read_only === true && result.preview && result.preview.title === "Vista previa planner",
    out);
  check("2· preview include summary",
    result.preview.summary.totalOrders === 3 &&
      result.preview.summary.deliveryOrders === 1 &&
      result.preview.summary.pickupOrders === 2 &&
      result.preview.summary.zones.includes("Q5"),
    JSON.stringify(result.preview.summary));
  check("3· preview include operatorMessages in spagnolo",
    result.preview.operatorMessages.some((m) => /Tiempo estimado poco fiable|Horno lleno/.test(m.title)),
    JSON.stringify(result.preview.operatorMessages));
  check("4· dirty geo genera Tiempo estimado poco fiable",
    result.preview.operatorMessages.some((m) => m.title === "Tiempo estimado poco fiable"),
    JSON.stringify(result.preview.operatorMessages));
  check("7· output non contiene PII",
    !/Persona Inventada|\+34000000000|Calle Falsa/.test(out),
    out);
  check("8· raw diagnostics non esposte",
    result.preview.rawDiagnosticsHidden === true &&
      !("diagnostics" in result.preview) &&
      !out.includes("cache-street") &&
      !out.includes("TEST_PREVIEW_DIRTY"),
    out);
  check("9· readOnly true",
    result.preview.readOnly === true && result.read_only === true,
    out);
  check("13· helper non modifica input",
    before === JSON.stringify(nights),
    JSON.stringify(nights));
}

console.log("\n══ Preview from aggregate shadow output ══");
{
  const shadow = aggregateShadowReports([
    {
      totalOrders: 1,
      deliveryOrders: 1,
      pickupOrders: 0,
      zones: ["Q5"],
      trips: 1,
      warnings: [],
      differences: [],
      diagnostics: [{ type: "global_oven_slot_warning", code: "forno_overload_serio", slot: "20:30", pizzas: 7, capacity: 4 }],
      invariants: { noDriverBeforePizza: true, noInvalidTimeFormat: true },
    },
  ]);
  const preview = buildShadowPreviewForOperator(shadow);
  check("5· global oven genera Horno muy cargado",
    preview.operatorMessages.some((m) => m.title === "Horno muy cargado"),
    JSON.stringify(preview));

  const critical = buildShadowPreviewForOperator(aggregateShadowReports([
    {
      totalOrders: 1,
      deliveryOrders: 1,
      pickupOrders: 0,
      zones: ["Q1"],
      trips: 1,
      warnings: [],
      differences: [],
      diagnostics: [],
      invariants: { noDriverBeforePizza: false, noInvalidTimeFormat: true },
    },
  ]));
  check("6· invariant rossa genera status critical",
    critical.status === "critical",
    JSON.stringify(critical));

  const ok = buildShadowPreviewForOperator(aggregateShadowReports([
    {
      totalOrders: 1,
      deliveryOrders: 0,
      pickupOrders: 1,
      zones: [],
      trips: 0,
      warnings: [],
      differences: [],
      diagnostics: [],
      invariants: { noDriverBeforePizza: true, noInvalidTimeFormat: true },
    },
  ]));
  check("14· fallback se nessuna diagnostic → ok",
    ok.status === "ok" && ok.operatorMessages.length === 0,
    JSON.stringify(ok));
}

console.log("\n══ Static safety ══");
{
  const scriptPath = path.join(__dirname, "../scripts/deliveryPlannerShadowPreviewReadOnly.js");
  const scriptSrc = fs.readFileSync(scriptPath, "utf8");
  const testSrc = fs.readFileSync(__filename, "utf8");
  const strip = (s) => s.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const testCode = strip(testSrc).toLowerCase();
  const NET_TOKENS = ["su" + "pabase", "fet" + "ch(", "ax" + "ios", "process" + ".env"];
  const WRITE_TOKENS = ["ins" + "ert", "up" + "date", "del" + "ete", "up" + "sert", ".r" + "pc("];
  check("12· nessun DB/network/env nei test",
    NET_TOKENS.every((t) => !testCode.includes(t)));
  check("12b· nessun metodo di scrittura nel test/script",
    WRITE_TOKENS.every((t) => !testCode.includes(t)) &&
      WRITE_TOKENS.every((t) => !strip(scriptSrc).toLowerCase().includes(t)));
}

console.log(`\n──────────────\n  ${pass} PASS · ${fail} FAIL\n`);
process.exit(fail ? 1 : 0);
