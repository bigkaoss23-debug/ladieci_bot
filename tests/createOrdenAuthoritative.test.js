// Test Step 2 anti-cerotto: createOrden/updateOrden autoritativi.
// Eseguire: node tests/createOrdenAuthoritative.test.js
//
// Verifica che per ordini operatore (operatorManual:true) il backend:
//   - ri-risolva indirizzo/zona/durata server-side via resolveDeliveryFields;
//   - IGNORI i campi geo/durata calcolati dal frontend (anche se bugiardi);
//   - calcoli forno_out server-side = hora − durata (manuale, no slittamento);
//   - preservi la hora scelta dall'operatore;
//   - rispetti l'override zona_manuale tracciandolo;
//   - NON tocchi il path bot (operatorManual falsy → nessuna re-resolve).
//
// Stub: supabase (sbSelect/sbInsert/sbUpdate/sbUpsert) + geoResolver.risolviIndirizzo
// + manualGiros.getManualGiros, tutti via require.cache PRIMA di caricare agentOrdini.
// Nessuna rete, nessun DB.

// ── Stub supabase ────────────────────────────────────────────────
const supaPath = require.resolve("../src/utils/supabase");
require(supaPath);
const supa = require.cache[supaPath].exports;

let INSERTED = [];
let UPDATED = [];
let STORE = {}; // id → ordine (per modificaOrdine fetch)

supa.sbSelect = async (table, query = "") => {
  if (table === "config") return []; // ORDER_RESET_TS, GEO_PROVIDER → default
  if (table === "ordenes") {
    const mId = query.match(/id=eq\.([^&]+)/);
    if (mId) {
      const id = decodeURIComponent(mId[1]);
      return STORE[id] ? [STORE[id]] : [];
    }
    return []; // id-gen window / active orders → vuoto (determinismo)
  }
  if (table === "clientes") return [];
  if (table === "geo_cache") return [];
  if (table === "manual_giros") return [];
  return [];
};
supa.sbInsert = async (table, row) => {
  if (table === "ordenes") { INSERTED.push(row); return [row]; }
  return [row];
};
supa.sbUpdate = async (table, filter, patch) => {
  if (table === "ordenes") UPDATED.push({ filter, patch });
  return {};
};
supa.sbUpsert = async () => ({});

// ── Stub geoResolver.risolviIndirizzo ───────────────────────────
const geoPath = require.resolve("../src/utils/geoResolver");
require(geoPath);
let resolveCalls = 0;
// Mappa direccion → risoluzione autoritativa (come tornerebbe il resolver reale).
const RESOLVE_MAP = {
  anade: { zona: "Q5", lat: 36.7238183, lon: -2.6395996, durataAndataMin: 12, googleMin: 12, haversineMin: 26, source: "google-from-cache-street", cached: true, fuoriZona: false, error: null },
  "playa serena": { zona: "Q5", lat: 36.7250966, lon: -2.6289733, durataAndataMin: 30, googleMin: 30, haversineMin: 31, source: "google", cached: true, fuoriZona: false, error: null },
  reino: { zona: "Q1", lat: 36.7718052, lon: -2.6090218, durataAndataMin: 8, googleMin: 8, haversineMin: 9, source: "google", cached: true, fuoriZona: false, error: null },
};
require.cache[geoPath].exports.risolviIndirizzo = async ({ direccion }) => {
  resolveCalls++;
  const key = String(direccion || "").toLowerCase().split(/\s+\d/)[0].trim();
  return RESOLVE_MAP[key] || { zona: null, lat: null, lon: null, durataAndataMin: null, googleMin: null, haversineMin: null, source: null, cached: false, fuoriZona: false, error: null };
};

// ── Stub manualGiros.getManualGiros ─────────────────────────────
const mgPath = require.resolve("../src/agents/manualGiros");
require(mgPath);
require.cache[mgPath].exports.getManualGiros = async () => [];

const { creaOrdine, modificaOrdine } = require("../src/agents/agentOrdini");

let passed = 0, failed = 0;
const assert = (name, cond, detail = "") => {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else      { console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); failed++; }
};
const section = (s) => console.log(`\n── ${s} ──`);
const lastInsert = () => INSERTED[INSERTED.length - 1];

