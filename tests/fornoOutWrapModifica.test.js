// Test modificaOrdine per BUG-FORNO-OUT-WRAP-00-01.
// Eseguire: node tests/fornoOutWrapModifica.test.js
//
// Usa stub in memoria: nessuna rete, nessuna scrittura DB.

const supaPath = require.resolve("../src/utils/supabase");
require(supaPath);
const supa = require.cache[supaPath].exports;

const previewPath = require.resolve("../src/agents/previewTiming");
require.cache[previewPath] = {
  id: previewPath,
  filename: previewPath,
  loaded: true,
  exports: {
    resolveDeliveryFields: async ({ direccion }) => {
      const isLong = /larga|playa/i.test(String(direccion || ""));
      return {
        zona: "Q5",
        zona_lat: 36.7250966,
        zona_lon: -2.6289733,
        durata_andata_min: isLong ? 13 : 12,
        durata_google_min: isLong ? 13 : 12,
        durata_haversine_min: null,
        geo_source: "test-google",
      };
    },
  },
};

let current = null;
let updates = [];

const baseOrder = () => ({
  id: "#W01",
  estado: "EN_COCINA",
  tipo_consegna: "DOMICILIO",
  hora: "21:00",
  direccion: "base",
  zona: "Q5",
  zona_lat: 36.7250966,
  zona_lon: -2.6289733,
  geo_source: "test-google",
  durata_andata_min: 12,
  durata_google_min: 12,
  durata_haversine_min: null,
  items: [{ n: "Margherita", q: 1, p: 10, cat: "Pizzas" }],
  tel: "699000000",
  forzado: false,
});

supa.sbSelect = async (table, query = "") => {
  if (table === "config") return [];
  if (table === "ordenes") {
    if (query.includes("id=eq.%23W01")) return current ? [current] : [];
    if (/tipo_consegna=eq\.DOMICILIO/.test(query)) return [];
  }
  return [];
};
supa.sbUpdate = async (table, query, patch) => {
  if (table === "ordenes" && query.includes("id=eq.%23W01")) {
    updates.push(patch);
    current = { ...current, ...patch };
    return [current];
  }
  return [];
};
supa.sbInsert = async () => [];
supa.sbUpsert = async () => ({});
supa.sbDelete = async () => ({});

const { modificaOrdine } = require("../src/agents/agentOrdini");

let passed = 0, failed = 0;
const assert = (name, cond, detail = "") => {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else      { console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); failed++; }
};
const section = (s) => console.log(`\n── ${s} ──`);

(async () => {
  section("T1 — modifica hora a 00:10 salva forno_out 23:58");
  {
    current = baseOrder();
    updates = [];
    await modificaOrdine("#W01", { operatorManual: true, hora: "00:10" });
    const patch = updates.find(u => u.forno_out !== undefined);
    assert("hora patch = 00:10", patch?.hora === "00:10", `hora=${patch?.hora}`);
    assert("forno_out = 23:58", patch?.forno_out === "23:58", `forno=${patch?.forno_out}`);
    assert("nessun 24/25", !/\b2[4-9]:\d\d/.test(JSON.stringify(patch)), JSON.stringify(patch));
  }

  section("T2 — cambio indirizzo con durata maggiore vicino mezzanotte wrappa");
  {
    current = { ...baseOrder(), hora: "00:05", durata_andata_min: 12, forno_out: "23:53" };
    updates = [];
    await modificaOrdine("#W01", { operatorManual: true, direccion: "playa larga" });
    const patch = updates.find(u => u.forno_out !== undefined);
    assert("durata ri-risolta = 13", patch?.durata_andata_min === 13, `durata=${patch?.durata_andata_min}`);
    assert("forno_out = 23:52", patch?.forno_out === "23:52", `forno=${patch?.forno_out}`);
    assert("zona Q5 preservata da resolver", patch?.zona === "Q5", `zona=${patch?.zona}`);
    assert("hora non riscritta se non cambia", patch?.hora === undefined, `hora=${patch?.hora}`);
    assert("nessun 24/25", !/\b2[4-9]:\d\d/.test(JSON.stringify(patch)), JSON.stringify(patch));
  }

  console.log(`\n═══ RESULT: ${passed} passed, ${failed} failed ═══\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
