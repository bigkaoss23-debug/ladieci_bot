// tests/deliveryPlannerRiderChainExplanation.test.js
// ===============================================================
// RIDER-CHAIN-EXPLANATION-42
// Run: node tests/deliveryPlannerRiderChainExplanation.test.js
// Offline/read-only: no DB, no network, no PII.
// ===============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const { explainRiderDelayChain } = require("../src/core/delivery/riderChainExplanation");
const { runShadow } = require("../scripts/deliveryPlannerShadowReadOnly");
const { buildShadowPreviewForOperator } = require("../src/core/delivery/shadowPreview");
const { buildShadowPreviewContract } = require("../src/core/delivery/shadowPreviewContract");

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label} ${extra}`); }
}

function delivery({
  id,
  zona = "Q1",
  estado = "EN_COCINA",
  hora = "23:05",
  forno = "23:00",
  salida = "23:00",
  entrega = "23:05",
  durata = 5,
  delay = 0,
  conflict = false,
}) {
  return {
    id,
    tipo_consegna: "DOMICILIO",
    estado,
    zona,
    hora,
    forno_out: forno,
    forno_out_db: forno,
    salida_driver_estimada: salida,
    entrega_estimada: entrega,
    andata_min: durata,
    durata_andata_min: durata,
    retraso_estimado_min: delay,
    conflicto_driver: conflict,
    n_pizze: 1,
  };
}

console.log("\n══ Helper rider-chain ══");
{
  const rows = [
    delivery({ id: "#015", zona: "Q5", hora: "22:55", salida: "22:46", entrega: "22:55", durata: 9 }),
    delivery({ id: "#016", zona: "Q5", hora: "23:19", salida: "23:07", entrega: "23:19", durata: 12 }),
    delivery({ id: "#017", zona: "Q1", hora: "23:05", forno: "23:00", salida: "23:34", entrega: "23:39", durata: 5, delay: 34, conflict: true }),
  ];
  const chain = explainRiderDelayChain(rows);
  const x = chain[0];
  check("1· #017 blockedBy #016",
    chain.length === 1 && x.orderId === "#017" && x.blockedByOrderId === "#016",
    JSON.stringify(chain));
  check("1b· #017 riderAvailableAt 23:34",
    x.riderAvailableAt === "23:34" && x.blockedByZone === "Q5",
    JSON.stringify(x));
  check("1c· #017 message compatta senza PII",
    /#017 \+34 min: rider bloccato da #016 Q5 fino alle 23:34/.test(x.message) &&
      !/nombre|telefono|direccion|nota/i.test(JSON.stringify(x)),
    JSON.stringify(x));
}

{
  const chain = explainRiderDelayChain([
    delivery({ id: "#020", delay: 0, conflict: false }),
  ]);
  check("2· no delay → no explanation", chain.length === 0, JSON.stringify(chain));
}

{
  const rows = [
    delivery({ id: "#013", zona: "Q1", salida: "22:07", entrega: "22:17", durata: 10 }),
    delivery({ id: "#014", zona: "Q1", salida: "22:30", entrega: "22:48", durata: 9, delay: 10, conflict: true }),
    delivery({ id: "#015", zona: "Q2", salida: "23:00", entrega: "23:21", durata: 10, delay: 22, conflict: true }),
    delivery({ id: "#016", zona: "Q5", salida: "23:34", entrega: "23:37", durata: 9, delay: 40, conflict: true }),
    delivery({ id: "#017", zona: "Q1", salida: "23:49", entrega: "23:54", durata: 5, delay: 34, conflict: true }),
  ];
  const chain = explainRiderDelayChain(rows);
  check("3· multiple delays max 3",
    chain.length === 3,
    JSON.stringify(chain));
  check("3b· ordinate per delay desc",
    chain.map((x) => x.orderId).join(",") === "#016,#017,#015",
    JSON.stringify(chain));
}

{
  const chain = explainRiderDelayChain([
    delivery({ id: "#030", zona: "Q5", salida: "23:46", entrega: "23:55", durata: 9 }),
    delivery({ id: "#031", zona: "Q1", salida: "00:07", entrega: "00:12", durata: 5, delay: 20, conflict: true }),
  ]);
  check("4· after midnight riderAvailableAt valido 00:07",
    chain[0]?.riderAvailableAt === "00:07" && !/2[45]:/.test(JSON.stringify(chain)),
    JSON.stringify(chain));
}

{
  const chain = explainRiderDelayChain([
    delivery({ id: "#040", zona: "Q1", salida: "23:34", entrega: "23:39", durata: 5, delay: 34, conflict: true }),
  ]);
  check("5· unknown blocker fallback senza crash",
    chain.length === 1 &&
      chain[0].reason === "rider_unavailable_unknown_previous_order" &&
      chain[0].blockedByOrderId === null,
    JSON.stringify(chain));
}

{
  const chain = explainRiderDelayChain([
    delivery({ id: "#050", estado: "RETIRADO", salida: "23:34", entrega: "23:39", durata: 5, delay: 34, conflict: true }),
    delivery({ id: "#051", estado: "COMPLETADO", salida: "23:49", entrega: "23:54", durata: 5, delay: 20, conflict: true }),
  ]);
  check("6· terminal/frozen completati non generano explanation operativa",
    chain.length === 0,
    JSON.stringify(chain));
}

console.log("\n══ Integration preview/contract ══");
{
  const report = runShadow({
    fecha: "2026-06-05",
    now: "22:00",
    orders: [
      delivery({ id: "#016", zona: "Q5", hora: "23:19", salida: "23:07", entrega: "23:19", durata: 12 }),
      delivery({ id: "#017", zona: "Q1", hora: "23:05", forno: "23:00", salida: "23:34", entrega: "23:39", durata: 5, delay: 34, conflict: true }),
    ],
  });
  const preview = buildShadowPreviewForOperator(report);
  const contract = buildShadowPreviewContract({
    preview,
    generatedAt: "2026-06-05T12:00:00.000Z",
    source: { type: "test", dates: ["2026-06-05"] },
  });
  check("7· shadow output include riderChain",
    report.riderChain.length === 1 && report.riderChain[0].blockedByOrderId === "#016",
    JSON.stringify(report.riderChain));
  check("7b· preview conserva riderChain e action testuale",
    preview.riderChain.length === 1 &&
      preview.suggestedOperatorActions.includes("Revisar cadena rider"),
    JSON.stringify(preview));
  check("7c· contract include riderChain + review_rider_chain",
    contract.riderChain.length === 1 &&
      contract.actions.some((a) => a.id === "review_rider_chain" && a.priority === "high"),
    JSON.stringify(contract));
  check("7d· contract riderChain no PII",
    !/nombre|telefono|direccion|nota/i.test(JSON.stringify(contract.riderChain)),
    JSON.stringify(contract.riderChain));
}

console.log("\n══ Static safety ══");
{
  const helperSrc = fs.readFileSync(path.join(__dirname, "../src/core/delivery/riderChainExplanation.js"), "utf8");
  const testSrc = fs.readFileSync(__filename, "utf8");
  const strip = (s) => s.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const code = strip(helperSrc + "\n" + testSrc).toLowerCase();
  const NET_TOKENS = ["su" + "pabase", "fet" + "ch(", "ax" + "ios", "process" + ".env"];
  const WRITE_TOKENS = ["ins" + "ert", "up" + "date", "del" + "ete", "up" + "sert", ".r" + "pc("];
  check("8· helper/test senza DB/network/env",
    NET_TOKENS.every((t) => !code.includes(t)));
  check("8b· helper/test senza metodi di scrittura",
    WRITE_TOKENS.every((t) => !code.includes(t)));
}

console.log(`\n──────────────\n  ${pass} PASS · ${fail} FAIL\n`);
process.exit(fail ? 1 : 0);
