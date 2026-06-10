// Test per previewOrderTiming (Step 1 anti-cerotto, 2026-06-01).
// Eseguire: node tests/previewOrderTiming.test.js
//
// Boundary: questi test verificano la LOGICA di previewOrderTiming (mapping
// resolver→output, regola hora manuale preservata, forno_out server-side,
// conflitto driver advisory, giro compatibile). La risoluzione indirizzo reale
// (Google/cache/haversine) è già coperta da geoResolverEnrich.test.js → qui
// risolviIndirizzo è stubbato per restituire shape note e deterministiche.
//
// Stub via require.cache PRIMA di caricare previewTiming (così i `require`
// destrutturati dentro il modulo raccolgono gli stub). Nessuna rete, nessun DB.

// Clock congelato a 20:38 Europe/Madrid (= 18:38 UTC CEST) per determinismo di
// nowMadridMinutes() usato dallo slot-search di proposeForNewOrder.
const FIXED = new Date("2026-05-31T18:38:00Z");
const RealDate = Date;
global.Date = class extends RealDate {
  constructor(...args) { return args.length === 0 ? new RealDate(FIXED.getTime()) : new RealDate(...args); }
  static now() { return FIXED.getTime(); }
};

// ── Stub supabase.sbSelect (ordini attivi) ──────────────────────
let STUB_ORDERS = [];
const supaPath = require.resolve("../src/utils/supabase");
require(supaPath);
require.cache[supaPath].exports.sbSelect = async (table) =>
  table === "ordenes" ? STUB_ORDERS : [];

// ── Stub geoResolver.risolviIndirizzo ───────────────────────────
let STUB_RESOLVED = null;
const geoPath = require.resolve("../src/utils/geoResolver");
require(geoPath);
require.cache[geoPath].exports.risolviIndirizzo = async () => STUB_RESOLVED;

// ── Stub manualGiros.getManualGiros ─────────────────────────────
let STUB_GIROS = [];
const mgPath = require.resolve("../src/agents/manualGiros");
require(mgPath);
require.cache[mgPath].exports.getManualGiros = async () => STUB_GIROS;

const { previewOrderTiming } = require("../src/agents/previewTiming");

let passed = 0, failed = 0;
const assert = (name, cond, detail = "") => {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else      { console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); failed++; }
};
const section = (s) => console.log(`\n── ${s} ──`);
const toMin = (t) => { const [h, m] = String(t).split(":").map(Number); return h * 60 + (m || 0); };
const hasWarn = (r, code) => r.warnings.some((w) => w.code === code);

