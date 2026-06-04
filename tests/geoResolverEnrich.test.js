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

const { risolviIndirizzo, enrichDurataFromGoogle, isFarDeliveryZone } = require("../src/utils/geoResolver");

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

  // ── GEO-CACHE-GOOGLE-REFRESH-FIX-37 — far-zone cache-street refresh ──
  // Audit -36: ordine live #003 (Q5, cache-street, durata 10, google null) non
  // chiamava Google perché la durata street-fallback era già non-null. Ora le zone
  // lontane (Q5/Marina/Evershine) rinfrescano comunque; Q1/Q2/Q3 restano invariate.
  const farHit = (over = {}) => ({
    zona: "Q5", lat: 36.7238183, lon: -2.6395996,
    durataAndataMin: 10, source: "cache-street", cached: true, blindata: false, ...over,
  });

  section("T4 (A) — Q5 cache-street durata NON null + Google OK → refresh google-from-cache-street");
  {
    DM_OK = true; upserted = null; fetchCalls = 0;
    const r = await enrichDurataFromGoogle("Calle X 10", farHit(), true);
    assert("Distance Matrix chiamata", fetchCalls === 1, `fetchCalls=${fetchCalls}`);
    assert("durataAndataMin aggiornata a Google 11 (non più 10)", r.durataAndataMin === 11, `durata=${r.durataAndataMin}`);
    assert("source = google-from-cache-street", r.source === "google-from-cache-street", `source=${r.source}`);
    assert("source include 'google' → buildResult valorizza durata_google_min", r.source.includes("google"));
    assert("backfill cache con durata 11", upserted?.durata_andata_min === 11 && upserted?.source === "google-from-cache-street",
           `upserted=${JSON.stringify(upserted)}`);
  }

  section("T5 (B) — Q1 cache-street durata NON null → NESSUNA chiamata Google (invariato)");
  {
    DM_OK = true; upserted = null; fetchCalls = 0;
    const r = await enrichDurataFromGoogle("Calle Y 2", farHit({ zona: "Q1", durataAndataMin: 2 }), true);
    assert("Google NON chiamato", fetchCalls === 0, `fetchCalls=${fetchCalls}`);
    assert("source resta cache-street", r.source === "cache-street", `source=${r.source}`);
    assert("durata resta 2", r.durataAndataMin === 2, `durata=${r.durataAndataMin}`);
    assert("nessun backfill", upserted === null, `upserted=${JSON.stringify(upserted)}`);
  }

  section("T6 (C) — Q5 cache-street durata NON null ma Google FALLISCE → resta cache-street, durata invariata");
  {
    DM_OK = false; upserted = null; fetchCalls = 0;
    const r = await enrichDurataFromGoogle("Calle X 10", farHit(), true);
    assert("Distance Matrix tentata", fetchCalls === 1, `fetchCalls=${fetchCalls}`);
    assert("source resta cache-street", r.source === "cache-street", `source=${r.source}`);
    assert("durata invariata = 10 (nessun crash)", r.durataAndataMin === 10, `durata=${r.durataAndataMin}`);
    assert("nessun backfill su fallimento", upserted === null, `upserted=${JSON.stringify(upserted)}`);
  }

  section("T7 (D) — cache-street/null durata resta coperto (Q5, durata null, Google OK)");
  {
    DM_OK = true; upserted = null; fetchCalls = 0;
    const r = await enrichDurataFromGoogle("Calle X", farHit({ durataAndataMin: null }), true);
    assert("Google chiamato come prima", fetchCalls === 1, `fetchCalls=${fetchCalls}`);
    assert("durata = 11 (Google)", r.durataAndataMin === 11, `durata=${r.durataAndataMin}`);
    assert("source = google-from-cache-street", r.source === "google-from-cache-street", `source=${r.source}`);
  }

  section("T8 (E) — exact google hit durata non null in Q5 → NON refreshato");
  {
    DM_OK = true; upserted = null; fetchCalls = 0;
    const r = await enrichDurataFromGoogle("Calle Z 5", farHit({ source: "google", durataAndataMin: 12 }), true);
    assert("Google NON ri-chiamato", fetchCalls === 0, `fetchCalls=${fetchCalls}`);
    assert("source resta google", r.source === "google", `source=${r.source}`);
    assert("durata resta 12", r.durataAndataMin === 12, `durata=${r.durataAndataMin}`);
  }

  section("T9 — isFarDeliveryZone semantics");
  {
    assert("Q5 è far zone", isFarDeliveryZone("Q5") === true);
    assert("Marina è far zone", isFarDeliveryZone("Marina") === true);
    assert("Evershine è far zone", isFarDeliveryZone("evershine") === true);
    assert("Q1 NON è far zone", isFarDeliveryZone("Q1") === false);
    assert("Q2 NON è far zone", isFarDeliveryZone("Q2") === false);
  }

  console.log(`\n═══ RESULT: ${passed} passed, ${failed} failed ═══\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
