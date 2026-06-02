// Test integrazione per la regola "ordini manuali = orario deterministico".
// Eseguire: node tests/manualOrderTime.test.js
//
// HOTFIX 31/05/2026: per operatorManual:true il backend NON deve MAI spostare la
// hora scelta dall'operatore. Calcola solo forno_out = hora − durata_andata_min
// (DOMICILIO) o forno_out = hora (RITIRO / durata mancante). Nessuno slot-search,
// nessuno slittamento driver — anche se esistono giri lontani attivi.
//
// Stub DB: sovrascriviamo i metodi del modulo supabase nella cache PRIMA di
// caricare agentOrdini, così creaOrdine reale gira senza toccare il database.
// sbInsert cattura la riga che SAREBBE scritta su `ordenes`; asseriamo su quella.

const supaPath = require.resolve("../src/utils/supabase");
require(supaPath);
const supa = require.cache[supaPath].exports;

// Giri Q5 lontani attivi (caso live): NON devono influenzare l'ordine manuale.
const FAR_Q5 = [
  { id:"#006", tipo_consegna:"DOMICILIO", hora:"00:22", zona:"Q5", estado:"EN_COCINA", durata_andata_min:23, forno_out:"00:27" },
  { id:"#007", tipo_consegna:"DOMICILIO", hora:"00:25", zona:"Q5", estado:"EN_COCINA", durata_andata_min:26, forno_out:"01:16" },
];
let inserted = null;
supa.sbSelect = async (table, query = "") => {
  // deliveries per risincronizzaGiro/planFornoOutSync: torniamo i giri lontani per
  // dimostrare che NON spostano l'ordine manuale. Tutto il resto (idempotency,
  // config, max-id) → [] così l'id generato è #001 e non scatta nessun replay.
  if (table === "ordenes" && /tipo_consegna=eq\.DOMICILIO/.test(query)) return FAR_Q5;
  return [];
};
supa.sbInsert = async (table, row) => { if (table === "ordenes") inserted = row; return [row]; };
supa.sbUpdate = async () => ({});
supa.sbUpsert = async () => ({});

const { creaOrdine } = require("../src/agents/agentOrdini");

let passed = 0, failed = 0;
const assert = (name, cond, detail = "") => {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else      { console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); failed++; }
};
const section = (s) => console.log(`\n── ${s} ──`);

// Helper: crea un ordine manuale e ritorna la riga catturata da sbInsert.
async function manual({ tipo, hora, durata, zona }) {
  inserted = null;
  await creaOrdine({
    operatorManual: true,
    canal: "MANUAL",
    nombre: "TEST_MANUAL_TIME_DELETE_OK",
    cliente_id: 1, // salta upsert cliente
    items: [{ q: 1, cat: "Pizzas", n: "Margherita", precio: 10 }],
    tipo_consegna: tipo,
    hora,
    durata_andata_min: durata ?? null,
    zona: zona ?? null,
    estado: "EN_COCINA",
  });
  return inserted;
}

(async () => {
  section("T1 — DOMICILIO 21:00 / andata 8 → hora 21:00, forno 20:52 (giri lontani ignorati)");
  {
    const r = await manual({ tipo: "DOMICILIO", hora: "21:00", durata: 8, zona: "Q1" });
    assert("hora preservata 21:00", r?.hora === "21:00", `hora=${r?.hora}`);
    assert("forno_out = 20:52", r?.forno_out === "20:52", `forno_out=${r?.forno_out}`);
    assert("NON accodato dietro Q5 lontani (forno < 23:00)",
           Number(r?.forno_out?.split(":")[0]) < 23, `forno_out=${r?.forno_out}`);
  }

  section("T2 — DOMICILIO oltre mezzanotte 00:16 / andata 8 → hora 00:16, forno 00:08");
  {
    const r = await manual({ tipo: "DOMICILIO", hora: "00:16", durata: 8, zona: "Q1" });
    assert("hora preservata 00:16", r?.hora === "00:16", `hora=${r?.hora}`);
    assert("forno_out = 00:08 (wrap 24h)", r?.forno_out === "00:08", `forno_out=${r?.forno_out}`);
  }

  section("T3 — DOMICILIO after-midnight negativo → wrap a sera precedente");
  {
    const a = await manual({ tipo: "DOMICILIO", hora: "00:05", durata: 13, zona: "Q5" });
    assert("00:05 − 13 = 23:52", a?.forno_out === "23:52", `forno_out=${a?.forno_out}`);
    const b = await manual({ tipo: "DOMICILIO", hora: "00:10", durata: 12, zona: "Q5" });
    assert("00:10 − 12 = 23:58", b?.forno_out === "23:58", `forno_out=${b?.forno_out}`);
    const c = await manual({ tipo: "DOMICILIO", hora: "00:11", durata: 12, zona: "Q5" });
    assert("00:11 − 12 = 23:59", c?.forno_out === "23:59", `forno_out=${c?.forno_out}`);
    assert("nessun 24/25", !/\b2[4-9]:\d\d/.test(JSON.stringify([a,b,c])), JSON.stringify([a,b,c]));
  }

  section("T4 — DOMICILIO tardi 23:55 / andata 8 → hora 23:55, forno 23:47");
  {
    const r = await manual({ tipo: "DOMICILIO", hora: "23:55", durata: 8, zona: "Q1" });
    assert("hora preservata 23:55", r?.hora === "23:55", `hora=${r?.hora}`);
    assert("forno_out = 23:47", r?.forno_out === "23:47", `forno_out=${r?.forno_out}`);
  }

  section("T5 — RITIRO 21:00 → hora 21:00, forno 21:00");
  {
    const r = await manual({ tipo: "RITIRO", hora: "21:00" });
    assert("hora preservata 21:00", r?.hora === "21:00", `hora=${r?.hora}`);
    assert("forno_out = 21:00", r?.forno_out === "21:00", `forno_out=${r?.forno_out}`);
  }

  section("T6 — DOMICILIO senza durata → hora intatta, forno = hora (prudente)");
  {
    const r = await manual({ tipo: "DOMICILIO", hora: "21:30", durata: null, zona: "Q1" });
    assert("hora preservata 21:30", r?.hora === "21:30", `hora=${r?.hora}`);
    assert("forno_out = 21:30 (no durata)", r?.forno_out === "21:30", `forno_out=${r?.forno_out}`);
  }

  console.log(`\n═══ RESULT: ${passed} passed, ${failed} failed ═══\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
