// tests/fornoOutKitchenOnly.test.js — [DELIVERY-REFACTOR 2026-09-22]
// Sostituisce fornoOutFallbackSlot.test.js, la cui premessa (slot-search sulla
// disponibilità simulata del rider) è stata rimossa dal percorso ordini.
//
// Contratto verificato qui:
//   forno_out = hora − durata_andata_min          ← CUCINA (tempo di percorrenza reale)
//   `hora` non viene MAI spostata da assunzioni sul rider
//   dashboard (operatorManual) e bot WhatsApp calcolano la STESSA cosa
//
// Eseguire: node tests/fornoOutKitchenOnly.test.js — nessuna rete, nessun DB.

const supaPath = require.resolve("../src/utils/supabase");
require(supaPath);
let STUB_ROWS = [];
require.cache[supaPath].exports.sbSelect = async () => STUB_ROWS;

const { calcolaFornoOutFallback } = require("../src/agents/agentOrdini");
const { calcolaFornoOut } = require("../src/utils/zones");

let passed = 0, failed = 0;
const assert = (name, cond, detail = "") => {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else      { console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); failed++; }
};
const section = (s) => console.log(`\n── ${s} ──`);
const toMin = (t) => { const [h, m] = String(t).split(":").map(Number); return h * 60 + (m || 0); };

// Coordinate reali dalla geo_cache live.
const Q1_LAT = 36.7718052, Q1_LON = -2.6090218;   // Reino de España 46 (andata ~8')
const Q5_PLAYA = { lat: 36.7250966, lon: -2.6289733 };
const Q5_ANADE = { lat: 36.7238183, lon: -2.6395996 };

// Schedule "pesante": due delivery Q5 lontani e tardi. Prima di questa release
// spingevano in avanti qualsiasi nuovo ordine (driverLiberoMin ≈ 23:13).
const GIRO_PESANTE = [
  { id: "#006", tipo_consegna: "DOMICILIO", hora: "21:52", zona: "Q5", estado: "EN_COCINA",
    durata_andata_min: 23, zona_lat: Q5_PLAYA.lat, zona_lon: Q5_PLAYA.lon },
  { id: "#007", tipo_consegna: "DOMICILIO", hora: "22:44", zona: "Q5", estado: "EN_COCINA",
    durata_andata_min: 26, zona_lat: Q5_ANADE.lat, zona_lon: Q5_ANADE.lon },
];

(async () => {
  section("T1 — nessun pavimento rider: la hora richiesta resta la hora promessa");
  {
    STUB_ROWS = GIRO_PESANTE;
    const r = await calcolaFornoOutFallback({ tipoConsegna: "DOMICILIO", hora: "20:50", durataAndataMin: 8 });
    assert("hora NON spostata (20:50)", r.hora_finale === "20:50", `hora=${r.hora_finale}`);
    assert("slittato = false", r.slittato === false, String(r.slittato));
    assert("forno_out = 20:42 (= hora − 8)", r.forno_out === "20:42", `forno_out=${r.forno_out}`);
    assert("invariante hora = forno_out + andata", toMin(r.hora_finale) - toMin(r.forno_out) === 8);
  }

  section("T2 — lo schedule esistente non influenza più il risultato");
  {
    STUB_ROWS = GIRO_PESANTE;
    const conGiri = await calcolaFornoOutFallback({ tipoConsegna: "DOMICILIO", hora: "21:00", durataAndataMin: 12 });
    STUB_ROWS = [];
    const senzaGiri = await calcolaFornoOutFallback({ tipoConsegna: "DOMICILIO", hora: "21:00", durataAndataMin: 12 });
    assert("stesso forno_out con e senza ordini in DB", conGiri.forno_out === senzaGiri.forno_out,
           `${conGiri.forno_out} vs ${senzaGiri.forno_out}`);
    assert("stessa hora con e senza ordini in DB", conGiri.hora_finale === senzaGiri.hora_finale);
    assert("forno_out = 20:48", conGiri.forno_out === "20:48", conGiri.forno_out);
  }

  section("T3 — dashboard vs bot WhatsApp: stessa logica cucina a parità di input");
  {
    // Il percorso dashboard (operatorManual) chiama calcolaFornoOut con
    // driverLiberoMin: 0; il bot passa da calcolaFornoOutFallback. Devono coincidere.
    STUB_ROWS = GIRO_PESANTE;
    for (const [hora, andata] of [["20:50", 8], ["21:00", 12], ["22:30", 26], ["00:16", 8]]) {
      const bot = await calcolaFornoOutFallback({ tipoConsegna: "DOMICILIO", hora, durataAndataMin: andata });
      const dashboard = calcolaFornoOut({ tipoConsegna: "DOMICILIO", hora, durataAndataMin: andata, driverLiberoMin: 0 });
      assert(`${hora} / andata ${andata}': forno_out identico (${bot.forno_out})`,
             bot.forno_out === dashboard.forno_out, `bot=${bot.forno_out} dash=${dashboard.forno_out}`);
      assert(`${hora} / andata ${andata}': hora identica (${bot.hora_finale})`,
             bot.hora_finale === dashboard.hora_finale, `bot=${bot.hora_finale} dash=${dashboard.hora_finale}`);
      assert(`${hora} / andata ${andata}': nessuno dei due slitta`,
             bot.slittato === false && dashboard.slittato === false);
    }
  }

  section("T4 — wrap oltre la mezzanotte preservato (regressione 00:16 − 8 = 00:08)");
  {
    STUB_ROWS = [];
    const r = await calcolaFornoOutFallback({ tipoConsegna: "DOMICILIO", hora: "00:16", durataAndataMin: 8 });
    assert("forno_out = 00:08", r.forno_out === "00:08", r.forno_out);
  }

  section("T5 — RITIRO e input incompleti: forno_out = hora");
  {
    STUB_ROWS = [];
    const ritiro = await calcolaFornoOutFallback({ tipoConsegna: "RITIRO", hora: "21:00", durataAndataMin: null });
    assert("RITIRO: forno_out = hora", ritiro.forno_out === "21:00" && ritiro.hora_finale === "21:00");
    const senzaDurata = await calcolaFornoOutFallback({ tipoConsegna: "DOMICILIO", hora: "21:00", durataAndataMin: null });
    assert("DOMICILIO senza durata: forno_out = hora (prudente)", senzaDurata.forno_out === "21:00");
    const senzaHora = await calcolaFornoOutFallback({ tipoConsegna: "DOMICILIO", hora: null, durataAndataMin: 8 });
    assert("senza hora: tutto null", senzaHora.forno_out === null && senzaHora.hora_finale === null);
  }

  section("T6 — nessuna lettura di ordini: la funzione non dipende più dal DB");
  {
    let letto = false;
    require.cache[supaPath].exports.sbSelect = async () => { letto = true; return []; };
    await calcolaFornoOutFallback({ tipoConsegna: "DOMICILIO", hora: "21:00", durataAndataMin: 10 });
    assert("nessuna sbSelect durante il calcolo di forno_out", letto === false);
  }

  console.log(`\n═══ RESULT: ${passed} passed, ${failed} failed ═══`);
  process.exit(failed === 0 ? 0 : 1);
})();
