// tests/deliveryPlannerShadowPreviewFrozenOrders.test.js
// ===============================================================
// SHADOW-PREVIEW-FROZEN-ORDERS-FALSE-CRITICAL-41
// Run: node tests/deliveryPlannerShadowPreviewFrozenOrders.test.js
// Offline/read-only: nessun DB, nessuna rete, nessuna scrittura.
// ===============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const { runShadow } = require("../scripts/deliveryPlannerShadowReadOnly");
const { buildShadowPreviewForOperator } = require("../src/core/delivery/shadowPreview");
const { buildShadowPreviewContract } = require("../src/core/delivery/shadowPreviewContract");

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label} ${extra}`); }
}

function pizzaOrder({ id, estado, zona = "Q1", hora = "21:00", andata = 8, forno = "20:52", salida = null, entrega = null, retraso = 0, conflicto = false }) {
  return {
    id,
    tipo_consegna: "DOMICILIO",
    estado,
    zona,
    hora,
    andata_min: andata,
    n_pizze: 1,
    forno_out_db: forno,
    salida_driver_estimada: salida,
    entrega_estimada: entrega,
    retraso_estimado_min: retraso,
    conflicto_driver: conflicto,
  };
}

function previewAndContract(report) {
  const preview = buildShadowPreviewForOperator(report);
  const contract = buildShadowPreviewContract({
    preview,
    generatedAt: "2026-06-05T12:00:00.000Z",
    source: { type: "test", dates: ["2026-06-05"] },
  });
  return { preview, contract };
}

console.log("\n══ Frozen/terminal artifacts non critical ══");
{
  const report = runShadow({
    fecha: "2026-06-05",
    now: "20:00",
    orders: [
      pizzaOrder({
        id: "#F17",
        estado: "EN_ENTREGA",
        hora: "21:00",
        forno: "20:52",
        salida: "20:52",
        entrega: "21:00",
      }),
    ],
  });
  const { preview, contract } = previewAndContract(report);
  check("1· EN_ENTREGA frozen non produce shadow_red",
    report.verdict === "shadow_ok" && Object.values(report.invariants).every(Boolean),
    JSON.stringify(report.invariants));
  check("1b· EN_ENTREGA non diventa critical e niente do_not_apply_plan",
    preview.status !== "critical" && contract.status !== "critical" &&
      !contract.actions.some((a) => a.id === "do_not_apply_plan"),
    JSON.stringify({ preview: preview.status, actions: contract.actions }));
  check("1c· EN_ENTREGA produce al massimo diagnostic info frozen",
    report.diagnostics.some((d) => d.type === "frozen_committed_order" && d.severity === "info"),
    JSON.stringify(report.diagnostics));
}

{
  const report = runShadow({
    fecha: "2026-06-05",
    now: "22:00",
    orders: [
      pizzaOrder({
        id: "#R18",
        estado: "RETIRADO",
        hora: "21:00",
        forno: "20:52",
        salida: "20:52",
        entrega: "21:00",
      }),
    ],
  });
  const { preview, contract } = previewAndContract(report);
  check("2· RETIRADO terminale escluso da invarianti ricalcolabili",
    report.verdict === "shadow_ok" &&
      report.invariants.noImpossibleFornoOut === true &&
      report.invariants.noDriverBeforePizza === true,
    JSON.stringify(report.invariants));
  check("2b· RETIRADO non conta difference operativa",
    report.differences.length === 0 && preview.summary.differencesCount === 0,
    JSON.stringify(report.differences));
  check("2c· RETIRADO non genera do_not_apply_plan",
    contract.status !== "critical" && !contract.actions.some((a) => a.id === "do_not_apply_plan"),
    JSON.stringify(contract));
}

console.log("\n══ Mix pianificabile + terminale ══");
{
  const report = runShadow({
    fecha: "2026-06-05",
    now: "19:00",
    orders: [
      pizzaOrder({ id: "#A01", estado: "EN_COCINA", zona: "Q1", hora: "20:30", andata: 8, forno: "20:22" }),
      pizzaOrder({ id: "#A02", estado: "RETIRADO", zona: "Q2", hora: "20:20", andata: 7, forno: "20:13", salida: "20:13", entrega: "20:20" }),
    ],
  });
  const { preview, contract } = previewAndContract(report);
  check("3· terminale non contamina ordine EN_COCINA sano",
    report.verdict === "shadow_ok" && preview.status !== "critical",
    JSON.stringify({ inv: report.invariants, status: preview.status }));
  check("3b· niente safety stop nel mix sano",
    !contract.actions.some((a) => a.id === "do_not_apply_plan"),
    JSON.stringify(contract.actions));
}

console.log("\n══ Critical vero resta critical ══");
{
  const syntheticCritical = {
    totalOrders: 1,
    deliveryOrders: 1,
    pickupOrders: 0,
    zones: ["Q1"],
    trips: 1,
    warnings: [],
    differences: [],
    diagnostics: [],
    invariants: {
      noImpossibleFornoOut: true,
      noDriverBeforePizza: false,
      noRiderOverlap: true,
      noInvalidTimeFormat: true,
      noDerivedInputLeak: true,
    },
  };
  const { preview, contract } = previewAndContract(syntheticCritical);
  check("4· bug reale su pianificabile resta critical",
    preview.status === "critical" && contract.status === "critical",
    JSON.stringify({ preview: preview.status, contract: contract.status }));
  check("4b· critical vero mantiene do_not_apply_plan",
    contract.actions.some((a) => a.id === "do_not_apply_plan" && a.priority === "high"),
    JSON.stringify(contract.actions));
}

console.log("\n══ Stress 39 shape ══");
{
  const report = runShadow({
    fecha: "2026-06-05",
    now: "22:30",
    orders: [
      pizzaOrder({ id: "#002", estado: "RETIRADO", zona: "Q1", hora: "21:00", andata: 8, forno: "20:52", salida: "20:52", entrega: "21:00" }),
      pizzaOrder({ id: "#003", estado: "RETIRADO", zona: "Q1", hora: "21:10", andata: 8, forno: "21:02", salida: "21:02", entrega: "21:10" }),
      pizzaOrder({ id: "#017", estado: "EN_COCINA", zona: "Q1", hora: "23:00", andata: 8, forno: "22:52" }),
    ],
  });
  const { preview, contract } = previewAndContract(report);
  check("5· forma Stress 39: terminali non generano false critical",
    report.verdict === "shadow_ok" && preview.status !== "critical",
    JSON.stringify({ inv: report.invariants, diagnostics: report.diagnostics }));
  check("5b· forma Stress 39: niente safety stop falso",
    !contract.actions.some((a) => a.id === "do_not_apply_plan"),
    JSON.stringify(contract.actions));
}

console.log("\n══ Static safety ══");
{
  const runnerPath = path.join(__dirname, "../scripts/deliveryPlannerShadowReadOnly.js");
  const testSrc = fs.readFileSync(__filename, "utf8");
  const runnerSrc = fs.readFileSync(runnerPath, "utf8");
  const strip = (s) => s.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const code = strip(testSrc + "\n" + runnerSrc).toLowerCase();
  const NET_TOKENS = ["su" + "pabase", "fet" + "ch(", "ax" + "ios", "process" + ".env"];
  const WRITE_TOKENS = ["ins" + "ert", "up" + "date", "del" + "ete", "up" + "sert", ".r" + "pc("];
  check("6· runner/test senza DB/network/env nel core path",
    NET_TOKENS.every((t) => !code.includes(t)));
  check("6b· runner/test senza metodi di scrittura",
    WRITE_TOKENS.every((t) => !code.includes(t)));
}

console.log(`\n──────────────\n  ${pass} PASS · ${fail} FAIL\n`);
process.exit(fail ? 1 : 0);
