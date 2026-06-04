// tests/deliveryPlannerShadowReadOnly.test.js
// ===============================================================
// SHADOW MODE READ-ONLY — test · task SHADOW-MODE-READONLY-01
// Run: node tests/deliveryPlannerShadowReadOnly.test.js
// ===============================================================
// Verifica che lo shadow runner read-only giri sulle 4 serate reali, produca
// summary + invarianti, abbia 0 invarianti rosse, non usi campi derivati come
// input e non importi side-effect (supabase/fetch/axios/process.env).
// Tutto STATICO/OFFLINE: nessuna query live, nessuna scrittura.
// ===============================================================
"use strict";
const fs = require("fs");
const path = require("path");
const {
  runShadow,
  runShadowAll,
  normalizeRawOrders,
  assertNoDerivedInput,
} = require("../scripts/deliveryPlannerShadowReadOnly");

const FIXTURE_DATES = ["20260528", "20260529", "20260530", "20260531"];
const fixtures = FIXTURE_DATES.map((d) => require("./fixtures/deliveryPlannerRealSnapshot" + d));

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label} ${extra}`); }
}

// ── 1. gira su tutte e 4 le fixture reali ─────────────────────────────────────
const { summary, reports } = runShadowAll(fixtures);
check(`1· shadow runner gira su tutte e 4 le fixture (${reports.length})`, reports.length === 4);
check("1b· totali coerenti (87 ordini · 27 dom · 60 rit)",
  summary.totalOrders === 87 && summary.deliveryOrders === 27 && summary.pickupOrders === 60,
  JSON.stringify(summary));

// ── 2. output contiene summary ────────────────────────────────────────────────
check("2· summary presente con verdict globale",
  summary && typeof summary.verdict === "string" && "snapshots" in summary);

// ── 3. ogni report contiene summary fields + invariants ───────────────────────
let missingInv = 0, missingSum = 0;
for (const r of reports) {
  const sumOk = ["snapshotDate", "totalOrders", "deliveryOrders", "pickupOrders", "zones", "verdict"].every(k => k in r);
  if (!sumOk) missingSum++;
  const invKeys = ["noImpossibleFornoOut", "noDriverBeforePizza", "noRiderOverlap", "noInvalidTimeFormat", "noDerivedInputLeak"];
  if (!r.invariants || !invKeys.every(k => k in r.invariants)) missingInv++;
}
check("3· ogni report ha i campi summary", missingSum === 0);
check("3b· ogni report ha gli invariants attesi", missingInv === 0);

// ── 4. invarianti rosse = 0 (verdict shadow_ok ovunque) ───────────────────────
const reds = reports.filter(r => r.verdict !== "shadow_ok");
check("4· invarianti rosse = 0 su ogni serata (tutto shadow_ok)", reds.length === 0,
  JSON.stringify(reds.map(r => ({ d: r.snapshotDate, inv: r.invariants }))));
check("4b· verdict globale shadow_ok", summary.verdict === "shadow_ok");

// ── 5. warnings/differences non vuoti dove SAPPIAMO che ci sono casi reali ─────
// Le 4 serate reali hanno differenze attese (buffer 3, single-rider, capacità forno).
check("5· differenze totali > 0 (le nuove regole producono A/B reali)", summary.totalDifferences > 0,
  String(summary.totalDifferences));
// 2026-05-30 ha cluster forno sotto stress (#008=4 pizze, mega-ritiro 5): deve avere warning o diff.
const r30 = reports.find(r => r.snapshotDate === "2026-05-30");
check("5b· 2026-05-30 produce warning o differenze (serata forno stress)",
  r30 && (r30.warnings.length > 0 || r30.differences.length > 0));

// ── 6. NON usa campi derivati come input ──────────────────────────────────────
// 6a · l'invariante interna noDerivedInputLeak è verde ovunque.
check("6· nessun derived input leak rilevato dal runner",
  reports.every(r => r.invariants.noDerivedInputLeak && r.derivedLeak.length === 0));
// 6b · la normalizzazione SCARTA esplicitamente forno_out_db / estado_db.
const norm = normalizeRawOrders(fixtures[2].orders);
const leak = assertNoDerivedInput(norm);
check("6c· normalizeRawOrders scarta forno_out_db/estado_db", leak.length === 0, JSON.stringify(leak));
check("6d· normalize NON propaga forno_out_db",
  norm.every(o => !("forno_out_db" in o) && !("estado_db" in o)));
check("6e· normalize replay archiviati → estado NUEVO",
  norm.every(o => o.estado === "NUEVO"));

// ── 7. il runner NON importa supabase/fetch/axios/process.env ──────────────────
const src = fs.readFileSync(path.join(__dirname, "../scripts/deliveryPlannerShadowReadOnly.js"), "utf8");
// strip commenti per evitare falsi positivi sui token citati in doc.
const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
for (const bad of ["supabase", "fetch(", "axios", "process.env"]) {
  check(`7· lo shadow runner NON usa '${bad}'`, !code.includes(bad));
}
// l'unico require ammesso nel core-path è il planner puro (+ fixture/fs solo in CLI/test).
check("7b· require del solo planner puro nel modulo",
  /require\("\.\.\/src\/core\/delivery\/planner"\)/.test(code));

// ── 8. NON tocca consumer live (planner ancora isolato) ───────────────────────
const planSrc = fs.readFileSync(path.join(__dirname, "../src/core/delivery/planner.js"), "utf8");
const planCode = planSrc.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
for (const bad of ["supabase", "fetch(", "axios", "process.env", "require("]) {
  check(`8· planner core resta PURO senza '${bad}'`, !planCode.includes(bad));
}

console.log(`\n──────────────\n  ${pass} PASS · ${fail} FAIL\n`);
process.exit(fail ? 1 : 0);