(async () => {
  // ═══════════════════════════════════════════════════════════════
  section("T1 — Q1 vicino (Reino de España 46), hora 21:00");
  {
    STUB_ORDERS = [];
    STUB_GIROS = [];
    STUB_RESOLVED = {
      zona: "Q1", lat: 36.7718052, lon: -2.6090218,
      durataAndataMin: 8, googleMin: 8, haversineMin: 9,
      source: "google", cached: true, fuoriZona: false, error: null,
    };
    const r = await previewOrderTiming({
      tipo_consegna: "DOMICILIO", direccion: "Reino de España 46", hora: "21:00",
    });
    assert("zona Q1", r.zona === "Q1", `zona=${r.zona}`);
    assert("durata_andata_min = 8 (server)", r.durata_andata_min === 8, `durata=${r.durata_andata_min}`);
    assert("durata_google_min = 8", r.durata_google_min === 8);
    assert("hora_proposta = hora_richiesta = 21:00", r.hora_proposta === "21:00" && r.hora_richiesta === "21:00");
    assert("forno_out = 20:52 (hora − durata)", r.forno_out === "20:52", `forno=${r.forno_out}`);
    assert("invariante forno_out + durata = hora", toMin(r.forno_out) + r.durata_andata_min === toMin("21:00"));
    assert("no conflicto driver", r.driver.has_conflict === false);
    assert("no giro sugerido", r.giro.suggested === false);
  }

  // ═══════════════════════════════════════════════════════════════
  section("T2 — Anade 35: cache-street arricchita da Google");
  {
    STUB_ORDERS = []; STUB_GIROS = [];
    STUB_RESOLVED = {
      zona: "Q5", lat: 36.7238183, lon: -2.6395996,
      durataAndataMin: 12, googleMin: 12, haversineMin: 26,
      source: "google-from-cache-street", cached: true, fuoriZona: false, error: null,
    };
    const r = await previewOrderTiming({
      tipo_consegna: "DOMICILIO", direccion: "Anade 35", hora: "21:00",
    });
    assert("zona Q5", r.zona === "Q5");
    assert("durata_andata_min = 12 (Google, NON haversine 26)", r.durata_andata_min === 12, `durata=${r.durata_andata_min}`);
    assert("durata_google_min = 12", r.durata_google_min === 12);
    assert("durata_haversine_min = 26 (registrada para A/B)", r.durata_haversine_min === 26);
    assert("geo_source = google-from-cache-street", r.geo_source === "google-from-cache-street", `src=${r.geo_source}`);
    assert("forno_out = 20:48", r.forno_out === "20:48", `forno=${r.forno_out}`);
    assert("sin warning de estimación", !hasWarn(r, "durata_estimada"));
  }

  // ═══════════════════════════════════════════════════════════════
  section("T3 — Google fail → fallback haversine + warning estimado");
  {
    STUB_ORDERS = []; STUB_GIROS = [];
    STUB_RESOLVED = {
      zona: "Q5", lat: 36.7238183, lon: -2.6395996,
      durataAndataMin: null, googleMin: null, haversineMin: 26,
      source: "nominatim", cached: true, fuoriZona: false, error: null,
    };
    const r = await previewOrderTiming({
      tipo_consegna: "DOMICILIO", direccion: "Anade 35", hora: "21:00",
    });
    assert("durata_andata_min = 26 (haversine fallback)", r.durata_andata_min === 26, `durata=${r.durata_andata_min}`);
    assert("durata_google_min = null", r.durata_google_min === null);
    assert("warning durata_estimada presente", hasWarn(r, "durata_estimada"));
    assert("geo_source preserva nominatim", r.geo_source === "nominatim", `src=${r.geo_source}`);
    assert("forno_out = 20:34", r.forno_out === "20:34", `forno=${r.forno_out}`);
  }

  // ═══════════════════════════════════════════════════════════════
  section("T4 — Driver ocupado: ordine manuale conserva hora, conflict advisory");
  {
    // Stato live: giro Q5 saturo (#006 21:52 andata 23, #007 22:44 andata 26).
    STUB_ORDERS = [
      { id: "#006", tipo_consegna: "DOMICILIO", hora: "21:52", zona: "Q5", estado: "EN_COCINA",
        durata_andata_min: 23, zona_lat: 36.7250966, zona_lon: -2.6289733 },
      { id: "#007", tipo_consegna: "DOMICILIO", hora: "22:44", zona: "Q5", estado: "EN_COCINA",
        durata_andata_min: 26, zona_lat: 36.7238183, zona_lon: -2.6395996 },
    ];
    STUB_GIROS = [];
    STUB_RESOLVED = {
      zona: "Q5", lat: 36.7238183, lon: -2.6395996,
      durataAndataMin: 26, googleMin: 26, haversineMin: 26,
      source: "google", cached: true, fuoriZona: false, error: null,
    };
    const r = await previewOrderTiming({
      tipo_consegna: "DOMICILIO", direccion: "Playa Serena", hora: "22:10",
    });
    assert("hora_proposta NO se reescribe (22:10)", r.hora_proposta === "22:10", `hora_proposta=${r.hora_proposta}`);
    assert("driver.has_conflict = true", r.driver.has_conflict === true, `conflict=${r.driver.has_conflict}`);
    assert("driver.message presente", typeof r.driver.message === "string" && r.driver.message.length > 0);
    assert("suggested_hora presente (alternativa, no sustituye)", /^\d\d:\d\d$/.test(r.suggested_hora || ""), `suggested=${r.suggested_hora}`);
    assert("warning driver_conflict", hasWarn(r, "driver_conflict"));
    assert("forno_out = hora − 26 = 21:44", r.forno_out === "21:44", `forno=${r.forno_out}`);
  }

  // ═══════════════════════════════════════════════════════════════
  section("T5 — Same-zone manual giro activo → giro compatible sugerido");
  {
    STUB_ORDERS = [
      { id: "#A", tipo_consegna: "DOMICILIO", hora: "21:00", zona: "Q1", estado: "EN_COCINA",
        durata_andata_min: 8, zona_lat: 36.7718052, zona_lon: -2.6090218, manual_giro_id: "mg_260601_1" },
    ];
    STUB_GIROS = [
      { id: "mg_260601_1", seq: 1, hora_ref: "21:00", order_ids: ["#A"], dissolved_at: null },
    ];
    STUB_RESOLVED = {
      zona: "Q1", lat: 36.7718052, lon: -2.6090218,
      durataAndataMin: 8, googleMin: 8, haversineMin: 9,
      source: "google", cached: true, fuoriZona: false, error: null,
    };
    const r = await previewOrderTiming({
      tipo_consegna: "DOMICILIO", direccion: "Reino de España 50", hora: "21:00",
    });
    assert("giro.suggested = true", r.giro.suggested === true);
    assert("giro.manual_giro_id = mg_260601_1", r.giro.manual_giro_id === "mg_260601_1", `id=${r.giro.manual_giro_id}`);
    assert("giro.orders incluye #A", r.giro.orders.includes("#A"));
  }

  // ═══════════════════════════════════════════════════════════════
  section("T6 — RITIRO: sin durata delivery, forno_out = hora");
  {
    STUB_ORDERS = []; STUB_GIROS = []; STUB_RESOLVED = null;
    const r = await previewOrderTiming({ tipo_consegna: "RITIRO", hora: "21:00" });
    assert("zona null", r.zona === null);
    assert("durata_andata_min null", r.durata_andata_min === null);
    assert("forno_out = hora = 21:00", r.forno_out === "21:00", `forno=${r.forno_out}`);
    assert("hora_proposta = 21:00", r.hora_proposta === "21:00");
    assert("no conflicto driver", r.driver.has_conflict === false);
    // "Para ahora": earliest = ahora (20:38 Madrid) + cottura 5 = 20:43.
    assert("earliest_hora = 20:43 (ahora + cottura)", r.earliest_hora === "20:43", `earliest=${r.earliest_hora}`);
    assert("hora_proposta NO se reescribe con earliest", r.hora_proposta === "21:00");

    // Sin hora: el endpoint igual propone el primer retiro fattibile.
    const r2 = await previewOrderTiming({ tipo_consegna: "RITIRO" });
    assert("earliest_hora = 20:43 también sin hora", r2.earliest_hora === "20:43", `earliest=${r2.earliest_hora}`);
    assert("forno_out null sin hora", r2.forno_out === null, `forno=${r2.forno_out}`);
  }

  // ═══════════════════════════════════════════════════════════════
  section("T7 — Después de medianoche: hora - durata wrappa, no clamp 00:00");
  {
    STUB_ORDERS = []; STUB_GIROS = [];
    STUB_RESOLVED = {
      zona: "Q1", lat: 36.7718052, lon: -2.6090218,
      durataAndataMin: 12, googleMin: 12, haversineMin: 13,
      source: "google", cached: true, fuoriZona: false, error: null,
    };
    const a = await previewOrderTiming({
      tipo_consegna: "DOMICILIO", direccion: "Reino de España 46", hora: "00:10",
    });
    assert("00:10 − 12 = 23:58", a.forno_out === "23:58", `forno=${a.forno_out}`);
    assert("hora_proposta = 00:10 (preservada)", a.hora_proposta === "00:10");

    STUB_RESOLVED = {
      zona: "Q5", lat: 36.7250966, lon: -2.6289733,
      durataAndataMin: 13, googleMin: 13, haversineMin: 13,
      source: "google", cached: true, fuoriZona: false, error: null,
    };
    const b = await previewOrderTiming({
      tipo_consegna: "DOMICILIO", direccion: "Playa Serena", hora: "00:05",
    });
    assert("00:05 − 13 = 23:52", b.forno_out === "23:52", `forno=${b.forno_out}`);
    assert("hora_proposta = 00:05 (preservada)", b.hora_proposta === "00:05");

    const allStr = JSON.stringify([a, b]);
    assert("ningún campo contiene 24:/25:", !/\b2[4-9]:\d\d/.test(allStr), allStr);
  }

  console.log(`\n═══ RESULT: ${passed} passed, ${failed} failed ═══\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
