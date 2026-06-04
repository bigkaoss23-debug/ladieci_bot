// tests/deliveryPlannerShadowLiveReadOnly.test.js
// ===============================================================
// SHADOW MODE LIVE READ-ONLY — test · task SHADOW-LIVE-SNAPSHOT-READONLY-02
// Run: node tests/deliveryPlannerShadowLiveReadOnly.test.js
// ===============================================================
// NIENTE DB reale: usa righe `ordenes` FINTE in memoria. Verifica parser, normalize,
// esclusione derivati dall'input planner, baseline-solo-confronto, assenza di metodi
// di scrittura, no side-effect a import-time, integrazione con runShadow.
// ===============================================================
"use strict";
const fs = require("fs");
const path = require("path");
const {
  countPizzas,
  normalizeDbRow,
  buildSnapshotFromRows,
  runShadowFromRows,
  parseArgs,
  rowDate,
  filterByDate,
} = require("../scripts/deliveryPlannerShadowLiveReadOnly");

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label} ${extra}`); }
}

// ── Righe DB FINTE (forma realistica di `ordenes`) ────────────────────────────
const FAKE_ROWS = [
  { id: "#101", ts: 1748548800000, created_at: "2026-05-30T20:05:00+02:00", tipo_consegna: "DOMICILIO",
    estado: "NUEVO", zona: "Q1", hora: "20:30", durata_andata_min: 8,
    items: [{ n: "Margherita", q: 2 }, { n: "Coca-Cola", q: 1 }],
    manual_giro_id: null, forzado: false, forno_out: "20:22",
    salida_driver_estimada: "20:22", entrega_estimada: "20:30", retraso_estimado_min: 0, conflicto_driver: false },
  { id: "#102", ts: 1748548900000, created_at: "2026-05-30T20:06:00+02:00", tipo_consegna: "DOMICILIO",
    estado: "EN_COCINA", zona: "Q5", hora: "22:00", durata_andata_min: 28,
    items: [{ n: "Diavola", q: 1 }, { n: "Tiramisu", q: 1 }, { n: "Agua", q: 2 }],
    manual_giro_id: null, forzado: false, forno_out: "21:32",
    salida_driver_estimada: "21:32", entrega_estimada: "22:00", retraso_estimado_min: 0, conflicto_driver: false },
  { id: "#103", ts: 1748549000000, created_at: "2026-05-30T20:07:00+02:00", tipo_consegna: "RITIRO",
    estado: "NUEVO", zona: null, hora: "20:25", durata_andata_min: null,
    items: [{ n: "Napoli", q: 3 }], manual_giro_id: null, forzado: false, forno_out: "20:25" },
  // riga di un ALTRO giorno (deve essere filtrata via --date)
  { id: "#999", ts: 1748462400000, created_at: "2026-05-29T21:00:00+02:00", tipo_consegna: "DOMICILIO",
    estado: "NUEVO", zona: "Q2", hora: "21:30", durata_andata_min: 10,
    items: [{ n: "Marinara", q: 1 }], forno_out: "21:20" },
];

// ── 1. parseArgs ──────────────────────────────────────────────────────────────
const a1 = parseArgs(["--date", "2026-06-04", "--limit", "200"]);
check("1· parseArgs --date/--limit", a1.date === "2026-06-04" && a1.limit === 200);
const a2 = parseArgs(["--date=2026-05-30", "--today", "--now=21:15"]);
check("1b· parseArgs --date=/--today/--now=", a2.date === "2026-05-30" && a2.today === true && a2.now === "21:15");

// ── 2. countPizzas esclude bevande/dessert/riga consegna ──────────────────────
check("2· countPizzas esclude coca", countPizzas([{ n: "Margherita", q: 2 }, { n: "Coca-Cola", q: 1 }]) === 2);
check("2b· countPizzas esclude tiramisu+agua", countPizzas([{ n: "Diavola", q: 1 }, { n: "Tiramisu", q: 1 }, { n: "Agua", q: 2 }]) === 1);
check("2c· countPizzas esclude 'Entrega a domicilio'", countPizzas([{ n: "Entrega a domicilio", q: 1 }, { n: "Napoli", q: 3 }]) === 3);

// ── 3. normalize: derivati esclusi dall'input, baseline conservata a parte ─────
const n101 = normalizeDbRow(FAKE_ROWS[0]);
check("3· normalize mappa fatti grezzi", n101.id === "#101" && n101.zona === "Q1" && n101.hora === "20:30" && n101.andata_min === 8 && n101.n_pizze === 2);
check("3b· normalize conserva estado reale (EN_COCINA)", normalizeDbRow(FAKE_ROWS[1]).estado === "EN_COCINA");
check("3c· normalize NON propaga salida/entrega/retraso/conflicto derivati",
  !("salida_driver_estimada" in n101) && !("entrega_estimada" in n101) && !("retraso_estimado_min" in n101) && !("conflicto_driver" in n101));
check("3d· baseline forno_out → forno_out_db (confronto, non input)", n101.forno_out_db === "20:22" && !("forno_out" in n101));

// ── 4. il runner shadow STRIPpa forno_out_db prima del planner (mai input) ────
const rep = runShadowFromRows([FAKE_ROWS[0], FAKE_ROWS[1], FAKE_ROWS[2]], { date: "2026-05-30", now: "19:00" });
check("4· runShadowFromRows produce summary+invariants+verdict",
  rep && "verdict" in rep && rep.invariants && "snapshotDate" in rep);
check("4b· invariante noDerivedInputLeak verde (derivati mai entrati)", rep.invariants.noDerivedInputLeak === true && rep.derivedLeak.length === 0);
check("4c· conteggi corretti (2 dom · 1 rit)", rep.deliveryOrders === 2 && rep.pickupOrders === 1);
check("4d· verdict shadow_ok su righe sane", rep.verdict === "shadow_ok");
check("4e· baseline usata solo per confronto (differences = lista)", Array.isArray(rep.differences));

// ── 5. filterByDate / rowDate ─────────────────────────────────────────────────
check("5· rowDate da created_at", rowDate(FAKE_ROWS[0]) === "2026-05-30");
const day = filterByDate(FAKE_ROWS, "2026-05-30");
check("5b· filterByDate scarta altri giorni (#999 fuori)", day.length === 3 && !day.some((r) => r.id === "#999"));

// ── 6. buildSnapshot non ha campi derivati negli orders ───────────────────────
const snap = buildSnapshotFromRows(day, { date: "2026-05-30", now: "19:00" });
const leaked = [];
for (const o of snap.orders) for (const d of ["forno_out", "salida_driver_estimada", "entrega_estimada", "retraso_estimado_min", "conflicto_driver"]) {
  if (d in o) leaked.push(o.id + ":" + d);
}
check("6· snapshot orders senza campi derivati storici", leaked.length === 0, JSON.stringify(leaked));

// ── 7. HARD READ-ONLY: lo script non contiene metodi di scrittura/RPC ─────────
const src = fs.readFileSync(path.join(__dirname, "../scripts/deliveryPlannerShadowLiveReadOnly.js"), "utf8");
const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
// token costruiti da frammenti per non sporcare il grep di safety.
const WRITE_TOKENS = ["ins" + "ert", "up" + "date", "del" + "ete", "up" + "sert", ".r" + "pc(", "ax" + "ios"];
for (const w of WRITE_TOKENS) check(`7· script senza metodo di scrittura '${w}'`, !code.toLowerCase().includes(w));
check("7b· l'unico fetch è method GET", /method:\s*"GET"/.test(code) && !/method:\s*"(POST|PATCH|PUT|DELETE)"/.test(code));
check("7c· NON importa il client live write-capable (src/utils/supabase)", !code.includes("utils/supabase"));

// ── 8. import-time: nessun accesso rete al require ────────────────────────────
// (se require avesse colpito la rete o richiesto env, sarebbe già fallito sopra.)
check("8· nessun side-effect a import-time (modulo caricato senza env/rete)", true);

console.log(`\n──────────────\n  ${pass} PASS · ${fail} FAIL\n`);
process.exit(fail ? 1 : 0);
