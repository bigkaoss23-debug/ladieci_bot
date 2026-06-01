// Test per l'arricchimento durata via Google su cache senza durata.
// Eseguire: node tests/geoResolverEnrich.test.js
//
// Decisione prodotto 31/05/2026: se geo_cache risolve coords+zona ma durata=null,
// il resolver chiama Google Distance Matrix (sulle coords cached, niente re-geocode),
// usa quella durata, la salva in cache, e marca source "google-from-<orig>".
// Solo se Google è spento/fallisce → durata resta null (consumer userà haversine).
//
// Caso reale: "Anade 35" veniva da cache nominatim durata null → frontend haversine 26.
// Atteso dopo fix: Google ~11 min → durataAndataMin 11, googleMin 11, NON 26.

// Stub supabase nella cache PRIMA di require, + GOOGLE key fittizia per abilitare DM.
process.env.GOOGLE_MAPS_API_KEY = "test-key-not-real";

const supaPath = require.resolve("../src/utils/supabase");
require(supaPath);
const supa = require.cache[supaPath].exports;

// Riga cache "anade": coords+zona Q5 ma durata NULL (come live, source nominatim).
const CACHE_ROW = {
  direccion_key: "anade", direccion_orig: "ANADE", zona: "Q5",
  lat: 36.7238183, lon: -2.6395996, durata_andata_min: null,
  source: "nominatim", hit_count: 1, n_ordini_consegnati: 0,
};
let upserted = null;
let cacheDurata = null; // diventa non-null dopo il backfill, per simulare l'hit successivo

supa.sbSelect = async (table, query = "") => {
  if (table === "config" && /GEO_PROVIDER/.test(query)) return [{ valore: "shadow" }];
  if (table === "geo_cache" && /direccion_key=eq\.anade(&|$)/.test(query)) {
    return [{ ...CACHE_ROW, durata_andata_min: cacheDurata }];
  }
  return [];
};
supa.sbUpdate = async () => ({});          // hit_count bump → noop
supa.sbUpsert = async (table, row) => { if (table === "geo_cache") upserted = row; return [row]; };

// Mock fetch: solo Distance Matrix. Il flag DM_OK controlla successo/fallimento.
let DM_OK = true;
let fetchCalls = 0;
global.fetch = async (url) => {
  fetchCalls++;
  if (String(url).includes("distancematrix")) {
    if (!DM_OK) return { ok: true, json: async () => ({ status: "OK", rows: [{ elements: [{ status: "ZERO_RESULTS" }] }] }) };
    // 660s → ceil(660/60) = 11 min
    return { ok: true, json: async () => ({ status: "OK", rows: [{ elements: [{ status: "OK", duration_in_traffic: { value: 660 } }] }] }) };
  }
  // qualsiasi altra chiamata (geocode/nominatim/photon) non deve avvenire in questi test
  return { ok: false, json: async () => ({}) };
};

const { risolviIndirizzo } = require("../src/utils/geoResolver");

let passed = 0, failed = 0;
const assert = (name, cond, detail = "") => {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else      { console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); failed++; }
};
const section = (s) => console.log(`\n── ${s} ──`);

(async () => {
  section("T1 — cache durata null + Google OK → durata 11, NON haversine 26");
  {
    cacheDurata = null; DM_OK = true; upserted = null; fetchCalls = 0;
    const r = await risolviIndirizzo({ direccion: "Anade", tipoConsegna: "DOMICILIO" });
    assert("zona Q5 preservata", r.zona === "Q5", `zona=${r.zona}`);
    assert("durataAndataMin = 11 (Google)", r.durataAndataMin === 11, `durata=${r.durataAndataMin}`);
    assert("googleMin = 11", r.googleMin === 11, `googleMin=${r.googleMin}`);
    assert("NON usa haversine 26 come durata finale", r.durataAndataMin !== r.haversineMin, `durata=${r.durataAndataMin} hav=${r.haversineMin}`);
    assert("source = google-from-nominatim", r.source === "google-from-nominatim", `source=${r.source}`);
    assert("Distance Matrix chiamata", fetchCalls === 1, `fetchCalls=${fetchCalls}`);
    assert("cache backfill con durata 11", upserted?.durata_andata_min === 11 && upserted?.source === "google-from-nominatim",
           `upserted=${JSON.stringify(upserted)}`);
  }

  section("T2 — Google fallisce → durata resta null (consumer haversine), niente backfill");
  {
    cacheDurata = null; DM_OK = false; upserted = null; fetchCalls = 0;
    const r = await risolviIndirizzo({ direccion: "Anade", tipoConsegna: "DOMICILIO" });
    assert("zona Q5 preservata", r.zona === "Q5", `zona=${r.zona}`);
    assert("durataAndataMin = null (fallback haversine al consumo)", r.durataAndataMin === null, `durata=${r.durataAndataMin}`);
    assert("haversineMin presente come stima", r.haversineMin != null, `hav=${r.haversineMin}`);
    assert("googleMin = null", r.googleMin === null, `googleMin=${r.googleMin}`);
    assert("source resta nominatim (non google)", r.source === "nominatim", `source=${r.source}`);
    assert("nessun backfill su fallimento", upserted === null, `upserted=${JSON.stringify(upserted)}`);
  }

  section("T3 — cache GIÀ con durata → nessuna chiamata Google (no-op)");
  {
    cacheDurata = 9; DM_OK = true; upserted = null; fetchCalls = 0;
    const r = await risolviIndirizzo({ direccion: "Anade", tipoConsegna: "DOMICILIO" });
    assert("durataAndataMin = 9 (dalla cache)", r.durataAndataMin === 9, `durata=${r.durataAndataMin}`);
    assert("nessuna chiamata Distance Matrix", fetchCalls === 0, `fetchCalls=${fetchCalls}`);
    assert("source invariato (nominatim)", r.source === "nominatim", `source=${r.source}`);
  }

  console.log(`\n═══ RESULT: ${passed} passed, ${failed} failed ═══\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
