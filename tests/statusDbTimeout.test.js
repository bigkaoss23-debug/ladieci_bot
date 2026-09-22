// tests/statusDbTimeout.test.js — [2026-09-22] soglia del check DB di /status.
// Statico per necessità: index.js avvia il server su require, quindi non è
// importabile in un test. Lo stile segue liveSafetyGuards.stress.test.js.
// Eseguire: node tests/statusDbTimeout.test.js

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const src = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
let passed = 0, failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) { console.log("  ok  " + name); passed++; }
  else { console.log("  FAIL " + name + (detail ? " — " + detail : "")); failed++; }
};

// Latenze Railway→Supabase misurate in produzione il 2026-09-22 su /status:
// 848, 1006, 1019 ms. Il vecchio tetto di 1000 ms ci cadeva dentro.
const OSSERVATA_MAX_MS = 1019;

const m = src.match(/const STATUS_DB_TIMEOUT_MS = (\d+);/);
check("STATUS_DB_TIMEOUT_MS è definita", !!m, "costante non trovata");

const val = m ? Number(m[1]) : null;
check("vale 2500 ms", val === 2500, String(val));

check("sta sopra la latenza massima osservata in produzione",
  val > OSSERVATA_MAX_MS, `${val} <= ${OSSERVATA_MAX_MS}`);

check("ha almeno il doppio di margine sulla latenza osservata",
  val >= OSSERVATA_MAX_MS * 2, `${val} < ${OSSERVATA_MAX_MS * 2}`);

// Non deve diventare così largo da mascherare un incidente vero: se Supabase
// impiega più di 5 s per tre letture, `red` è la risposta corretta.
check("resta sotto i 5 s (oltre, un rallentamento è un incidente reale)",
  val < 5000, String(val));

// La semantica del wrapper non è stata toccata: solo il budget.
check("_withTimeout continua a rifiutare con l'etichetta passata",
  /setTimeout\(\(\) => reject\(new Error\(label\)\), ms\)/.test(src));

check("il check DB usa ancora la costante (non un numero inline)",
  /_withTimeout\(\s*Promise\.all\(/.test(src) && /STATUS_DB_TIMEOUT_MS,\s*\n\s*"db_timeout"/.test(src));

check("la cache di /status resta a 5 s", /const STATUS_CACHE_MS = 5000;/.test(src));

console.log(`\n  passed=${passed} failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);
