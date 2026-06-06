// tests/operationalAdjustmentMetrics.test.js
// ===============================================================
// Operational Adjustment metrics (ui_offset_min → ajuste_operativo) — offline.
// Read-only, no DB. Fixture sintetiche (incl. #013-like del live 05/06/2026).
// Run: node tests/operationalAdjustmentMetrics.test.js
// ===============================================================
"use strict";

const {
  computeOperationalAdjustmentMetric,
  summarizeOperationalAdjustments,
} = require("../src/core/delivery/operationalAdjustmentMetrics");

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label} ${extra}`); }
}

console.log("══ 1· Nessun ajuste (ui_offset 0) ══");
{
  const m = computeOperationalAdjustmentMetric({
    id: "#1", tipo: "DOMICILIO", estado: "EN_COCINA", hora: "21:30", ui_offset_min: 0,
  });
  check("hora_original 21:30", m.hora_original === "21:30", m.hora_original);
  check("hora_operativa 21:30", m.hora_operativa === "21:30", m.hora_operativa);
  check("ajuste 0", m.ajuste_operativo_min === 0, String(m.ajuste_operativo_min));
  check("has_adjustment false", m.has_adjustment === false, String(m.has_adjustment));
  check("classification no_adjustment", m.classification === "no_adjustment", m.classification);
}

console.log("\n══ 2· +5 attivo, non ancora LISTO ══");
{
  const m = computeOperationalAdjustmentMetric({
    id: "#2", tipo: "DOMICILIO", estado: "EN_COCINA", hora: "21:30", ui_offset_min: 5, listo_at: null,
  });
  check("hora_operativa 21:35", m.hora_operativa === "21:35", m.hora_operativa);
  check("classification active_adjustment", m.classification === "active_adjustment", m.classification);
  check("adjustment_status active", m.adjustment_status === "active", m.adjustment_status);
}

console.log("\n══ 3· +5 assorbito (LISTO prima dell'orario operativo) ══");
{
  const m = computeOperationalAdjustmentMetric({
    id: "#3", tipo: "DOMICILIO", estado: "LISTO", hora: "21:30", ui_offset_min: 5,
    listo_at: "2026-06-05T21:33:00",
  });
  check("hora_operativa 21:35", m.hora_operativa === "21:35", m.hora_operativa);
  check("classification absorbed", m.classification === "absorbed", m.classification);
  check("reason ready_before_operational_time", m.reasons.includes("ready_before_operational_time"), JSON.stringify(m.reasons));
  check("listo_vs_operativa = -2", m.listo_vs_hora_operativa_min === -2, String(m.listo_vs_hora_operativa_min));
  check("within_margin true", m.within_margin === true, String(m.within_margin));
}

console.log("\n══ 4· +10 con LISTO dentro orario operativo → absorbed ══");
{
  // hora_operativa 21:40, listo 21:37 ≤ 21:40 → absorbed (preferenza: LISTO ≤ hora_operativa).
  const m = computeOperationalAdjustmentMetric({
    id: "#4", tipo: "DOMICILIO", estado: "LISTO", hora: "21:30", ui_offset_min: 10,
    listo_at: "2026-06-05T21:37:00",
  });
  check("hora_operativa 21:40", m.hora_operativa === "21:40", m.hora_operativa);
  check("classification absorbed", m.classification === "absorbed", m.classification);
  check("listo_vs_operativa = -3", m.listo_vs_hora_operativa_min === -3, String(m.listo_vs_hora_operativa_min));
}

console.log("\n══ 5· +10 fuori margine operativo ══");
{
  const m = computeOperationalAdjustmentMetric({
    id: "#5", tipo: "DOMICILIO", estado: "LISTO", hora: "21:30", ui_offset_min: 10,
    listo_at: "2026-06-05T21:45:00",
  });
  check("hora_operativa 21:40", m.hora_operativa === "21:40", m.hora_operativa);
  check("classification outside_margin", m.classification === "outside_margin", m.classification);
  check("listo_vs_operativa = +5", m.listo_vs_hora_operativa_min === 5, String(m.listo_vs_hora_operativa_min));
  check("reason ready_after_operational_time", m.reasons.includes("ready_after_operational_time"), JSON.stringify(m.reasons));
  check("within_margin false", m.within_margin === false, String(m.within_margin));
}

console.log("\n══ 6· #013-like: il doppio dato cambia l'interpretazione ══");
{
  // forno_out 21:27, listo_at 21:33:45.
  const senza = computeOperationalAdjustmentMetric({
    id: "#013a", tipo: "DOMICILIO", estado: "LISTO", hora: "21:30", ui_offset_min: 0,
    forno_out: "21:27", listo_at: "2026-06-05T21:33:45",
  });
  const con5 = computeOperationalAdjustmentMetric({
    id: "#013b", tipo: "DOMICILIO", estado: "LISTO", hora: "21:30", ui_offset_min: 5,
    forno_out: "21:27", listo_at: "2026-06-05T21:33:45",
  });
  // Senza ajuste: LISTO +3.75 vs original, entro margine 10 → within_margin (retraso leve).
  check("senza ajuste → within_margin", senza.classification === "within_margin", senza.classification);
  check("senza: listo_vs_forno ≈ +6.8", senza.listo_vs_forno_out_min === 6.8, String(senza.listo_vs_forno_out_min));
  // Con +5: hora_operativa 21:35, LISTO 21:33:45 ≤ 21:35 → absorbed (il riallineo lo assorbe).
  check("con +5 → absorbed", con5.classification === "absorbed", con5.classification);
  check("con +5: hora_operativa 21:35", con5.hora_operativa === "21:35", con5.hora_operativa);
  check("dimostrazione valore doppio dato (within_margin → absorbed)",
    senza.classification === "within_margin" && con5.classification === "absorbed", "");
}

console.log("\n══ 7· Orari dopo mezzanotte (service-day wrap) ══");
{
  const m = computeOperationalAdjustmentMetric({
    id: "#7", tipo: "DOMICILIO", estado: "LISTO", hora: "00:10", ui_offset_min: 10,
    listo_at: "2026-06-06T00:15:00",
  });
  check("hora_operativa 00:20 (wrap corretto)", m.hora_operativa === "00:20", m.hora_operativa);
  check("classification absorbed", m.classification === "absorbed", m.classification);
  check("listo_vs_operativa = -5", m.listo_vs_hora_operativa_min === -5, String(m.listo_vs_hora_operativa_min));
}

console.log("\n══ 8· PII safety ══");
{
  const m = computeOperationalAdjustmentMetric({
    id: "#8", tipo: "DOMICILIO", estado: "LISTO", zona: "Q1", hora: "21:30", ui_offset_min: 5,
    listo_at: "2026-06-05T21:33:00",
    cliente: "Yoana Secreta", telefono: "+34666111222", direccion: "Calle Privada 9",
    wa_id: "wa-secret", items: [{ n: "Diavola", q: 1 }], nombre: "Yoana",
  });
  const out = JSON.stringify(m);
  check("output senza cliente/tel/direccion/wa_id/items/nombre",
    !/Yoana|\+34666111222|Calle Privada|wa-secret|Diavola|nombre/.test(out), out);
  check("output espone solo campi operativi",
    m.orderId === "#8" && m.zona === "Q1" && m.estado === "LISTO" &&
      Object.keys(m).every((k) => !/cliente|tel|direccion|wa_id|items|nombre/i.test(k)),
    Object.keys(m).join(","));
}

console.log("\n══ 9· Aggregato summarize ══");
{
  const s = summarizeOperationalAdjustments([
    { id: "#a", tipo: "DOMICILIO", estado: "EN_COCINA", hora: "21:30", ui_offset_min: 5, listo_at: null },          // active
    { id: "#b", tipo: "DOMICILIO", estado: "LISTO", hora: "21:30", ui_offset_min: 10, listo_at: "2026-06-05T21:37:00" }, // absorbed
    { id: "#c", tipo: "DOMICILIO", estado: "LISTO", hora: "21:30", ui_offset_min: 10, listo_at: "2026-06-05T21:45:00" }, // outside
    { id: "#d", tipo: "DOMICILIO", estado: "EN_COCINA", hora: "21:30", ui_offset_min: 0 },                          // no_adjustment
  ]);
  check("totalOrders 4", s.totalOrders === 4, String(s.totalOrders));
  check("adjustedOrders 3", s.adjustedOrders === 3, String(s.adjustedOrders));
  check("activeAdjustments 1", s.activeAdjustments === 1, String(s.activeAdjustments));
  check("absorbedAdjustments 1", s.absorbedAdjustments === 1, String(s.absorbedAdjustments));
  check("outsideMargin 1", s.outsideMargin === 1, String(s.outsideMargin));
  check("maxAdjustmentMin 10", s.maxAdjustmentMin === 10, String(s.maxAdjustmentMin));
  check("avgAdjustmentMin ≈ 8.3", s.avgAdjustmentMin === 8.3, String(s.avgAdjustmentMin));
  check("watchOrders = 2 (active + outside)", s.watchOrders.length === 2, JSON.stringify(s.watchOrders.map(w => w.orderId)));
  check("watchOrders senza PII", !/tel|direccion|cliente|nombre|wa_id/i.test(JSON.stringify(s.watchOrders)), JSON.stringify(s.watchOrders));
}

console.log("\n══ 10· Static safety: helper puro ══");
{
  const fs = require("fs");
  const src = fs.readFileSync(require.resolve("../src/core/delivery/operationalAdjustmentMetrics"), "utf8");
  const strip = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  check("nessun supabase/fetch/axios", !/supabase|node-fetch|axios/.test(strip), "");
  check("nessun process.env", !/process\.env/.test(strip), "");
  check("nessun fetch(", !/\bfetch\s*\(/.test(strip), "");
  check("nessun metodo scrittura DB", !/\b(insert|update|delete|upsert)\b/i.test(strip.replace(/updated?_at/gi, "")), "");
  check("nessun CommitWriter/geo_cache", !/CommitWriter|geo_cache/i.test(strip), "");
}

console.log(`\n──────────────\n  ${pass} PASS · ${fail} FAIL\n`);
process.exit(fail ? 1 : 0);
