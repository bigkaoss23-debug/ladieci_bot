// Test integrazione per calcolaFornoOutFallback (slot-search, fix 31/05/2026).
// Eseguire: node tests/fornoOutFallbackSlot.test.js
//
// Verifica il fix del bug live: un nuovo delivery vicino NON deve più essere
// accodato dietro l'intero schedule (driverLiberoMin come pavimento rigido) se
// c'è un buco libero prima. Riproduce il caso #010 DAVID e i casi di regressione.
//
// Stub DB: sovrascriviamo sbSelect nella cache del modulo supabase PRIMA di
// caricare agentOrdini, così la funzione reale gira contro un set di ordini noto
// senza toccare il database. Nessuna scrittura, nessun deploy.

// Clock congelato a 20:38 Europe/Madrid (= 18:38 UTC, CEST) per determinismo:
// calcolaFornoOutFallback usa nowMadridMinutes() internamente, che dipende da
// new Date(). Senza freeze il test sarebbe flaky a seconda dell'ora di esecuzione.
const FIXED = new Date("2026-05-31T18:38:00Z");
const RealDate = Date;
global.Date = class extends RealDate {
  constructor(...args) { return args.length === 0 ? new RealDate(FIXED.getTime()) : new RealDate(...args); }
  static now() { return FIXED.getTime(); }
};

const supaPath = require.resolve("../src/utils/supabase");
require(supaPath); // forza il caricamento in cache
let STUB_ROWS = [];
require.cache[supaPath].exports.sbSelect = async () => STUB_ROWS;

const { calcolaFornoOutFallback } = require("../src/agents/agentOrdini");

let passed = 0, failed = 0;
const assert = (name, cond, detail = "") => {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else      { console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); failed++; }
};
const section = (s) => console.log(`\n── ${s} ──`);
const toMin = (t) => { const [h,m] = String(t).split(":").map(Number); return h*60+(m||0); };

// Coordinate reali dalla geo_cache live (per far calcolare a proposeForNewOrder
// il tempoGiro corretto via haversine invece del fallback zona).
const Q1_LAT = 36.7718052, Q1_LON = -2.6090218; // Reino de España 46
const Q5_PLAYA = { lat: 36.7250966, lon: -2.6289733 };
const Q5_ANADE = { lat: 36.7238183, lon: -2.6395996 };

// ═══════════════════════════════════════════════════════════════════════════
section("T1 — caso live #010 DAVID: Q1 vicino NON accodato dietro manual giro Q5");
// Stato live: #006 Q5 21:52 (andata 23) + #007 Q5 22:44 (andata 26) in manual giro.
// driverLiberoMin = 23:13. Nuovo Q1 (andata 8) creato alle 20:38 Madrid.
{
  STUB_ROWS = [
    { id:"#006", tipo_consegna:"DOMICILIO", hora:"21:52", zona:"Q5", estado:"EN_COCINA",
      durata_andata_min:23, zona_lat:Q5_PLAYA.lat, zona_lon:Q5_PLAYA.lon },
    { id:"#007", tipo_consegna:"DOMICILIO", hora:"22:44", zona:"Q5", estado:"EN_COCINA",
      durata_andata_min:26, zona_lat:Q5_ANADE.lat, zona_lon:Q5_ANADE.lon },
  ];
  // PRIMA del fix: forno_out 23:13 / hora 23:21 (accodato dietro driverLiberoMin).
  // DOPO il fix: slot-search trova il buco prima del giro Q5 → ~20:47 / 20:55.
  calcolaFornoOutFallback({
    tipoConsegna:"DOMICILIO", hora:"20:50", durataAndataMin:8,
    zona:"Q1", zonaLat:Q1_LAT, zonaLon:Q1_LON,
  }).then(r => {
    assert(`NON accodato dietro #007 (forno_out ${r.forno_out} < 23:00)`,
           toMin(r.forno_out) < toMin("23:00"),
           `forno_out=${r.forno_out} hora=${r.hora_finale}`);
    assert(`forno_out = 20:47 (got ${r.forno_out})`, r.forno_out === "20:47", `forno_out=${r.forno_out}`);
    assert(`hora consegna = 20:55 (got ${r.hora_finale})`, r.hora_finale === "20:55", `hora=${r.hora_finale}`);
    assert(`invariante hora = forno_out + 8`,
           toMin(r.hora_finale) - toMin(r.forno_out) === 8);
    run2();
  });
}