(async () => {
  // ═══════════════════════════════════════════════════════════════
  section("T1 — payload frontend bugiardo: durata_andata_min=99 ignorato");
  {
    INSERTED = []; resolveCalls = 0;
    await creaOrdine({
      operatorManual: true, tipo_consegna: "DOMICILIO", direccion: "Anade 35",
      hora: "21:00", items: [{ n: "Margherita", q: 1, p: 7 }],
      // CLIENT MIENTE: estos valores NO deben usarse.
      durata_andata_min: 99, durata_google_min: 99, zona: "Q1", geo_source: "frontend_fake",
    });
    const row = lastInsert();
    assert("risolviIndirizzo chiamato (server-side)", resolveCalls === 1, `calls=${resolveCalls}`);
    assert("durata_andata_min = 12 (Google), NON 99", row.durata_andata_min === 12, `durata=${row.durata_andata_min}`);
    assert("zona = Q5 (resolver), NON Q1 del client", row.zona === "Q5", `zona=${row.zona}`);
    assert("geo_source = google-from-cache-street, NON frontend_fake", row.geo_source === "google-from-cache-street", `src=${row.geo_source}`);
    assert("forno_out = 20:48 (hora − 12)", row.forno_out === "20:48", `forno=${row.forno_out}`);
    assert("hora preservata 21:00", row.hora === "21:00", `hora=${row.hora}`);
  }

  // ═══════════════════════════════════════════════════════════════
  section("T2 — Anade 35, hora 21:00 → durata 12, forno_out 20:48");
  {
    INSERTED = []; resolveCalls = 0;
    await creaOrdine({
      operatorManual: true, tipo_consegna: "DOMICILIO", direccion: "Anade 35",
      hora: "21:00", items: [{ n: "Diavola", q: 1, p: 9 }],
    });
    const row = lastInsert();
    assert("durata_andata_min = 12", row.durata_andata_min === 12, `durata=${row.durata_andata_min}`);
    assert("durata_haversine_min = 26 (A/B)", row.durata_haversine_min === 26, `hav=${row.durata_haversine_min}`);
    assert("forno_out = 20:48", row.forno_out === "20:48", `forno=${row.forno_out}`);
  }

  // ═══════════════════════════════════════════════════════════════
  section("T3 — updateOrden: cambio dirección → backend re-resuelve, hora manual intacta");
  {
    UPDATED = []; resolveCalls = 0;
    STORE["#010"] = {
      id: "#010", estado: "EN_COCINA", tipo_consegna: "DOMICILIO",
      hora: "21:30", direccion: "Anade 35", zona: "Q5", zona_lat: 36.72, zona_lon: -2.63,
      durata_andata_min: 12, items: [{ n: "Margherita", q: 1, p: 7 }], tel: "699111222",
    };
    await modificaOrdine("#010", {
      operatorManual: true, direccion: "Playa Serena 5",
      // client miente otra vez:
      durata_andata_min: 5, zona: "Q1",
    });
    const u = UPDATED.find(x => x.patch.forno_out !== undefined) || UPDATED[UPDATED.length - 1];
    assert("risolviIndirizzo chiamato en update", resolveCalls >= 1, `calls=${resolveCalls}`);
    assert("durata re-resuelta = 30 (Playa Serena), NON 5", u.patch.durata_andata_min === 30, `durata=${u.patch.durata_andata_min}`);
    assert("zona re-resuelta = Q5, NON Q1 del client", u.patch.zona === "Q5", `zona=${u.patch.zona}`);
    assert("hora NO se reescribe (sin upd.hora)", u.patch.hora === undefined, `hora=${u.patch.hora}`);
    assert("forno_out = 21:00 (21:30 − 30)", u.patch.forno_out === "21:00", `forno=${u.patch.forno_out}`);
  }

  // ═══════════════════════════════════════════════════════════════
  section("T4 — zona_manuale override: operador fuerza Q3, tracciato");
  {
    INSERTED = []; resolveCalls = 0;
    await creaOrdine({
      operatorManual: true, tipo_consegna: "DOMICILIO", direccion: "Anade 35",
      hora: "21:00", items: [{ n: "Margherita", q: 1, p: 7 }],
      zona_manuale: true, zona: "Q3",
    });
    const row = lastInsert();
    assert("zona = Q3 (override operador), NON Q5 resolver", row.zona === "Q3", `zona=${row.zona}`);
    assert("zona_manuale = true (tracciato)", row.zona_manuale === true, `zm=${row.zona_manuale}`);
    assert("zona_lat descartada (coords resolver no pertenecen a Q3)", row.zona_lat == null, `lat=${row.zona_lat}`);
  }

  // ═══════════════════════════════════════════════════════════════
  section("T5 — regresión BOT: operatorManual falsy → NO re-resuelve, usa valores pasados");
  {
    INSERTED = []; resolveCalls = 0;
    // El orchestrator (bot) ya resolvió y pasa zona/durata. creaOrdine NO debe re-resolver.
    await creaOrdine({
      tipo_consegna: "DOMICILIO", direccion: "Anade 35", hora: "21:00",
      items: [{ n: "Margherita", q: 1, p: 7 }],
      zona: "Q5", zona_lat: 36.7238, zona_lon: -2.6396, durata_andata_min: 17, geo_source: "google",
      // operatorManual ausente → path bot.
    });
    const row = lastInsert();
    assert("risolviIndirizzo NO llamado en path bot", resolveCalls === 0, `calls=${resolveCalls}`);
    assert("durata = 17 (valor orchestrator preservado)", row.durata_andata_min === 17, `durata=${row.durata_andata_min}`);
    assert("zona = Q5 (orchestrator)", row.zona === "Q5", `zona=${row.zona}`);
  }

  console.log(`\n═══ RESULT: ${passed} passed, ${failed} failed ═══\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
