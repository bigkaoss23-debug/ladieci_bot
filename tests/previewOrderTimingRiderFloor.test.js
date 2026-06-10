// tests/previewOrderTimingRiderFloor.test.js
// ===============================================================
// Integrazione: previewOrderTiming applica il FLOOR rider reale
// (resolveRiderAvailability) quando un ordine DOMICILIO è EN_ENTREGA
// con hora_salida reale. Dimostra il fix di RIDER EVENT FEEDBACK LOOP.
// Run: node tests/previewOrderTimingRiderFloor.test.js
// Nessun DB / rete: supabase + geoResolver + manualGiros stubbati.
// ===============================================================
"use strict";

// Clock congelato 2026-05-31T18:38:00Z = 20:38 Europe/Madrid (CEST).
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
const mgPath = require.resolve("../src/agents/manualGiros");
require(mgPath);
require.cache[mgPath].exports.getManualGiros = async () => [];

const { previewOrderTiming } = require("../src/agents/previewTiming");
const { proposeForNewOrder } = require("../src/utils/zones");

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
};
const section = (s) => console.log(`\n── ${s} ──`);
const toMin = (t) => { const [h, m] = String(t).split(":").map(Number); return h * 60 + (m || 0); };
const hasWarn = (r, code) => r.warnings.some((w) => w.code === code);
// ms epoch da orario Madrid (CEST = UTC+2), data del clock congelato.
const madridMs = (h, m) => RealDate.UTC(2026, 4, 31, h - 2, m, 0);

const Q1 = { zona: "Q1", lat: 36.7718052, lon: -2.6090218, durataAndataMin: 5, googleMin: 5, haversineMin: 8, source: "google", cached: true, fuoriZona: false, error: null };

(async () => {
  // ════════════════════════════════════════════════════════════════
  // Scenario A — rider partito REALMENTE tardi (20:36) rispetto al
  // pianificato (giro pianificato 20:20 → già "passato"). Un nuovo
  // ordine a 20:42 cade mentre il rider è ANCORA fuori (rientro reale
  // ~20:49). proposeForNewOrder (schedule pianificato) NON lo vede;
  // il floor rider reale SÌ.
  section("A — nuovo ordine col rider ancora in reparto (partenza reale tardiva)");
  {
    STUB_ORDERS = [{
      id: "#001", tipo_consegna: "DOMICILIO", estado: "EN_ENTREGA", zona: "Q1",
      hora: "20:20",                     // pianificato (già passato rispetto a now 20:38)
      durata_andata_min: 5,
      hora_salida: madridMs(20, 36),     // partenza REALE tardiva → rientro ~20:49
    }];
    STUB_RESOLVED = Q1;

    // hora 20:52: oltre il lead minimo (cocina+andata) → NON scatta il
    // conflitto "muy pronta", ma il rider reale è ancora fuori (~20:49).
    // BEFORE (path planned puro): proposeForNewOrder non segnala conflitto
    // (il giro pianificato 20:20 è già passato e non collide).
    const propose = proposeForNewOrder(
      STUB_ORDERS,
      { hora: "20:52", zona: "Q1", zona_lat: Q1.lat, zona_lon: Q1.lon, durata_andata_min: 5 },
      { nowMin: toMin("20:38") }
    );
    check("BEFORE: proposeForNewOrder NON segnala conflitto (giro pianificato già passato)",
      propose && propose.ok !== false, JSON.stringify(propose));

    // AFTER (previewOrderTiming con floor rider reale): conflitto rider.
    const r = await previewOrderTiming({ tipo_consegna: "DOMICILIO", direccion: "Reino 46", hora: "20:52" });
    check("AFTER: driver.has_conflict = true (floor rider reale)", r.driver.has_conflict === true, JSON.stringify(r.driver));
    check("AFTER: warning rider_busy presente", hasWarn(r, "rider_busy"), JSON.stringify(r.warnings));
    check("AFTER: suggested_hora = 20:54 (rientro 20:49 + andata 5)", r.suggested_hora === "20:54", `sugg=${r.suggested_hora}`);
    check("forno_out NON contaminato = 20:47 (hora 20:52 − andata 5)", r.forno_out === "20:47", `forno=${r.forno_out}`);
    check("invariante forno_out + andata = hora", toMin(r.forno_out) + r.durata_andata_min === toMin("20:52"));
    check("hora_proposta MAI riscritta = 20:52", r.hora_proposta === "20:52", `hp=${r.hora_proposta}`);
    check("nessun giro auto-suggerito solo perché rider fuori", r.giro.suggested === false, JSON.stringify(r.giro));
  }

  // ════════════════════════════════════════════════════════════════
  // Scenario B — stesso rider, ma nuovo ordine DOPO il rientro reale
  // (~20:49). Nessun conflitto rider; forno_out coerente.
  section("B — nuovo ordine dopo il rientro reale del rider → nessun conflitto");
  {
    STUB_ORDERS = [{
      id: "#001", tipo_consegna: "DOMICILIO", estado: "EN_ENTREGA", zona: "Q1",
      hora: "20:20", durata_andata_min: 5, hora_salida: madridMs(20, 36),
    }];
    STUB_RESOLVED = Q1;
    const r = await previewOrderTiming({ tipo_consegna: "DOMICILIO", direccion: "Reino 46", hora: "21:10" });
    check("driver.has_conflict = false (rider già rientrato)", r.driver.has_conflict === false, JSON.stringify(r.driver));
    check("nessun warning rider_busy", !hasWarn(r, "rider_busy"), JSON.stringify(r.warnings));
    check("forno_out = 21:05 (hora 21:10 − andata 5)", r.forno_out === "21:05", `forno=${r.forno_out}`);
  }

  // ════════════════════════════════════════════════════════════════
  // Scenario C — nessun ordine attivo: comportamento invariato (no regress).
  section("C — nessun ordine attivo → nessun conflitto rider (no regressione)");
  {
    STUB_ORDERS = [];
    STUB_RESOLVED = Q1;
    const r = await previewOrderTiming({ tipo_consegna: "DOMICILIO", direccion: "Reino 46", hora: "21:10" });
    check("driver.has_conflict = false", r.driver.has_conflict === false, JSON.stringify(r.driver));
    check("nessun warning rider_busy", !hasWarn(r, "rider_busy"));
    check("forno_out = 21:05", r.forno_out === "21:05", `forno=${r.forno_out}`);
  }

  console.log(`\n=== previewOrderTimingRiderFloor: ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
})();
