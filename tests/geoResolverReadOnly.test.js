// tests/geoResolverReadOnly.test.js
// ===============================================================
// READ-ONLY GEO RESOLVER — test-first skeleton (zero-write contract)
// Run: node tests/geoResolverReadOnly.test.js
//
// Why this file exists:
//   previewOrderPlanner must resolve zona/durata WITHOUT ever writing
//   geo_cache. The live resolver chain does write:
//     - resolveDeliveryFields -> risolviIndirizzo
//     - cache hit  -> sbUpdate("geo_cache", {hit_count++})   (geoResolver.js:83)
//     - geocode    -> saveToCache -> sbUpsert("geo_cache")    (geoResolver.js:392)
//   This skeleton pins the contract for a future read-only wrapper that
//   reuses the READ cascade but never persists.
//
// Boundary:
//   - This test intentionally imports the expected (not-yet-existing) module:
//       ../src/agents/resolveDeliveryFieldsReadOnly
//     Until that module exists, this test must fail with a clear EXPECTED FAIL.
//   - It does NOT implement the wrapper. It only fixes the contract.
//
// Path rationale (see report): the wrapper returns the SAME shape as
//   previewTiming.resolveDeliveryFields (zona / zona_lat / zona_lon /
//   durata_andata_min / geo_source / warnings) and is meant to be injected
//   as deps.resolveDeliveryFields into previewOrderPlanner. It is an
//   agent-layer composer (cascade primitives + warning shaping), a sibling of
//   resolveDeliveryFields, NOT a low-level geo primitive. Hence src/agents/.
// ===============================================================
"use strict";

const fs = require("fs");
const path = require("path");

// ── No-write supabase stub, installed BEFORE requiring the wrapper. ──────
// READ (sbSelect) is allowed and serves a cache row. Any WRITE throws, so a
// wrapper that touches geo_cache fails loudly instead of silently passing.
let writeAttempts = [];
const supaPath = require.resolve("../src/utils/supabase");
require(supaPath);
const supa = require.cache[supaPath].exports;

const CACHE_ROW = {
  direccion_key: "calle lucena 5",
  direccion_orig: "Calle Lucena 5",
  zona: "Q2",
  lat: 36.764,
  lon: -2.614,
  durata_andata_min: 9,
  source: "google",
  hit_count: 3,
  n_ordini_consegnati: 2,
};

supa.sbSelect = async (table, query = "") => {
  if (table === "config" && /GEO_PROVIDER/.test(query)) return [{ valore: "shadow" }];
  if (table === "geo_cache" && /direccion_key=eq\.calle%20lucena%205/i.test(query)) return [CACHE_ROW];
  if (table === "geo_cache") return [];
  if (table === "clientes") return [];
  return [];
};
const blockWrite = (op) => async (table, ...rest) => {
  writeAttempts.push({ op, table });
  throw new Error(`unexpected_geo_cache_write_${op}_on_${table}`);
};
supa.sbUpsert = blockWrite("sbUpsert");
supa.sbUpdate = blockWrite("sbUpdate");
supa.sbInsert = blockWrite("sbInsert");
supa.sbDelete = blockWrite("sbDelete");

// Track external geocoder calls (fresh-geocode case must still not persist).
let fetchCalls = 0;
global.fetch = async (url) => {
  fetchCalls++;
  const u = String(url);
  if (u.includes("/geocode/")) {
    return { ok: true, json: async () => ({
      status: "OK",
      results: [{
        geometry: { location: { lat: 36.77, lng: -2.62 }, location_type: "ROOFTOP" },
        formatted_address: "Calle Nueva 1, Roquetas de Mar",
        partial_match: false,
      }],
    }) };
  }
  if (u.includes("distancematrix")) {
    return { ok: true, json: async () => ({
      status: "OK",
      rows: [{ elements: [{ status: "OK", duration_in_traffic: { value: 600 } }] }],
    }) };
  }
  return { ok: false, json: async () => ({}) };
};

// ── Import the (future) wrapper. Expected to fail until implemented. ──────
const WRAPPER_PATH = "../src/agents/resolveDeliveryFieldsReadOnly";
let resolveDeliveryFieldsReadOnly;
try {
  ({ resolveDeliveryFieldsReadOnly } = require(WRAPPER_PATH));
} catch (e) {
  if (e && e.code === "MODULE_NOT_FOUND" && /resolveDeliveryFieldsReadOnly/.test(String(e.message))) {
    console.log("EXPECTED FAIL: read-only geo resolver wrapper is not implemented yet.");
    console.log(`Next step: implement ${WRAPPER_PATH}.js exporting`);
    console.log("  resolveDeliveryFieldsReadOnly(params, deps) — reuse the READ cascade,");
    console.log("  never call saveToCache / sbUpsert / sbUpdate(hit_count).");
    process.exit(1);
  }
  throw e;
}

