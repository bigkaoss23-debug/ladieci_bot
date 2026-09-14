// Test per previewOrderTiming (Step 1 anti-cerotto, 2026-06-01; W4 Packet 01 canonical
// giro cutover, 2026-09-14).
// Eseguire: node tests/previewOrderTiming.test.js
//
// Boundary: questi test verificano la LOGICA di previewOrderTiming (mapping
// resolver→output, regola hora manuale preservata, forno_out server-side,
// conflitto driver advisory, giro compatibile). La risoluzione indirizzo reale
// (Google/cache/haversine) è già coperta da geoResolverEnrich.test.js → qui
// risolviIndirizzo è stubbato per restituire shape note e deterministiche.
//
// W4: il giro compatibile ora viene SOLO dalla Projection canonica
// (giroProjectionReader → giroProjectionPort), mai da ordenes.manual_giro_id /
// manual_giros raw. T5 prova la parity di shape esterna sul path canonico; T8-T11
// (sotto) provano il disaccordo raw-vs-projection, DISSOLVED, e degraded/unavailable.
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

// ── Stub giroProjectionReader.readGiroProjection (W4 canonical source) ──────
// null = unavailable/degraded (fail-closed); an object = a real giro_projection_v1 body.
let STUB_PROJECTION = null;
const readerPath = require.resolve("../src/core/delivery/giroProjectionReader");
require(readerPath);
require.cache[readerPath].exports.readGiroProjection = async () => STUB_PROJECTION;

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
    STUB_PROJECTION = null;
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
    STUB_ORDERS = []; STUB_PROJECTION = null;
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
    STUB_ORDERS = []; STUB_PROJECTION = null;
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
    STUB_PROJECTION = null;
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
  section("T5 — Giro compatible desde la Projection canonica (W4-N01/N08); raw manual_giro_id en desacuerdo se IGNORA (W4-N02)");
  {
    // #A carries a deliberately WRONG/STALE raw manual_giro_id (as a real ordenes row
    // could, if the legacy writer left it dangling). The canonical Projection says the
    // real effective giro is mg_260601_1. previewOrderTiming must answer mg_260601_1 —
    // never the raw column — proving W4's core principle: canonical wins.
    // Zona Q2 (canal sur), NOT the Q1 hub: isRouteChannelCompatible treats a hub-only
    // route as undecidable (routeChannel([Q1]) has zero non-hub channels -> null ->
    // NOT compatible, by design — same rule giroFactsPort.findCompatibleGiro already
    // used). Q2+Q2 is unambiguously same-channel ("sur"), matching this fixture's intent.
    STUB_ORDERS = [
      // language-guard: allow-legacy tipo_consegna is the existing ordenes column name, reproduced verbatim in this fixture
      { id: "#A", tipo_consegna: "DOMICILIO", hora: "21:00", zona: "Q2", estado: "EN_COCINA",
        durata_andata_min: 8, zona_lat: 36.7718052, zona_lon: -2.6090218, manual_giro_id: "WRONG_STALE_RAW_ID" },
    ];
    STUB_PROJECTION = {
      contract: "giro_projection_v1", scope_valid: true, degraded: false,
      giros: [
        { giro_id: "mg_260601_1", giro_state: "PLANNED", salida: "21:00", effective_members: [{ order_uid: "u-a", order_id: "#A" }] },
      ],
      orders: [{ order_uid: "u-a", order_id: "#A", effective_giro_id: "mg_260601_1" }],
      intents: [],
    };
    STUB_RESOLVED = {
      zona: "Q2", lat: 36.7718052, lon: -2.6090218,
      durataAndataMin: 8, googleMin: 8, haversineMin: 9,
      source: "google", cached: true, fuoriZona: false, error: null,
    };
    const r = await previewOrderTiming({
      // language-guard: allow-legacy tipo_consegna is the existing previewOrderTiming param name, reproduced verbatim in this fixture
      tipo_consegna: "DOMICILIO", direccion: "Reino de España 50", hora: "21:00",
    });
    assert("giro.suggested = true", r.giro.suggested === true);
    assert("giro.manual_giro_id = mg_260601_1 (from the Projection's effective_giro_id)", r.giro.manual_giro_id === "mg_260601_1", `id=${r.giro.manual_giro_id}`);
    assert("giro.manual_giro_id NEVER the raw stale column value (W4-N02: canonical wins)", r.giro.manual_giro_id !== "WRONG_STALE_RAW_ID");
    assert("giro.orders incluye #A", r.giro.orders.includes("#A"));
  }

  // ═══════════════════════════════════════════════════════════════
  section("T8 — DISSOLVED giro en la Projection → ningún giro sugerido (W4-N03)");
  {
    STUB_ORDERS = [
      // language-guard: allow-legacy tipo_consegna is the existing ordenes column name, reproduced verbatim in this fixture
      { id: "#A", tipo_consegna: "DOMICILIO", hora: "21:00", zona: "Q1", estado: "EN_COCINA",
        durata_andata_min: 8, zona_lat: 36.7718052, zona_lon: -2.6090218 },
    ];
    STUB_PROJECTION = {
      contract: "giro_projection_v1", scope_valid: true, degraded: false,
      giros: [{ giro_id: "mg_dissolved_1", giro_state: "DISSOLVED", salida: null, effective_members: [] }],
      orders: [], intents: [],
    };
    STUB_RESOLVED = {
      zona: "Q1", lat: 36.7718052, lon: -2.6090218,
      durataAndataMin: 8, googleMin: 8, haversineMin: 9,
      source: "google", cached: true, fuoriZona: false, error: null,
    };
    const r = await previewOrderTiming({
      // language-guard: allow-legacy tipo_consegna is the existing previewOrderTiming param name, reproduced verbatim in this fixture
      tipo_consegna: "DOMICILIO", direccion: "Reino de España 50", hora: "21:00",
    });
    assert("giro.suggested = false (DISSOLVED is never offered)", r.giro.suggested === false);
    assert("giro.manual_giro_id = null", r.giro.manual_giro_id === null);
    assert("giro.orders = []", Array.isArray(r.giro.orders) && r.giro.orders.length === 0);
    assert("no crash / ok:true still returned", r.ok === true);
  }

  // ═══════════════════════════════════════════════════════════════
  section("T9 — Projection no disponible (null) → sin giro, sin raw fallback, sin crash (W4-N07/N13)");
  {
    // #A still carries a raw manual_giro_id here too — proves that even when the
    // canonical source is entirely unavailable, the reader NEVER falls back to it.
    STUB_ORDERS = [
      // language-guard: allow-legacy tipo_consegna is the existing ordenes column name, reproduced verbatim in this fixture
      { id: "#A", tipo_consegna: "DOMICILIO", hora: "21:00", zona: "Q1", estado: "EN_COCINA",
        durata_andata_min: 8, zona_lat: 36.7718052, zona_lon: -2.6090218, manual_giro_id: "SOME_RAW_ID" },
    ];
    STUB_PROJECTION = null;
    STUB_RESOLVED = {
      zona: "Q1", lat: 36.7718052, lon: -2.6090218,
      durataAndataMin: 8, googleMin: 8, haversineMin: 9,
      source: "google", cached: true, fuoriZona: false, error: null,
    };
    const r = await previewOrderTiming({
      // language-guard: allow-legacy tipo_consegna is the existing previewOrderTiming param name, reproduced verbatim in this fixture
      tipo_consegna: "DOMICILIO", direccion: "Reino de España 50", hora: "21:00",
    });
    assert("giro.suggested = false (never a guess)", r.giro.suggested === false);
    assert("giro.manual_giro_id = null (never the raw column)", r.giro.manual_giro_id === null);
    assert("no crash / ok:true still returned", r.ok === true);
  }

  // ═══════════════════════════════════════════════════════════════
  section("T10 — Projection degraded:true (trip facts unavailable) → sin giro, sin crash (W4-N07/N13)");
  {
    STUB_ORDERS = [
      // language-guard: allow-legacy tipo_consegna is the existing ordenes column name, reproduced verbatim in this fixture
      { id: "#A", tipo_consegna: "DOMICILIO", hora: "21:00", zona: "Q1", estado: "EN_COCINA",
        durata_andata_min: 8, zona_lat: 36.7718052, zona_lon: -2.6090218 },
    ];
    STUB_PROJECTION = {
      contract: "giro_projection_v1", scope_valid: true, degraded: true, reasons: ["TRIP_FACTS_UNAVAILABLE"],
      giros: [{ giro_id: "mg_x", giro_state: "PLANNED", salida: "21:00", effective_members: [{ order_uid: "u-a", order_id: "#A" }] }],
      orders: [{ order_uid: "u-a", order_id: "#A", effective_giro_id: "mg_x" }],
      intents: [],
    };
    STUB_RESOLVED = {
      zona: "Q1", lat: 36.7718052, lon: -2.6090218,
      durataAndataMin: 8, googleMin: 8, haversineMin: 9,
      source: "google", cached: true, fuoriZona: false, error: null,
    };
    const r = await previewOrderTiming({
      // language-guard: allow-legacy tipo_consegna is the existing previewOrderTiming param name, reproduced verbatim in this fixture
      tipo_consegna: "DOMICILIO", direccion: "Reino de España 50", hora: "21:00",
    });
    assert("degraded projection -> giro.suggested = false (never trusts a giro it can't verify)", r.giro.suggested === false);
    assert("giro.manual_giro_id = null", r.giro.manual_giro_id === null);
    assert("no crash / ok:true still returned", r.ok === true);
  }

  // ═══════════════════════════════════════════════════════════════
  section("T6 — RITIRO: sin durata delivery, forno_out = hora");
  {
    STUB_ORDERS = []; STUB_PROJECTION = null; STUB_RESOLVED = null;
    const r = await previewOrderTiming({ tipo_consegna: "RITIRO", hora: "21:00" });
    assert("zona null", r.zona === null);
    assert("durata_andata_min null", r.durata_andata_min === null);
    assert("forno_out = hora = 21:00", r.forno_out === "21:00", `forno=${r.forno_out}`);
    assert("hora_proposta = 21:00", r.hora_proposta === "21:00");
    assert("no conflicto driver", r.driver.has_conflict === false);
  }

  // ═══════════════════════════════════════════════════════════════
  section("T7 — Después de medianoche: hora - durata wrappa, no clamp 00:00");
  {
    STUB_ORDERS = []; STUB_PROJECTION = null;
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
