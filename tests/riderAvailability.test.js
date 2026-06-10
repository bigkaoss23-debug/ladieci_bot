// tests/riderAvailability.test.js
// ===============================================================
// Unit test PURO per resolveRiderAvailability (RIDER AVAILABILITY ADAPTER).
// Run: node tests/riderAvailability.test.js
// Nessun DB, nessuna rete, nessun Date.now dentro l'adapter.
// ===============================================================
"use strict";

const { resolveRiderAvailability, toMadridMinutes } = require("../src/core/delivery/riderAvailability");

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}  ${extra}`); }
}

// Helper: ms epoch da un orario clock Madrid (Giugno = CEST = UTC+2).
// 17:16 Madrid → 15:16 UTC.
const madridMs = (h, m) => Date.UTC(2026, 5, 10, h - 2, m, 0);
const M = (h, m) => h * 60 + m; // clock-min

const dom = (o) => ({ tipo_consegna: "DOMICILIO", ...o });

// ── 1. EN_ENTREGA con hora_salida reale, durata 5 → busyUntilMin = 17:29 ──
console.log("\n── 1. EN_ENTREGA hora_salida reale → finestra occupata ──");
{
  const orders = [dom({ id: "#001", estado: "EN_ENTREGA", zona: "Q1", hora_salida: madridMs(17, 16), durata_andata_min: 5 })];
  const r = resolveRiderAvailability(orders, { nowMin: M(17, 20) });
  check("busyUntilMin = 17:29 (1036 + 10 + 3)", r.busyUntilMin === M(17, 29), `got ${r.busyUntilMin}`);
  check("driverLiberoMin = busyUntilMin", r.driverLiberoMin === M(17, 29), `got ${r.driverLiberoMin}`);
  check("ridersOut len 1, source order_hora_salida", r.ridersOut.length === 1 && r.ridersOut[0].source === "order_hora_salida", JSON.stringify(r.ridersOut));
  check("salidaRealMin = 17:16", r.ridersOut[0].salidaRealMin === M(17, 16), `got ${r.ridersOut[0].salidaRealMin}`);
  check("nessun warning", r.warnings.length === 0, JSON.stringify(r.warnings));
}

// ── 2. Rider già rientrato (now dopo return) → busyUntilMin null ──
console.log("\n── 2. rider già rientrato → libero ──");
{
  const orders = [dom({ id: "#001", estado: "EN_ENTREGA", zona: "Q1", hora_salida: madridMs(17, 16), durata_andata_min: 5 })];
  const r = resolveRiderAvailability(orders, { nowMin: M(18, 20) }); // 18:20 > return 17:29
  check("busyUntilMin null (rientrato)", r.busyUntilMin === null, `got ${r.busyUntilMin}`);
  check("driverLiberoMin null", r.driverLiberoMin === null, `got ${r.driverLiberoMin}`);
  check("ridersOut comunque elenca il giro (returnMin 17:29)", r.ridersOut.length === 1 && r.ridersOut[0].returnMin === M(17, 29), JSON.stringify(r.ridersOut));
}

// ── 3. EN_COCINA / LISTO senza hora_salida → non inventa, non crasha ──
console.log("\n── 3. EN_COCINA / LISTO senza partenza reale ──");
{
  const orders = [
    dom({ id: "#A", estado: "EN_COCINA", zona: "Q1", hora: "17:40", durata_andata_min: 5 }),
    dom({ id: "#B", estado: "LISTO", zona: "Q2", hora: "17:45", durata_andata_min: 8 }),
  ];
  const r = resolveRiderAvailability(orders, { nowMin: M(17, 20) });
  check("busyUntilMin null (nessuna partenza reale)", r.busyUntilMin === null, `got ${r.busyUntilMin}`);
  check("ridersOut vuoto (non inventa)", r.ridersOut.length === 0, JSON.stringify(r.ridersOut));
  check("ok true, nessun crash", r.ok === true);
}

// ── 4. POR_CONFIRMAR ignorato ──
console.log("\n── 4. POR_CONFIRMAR ignorato ──");
{
  const orders = [dom({ id: "#P", estado: "POR_CONFIRMAR", zona: "Q1", hora_salida: madridMs(17, 16), durata_andata_min: 5 })];
  const r = resolveRiderAvailability(orders, { nowMin: M(17, 20) });
  check("busyUntilMin null", r.busyUntilMin === null, `got ${r.busyUntilMin}`);
  check("ridersOut vuoto", r.ridersOut.length === 0, JSON.stringify(r.ridersOut));
}

// ── 5. RETIRADO / COMPLETATO ignorati ──
console.log("\n── 5. RETIRADO / COMPLETATO ignorati ──");
{
  const orders = [
    dom({ id: "#R", estado: "RETIRADO", zona: "Q1", hora_salida: madridMs(17, 16), durata_andata_min: 5 }),
    dom({ id: "#C", estado: "COMPLETATO", zona: "Q1", hora_salida: madridMs(17, 16), durata_andata_min: 5 }),
  ];
  const r = resolveRiderAvailability(orders, { nowMin: M(17, 20) });
  check("busyUntilMin null", r.busyUntilMin === null, `got ${r.busyUntilMin}`);
  check("ridersOut vuoto", r.ridersOut.length === 0, JSON.stringify(r.ridersOut));
}

// ── 6. hora_salida malformata → warning, niente crash ──
console.log("\n── 6. hora_salida malformata → warning, no crash ──");
{
  const orders = [dom({ id: "#X", estado: "EN_ENTREGA", zona: "Q1", hora_salida: "not-a-date", durata_andata_min: 5 })];
  const r = resolveRiderAvailability(orders, { nowMin: M(17, 20) });
  check("busyUntilMin null (skip safe)", r.busyUntilMin === null, `got ${r.busyUntilMin}`);
  check("warning hora_salida_unparseable", r.warnings.some(w => w.code === "hora_salida_unparseable"), JSON.stringify(r.warnings));
  check("ok true (no crash)", r.ok === true);
}

// ── 6b. durata mancante su EN_ENTREGA → warning, niente crash ──
console.log("\n── 6b. durata_andata_min mancante → warning ──");
{
  const orders = [dom({ id: "#Y", estado: "EN_ENTREGA", zona: "Q1", hora_salida: madridMs(17, 16) })];
  const r = resolveRiderAvailability(orders, { nowMin: M(17, 20) });
  check("busyUntilMin null", r.busyUntilMin === null, `got ${r.busyUntilMin}`);
  check("warning durata_andata_missing", r.warnings.some(w => w.code === "durata_andata_missing"), JSON.stringify(r.warnings));
}

// ── 7. due EN_ENTREGA → busyUntilMin = max rientro ──
console.log("\n── 7. due rider out → max rientro ──");
{
  const orders = [
    dom({ id: "#1", estado: "EN_ENTREGA", zona: "Q1", hora_salida: madridMs(17, 16), durata_andata_min: 5 }),  // ret 17:29
    dom({ id: "#2", estado: "EN_ENTREGA", zona: "Q4", hora_salida: madridMs(17, 18), durata_andata_min: 12 }), // ret 17:18+24+3=17:45
  ];
  const r = resolveRiderAvailability(orders, { nowMin: M(17, 20) });
  check("busyUntilMin = 17:45 (max)", r.busyUntilMin === M(17, 45), `got ${r.busyUntilMin}`);
  check("ridersOut len 2", r.ridersOut.length === 2);
}

// ── 8. toMadridMinutes accetta ISO e HH:MM ──
console.log("\n── 8. toMadridMinutes formati misti ──");
{
  check("ms epoch → 17:16", toMadridMinutes(madridMs(17, 16)) === M(17, 16), `got ${toMadridMinutes(madridMs(17, 16))}`);
  check("ISO string → 17:16", toMadridMinutes(new Date(madridMs(17, 16)).toISOString()) === M(17, 16), `got ${toMadridMinutes(new Date(madridMs(17, 16)).toISOString())}`);
  check("HH:MM passthrough", toMadridMinutes("17:16") === M(17, 16), `got ${toMadridMinutes("17:16")}`);
  check("null → null", toMadridMinutes(null) === null);
  check("garbage → null", toMadridMinutes("xyz") === null);
}

console.log(`\n=== riderAvailability: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
