// tests/driverTelemetrySecondGiro.test.js — DELIVERY-RIDER-SECOND-GIRO-01
// Unit tests for recordRiderOut per-giro idempotency + the final-delivery
// closing contract in src/utils/driverTelemetry.js. No real DB: ./supabase is
// stubbed via require.cache before the module-under-test is loaded (same
// pattern as manualGiros.test.js / closingTimeGuard.test.js).

const assert = require("assert");

// ─── In-memory fake DB ───────────────────────────────────────────
// config holds a single DRIVER_STATO row (valore = JSON string).
// ordenes is queried by countActiveDeliveries and the shadow A/B select.
const db = {
  DRIVER_STATO: null,   // parsed object or null (absent)
  ordenes: [],
  delivery_logs: [],
};
let failRead = false;   // simulate sbSelect(config) throwing / failing
let failWrite = false;  // simulate sbUpsert(config) failing

function resetDb() {
  db.DRIVER_STATO = null;
  db.ordenes = [];
  db.delivery_logs = [];
  failRead = false;
  failWrite = false;
}

function setDriverStato(obj) { db.DRIVER_STATO = obj ? { ...obj } : null; }
function getDriverStato() { return db.DRIVER_STATO ? { ...db.DRIVER_STATO } : null; }

// Parse the tiny subset of PostgREST syntax driverTelemetry actually emits.
// countActiveDeliveries: `[manual_giro_id=eq.X&]tipo_consegna=eq.DOMICILIO&estado=in.(LISTO,EN_ENTREGA)&select=id`
function countOrdenes(query) {
  const parts = String(query || "").split("&").filter(Boolean);
  let giro = null;
  for (const p of parts) {
    if (p.startsWith("manual_giro_id=eq.")) giro = decodeURIComponent(p.slice("manual_giro_id=eq.".length));
  }
  return db.ordenes.filter(o =>
    o.tipo_consegna === "DOMICILIO" &&
    (o.estado === "LISTO" || o.estado === "EN_ENTREGA") &&
    (giro == null || String(o.manual_giro_id) === String(giro))
  );
}

const supabasePath = require.resolve("../src/utils/supabase");
require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: {
    sbSelect: async (table, query = "") => {
      if (table === "config" && /chiave=eq\.DRIVER_STATO/.test(query)) {
        if (failRead) throw new Error("simulated read failure");
        const ds = getDriverStato();
        return ds == null ? [] : [{ chiave: "DRIVER_STATO", valore: JSON.stringify(ds) }];
      }
      if (table === "ordenes") {
        // countActiveDeliveries wants [{id}]; the shadow A/B select wants full rows.
        if (/estado=in\.\(LISTO,EN_ENTREGA\)/.test(query)) {
          return countOrdenes(query).map(o => ({ id: o.id }));
        }
        // shadow A/B: RETIRADO rows — return empty (no giro logging under test)
        return [];
      }
      return [];
    },
    sbUpsert: async (table, data /*, onConflict */) => {
      if (table === "config" && data && data.chiave === "DRIVER_STATO") {
        if (failWrite) throw new Error("simulated write failure");
        db.DRIVER_STATO = JSON.parse(data.valore);
        return [{ ...data }];
      }
      return [{ ...data }];
    },
    sbInsert: async (table, data) => {
      if (table === "delivery_logs") db.delivery_logs.push({ ...data });
      return [{ ...data }];
    },
    sbUpdate: async () => [],
    sbDelete: async () => [],
    getConfig: async () => ({}),
  },
};

// Load the module under the stub.
const {
  recordRiderOut,
  recordDeliveryAndMaybeReturn,
  getDriverStatus,
} = require("../src/utils/driverTelemetry");