// ═══════════════════════════════════════════════════════════════════════════
function run2() {
  section("T2 — nessun delivery attivo: Q1 vicino resta vicino");
  STUB_ROWS = [];
  calcolaFornoOutFallback({
    tipoConsegna:"DOMICILIO", hora:"20:50", durataAndataMin:8,
    zona:"Q1", zonaLat:Q1_LAT, zonaLon:Q1_LON,
  }).then(r => {
    assert(`forno_out = 20:47 (got ${r.forno_out})`, r.forno_out === "20:47", `forno_out=${r.forno_out}`);
    assert(`hora = 20:55 (got ${r.hora_finale})`, r.hora_finale === "20:55", `hora=${r.hora_finale}`);
    assert(`invariante hora = forno_out + 8`,
           toMin(r.hora_finale) - toMin(r.forno_out) === 8,
           `forno=${r.forno_out} hora=${r.hora_finale}`);
    run3();
  });
}

// ═══════════════════════════════════════════════════════════════════════════
function run3() {
  section("T3 — aggregazione same-zone-slot preservata");
  // Esiste già un giro Q1 alle 20:50. Nuovo Q1 stesso slot → condivide forno_out
  // del giro (hora resta quella richiesta, niente slittamento).
  STUB_ROWS = [
    { id:"#A", tipo_consegna:"DOMICILIO", hora:"20:50", zona:"Q1", estado:"EN_COCINA",
      durata_andata_min:8, zona_lat:Q1_LAT, zona_lon:Q1_LON },
  ];
  calcolaFornoOutFallback({
    tipoConsegna:"DOMICILIO", hora:"20:50", durataAndataMin:8,
    zona:"Q1", zonaLat:Q1_LAT, zonaLon:Q1_LON,
  }).then(r => {
    assert(`hora richiesta preservata 20:50 (got ${r.hora_finale})`,
           r.hora_finale === "20:50", `hora=${r.hora_finale}`);
    assert(`non slittato (aggregato)`, r.slittato === false);
    run4();
  });
}

// ═══════════════════════════════════════════════════════════════════════════
function run4() {
  section("T4 — RITIRO invariato: forno_out = hora, niente slot-search");
  STUB_ROWS = [
    { id:"#006", tipo_consegna:"DOMICILIO", hora:"21:52", zona:"Q5", estado:"EN_COCINA",
      durata_andata_min:23, zona_lat:Q5_PLAYA.lat, zona_lon:Q5_PLAYA.lon },
  ];
  calcolaFornoOutFallback({
    tipoConsegna:"RITIRO", hora:"21:00", durataAndataMin:null, zona:null,
  }).then(r => {
    assert(`RITIRO forno_out = hora (21:00)`, r.forno_out === "21:00" && r.hora_finale === "21:00",
           `forno=${r.forno_out} hora=${r.hora_finale}`);
    assert(`RITIRO non slittato`, r.slittato === false);
    run5();
  });
}

// ═══════════════════════════════════════════════════════════════════════════
function run5() {
  section("T5 — zona null / durata null: comportamento invariato (no crash)");
  STUB_ROWS = [];
  calcolaFornoOutFallback({
    tipoConsegna:"DOMICILIO", hora:"21:00", durataAndataMin:null, zona:null,
  }).then(r => {
    assert(`no crash, forno_out = hora`, r.forno_out === "21:00", `forno=${r.forno_out}`);
    finish();
  }).catch(e => { assert("no crash", false, e.message); finish(); });
}

function finish() {
  console.log(`\n═══ RESULT: ${passed} passed, ${failed} failed ═══\n`);
  process.exit(failed > 0 ? 1 : 0);
}