// ── Minimal hand-rolled harness (matches repo style). ────────────────────
let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? " — " + extra : ""}`); }
}
const section = (s) => console.log(`\n── ${s} ──`);

// PII / address leakage guard: a string that must never appear in any output.
const SECRET_TEL = "+34600111222";
const SECRET_NAME = "Persona Inventada";
function leaksPii(out, rawDireccion) {
  const s = JSON.stringify(out || {});
  if (s.includes(SECRET_TEL)) return true;
  if (s.includes(SECRET_NAME)) return true;
  if (rawDireccion && s.includes(rawDireccion)) return true; // full address must not echo
  return false;
}
function hasResolverShape(r) {
  return r && typeof r === "object"
    && "zona" in r
    && "zona_lat" in r
    && "zona_lon" in r
    && "durata_andata_min" in r
    && "geo_source" in r
    && (Array.isArray(r.warnings) || "confidence" in r);
}

async function main() {
  // ── 1. Export ──────────────────────────────────────────────────────────
  section("1 — wrapper export");
  check("resolveDeliveryFieldsReadOnly is a function", typeof resolveDeliveryFieldsReadOnly === "function");
  // Static guard: source must not call the cache writers.
  const srcPath = path.join(__dirname, WRAPPER_PATH + ".js");
  const src = fs.existsSync(srcPath) ? fs.readFileSync(srcPath, "utf8") : "";
  check("source does not call saveToCache", !/saveToCache\s*\(/.test(src));
  check("source does not call sbUpsert/sbUpdate/sbInsert/sbDelete",
    !/sb(Upsert|Update|Insert|Delete)\s*\(/.test(src));

  // ── 2. Cache hit read-only ─────────────────────────────────────────────
  section("2 — cache hit returns geo, no write");
  writeAttempts = [];
  {
    const r = await resolveDeliveryFieldsReadOnly(
      { direccion: "Calle Lucena 5", tel: SECRET_TEL },
      {},
    );
    check("returns resolver shape", hasResolverShape(r));
    check("zona resolved (Q2)", r && r.zona === "Q2", r && `zona=${r.zona}`);
    check("durata_andata_min resolved (9)", r && r.durata_andata_min === 9, r && `durata=${r.durata_andata_min}`);
    check("geo_source present", !!(r && r.geo_source));
    check("NO hit_count bump (sbUpdate not called)", writeAttempts.length === 0,
      JSON.stringify(writeAttempts));
  }

  // ── 3. Fresh geocode read-only ─────────────────────────────────────────
  section("3 — fresh geocode does not persist");
  writeAttempts = [];
  {
    const r = await resolveDeliveryFieldsReadOnly(
      { direccion: "Calle Nueva 1", tel: SECRET_TEL },
      {},
    );
    check("returns a result for fresh address", !!r);
    check("NO saveToCache / sbUpsert on fresh geocode", writeAttempts.length === 0,
      JSON.stringify(writeAttempts));
  }

  // ── 4. Unresolved geo safe ─────────────────────────────────────────────
  section("4 — unresolved geo safe, no PII");
  writeAttempts = [];
  {
    const rawDir = "xx, El Ejido"; // out-of-zone locality → unresolved
    const r = await resolveDeliveryFieldsReadOnly(
      { direccion: rawDir, tel: SECRET_TEL, nombre: SECRET_NAME },
      {},
    );
    check("returns a safe object (no throw)", !!r && typeof r === "object");
    check("unresolved reported via warnings/zona=null",
      !!r && (r.zona == null || (Array.isArray(r.warnings) && r.warnings.length > 0)));
    check("no PII / full address in output", !leaksPii(r, rawDir));
    check("still no writes on unresolved path", writeAttempts.length === 0);
  }

  // ── 5. Global no-write guard ───────────────────────────────────────────
  section("5 — global no-write guard");
  writeAttempts = [];
  {
    // Force the geocode path (no cache) to exercise the would-be saveToCache.
    const r = await resolveDeliveryFieldsReadOnly(
      { direccion: "Calle Otra Nueva 7", tel: SECRET_TEL },
      {},
    );
    check("wrapper completed without triggering any write", writeAttempts.length === 0,
      `attempts=${JSON.stringify(writeAttempts)}`);
    check("result returned despite write-throwing supabase", !!r);
  }

  // ── 6. Compatible with previewOrderPlanner ─────────────────────────────
  section("6 — usable as deps.resolveDeliveryFields in previewOrderPlanner");
  writeAttempts = [];
  {
    let previewOrderPlanner;
    try {
      ({ previewOrderPlanner } = require("../src/agents/previewOrderPlanner"));
    } catch (_) { previewOrderPlanner = null; }
    check("previewOrderPlanner available", typeof previewOrderPlanner === "function");

    if (typeof previewOrderPlanner === "function") {
      const snapshot = {
        now: "20:00",
        orders: [],
        manual_giros: [],
        driver: null,
        driver_events: [],
        driver_status: null,
      };
      const r = await previewOrderPlanner(
        { tipo_consegna: "DOMICILIO", direccion: "Calle Lucena 5", tel: SECRET_TEL, hora: "20:30", pizzas_count: 1 },
        {
          now: () => "20:00",
          db: { select: async () => [], insert: blockWrite("insert"), update: blockWrite("update"), upsert: blockWrite("upsert"), delete: blockWrite("delete") },
          resolveDeliveryFields: resolveDeliveryFieldsReadOnly,
          loadPlannerSnapshot: async () => snapshot,
          evaluateNewOrder: () => ({ selected: null, recommended: null, options: [], proximo_slot: null, warnings: [], snapshot_now: "20:00" }),
        },
      );
      check("contract = nuevo-pedido-planner-preview-v1", r && r.contract === "nuevo-pedido-planner-preview-v1", r && `contract=${r.contract}`);
      check("source = planner", r && r.source === "planner", r && `source=${r.source}`);
      check("mode = read_only", r && r.mode === "read_only", r && `mode=${r.mode}`);
      check("no geo_cache write through full preview", writeAttempts.length === 0, JSON.stringify(writeAttempts));
      check("no PII leaked through preview", !leaksPii(r, "Calle Lucena 5"));
    }
  }

  // ── 7. Output minimum fields ───────────────────────────────────────────
  section("7 — minimum output fields");
  {
    const r = await resolveDeliveryFieldsReadOnly({ direccion: "Calle Lucena 5", tel: SECRET_TEL }, {});
    check("has zona", r && "zona" in r);
    check("has zona_lat", r && "zona_lat" in r);
    check("has zona_lon", r && "zona_lon" in r);
    check("has durata_andata_min", r && "durata_andata_min" in r);
    check("has geo_source", r && "geo_source" in r);
    check("has warnings[] or confidence", r && (Array.isArray(r.warnings) || "confidence" in r));
    check("no nombre/tel/wa_id in output", !leaksPii(r, null));
  }

  // ── 8. Q5 / Las Marinas — cache hit read-only ─────────────────────────
  // Far-delivery zone (tempoGiro 30). Blindata (n_ordini_consegnati>=1) →
  // alta confidence, durata dalla cache, zero write.
  section("8 — Q5/Marina cache hit read-only");
  writeAttempts = [];
  {
    const Q5_ROW = {
      direccion_key: "avenida playa serena 12", direccion_orig: "Avenida Playa Serena 12",
      zona: "Q5", lat: 36.7313, lon: -2.6352, durata_andata_min: 30,
      source: "google", hit_count: 5, n_ordini_consegnati: 3,
    };
    const calls = [];
    const r = await resolveDeliveryFieldsReadOnly(
      { direccion: "Avenida Playa Serena 12", tel: SECRET_TEL },
      { sbSelect: async (table, query = "") => { calls.push({ table, query }); return table === "geo_cache" ? [Q5_ROW] : []; } },
    );
    check("Q5 cache: resolver shape", hasResolverShape(r));
    check("Q5 cache: zona = Q5", r && r.zona === "Q5", r && `zona=${r.zona}`);
    check("Q5 cache: durata_andata_min = 30", r && r.durata_andata_min === 30, r && `durata=${r.durata_andata_min}`);
    check("Q5 cache: geo_source = google", r && r.geo_source === "google", r && `src=${r.geo_source}`);
    check("Q5 cache: confidence high (blindata)", r && r.confidence === "high", r && `conf=${r.confidence}`);
    check("Q5 cache: cache read issued (read-only)", calls.some((c) => c.table === "geo_cache"));
    check("Q5 cache: NO write attempted", writeAttempts.length === 0, JSON.stringify(writeAttempts));
    check("Q5 cache: no PII leaked", !leaksPii(r, "Avenida Playa Serena 12"));
  }

  // ── 9. Q5 / Marina — fresh geocode (no cache), no persist ─────────────
  // Geocoder mockato ritorna coordinate dentro il poligono Q5; durata da
  // haversine (range sensato, non minuto-esatto). Nessun saveToCache/upsert.
  section("9 — Q5/Marina fresh geocode does not persist");
  writeAttempts = [];
  {
    // Coord nel poligono Q5 (assegnaZonaDaCoord → Q5).
    const Q5_COORD = { lat: 36.7314, lon: -2.6352 };
    const r = await resolveDeliveryFieldsReadOnly(
      { direccion: "Calle del Golf 7, Las Marinas", tel: SECRET_TEL },
      {
        sbSelect: async () => [],                       // cache miss
        loadFromCliente: async () => null,              // no cliente hit
        nominatimGeocode: async () => ({ ...Q5_COORD }), // geocoder → Q5
      },
    );
    check("Q5 fresh: zona = Q5 (from coord)", r && r.zona === "Q5", r && `zona=${r.zona}`);
    check("Q5 fresh: geo_source = nominatim", r && r.geo_source === "nominatim", r && `src=${r.geo_source}`);
    check("Q5 fresh: durata in sensible range (8..45)",
      r && Number.isFinite(r.durata_andata_min) && r.durata_andata_min >= 8 && r.durata_andata_min <= 45,
      r && `durata=${r.durata_andata_min}`);
    check("Q5 fresh: haversine durata exposed", r && r.durata_haversine_min != null);
    check("Q5 fresh: NO saveToCache / write attempted", writeAttempts.length === 0, JSON.stringify(writeAttempts));
    check("Q5 fresh: no PII leaked", !leaksPii(r, "Calle del Golf 7, Las Marinas"));
  }

  // ── 10. previewOrderPlanner compat with Q5 address ────────────────────
  section("10 — previewOrderPlanner Q5 compatibility");
  writeAttempts = [];
  {
    let previewOrderPlanner;
    try { ({ previewOrderPlanner } = require("../src/agents/previewOrderPlanner")); }
    catch (_) { previewOrderPlanner = null; }
    check("previewOrderPlanner available", typeof previewOrderPlanner === "function");

    if (typeof previewOrderPlanner === "function") {
      const Q5_ROW = {
        direccion_key: "avenida playa serena 12", zona: "Q5", lat: 36.7313, lon: -2.6352,
        durata_andata_min: 30, source: "google", hit_count: 5, n_ordini_consegnati: 3,
      };
      const snapshot = { now: "20:00", orders: [], manual_giros: [], driver: null, driver_events: [], driver_status: null };
      const r = await previewOrderPlanner(
        { tipo_consegna: "DOMICILIO", direccion: "Avenida Playa Serena 12", tel: SECRET_TEL, hora: "21:00", pizzas_count: 2 },
        {
          now: () => "20:00",
          db: { select: async () => [], insert: blockWrite("insert"), update: blockWrite("update"), upsert: blockWrite("upsert"), delete: blockWrite("delete") },
          resolveDeliveryFields: resolveDeliveryFieldsReadOnly,
          sbSelect: async (table) => (table === "geo_cache" ? [Q5_ROW] : []),
          loadPlannerSnapshot: async () => snapshot,
          evaluateNewOrder: () => ({ selected: null, recommended: null, options: [], proximo_slot: null, warnings: [], snapshot_now: "20:00" }),
        },
      );
      check("Q5 preview: contract = nuevo-pedido-planner-preview-v1", r && r.contract === "nuevo-pedido-planner-preview-v1", r && `contract=${r.contract}`);
      check("Q5 preview: source = planner", r && r.source === "planner");
      check("Q5 preview: mode = read_only", r && r.mode === "read_only");
      check("Q5 preview: geo.zona = Q5", r && r.geo && r.geo.zona === "Q5", r && JSON.stringify(r.geo));
      check("Q5 preview: NO geo_cache write", writeAttempts.length === 0, JSON.stringify(writeAttempts));
      check("Q5 preview: no PII leaked", !leaksPii(r, "Avenida Playa Serena 12"));
    }
  }

  console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("UNEXPECTED ERROR:", e && e.stack ? e.stack : e);
  process.exit(1);
});