// ─── Tiny assertion harness ──────────────────────────────────────
let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label} ${extra}`); }
}

(async () => {
  // ── Test 1 — FIRST DEPARTURE ──────────────────────────────────
  console.log("\n── Test 1 — first departure ──");
  {
    resetDb();
    db.ordenes = [{ id: "#1", tipo_consegna: "DOMICILIO", estado: "EN_ENTREGA" }];
    const r = await recordRiderOut({ zona: "Q2", nOrdini: 1 });
    const ds = getDriverStato();
    check("returns success (no skip)", r.success === true && !r.skipped, JSON.stringify(r));
    check("stato IN_GIRO", ds && ds.stato === "IN_GIRO", JSON.stringify(ds));
    check("partito_alle set", !!ds.partito_alle);
    check("rientro_stimato null", ds.rientro_stimato === null);
    check("zona refreshed = Q2", ds.zona === "Q2");
    check("no reset flag on first departure", !r.reset, JSON.stringify(r));
  }

  // ── Test 2 — REPEATED EN_ENTREGA, SAME OPEN GIRO ──────────────
  console.log("\n── Test 2 — repeated EN_ENTREGA, same open giro ──");
  {
    resetDb();
    const partito = "2026-07-10T20:00:00.000Z";
    setDriverStato({ stato: "IN_GIRO", zona: "Q2", partito_alle: partito, n_ordini: 2, rientro_stimato: null });
    const r = await recordRiderOut({ zona: "Q5", nOrdini: 1 });
    const ds = getDriverStato();
    check("already_out", r.skipped === "already_out", JSON.stringify(r));
    check("partito_alle unchanged", ds.partito_alle === partito, ds.partito_alle);
    check("zona unchanged (Q2)", ds.zona === "Q2", ds.zona);
    check("rientro_stimato still null", ds.rientro_stimato === null);
  }

  // ── Test 3 — FINAL DELIVERY CLOSES GIRO (remaining=0) ─────────
  console.log("\n── Test 3 — final delivery closes giro ──");
  {
    resetDb();
    setDriverStato({ stato: "IN_GIRO", zona: "Q2", partito_alle: "2026-07-10T20:00:00.000Z", n_ordini: 1, rientro_stimato: null });
    db.ordenes = []; // no active DOMICILIO left → remaining 0
    const r = await recordDeliveryAndMaybeReturn({ id: "#1", manual_giro_id: null });
    const ds = getDriverStato();
    check("closeGiro succeeded", r.success === true && !r.skipped, JSON.stringify(r));
    check("rientro_stimato set (absolute ISO)", !!ds.rientro_stimato && !Number.isNaN(Date.parse(ds.rientro_stimato)), ds.rientro_stimato);
    const st = await getDriverStatus();
    check("getDriverStatus returning=true", st && st.returning === true, JSON.stringify(st));
    check("stato still IN_GIRO after close", ds.stato === "IN_GIRO");
  }

  // ── Test 4 — NEW DEPARTURE AFTER CLOSED GIRO ──────────────────
  console.log("\n── Test 4 — new departure after closed giro ──");
  {
    resetDb();
    const oldPartito = "2026-07-10T20:00:00.000Z";
    const oldEta = "2026-07-10T20:20:00.000Z";
    setDriverStato({ stato: "IN_GIRO", zona: "Q2", partito_alle: oldPartito, n_ordini: 1, rientro_stimato: oldEta });
    db.ordenes = [{ id: "#9", tipo_consegna: "DOMICILIO", estado: "EN_ENTREGA", manual_giro_id: "g2" }];
    const r = await recordRiderOut({ zona: "Q5", nOrdini: 1 });
    const ds = getDriverStato();
    check("reset=new_giro_after_return", r.reset === "new_giro_after_return", JSON.stringify(r));
    check("success true", r.success === true);
    check("new partito_alle differs from old", ds.partito_alle !== oldPartito, ds.partito_alle);
    check("rientro_stimato cleared", ds.rientro_stimato === null, String(ds.rientro_stimato));
    check("zona refreshed = Q5", ds.zona === "Q5", ds.zona);
    const st = await getDriverStatus();
    check("getDriverStatus returning=false", st && st.returning === false, JSON.stringify(st));
  }

  // ── Test 5 — SECOND ORDER OF NEW GIRO (no second reset) ───────
  console.log("\n── Test 5 — second order of new giro ──");
  {
    resetDb();
    const newPartito = "2026-07-10T20:30:00.000Z";
    setDriverStato({ stato: "IN_GIRO", zona: "Q5", partito_alle: newPartito, n_ordini: 1, rientro_stimato: null });
    const r = await recordRiderOut({ zona: "Q1", nOrdini: 1 });
    const ds = getDriverStato();
    check("already_out (idempotent)", r.skipped === "already_out", JSON.stringify(r));
    check("partito_alle unchanged", ds.partito_alle === newPartito, ds.partito_alle);
    check("no reset flag", !r.reset);
  }

  // ── Test 6 — NEW DEPARTURE BEFORE OLD ETA (future ETA) ────────
  console.log("\n── Test 6 — new departure before old ETA ──");
  {
    resetDb();
    const futureEta = new Date(Date.now() + 30 * 60000).toISOString(); // still in the future
    setDriverStato({ stato: "IN_GIRO", zona: "Q2", partito_alle: new Date(Date.now() - 5 * 60000).toISOString(), n_ordini: 1, rientro_stimato: futureEta });
    const r = await recordRiderOut({ zona: "Q3", nOrdini: 1 });
    const ds = getDriverStato();
    check("resets immediately despite future ETA", r.reset === "new_giro_after_return", JSON.stringify(r));
    check("stale ETA cleared", ds.rientro_stimato === null, String(ds.rientro_stimato));
  }

  // ── Test 7 — NEW DEPARTURE AFTER OLD ETA (past ETA) ───────────
  console.log("\n── Test 7 — new departure after old ETA ──");
  {
    resetDb();
    const pastEta = new Date(Date.now() - 30 * 60000).toISOString();
    setDriverStato({ stato: "IN_GIRO", zona: "Q2", partito_alle: new Date(Date.now() - 60 * 60000).toISOString(), n_ordini: 1, rientro_stimato: pastEta });
    const r = await recordRiderOut({ zona: "Q4", nOrdini: 1 });
    const ds = getDriverStato();
    check("fresh giro starts", r.reset === "new_giro_after_return" && r.success === true, JSON.stringify(r));
    check("rientro_stimato cleared", ds.rientro_stimato === null);
    check("zona refreshed = Q4", ds.zona === "Q4");
  }

  // ── Test 8 — READ FAILURE (conservative, no throw) ────────────
  console.log("\n── Test 8 — read failure ──");
  {
    resetDb();
    failRead = true;
    let threw = false;
    let r;
    try { r = await recordRiderOut({ zona: "Q2", nOrdini: 1 }); } catch (e) { threw = true; }
    check("does not throw", threw === false);
    // readDriverStato swallows the error → null → treated as fresh departure (write succeeds).
    check("returns a result object", r && typeof r === "object", JSON.stringify(r));
    check("order transition unaffected (no error thrown to caller)", threw === false);
  }

  // ── Test 9 — WRITE FAILURE (best-effort) ──────────────────────
  console.log("\n── Test 9 — write failure ──");
  {
    resetDb();
    failWrite = true;
    let threw = false;
    let r;
    try { r = await recordRiderOut({ zona: "Q2", nOrdini: 1 }); } catch (e) { threw = true; }
    check("does not throw", threw === false);
    check("telemetry_failed reported, not success", r && r.success === false && r.error === "telemetry_failed", JSON.stringify(r));
  }

  // ── Test 10 — MULTI-ORDER FINAL-DELIVERY CONTRACT ─────────────
  console.log("\n── Test 10 — multi-order final-delivery contract ──");
  {
    resetDb();
    setDriverStato({ stato: "IN_GIRO", zona: "Q2", partito_alle: "2026-07-10T20:00:00.000Z", n_ordini: 3, rientro_stimato: null });
    // Combined giro "g1" of 3 orders, all initially LISTO/EN_ENTREGA.
    db.ordenes = [
      { id: "#A", tipo_consegna: "DOMICILIO", estado: "EN_ENTREGA", manual_giro_id: "g1" },
      { id: "#B", tipo_consegna: "DOMICILIO", estado: "EN_ENTREGA", manual_giro_id: "g1" },
      { id: "#C", tipo_consegna: "DOMICILIO", estado: "EN_ENTREGA", manual_giro_id: "g1" },
    ];
    // First delivery: #A removed, #B/#C still active → not_last.
    db.ordenes = db.ordenes.filter(o => o.id !== "#A");
    let r1 = await recordDeliveryAndMaybeReturn({ id: "#A", manual_giro_id: "g1" });
    check("1st delivery does NOT close", r1.skipped === "not_last" && r1.remaining === 2, JSON.stringify(r1));
    check("returning still false after 1st", getDriverStato().rientro_stimato === null);

    // Middle delivery: #B removed, #C still active → not_last.
    db.ordenes = db.ordenes.filter(o => o.id !== "#B");
    let r2 = await recordDeliveryAndMaybeReturn({ id: "#B", manual_giro_id: "g1" });
    check("middle delivery does NOT close", r2.skipped === "not_last" && r2.remaining === 1, JSON.stringify(r2));
    check("returning still false after middle", getDriverStato().rientro_stimato === null);

    // Final delivery: #C removed, none left → closes.
    db.ordenes = db.ordenes.filter(o => o.id !== "#C");
    let r3 = await recordDeliveryAndMaybeReturn({ id: "#C", manual_giro_id: "g1" });
    check("final delivery closes giro", r3.success === true && !r3.skipped, JSON.stringify(r3));
    check("returning true after final", !!getDriverStato().rientro_stimato);
  }

  console.log(`\n${fail === 0 ? "✅" : "❌"} driverTelemetrySecondGiro: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
