// tests/caricoDeliveryZoneCapacity.test.js — [DELIVERY-REFACTOR 2026-09-22]
// getCaricoDelivery non aveva copertura. Questo test fissa cosa DEVE fare dopo la
// separazione cucina / rider:
//   RESTA  → capacità (zona, slot10) contro zona.maxOrdiniPerGiro, e forno_out
//            derivato dal tempo di percorrenza reale
//   NON C'È PIÙ → lettura di config.DRIVER_STATO, pavimento driverLiberoMin,
//            proposte accodate dietro lo schedule simulato del rider
// Eseguire: node tests/caricoDeliveryZoneCapacity.test.js — nessuna rete, nessun DB.

const supaPath = require.resolve("../src/utils/supabase");
require(supaPath);
let ORDENES = [];
let QUERIES = [];
require.cache[supaPath].exports.sbSelect = async (table, query = "") => {
  QUERIES.push({ table, query });
  if (table === "ordenes") return ORDENES;
  return [];
};

const { getCaricoDelivery } = require("../src/agents/agentCucina");

let passed = 0, failed = 0;
const assert = (name, cond, detail = "") => {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else      { console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); failed++; }
};
const section = (s) => console.log(`\n── ${s} ──`);
const dom = (id, hora, zona = "Q1") => ({ id, tipo_consegna: "DOMICILIO", estado: "EN_COCINA", zona, hora, durata_andata_min: 8 });
const reset = () => { ORDENES = []; QUERIES = []; };

(async () => {
  section("T1 — zona libera: l'ora richiesta viene confermata");
  {
    reset();
    const r = await getCaricoDelivery("Q1", "21:00", 8);
    assert("slot = 21:00", r.slotAssegnato === "21:00", r.slotAssegnato);
    assert("zona non completa", r.zonaCompleta === false);
    assert("forno_out = 20:52 (hora − 8)", r.forno_out === "20:52", r.forno_out);
    assert("driverInGiro sempre false", r.driverInGiro === false);
  }

  section("T2 — nessuna lettura di config: DRIVER_STATO non viene più interrogato");
  {
    reset();
    await getCaricoDelivery("Q1", "21:00", 8);
    assert("nessuna query sulla tabella config", !QUERIES.some(q => q.table === "config"),
           JSON.stringify(QUERIES.map(q => q.table)));
  }

  section("T3 — capacità di zona: lo slot pieno viene scavalcato");
  {
    reset();
    // Q1 max = 4. Riempiamo lo slot 21:00 e lasciamo posto in 21:10.
    ORDENES = ["a", "b", "c", "d"].map((x, i) => dom(`#${i}`, "21:00"));
    const r = await getCaricoDelivery("Q1", "21:00", 8);
    assert("slot spostato oltre le 21:00", r.slotAssegnato !== "21:00", r.slotAssegnato);
    assert("slot = 21:10 (primo con posto)", r.slotAssegnato === "21:10", r.slotAssegnato);
    assert("zona non completa", r.zonaCompleta === false);
  }

  section("T4 — aggregazione: slot della stessa zona con ancora posto");
  {
    reset();
    ORDENES = [dom("#1", "21:20"), dom("#2", "21:20")]; // 2 < max 4
    const r = await getCaricoDelivery("Q1", "21:10", 8);
    assert("si accoda allo slot caldo 21:20", r.slotAssegnato === "21:20", r.slotAssegnato);
    assert("forno_out = 21:12", r.forno_out === "21:12", r.forno_out);
  }

  section("T5 — uno schedule pesante in ALTRE zone non sposta più nulla");
  {
    reset();
    // Prima della release: questi due Q5 lontani e tardi spingevano driverLiberoMin
    // a ~23:13 e ogni nuova proposta finiva lì dietro.
    ORDENES = [
      { id: "#006", tipo_consegna: "DOMICILIO", estado: "EN_COCINA", zona: "Q5", hora: "21:52", durata_andata_min: 23 },
      { id: "#007", tipo_consegna: "DOMICILIO", estado: "EN_COCINA", zona: "Q5", hora: "22:44", durata_andata_min: 26 },
    ];
    const r = await getCaricoDelivery("Q1", "20:50", 8);
    assert("Q1 confermata alle 20:50", r.slotAssegnato === "20:50", r.slotAssegnato);
    assert("forno_out = 20:42", r.forno_out === "20:42", r.forno_out);
  }

  section("T6 — la capacità guarda la zona giusta");
  {
    reset();
    ORDENES = ["a", "b", "c", "d"].map((x, i) => dom(`#${i}`, "21:00", "Q2")); // Q2 pieno (max 3)
    const r = await getCaricoDelivery("Q1", "21:00", 8);
    assert("Q1 resta libera alle 21:00", r.slotAssegnato === "21:00", r.slotAssegnato);
  }

  section("T7 — zona inesistente: risposta neutra");
  {
    reset();
    const r = await getCaricoDelivery("ZZZ", "21:00", 8);
    assert("slot = ora richiesta", r.slotAssegnato === "21:00");
    assert("driverInGiro false", r.driverInGiro === false);
  }

  console.log(`\n═══ RESULT: ${passed} passed, ${failed} failed ═══`);
  process.exit(failed === 0 ? 0 : 1);
})();
