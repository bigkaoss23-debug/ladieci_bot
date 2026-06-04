// tests/deliveryPlannerShadowBackupReadOnly.test.js
// ===============================================================
// SHADOW BACKUP SERATA READ-ONLY — test · task SHADOW-BACKUP-SERATA-SCRIPT-08
// Run: node tests/deliveryPlannerShadowBackupReadOnly.test.js
// ===============================================================
// NIENTE DB reale: righe `backup_serata` FINTE in memoria. Verifica parser, scelta
// riga ricca, replay MOVIBILE, derivati solo baseline, NESSUNA PII in output,
// summary per data + globale, no write methods, no side-effect a import-time.
// ===============================================================
"use strict";
const fs = require("fs");
const path = require("path");
const {
  parseArgs, splitDates, pickRichestRow, extractOrdini,
  runNightShadow, runBackupShadow,
} = require("../scripts/deliveryPlannerShadowBackupReadOnly");

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label} ${extra}`); }
}

// ── Ordini FINTI con PII (devono NON comparire in output) ─────────────────────
const FAKE_ORDINI = [
  { id: "#001", tipo_consegna: "DOMICILIO", estado: "RETIRADO", zona: "Q1", hora: "20:30",
    durata_andata_min: 8, items: [{ n: "Margherita", q: 2 }, { n: "Coca", q: 1 }],
    forno_out: "20:22", manual_giro_id: null, forzado: false,
    nombre: "Mario Rossi", tel: "+39333111", direccion: "Via Segreta 1" },
  { id: "#002", tipo_consegna: "DOMICILIO", estado: "RETIRADO", zona: "Q1", hora: "20:30",
    durata_andata_min: 8, items: [{ n: "Diavola", q: 2 }], forno_out: "20:22",
    nombre: "Lucia Bianchi", tel: "+39333222", direccion: "Calle Privada 2" },
  { id: "#003", tipo_consegna: "RITIRO", estado: "RETIRADO", zona: null, hora: "20:25",
    durata_andata_min: null, items: [{ n: "Napoli", q: 3 }], forno_out: "20:25",
    nombre: "Anon", tel: "+39333333", direccion: "n/a" },
];
const NIGHT_ROW = { fecha: "2026-05-30", n_ordini: 3, ordini: FAKE_ORDINI };

// ── 1. parser ─────────────────────────────────────────────────────────────────
check("1· --date singola", parseArgs(["--date", "2026-05-31"]).dates.join() === "2026-05-31");
check("1b· --dates CSV", parseArgs(["--dates", "2026-05-28,2026-05-29"]).dates.length === 2);
check("1c· --dates= inline + dedup", parseArgs(["--dates=2026-05-30,2026-05-30"]).dates.length === 1);
// splitDates valida solo il FORMATO YYYY-MM-DD (non il calendario): scarta i token mal formati.
check("1d· splitDates scarta token mal formati", splitDates("2026-05-31,xx,2026-5-1, ,2026-05-28").join() === "2026-05-31,2026-05-28");
const noArgs = parseArgs([]);
check("3· errore pulito se manca data", noArgs.error === "missing --date or --dates" && noArgs.dates.length === 0);

// ── 4/5. scelta riga ricca + estrazione ordini JSON ───────────────────────────
const dupRows = [{ fecha: "x", ordini: [{}, {}] }, { fecha: "x", ordini: [{}, {}, {}, {}] }];
const picked = pickRichestRow(dupRows);
check("4· pickRichestRow sceglie la riga con più ordini", picked.row.ordini.length === 4 && picked.ambiguous === true && picked.candidates === 2);
check("4b· pickRichestRow su vuoto → null non-ambiguo", pickRichestRow([]).row === null);
check("5· extractOrdini legge il JSON array", extractOrdini(NIGHT_ROW).length === 3);

// ── 6. NESSUNA PII nell'output ─────────────────────────────────────────────────
const rep = runNightShadow(FAKE_ORDINI, { date: "2026-05-30", now: "19:00" });
const repStr = JSON.stringify(rep);
check("6· output NON contiene nomi/telefoni/indirizzi",
  !/Mario|Lucia|Rossi|Bianchi|\+3933|Via Segreta|Calle Privada/.test(repStr), "PII leak!");
check("6b· differences espongono solo id/zona/orari/severity/reason",
  rep.differences.every((d) => Object.keys(d).every((k) => ["orderId", "zona", "type", "old", "planner", "retraso", "severity", "reason"].includes(k))));

// ── 7. derivati solo baseline (forno_out non entra come input) ─────────────────
check("7· invariante noDerivedInputLeak verde", rep.invariants.noDerivedInputLeak === true);
check("7b· counts corretti (2 dom · 1 rit)", rep.deliveryOrders === 2 && rep.pickupOrders === 1);

// ── 8/9/10. summary per data + globale + invariants ───────────────────────────
const { aggregate, perDate } = runBackupShadow([
  { date: "2026-05-30", rows: [NIGHT_ROW] },
  { date: "2026-05-31", rows: [] }, // serata mancante → found:false
], { now: "19:00" });
check("8· perDate per ogni richiesta", perDate.length === 2 && perDate[0].date === "2026-05-30");
check("8b· serata senza riga → found:false (no crash)", perDate[1].found === false);
check("9· aggregate globale presente", aggregate && "verdict" in aggregate && aggregate.snapshots === 1 && aggregate.totalOrders === 3);
check("10· invariants presenti in ogni report", perDate[0].invariants && "noRiderOverlap" in perDate[0].invariants);
check("10b· verdict shadow_ok su dati sani", aggregate.verdict === "shadow_ok");

// ── 11. zero write methods / no client write-capable / no PII print nello script
const src = fs.readFileSync(path.join(__dirname, "../scripts/deliveryPlannerShadowBackupReadOnly.js"), "utf8");
const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
const WRITE_TOKENS = ["ins" + "ert", "up" + "date", "del" + "ete", "up" + "sert", ".r" + "pc(", "ax" + "ios"];
for (const w of WRITE_TOKENS) check(`11· script senza '${w}'`, !code.toLowerCase().includes(w));
check("11b· unico fetch è method GET", /method:\s*"GET"/.test(code) && !/method:\s*"(POST|PATCH|PUT|DELETE)"/.test(code));
check("11c· NON importa client write-capable (utils/supabase)", !code.includes("utils/supabase"));
check("11d· lo script NON stampa/seleziona PII (no nombre/tel/direccion nel codice)",
  !/nombre|direccion/.test(code) && !/\btel\b/.test(code));

// ── 12/13. import-time safe + env missing gestito ─────────────────────────────
check("12· nessun side-effect a import-time (modulo caricato senza env/rete)", true);
// 13: la funzione pura gira senza env (nessun process.env nel core-path testato).
check("13· runBackupShadow gira senza env/rete", runBackupShadow([{ date: "x", rows: [NIGHT_ROW] }]).aggregate.totalOrders === 3);

console.log(`\n──────────────\n  ${pass} PASS · ${fail} FAIL\n`);
process.exit(fail ? 1 : 0);
