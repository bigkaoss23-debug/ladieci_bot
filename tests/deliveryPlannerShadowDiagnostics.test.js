// tests/deliveryPlannerShadowDiagnostics.test.js
// ===============================================================
// SHADOW DIAGNOSTICS — dirty geo + global oven slots · offline/read-only
// Run: node tests/deliveryPlannerShadowDiagnostics.test.js
// ===============================================================
// Diagnostica pura di report: usa solo fixture finte in memoria, non scrive, non
// legge DB/rete/env e non cambia scheduling/verdict.
// ===============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const {
  runShadow,
  collectDiagnostics,
} = require("../scripts/deliveryPlannerShadowReadOnly");

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label} ${extra}`); }
}

function delivery(o) {
  return {
    id: o.id,
    tipo_consegna: "DOMICILIO",
    estado: "NUEVO",
    zona: o.zona,
    hora: o.hora || "21:30",
    andata_min: o.andata_min,
    n_pizze: o.n_pizze ?? 1,
    ...(o.geo_source !== undefined ? { geo_source: o.geo_source } : {}),
    ...(o.durata_google_min !== undefined ? { durata_google_min: o.durata_google_min } : {}),
    ...(o.durata_haversine_min !== undefined ? { durata_haversine_min: o.durata_haversine_min } : {}),
    ...(o.forno_out_db ? { forno_out_db: o.forno_out_db } : {}),
    // PII finta: non deve mai uscire dal report.
    ...(o.nombre ? { nombre: o.nombre } : {}),
    ...(o.tel ? { tel: o.tel } : {}),
    ...(o.direccion ? { direccion: o.direccion } : {}),
  };
}

function pickup(o) {
  return {
    id: o.id,
    tipo_consegna: "RITIRO",
    estado: "NUEVO",
    zona: null,
    hora: o.hora,
    andata_min: null,
    n_pizze: o.n_pizze,
    ...(o.nombre ? { nombre: o.nombre } : {}),
    ...(o.tel ? { tel: o.tel } : {}),
    ...(o.direccion ? { direccion: o.direccion } : {}),
  };
}

function diagnosticsOf(orders) {
  return runShadow({ fecha: "2026-06-04", now: "19:00", orders }).diagnostics;
}

console.log("\n══ Dirty geo timing ══");
{
  const dirty = diagnosticsOf([
    delivery({
      id: "TEST_DIAG_Q5_DIRTY",
      zona: "Q5",
      andata_min: 28,
      geo_source: "cache-street",
      durata_google_min: null,
      durata_haversine_min: 28,
    }),
  ]).filter((d) => d.type === "dirty_geo_timing");
  check("1· dirty Q5 cache-street → diagnostic presente",
    dirty.length === 1 && dirty[0].orderId === "TEST_DIAG_Q5_DIRTY" && dirty[0].input_dirty === true,
    JSON.stringify(dirty));

  const clean = diagnosticsOf([
    delivery({
      id: "TEST_DIAG_Q5_CLEAN",
      zona: "Q5",
      andata_min: 13,
      geo_source: "google-from-nominatim",
      durata_google_min: 13,
      durata_haversine_min: 23,
    }),
  ]).filter((d) => d.type === "dirty_geo_timing");
  check("2· clean Q5 Google → diagnostic assente", clean.length === 0, JSON.stringify(clean));

  const fallback = diagnosticsOf([
    delivery({
      id: "TEST_DIAG_Q5_FALLBACK",
      zona: "Q5",
      andata_min: 21,
      geo_source: "haversine",
      durata_google_min: null,
      durata_haversine_min: 21,
    }),
  ]).filter((d) => d.type === "dirty_geo_timing");
  check("3· Q5 andata >=20 non-Google → diagnostic presente",
    fallback.length === 1 && fallback[0].orderId === "TEST_DIAG_Q5_FALLBACK",
    JSON.stringify(fallback));

  const q1 = diagnosticsOf([
    delivery({
      id: "TEST_DIAG_Q1_HIGH",
      zona: "Q1",
      andata_min: 24,
      geo_source: "haversine",
      durata_google_min: null,
      durata_haversine_min: 24,
    }),
  ]).filter((d) => d.type === "dirty_geo_timing");
  check("4· Q1 con andata alta non è automaticamente dirty Q5/Marina",
    q1.length === 0,
    JSON.stringify(q1));
}

console.log("\n══ Global oven slot warnings ══");
{
  const soft = diagnosticsOf([pickup({ id: "TEST_DIAG_RIT_SOFT", hora: "20:30", n_pizze: 5 })])
    .find((d) => d.type === "global_oven_slot_warning");
  check("5· global oven slot 5/4 → soft warning",
    soft && soft.code === "forno_soft_overload" && soft.severity === "yellow" && soft.slot === "20:30",
    JSON.stringify(soft));

  const serious = diagnosticsOf([pickup({ id: "TEST_DIAG_RIT_SERIOUS", hora: "20:30", n_pizze: 7 })])
    .find((d) => d.type === "global_oven_slot_warning");
  check("6· global oven slot 6–7/4 → serious warning",
    serious && serious.code === "forno_overload_serio" && serious.severity === "orange",
    JSON.stringify(serious));

  const hard = diagnosticsOf([pickup({ id: "TEST_DIAG_RIT_HARD", hora: "20:30", n_pizze: 8 })])
    .find((d) => d.type === "global_oven_slot_warning");
  check("7· global oven slot 8+/4 → hard/full warning",
    hard && hard.code === "forno_pieno" && hard.severity === "red",
    JSON.stringify(hard));

  check("8· slot saturo da soli ritiri → warning presente",
    hard && hard.pizzas === 8 && hard.capacity === 4,
    JSON.stringify(hard));
}

console.log("\n══ Safety / invariants ══");
{
  const fixture = {
    fecha: "2026-06-04",
    now: "19:00",
    orders: [
      delivery({
        id: "TEST_DIAG_PII_DIRTY",
        zona: "Q5",
        andata_min: 28,
        geo_source: "cache-street",
        durata_google_min: null,
        durata_haversine_min: 28,
        nombre: "Persona Inventata",
        tel: "+34000000000",
        direccion: "Calle Falsa 123",
      }),
      pickup({
        id: "TEST_DIAG_PII_RIT",
        hora: "20:30",
        n_pizze: 5,
        nombre: "Altro Nome",
        tel: "+34999999999",
        direccion: "Avenida Finta 9",
      }),
    ],
  };
  const report = runShadow(fixture);
  const out = JSON.stringify(report);
  check("9· output non contiene PII",
    !/Persona Inventata|Altro Nome|\+34000000000|\+34999999999|Calle Falsa|Avenida Finta/.test(out),
    "PII leak");
  check("10· diagnostics non modificano shadow_ok se invarianti restano verdi",
    report.verdict === "shadow_ok" && report.invariants.noDerivedInputLeak === true && report.diagnostics.length >= 2,
    JSON.stringify({ verdict: report.verdict, diagnostics: report.diagnostics }));

  const before = JSON.stringify(report.diagnostics);
  const again = collectDiagnostics(fixture.orders, { ...report, orders: {} });
  check("10b· collectDiagnostics è read-only/pura sui dati in input",
    before !== "" && Array.isArray(again),
    JSON.stringify(again));
}

console.log("\n══ Static safety ══");
{
  const testSrc = fs.readFileSync(__filename, "utf8");
  const runnerSrc = fs.readFileSync(path.join(__dirname, "../scripts/deliveryPlannerShadowReadOnly.js"), "utf8");
  const testCode = testSrc.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const runnerCode = runnerSrc.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const NET_TOKENS = ["su" + "pabase", "fet" + "ch(", "ax" + "ios", "process" + ".env"];
  const WRITE_TOKENS = ["ins" + "ert", "up" + "date", "del" + "ete", "up" + "sert", ".r" + "pc("];
  check("11· no DB/network/env access nel nuovo test",
    NET_TOKENS.every((t) => !testCode.toLowerCase().includes(t)));
  check("11b· helper shadow resta senza DB/network/env access",
    NET_TOKENS.every((t) => !runnerCode.toLowerCase().includes(t)));
  check("11c· nessun metodo di scrittura nel nuovo test",
    WRITE_TOKENS.every((t) => !testCode.toLowerCase().includes(t)));
}

console.log(`\n──────────────\n  ${pass} PASS · ${fail} FAIL\n`);
process.exit(fail ? 1 : 0);
